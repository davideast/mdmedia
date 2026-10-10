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
import { DEFAULT_IMAGE_REQUEST, MAX_IMAGE_PROMPT, MAX_REFERENCE_BYTES } from '@/lib/image-request';
import type { ImageDraft, ImageRequest, ImageResource, GenerationResource } from '@/lib/media-types';
import { MediaClientError, studioJson } from '@/lib/media-client';
import { AssetImage, downloadAsset } from './asset-image';
import { MediaComposer, MediaIconAction } from './media-composer';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth-context';

type Options = { available: boolean; defaults: ImageRequest; capabilities: { aspectRatios: string[]; resolutions: string[] } };
const fromDraft = (draft: ImageDraft): ImageRequest => ({ prompt: draft.prompt, adaptation: { enabled: draft.adapt, instructions: draft.instructions }, output: { aspectRatio: draft.aspectRatio, resolution: draft.resolution || null }, referenceAssetId: draft.referenceAssetId });
const toDraft = (request: ImageRequest): ImageDraft => ({ kind: 'image', prompt: request.prompt, adapt: request.adaptation.enabled, instructions: request.adaptation.instructions, aspectRatio: request.output.aspectRatio, resolution: request.output.resolution ?? '', referenceAssetId: request.referenceAssetId });
const phaseLabel = (phase: string) => ({ queued: 'Waiting to start…', starting: 'Starting…', preparing: 'Preparing visual prompt…', generating: 'Generating image…', saving: 'Saving image…' }[phase] ?? phase);
export function ImageEditor({ id }: { id?: string }) {
  const { state, store, draftId, activeView, replaceCurrent } = useWorkspace();
  const { updateSettings } = useAuth();
  const router = useRouter();
  const [options, setOptions] = useState<Options | null>(null);
  const [image, setImage] = useState<ImageResource | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [optionsOpen, setOptionsOpen] = useWorkspaceField('imageOptionsOpen', false);
  const [edit, setEdit] = useWorkspaceField('imageEdit', '');
  const [pending, setPending] = useWorkspaceField('imageSubmission', '');
  const [versions, setVersions] = useState<GenerationResource[] | null>(null);
  const [versionCursor, setVersionCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [selected, setSelected] = useState<GenerationResource | null>(null);
  const [rename, setRename] = useState('');
  const [viewerOpen, setViewerOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const base = id ? image?.request ?? DEFAULT_IMAGE_REQUEST : state.imageDrafts?.[draftId] ? fromDraft(state.imageDrafts[draftId]) : options?.defaults ?? DEFAULT_IMAGE_REQUEST;
  let request = base;
  if (id && edit) { try { request = JSON.parse(edit) as ImageRequest; } catch { /* A malformed local edit never replaces the persisted source. */ } }
  const requestRef = useRef(request);
  useEffect(() => { requestRef.current = request; }, [request]);
  const busy = submitting || uploading || ['queued', 'generating'].includes(image?.status ?? '');
  const result = selected ?? image?.result;
  const asset = (selected?.assets.length ? selected : image?.result)?.assets[0];
  const update = (patch: Partial<ImageRequest>) => {
    const next = { ...requestRef.current, ...patch };
    if (id) setEdit(JSON.stringify(next)); else store.setImageDraft(draftId, toDraft(next));
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
        setImage(next); setLoadError('');
        timer = setTimeout(load, ['queued', 'generating'].includes(next.status) ? 2000 : 10_000);
      } catch (e) { if (!controller.signal.aborted) { setLoadError((e as Error).message); timer = setTimeout(load, 10_000); } }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function generate() {
    if (pendingRef.current) return;
    pendingRef.current = true; setSubmitting(true); setError('');
    const submittingViewId = activeView?.id;
    let submission: { key: string; body: ImageRequest };
    try {
      submission = pending ? JSON.parse(pending) : { key: crypto.randomUUID(), body: request };
      setPending(JSON.stringify(submission));
      const accepted = await studioJson<{ id: string; generation: GenerationResource }>(id ? `/api/v1/images/${id}/generations` : '/api/v1/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: JSON.stringify(submission.body),
      });
      setPending(''); setSelected(null); setVersions(null);
      if (!id) {
        store.clearImageDraft(draftId);
        if (store.getSnapshot().activeId === submittingViewId) replaceCurrent(`/image/${accepted.id}`, submission.body.prompt.trim().split('\n')[0].slice(0, 100));
        else { if (submittingViewId) store.replaceTab(submittingViewId, `/image/${accepted.id}`); toast.success('Image generation started. Find it in Activity.'); }
      }
      else { setEdit(''); setImage(await studioJson<ImageResource>(`/api/v1/images/${id}`)); }
    } catch (e) {
      if (e instanceof MediaClientError && e.status >= 400 && e.status < 500) setPending('');
      setError((e as Error).message);
    } finally { pendingRef.current = false; setSubmitting(false); }
  }
  async function attach(file: File) {
    if (file.size > MAX_REFERENCE_BYTES) { setError('Reference images must be at most 10 MiB.'); return; }
    setUploading(true); setError('');
    try {
      const uploaded = await studioJson<{ id: string }>('/api/v1/assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      update({ referenceAssetId: uploaded.id });
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  async function history(older = false) {
    try {
      const suffix = older && versionCursor ? `?cursor=${encodeURIComponent(JSON.stringify(versionCursor))}` : '';
      const page = await studioJson<{ items: GenerationResource[]; nextCursor: typeof versionCursor }>(`/api/v1/images/${id}/generations${suffix}`);
      setVersions(previous => older ? [...(previous ?? []), ...page.items] : page.items); setVersionCursor(page.nextCursor);
    } catch (e) { setError((e as Error).message); }
  }
  function duplicate() {
    const nextId = crypto.randomUUID(); store.setImageDraft(nextId, toDraft(request)); router.push(`/studio/image?draft=${nextId}`);
  }
  const title = id ? image?.title ?? 'Image' : request.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'New image';
  return <WorkbenchPanel workspacePage title={title} icon={<ImageIcon size={13} strokeWidth={2} />} bodyClassName="gap-0 p-0"
    actions={<MediaIconAction label="Image options" compact onClick={() => setOptionsOpen(!optionsOpen)} aria-expanded={optionsOpen}><PanelRight size={15} strokeWidth={2} /></MediaIconAction>}>
    {loadError && <p role="alert" className="px-4 pt-4 text-sm text-destructive sm:px-6">{loadError}</p>}
    {asset && <div className="grid shrink-0 gap-3 p-4 pb-0 sm:p-6 sm:pb-0">
      <AssetImage id={asset.id} alt={image?.title ?? 'Generated image'} className="h-[55dvh] min-h-64 rounded-lg border border-border p-2" />
      <div className="flex flex-wrap items-center gap-2">
        <MediaIconAction label="Download" onClick={() => void downloadAsset(asset.id, `${image?.title ?? 'image'}.${asset.mimeType.split('/')[1]}`).catch(e => setError(e.message))}><Download size={16} /></MediaIconAction>
        <MediaIconAction label="View full size" onClick={() => { setActualSize(false); setViewerOpen(true); }}><Expand size={16} /></MediaIconAction>
        <span className="text-xs text-ink-muted">{asset.width} × {asset.height} · {asset.mimeType.replace('image/', '').toUpperCase()}</span>
      </div>
      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}><DialogContent className="flex h-[90dvh] w-[95vw] max-w-none flex-col gap-3 p-4 sm:max-w-none"><DialogTitle className="pr-8">{image?.title ?? 'Generated image'}</DialogTitle><DialogDescription className="sr-only">Inspect the image fitted to the window or at its actual pixel size.</DialogDescription><div><Button variant="outline" size="sm" onClick={() => setActualSize(!actualSize)}>{actualSize ? 'Fit to window' : 'Actual size'}</Button></div><div className="min-h-0 flex-1 overflow-auto"><div style={actualSize ? { width: asset.width, height: asset.height } : { width: '100%', height: '100%' }}><AssetImage id={asset.id} alt="Full size image" className="h-full w-full" /></div></div></DialogContent></Dialog>
    </div>}
    {id && !image && !loadError && <p role="status" className="p-4 sm:p-6">Loading image…</p>}
    <MediaComposer
      heading={asset ? 'Refine your image' : 'Describe an image'}
      label="Image prompt"
      placeholder="Describe or paste here. Markdown is fine."
      value={request.prompt}
      maxLength={MAX_IMAGE_PROMPT}
      disabled={submitting || Boolean(pending)}
      onChange={prompt => update({ prompt })}
      onSubmit={() => void generate()}
      actionLabel={pending && !submitting ? 'Retry submission' : busy ? 'Generating…' : image ? 'Generate again' : 'Generate image'}
      actionDisabled={busy || (!pending && !request.prompt.trim()) || options?.available === false || Boolean(id && !image)}
      busy={busy}
      grow={!id}
      footer={<div className="flex items-center gap-1">
        <MediaIconAction label="Import Markdown" onClick={() => importRef.current?.click()} disabled={Boolean(pending)}><Upload size={16} /></MediaIconAction>
        <MediaIconAction label={uploading ? 'Uploading reference' : 'Attach reference'} onClick={() => referenceRef.current?.click()} disabled={uploading || Boolean(pending)}>{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</MediaIconAction>
      </div>}
    >
      {request.referenceAssetId && <div className="flex items-center gap-3 rounded-lg border border-border p-2"><AssetImage id={request.referenceAssetId} thumbnail alt="Reference image" className="h-16 w-20 rounded" /><span className="t-meta flex-1">Reference image</span><MediaIconAction label="Remove reference" disabled={Boolean(pending)} onClick={() => update({ referenceAssetId: null })}><X size={16} /></MediaIconAction></div>}
    </MediaComposer>
      <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (file.size > MAX_IMAGE_PROMPT * 4) setError('This Markdown file is too large.'); else void file.text().then(text => { if (text.length > MAX_IMAGE_PROMPT) setError('Image prompts are limited to 32,000 characters.'); else update({ prompt: text }); }); } event.target.value = ''; }} />
      <input ref={referenceRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ''; }} />
    {(error || pending || options?.available === false || image?.latestGeneration?.error || ['queued', 'generating'].includes(image?.latestGeneration?.status ?? '')) && <div className="grid shrink-0 gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
      {image?.latestGeneration && ['queued', 'generating'].includes(image.latestGeneration.status) && <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={15} className="animate-spin" />{phaseLabel(image.latestGeneration.phase)}</p>}
      {options?.available === false && <p role="alert" className="text-sm text-destructive">Image generation is unavailable on this Studio.</p>}
      {(error || image?.latestGeneration?.error) && <p role="alert" className="text-sm text-destructive">{error || image?.latestGeneration?.error?.message}</p>}
      {pending && <p className="text-xs text-ink-muted">The submission has not been confirmed. Retry submission uses the same request key to avoid starting another generation.</p>}
    </div>}
    {id && image && <div className="grid shrink-0 gap-3 border-t border-border p-4 sm:p-6">
      <div className="flex flex-wrap gap-1"><MediaIconAction label="Duplicate" onClick={duplicate}><Copy size={16} /></MediaIconAction><MediaIconAction label="History" aria-expanded={Boolean(versions)} onClick={() => versions ? setVersions(null) : void history()}><History size={16} /></MediaIconAction></div>
      {versions && <div className="grid gap-2" aria-label="Image versions">{versions.map((version) => <button type="button" key={version.id} className={`flex items-center justify-between gap-2 rounded-md border p-3 text-left text-sm ${selected?.id === version.id ? 'border-primary' : 'border-border'}`} onClick={() => setSelected(version)}><span>{new Date(version.createdAt).toLocaleString()} · {version.status}</span><span>{version.id.slice(-6)}</span></button>)}{versionCursor && <Button variant="outline" onClick={() => void history(true)}>Older attempts</Button>}{selected && <Button variant="ghost" onClick={() => setSelected(null)}>Show latest result</Button>}</div>}
      <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Rename image</summary><form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void studioJson<ImageResource>(`/api/v1/images/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rename }) }).then(next => { setImage(next); setRename(''); }).catch(e => setError(e.message)); }}><Input aria-label="Image title" value={rename} placeholder={image.title} onChange={event => setRename(event.target.value)} maxLength={200} /><Button disabled={!rename.trim()} type="submit" variant="outline">Save title</Button></form></details>
      {result && <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Result details</summary><div className="mt-3 grid gap-2 text-xs text-ink-muted"><div>Generator: {result.provider} · {result.model}</div><div>Generation: {result.id}</div><div>Shape: {result.request.output.aspectRatio} · Resolution: {result.request.output.resolution ?? 'Default'}</div></div><h3 className="mt-4 font-medium">Original source</h3><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{result.request.prompt}</pre><h3 className="mt-4 font-medium">Submitted visual prompt</h3><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{result.preparedPrompt}</pre></details>}
    </div>}
    <Sheet open={optionsOpen} onOpenChange={setOptionsOpen}><SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md">
      <SheetTitle>Image options</SheetTitle><SheetDescription>Optional ways to shape your image.</SheetDescription>
      <fieldset disabled={submitting || Boolean(pending)} className="grid gap-6 disabled:opacity-60">
        <div className="grid gap-2"><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={request.adaptation.enabled} onChange={event => update({ adaptation: { ...request.adaptation, enabled: event.target.checked } })} />Adapt notes for an image</label><p className="text-xs text-ink-muted">Prepare a visual prompt from your Markdown before generating.</p>{request.adaptation.enabled && <label className="grid gap-2 text-sm">Custom instructions<Textarea aria-label="Image adaptation instructions" placeholder="Focus on the central idea; use an editorial illustration…" value={request.adaptation.instructions} maxLength={4000} onChange={event => update({ adaptation: { ...request.adaptation, instructions: event.target.value } })} /></label>}</div>
        <label className="grid gap-2 text-sm font-medium">Shape<select aria-label="Image shape" className="rounded-md border border-input bg-background p-2" value={request.output.aspectRatio} onChange={event => update({ output: { ...request.output, aspectRatio: event.target.value } })}>{(options?.capabilities.aspectRatios ?? ['16:9', '1:1', '9:16']).map(ratio => <option key={ratio} value={ratio}>{ratio === '16:9' ? 'Wide · 16:9' : ratio === '1:1' ? 'Square · 1:1' : ratio === '9:16' ? 'Portrait · 9:16' : ratio}</option>)}</select></label>
        <label className="grid gap-2 text-sm font-medium">Resolution<select aria-label="Image resolution" className="rounded-md border border-input bg-background p-2" value={request.output.resolution ?? ''} onChange={event => update({ output: { ...request.output, resolution: event.target.value || null } })}><option value="">Model default</option>{(options?.capabilities.resolutions ?? ['1K', '2K', '4K']).map(value => <option key={value}>{value}</option>)}</select></label>
        <div className="grid gap-2"><span className="text-sm font-medium">Reference image</span><p className="text-xs text-ink-muted">One PNG, JPEG, or WebP up to 10 MiB. It guides Gemini’s generation.</p><Button variant="outline" disabled={uploading} onClick={() => referenceRef.current?.click()}>{uploading ? 'Uploading…' : request.referenceAssetId ? 'Replace reference' : 'Attach reference'}</Button></div>
        <Button variant="outline" onClick={() => { void updateSettings({ imageDefaults: { ...request, prompt: '', referenceAssetId: null } }).then(() => toast.success('Image defaults saved.')).catch(() => setError('Could not save image defaults.')); }}>Use these options for new images</Button>
      </fieldset>
      <Button onClick={() => setOptionsOpen(false)}>Done</Button>
    </SheetContent></Sheet>
  </WorkbenchPanel>;
}
