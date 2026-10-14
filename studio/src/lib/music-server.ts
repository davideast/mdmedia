import { createHash, randomUUID } from 'node:crypto';
import { LyriaMusicProvider } from 'mdmedia/music';
import { videoToolsAvailable } from './video-assets-server';
import { saveMusicAsset, type MusicAsset } from './music-assets-server';
import { musicPrompt, readMusicDefaults, MAX_MUSIC_BYTES } from './music-request';
import { createGeminiClient } from 'mdmedia/tts';
import { adminBucket, adminDb } from './firebase-admin';
import { assetResource, loadOwnedAsset, type StoredAsset } from './assets-server';
import { MediaError, validMediaId } from './image-request';
import { decideIdempotentReplay } from './image-jobs';
import type { MusicGenerationResource, GenerationStatus, MusicRequest, MusicResource, MediaSummary } from './media-types';

interface MusicItem extends MediaSummary {
  ownerUid: string; visibility: 'private'; request: MusicRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
}
export interface MusicGeneration {
  id: string; ownerUid: string; itemId: string; type: 'music'; title: string;
  interactionId: string | null; lyrics: string | null;
  request: MusicRequest; provider: 'lyria'; model: string; adaptationModel: string;
  status: GenerationStatus; phase: string; preparedPrompt: string | null;
  assetId: string | null; createdAt: number; updatedAt: number;
  leaseUntil: number; leaseToken: string | null;
  error: { code: string; message: string } | null;
}
export const configuredMusicModel = () => process.env.MDMEDIA_MUSIC_MODEL?.trim() || 'lyria-3.5';
const titleFor = (prompt: string) => prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) || 'Untitled music';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const itemRef = (id: string) => adminDb().collection('mediaItems').doc(`music_${id}`);
const generationRef = (id: string) => adminDb().collection('mediaGenerations').doc(id);

export async function musicDefaults(uid: string): Promise<MusicRequest> {
  const user = await adminDb().collection('users').doc(uid).get();
  return readMusicDefaults(user.data()?.settings?.musicDefaults);
}
export async function loadMusicItem(uid: string, id: string): Promise<MusicItem> {
  const snapshot = validMediaId(id) ? await itemRef(id).get() : null;
  const item = snapshot?.data() as MusicItem | undefined;
  if (!item || item.type !== 'music' || item.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That music is not available to you.');
  return item;
}
export async function loadMusicGeneration(uid: string, id: string): Promise<MusicGeneration> {
  const snapshot = validMediaId(id) ? await generationRef(id).get() : null;
  const generation = snapshot?.data() as MusicGeneration | undefined;
  if (!generation || generation.type !== 'music' || generation.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That generation is not available to you.');
  return generation;
}

/** Persist acceptance, quota, and idempotency together before dispatching any paid work. */
export async function submitMusic(uid: string, request: MusicRequest, key: string, existingItemId: string | null, apiKeyId: string | null, submittedBody: unknown = request) {
  const target = existingItemId ?? 'new';
  const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    : Array.isArray(value) ? value.map(canonical) : value;
  const requestHash = digest(JSON.stringify(canonical(submittedBody)));
  const replayRef = adminDb().collection('mediaRequests').doc(digest(`music:${uid}:${target}:${key}`));
  const quotaRef = adminDb().collection('mediaQuotas').doc(`music_${uid}`);
  const itemId = existingItemId ?? adminDb().collection('mediaItems').doc().id;
  const generationId = adminDb().collection('mediaGenerations').doc().id;
  const now = Date.now();
  const toolsAvailable = await videoToolsAvailable();
  const accepted = await adminDb().runTransaction(async tx => {
    const replay = await tx.get(replayRef);
    const decision = decideIdempotentReplay(replay.exists ? replay.data() as { requestHash: string; itemId: string; generationId: string } : null, requestHash);
    if (decision.kind === 'conflict') throw new MediaError(409, 'idempotency_conflict', 'That key was already used with different music settings.');
    if (decision.kind === 'replay') return { itemId: decision.itemId, generationId: decision.generationId, replayed: true };
    if (!process.env.GEMINI_API_KEY || !toolsAvailable) throw new MediaError(503, 'provider_unavailable', 'Gemini music generation is not configured on this Studio.');
    const itemSnapshot = await tx.get(itemRef(itemId));
    const previous = itemSnapshot.data() as MusicItem | undefined;
    if (existingItemId && (!previous || previous.type !== 'music' || previous.ownerUid !== uid)) throw new MediaError(404, 'not_found', 'That music is not available to you.');
    if (previous && ['queued', 'generating'].includes(previous.status)) throw new MediaError(409, 'generation_in_progress', 'This music already has a generation in progress.');
    if (request.referenceAssetId) {
      const reference = await tx.get(adminDb().collection('mediaAssets').doc(request.referenceAssetId));
      if (!reference.exists || reference.data()?.ownerUid !== uid || !String(reference.data()?.mimeType).startsWith('image/') || reference.data()?.mediaType !== 'music' || reference.data()?.purpose !== 'reference') throw new MediaError(404, 'reference_not_found', 'That reference image is not available to you.');
    }
    const quota = await tx.get(quotaRef);
    const data = quota.data() ?? {};
    const active = Array.isArray(data.active) ? data.active as string[] : [];
    if (active.length >= 3) throw new MediaError(429, 'too_many_in_progress', 'You have three music attempts in progress. Wait for one to finish.');
    const hourly = data.hourly as Record<string, { since: number; count: number }> | undefined;
    const bucket = apiKeyId ? hourly?.[apiKeyId] : null;
    const current = bucket && now - bucket.since < 3_600_000 ? bucket : { since: now, count: 0 };
    if (apiKeyId && current.count >= 30) throw new MediaError(429, 'rate_limited', 'This key has started too much music this hour.');
    const nextHourly = Object.fromEntries(Object.entries(hourly ?? {}).filter(([, value]) => now - value.since < 3_600_000));
    if (apiKeyId) nextHourly[apiKeyId] = { ...current, count: current.count + 1 };
    const title = previous?.title ?? titleFor(request.prompt);
    const item: MusicItem = { id: itemId, type: 'music', ownerUid: uid, title, status: 'queued', visibility: 'private',
      createdAt: previous?.createdAt ?? now, updatedAt: now, href: `/music/${itemId}`, sourcePreview: request.prompt.slice(0, 4000),
      thumbnailAssetId: previous?.thumbnailAssetId ?? null, durationMs: previous?.durationMs ?? 0, request, latestGenerationId: generationId,
      latestSuccessfulGenerationId: previous?.latestSuccessfulGenerationId ?? null };
    const generation: MusicGeneration = { id: generationId, ownerUid: uid, itemId, type: 'music', title, request,
      provider: 'lyria', model: request.output.mode === 'clip' ? 'lyria-3-clip-preview' : configuredMusicModel(), adaptationModel: process.env.MDMEDIA_MUSIC_ADAPTATION_MODEL || 'gemini-3.5-flash-lite',
      status: 'queued', phase: 'queued', preparedPrompt: null, assetId: null, interactionId: null, lyrics: null, createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, error: null };
    tx.set(itemRef(itemId), item);
    tx.set(generationRef(generationId), generation);
    tx.set(adminDb().collection('mediaActivity').doc(generationId), { id: generationId, itemId, ownerUid: uid, type: 'music', title, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, href: `/music/${itemId}` });
    tx.set(replayRef, { ownerUid: uid, requestHash, itemId, generationId, createdAt: now });
    tx.set(quotaRef, { active: [...active, generationId], hourly: nextHourly });
    return { itemId, generationId, replayed: false };
  });
  startMusicWorker();
  void processMusicJobs().catch(() => {});
  return accepted;
}

export async function generationResource(generation: MusicGeneration, origin: string): Promise<MusicGenerationResource> {
  const asset = generation.assetId ? await loadOwnedAsset(generation.ownerUid, generation.assetId) : null;
  return { id: generation.id, itemId: generation.itemId, type: 'music', title: generation.title, status: generation.status,
    phase: generation.phase, createdAt: generation.createdAt, updatedAt: generation.updatedAt, request: generation.request,
    preparedPrompt: generation.preparedPrompt, provider: generation.provider, model: generation.model, lyrics: generation.lyrics,
    waveform: (asset as MusicAsset | null)?.waveform ?? [], durationSeconds: asset?.durationMs ? asset.durationMs / 1000 : null,
    assets: asset ? [assetResource(asset, origin)] : [], error: generation.error,
    links: { self: `${origin}/api/v1/generations/${generation.id}`, web: `${origin}/music/${generation.itemId}` } };
}
export async function musicResource(uid: string, id: string, origin: string): Promise<MusicResource> {
  const item = await loadMusicItem(uid, id);
  const latest = await loadMusicGeneration(uid, item.latestGenerationId);
  const successful = item.latestSuccessfulGenerationId === latest.id ? latest : item.latestSuccessfulGenerationId ? await loadMusicGeneration(uid, item.latestSuccessfulGenerationId) : null;
  return { id: item.id, type: 'music', title: item.title, status: item.status, visibility: 'private',
    createdAt: item.createdAt, updatedAt: item.updatedAt, href: item.href, thumbnailAssetId: item.thumbnailAssetId, durationMs: item.durationMs,
    request: item.request, latestGenerationId: latest.id, latestSuccessfulGenerationId: successful?.id ?? null,
    latestGeneration: await generationResource(latest, origin), result: successful ? await generationResource(successful, origin) : null,
    links: { self: `${origin}/api/v1/music/${id}`, web: `${origin}/music/${id}`, generations: `${origin}/api/v1/music/${id}/generations` } };
}

async function finishGeneration(job: MusicGeneration, token: string, asset: StoredAsset | null, error: MusicGeneration['error'], status: GenerationStatus) {
  const quotaRef = adminDb().collection('mediaQuotas').doc(`music_${job.ownerUid}`);
  await adminDb().runTransaction(async tx => {
    const snapshot = await tx.get(generationRef(job.id));
    const current = snapshot.data() as MusicGeneration | undefined;
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
    const data = snapshot.data() as MusicGeneration | undefined;
    if (!data || data.type !== 'music' || data.status !== 'queued') return null;
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
    const client = createGeminiClient();
    let prompt = job.request.prompt;
    if (job.request.adaptation.enabled) {
      await checkpoint(job, token, { phase: 'preparing' });
      const adapted = await client.models.generateContent({ model: job.adaptationModel,
        contents: `Turn these notes into a concise music generation prompt. Preserve intent and musical directions. Return only the prompt.\nInstructions: ${job.request.adaptation.instructions}\nNotes:\n${prompt}` });
      if (!adapted.text?.trim()) throw new Error('No prepared prompt');
      prompt = adapted.text.trim();
    }
    prompt = musicPrompt(job.request, prompt);
    await checkpoint(job, token, { phase: 'generating', preparedPrompt: prompt });
    const reference = job.request.referenceAssetId ? await loadOwnedAsset(job.ownerUid, job.request.referenceAssetId) : null;
    const bytes = reference ? new Uint8Array((await adminBucket().file(reference.path).download())[0]) : null;
    submitted = true;
    const output = await new LyriaMusicProvider(client, 0).generate(prompt, { model: job.model, outputFormat: job.request.output.mode === 'clip' ? 'mp3' : job.request.output.format, maxBytes: MAX_MUSIC_BYTES,
      ...(reference && bytes ? { reference: { bytes, mimeType: reference.mimeType } } : {}),
      onInteraction: async interactionId => { job.interactionId = interactionId; await checkpoint(job, token, { interactionId, phase: 'downloading' }); } });
    await checkpoint(job, token, { lyrics: output.lyrics ?? null, phase: 'saving' });
    const asset = await saveMusicAsset(job.ownerUid, output.audioBytes, job.id, job.itemId, job.request.output.format);
    await finishGeneration(job, token, asset, null, 'ready');
  } catch (error) {
    const status = Number((error as { status?: number }).status);
    if (!submitted || [400, 401, 403, 404, 422, 429].includes(status)) {
      await finishGeneration(job, token, null, { code: submitted ? 'provider_rejected' : 'preparation_failed', message: submitted ? 'Lyria could not accept this request. Your previous music is preserved.' : 'Could not prepare this music request. Your source is preserved.' }, 'error').catch(() => {});
    } else await recoverJob(job, token).catch(() => {});
  } finally { clearInterval(heartbeat); }
}
async function checkpoint(job: MusicGeneration, token: string, patch: Partial<MusicGeneration>) {
  await adminDb().runTransaction(async tx => {
    const current = (await tx.get(generationRef(job.id))).data();
    if (current?.leaseToken !== token || current.status !== 'generating') throw new Error('Generation lease expired');
    tx.update(generationRef(job.id), { ...patch, updatedAt: Date.now() });
    if (patch.phase) tx.update(adminDb().collection('mediaActivity').doc(job.id), { phase: patch.phase, updatedAt: Date.now() });
  });
}
async function recoverJob(job: MusicGeneration, token: string) {
  let asset: StoredAsset | null = null;
  try { asset = await loadOwnedAsset(job.ownerUid, `music_${job.id}`); } catch { /* Try durable storage or the saved receipt, never a new paid create. */ }
  if (!asset) {
    try {
      const [bytes] = await adminBucket().file(`media/${job.ownerUid}/music_${job.id}/original`).download();
      asset = await saveMusicAsset(job.ownerUid, new Uint8Array(bytes), job.id, job.itemId, job.request.output.format);
    } catch { /* Receipt retrieval is safe if no output survived. */ }
  }
  if (!asset && job.interactionId) {
    try {
      const output = await new LyriaMusicProvider(createGeminiClient(), 0).retrieve(job.interactionId, { maxBytes: MAX_MUSIC_BYTES });
      await checkpoint(job, token, { lyrics: output.lyrics ?? null, phase: 'saving' });
      asset = await saveMusicAsset(job.ownerUid, output.audioBytes, job.id, job.itemId, job.request.output.format);
    } catch { /* Unknown outcome is explicit and requires user retry. */ }
  }
  await finishGeneration(job, token, asset, asset ? null : { code: 'generation_interrupted', message: 'This attempt did not complete. Generating again starts a new request; your previous music is preserved.' }, asset ? 'ready' : 'interrupted');
}

type Worker = { timer: ReturnType<typeof setInterval> | null; ticking: boolean; running: Set<string> };
const globalWorker = globalThis as typeof globalThis & { __mdmediaMusicWorker?: Worker };
const worker = globalWorker.__mdmediaMusicWorker ??= { timer: null, ticking: false, running: new Set() };
export function startMusicWorker() {
  if (worker.timer) return;
  worker.timer = setInterval(() => { void processMusicJobs().catch(() => {}); }, 5000);
  worker.timer.unref();
}
export async function processMusicJobs() {
  if (worker.ticking) return;
  worker.ticking = true;
  try {
    const stale = await adminDb().collection('mediaGenerations').where('type', '==', 'music').where('status', '==', 'generating').where('leaseUntil', '<', Date.now()).limit(10).get();
    for (const snapshot of stale.docs) {
      const job = snapshot.data() as MusicGeneration;
      const recoveryToken = randomUUID();
      const claimed = await adminDb().runTransaction(async tx => {
        const current = await tx.get(generationRef(job.id));
        if (current.data()?.type !== 'music' || current.data()?.status !== 'generating' || Number(current.data()?.leaseUntil) >= Date.now()) return false;
        tx.update(generationRef(job.id), { leaseToken: recoveryToken, leaseUntil: Date.now() + 90_000 });
        return true;
      });
      if (claimed) await recoverJob(job, recoveryToken);
    }
    const room = Math.max(0, 3 - worker.running.size);
    if (!room) return;
    const queued = await adminDb().collection('mediaGenerations').where('type', '==', 'music').where('status', '==', 'queued').orderBy('createdAt', 'asc').limit(room).get();
    for (const snapshot of queued.docs) {
      if (worker.running.has(snapshot.id)) continue;
      worker.running.add(snapshot.id);
      void runJob(snapshot.id).catch(() => {}).finally(() => worker.running.delete(snapshot.id));
    }
  } finally { worker.ticking = false; }
}
