import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_ANALYSIS_MODEL, GeminiVideoAnalysisProvider, VIDEO_MIME_TYPES, type VideoSource } from 'mdmedia/analysis';
import { readMp4Duration } from 'mdmedia/video';
import { createGeminiClient } from 'mdmedia/tts';
import { hasScope, type Caller } from './api-auth';
import type { ApiKeyScope } from './api-key-token';
import { adminBucket, adminDb } from './firebase-admin';
import { carriedRetention } from './retention-server';
import { assetResource, loadOwnedAsset, type StoredAsset } from './assets-server';
import { MediaError, validMediaId } from './image-request';
import { decideIdempotentReplay } from './image-jobs';
import { parseAnalysisRequest, providerOptions, resolveAnalysisNarration, type AnalysisNarration } from './analysis-request';
import { normalizeAnalysisMarkdown } from './analysis-markdown';
import { MAX_MARKDOWN_CHARS } from './narration-api';
import { loadUserSettings } from './user-settings-server';
import { loadVideoGeneration, loadVideoItem, videoClips } from './video-server';
import { videoClipContent, videoToolsAvailable } from './video-assets-server';
import type { AnalysisGenerationResource, AnalysisRequest, AnalysisResource, AnalysisSource, AnalysisUsage, GenerationStatus, MediaSummary } from './media-types';

interface AnalysisItem extends MediaSummary {
  type: 'analysis'; ownerUid: string; visibility: 'private'; request: AnalysisRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
}
export interface AnalysisGeneration {
  id: string; ownerUid: string; itemId: string; type: 'analysis'; title: string;
  request: AnalysisRequest; provider: 'gemini'; model: string;
  status: GenerationStatus; phase: string;
  assetId: string | null; interactionId: string | null; usage: AnalysisUsage | null; trace: string[];
  /** While running: the latest step Gemini reported, one capped line of plain text. Cleared when the attempt ends. */
  progress?: string | null;
  /** The resolved narration options, snapshotted at acceptance so later Settings changes do not alter queued work. */
  narration: AnalysisNarration | null; narrationId: string | null; narrationError: { code: string; message: string } | null;
  createdAt: number; updatedAt: number; leaseUntil: number; leaseToken: string | null;
  error: { code: string; message: string } | null;
}
export interface PreparedAnalysis { request: AnalysisRequest; narration: AnalysisNarration | null }

/** Uploads the provider accepts. Gemini file URIs are temporary, so Studio keeps the bytes and never the URI. */
export const ANALYSIS_UPLOAD_TYPES: ReadonlySet<string> = new Set([...Object.values(VIDEO_MIME_TYPES), 'video/quicktime']);
/** The provider's own deadline; long agentic runs on big files can take many minutes. */
const ANALYSIS_TIMEOUT_MS = 20 * 60_000;
const MAX_RUNNING = 3;
/** Progress is a nicety: at most one write per interval, and only the newest line. */
const PROGRESS_WRITE_MS = 5000;
const MAX_PROGRESS_CHARS = 160;
const MARKDOWN_DOCUMENT_INSTRUCTION = 'Write the response as a clean, well-structured Markdown document. Start directly with the content—no conversational preamble or sign-off. Put a blank line before headings, paragraphs, code blocks, and lists, and place every list item on its own line.';
const markdownSystemInstruction = (instruction?: string) => instruction ? `${MARKDOWN_DOCUMENT_INSTRUCTION}\n\n${instruction}` : MARKDOWN_DOCUMENT_INSTRUCTION;
export const configuredAnalysisModel = () => process.env.MDMEDIA_ANALYSIS_MODEL?.trim() || DEFAULT_ANALYSIS_MODEL;
const itemRef = (id: string) => adminDb().collection('mediaItems').doc(`analysis_${id}`);
const generationRef = (id: string) => adminDb().collection('mediaGenerations').doc(id);
const activityRef = (id: string) => adminDb().collection('mediaActivity').doc(id);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  : Array.isArray(value) ? value.map(canonical) : value;
const titleFor = (prompt: string) => prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) || 'Video analysis';
const insufficient = (scope: ApiKeyScope) => new MediaError(403, 'insufficient_scope', `This API key cannot ${scope.replace(':', ' ')}.`);

/** One narration per attempt: retries and lease recovery reuse this id, so they can never start a second. */
export function narrationIdFor(generationId: string): string {
  return /^[A-Za-z0-9_-]{5,123}$/.test(generationId) ? `narr_${generationId}` : `narr_${digest(generationId).slice(0, 40)}`;
}

/** A short plain excerpt of a JSON answer: its text values in order, else the compact JSON. */
export function jsonExcerpt(json: string, max = 500): string {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return markdownExcerpt(json, max); }
  const leaves: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') leaves.push(String(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  const text = (leaves.length ? leaves.join(' · ') : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A short plain-text excerpt for Library and Activity rows. */
export function markdownExcerpt(markdown: string, max = 500): string {
  const text = normalizeAnalysisMarkdown(markdown)
    .replace(/```[^\n]*\n?/g, ' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*_`~|]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function loadAnalysisItem(uid: string, id: string): Promise<AnalysisItem> {
  const item = validMediaId(id) ? (await itemRef(id).get()).data() as AnalysisItem | undefined : undefined;
  if (!item || item.type !== 'analysis' || item.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That analysis is not available to you.');
  return item;
}
export async function loadAnalysisGeneration(uid: string, id: string): Promise<AnalysisGeneration> {
  const job = validMediaId(id) ? (await generationRef(id).get()).data() as AnalysisGeneration | undefined : undefined;
  if (!job || job.type !== 'analysis' || job.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That generation is not available to you.');
  return job;
}

/**
 * Everything checked before acceptance, so bad input or a missing scope fails with 4xx instead
 * of after a paid request: the body, the engine's option checks, a Studio video source's
 * `videos:read`, and `narrate` with its `narrations:create` (and `playlists:manage`) scope.
 */
export async function prepareAnalysis(caller: Caller, body: Record<string, unknown>, item: AnalysisItem | null): Promise<PreparedAnalysis> {
  const { request, narrate } = parseAnalysisRequest(body, { defaults: item?.request ?? null, model: configuredAnalysisModel(), followUps: Boolean(item) });
  if (request.source.kind === 'video' && !request.previousInteractionId && !hasScope(caller, 'videos:read')) throw insufficient('videos:read');
  if (narrate === undefined || narrate === false) return { request, narration: null };
  if (request.responseSchema) throw new MediaError(400, 'invalid_narrate', 'Narration reads a Markdown answer; leave out narrate, or send responseSchema: null.');
  if (!hasScope(caller, 'narrations:create')) throw insufficient('narrations:create');
  const narration = resolveAnalysisNarration(narrate, await loadUserSettings(caller.uid), caller.kind === 'apiKey');
  if (narration?.placement && !hasScope(caller, 'playlists:manage')) throw insufficient('playlists:manage');
  return { request, narration };
}

/** Pins a source to what exists now, enforcing ownership. A Studio video resolves to one ready version. */
async function resolveSource(uid: string, source: AnalysisSource): Promise<AnalysisSource> {
  if (source.kind === 'youtube') return source;
  if (source.kind === 'asset') {
    const asset = await loadOwnedAsset(uid, source.assetId).catch(() => null);
    if (!asset || asset.mediaType !== 'analysis' || asset.purpose !== 'reference' || !ANALYSIS_UPLOAD_TYPES.has(asset.mimeType)) {
      throw new MediaError(404, 'source_not_found', 'Upload the video with POST /api/v1/assets?media=analysis, then send its id.');
    }
    return { kind: 'asset', assetId: asset.id };
  }
  const item = await loadVideoItem(uid, source.videoItemId);
  const generationId = source.generationId ?? item.latestSuccessfulGenerationId;
  if (!generationId) throw new MediaError(409, 'no_result', 'That video has no finished result to analyze yet.');
  const generation = await loadVideoGeneration(uid, generationId);
  if (generation.itemId !== item.id || generation.status !== 'ready' || !generation.assetId) throw new MediaError(409, 'source_unavailable', 'That video version is not ready.');
  if (source.clip !== null) {
    const clips = await videoClips(uid, generation, '');
    if (source.clip > clips.length) throw new MediaError(400, 'invalid_clip', `That video has ${clips.length} clip${clips.length === 1 ? '' : 's'}.`);
    if (!await videoToolsAvailable()) throw new MediaError(503, 'video_tools_unavailable', 'Clip extraction is unavailable on this Studio.');
  }
  return { ...source, generationId };
}

/** Replay precedes everything else. Acceptance, ownership, quota, activity and the pending job change atomically. */
export async function submitAnalysis(uid: string, prepared: PreparedAnalysis, body: unknown, key: string, existingItemId: string | null) {
  const requestHash = digest(JSON.stringify(canonical(body)));
  const replayRef = adminDb().collection('mediaRequests').doc(digest(`analysis:${uid}:${existingItemId ?? 'new'}:${key}`));
  const quotaRef = adminDb().collection('mediaQuotas').doc(`analysis_${uid}`);
  const itemId = existingItemId ?? adminDb().collection('mediaItems').doc().id;
  const generationId = adminDb().collection('mediaGenerations').doc().id;
  const accepted = await adminDb().runTransaction(async tx => {
    const replay = await tx.get(replayRef);
    const decision = decideIdempotentReplay(replay.exists ? replay.data() as { requestHash: string; itemId: string; generationId: string } : null, requestHash);
    if (decision.kind === 'conflict') throw new MediaError(409, 'idempotency_conflict', 'That key was already used for a different analysis request.');
    if (decision.kind === 'replay') return { itemId: decision.itemId, generationId: decision.generationId, replayed: true };
    if (!process.env.GEMINI_API_KEY) throw new MediaError(503, 'provider_unavailable', 'Video analysis is unavailable on this Studio.');
    const previous = (await tx.get(itemRef(itemId))).data() as AnalysisItem | undefined;
    if (existingItemId && (!previous || previous.ownerUid !== uid || previous.type !== 'analysis')) throw new MediaError(404, 'not_found', 'That analysis is not available to you.');
    if (previous && ['queued', 'generating'].includes(previous.status)) throw new MediaError(409, 'generation_in_progress', 'This analysis already has an attempt in progress.');
    const quota = (await tx.get(quotaRef)).data() ?? {};
    let request = prepared.request;
    if (request.previousInteractionId) {
      // Gemini keeps one shared key's interactions, so a follow-up may only name this item's own receipts.
      const own = await adminDb().collection('mediaGenerations').where('ownerUid', '==', uid).where('itemId', '==', itemId)
        .where('type', '==', 'analysis').where('interactionId', '==', request.previousInteractionId).limit(1).get();
      if (own.empty) throw new MediaError(404, 'follow_up_not_found', 'That interaction is not part of this analysis.');
    } else request = { ...request, source: await resolveSource(uid, request.source) };
    const now = Date.now();
    const title = previous?.title ?? titleFor(request.prompt);
    const job: AnalysisGeneration = { id: generationId, ownerUid: uid, itemId, type: 'analysis', title, request, provider: 'gemini', model: request.model ?? configuredAnalysisModel(),
      status: 'queued', phase: 'queued', assetId: null, interactionId: null, usage: null, trace: [], progress: null,
      narration: prepared.narration, narrationId: prepared.narration ? narrationIdFor(generationId) : null, narrationError: null,
      createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, error: null };
    const item: AnalysisItem = { id: itemId, type: 'analysis', ownerUid: uid, title, status: 'queued', visibility: 'private', request,
      ...carriedRetention(previous), createdAt: previous?.createdAt ?? now, updatedAt: now, href: `/analysis/${itemId}`,
      sourcePreview: previous?.sourcePreview ?? request.prompt.slice(0, 4000), thumbnailAssetId: null,
      latestGenerationId: generationId, latestSuccessfulGenerationId: previous?.latestSuccessfulGenerationId ?? null };
    tx.set(itemRef(itemId), item); tx.set(generationRef(generationId), job);
    tx.set(activityRef(generationId), { id: generationId, itemId, ownerUid: uid, type: 'analysis', title, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, href: item.href });
    tx.set(replayRef, { ownerUid: uid, requestHash, itemId, generationId, createdAt: now });
    tx.set(quotaRef, { active: [...((quota.active ?? []) as string[]), generationId] });
    return { itemId, generationId, replayed: false };
  });
  startAnalysisWorker(); void processAnalysisJobs().catch(() => {});
  return accepted;
}

export async function analysisGenerationResource(job: AnalysisGeneration, origin: string): Promise<AnalysisGenerationResource> {
  const asset = job.assetId ? await loadOwnedAsset(job.ownerUid, job.assetId) : null;
  return { id: job.id, itemId: job.itemId, type: 'analysis', title: job.title, status: job.status, phase: job.phase, createdAt: job.createdAt, updatedAt: job.updatedAt,
    request: { ...job.request, responseSchema: job.request.responseSchema ?? null }, preparedPrompt: null, provider: job.provider, model: job.model, interactionId: job.interactionId,
    progress: job.status === 'generating' ? job.progress ?? null : null, usage: job.usage ?? null, trace: job.trace ?? [],
    narrationId: job.narrationId ?? null, narrationError: job.narrationError ?? null,
    assets: asset ? [assetResource(asset, origin)] : [], error: job.error, links: { self: `${origin}/api/v1/generations/${job.id}`, web: `${origin}/analysis/${job.itemId}` } };
}
export async function analysisResource(uid: string, id: string, origin: string): Promise<AnalysisResource> {
  const item = await loadAnalysisItem(uid, id); const latest = await loadAnalysisGeneration(uid, item.latestGenerationId);
  const result = item.latestSuccessfulGenerationId ? item.latestSuccessfulGenerationId === latest.id ? latest : await loadAnalysisGeneration(uid, item.latestSuccessfulGenerationId) : null;
  return { id: item.id, type: 'analysis', title: item.title, status: item.status, visibility: 'private', createdAt: item.createdAt, updatedAt: item.updatedAt,
    href: item.href, thumbnailAssetId: null, ...(item.sourcePreview === undefined ? {} : { sourcePreview: item.sourcePreview }), request: { ...item.request, responseSchema: item.request.responseSchema ?? null },
    latestGenerationId: latest.id, latestSuccessfulGenerationId: result?.id ?? null,
    latestGeneration: await analysisGenerationResource(latest, origin), result: result ? await analysisGenerationResource(result, origin) : null,
    links: { self: `${origin}/api/v1/analyses/${id}`, web: `${origin}/analysis/${id}`, generations: `${origin}/api/v1/analyses/${id}/generations` } };
}

/** A raw video upload for `source: { kind: 'asset' }`. The bytes stay in Storage; Gemini gets them per attempt. */
export async function saveAnalysisReference(uid: string, bytes: Uint8Array, mimeType: string): Promise<StoredAsset> {
  const id = adminDb().collection('mediaAssets').doc().id;
  const path = `media/${uid}/${id}/original`;
  await adminBucket().file(path).save(Buffer.from(bytes), { resumable: false, contentType: mimeType });
  const duration = mimeType === 'video/mp4' || mimeType === 'video/mov' || mimeType === 'video/quicktime' ? readMp4Duration(bytes) : null;
  const asset: StoredAsset = { id, ownerUid: uid, purpose: 'reference', generationId: null, itemId: null, mediaType: 'analysis', path, thumbnailPath: '',
    mimeType, width: 0, height: 0, byteLength: bytes.length, ...(duration ? { durationMs: Math.round(duration * 1000) } : {}), createdAt: Date.now() };
  await adminDb().collection('mediaAssets').doc(id).set(asset);
  return asset;
}
/** The answer's type: JSON when the request carried a schema, else Markdown. */
export const answerMimeType = (request: AnalysisRequest) => request.responseSchema ? 'application/json' : 'text/markdown';
/** Storage first under a deterministic id, so recovery finds a saved answer instead of asking again. */
async function saveAnalysisAsset(job: AnalysisGeneration, text: string): Promise<StoredAsset> {
  const id = `analysis_${job.id}`; const path = `media/${job.ownerUid}/${id}/original`; const bytes = Buffer.from(text, 'utf8');
  const mimeType = answerMimeType(job.request);
  await adminBucket().file(path).save(bytes, { resumable: false, contentType: `${mimeType}; charset=utf-8` });
  const asset: StoredAsset = { id, ownerUid: job.ownerUid, purpose: 'output', mediaType: 'analysis', generationId: job.id, itemId: job.itemId, path, thumbnailPath: '',
    mimeType, width: 0, height: 0, byteLength: bytes.length, createdAt: Date.now() };
  await adminDb().collection('mediaAssets').doc(id).set(asset);
  return asset;
}
async function savedAnalysis(job: AnalysisGeneration): Promise<{ asset: StoredAsset; text: string } | null> {
  const asset = (await adminDb().collection('mediaAssets').doc(`analysis_${job.id}`).get()).data() as StoredAsset | undefined;
  if (!asset || asset.ownerUid !== job.ownerUid) return null;
  const bytes = await adminBucket().file(asset.path).download().then(([data]) => data, () => null);
  return bytes ? { asset, text: Buffer.from(bytes).toString('utf8') } : null;
}

/** The videos to send. A follow-up sends none: Gemini kept the earlier video context. */
async function sourceVideos(job: AnalysisGeneration): Promise<VideoSource[]> {
  const { request, ownerUid } = job;
  if (request.previousInteractionId) return [];
  const source = request.source;
  if (source.kind === 'youtube') return [{ kind: 'youtube', url: source.url }];
  if (source.kind === 'asset') {
    const asset = await loadOwnedAsset(ownerUid, source.assetId).catch(() => null);
    if (!asset || asset.mediaType !== 'analysis') throw new MediaError(404, 'source_not_found', 'The uploaded video is no longer available.');
    return [{ kind: 'bytes', bytes: new Uint8Array((await adminBucket().file(asset.path).download())[0]), mimeType: asset.mimeType, name: asset.id }];
  }
  const generation = await loadVideoGeneration(ownerUid, source.generationId!);
  if (generation.itemId !== source.videoItemId || generation.status !== 'ready' || !generation.assetId) throw new MediaError(409, 'source_unavailable', 'That video version is no longer available.');
  const sequence = await loadOwnedAsset(ownerUid, generation.assetId);
  if (source.clip === null) return [{ kind: 'bytes', bytes: new Uint8Array((await adminBucket().file(sequence.path).download())[0]), mimeType: 'video/mp4', name: `video-${source.videoItemId}.mp4` }];
  const clip = (await videoClips(ownerUid, generation, '')).find(entry => entry.index === source.clip);
  if (!clip) throw new MediaError(409, 'source_unavailable', 'That clip is no longer available.');
  // Same bytes the clip content route serves: a saved clip when there is one, else a local extract.
  const clipGeneration = await loadVideoGeneration(ownerUid, clip.generationId);
  const saved = clipGeneration.clipAssetId ? await loadOwnedAsset(ownerUid, clipGeneration.clipAssetId) : null;
  const bytes = saved ? (await adminBucket().file(saved.path).download())[0] : await videoClipContent(sequence, clip.index, clip.startSeconds, clip.endSeconds, false);
  return [{ kind: 'bytes', bytes: new Uint8Array(bytes), mimeType: 'video/mp4', name: `clip-${clip.index}.mp4` }];
}

async function checkpoint(job: AnalysisGeneration, token: string, patch: Partial<AnalysisGeneration>) {
  await adminDb().runTransaction(async tx => {
    const current = (await tx.get(generationRef(job.id))).data();
    if (current?.leaseToken !== token || current.status !== 'generating') throw new Error('Generation lease expired');
    tx.update(generationRef(job.id), { ...patch, updatedAt: Date.now() });
    if (patch.phase) tx.update(activityRef(job.id), { phase: patch.phase, updatedAt: Date.now() });
  });
}
async function finish(job: AnalysisGeneration, token: string, outcome: { asset: StoredAsset; text: string } | null, status: GenerationStatus, error: AnalysisGeneration['error'], patch: Partial<AnalysisGeneration> = {}) {
  const quotaRef = adminDb().collection('mediaQuotas').doc(`analysis_${job.ownerUid}`);
  await adminDb().runTransaction(async tx => {
    const current = (await tx.get(generationRef(job.id))).data();
    if (current?.leaseToken !== token || current.status !== 'generating') return;
    const item = await tx.get(itemRef(job.itemId)); const quota = await tx.get(quotaRef); const now = Date.now();
    tx.update(generationRef(job.id), { ...patch, status, phase: status, error, assetId: outcome?.asset.id ?? null, progress: null, leaseUntil: 0, updatedAt: now });
    tx.update(activityRef(job.id), { status, phase: status, updatedAt: now });
    // A failed retry never replaces the last good result.
    if (item.data()?.latestGenerationId === job.id) tx.update(itemRef(job.itemId), { status, updatedAt: now,
      ...(outcome ? { latestSuccessfulGenerationId: job.id, sourcePreview: outcome.asset.mimeType === 'application/json' ? jsonExcerpt(outcome.text) : markdownExcerpt(outcome.text) } : {}) });
    tx.set(quotaRef, { ...quota.data(), active: ((quota.data()?.active ?? []) as string[]).filter(id => id !== job.id) });
  });
}

/**
 * Starts the requested narration from the saved answer, while this attempt still holds its lease,
 * so lease recovery covers it too. The id is fixed per attempt and an existing narration is never
 * restarted, so neither path can start a second one. Any failure is recorded, never thrown: the
 * analysis succeeds on its own.
 */
async function followOnNarration(job: AnalysisGeneration, token: string, text: string): Promise<AnalysisGeneration['narrationError']> {
  const id = job.narrationId; const options = job.narration;
  if (!id || !options) return null;
  try {
    await checkpoint(job, token, { phase: 'narrating' });
    const existing = (await adminDb().collection('narrations').doc(id).get()).data();
    if (existing) return existing.ownerUid === job.ownerUid ? null : { code: 'id_in_use', message: 'That narration id is already in use.' };
    if (text.length > MAX_MARKDOWN_CHARS) return { code: 'narration_too_long', message: `The analysis is ${text.length.toLocaleString('en-US')} characters; narration takes at most ${MAX_MARKDOWN_CHARS.toLocaleString('en-US')}. The analysis is saved.` };
    const { startNarration } = await import('./narration-start');
    // Detached like POST /api/v1/narrations: synthesis carries on without a reader.
    const detached = new AbortController();
    const started = await startNarration({ uid: job.ownerUid, request: { ...options.request, markdown: text, id }, signal: detached.signal,
      source: { kind: 'analysis', analysisId: job.itemId, generationId: job.id } });
    if (!started.ok) return { code: started.code, message: started.message };
    detached.abort(); void started.stream.cancel().catch(() => {});
    if (options.placement) {
      try {
        const { placeNarration, preparePlacement } = await import('./playlists-server');
        await placeNarration(job.ownerUid, await preparePlacement(job.ownerUid, options.placement, id), id);
      } catch { return { code: 'playlist_update_failed', message: 'The narration started but could not be added to the playlist.' }; }
    }
    return null;
  } catch (error) {
    console.warn('[analysis] Narration did not start', { id: job.id, exception: error instanceof Error ? error.name : 'unknown' });
    return { code: 'narration_failed', message: 'Could not start the narration. The analysis is saved.' };
  }
}
async function complete(job: AnalysisGeneration, token: string, text: string, saved: StoredAsset | null) {
  const asset = saved ?? await saveAnalysisAsset(job, text);
  const narrationError = await followOnNarration(job, token, text);
  await finish(job, token, { asset, text }, 'ready', null, job.narrationId ? { narrationError } : {});
}
/** Finish from a saved answer or the saved receipt only. Without either, an unknown outcome is never asked again. */
async function recover(job: AnalysisGeneration, token: string, provider: GeminiVideoAnalysisProvider, onProgress?: (step: string) => void) {
  const saved = await savedAnalysis(job);
  if (saved) return complete(job, token, saved.text, saved.asset);
  if (job.interactionId) {
    const result = await provider.retrieveAnalysis(job.interactionId, { timeoutMs: ANALYSIS_TIMEOUT_MS, onProgress });
    await checkpoint(job, token, { phase: 'saving', usage: result.usage ?? null, trace: result.trace, progress: null });
    return complete(job, token, result.text, null);
  }
  await finish(job, token, null, 'interrupted', { code: 'generation_interrupted', message: 'The provider outcome is unknown. Your previous analysis is preserved. Running it again starts a new request.' });
}
/** Gemini answered, and the answer is a failure: asking again for the same receipt cannot help. */
const providerFailure = (error: unknown) => /^(Video analysis (failed|cancelled|incomplete|budget exceeded|requires action)|Gemini finished without (any analysis text|valid JSON)|Gemini could not process)/.test(error instanceof Error ? error.message : '');

/**
 * The worker's `onProgress`: keeps only the newest step and writes it at most once per interval,
 * so a chatty model costs a handful of small writes. `stop` drops anything not yet written.
 */
export function progressWriter(write: (progress: string) => Promise<unknown>, intervalMs = PROGRESS_WRITE_MS) {
  let pending: string | null = null, last = 0, timer: ReturnType<typeof setTimeout> | null = null, stopped = false;
  const flush = () => {
    timer = null;
    if (stopped || pending === null) return;
    const next = pending; pending = null; last = Date.now();
    void write(next).catch(() => {});
  };
  return {
    report(step: string) {
      const line = step.replace(/\s+/g, ' ').trim();
      if (stopped || !line) return;
      pending = line.length > MAX_PROGRESS_CHARS ? `${line.slice(0, MAX_PROGRESS_CHARS - 1).trimEnd()}…` : line;
      if (timer) return;
      const wait = Math.max(0, last + intervalMs - Date.now());
      if (wait === 0) flush(); else { timer = setTimeout(flush, wait); timer.unref?.(); }
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

async function run(job: AnalysisGeneration, token: string, recovery: boolean) {
  const heartbeat = setInterval(() => { void checkpoint(job, token, { leaseUntil: Date.now() + 90_000 }).catch(() => {}); }, 20_000); heartbeat.unref();
  const progress = progressWriter(line => checkpoint(job, token, { progress: line }));
  let provider: GeminiVideoAnalysisProvider | null = null;
  let submitted = recovery;
  try {
    provider = new GeminiVideoAnalysisProvider(createGeminiClient(), 2, job.model);
    if (recovery) { await recover(job, token, provider, progress.report); return; }
    await checkpoint(job, token, { phase: 'preparing' });
    const sources = await sourceVideos(job);
    const options = providerOptions(job.request);
    if (!job.request.responseSchema) options.systemInstruction = markdownSystemInstruction(options.systemInstruction);
    const result = await provider.analyzeVideo(job.request.prompt, sources, {
      model: job.model, ...options, background: true, timeoutMs: ANALYSIS_TIMEOUT_MS, onProgress: progress.report,
      // `analyzing` is reported just before the paid create; from then on the outcome may be unknown.
      onPhase(phase) { if (phase === 'analyzing') submitted = true; else void checkpoint(job, token, { phase }).catch(() => {}); },
      // The receipt is durable before any polling, so recovery reads it instead of paying twice.
      async onInteraction(interactionId) { await checkpoint(job, token, { interactionId, phase: 'analyzing' }); job.interactionId = interactionId; },
    });
    progress.stop();
    await checkpoint(job, token, { phase: 'saving', usage: result.usage ?? null, trace: result.trace, progress: null });
    await complete(job, token, result.text, null);
  } catch (error) {
    progress.stop();
    const status = Number((error as { status?: number }).status ?? (error as { statusCode?: number }).statusCode ?? (error as { code?: number }).code);
    console.warn('[analysis] Attempt failed', { id: job.id, exception: error instanceof Error ? error.name : 'unknown', status: Number.isFinite(status) ? status : null, receiptSaved: Boolean(job.interactionId) });
    if (error instanceof MediaError) await finish(job, token, null, 'error', { code: error.code, message: error.message });
    else if ([400, 401, 403, 404, 410, 422, 429].includes(status)) await finish(job, token, null, 'error', { code: 'provider_rejected', message: 'Gemini could not accept this request. Check the prompt, source and settings, or try again later. Your previous analysis is preserved.' });
    else if (providerFailure(error)) await finish(job, token, null, 'error', { code: 'analysis_failed', message: 'Gemini could not finish this analysis. Try again or change the prompt. Your previous analysis is preserved.' });
    else if (!submitted) await finish(job, token, null, 'error', { code: 'preparation_failed', message: 'Could not prepare this request. Your source and previous analysis are preserved.' });
    else if (!recovery && job.interactionId && provider) {
      try { await recover(job, token, provider, progress.report); }
      catch (recoveryError) {
        await finish(job, token, null, recoveryError instanceof MediaError ? 'error' : 'interrupted', recoveryError instanceof MediaError
          ? { code: recoveryError.code, message: recoveryError.message }
          : { code: 'generation_interrupted', message: 'Could not retrieve this attempt. Your previous analysis is preserved.' });
      }
    } else await finish(job, token, null, 'interrupted', { code: 'generation_interrupted', message: 'This attempt did not complete. Running it again starts a new request; your previous analysis is preserved.' });
  } finally { clearInterval(heartbeat); progress.stop(); }
}

type Worker = { started: boolean; ticking: boolean; running: Set<string> };
const globalWorker = globalThis as typeof globalThis & { __mdmediaAnalysisWorker?: Worker };
const worker = globalWorker.__mdmediaAnalysisWorker ??= { started: false, ticking: false, running: new Set() };
export function startAnalysisWorker() {
  if (worker.started) return;
  worker.started = true;
  setTimeout(() => { void processAnalysisJobs().catch(() => {}); }, 5000).unref();
}
/** Claims expired leases first (recovery), then the oldest queued attempts, up to a few at once. */
export async function processAnalysisJobs() {
  if (worker.ticking) return;
  worker.ticking = true;
  try {
    while (worker.running.size < MAX_RUNNING) {
      const stale = await adminDb().collection('mediaGenerations').where('type', '==', 'analysis').where('status', '==', 'generating').where('leaseUntil', '<', Date.now()).limit(1).get();
      const next = stale.empty ? await adminDb().collection('mediaGenerations').where('type', '==', 'analysis').where('status', '==', 'queued').orderBy('createdAt', 'asc').limit(1).get() : stale;
      const snapshot = next.docs[0]; if (!snapshot || worker.running.has(snapshot.id)) return;
      const token = randomUUID();
      const job = await adminDb().runTransaction(async tx => {
        const current = (await tx.get(generationRef(snapshot.id))).data() as AnalysisGeneration | undefined;
        if (!current || current.type !== 'analysis' || (current.status !== 'queued' && (current.status !== 'generating' || current.leaseUntil >= Date.now()))) return null;
        const phase = current.status === 'queued' ? 'starting' : 'recovering';
        tx.update(generationRef(current.id), { status: 'generating', phase, leaseToken: token, leaseUntil: Date.now() + 90_000, updatedAt: Date.now() });
        tx.update(itemRef(current.itemId), { status: 'generating', updatedAt: Date.now() });
        tx.update(activityRef(current.id), { status: 'generating', phase, updatedAt: Date.now() });
        return current;
      });
      if (!job) return;
      worker.running.add(job.id);
      void run(job, token, job.status === 'generating').catch(() => {}).finally(() => { worker.running.delete(job.id); void processAnalysisJobs().catch(() => {}); });
    }
  } finally { worker.ticking = false; }
}
