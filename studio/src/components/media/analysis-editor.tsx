'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ScanSearch, PanelRight, MoreHorizontal, History, Headphones, AudioLines, Upload, Library, Link2, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import type { HeaderAction } from '@/components/shell/header-action';
import { useWorkspace, useWorkspaceField } from '@/components/shell/workspace-provider';
import { VoicePicker } from '@/components/studio/voice-picker';
import { useAuth } from '@/lib/auth-context';
import { usePublishChatViewContext } from '@/lib/chat-context-bridge';
import { MediaClientError, studioFetch, studioJson } from '@/lib/media-client';
import { ANALYSIS_RESOLUTIONS, ANALYSIS_UPLOAD_ACCEPT, DEFAULT_ANALYSIS_DRAFT, MAX_ANALYSIS_UPLOAD_BYTES, analysisBody, type AnalysisDraft } from '@/lib/analysis-draft';
import type { AnalysisGenerationResource, AnalysisResource, AnalysisSource, MediaSummary, VideoResource } from '@/lib/media-types';
import { MediaComposer, MediaIconAction } from './media-composer';
import { AssetImage } from './asset-image';
import { PrivateThumbnail, usePrivateMedia } from './private-media';
import { AnalysisAnswer } from './analysis-answer';

type Options = { available: boolean; model: string; capabilities: { agenticModels: string[] } };
const RESOLUTION_LABELS: Record<(typeof ANALYSIS_RESOLUTIONS)[number], string> = { low: 'Low', medium: 'Medium', high: 'High', ultra_high: 'Highest' };
const titleOf = (prompt: string) => prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
const running = (status?: string) => status === 'queued' || status === 'generating';

export function AnalysisEditor({ id }: { id?: string }) {
  return id ? <AnalysisView id={id} /> : <AnalysisComposer />;
}

/** Prompt, one source, and Analyze. Everything else waits behind Analysis options. */
function AnalysisComposer() {
  const { state, store, draftId, activeView, replaceCurrent } = useWorkspace();
  const { defaultReader } = useAuth();
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false), [uploading, setUploading] = useState(false);
  const [drawer, setDrawer] = useWorkspaceField('analysisDrawer', '');
  const [pending, setPending] = useWorkspaceField('analysisSubmission', '');
  const [videos, setVideos] = useState<MediaSummary[] | null>(null), [picked, setPicked] = useState<VideoResource | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null), submittingRef = useRef(false);
  const draft = state.analysisDrafts?.[draftId] ?? DEFAULT_ANALYSIS_DRAFT;
  const draftRef = useRef(draft); useEffect(() => { draftRef.current = draft; }, [draft]);
  const busy = submitting || uploading;
  const locked = busy || Boolean(pending);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.');
  const update = (patch: Partial<AnalysisDraft>) => store.setAnalysisDraft(draftId, { ...draftRef.current, ...patch });
  const ready = Boolean(draft.prompt.trim() && draft.source && (draft.source.kind !== 'youtube' || draft.source.url.trim()));
  useEffect(() => {
    const controller = new AbortController();
    void studioJson<Options>('/api/v1/options?media=analysis', { signal: controller.signal }).then(setOptions).catch(e => { if (!controller.signal.aborted) report(e); });
    return () => controller.abort();
  }, []);
  async function analyze() {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError(''); const viewId = activeView?.id;
    try {
      const submission: { key: string; body: ReturnType<typeof analysisBody> } = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body: analysisBody(draft) };
      setPending(JSON.stringify(submission));
      const accepted = await studioJson<{ id: string }>('/api/v1/analyses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body) });
      setPending(''); store.clearAnalysisDraft(draftId);
      if (store.getSnapshot().activeId === viewId) replaceCurrent(`/analysis/${accepted.id}`, titleOf(submission.body.prompt));
      else { if (viewId) store.replaceTab(viewId, `/analysis/${accepted.id}`); toast.success('Analysis started.'); }
    } catch (e) {
      if (!(e instanceof MediaClientError) || (e.status >= 400 && e.status < 500)) setPending('');
      report(e);
    } finally { submittingRef.current = false; setSubmitting(false); }
  }
  async function upload(file: File) {
    if (file.size > MAX_ANALYSIS_UPLOAD_BYTES) { setError('Videos must be at most 200 MiB.'); return; }
    setUploading(true); setError('');
    try {
      const asset = await studioJson<{ id: string }>('/api/v1/assets?media=analysis', { method: 'POST', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
      update({ source: { kind: 'asset', assetId: asset.id }, sourceLabel: file.name });
    } catch (e) { report(e); } finally { setUploading(false); }
  }
  async function openLibrary() {
    setPicked(null); setDrawer('library');
    try { setVideos((await studioJson<{ items: MediaSummary[] }>('/api/v1/videos')).items.filter(video => video.thumbnailAssetId)); } catch (e) { report(e); }
  }
  async function pickVideo(video: MediaSummary) {
    try {
      const detail = await studioJson<VideoResource>(`/api/v1/videos/${video.id}`);
      if (detail.clips.length > 1) { setPicked(detail); return; }
      choose({ kind: 'video', videoItemId: detail.id, generationId: null, clip: null }, detail.title);
    } catch (e) { report(e); }
  }
  const choose = (source: AnalysisSource, label: string) => { update({ source, sourceLabel: label }); setDrawer(''); setPicked(null); };
  const title = titleOf(draft.prompt) || 'New analysis';
  const models = options ? [...new Set([options.model, ...options.capabilities.agenticModels])] : [];
  const source = draft.source;
  const selectedSourceId = source?.kind === 'video' ? source.videoItemId : source?.kind === 'asset' ? source.assetId : source?.kind === 'youtube' ? source.url || null : null;
  const composerSnapshot = useMemo(() => ({
    surface: 'composer' as const,
    route: '/studio/analysis',
    draftKind: 'analysis' as const,
    draftTitle: title,
    promptExcerpt: draft.prompt.trim().slice(0, 240) || undefined,
    selectedSourceId,
  }), [title, draft.prompt, selectedSourceId]);
  usePublishChatViewContext(composerSnapshot, {
    patchComposerDraft: (draftKind, patch) => {
      if (draftKind !== 'analysis') return;
      const nextPatch: Partial<AnalysisDraft> = {};
      if (typeof patch.prompt === 'string') nextPatch.prompt = patch.prompt;
      if (typeof patch.youtubeUrl === 'string' && patch.youtubeUrl.trim()) {
        nextPatch.source = { kind: 'youtube', url: patch.youtubeUrl.trim() };
        nextPatch.sourceLabel = patch.youtubeUrl.trim();
      } else if (typeof patch.videoItemId === 'string' && patch.videoItemId.trim()) {
        nextPatch.source = { kind: 'video', videoItemId: patch.videoItemId.trim(), generationId: null, clip: null };
      }
      if (typeof patch.narrate === 'boolean') nextPatch.narrate = patch.narrate;
      if (typeof patch.model === 'string') nextPatch.model = patch.model;
      if (typeof patch.longVideo === 'boolean') nextPatch.longVideo = patch.longVideo;
      if (typeof patch.systemInstruction === 'string') nextPatch.systemInstruction = patch.systemInstruction;
      if (Object.keys(nextPatch).length > 0) update(nextPatch);
    },
  });
  return <WorkbenchPanel workspacePage title={title} icon={<ScanSearch size={13} />} bodyClassName="gap-0 p-0"
    actions={[{ icon: PanelRight, label: 'Analysis options', onClick: () => setDrawer(drawer === 'options' ? '' : 'options'), expanded: drawer === 'options' }]}>
    <MediaComposer heading="Ask about a video" label="Analysis prompt" placeholder="What do you want to know?" value={draft.prompt} maxLength={32000}
      disabled={locked} onChange={prompt => update({ prompt })} onSubmit={() => void analyze()} busy={busy}
      actionLabel={pending && !submitting ? 'Retry submission' : submitting ? 'Analyzing…' : 'Analyze'}
      actionDisabled={busy || (!pending && !ready) || options?.available === false}
      footer={<div className="flex min-w-0 flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><Switch checked={draft.narrate} disabled={locked} onCheckedChange={narrate => update({ narrate })} />Narrate result</label>
        {draft.narrate && <div className="w-full min-w-0 sm:w-64"><VoicePicker id="analysis-voice" value={draft.voice ?? defaultReader} onChange={voice => update({ voice })} /></div>}
      </div>}>
      {source ? <div className="flex min-w-0 items-center gap-2">
        {source.kind === 'youtube'
          ? <Input aria-label="YouTube link" placeholder="YouTube link" value={source.url} disabled={locked} onChange={event => update({ source: { kind: 'youtube', url: event.target.value }, sourceLabel: event.target.value })} />
          : <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">{source.kind === 'asset' ? <Upload size={16} className="shrink-0 text-ink-muted" /> : <Library size={16} className="shrink-0 text-ink-muted" />}<span className="truncate">{draft.sourceLabel || 'Video'}{source.kind === 'video' && source.clip ? ` · Clip ${source.clip}` : ''}</span></span>}
        <MediaIconAction label="Remove video" disabled={locked} onClick={() => update({ source: null, sourceLabel: '' })}><X size={16} /></MediaIconAction>
      </div> : <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={locked} onClick={() => uploadRef.current?.click()}>{uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}Upload video</Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => void openLibrary()}><Library size={15} />From Library</Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => update({ source: { kind: 'youtube', url: '' }, sourceLabel: '' })}><Link2 size={15} />YouTube link</Button>
      </div>}
    </MediaComposer>
    {(error || options?.available === false || (pending && !submitting)) && <div className="grid shrink-0 gap-2 p-4 sm:p-6">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {options?.available === false && <p role="alert" className="text-sm text-destructive">Video analysis is unavailable on this Studio.</p>}
      {pending && !submitting && <p role="status" className="text-xs text-ink-muted">Submission unconfirmed. Retry safely with the same request.</p>}
    </div>}
    <input ref={uploadRef} type="file" accept={ANALYSIS_UPLOAD_ACCEPT} className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
    <Sheet open={Boolean(drawer)} onOpenChange={open => { if (!open) { setDrawer(''); setPicked(null); } }}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>{drawer === 'library' ? picked?.title ?? 'From Library' : 'Analysis options'}</SheetTitle>
      <SheetDescription className="sr-only">{drawer === 'library' ? 'Choose a video from your Library.' : 'Optional analysis settings.'}</SheetDescription>
      {drawer === 'library' ? picked ? <div className="grid gap-2">
        <button className="flex items-center gap-3 rounded-md border border-border p-2 text-left text-sm" onClick={() => choose({ kind: 'video', videoItemId: picked.id, generationId: null, clip: null }, picked.title)}>
          {picked.thumbnailAssetId && <AssetImage id={picked.thumbnailAssetId} thumbnail alt={picked.title} className="h-14 w-20 rounded" />}Whole video</button>
        {picked.clips.map(clip => <button key={clip.index} className="flex items-center gap-3 rounded-md border border-border p-2 text-left text-sm" onClick={() => choose({ kind: 'video', videoItemId: picked.id, generationId: picked.latestSuccessfulGenerationId, clip: clip.index }, picked.title)}>
          <PrivateThumbnail path={clip.thumbnail} alt={`Clip ${clip.index}`} className="h-14 w-20 rounded object-cover" />Clip {clip.index}</button>)}
      </div> : <div className="grid gap-2">
        {videos === null ? <p role="status" className="text-sm text-ink-muted">Loading videos…</p> : !videos.length ? <p className="text-sm text-ink-muted">No videos yet.</p>
          : videos.map(video => <button key={video.id} className="flex items-center gap-3 rounded-md border border-border p-2 text-left text-sm" onClick={() => void pickVideo(video)}>
            <AssetImage id={video.thumbnailAssetId!} thumbnail alt={video.title} className="h-14 w-20 shrink-0 rounded" /><span className="min-w-0 truncate">{video.title}</span></button>)}
      </div> : <fieldset disabled={locked} className="grid gap-6 disabled:opacity-60">
        <label className="grid gap-2 text-sm font-medium">Model<select aria-label="Analysis model" className="rounded-md border border-input bg-background p-2" value={draft.model} onChange={event => update({ model: event.target.value })}>
          <option value="">{options ? `Default (${options.model})` : 'Default'}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={draft.longVideo} onChange={event => update({ longVideo: event.target.checked })} />Long video mode</label>
        {!draft.longVideo && <div className="grid grid-cols-3 gap-3">
          <label className="grid gap-2 text-sm font-medium">Start<Input aria-label="Start" placeholder="0:00" value={draft.start} onChange={event => update({ start: event.target.value })} /></label>
          <label className="grid gap-2 text-sm font-medium">End<Input aria-label="End" value={draft.end} onChange={event => update({ end: event.target.value })} /></label>
          <label className="grid gap-2 text-sm font-medium">Frame rate<Input aria-label="Frame rate" inputMode="decimal" placeholder="1" value={draft.fps} onChange={event => update({ fps: event.target.value })} /></label>
        </div>}
        <label className="grid gap-2 text-sm font-medium">Detail<select aria-label="Media resolution" className="rounded-md border border-input bg-background p-2" value={draft.mediaResolution} onChange={event => update({ mediaResolution: event.target.value as AnalysisDraft['mediaResolution'] })}>
          <option value="">Default</option>{ANALYSIS_RESOLUTIONS.map(value => <option key={value} value={value}>{RESOLUTION_LABELS[value]}</option>)}</select></label>
        <label className="grid gap-2 text-sm font-medium">Instructions<Textarea aria-label="System instruction" value={draft.systemInstruction} maxLength={8000} onChange={event => update({ systemInstruction: event.target.value })} /></label>
      </fieldset>}
      <Button variant="outline" onClick={() => { setDrawer(''); setPicked(null); }}>Done</Button>
    </SheetContent></Sheet>
  </WorkbenchPanel>;
}

/** The private path a source video plays from, when it plays here at all. YouTube does not. */
function useSourcePath(source: AnalysisSource | undefined): string | null {
  const [assetPath, setAssetPath] = useState<{ key: string; path: string | null }>({ key: '', path: null });
  const key = source?.kind === 'video' && !source.clip ? source.generationId ?? '' : '';
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void studioJson<{ assets: Array<{ id: string }> }>(`/api/v1/generations/${key}`, { signal: controller.signal })
      .then(generation => setAssetPath({ key, path: generation.assets[0] ? `/api/v1/assets/${generation.assets[0].id}/content` : null }))
      .catch(() => { if (!controller.signal.aborted) setAssetPath({ key, path: null }); });
    return () => controller.abort();
  }, [key]);
  if (!source || source.kind === 'youtube') return null;
  if (source.kind === 'asset') return `/api/v1/assets/${source.assetId}/content`;
  if (source.clip) return `/api/v1/videos/${source.videoItemId}/clips/${source.clip}/content${source.generationId ? `?generationId=${source.generationId}` : ''}`;
  return assetPath.key === key ? assetPath.path : null;
}

function useAnswer(assetId: string | undefined) {
  const [answer, setAnswer] = useState({ id: '', text: '' });
  useEffect(() => {
    if (!assetId) return;
    const controller = new AbortController();
    void studioFetch(`/api/v1/assets/${assetId}/content`, { signal: controller.signal }).then(response => response.text())
      .then(text => { if (!controller.signal.aborted) setAnswer({ id: assetId, text }); }).catch(() => {});
    return () => controller.abort();
  }, [assetId]);
  return answer.id === assetId ? answer.text : '';
}

/** The source video and the rendered analysis document. */
function AnalysisView({ id }: { id: string }) {
  const { store } = useWorkspace(); const router = useRouter();
  const [analysis, setAnalysis] = useState<AnalysisResource | null>(null);
  const [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [drawer, setDrawer] = useWorkspaceField('analysisDrawer', '');
  const [pending, setPending] = useWorkspaceField('analysisSubmission', '');
  const [versions, setVersions] = useState<AnalysisGenerationResource[]>([]), [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [selected, setSelected] = useState<AnalysisGenerationResource | null>(null);
  const playerRef = useRef<HTMLVideoElement>(null), submittingRef = useRef(false);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.');
  const result = selected ?? analysis?.result ?? null;
  const latest = analysis?.latestGeneration;
  const busy = submitting || running(analysis?.status);
  const failed = latest && ['error', 'interrupted'].includes(latest.status) && !selected ? latest : null;
  const source = (result ?? latest)?.request.source;
  const media = usePrivateMedia(useSourcePath(source));
  const answer = useAnswer(result?.assets[0]?.id);
  const json = result?.assets[0]?.mimeType === 'application/json';
  const narration = result?.narrationId && !result.narrationError ? result.narrationId : null;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await studioJson<AnalysisResource>(`/api/v1/analyses/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAnalysis(next); setLoadError(''); timer = setTimeout(load, running(next.status) ? 2000 : 10_000);
      } catch (e) { if (!controller.signal.aborted) { setLoadError((e as Error).message); timer = setTimeout(load, 10_000); } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function submit(body: Record<string, unknown>) {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError('');
    try {
      const submission: { key: string; body: Record<string, unknown> } = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body };
      setPending(JSON.stringify(submission));
      await studioJson(`/api/v1/analyses/${id}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body) });
      setPending(''); setSelected(null);
      setAnalysis(await studioJson<AnalysisResource>(`/api/v1/analyses/${id}`));
    } catch (e) {
      if (!(e instanceof MediaClientError) || (e.status >= 400 && e.status < 500)) setPending('');
      report(e);
    } finally { submittingRef.current = false; setSubmitting(false); }
  }
  // A retry repeats the failed attempt: its prompt, and its follow-up when it was one. Narration keeps the Studio voice.
  const retry = () => failed && void submit({ prompt: failed.request.prompt, ...(failed.request.previousInteractionId ? { previousInteractionId: failed.request.previousInteractionId } : {}), ...(failed.narrationId ? { narrate: true } : {}) });
  async function history(older = false) {
    try {
      const page = await studioJson<{ items: AnalysisGenerationResource[]; nextCursor: typeof cursor }>(`/api/v1/analyses/${id}/generations${older && cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ''}`);
      setVersions(previous => older ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); setDrawer('history');
    } catch (e) { report(e); }
  }
  function narrate() {
    const draft = crypto.randomUUID();
    store.setDraft(draft, { markdown: answer }); router.push(`/studio?draft=${draft}`);
  }
  const seek = media.url ? (seconds: number) => { const player = playerRef.current; if (!player) return; player.currentTime = seconds; void player.play().catch(() => {}); } : undefined;
  const sourceVideoId = source?.kind === 'video' ? source.videoItemId : source?.kind === 'asset' ? source.assetId : null;
  const sourceYoutubeUrl = source?.kind === 'youtube' ? source.url : null;
  const viewTitle = analysis?.title || result?.request.prompt.trim().split('\n')[0] || 'Video analysis';
  const viewSnapshot = useMemo(() => ({
    surface: 'analysis' as const,
    route: `/analysis/${id}`,
    itemId: id,
    title: viewTitle,
    status: analysis?.status,
    sourceVideoId,
    sourceYoutubeUrl,
  }), [id, viewTitle, analysis?.status, sourceVideoId, sourceYoutubeUrl]);
  usePublishChatViewContext(viewSnapshot, {
    getPlayheadSeconds: () => (playerRef.current ? playerRef.current.currentTime : null),
    seek: (seconds, play) => {
      const player = playerRef.current;
      if (!player) return;
      player.currentTime = seconds;
      if (play !== false) void player.play().catch(() => {});
    },
    togglePlay: () => {
      const player = playerRef.current;
      if (!player) return;
      if (player.paused || player.ended) void player.play().catch(() => {});
      else player.pause();
    },
  });
  const menu: HeaderAction = { icon: MoreHorizontal, label: 'Analysis actions', menu: <>
    <DropdownMenuItem onSelect={() => void history()}><History size={15} />History</DropdownMenuItem>
    {!narration && !json && <DropdownMenuItem disabled={!answer} onSelect={narrate}><AudioLines size={15} />Narrate</DropdownMenuItem>}
  </> };
  return <WorkbenchPanel workspacePage title={analysis?.title ?? 'Analysis'} icon={<ScanSearch size={13} />} viewGrid gridVariant="reader"
    actions={narration ? [menu, { icon: Headphones, label: 'Listen', onClick: () => router.push(`/narration/${narration}`) }] : [menu]}>
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    {!analysis && !loadError && <p role="status" className="text-sm text-ink-muted">Loading analysis…</p>}
    {source?.kind === 'youtube' ? <a href={source.url} target="_blank" rel="noreferrer" className="justify-self-start text-sm underline decoration-border-strong underline-offset-4 hover:text-primary">Watch on YouTube</a>
      : media.url ? <video key={media.url} ref={playerRef} src={media.url} controls playsInline preload="metadata" aria-label="Source video" className="max-h-[42dvh] w-full rounded-lg border border-border bg-black" />
        : source && <div role="status" className="grid min-h-40 place-content-center rounded-lg bg-muted text-sm text-ink-muted">{media.error || 'Loading video…'}</div>}
    {selected && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setSelected(null)}>Back to latest</Button>}
    {busy && !selected && <div role="status" className="grid min-w-0 grid-cols-[15px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-ink-muted">
      <Loader2 size={15} className="animate-spin" /><p className="text-sm">Analyzing…</p>
      {latest?.progress && <p className="col-start-2 truncate text-xs">{latest.progress}</p>}
    </div>}
    {(failed?.error || error) && !busy && <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-destructive">{error || failed?.error?.message}</p>
      {failed && <Button variant="outline" size="sm" onClick={retry}>Retry</Button>}
    </div>}
    {answer && <AnalysisAnswer markdown={answer} json={json} onSeek={seek} />}
    <Sheet open={drawer === 'history'} onOpenChange={open => { if (!open) setDrawer(''); }}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>History</SheetTitle><SheetDescription className="sr-only">Read earlier answers without replacing the latest.</SheetDescription>
      <div className="grid gap-2">{versions.map(version => <button key={version.id} disabled={version.status !== 'ready'} className="grid gap-1 rounded-md border border-border p-3 text-left text-sm disabled:opacity-50" onClick={() => { setSelected(version); setDrawer(''); }}>
        <span className="truncate">{version.request.prompt.trim().split('\n')[0]}</span><span className="text-xs text-ink-muted">{new Date(version.createdAt).toLocaleString()}</span>
      </button>)}{cursor && <Button variant="outline" onClick={() => void history(true)}>Older attempts</Button>}</div>
      <Button variant="outline" onClick={() => setDrawer('')}>Done</Button>
    </SheetContent></Sheet>
  </WorkbenchPanel>;
}
