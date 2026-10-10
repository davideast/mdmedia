'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Music2, PanelRight, MoreHorizontal, History, Copy, Pencil, Upload, Paperclip, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useWorkspace, useWorkspaceField } from '@/components/shell/workspace-provider';
import { useNarration } from '@/components/shell/narration-provider';
import { useAuth } from '@/lib/auth-context';
import { DEFAULT_MUSIC_REQUEST, MAX_MUSIC_PROMPT } from '@/lib/music-request';
import { MAX_REFERENCE_BYTES } from '@/lib/image-request';
import type { MusicRequest, MusicResource, MusicGenerationResource } from '@/lib/media-types';
import { MediaClientError, studioJson } from '@/lib/media-client';
import { MediaComposer, MediaIconAction } from './media-composer';
import { AssetImage } from './asset-image';
import { MusicPlayer } from './music-player';

const fromDraft = (draft: MusicRequest): MusicRequest => ({ prompt: draft.prompt, adaptation: draft.adaptation, output: draft.output, vocals: draft.vocals, lyrics: draft.lyrics, referenceAssetId: draft.referenceAssetId });

export function MusicEditor({ id }: { id?: string }) {
  const { state, store, draftId, activeView, replaceCurrent } = useWorkspace();
  const { updateSettings } = useAuth(), { stream } = useNarration(), router = useRouter();
  const [options, setOptions] = useState<{ available: boolean; defaults: MusicRequest } | null>(null);
  const [music, setMusic] = useState<MusicResource | null>(null), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false), [uploading, setUploading] = useState(false);
  const [drawer, setDrawer] = useWorkspaceField('musicDrawer', ''), [edit, setEdit] = useWorkspaceField('musicEdit', '');
  const [pending, setPending] = useWorkspaceField('musicSubmission', '');
  const [versions, setVersions] = useState<MusicGenerationResource[]>([]), [selected, setSelected] = useState<MusicGenerationResource | null>(null);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false), [rename, setRename] = useState('');
  const importRef = useRef<HTMLInputElement>(null), referenceRef = useRef<HTMLInputElement>(null), submittingRef = useRef(false);
  const base = id ? music?.request ?? DEFAULT_MUSIC_REQUEST : (state.musicDrafts?.[draftId] ? fromDraft(state.musicDrafts[draftId]) : null) ?? options?.defaults ?? DEFAULT_MUSIC_REQUEST;
  let request: MusicRequest = base;
  if (id && edit) { try { request = JSON.parse(edit) as MusicRequest; } catch { /* Preserve the saved source. */ } }
  const requestRef = useRef(request); useEffect(() => { requestRef.current = request; }, [request]);
  const busy = submitting || uploading || ['queued', 'generating'].includes(music?.status ?? '');
  const result = selected ?? music?.result, asset = result?.assets[0];
  const report = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.');
  function update(patch: Partial<MusicRequest>) {
    const next = { ...requestRef.current, ...patch };
    if (id) setEdit(JSON.stringify(next)); else store.setMusicDraft(draftId, { ...next, kind: 'music' });
  }
  useEffect(() => {
    const controller = new AbortController();
    void studioJson<{ available: boolean; defaults: MusicRequest }>('/api/v1/options?media=music', { signal: controller.signal }).then(setOptions).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await studioJson<MusicResource>(`/api/v1/music/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setMusic(next); setLoadError(''); timer = setTimeout(load, ['queued', 'generating'].includes(next.status) ? 2000 : 10_000);
      } catch (e) { if (!controller.signal.aborted) { setLoadError((e as Error).message); timer = setTimeout(load, 10_000); } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function generate() {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError(''); const viewId = activeView?.id;
    try {
      const submission: { key: string; body: MusicRequest } = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body: request };
      setPending(JSON.stringify(submission));
      const accepted = await studioJson<{ id: string }>(id ? `/api/v1/music/${id}/generations` : '/api/v1/music', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body) });
      setPending(''); setEdit(''); setSelected(null);
      if (!id) {
        store.clearMusicDraft(draftId);
        if (store.getSnapshot().activeId === viewId) replaceCurrent(`/music/${accepted.id}`, submission.body.prompt.trim().split('\n')[0].slice(0, 100));
        else { if (viewId) store.replaceTab(viewId, `/music/${accepted.id}`); toast.success('Music generation started.'); }
      } else setMusic(await studioJson<MusicResource>(`/api/v1/music/${id}`));
    } catch (e) {
      if (e instanceof MediaClientError && e.status >= 400 && e.status < 500) setPending('');
      report(e);
    } finally { submittingRef.current = false; setSubmitting(false); }
  }
  async function attach(file: File) {
    if (file.size > MAX_REFERENCE_BYTES) { setError('Reference images must be at most 10 MiB.'); return; }
    setUploading(true); setError('');
    try { const asset = await studioJson<{ id: string }>('/api/v1/assets?media=music', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); update({ referenceAssetId: asset.id }); }
    catch (e) { report(e); } finally { setUploading(false); }
  }
  async function history(older = false) {
    try {
      const page = await studioJson<{ items: MusicGenerationResource[]; nextCursor: typeof cursor }>(`/api/v1/music/${id}/generations${older && cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ''}`);
      setVersions(previous => older ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); setDrawer('history');
    } catch (e) { report(e); }
  }
  const title = id ? music?.title ?? 'Music' : request.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'New music';
  return <WorkbenchPanel workspacePage title={title} icon={<Music2 size={13} />} bodyClassName="gap-0 p-0" actions={<>
    {music && <DropdownMenu><DropdownMenuTrigger asChild><button aria-label="Music actions" className="grid size-7 place-items-center rounded-md text-ink-muted hover:bg-muted"><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => void history()}><History size={15} />History</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { const next = crypto.randomUUID(); store.setMusicDraft(next, { ...request, kind: 'music' }); router.push(`/studio/music?draft=${next}`); }}><Copy size={15} />Duplicate</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { setRename(music.title); setRenameOpen(true); }}><Pencil size={15} />Rename</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>}
    <MediaIconAction compact label="Music options" aria-expanded={drawer === 'options'} onClick={() => setDrawer(drawer === 'options' ? '' : 'options')}><PanelRight size={15} /></MediaIconAction>
  </>}>
    {loadError && <p role="alert" className="p-4 text-sm text-destructive">{loadError}</p>}
    {asset && result && <MusicPlayer key={asset.id} result={result} title={title} onStart={() => stream.player?.pause()} otherAudioPlaying={stream.playing} />}
    {selected && <Button variant="ghost" className="mx-4 mt-3 self-start" onClick={() => setSelected(null)}>Back to latest</Button>}
    {id && !music && !loadError && <p role="status" className="p-4 text-sm text-ink-muted">Loading music…</p>}
    {!selected && <MediaComposer heading={asset ? 'Try another take' : 'Describe music'} label="Music prompt" placeholder="Describe or paste here. Markdown is fine."
      value={request.prompt} maxLength={MAX_MUSIC_PROMPT} onChange={prompt => update({ prompt })} disabled={busy || Boolean(pending)}
      onSubmit={() => void generate()} actionLabel={pending && !submitting ? 'Retry submission' : busy ? 'Generating…' : music ? 'Generate again' : 'Generate music'}
      actionDisabled={busy || (!pending && !request.prompt.trim()) || options?.available === false || Boolean(id && !music)} busy={busy} grow={!asset}
      footer={<div className="flex items-center gap-1"><MediaIconAction label="Import Markdown" disabled={busy || Boolean(pending)} onClick={() => importRef.current?.click()}><Upload size={16} /></MediaIconAction><MediaIconAction label="Attach reference" disabled={busy || Boolean(pending)} onClick={() => referenceRef.current?.click()}>{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</MediaIconAction></div>}>
      {request.referenceAssetId && <div className="flex items-center gap-2"><AssetImage id={request.referenceAssetId} thumbnail alt="Music reference" className="h-16 w-20 rounded" /><MediaIconAction label="Remove reference" disabled={busy || Boolean(pending)} onClick={() => update({ referenceAssetId: null })}><X size={16} /></MediaIconAction></div>}
    </MediaComposer>}
    {(error || options?.available === false || music?.latestGeneration.error || busy || pending) && <div className="grid gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
      {music && ['queued', 'generating'].includes(music.status) && <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={15} className="animate-spin" />{music.latestGeneration.phase === 'preparing' ? 'Preparing…' : music.latestGeneration.phase === 'saving' ? 'Saving…' : music.status === 'queued' ? 'Waiting…' : 'Generating music…'}</p>}
      {(error || music?.latestGeneration.error) && <p role="alert" className="text-sm text-destructive">{error || music?.latestGeneration.error?.message}</p>}
      {options?.available === false && <p role="alert" className="text-sm text-destructive">Music generation is unavailable on this Studio.</p>}
      {pending && !submitting && <p role="status" className="text-xs text-ink-muted">Submission unconfirmed. Retry safely with the same request.</p>}
    </div>}
    <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (file.size > MAX_MUSIC_PROMPT * 4) setError('This Markdown file is too large.'); else void file.text().then(text => { if (text.length > MAX_MUSIC_PROMPT) setError('Music prompts are limited to 32,000 characters.'); else update({ prompt: text }); }).catch(report); } event.target.value = ''; }} />
    <input ref={referenceRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ''; }} />
    <Sheet open={Boolean(drawer)} onOpenChange={open => { if (!open) setDrawer(''); }}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>{drawer === 'history' ? 'History' : 'Music options'}</SheetTitle><SheetDescription className="sr-only">{drawer === 'history' ? 'Play previous takes without replacing your latest result.' : 'Optional ways to shape your music.'}</SheetDescription>
      {drawer === 'history' ? <div className="grid gap-2">{versions.map(version => <button key={version.id} disabled={version.status !== 'ready'} className="flex items-center gap-3 rounded-md border border-border p-3 text-left text-sm disabled:opacity-50" onClick={() => { setSelected(version); setDrawer(''); }}><Music2 size={18} /><span>{new Date(version.createdAt).toLocaleString()}<span className="block text-xs text-ink-muted">{version.status === 'ready' ? `${Math.round(version.durationSeconds ?? 0)}s` : version.status}</span></span></button>)}{cursor && <Button variant="outline" onClick={() => void history(true)}>Older attempts</Button>}</div> : <fieldset disabled={busy || Boolean(pending) || Boolean(selected)} className="grid gap-6 disabled:opacity-60">
        <label className="grid gap-2 text-sm font-medium">Length<select aria-label="Music length" className="rounded-md border border-input bg-background p-2" value={request.output.mode} onChange={event => update({ output: { ...request.output, mode: event.target.value as 'song' | 'clip' } })}><option value="song">Full song</option><option value="clip">30-second clip</option></select></label>
        <label className="grid gap-2 text-sm font-medium">Vocals<select aria-label="Music vocals" className="rounded-md border border-input bg-background p-2" value={request.vocals} onChange={event => { const vocals = event.target.value as MusicRequest['vocals']; update({ vocals, ...(vocals === 'instrumental' ? { lyrics: '' } : {}) }); }}><option value="auto">Automatic</option><option value="vocals">With vocals</option><option value="instrumental">Instrumental</option></select></label>
        {request.vocals !== 'instrumental' && <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Your lyrics</summary><Textarea aria-label="Custom lyrics" className="mt-3 min-h-40" value={request.lyrics} maxLength={8000} onChange={event => update({ lyrics: event.target.value })} placeholder="[Verse]\nYour words…" /></details>}
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={request.adaptation.enabled} onChange={event => update({ adaptation: { ...request.adaptation, enabled: event.target.checked } })} />Adapt notes for music</label>
        {request.adaptation.enabled && <label className="grid gap-2 text-sm font-medium">Custom instructions<Textarea aria-label="Music adaptation instructions" value={request.adaptation.instructions} maxLength={4000} onChange={event => update({ adaptation: { ...request.adaptation, instructions: event.target.value } })} /></label>}
        <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Download format</summary><select aria-label="Music format" className="mt-3 w-full rounded-md border border-input bg-background p-2" value={request.output.format} onChange={event => update({ output: { ...request.output, format: event.target.value as 'mp3' | 'wav' } })}><option value="mp3">MP3</option><option value="wav">WAV</option></select></details>
        <Button variant="outline" onClick={() => void updateSettings({ musicDefaults: { ...request, prompt: '', lyrics: '', referenceAssetId: null } }).then(() => toast.success('Music defaults saved.')).catch(report)}>Save as defaults</Button>
      </fieldset>}
      <Button variant="outline" onClick={() => setDrawer('')}>Done</Button>
    </SheetContent></Sheet>
    {result?.lyrics && <details className="px-4 pb-6 text-sm sm:px-6"><summary className="cursor-pointer text-ink-muted">Song text</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{result.lyrics}</pre></details>}
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent><DialogTitle>Rename music</DialogTitle><DialogDescription className="sr-only">Change this track’s title.</DialogDescription><form className="grid gap-4" onSubmit={event => { event.preventDefault(); void studioJson<MusicResource>(`/api/v1/music/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rename }) }).then(next => { setMusic(next); setRenameOpen(false); }).catch(report); }}><Input aria-label="Music title" value={rename} maxLength={200} onChange={event => setRename(event.target.value)} /><Button type="submit" disabled={!rename.trim()}>Save</Button></form></DialogContent></Dialog>
  </WorkbenchPanel>;
}
