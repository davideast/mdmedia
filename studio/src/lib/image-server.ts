import { createHash, randomUUID } from 'node:crypto';
import { adaptGeminiImagePrompt, generateGeminiImage, GeminiImageError, type ImageAspectRatio, type ImageResolution } from 'mdmedia/image';
import { createGeminiClient } from 'mdmedia/tts';
import { adminBucket, adminDb } from './firebase-admin';
import { assetResource, loadOwnedAsset, saveImageAsset, type StoredAsset } from './assets-server';
import { MediaError, validMediaId, readImageDefaults } from './image-request';
import { decideIdempotentReplay, executeImageJob } from './image-jobs';
import type { ImageGenerationResource, GenerationStatus, ImageRequest, ImageResource, MediaSummary } from './media-types';

interface ImageItem extends MediaSummary {
  ownerUid: string; visibility: 'private'; request: ImageRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
}
export interface ImageGeneration {
  id: string; ownerUid: string; itemId: string; type: 'image'; title: string;
  request: ImageRequest; provider: 'gemini'; model: string; adaptationModel: string;
  status: GenerationStatus; phase: string; preparedPrompt: string | null;
  assetId: string | null; createdAt: number; updatedAt: number;
  leaseUntil: number; leaseToken: string | null;
  error: { code: string; message: string } | null;
}
export const configuredImageModel = () => process.env.MDMEDIA_IMAGE_MODEL?.trim() || 'gemini-3-pro-image';
const titleFor = (prompt: string) => prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) || 'Untitled image';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const itemRef = (id: string) => adminDb().collection('mediaItems').doc(`image_${id}`);
const generationRef = (id: string) => adminDb().collection('mediaGenerations').doc(id);

export async function imageDefaults(uid: string): Promise<ImageRequest> {
  const user = await adminDb().collection('users').doc(uid).get();
  return readImageDefaults(user.data()?.settings?.imageDefaults);
}
export async function loadImageItem(uid: string, id: string): Promise<ImageItem> {
  const snapshot = validMediaId(id) ? await itemRef(id).get() : null;
  const item = snapshot?.data() as ImageItem | undefined;
  if (!item || item.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That image is not available to you.');
  return item;
}
export async function loadImageGeneration(uid: string, id: string): Promise<ImageGeneration> {
  const snapshot = validMediaId(id) ? await generationRef(id).get() : null;
  const generation = snapshot?.data() as ImageGeneration | undefined;
  if (!generation || generation.type !== 'image' || generation.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That generation is not available to you.');
  return generation;
}

/** Persist acceptance, quota, and idempotency together before dispatching any paid work. */
export async function submitImage(uid: string, request: ImageRequest, key: string, existingItemId: string | null, apiKeyId: string | null, submittedBody: unknown = request) {
  const target = existingItemId ?? 'new';
  const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    : Array.isArray(value) ? value.map(canonical) : value;
  const requestHash = digest(JSON.stringify(canonical(submittedBody)));
  const replayRef = adminDb().collection('mediaRequests').doc(digest(`${uid}:${target}:${key}`));
  const quotaRef = adminDb().collection('mediaQuotas').doc(uid);
  const itemId = existingItemId ?? adminDb().collection('mediaItems').doc().id;
  const generationId = adminDb().collection('mediaGenerations').doc().id;
  const now = Date.now();
  const accepted = await adminDb().runTransaction(async tx => {
    const replay = await tx.get(replayRef);
    const decision = decideIdempotentReplay(replay.exists ? replay.data() as { requestHash: string; itemId: string; generationId: string } : null, requestHash);
    if (decision.kind === 'conflict') throw new MediaError(409, 'idempotency_conflict', 'That key was already used with different image settings.');
    if (decision.kind === 'replay') return { itemId: decision.itemId, generationId: decision.generationId, replayed: true };
    if (!process.env.GEMINI_API_KEY) throw new MediaError(503, 'provider_unavailable', 'Gemini image generation is not configured on this Studio.');
    const itemSnapshot = await tx.get(itemRef(itemId));
    const previous = itemSnapshot.data() as ImageItem | undefined;
    if (existingItemId && (!previous || previous.ownerUid !== uid)) throw new MediaError(404, 'not_found', 'That image is not available to you.');
    if (previous && ['queued', 'generating'].includes(previous.status)) throw new MediaError(409, 'generation_in_progress', 'This image already has a generation in progress.');
    if (request.referenceAssetId) {
      const reference = await tx.get(adminDb().collection('mediaAssets').doc(request.referenceAssetId));
      if (!reference.exists || reference.data()?.ownerUid !== uid || !String(reference.data()?.mimeType).startsWith('image/') || reference.data()?.mediaType === 'video') throw new MediaError(404, 'reference_not_found', 'That reference image is not available to you.');
    }
    const quota = await tx.get(quotaRef);
    const data = quota.data() ?? {};
    const active = Array.isArray(data.active) ? data.active as string[] : [];
    if (active.length >= 3) throw new MediaError(429, 'too_many_in_progress', 'You have three images in progress. Wait for one to finish.');
    const hourly = data.hourly as Record<string, { since: number; count: number }> | undefined;
    const bucket = apiKeyId ? hourly?.[apiKeyId] : null;
    const current = bucket && now - bucket.since < 3_600_000 ? bucket : { since: now, count: 0 };
    if (apiKeyId && current.count >= 30) throw new MediaError(429, 'rate_limited', 'This key has started too many images this hour.');
    const nextHourly = Object.fromEntries(Object.entries(hourly ?? {}).filter(([, value]) => now - value.since < 3_600_000));
    if (apiKeyId) nextHourly[apiKeyId] = { ...current, count: current.count + 1 };
    const title = previous?.title ?? titleFor(request.prompt);
    const item: ImageItem = { id: itemId, type: 'image', ownerUid: uid, title, status: 'queued', visibility: 'private',
      createdAt: previous?.createdAt ?? now, updatedAt: now, href: `/image/${itemId}`, sourcePreview: request.prompt.slice(0, 4000),
      thumbnailAssetId: previous?.thumbnailAssetId ?? null, request, latestGenerationId: generationId,
      latestSuccessfulGenerationId: previous?.latestSuccessfulGenerationId ?? null };
    const generation: ImageGeneration = { id: generationId, ownerUid: uid, itemId, type: 'image', title, request,
      provider: 'gemini', model: configuredImageModel(), adaptationModel: process.env.MDMEDIA_IMAGE_ADAPTATION_MODEL || 'gemini-3.5-flash-lite',
      status: 'queued', phase: 'queued', preparedPrompt: null, assetId: null, createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, error: null };
    tx.set(itemRef(itemId), item);
    tx.set(generationRef(generationId), generation);
    tx.set(adminDb().collection('mediaActivity').doc(generationId), { id: generationId, itemId, ownerUid: uid, type: 'image', title, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, href: `/image/${itemId}` });
    tx.set(replayRef, { ownerUid: uid, requestHash, itemId, generationId, createdAt: now });
    tx.set(quotaRef, { active: [...active, generationId], hourly: nextHourly });
    return { itemId, generationId, replayed: false };
  });
  startImageWorker();
  void processImageJobs().catch(() => {});
  return accepted;
}

export async function generationResource(generation: ImageGeneration, origin: string): Promise<ImageGenerationResource> {
  const asset = generation.assetId ? await loadOwnedAsset(generation.ownerUid, generation.assetId) : null;
  return { id: generation.id, itemId: generation.itemId, type: 'image', title: generation.title, status: generation.status,
    phase: generation.phase, createdAt: generation.createdAt, updatedAt: generation.updatedAt, request: generation.request,
    preparedPrompt: generation.preparedPrompt, provider: generation.provider, model: generation.model,
    assets: asset ? [assetResource(asset, origin)] : [], error: generation.error,
    links: { self: `${origin}/api/v1/generations/${generation.id}`, web: `${origin}/image/${generation.itemId}` } };
}
export async function imageResource(uid: string, id: string, origin: string): Promise<ImageResource> {
  const item = await loadImageItem(uid, id);
  const latest = await loadImageGeneration(uid, item.latestGenerationId);
  const successful = item.latestSuccessfulGenerationId === latest.id ? latest : item.latestSuccessfulGenerationId ? await loadImageGeneration(uid, item.latestSuccessfulGenerationId) : null;
  const publicItem: Omit<ImageItem, 'ownerUid'> = { ...item };
  Reflect.deleteProperty(publicItem, 'ownerUid');
  return { ...publicItem, latestGeneration: await generationResource(latest, origin), result: successful ? await generationResource(successful, origin) : null,
    links: { self: `${origin}/api/v1/images/${id}`, web: `${origin}/image/${id}`, generations: `${origin}/api/v1/images/${id}/generations` } };
}

async function finishGeneration(job: ImageGeneration, token: string, asset: StoredAsset | null, error: ImageGeneration['error'], status: GenerationStatus) {
  const quotaRef = adminDb().collection('mediaQuotas').doc(job.ownerUid);
  await adminDb().runTransaction(async tx => {
    const snapshot = await tx.get(generationRef(job.id));
    const current = snapshot.data() as ImageGeneration | undefined;
    if (!current || current.leaseToken !== token || current.status !== 'generating') return;
    const item = await tx.get(itemRef(job.itemId));
    const quota = await tx.get(quotaRef);
    const now = Date.now();
    tx.update(generationRef(job.id), { status, phase: status, error, assetId: asset?.id ?? null, leaseUntil: 0, updatedAt: now });
    tx.update(adminDb().collection('mediaActivity').doc(job.id), { status, phase: status, updatedAt: now });
    if (item.data()?.latestGenerationId === job.id) tx.update(itemRef(job.itemId), {
      status, updatedAt: now, ...(asset ? { latestSuccessfulGenerationId: job.id, thumbnailAssetId: asset.id } : {}),
    });
    tx.set(quotaRef, { ...quota.data(), active: ((quota.data()?.active ?? []) as string[]).filter(id => id !== job.id) });
  });
}

async function runJob(id: string) {
  const token = randomUUID();
  const job = await adminDb().runTransaction(async tx => {
    const snapshot = await tx.get(generationRef(id));
    const data = snapshot.data() as ImageGeneration | undefined;
    if (!data || data.type !== 'image' || data.status !== 'queued') return null;
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
  let providerSubmitted = false;
  try {
    const client = createGeminiClient();
    await executeImageJob(job.request, {
      prepare: (source, instructions) => adaptGeminiImagePrompt(client, source, instructions, job.adaptationModel),
      async checkpoint(phase, preparedPrompt) {
        await adminDb().runTransaction(async tx => {
          const current = await tx.get(generationRef(id));
          if (current.data()?.leaseToken !== token || current.data()?.status !== 'generating') throw new Error('Generation lease expired');
          tx.update(generationRef(id), { phase, ...(preparedPrompt === undefined ? {} : { preparedPrompt }), updatedAt: Date.now() });
          tx.update(adminDb().collection('mediaActivity').doc(id), { phase, updatedAt: Date.now() });
        });
      },
      async generate(prompt, request) {
        const reference = request.referenceAssetId ? await loadOwnedAsset(job.ownerUid, request.referenceAssetId) : null;
        const bytes = reference ? new Uint8Array((await adminBucket().file(reference.path).download())[0]) : null;
        providerSubmitted = true;
        const output = await generateGeminiImage(client, { prompt, model: job.model, aspectRatio: request.output.aspectRatio as ImageAspectRatio,
          ...(request.output.resolution ? { resolution: request.output.resolution as ImageResolution } : {}),
          ...(reference && bytes ? { reference: { bytes, mimeType: reference.mimeType } } : {}) });
        return output.bytes;
      },
      async save(bytes) {
        const asset = await saveImageAsset(job.ownerUid, bytes, 'output', job.id, job.itemId);
        await finishGeneration(job, token, asset, null, 'ready');
      },
    });
  } catch (error) {
    // Never return provider exception text: it may contain request bodies or credentials.
    if (!providerSubmitted || error instanceof GeminiImageError) {
      await finishGeneration(job, token, null, { code: providerSubmitted ? 'no_image' : 'preparation_failed', message: providerSubmitted ? 'Gemini returned no image. Try revising your prompt.' : 'Could not prepare this image request. Your source has been preserved.' }, 'error').catch(() => {});
    } else await recoverJob(job, token).catch(() => {});
  } finally { clearInterval(heartbeat); }
}
async function recoverJob(job: ImageGeneration, token: string) {
  let asset: StoredAsset | null = null;
  try { asset = await loadOwnedAsset(job.ownerUid, `image_${job.id}`); } catch { /* Storage may have completed before its database checkpoint. */ }
  if (!asset) {
    try {
      const [bytes] = await adminBucket().file(`media/${job.ownerUid}/image_${job.id}/original`).download();
      asset = await saveImageAsset(job.ownerUid, new Uint8Array(bytes), 'output', job.id, job.itemId);
    } catch { /* An absent output must not trigger another provider request. */ }
  }
  await finishGeneration(job, token, asset, asset ? null : { code: 'generation_interrupted', message: 'This attempt did not complete. Its provider outcome may be unknown. Generating again starts a new request.' }, asset ? 'ready' : 'interrupted');
}

type Worker = { timer: ReturnType<typeof setInterval> | null; ticking: boolean; running: Set<string> };
const globalWorker = globalThis as typeof globalThis & { __mdmediaImageWorker?: Worker };
const worker = globalWorker.__mdmediaImageWorker ??= { timer: null, ticking: false, running: new Set() };
export function startImageWorker() {
  if (worker.timer) return;
  worker.timer = setInterval(() => { void processImageJobs().catch(() => {}); }, 5000);
  worker.timer.unref();
}
export async function processImageJobs() {
  if (worker.ticking) return;
  worker.ticking = true;
  try {
    const stale = await adminDb().collection('mediaGenerations').where('type', '==', 'image').where('status', '==', 'generating').where('leaseUntil', '<', Date.now()).limit(10).get();
    for (const snapshot of stale.docs) {
      const job = snapshot.data() as ImageGeneration;
      const recoveryToken = randomUUID();
      const claimed = await adminDb().runTransaction(async tx => {
        const current = await tx.get(generationRef(job.id));
        if (current.data()?.type !== 'image' || current.data()?.status !== 'generating' || Number(current.data()?.leaseUntil) >= Date.now()) return false;
        tx.update(generationRef(job.id), { leaseToken: recoveryToken, leaseUntil: Date.now() + 90_000 });
        return true;
      });
      if (claimed) await recoverJob(job, recoveryToken);
    }
    const room = Math.max(0, 3 - worker.running.size);
    if (!room) return;
    const queued = await adminDb().collection('mediaGenerations').where('type', '==', 'image').where('status', '==', 'queued').orderBy('createdAt', 'asc').limit(room).get();
    for (const snapshot of queued.docs) {
      if (worker.running.has(snapshot.id)) continue;
      worker.running.add(snapshot.id);
      void runJob(snapshot.id).catch(() => {}).finally(() => worker.running.delete(snapshot.id));
    }
  } finally { worker.ticking = false; }
}
