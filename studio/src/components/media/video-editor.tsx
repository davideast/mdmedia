'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Video, Download, Expand, PanelRight, MoreHorizontal, Upload, Paperclip, X, Loader2, History, Copy, Pencil, RotateCcw, ListVideo } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useWorkspace, useWorkspaceField } from '@/components/shell/workspace-provider';
import { useAuth } from '@/lib/auth-context';
import { MediaClientError, studioJson } from '@/lib/media-client';
import type { VideoRequest, VideoResource, VideoGenerationResource, VideoDraft } from '@/lib/media-types';
import { DEFAULT_VIDEO_REQUEST, VIDEO_RESOLUTIONS } from '@/lib/video-request';
import { MAX_REFERENCE_BYTES } from '@/lib/image-request';
import { MediaComposer, MediaIconAction } from './media-composer';
import { AssetImage } from './asset-image';
import { usePrivateMedia, PrivateThumbnail, downloadPrivateMedia } from './private-media';

type Options = { available: boolean; defaults: VideoRequest };
type Submission = { key: string; body: VideoRequest & { action?: 'continue' | 'regenerate_latest'; fromGenerationId?: string } };
const fromDraft = (draft: VideoDraft): VideoRequest => ({ prompt: draft.prompt, adaptation: draft.adaptation, output: draft.output, referenceAssetId: draft.referenceAssetId, referenceRole: draft.referenceRole });
const seconds = (duration: number) => `${Math.round(duration * 10) / 10}s`;
const phaseLabel = (phase: string) => ({ queued: 'Waiting…', starting: 'Starting…', preparing: 'Preparing…', generating: 'Generating video…', downloading: 'Downloading…', saving: 'Saving…', assembling: 'Saving…', recovering: 'Recovering…' }[phase] ?? phase);
export function VideoEditor({ id }: { id?: string }) {
  const { state, store, draftId, activeView, replaceCurrent } = useWorkspace();
  const { updateSettings } = useAuth(); const router = useRouter();
  const [options, setOptions] = useState<Options | null>(null);
  const [video, setVideo] = useState<VideoResource | null>(null);
  const [error, setError] = useState(''); const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false); const [uploading, setUploading] = useState(false);
  const [drawer, setDrawer] = useWorkspaceField('videoDrawer', '');
  const [edit, setEdit] = useWorkspaceField('videoEdit', '');
  const [mode, setMode] = useWorkspaceField('videoMode', 'continue');
  const [pending, setPending] = useWorkspaceField('videoSubmission', '');
  const [versions, setVersions] = useState<VideoGenerationResource[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [selected, setSelected] = useState<VideoGenerationResource | null>(null);
  const [renameOpen, setRenameOpen] = useState(false); const [rename, setRename] = useState('');
  const importRef = useRef<HTMLInputElement>(null); const referenceRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<HTMLVideoElement>(null); const submissionRef = useRef(false);
  const failedAttempt = video && ['error', 'interrupted'].includes(video.latestGeneration.status) ? video.latestGeneration : null;
  const base: VideoRequest = id ? failedAttempt ? failedAttempt.request : video?.result ? { ...video.result.request, prompt: '', referenceAssetId: null, referenceRole: 'reference' }
    : video?.request ?? DEFAULT_VIDEO_REQUEST : (state.videoDrafts?.[draftId] ? fromDraft(state.videoDrafts[draftId]) : null) ?? options?.defaults ?? DEFAULT_VIDEO_REQUEST;
  let request = base;
  if (id && edit) { try { request = JSON.parse(edit) as VideoRequest; } catch { /* Keep the saved source. */ } }
  const requestRef = useRef(request); useEffect(() => { requestRef.current = request; }, [request]);
  const busy = submitting || uploading || ['queued', 'generating'].includes(video?.status ?? '');
  const result = selected ?? video?.result; const asset = result?.assets[0];
  const media = usePrivateMedia(asset ? `/api/v1/assets/${asset.id}/content` : null);
  const poster = usePrivateMedia(asset ? `/api/v1/assets/${asset.id}/content?thumbnail=1` : null);
  const regenerating = mode === 'regenerate_latest' || (failedAttempt?.action === 'regenerate_latest' && mode !== 'continue_after_failure') || Boolean(id && video && !video.result && failedAttempt);
  const parentDuration = regenerating ? video?.clips.at(-1)?.startSeconds ?? 0 : video?.result?.durationSeconds ?? 0;
  const remaining = Math.floor(40 - parentDuration + 0.25); const maxDuration = Math.min(10, remaining);
  function update(patch: Partial<VideoRequest>) {
    const next = { ...requestRef.current, ...patch };
    if (id) setEdit(JSON.stringify(next)); else store.setVideoDraft(draftId, { ...next, kind: 'video' });
  }
  useEffect(() => {
    const controller = new AbortController();
    void studioJson<Options>('/api/v1/options?media=video', { signal: controller.signal }).then(setOptions).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await studioJson<VideoResource>(`/api/v1/videos/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setVideo(next); setLoadError(''); timer = setTimeout(load, ['queued', 'generating'].includes(next.status) ? 2000 : 10_000);
      } catch (e) { if (!controller.signal.aborted) { setLoadError((e as Error).message); timer = setTimeout(load, 10_000); } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function generate() {
    if (submissionRef.current) return;
    submissionRef.current = true; setSubmitting(true); setError('');
    const viewId = activeView?.id;
    try {
      const body = { ...request, output: { ...request.output, durationSeconds: Math.min(request.output.durationSeconds, maxDuration) },
        ...(id && video ? { action: regenerating ? 'regenerate_latest' as const : 'continue' as const, fromGenerationId: video.latestSuccessfulGenerationId ?? video.latestGenerationId } : {}) };
      const submission: Submission = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body };
      setPending(JSON.stringify(submission));
      const accepted = await studioJson<{ id: string }>(id ? `/api/v1/videos/${id}/generations` : '/api/v1/videos', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body),
      });
      setPending(''); setEdit(''); setMode('continue'); setSelected(null);
      if (!id) {
        store.clearVideoDraft(draftId);
        if (store.getSnapshot().activeId === viewId) replaceCurrent(`/video/${accepted.id}`, submission.body.prompt.trim().split('\n')[0].slice(0, 100));
        else { if (viewId) store.replaceTab(viewId, `/video/${accepted.id}`); toast.success('Video generation started.'); }
      } else setVideo(await studioJson<VideoResource>(`/api/v1/videos/${id}`));
    } catch (e) {
      if (e instanceof MediaClientError && e.status >= 400 && e.status < 500) setPending('');
      setError((e as Error).message);
    } finally { submissionRef.current = false; setSubmitting(false); }
  }
  async function attach(file: File) {
    if (file.size > MAX_REFERENCE_BYTES) { setError('Reference images must be at most 10 MiB.'); return; }
    setUploading(true); setError('');
    try { const uploaded = await studioJson<{ id: string }>('/api/v1/assets?media=video', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); update({ referenceAssetId: uploaded.id }); }
    catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  async function history(older = false) {
    setDrawer('history');
    try {
      const suffix = older && cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : '';
      const page = await studioJson<{ items: VideoGenerationResource[]; nextCursor: typeof cursor }>(`/api/v1/videos/${id}/generations${suffix}`);
      setVersions(previous => older ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor);
    } catch (e) { setError((e as Error).message); }
  }
  function regenerate() {
    const source = video?.result ?? video?.latestGeneration; if (!source) return;
    setSelected(null); setEdit(JSON.stringify(source.request)); setMode('regenerate_latest'); setDrawer('');
  }
  function duplicate() {
    const draft = crypto.randomUUID(); const source = request.prompt.trim() ? request : video?.result?.request ?? request;
    store.setVideoDraft(draft, { ...source, kind: 'video' }); router.push(`/studio/video?draft=${draft}`);
  }
  const title = id ? video?.title ?? 'Video' : request.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'New video';
  const report = (e: unknown) => setError((e as Error).message);
  return <WorkbenchPanel workspacePage title={title} icon={<Video size={13} strokeWidth={2} />} bodyClassName="gap-0 p-0" actions={<>
    {id && <DropdownMenu><DropdownMenuTrigger asChild><MediaIconAction compact label="Video actions"><MoreHorizontal size={15} /></MediaIconAction></DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem disabled={!video?.result || Boolean(selected)} onSelect={() => setDrawer('clips')}><ListVideo size={16} />Clips</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void history()}><History size={16} />History</DropdownMenuItem>
      <DropdownMenuItem disabled={busy || Boolean(pending) || !video} onSelect={regenerate}><RotateCcw size={16} />Regenerate latest</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { setRename(video?.title ?? ''); setRenameOpen(true); }}><Pencil size={16} />Rename</DropdownMenuItem>
      <DropdownMenuItem disabled={!video} onSelect={duplicate}><Copy size={16} />Duplicate</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>}
    <MediaIconAction compact label="Video options" aria-expanded={drawer === 'options'} onClick={() => setDrawer(drawer === 'options' ? '' : 'options')}><PanelRight size={15} /></MediaIconAction>
  </>}>
    {loadError && <p role="alert" className="p-4 text-sm text-destructive">{loadError}</p>}
    {asset && <div className="grid shrink-0 gap-2 p-4 pb-0 sm:p-6 sm:pb-0">
      {media.url ? <video key={asset.id} ref={playerRef} src={media.url} poster={poster.url || undefined} controls playsInline preload="metadata" aria-label={video?.title ?? 'Generated video'} className="max-h-[55dvh] w-full rounded-lg border border-border bg-black" /> : <div role="status" className="grid min-h-48 place-content-center rounded-lg bg-muted text-sm text-ink-muted">{media.error || 'Loading video…'}</div>}
      <div className="flex items-center gap-1">
        <MediaIconAction label="Download video" onClick={() => void downloadPrivateMedia(`/api/v1/assets/${asset.id}/content?download=1`, `${title}.mp4`).catch(report)}><Download size={16} /></MediaIconAction>
        <MediaIconAction label="Fullscreen" disabled={!media.url} onClick={() => { const player = playerRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (player?.requestFullscreen) void player.requestFullscreen().catch(report); else player?.webkitEnterFullscreen?.(); }}><Expand size={16} /></MediaIconAction>
        <span className="text-xs text-ink-muted">{seconds(result?.durationSeconds ?? 0)} / 40s</span>
        {selected && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(null)}>Back to latest</Button>}
      </div>
    </div>}
    {id && !video && !loadError && <p role="status" className="p-4 text-sm text-ink-muted">Loading video…</p>}
    {!selected && <MediaComposer heading={regenerating && video ? 'Regenerate latest clip' : asset ? 'What happens next?' : 'Describe a video'} label="Video prompt" placeholder="Describe or paste here. Markdown is fine."
      value={request.prompt} maxLength={32000} disabled={busy || Boolean(pending)} onChange={prompt => update({ prompt })} onSubmit={() => void generate()}
      actionLabel={pending && !submitting ? 'Retry submission' : busy ? 'Generating…' : regenerating ? 'Regenerate clip' : video?.result ? 'Continue video' : 'Generate video'}
      actionDisabled={busy || (!pending && !request.prompt.trim()) || options?.available === false || Boolean(id && !video) || maxDuration < 3 || Boolean(video?.result && !regenerating && !video.canContinue)}
      busy={busy} grow={!asset} footer={<div className="flex items-center gap-1">
        <MediaIconAction label="Import Markdown" disabled={busy || Boolean(pending)} onClick={() => importRef.current?.click()}><Upload size={16} /></MediaIconAction>
        <MediaIconAction label="Attach reference" disabled={busy || Boolean(pending)} onClick={() => referenceRef.current?.click()}>{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</MediaIconAction>
        {regenerating && Boolean(video?.result) && <MediaIconAction label="Cancel regeneration" disabled={busy || Boolean(pending)} onClick={() => { setMode('continue_after_failure'); setEdit(JSON.stringify({ ...base, prompt: '', referenceAssetId: null, referenceRole: 'reference' })); }}><X size={16} /></MediaIconAction>}
        {maxDuration < 3 && <span className="text-xs text-ink-muted">Sequence complete</span>}
      </div>}>
      {request.referenceAssetId && <div className="flex items-center gap-2"><AssetImage id={request.referenceAssetId} thumbnail alt="Reference" className="h-16 w-20 rounded" /><MediaIconAction label="Remove reference" disabled={busy || Boolean(pending)} onClick={() => update({ referenceAssetId: null })}><X size={16} /></MediaIconAction></div>}
    </MediaComposer>}
    {(error || options?.available === false || video?.latestGeneration.error || busy || pending) && <div className="grid shrink-0 gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
      {video && ['queued', 'generating'].includes(video.status) && <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={15} className="animate-spin" />{phaseLabel(video.latestGeneration.phase)}</p>}
      {(error || video?.latestGeneration.error) && <p role="alert" className="text-sm text-destructive">{error || video?.latestGeneration.error?.message}</p>}
      {options?.available === false && <p role="alert" className="text-sm text-destructive">Video generation is unavailable on this Studio.</p>}
      {pending && !submitting && <p role="status" className="text-xs text-ink-muted">Submission unconfirmed. Retry safely with the same request.</p>}
    </div>}
    <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (file.size > 128000) setError('This Markdown file is too large.'); else void file.text().then(text => { if (text.length > 32000) setError('Prompts are limited to 32,000 characters.'); else update({ prompt: text }); }).catch(report); } event.target.value = ''; }} />
    <input ref={referenceRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ''; }} />
    <Sheet open={Boolean(drawer)} onOpenChange={open => { if (!open) setDrawer(''); }}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>{drawer === 'clips' ? 'Clips' : drawer === 'history' ? 'History' : 'Video options'}</SheetTitle><SheetDescription className="sr-only">{drawer === 'clips' ? 'Seek or download clips from the complete video.' : drawer === 'history' ? 'Preview previous results. Only the latest result can be continued.' : 'Optional video settings.'}</SheetDescription>
      {drawer === 'clips' ? <div className="grid gap-3">{video?.clips.map(clip => <div key={clip.index} className="flex items-center gap-2 rounded-md border border-border p-2">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => { if (playerRef.current) { playerRef.current.currentTime = clip.startSeconds; void playerRef.current.play().catch(report); } setDrawer(''); }}><PrivateThumbnail path={clip.thumbnail} alt={`Clip ${clip.index}`} className="h-14 w-20 rounded object-cover" /><span className="text-sm">{clip.index}<span className="block text-xs text-ink-muted">{seconds(clip.endSeconds - clip.startSeconds)}</span></span></button>
        <MediaIconAction label={`Download clip ${clip.index}`} onClick={() => void downloadPrivateMedia(clip.content, `clip-${clip.index}.mp4`).catch(report)}><Download size={16} /></MediaIconAction>
      </div>)}</div> : drawer === 'history' ? <div className="grid gap-2">{versions.map(version => <button key={version.id} disabled={version.status !== 'ready'} className="flex items-center gap-3 rounded-md border border-border p-3 text-left text-sm disabled:opacity-50" onClick={() => { setSelected(version); setDrawer(''); }}>
        {version.assets[0] && <AssetImage id={version.assets[0].id} thumbnail alt="Previous video" className="h-14 w-20 rounded" />}<span>{new Date(version.createdAt).toLocaleString()}<span className="block text-xs text-ink-muted">{version.status === 'ready' ? seconds(version.durationSeconds ?? 0) : version.status}</span></span>
      </button>)}{cursor && <Button variant="outline" onClick={() => void history(true)}>Older attempts</Button>}</div> : <fieldset disabled={busy || Boolean(pending) || Boolean(selected)} className="grid gap-6 disabled:opacity-60">
        <label className="grid gap-2 text-sm font-medium">Clip length<select aria-label="Clip length" className="rounded-md border border-input bg-background p-2" disabled={maxDuration < 3} value={Math.min(request.output.durationSeconds, Math.max(3, maxDuration))} onChange={event => update({ output: { ...request.output, durationSeconds: Number(event.target.value) } })}>{Array.from({ length: Math.max(1, maxDuration - 2) }, (_, i) => i + 3).map(value => <option key={value} value={value}>{value}s</option>)}</select></label>
        <label className="grid gap-2 text-sm font-medium">Shape<select aria-label="Video shape" disabled={Boolean(video?.result)} className="rounded-md border border-input bg-background p-2" value={request.output.aspectRatio} onChange={event => update({ output: { ...request.output, aspectRatio: event.target.value as VideoRequest['output']['aspectRatio'] } })}><option value="16:9">Landscape</option><option value="9:16">Portrait</option></select></label>
        <label className="grid gap-2 text-sm font-medium">Resolution<select aria-label="Video resolution" disabled={Boolean(video?.result)} className="rounded-md border border-input bg-background p-2" value={request.output.resolution} onChange={event => update({ output: { ...request.output, resolution: event.target.value as VideoRequest['output']['resolution'] } })}>{VIDEO_RESOLUTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={request.adaptation.enabled} onChange={event => update({ adaptation: { ...request.adaptation, enabled: event.target.checked } })} />Adapt notes for video</label>
        {request.adaptation.enabled && <label className="grid gap-2 text-sm font-medium">Custom instructions<Textarea aria-label="Video adaptation instructions" value={request.adaptation.instructions} maxLength={4000} onChange={event => update({ adaptation: { ...request.adaptation, instructions: event.target.value } })} /></label>}
        {request.referenceAssetId && !parentDuration && <label className="grid gap-2 text-sm font-medium">Image role<select aria-label="Image role" className="rounded-md border border-input bg-background p-2" value={request.referenceRole} onChange={event => update({ referenceRole: event.target.value as VideoRequest['referenceRole'] })}><option value="reference">Reference</option><option value="first_frame">First frame</option></select></label>}
        <Button variant="outline" onClick={() => { void updateSettings({ videoDefaults: { ...request, prompt: '', referenceAssetId: null } }).then(() => toast.success('Video defaults saved.')).catch(report); }}>Save as defaults</Button>
      </fieldset>}
      <Button variant="outline" onClick={() => setDrawer('')}>Done</Button>
    </SheetContent></Sheet>
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent><DialogTitle>Rename video</DialogTitle><DialogDescription className="sr-only">Change this video’s title.</DialogDescription><form className="grid gap-4" onSubmit={event => { event.preventDefault(); void studioJson<VideoResource>(`/api/v1/videos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rename }) }).then(next => { setVideo(next); setRenameOpen(false); }).catch(report); }}><Input aria-label="Video title" value={rename} maxLength={200} onChange={event => setRename(event.target.value)} /><Button type="submit" disabled={!rename.trim()}>Save</Button></form></DialogContent></Dialog>
  </WorkbenchPanel>;
}
