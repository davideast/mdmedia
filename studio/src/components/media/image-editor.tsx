'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, ImageIcon, Loader2, PanelRight, Upload, Copy, History, Expand, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useWorkspace, useWorkspaceField } from '@/components/shell/workspace-provider';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_REQUEST,
  EXTENDED_IMAGE_RATIOS,
  IMAGE_MODELS,
  IMAGE_RATIOS,
  IMAGE_RESOLUTIONS,
  MAX_IMAGE_PROMPT,
  MAX_IMAGE_REFERENCES,
  MAX_REFERENCE_BYTES,
  STANDARD_IMAGE_RATIOS,
  collectReferenceAssetIds,
} from '@/lib/image-request';
import type { ImageAction, ImageDraft, ImageGenerationResource, ImageRequest, ImageResource, ImageThinkingLevel } from '@/lib/media-types';
import { MediaClientError, studioJson } from '@/lib/media-client';
import { AssetImage, downloadAsset } from './asset-image';
import { MediaComposer, MediaIconAction } from './media-composer';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth-context';

type Options = { available: boolean; defaults: ImageRequest; capabilities: { aspectRatios: string[]; resolutions: string[] } };

const EMPTY_DRAFT: ImageDraft = {
  kind: 'image',
  prompt: '',
  model: DEFAULT_IMAGE_MODEL,
  aspectRatio: '16:9',
  resolution: '',
  adapt: false,
  instructions: '',
  referenceAssetId: null,
  referenceAssetIds: [],
  videoUri: '',
  searchGrounding: { web: false, imageSearch: false },
  thinkingLevel: '',
};

const supportsExtendedRatios = (model: string) => model === 'gemini-nano-banana-2.1' || model === 'gemini-3.1-flash-image';
const is1KOnlyModel = (model: string) => model === 'gemini-3.1-flash-lite-image' || model === 'gemini-2.5-flash-image';
const supportsWebSearch = (model: string) => model === 'gemini-nano-banana-2.1' || model === 'gemini-3.1-flash-image' || model === 'gemini-3-pro-image';
const supportsImageSearch = (model: string) => model === 'gemini-nano-banana-2.1' || model === 'gemini-3.1-flash-image';
const supportsVideoInput = (model: string) => model === 'gemini-nano-banana-2.1' || model === 'gemini-3.1-flash-image' || model === 'gemini-3.1-flash-lite-image';
const maxRefsForModel = (model: string) => (model === 'gemini-2.5-flash-image' ? 3 : MAX_IMAGE_REFERENCES);
const supportedAspectRatios = (model: string): readonly string[] => (supportsExtendedRatios(model) ? IMAGE_RATIOS : STANDARD_IMAGE_RATIOS);
const supportedResolutions = (model: string): readonly string[] => {
  if (model === 'gemini-3.1-flash-image') return IMAGE_RESOLUTIONS;
  if (is1KOnlyModel(model)) return ['1K'];
  return ['1K', '2K', '4K'];
};
const supportedThinkingLevels = (model: string): readonly ImageThinkingLevel[] => {
  if (model === 'gemini-nano-banana-2.1') return ['minimal', 'medium', 'high'];
  if (model === 'gemini-3.1-flash-image' || model === 'gemini-3.1-flash-lite-image') return ['minimal', 'high'];
  return [];
};

const fromDraft = (draft: ImageDraft): ImageRequest => {
  const ids = collectReferenceAssetIds(draft);
  return {
    prompt: draft.prompt,
    model: draft.model || DEFAULT_IMAGE_MODEL,
    adaptation: { enabled: draft.adapt, instructions: draft.instructions },
    output: { aspectRatio: draft.aspectRatio, resolution: draft.resolution || null },
    referenceAssetId: ids[0] ?? null,
    referenceAssetIds: ids,
    videoUri: draft.videoUri ?? '',
    searchGrounding: draft.searchGrounding ?? { web: false, imageSearch: false },
    thinkingLevel: draft.thinkingLevel ? draft.thinkingLevel : null,
  };
};

const toDraft = (request: ImageRequest): ImageDraft => {
  const ids = collectReferenceAssetIds(request);
  return {
    kind: 'image',
    prompt: request.prompt,
    model: request.model || DEFAULT_IMAGE_MODEL,
    adapt: request.adaptation.enabled,
    instructions: request.adaptation.instructions,
    aspectRatio: request.output.aspectRatio,
    resolution: request.output.resolution ?? '',
    referenceAssetId: ids[0] ?? null,
    referenceAssetIds: ids,
    videoUri: request.videoUri ?? '',
    searchGrounding: request.searchGrounding ?? { web: false, imageSearch: false },
    thinkingLevel: request.thinkingLevel ?? '',
  };
};

const phaseLabel = (phase: string) => ({ queued: 'Waiting to start…', starting: 'Starting…', preparing: 'Preparing visual prompt…', generating: 'Generating image…', saving: 'Saving image…' }[phase] ?? phase);

export function ImageEditor({ id }: { id?: string }) {
  const { state, store, draftId, activeView, replaceCurrent } = useWorkspace();
  const { updateSettings } = useAuth();
  const router = useRouter();
  const [options, setOptions] = useState<Options | null>(null);
  const [item, setItem] = useState<ImageResource | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [optionsOpen, setOptionsOpen] = useWorkspaceField('imageOptionsOpen', false);
  const [edit, setEdit] = useWorkspaceField('imageEdit', '');
  const [pending, setPending] = useWorkspaceField('imageSubmission', '');
  const [versions, setVersions] = useState<ImageGenerationResource[] | null>(null);
  const [versionCursor, setVersionCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [selected, setSelected] = useState<ImageGenerationResource | null>(null);
  const [rename, setRename] = useState('');
  const [viewerOpen, setViewerOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const base = id ? item?.request ?? DEFAULT_IMAGE_REQUEST : state.imageDrafts?.[draftId] ? fromDraft(state.imageDrafts[draftId]) : options?.defaults ?? fromDraft(EMPTY_DRAFT);
  let request = base;
  if (id && edit) { try { request = JSON.parse(edit) as ImageRequest; } catch { /* A malformed local edit never replaces the persisted source. */ } }
  const requestRef = useRef(request);
  useEffect(() => { requestRef.current = request; }, [request]);
  const activeModel = request.model || DEFAULT_IMAGE_MODEL;
  const maxRefs = maxRefsForModel(activeModel);
  const refIds = collectReferenceAssetIds(request);
  const searchGrounding = request.searchGrounding ?? { web: false, imageSearch: false };
  const thinkingLevels = supportedThinkingLevels(activeModel);
  const busy = submitting || uploading || ['queued', 'generating'].includes(item?.status ?? '');
  const current = selected ?? item?.result ?? item?.latestGeneration ?? null;
  const asset = (selected?.assets.length ? selected : item?.result)?.assets[0];
  const update = (patch: Partial<ImageRequest>) => {
    const merged: ImageRequest = { ...requestRef.current, ...patch };
    const syncedIds = patch.referenceAssetIds !== undefined
      ? patch.referenceAssetIds
      : patch.referenceAssetId !== undefined
        ? (patch.referenceAssetId ? [patch.referenceAssetId] : [])
        : collectReferenceAssetIds(merged);
    const next: ImageRequest = {
      ...merged,
      model: merged.model || DEFAULT_IMAGE_MODEL,
      referenceAssetIds: syncedIds,
      referenceAssetId: syncedIds[0] ?? null,
    };
    if (id) setEdit(JSON.stringify(next)); else store.setImageDraft(draftId, toDraft(next));
  };
  const selectModel = (nextModel: string) => {
    const currentReq = requestRef.current;
    const nextRatio = (EXTENDED_IMAGE_RATIOS as readonly string[]).includes(currentReq.output.aspectRatio) && !supportsExtendedRatios(nextModel)
      ? '16:9'
      : currentReq.output.aspectRatio;
    let nextRes = currentReq.output.resolution;
    if (nextRes === '0.5K' && nextModel !== 'gemini-3.1-flash-image') nextRes = null;
    if ((nextRes === '2K' || nextRes === '4K') && is1KOnlyModel(nextModel)) nextRes = '1K';
    const allowedThinking = supportedThinkingLevels(nextModel);
    const nextThinking = currentReq.thinkingLevel && allowedThinking.includes(currentReq.thinkingLevel) ? currentReq.thinkingLevel : null;
    const sg = currentReq.searchGrounding ?? { web: false, imageSearch: false };
    const nextSearch = {
      web: supportsWebSearch(nextModel) ? sg.web : false,
      imageSearch: supportsImageSearch(nextModel) ? sg.imageSearch : false,
    };
    const nextVideoUri = supportsVideoInput(nextModel) ? (currentReq.videoUri ?? '') : '';
    const nextRefIds = collectReferenceAssetIds(currentReq).slice(0, maxRefsForModel(nextModel));
    update({
      model: nextModel,
      output: { ...currentReq.output, aspectRatio: nextRatio, resolution: nextRes },
      thinkingLevel: nextThinking,
      searchGrounding: nextSearch,
      videoUri: nextVideoUri,
      referenceAssetIds: nextRefIds,
      referenceAssetId: nextRefIds[0] ?? null,
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    void studioJson<Options>('/api/v1/options?media=image', { signal: controller.signal }).then(setOptions).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await studioJson<ImageResource>(`/api/v1/images/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setItem(next); setLoadError('');
        timer = setTimeout(load, ['queued', 'generating'].includes(next.status) ? 2000 : 10_000);
      } catch (e) { if (!controller.signal.aborted) { setLoadError((e as Error).message); timer = setTimeout(load, 10_000); } }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function submit(action: ImageAction = id ? 'regenerate' : 'initial') {
    if (pendingRef.current) return;
    pendingRef.current = true; setSubmitting(true); setError('');
    const submittingViewId = activeView?.id;
    let submission: { key: string; body: ImageRequest };
    try {
      const normalizedBody: ImageRequest = {
        prompt: request.prompt,
        model: activeModel,
        adaptation: request.adaptation,
        output: request.output,
        referenceAssetId: refIds[0] ?? null,
        referenceAssetIds: refIds,
        ...(supportsVideoInput(activeModel) && request.videoUri?.trim() ? { videoUri: request.videoUri.trim() } : { videoUri: null }),
        ...(supportsWebSearch(activeModel) ? { searchGrounding: { web: Boolean(searchGrounding.web), imageSearch: supportsImageSearch(activeModel) ? Boolean(searchGrounding.imageSearch) : false } } : {}),
        ...(request.thinkingLevel && thinkingLevels.includes(request.thinkingLevel) ? { thinkingLevel: request.thinkingLevel } : { thinkingLevel: null }),
        ...(id ? { action, ...(action === 'refine' && current?.id ? { fromGenerationId: current.id } : {}) } : {}),
      };
      submission = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body: normalizedBody };
      setPending(JSON.stringify(submission));
      const accepted = await studioJson<{ id: string; generation: ImageGenerationResource }>(id ? `/api/v1/images/${id}/generations` : '/api/v1/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body),
      });
      setPending(''); setSelected(null); setVersions(null);
      if (!id) {
        store.clearImageDraft(draftId);
        if (store.getSnapshot().activeId === submittingViewId) replaceCurrent(`/image/${accepted.id}`, submission.body.prompt.trim().split('\n')[0].slice(0, 100));
        else { if (submittingViewId) store.replaceTab(submittingViewId, `/image/${accepted.id}`); toast.success('Image generation started. Find it in Activity.'); }
      }
      else { setEdit(''); setItem(await studioJson<ImageResource>(`/api/v1/images/${id}`)); }
    } catch (e) {
      if (e instanceof MediaClientError && e.status >= 400 && e.status < 500) setPending('');
      setError((e as Error).message);
    } finally { pendingRef.current = false; setSubmitting(false); }
  }
  async function attach(files: File[]) {
    if (!files.length) return;
    if (files.some(file => file.size > MAX_REFERENCE_BYTES)) { setError('Reference images must be at most 10 MiB.'); return; }
    const existingIds = collectReferenceAssetIds(requestRef.current);
    const limit = maxRefsForModel(requestRef.current.model || DEFAULT_IMAGE_MODEL);
    if (existingIds.length + files.length > limit) {
      setError(`At most ${limit} reference images are allowed for this model.`);
      return;
    }
    setUploading(true); setError('');
    try {
      const uploadedIds: string[] = [];
      for (const file of files) {
        const uploaded = await studioJson<{ id: string }>('/api/v1/assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        uploadedIds.push(uploaded.id);
      }
      const nextIds = Array.from(new Set([...collectReferenceAssetIds(requestRef.current), ...uploadedIds])).slice(0, limit);
      update({ referenceAssetIds: nextIds, referenceAssetId: nextIds[0] ?? null });
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  function removeReference(assetId: string) {
    const nextIds = collectReferenceAssetIds(requestRef.current).filter(item => item !== assetId);
    update({ referenceAssetIds: nextIds, referenceAssetId: nextIds[0] ?? null });
  }
  function clearReferences() {
    update({ referenceAssetIds: [], referenceAssetId: null });
  }
  async function history(older = false) {
    try {
      const suffix = older && versionCursor ? `?cursor=${encodeURIComponent(JSON.stringify(versionCursor))}` : '';
      const page = await studioJson<{ items: ImageGenerationResource[]; nextCursor: typeof versionCursor }>(`/api/v1/images/${id}/generations${suffix}`);
      setVersions(previous => older ? [...(previous ?? []), ...page.items] : page.items); setVersionCursor(page.nextCursor);
    } catch (e) { setError((e as Error).message); }
  }
  function duplicate() {
    const nextId = crypto.randomUUID(); store.setImageDraft(nextId, toDraft(request)); router.push(`/studio/image?draft=${nextId}`);
  }
  const title = id ? item?.title ?? 'Image' : request.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'New image';
  const canSubmit = !busy && (Boolean(pending) || Boolean(request.prompt.trim())) && options?.available !== false && !(id && !item);
  return <WorkbenchPanel workspacePage title={title} icon={<ImageIcon size={13} strokeWidth={2} />} bodyClassName="gap-0 p-0"
    actions={[{ icon: PanelRight, label: 'Image options', onClick: () => setOptionsOpen(!optionsOpen), expanded: optionsOpen }]}>
    {loadError && <p role="alert" className="px-4 pt-4 text-sm text-destructive sm:px-6">{loadError}</p>}
    {asset && <div className="grid shrink-0 gap-3 p-4 pb-0 sm:p-6 sm:pb-0">
      <AssetImage id={asset.id} alt={item?.title ?? 'Generated image'} className="h-[55dvh] min-h-64 rounded-lg border border-border p-2" />
      <div className="flex flex-wrap items-center gap-2">
        <MediaIconAction label="Download" onClick={() => void downloadAsset(asset.id, `${item?.title ?? 'image'}.${asset.mimeType.split('/')[1]}`).catch(e => setError(e.message))}><Download size={16} /></MediaIconAction>
        <MediaIconAction label="View full size" onClick={() => { setActualSize(false); setViewerOpen(true); }}><Expand size={16} /></MediaIconAction>
        <span className="text-xs text-ink-muted">{asset.width} × {asset.height} · {asset.mimeType.replace('image/', '').toUpperCase()}</span>
      </div>
      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}><DialogContent className="flex h-[90dvh] w-[95vw] max-w-none flex-col gap-3 p-4 sm:max-w-none"><DialogTitle className="pr-8">{item?.title ?? 'Generated image'}</DialogTitle><DialogDescription className="sr-only">Inspect the image fitted to the window or at its actual pixel size.</DialogDescription><div><Button variant="outline" size="sm" onClick={() => setActualSize(!actualSize)}>{actualSize ? 'Fit to window' : 'Actual size'}</Button></div><div className="min-h-0 flex-1 overflow-auto"><div style={actualSize ? { width: asset.width, height: asset.height } : { width: '100%', height: '100%' }}><AssetImage id={asset.id} alt="Full size image" className="h-full w-full" /></div></div></DialogContent></Dialog>
    </div>}
    {id && !item && !loadError && <p role="status" className="p-4 sm:p-6">Loading image…</p>}
    <MediaComposer
      heading={asset ? 'Refine your image' : 'Describe an image'}
      label="Image prompt"
      placeholder="Describe or paste here. Markdown is fine."
      value={request.prompt}
      maxLength={MAX_IMAGE_PROMPT}
      disabled={submitting || Boolean(pending)}
      onChange={prompt => update({ prompt })}
      onSubmit={() => void submit(id ? 'regenerate' : 'initial')}
      actionLabel={pending && !submitting ? 'Retry submission' : busy ? 'Generating…' : item ? 'Generate new version' : 'Generate image'}
      actionDisabled={!canSubmit}
      busy={busy}
      grow={!id}
      footer={<div className="flex flex-wrap items-center gap-2">
        <MediaIconAction label="Import Markdown" onClick={() => importRef.current?.click()} disabled={Boolean(pending)}><Upload size={16} /></MediaIconAction>
        <MediaIconAction label={uploading ? 'Uploading reference' : 'Attach reference'} onClick={() => referenceRef.current?.click()} disabled={uploading || Boolean(pending) || refIds.length >= maxRefs}>{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</MediaIconAction>
        <span className="text-xs text-ink-muted">References ({refIds.length}/{maxRefs})</span>
        {refIds.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={Boolean(pending)} onClick={clearReferences}>Clear all</Button>}
        {item && current?.status === 'ready' && (
          <Button type="button" variant="outline" size="sm" className="ml-auto rounded-full px-4" disabled={!canSubmit} onClick={() => void submit('refine')}>
            Refine image
          </Button>
        )}
      </div>}
    >
      {refIds.length > 0 && <div className="flex flex-wrap items-center gap-2">
        {refIds.map((refId, index) => (
          <div key={refId} className="flex items-center gap-3 rounded-lg border border-border p-2">
            <AssetImage id={refId} thumbnail alt={`Reference image ${index + 1}`} className="h-16 w-20 rounded" />
            <span className="t-meta flex-1">Reference {index + 1}</span>
            <MediaIconAction label={`Remove reference ${index + 1}`} disabled={Boolean(pending)} onClick={() => removeReference(refId)}><X size={16} /></MediaIconAction>
          </div>
        ))}
      </div>}
    </MediaComposer>
      <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (file.size > MAX_IMAGE_PROMPT * 4) setError('This Markdown file is too large.'); else void file.text().then(text => { if (text.length > MAX_IMAGE_PROMPT) setError('Image prompts are limited to 32,000 characters.'); else update({ prompt: text }); }); } event.target.value = ''; }} />
      <input ref={referenceRef} className="hidden" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={event => { const files = event.target.files ? Array.from(event.target.files) : []; if (files.length) void attach(files); event.target.value = ''; }} />
    {(error || pending || options?.available === false || item?.latestGeneration?.error || ['queued', 'generating'].includes(item?.latestGeneration?.status ?? '')) && <div className="grid shrink-0 gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
      {item?.latestGeneration && ['queued', 'generating'].includes(item.latestGeneration.status) && <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={15} className="animate-spin" />{phaseLabel(item.latestGeneration.phase)}</p>}
      {options?.available === false && <p role="alert" className="text-sm text-destructive">Image generation is unavailable on this Studio.</p>}
      {(error || item?.latestGeneration?.error) && <p role="alert" className="text-sm text-destructive">{error || item?.latestGeneration?.error?.message}</p>}
      {pending && <p className="text-xs text-ink-muted">The submission has not been confirmed. Retry submission uses the same request key to avoid starting another generation.</p>}
    </div>}
    {id && item && <div className="grid shrink-0 gap-3 border-t border-border p-4 sm:p-6">
      <div className="flex flex-wrap gap-1"><MediaIconAction label="Duplicate" onClick={duplicate}><Copy size={16} /></MediaIconAction><MediaIconAction label="History" aria-expanded={Boolean(versions)} onClick={() => versions ? setVersions(null) : void history()}><History size={16} /></MediaIconAction></div>
      {versions && <div className="grid gap-2" aria-label="Image versions">{versions.map((version) => <button type="button" key={version.id} className={`flex items-center justify-between gap-2 rounded-md border p-3 text-left text-sm ${selected?.id === version.id ? 'border-primary' : 'border-border'}`} onClick={() => setSelected(version)}><span>{new Date(version.createdAt).toLocaleString()} · {version.status}</span><span>{version.id.slice(-6)}</span></button>)}{versionCursor && <Button variant="outline" onClick={() => void history(true)}>Older attempts</Button>}{selected && <Button variant="ghost" onClick={() => setSelected(null)}>Show latest result</Button>}</div>}
      <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Rename image</summary><form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void studioJson<ImageResource>(`/api/v1/images/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rename }) }).then(next => { setItem(next); setRename(''); }).catch(e => setError(e.message)); }}><Input aria-label="Image title" value={rename} placeholder={item.title} onChange={event => setRename(event.target.value)} maxLength={200} /><Button disabled={!rename.trim()} type="submit" variant="outline">Save title</Button></form></details>
      {current && <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Result details</summary><div className="mt-3 grid gap-2 text-xs text-ink-muted"><div>Generator: {current.provider} · Model: {current.model}</div><div>Generation: {current.id}</div><div>Shape: {current.request.output.aspectRatio} · Resolution: {current.request.output.resolution ?? 'Default'}</div></div>{current.thoughtSummary && <><h3 className="mt-4 font-medium">Model thoughts</h3><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{current.thoughtSummary}</pre></>}{Boolean(current.grounding?.citations?.length) && <><h3 className="mt-4 font-medium">Sources</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{current.grounding!.citations.filter(c => /^https?:\/\//i.test(c.url)).map((c, index) => <li key={`${c.url}-${index}`}><a href={c.url} target="_blank" rel="noreferrer" className="underline">{c.title || c.url}</a></li>)}</ul></>}<h3 className="mt-4 font-medium">Original source</h3><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{current.request.prompt}</pre><h3 className="mt-4 font-medium">Submitted visual prompt</h3><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{current.preparedPrompt}</pre></details>}
    </div>}
    <Sheet open={optionsOpen} onOpenChange={setOptionsOpen}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>Image options</SheetTitle><SheetDescription>Optional ways to shape your image.</SheetDescription>
      <fieldset disabled={submitting || Boolean(pending)} className="grid gap-6 disabled:opacity-60">
        <label className="grid gap-2 text-sm font-medium">Model<select aria-label="Image model" className="rounded-md border border-input bg-background p-2" value={activeModel} onChange={event => selectModel(event.target.value)}>{IMAGE_MODELS.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        <div className="grid gap-2"><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={request.adaptation.enabled} onChange={event => update({ adaptation: { ...request.adaptation, enabled: event.target.checked } })} />Adapt notes for an image</label><p className="text-xs text-ink-muted">Prepare a visual prompt from your Markdown before generating.</p>{request.adaptation.enabled && <label className="grid gap-2 text-sm">Custom instructions<Textarea aria-label="Image adaptation instructions" placeholder="Focus on the central idea; use an editorial illustration…" value={request.adaptation.instructions} maxLength={4000} onChange={event => update({ adaptation: { ...request.adaptation, instructions: event.target.value } })} /></label>}</div>
        <label className="grid gap-2 text-sm font-medium">Shape<select aria-label="Image shape" className="rounded-md border border-input bg-background p-2" value={request.output.aspectRatio} onChange={event => update({ output: { ...request.output, aspectRatio: event.target.value } })}>{supportedAspectRatios(activeModel).map(ratio => <option key={ratio} value={ratio}>{ratio === '16:9' ? 'Wide · 16:9' : ratio === '1:1' ? 'Square · 1:1' : ratio === '9:16' ? 'Portrait · 9:16' : ratio}</option>)}</select></label>
        <label className="grid gap-2 text-sm font-medium">Resolution<select aria-label="Image resolution" className="rounded-md border border-input bg-background p-2" value={request.output.resolution ?? ''} onChange={event => update({ output: { ...request.output, resolution: event.target.value || null } })}><option value="">Model default</option>{supportedResolutions(activeModel).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        {thinkingLevels.length > 0 && (
          <label className="grid gap-2 text-sm font-medium">Thinking level<select aria-label="Thinking level" className="rounded-md border border-input bg-background p-2" value={request.thinkingLevel ?? ''} onChange={event => update({ thinkingLevel: (event.target.value || null) as ImageThinkingLevel | null })}><option value="">Model default</option>{thinkingLevels.map(level => <option key={level} value={level}>{level === 'minimal' ? 'Minimal' : level === 'medium' ? 'Medium' : 'High'}</option>)}</select></label>
        )}
        {supportsWebSearch(activeModel) && (
          <div className="grid gap-2">
            <span className="text-sm font-medium">Google Search grounding</span>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(searchGrounding.web)} onChange={event => update({ searchGrounding: { web: event.target.checked, imageSearch: Boolean(searchGrounding.imageSearch) } })} />Web search</label>
            {supportsImageSearch(activeModel) && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(searchGrounding.imageSearch)} onChange={event => update({ searchGrounding: { web: Boolean(searchGrounding.web), imageSearch: event.target.checked } })} />Image search</label>
            )}
          </div>
        )}
        {supportsVideoInput(activeModel) && (
          <label className="grid gap-2 text-sm font-medium">Video reference URL<Input aria-label="Video reference URL" type="url" placeholder="https://www.youtube.com/watch?v=..." value={request.videoUri ?? ''} onChange={event => update({ videoUri: event.target.value })} /></label>
        )}
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">References ({refIds.length}/{maxRefs})</span>
            {refIds.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={clearReferences}>Clear all</Button>}
          </div>
          <p className="text-xs text-ink-muted">Up to {maxRefs} PNG, JPEG, or WebP images up to 10 MiB each. They guide Gemini’s generation.</p>
          {refIds.length > 0 && <div className="flex flex-wrap gap-2">
            {refIds.map((refId, index) => (
              <div key={refId} className="flex items-center gap-2 rounded-md border border-border p-1.5">
                <AssetImage id={refId} thumbnail alt={`Reference ${index + 1}`} className="h-10 w-12 rounded" />
                <MediaIconAction label={`Remove reference ${index + 1}`} compact onClick={() => removeReference(refId)}><X size={14} /></MediaIconAction>
              </div>
            ))}
          </div>}
          <Button type="button" variant="outline" disabled={uploading || refIds.length >= maxRefs} onClick={() => referenceRef.current?.click()}>{uploading ? 'Uploading…' : refIds.length ? 'Add reference' : 'Attach reference'}</Button>
        </div>
        <Button variant="outline" onClick={() => { void updateSettings({ imageDefaults: { ...request, prompt: '', referenceAssetId: null, referenceAssetIds: [], videoUri: null } }).then(() => toast.success('Image defaults saved.')).catch(() => setError('Could not save image defaults.')); }}>Use these options for new images</Button>
      </fieldset>
      <Button onClick={() => setOptionsOpen(false)}>Done</Button>
    </SheetContent></Sheet>
  </WorkbenchPanel>;
}
