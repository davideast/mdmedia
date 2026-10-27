import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_ELEVENLABS_SFX_MODEL, ElevenLabsSoundEffectsProvider } from 'mdmedia/sfx';
import { videoToolsAvailable } from './video-assets-server';
import { saveSfxAsset, sfxOriginalPath, storeSfxOriginal, type SfxAsset } from './sfx-assets-server';
import { readSfxDefaults } from './sfx-request';
import { adminBucket, adminDb } from './firebase-admin';
import { startAdaptivePolling } from './worker-polling';
import { carriedRetention } from './retention-server';
import { assetResource, loadOwnedAsset, type StoredAsset } from './assets-server';
import { MediaError, validMediaId } from './image-request';
import { decideIdempotentReplay } from './image-jobs';
import type { SfxGenerationResource, GenerationStatus, SfxRequest, SfxResource, MediaSummary } from './media-types';

interface SfxItem extends MediaSummary {
  ownerUid: string; visibility: 'private'; request: SfxRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
}
export interface SfxGeneration {
  id: string; ownerUid: string; itemId: string; type: 'sfx'; title: string;
  request: SfxRequest; provider: 'elevenlabs'; model: string;
  status: GenerationStatus; phase: string; preparedPrompt: string | null;
  assetId: string | null; createdAt: number; updatedAt: number;
  leaseUntil: number; leaseToken: string | null;
  error: { code: string; message: string } | null;
}
export const configuredSfxModel = () => process.env.MDMEDIA_SFX_MODEL?.trim() || DEFAULT_ELEVENLABS_SFX_MODEL;
export const elevenLabsKey = () => process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY ?? '';
const titleFor = (prompt: string) => prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) || 'Untitled sound effect';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const itemRef = (id: string) => adminDb().collection('mediaItems').doc(`sfx_${id}`);
const generationRef = (id: string) => adminDb().collection('mediaGenerations').doc(id);

export async function sfxDefaults(uid: string): Promise<SfxRequest> {
  const user = await adminDb().collection('users').doc(uid).get();
  return readSfxDefaults(user.data()?.settings?.sfxDefaults);
}
export async function loadSfxItem(uid: string, id: string): Promise<SfxItem> {
  const snapshot = validMediaId(id) ? await itemRef(id).get() : null;
  const item = snapshot?.data() as SfxItem | undefined;
  if (!item || item.type !== 'sfx' || item.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That sound effect is not available to you.');
  return item;
}
export async function loadSfxGeneration(uid: string, id: string): Promise<SfxGeneration> {
  const snapshot = validMediaId(id) ? await generationRef(id).get() : null;
  const generation = snapshot?.data() as SfxGeneration | undefined;
  if (!generation || generation.type !== 'sfx' || generation.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That generation is not available to you.');
  return generation;
}

/** Persist acceptance, quota, and idempotency together before dispatching any paid work. */
export async function submitSfx(uid: string, request: SfxRequest, key: string, existingItemId: string | null, apiKeyId: string | null, submittedBody: unknown = request) {
  const target = existingItemId ?? 'new';
  const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    : Array.isArray(value) ? value.map(canonical) : value;
  const requestHash = digest(JSON.stringify(canonical(submittedBody)));
  const replayRef = adminDb().collection('mediaRequests').doc(digest(`sfx:${uid}:${target}:${key}`));
  const quotaRef = adminDb().collection('mediaQuotas').doc(`sfx_${uid}`);
  const itemId = existingItemId ?? adminDb().collection('mediaItems').doc().id;
  const generationId = adminDb().collection('mediaGenerations').doc().id;
  const now = Date.now();
  const toolsAvailable = await videoToolsAvailable();
  const accepted = await adminDb().runTransaction(async tx => {
    const replay = await tx.get(replayRef);
    const decision = decideIdempotentReplay(replay.exists ? replay.data() as { requestHash: string; itemId: string; generationId: string } : null, requestHash);
    if (decision.kind === 'conflict') throw new MediaError(409, 'idempotency_conflict', 'That key was already used with different sound effect settings.');
    if (decision.kind === 'replay') return { itemId: decision.itemId, generationId: decision.generationId, replayed: true };
    if (!elevenLabsKey() || !toolsAvailable) throw new MediaError(503, 'provider_unavailable', 'ElevenLabs sound effects are not configured on this Studio.');
    const itemSnapshot = await tx.get(itemRef(itemId));
    const previous = itemSnapshot.data() as SfxItem | undefined;
    if (existingItemId && (!previous || previous.type !== 'sfx' || previous.ownerUid !== uid)) throw new MediaError(404, 'not_found', 'That sound effect is not available to you.');
    if (previous && ['queued', 'generating'].includes(previous.status)) throw new MediaError(409, 'generation_in_progress', 'This sound effect already has a generation in progress.');
    const quota = await tx.get(quotaRef);
    const data = quota.data() ?? {};
    const active = Array.isArray(data.active) ? data.active as string[] : [];
    if (active.length >= 3) throw new MediaError(429, 'too_many_in_progress', 'You have three sound effect attempts in progress. Wait for one to finish.');
    const hourly = data.hourly as Record<string, { since: number; count: number }> | undefined;
    const bucket = apiKeyId ? hourly?.[apiKeyId] : null;
    const current = bucket && now - bucket.since < 3_600_000 ? bucket : { since: now, count: 0 };
    if (apiKeyId && current.count >= 30) throw new MediaError(429, 'rate_limited', 'This key has started too many sound effects this hour.');
    const nextHourly = Object.fromEntries(Object.entries(hourly ?? {}).filter(([, value]) => now - value.since < 3_600_000));
    if (apiKeyId) nextHourly[apiKeyId] = { ...current, count: current.count + 1 };
    const title = previous?.title ?? titleFor(request.prompt);
    // No sound effect page exists yet, so saved work opens the Library.
    const item: SfxItem = { id: itemId, type: 'sfx', ownerUid: uid, title, status: 'queued', visibility: 'private',
      ...carriedRetention(previous), createdAt: previous?.createdAt ?? now, updatedAt: now, href: '/library', sourcePreview: request.prompt.slice(0, 4000),
      thumbnailAssetId: previous?.thumbnailAssetId ?? null, durationMs: previous?.durationMs ?? 0, request, latestGenerationId: generationId,
      latestSuccessfulGenerationId: previous?.latestSuccessfulGenerationId ?? null };
    const generation: SfxGeneration = { id: generationId, ownerUid: uid, itemId, type: 'sfx', title, request, provider: 'elevenlabs', model: configuredSfxModel(),
      status: 'queued', phase: 'queued', preparedPrompt: null, assetId: null, createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, error: null };
    tx.set(itemRef(itemId), item);
    tx.set(generationRef(generationId), generation);
    tx.set(adminDb().collection('mediaActivity').doc(generationId), { id: generationId, itemId, ownerUid: uid, type: 'sfx', title, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, href: '/library' });
    tx.set(replayRef, { ownerUid: uid, requestHash, itemId, generationId, createdAt: now });
    tx.set(quotaRef, { active: [...active, generationId], hourly: nextHourly });
    return { itemId, generationId, replayed: false };
  });
  startSfxWorker();
  void processSfxJobs().catch(() => {});
  return accepted;
}

export async function generationResource(generation: SfxGeneration, origin: string): Promise<SfxGenerationResource> {
  const asset = generation.assetId ? await loadOwnedAsset(generation.ownerUid, generation.assetId) : null;
  return { id: generation.id, itemId: generation.itemId, type: 'sfx', title: generation.title, status: generation.status,
    phase: generation.phase, createdAt: generation.createdAt, updatedAt: generation.updatedAt, request: generation.request,
    preparedPrompt: generation.preparedPrompt, provider: generation.provider, model: generation.model,
    waveform: (asset as SfxAsset | null)?.waveform ?? [], durationSeconds: asset?.durationMs ? asset.durationMs / 1000 : null,
    assets: asset ? [assetResource(asset, origin)] : [], error: generation.error,
    links: { self: `${origin}/api/v1/generations/${generation.id}`, web: `${origin}/library` } };
}
export async function sfxResource(uid: string, id: string, origin: string): Promise<SfxResource> {
  const item = await loadSfxItem(uid, id);
  const latest = await loadSfxGeneration(uid, item.latestGenerationId);
  const successful = item.latestSuccessfulGenerationId === latest.id ? latest : item.latestSuccessfulGenerationId ? await loadSfxGeneration(uid, item.latestSuccessfulGenerationId) : null;
  return { id: item.id, type: 'sfx', title: item.title, status: item.status, visibility: 'private',
    createdAt: item.createdAt, updatedAt: item.updatedAt, href: item.href, thumbnailAssetId: item.thumbnailAssetId, durationMs: item.durationMs ?? 0,
    request: item.request, latestGenerationId: latest.id, latestSuccessfulGenerationId: successful?.id ?? null,
    latestGeneration: await generationResource(latest, origin), result: successful ? await generationResource(successful, origin) : null,
    links: { self: `${origin}/api/v1/sfx/${id}`, web: `${origin}/library`, generations: `${origin}/api/v1/sfx/${id}/generations` } };
}

async function finishGeneration(job: SfxGeneration, token: string, asset: StoredAsset | null, error: SfxGeneration['error'], status: GenerationStatus) {
  const quotaRef = adminDb().collection('mediaQuotas').doc(`sfx_${job.ownerUid}`);
  await adminDb().runTransaction(async tx => {
    const snapshot = await tx.get(generationRef(job.id));
    const current = snapshot.data() as SfxGeneration | undefined;
    if (!current || current.leaseToken !== token || current.status !== 'generating') return;
    const item = await tx.get(itemRef(job.itemId));
    const quota = await tx.get(quotaRef);
    const now = Date.now();
    tx.update(generationRef(job.id), { status, phase: status, error, assetId: asset?.id ?? null, leaseUntil: 0, updatedAt: now });
    tx.update(adminDb().collection('mediaActivity').doc(job.id), { status, phase: status, updatedAt: now });
    if (item.data()?.latestGenerationId === job.id) tx.update(itemRef(job.itemId), {
      status, updatedAt: now, ...(asset ? { latestSuccessfulGenerationId: job.id, thumbnailAssetId: asset.id, durationMs: asset.durationMs } : {}),
    });
    tx.set(quotaRef, { ...quota.data(), active: ((quota.data()?.active ?? []) as string[]).filter(id => id !== job.id) });
  });
}

async function runJob(id: string) {
  const token = randomUUID();
  const job = await adminDb().runTransaction(async tx => {
    const snapshot = await tx.get(generationRef(id));
    const data = snapshot.data() as SfxGeneration | undefined;
    if (!data || data.type !== 'sfx' || data.status !== 'queued') return null;
    tx.update(generationRef(id), { status: 'generating', phase: 'starting', leaseToken: token, leaseUntil: Date.now() + 90_000, updatedAt: Date.now() });
    tx.update(itemRef(data.itemId), { status: 'generating', updatedAt: Date.now() });
    tx.update(adminDb().collection('mediaActivity').doc(id), { status: 'generating', phase: 'starting', updatedAt: Date.now() });
    return data;
  });
  if (!job) return;
  const heartbeat = setInterval(() => {
    void adminDb().runTransaction(async tx => {
      const current = await tx.get(generationRef(id));
      if (current.data()?.leaseToken === token && current.data()?.status === 'generating') tx.update(generationRef(id), { leaseUntil: Date.now() + 90_000 });
    }).catch(() => {});
  }, 20_000);
  heartbeat.unref();
  let submitted = false;
  try {
    const { prompt, output, promptInfluence } = job.request;
    // Built before submission, so a key removed after acceptance is a configuration error rather than an unknown outcome.
    // No retries: a synchronous create has no receipt, so a repeated call could pay twice.
    let provider: ElevenLabsSoundEffectsProvider;
    try { provider = new ElevenLabsSoundEffectsProvider(elevenLabsKey(), 0, job.model); }
    catch { throw new MediaError(503, 'provider_unavailable', 'ElevenLabs sound effects are not configured on this Studio. Your prompt is preserved.'); }
    await checkpoint(job, token, { phase: 'generating', preparedPrompt: prompt });
    submitted = true;
    const result = await provider.generate(prompt, { outputFormat: output.format, promptInfluence, loop: output.loop,
      ...(output.durationSeconds === null ? {} : { durationSeconds: output.durationSeconds }) });
    // Store the paid audio before anything else can fail; recovery decodes from this copy.
    await storeSfxOriginal(job.ownerUid, result.audioBytes, job.id, output.format);
    await checkpoint(job, token, { phase: 'saving' });
    const asset = await saveSfxAsset(job.ownerUid, result.audioBytes, job.id, job.itemId, output.format);
    await finishGeneration(job, token, asset, null, 'ready');
  } catch (error) {
    // Every ElevenLabs 4xx is a refusal; 5xx and network failures are unknown outcomes that are never called again.
    const status = error instanceof Error && error.name === 'ElevenLabsRequestError' ? Number((error as Error & { status?: unknown }).status) : NaN;
    const failure = error instanceof MediaError ? { code: error.code, message: error.message }
      : !submitted ? { code: 'preparation_failed', message: 'Could not prepare this sound effect request. Your prompt is preserved.' }
      : status >= 400 && status < 500 ? { code: 'provider_rejected', message: 'ElevenLabs could not accept this request. Your previous sound effect is preserved.' } : null;
    if (failure) await finishGeneration(job, token, null, failure, 'error').catch(() => {});
    else await recoverJob(job, token).catch(() => {});
  } finally { clearInterval(heartbeat); }
}
async function checkpoint(job: SfxGeneration, token: string, patch: Partial<SfxGeneration>) {
  await adminDb().runTransaction(async tx => {
    const current = (await tx.get(generationRef(job.id))).data();
    if (current?.leaseToken !== token || current.status !== 'generating') throw new Error('Generation lease expired');
    tx.update(generationRef(job.id), { ...patch, updatedAt: Date.now() });
    if (patch.phase) tx.update(adminDb().collection('mediaActivity').doc(job.id), { phase: patch.phase, updatedAt: Date.now() });
  });
}
/** Finish from saved output only. Without a receipt an unknown outcome is never regenerated automatically. */
async function recoverJob(job: SfxGeneration, token: string) {
  let asset: StoredAsset | null = null, failure: SfxGeneration['error'] = null;
  try { asset = await loadOwnedAsset(job.ownerUid, `sfx_${job.id}`); } catch { /* Try durable storage, never a new paid create. */ }
  const original = asset ? null : await adminBucket().file(sfxOriginalPath(job.ownerUid, job.id)).download().then(([bytes]) => new Uint8Array(bytes), () => null);
  // Stored audio that still cannot be processed ends the attempt as an error instead of being retried in a loop.
  if (original) {
    try { asset = await saveSfxAsset(job.ownerUid, original, job.id, job.itemId, job.request.output.format); }
    catch { failure = { code: 'invalid_sfx', message: 'ElevenLabs returned audio that could not be decoded. Your previous sound effect is preserved.' }; }
  }
  // Without stored audio the outcome is unknown, so it is explicit and requires a user retry.
  await finishGeneration(job, token, asset, asset ? null : failure ?? { code: 'generation_interrupted', message: 'This attempt did not complete. Generating again starts a new request; your previous sound effect is preserved.' }, asset ? 'ready' : failure ? 'error' : 'interrupted');
}

type Worker = { timer: ReturnType<typeof setTimeout> | null; ticking: boolean; running: Set<string> };
const globalWorker = globalThis as typeof globalThis & { __mdmediaSfxWorker?: Worker };
const worker = globalWorker.__mdmediaSfxWorker ??= { timer: null, ticking: false, running: new Set() };
export function startSfxWorker() {
  if (worker.timer) return;
  startAdaptivePolling(worker, processSfxJobs);
}
export async function processSfxJobs() {
  if (worker.ticking) return;
  worker.ticking = true;
  try {
    const stale = await adminDb().collection('mediaGenerations').where('type', '==', 'sfx').where('status', '==', 'generating').where('leaseUntil', '<', Date.now()).limit(10).get();
    for (const snapshot of stale.docs) {
      const job = snapshot.data() as SfxGeneration;
      const recoveryToken = randomUUID();
      const claimed = await adminDb().runTransaction(async tx => {
        const current = await tx.get(generationRef(job.id));
        if (current.data()?.type !== 'sfx' || current.data()?.status !== 'generating' || Number(current.data()?.leaseUntil) >= Date.now()) return false;
        tx.update(generationRef(job.id), { leaseToken: recoveryToken, leaseUntil: Date.now() + 90_000 });
        return true;
      });
      if (claimed) await recoverJob(job, recoveryToken);
    }
    const room = Math.max(0, 3 - worker.running.size);
    if (!room) return;
    const queued = await adminDb().collection('mediaGenerations').where('type', '==', 'sfx').where('status', '==', 'queued').orderBy('createdAt', 'asc').limit(room).get();
    for (const snapshot of queued.docs) {
      if (worker.running.has(snapshot.id)) continue;
      worker.running.add(snapshot.id);
      void runJob(snapshot.id).catch(() => {}).finally(() => worker.running.delete(snapshot.id));
    }
  } finally { worker.ticking = false; }
}
