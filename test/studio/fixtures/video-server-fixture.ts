// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const documents = new Map<string, Record<string, any>>();
const files = new Map<string, Buffer>();
let sequence = 0;
let transactionTail = Promise.resolve();
class Ref {
  constructor(readonly path: string) {}
  get id() { return this.path.split('/').at(-1)!; }
  async get() { const data = documents.get(this.path); return { ref: this, id: this.id, exists: !!data, data: () => data ? structuredClone(data) : undefined }; }
  async set(data: Record<string, any>) { documents.set(this.path, structuredClone(data)); }
  async update(patch: Record<string, any>) { assert(documents.has(this.path), `Missing ${this.path}`); documents.set(this.path, { ...documents.get(this.path), ...structuredClone(patch) }); }
  async delete() { documents.delete(this.path); }
}
class Query {
  constructor(readonly collection: string, readonly filters: Array<[string, string, any]> = [], readonly orders: Array<[string, string]> = [], readonly cap = Infinity, readonly after: any[] = []) {}
  doc(id = `test${++sequence}`) { return new Ref(`${this.collection}/${id}`); }
  where(field: string, op: string, value: any) { return new Query(this.collection, [...this.filters, [field, op, value]], this.orders, this.cap, this.after); }
  orderBy(field: string, direction = 'asc') { return new Query(this.collection, this.filters, [...this.orders, [field, direction]], this.cap, this.after); }
  limit(cap: number) { return new Query(this.collection, this.filters, this.orders, cap, this.after); }
  startAfter(...after: any[]) { return new Query(this.collection, this.filters, this.orders, this.cap, after); }
  async get() {
    const value = (entry: [string, any], field: string) => field === '__name__' ? entry[0].split('/').at(-1) : entry[1][field];
    let entries = [...documents.entries()].filter(([path]) => path.startsWith(`${this.collection}/`) && path.split('/').length === 2);
    entries = entries.filter(entry => this.filters.every(([field, op, expected]) => op === '==' ? value(entry, field) === expected : op === 'in' ? expected.includes(value(entry, field)) : op === '<' ? value(entry, field) < expected : false));
    const compare = (entry: [string, any], other: any[]) => { for (let i = 0; i < this.orders.length; i++) { const [field, direction] = this.orders[i]; const actual = value(entry, field); if (actual !== other[i]) return (actual < other[i] ? -1 : 1) * (direction === 'desc' ? -1 : 1); } return 0; };
    entries.sort((a, b) => compare(a, this.orders.map(([field]) => value(b, field))));
    if (this.after.length) entries = entries.filter(entry => compare(entry, this.after) > 0);
    return { empty: entries.length === 0, docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction(run: (tx: any) => Promise<any>) {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = []; let writing = false;
  try { const result = await run({ get: (ref: Ref) => { assert(!writing, 'Read after write in transaction'); return ref.get(); }, set: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.set(data)); }, update: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.update(data)); } }); for (const write of writes) await write(); return result; }
  finally { release(); }
} };
const bucket = { file(path: string) { return { async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); }, async download() { assert(files.has(path), 'Missing storage object'); return [files.get(path)]; } }; } };
const directory = await mkdtemp(join(tmpdir(), 'mdmedia-video-test-'));
const movies = new Map<number, Buffer>();
try {
  for (const duration of [3, 6, 9, 10, 20]) {
    const path = join(directory, `${duration}.mp4`);
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(duration), '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', path]);
    movies.set(duration, await readFile(path));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
let providerCalls = 0; let retrievalCalls = 0; let fail: 'none' | 'network' | 'expired' | 'tail' = 'none';
let hold: Promise<void> | null = null; let release!: () => void;
const receipts = new Map<string, Buffer>(); const payloads: any[] = [];
const client = {
  interactions: {
    async create(payload: any, options: any) {
      providerCalls++; payloads.push(payload); assert.equal(options.maxRetries, 0); if (hold) await hold;
      if (fail === 'expired') throw Object.assign(new Error('SECRET provider context expired'), { status: 404 });
      if (fail === 'network') throw new Error('SECRET network failure');
      assert.equal(payload.previous_interaction_id, undefined);
      const sourceVideo = Array.isArray(payload.input) && payload.input[0]?.type === 'model_output' ? payload.input[0].content[0] : null;
      const prior = sourceVideo ? Buffer.from(sourceVideo.data, 'base64') : null;
      const { readMp4Duration } = await import('../../../src/video/mp4-duration');
      const duration = fail === 'tail' ? 3 : (prior ? Math.round(readMp4Duration(prior)!) : 0) + parseInt(payload.response_format.duration);
      const bytes = movies.get(duration)!; assert(bytes, `Missing ${duration}s fixture`);
      const id = `provider-${providerCalls}`; receipts.set(id, bytes);
      return { id, output_video: { data: bytes.toString('base64') } };
    },
    async get(id: string) { retrievalCalls++; assert(receipts.has(id)); return { id, output_video: { data: receipts.get(id)!.toString('base64') } }; },
  },
  models: { async generateContent() { return { text: 'Prepared motion and sound' }; } },
};
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));
const ttsEntry = Bun.resolveSync('mdmedia/tts', fileURLToPath(new URL('../../../studio/src/lib/', import.meta.url)));
mock.module(join(dirname(ttsEntry), 'gemini-client-factory.js'), () => ({ NodeEnvProvider: class {}, createGeminiClient: () => client }));
process.env.GEMINI_API_KEY = 'test-only-placeholder';
const server = await import('../../../studio/src/lib/video-server');
const imageServer = await import('../../../studio/src/lib/image-server');
const { parseVideoRequest } = await import('../../../studio/src/lib/video-request');
const { listMedia } = await import('../../../studio/src/lib/media-catalog-server');
const uid = 'owner';
const request = parseVideoRequest({ prompt: 'A red train rolls', output: { durationSeconds: 3 }, adaptation: { enabled: true } });
async function waitFor(id: string, predicate: (job: any) => boolean) {
  for (let i = 0; i < 1000; i++) { await server.processVideoJobs(); const job = await server.loadVideoGeneration(uid, id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out ${id}: ${JSON.stringify(documents.get(`mediaGenerations/${id}`))}`);
}
async function settled(id: string) { return waitFor(id, job => !['queued', 'generating'].includes(job.status)); }
// Concurrent duplicates reserve one attempt. Other scopes and owners cannot access it.
hold = new Promise(resolve => { release = resolve; });
const accepted = await Promise.all(Array.from({ length: 8 }, () => server.submitVideo(uid, request, 'initial-key-123', null, 'key')));
assert.equal(new Set(accepted.map(value => value.generationId)).size, 1); const first = accepted[0];
await waitFor(first.generationId, job => job.phase === 'generating');
assert.equal(providerCalls, 1); assert.equal(documents.get('mediaQuotas/video_owner')!.active.length, 1);
await assert.rejects(server.submitVideo(uid, { ...request, prompt: 'Different' }, 'initial-key-123', null, 'key'), { code: 'idempotency_conflict' });
await assert.rejects(server.loadVideoItem('other', first.itemId), { code: 'not_found' });
await assert.rejects(server.loadVideoGeneration('other', first.generationId), { code: 'not_found' });
// The image dispatcher leaves pending video jobs alone.
await imageServer.processImageJobs(); assert.equal(documents.get(`mediaGenerations/${first.generationId}`)!.type, 'video');
release(); hold = null; assert.equal((await settled(first.generationId)).status, 'ready');
const ready = await server.videoResource(uid, first.itemId, 'https://studio.test');
assert.equal(ready.result!.assets[0].width, 64); assert.equal(ready.result!.assets[0].height, 36); assert.equal(ready.result!.preparedPrompt, 'Prepared motion and sound');
assert.equal(ready.clips.length, 1); assert.equal(ready.clips[0].startSeconds, 0);
assert(!JSON.stringify(ready).includes('provider-')); assert(!JSON.stringify(ready).includes('ownerUid')); assert(!JSON.stringify(ready).includes('storage'));
// A new clip extends the current success. Stale clients and parallel distinct submissions conflict.
const nextBody = { ...request, prompt: 'Pass the blue station', action: 'continue', fromGenerationId: first.generationId };
hold = new Promise(resolve => { release = resolve; });
const next = await server.submitVideo(uid, nextBody, 'continue-key-123', first.itemId, 'key');
await waitFor(next.generationId, job => job.phase === 'generating');
await assert.rejects(server.submitVideo(uid, nextBody, 'another-key-123', first.itemId, 'key'), { code: 'generation_in_progress' });
assert.equal((await server.videoResource(uid, first.itemId, '')).result!.id, first.generationId);
release(); hold = null; const secondJob = await settled(next.generationId); assert.equal(secondJob.status, 'ready'); assert.equal(secondJob.parentGenerationId, first.generationId);
assert.equal(payloads[1].input[0].type, 'model_output'); assert(payloads[1].input[1].content[0].text.includes('Extend this video by 3 seconds'));
await assert.rejects(server.submitVideo(uid, nextBody, 'stale-key-12345', first.itemId, 'key'), { code: 'stale_generation' });
const continued = await server.videoResource(uid, first.itemId, 'https://studio.test'); assert(Math.abs(continued.result!.durationSeconds! - 6) < 0.1); assert.equal(continued.clips.length, 2);
const replay = await server.submitVideo(uid, nextBody, 'continue-key-123', first.itemId, 'key'); assert.equal(replay.generationId, next.generationId); assert.equal(providerCalls, 2);
// Regenerate latest replaces the second clip, using its original parent receipt.
const regenerate = await server.submitVideo(uid, { ...request, prompt: 'Pass a green station', action: 'regenerate_latest', fromGenerationId: next.generationId }, 'regenerate-key-123', first.itemId, 'key');
const replacement = await settled(regenerate.generationId); assert.equal(replacement.status, 'ready'); assert(Math.abs(replacement.durationSeconds! - 6) < 0.1);
assert.equal(replacement.parentGenerationId, first.generationId); assert.equal(replacement.replacesGenerationId, next.generationId); assert.equal(replacement.clipNumber, 2);
assert.equal(payloads[2].input[0].content[0].data, payloads[1].input[0].content[0].data);
assert.equal(replacement.clipDurationSeconds, 3); assert.notEqual(replacement.clipAssetId, replacement.assetId);
assert.equal((await server.loadVideoGeneration(uid, next.generationId)).assetId, secondJob.assetId);
// Bad outputs and a provider 404 preserve the result. Local clips do not expire with provider context.
fail = 'tail';
const invalid = await server.submitVideo(uid, { ...nextBody, fromGenerationId: replacement.id }, 'tail-key-123456', first.itemId, 'key'); await settled(invalid.generationId);
assert.equal((await server.videoResource(uid, first.itemId, '')).result!.id, replacement.id);
fail = 'expired';
const expired = await server.submitVideo(uid, { ...nextBody, fromGenerationId: replacement.id }, 'expired-key-123', first.itemId, 'key');
assert.equal((await settled(expired.generationId)).error!.code, 'provider_rejected');
assert.equal((await server.videoResource(uid, first.itemId, '')).result!.id, replacement.id);
assert.equal((await server.videoResource(uid, first.itemId, '')).canContinue, true);
fail = 'none';
// Shape/resolution, foreign references and the sequence cap are validated before paid work.
await assert.rejects(server.submitVideo(uid, { ...nextBody, fromGenerationId: replacement.id, output: { ...request.output, aspectRatio: '9:16' } }, 'shape-key-12345', first.itemId, 'key'), { code: 'locked_output' });
documents.set('mediaAssets/foreign', { ownerUid: 'other', mediaType: 'video', purpose: 'reference', mimeType: 'image/png' });
await assert.rejects(server.submitVideo(uid, { ...request, referenceAssetId: 'foreign' }, 'foreign-key-123', null, 'key'), { code: 'reference_not_found' });
const original = documents.get(`mediaGenerations/${replacement.id}`)!;
documents.set(`mediaGenerations/${replacement.id}`, { ...original, durationSeconds: 38 });
await assert.rejects(server.submitVideo(uid, { ...nextBody, fromGenerationId: replacement.id }, 'limit-key-12345', first.itemId, 'key'), { code: 'sequence_limit' });
documents.set(`mediaGenerations/${replacement.id}`, original);
// A receipt survived a process crash: retrieval succeeds without another paid create.
const callsBefore = providerCalls; const getsBefore = retrievalCalls;
const recoverId = 'recover-job'; const recoverItem = 'recover-item';
documents.set('mediaGenerations/recover-parent', { ...documents.get(`mediaGenerations/${first.generationId}`), id: 'recover-parent', itemId: recoverItem });
const abandoned = { ...original, id: recoverId, itemId: recoverItem, parentGenerationId: 'recover-parent', clipAssetId: null, status: 'generating', phase: 'downloading', assetId: null, leaseToken: 'old', leaseUntil: 1 };
documents.set(`mediaGenerations/${recoverId}`, abandoned); documents.set(`mediaActivity/${recoverId}`, { ...abandoned, href: `/video/${recoverItem}` });
documents.set(`mediaItems/video_${recoverItem}`, { ...documents.get(`mediaItems/video_${first.itemId}`), id: recoverItem, latestGenerationId: recoverId, latestSuccessfulGenerationId: null, status: 'generating' });
assert.equal((await settled(recoverId)).status, 'ready'); assert.equal(providerCalls, callsBefore); assert.equal(retrievalCalls, getsBefore + 1);
// Crash with no receipt must never repeat a paid POST.
const unknown = { ...abandoned, id: 'unknown-job', interactionId: null, parentGenerationId: null };
documents.set('mediaGenerations/unknown-job', unknown); documents.set('mediaActivity/unknown-job', { ...unknown });
assert.equal((await settled('unknown-job')).status, 'interrupted'); assert.equal(providerCalls, callsBefore);
// Legacy full-result clip extraction includes audio and is cached.
const { loadOwnedAsset } = await import('../../../studio/src/lib/assets-server');
const { videoClipContent } = await import('../../../studio/src/lib/video-assets-server');
const { readMp4Duration } = await import('../../../src/video/mp4-duration');
const fullAsset = await loadOwnedAsset(uid, replacement.assetId!);
const extracted = await videoClipContent(fullAsset, 2, 3, 6, false); assert(Math.abs(readMp4Duration(extracted)! - 3) < 0.1);
assert(extracted.includes(Buffer.from('soun'))); assert.equal((await videoClipContent(fullAsset, 2, 3, 6, false)).length, extracted.length); assert.equal(providerCalls, callsBefore);
const caller = { kind: 'apiKey' as const, uid, keyId: 'key', scopes: ['videos:read' as const] };
const catalog = await listMedia(caller, new URL('https://studio.test/api/v1/media')); assert(catalog.items.every(item => item.type === 'video'));
await assert.rejects(listMedia({ ...caller, scopes: ['images:read'] }, new URL('https://studio.test/api/v1/media?type=video')), { code: 'insufficient_scope' });
// HTTP permissions include the shared generation and asset routes; old keys gain no scopes.
const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const oldKey = generateApiKey(); const videoKey = generateApiKey();
for (const [key, scopes] of [[oldKey, ['images:read']], [videoKey, ['videos:read']]] as const) documents.set(`apiKeys/${key.keyId}`, { ownerUid: uid, ownerEmail: 'owner@example.test', hash: key.hash, scopes, revokedAt: null });
const videosRoute = await import('../../../studio/src/app/api/v1/videos/route');
const historyRoute = await import('../../../studio/src/app/api/v1/videos/[id]/generations/route');
const generationRoute = await import('../../../studio/src/app/api/v1/generations/[id]/route');
const assetRoute = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/assets/route');
const http = (path: string, token = videoKey.token) => new Request(`https://studio.test${path}`, { headers: { Authorization: `Bearer ${token}` } });
assert.equal((await videosRoute.GET(http('/api/v1/videos', 'missing'))).status, 401);
assert.equal((await videosRoute.GET(http('/api/v1/videos', oldKey.token))).status, 403);
assert.equal((await generationRoute.GET(http(`/api/v1/generations/${replacement.id}`, oldKey.token), { params: Promise.resolve({ id: replacement.id }) })).status, 403);
assert.equal((await generationRoute.GET(http(`/api/v1/generations/${replacement.id}`), { params: Promise.resolve({ id: replacement.id }) })).status, 200);
assert.equal((await assetRoute.GET(http(`/api/v1/assets/${fullAsset.id}/content`, oldKey.token), { params: Promise.resolve({ id: fullAsset.id }) })).status, 403);
assert.equal((await assetRoute.GET(http(`/api/v1/assets/${fullAsset.id}/content`), { params: Promise.resolve({ id: fullAsset.id }) })).status, 200);
const historyResponse = await historyRoute.GET(http(`/api/v1/videos/${first.itemId}/generations`), { params: Promise.resolve({ id: first.itemId }) });
assert.equal(historyResponse.status, 200); assert.equal((await historyResponse.json()).items.length, 5);
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer();
const upload = await uploadRoute.POST(new Request('https://studio.test/api/v1/assets?media=video', { method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: png }));
assert.equal(upload.status, 201); assert.equal(documents.get(`mediaAssets/${(await upload.json()).id}`)!.mediaType, 'video');
assert(!JSON.stringify(await server.videoResource(uid, first.itemId, '')).includes('SECRET'));
// Reproduce the reported boundary: 10 -> 20 -> 30 -> 40 seconds using only a 10s source each time.
const longRequest = { ...request, adaptation: { enabled: false, instructions: '' }, output: { ...request.output, durationSeconds: 10 } };
let long = await server.submitVideo(uid, longRequest, 'long-initial-123', null, 'key');
let longJob = await settled(long.generationId);
for (const target of [20, 30, 40]) {
  long = await server.submitVideo(uid, { ...longRequest, action: 'continue', fromGenerationId: longJob.id }, `long-continue-${target}`, long.itemId, 'key');
  longJob = await settled(long.generationId);
  assert.equal(longJob.status, 'ready'); assert(Math.abs(longJob.durationSeconds! - target) < 0.2);
  assert.equal(longJob.clipDurationSeconds, 10); assert.equal(longJob.parentClipDurationSeconds, 10);
  const source = payloads.at(-1).input[0].content[0];
  assert.equal(readMp4Duration(Buffer.from(source.data, 'base64')), 10);
}
assert.equal((await server.videoResource(uid, long.itemId, '')).clips.length, 4);
assert.equal((await server.videoResource(uid, long.itemId, '')).canContinue, false);
// Restart after storing the new clip must assemble locally without even a provider GET.
const recoveryJob = { ...longJob, id: 'clip-recovery', assetId: null, status: 'generating', phase: 'assembling', leaseUntil: 1, leaseToken: 'old' };
documents.set('mediaGenerations/clip-recovery', recoveryJob);
documents.set('mediaActivity/clip-recovery', recoveryJob);
const clip = documents.get(`mediaAssets/${longJob.clipAssetId}`)!;
documents.set('mediaAssets/video_clip-recovery_clip', { ...clip, id: 'video_clip-recovery_clip' });
const beforeRecoveryCalls = providerCalls, beforeRecoveryGets = retrievalCalls;
assert.equal((await settled('clip-recovery')).status, 'ready');
assert.equal(providerCalls, beforeRecoveryCalls); assert.equal(retrievalCalls, beforeRecoveryGets);
// Existing cumulative videos migrate on use: extract their last clip locally, independent of old receipts.
const old20 = [...documents.values()].find(j => j.type === 'video' && j.itemId === long.itemId && j.clipNumber === 2 && j.status === 'ready' && j.request)!;
const old10 = documents.get(`mediaGenerations/${old20.parentGenerationId}`)!;
const legacyId = 'legacy-item';
for (const [id, value, parent] of [['legacy-first', old10, null], ['legacy-second', old20, 'legacy-first']] as const) {
  const { assemblyMode, clipAssetId, clipDurationSeconds, parentClipDurationSeconds, ...legacy } = value;
  documents.set(`mediaGenerations/${id}`, { ...legacy, id, itemId: legacyId, parentGenerationId: parent, interactionId: null });
}
documents.set(`mediaItems/video_${legacyId}`, { ...documents.get(`mediaItems/video_${long.itemId}`), id: legacyId, status: 'ready', latestGenerationId: 'legacy-second', latestSuccessfulGenerationId: 'legacy-second' });
const migrated = await server.submitVideo(uid, { ...longRequest, action: 'continue', fromGenerationId: 'legacy-second' }, 'legacy-continue-123', legacyId, 'key');
const migratedJob = await settled(migrated.generationId);
assert.equal(migratedJob.status, 'ready'); assert(Math.abs(migratedJob.durationSeconds! - 30) < 0.25);
assert(migratedJob.parentClipDurationSeconds! <= 10.25);
assert.equal((await server.videoResource(uid, legacyId, '')).clips.length, 3);
console.log(JSON.stringify({ passed: true, providerCalls, retrievalCalls, assertions: 'concurrent idempotency, tip CAS, regeneration parent, history, scoped assets, receipt and clip recovery without paid retries, latest clip context, 10/20/30/40s local assembly, legacy migration, clip extraction' }));
