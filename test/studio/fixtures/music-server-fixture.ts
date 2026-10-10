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

const directory = await mkdtemp(join(tmpdir(), 'mdmedia-music-test-'));
let bytes: Buffer;
try {
  const path = join(directory, 'test.wav');
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '3', path]);
  bytes = await readFile(path);
} finally { await rm(directory, { recursive: true, force: true }); }
let providerCalls = 0, retrievalCalls = 0;
let hold: Promise<void> | null = null, release!: () => void;
let failure = false;
const payloads: any[] = [];
const client = { models: { generateContent: async () => ({ text: 'Prepared musical direction' }) }, interactions: {
  async create(payload: any, options: any) {
    providerCalls++; payloads.push(payload); assert.equal(options.maxRetries, 0); if (hold) await hold;
    if (failure) throw Object.assign(new Error('SECRET rejected prompt'), { status: 400 });
    return { id: `receipt-${providerCalls}`, output_audio: { data: bytes.toString('base64'), mime_type: 'audio/wav' }, output_text: '[Verse]\nHello' };
  },
  async get() { retrievalCalls++; return { output_audio: { data: bytes.toString('base64'), mime_type: 'audio/wav' }, output_text: '[Verse]\nRecovered' }; },
} };
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));
const ttsEntry = Bun.resolveSync('mdmedia/tts', fileURLToPath(new URL('../../../studio/src/lib/', import.meta.url)));
mock.module(join(dirname(ttsEntry), 'gemini-client-factory.js'), () => ({ NodeEnvProvider: class {}, createGeminiClient: () => client }));
process.env.GEMINI_API_KEY = 'test-only-placeholder';
const server = await import('../../../studio/src/lib/music-server');
const { parseMusicRequest } = await import('../../../studio/src/lib/music-request');
const { listMedia, listGenerations } = await import('../../../studio/src/lib/media-catalog-server');
const uid = 'owner';
const request = parseMusicRequest({ prompt: 'Gentle piano', adaptation: { enabled: true } });
async function waitFor(id: string, predicate: (job: any) => boolean) {
  for (let i = 0; i < 1500; i++) { await server.processMusicJobs(); const job = await server.loadMusicGeneration(uid, id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${id}`);
}
const settled = (id: string) => waitFor(id, job => !['queued', 'generating'].includes(job.status));
hold = new Promise(resolve => { release = resolve; });
const duplicates = await Promise.all(Array.from({ length: 8 }, () => server.submitMusic(uid, request, 'music-key-initial', null, 'key')));
assert.equal(new Set(duplicates.map(a => a.generationId)).size, 1);
const first = duplicates[0]; await waitFor(first.generationId, job => job.phase === 'generating');
assert.equal(providerCalls, 1);
await assert.rejects(server.submitMusic(uid, request, 'distinct-pending-key', first.itemId, 'key'), { code: 'generation_in_progress' });
await assert.rejects(server.submitMusic(uid, { ...request, prompt: 'Changed' }, 'music-key-initial', null, 'key'), { code: 'idempotency_conflict' });
await assert.rejects(server.loadMusicItem('other', first.itemId), { code: 'not_found' });
await assert.rejects(server.loadMusicGeneration('other', first.generationId), { code: 'not_found' });
const imageServer = await import('../../../studio/src/lib/image-server');
await imageServer.processImageJobs(); assert.equal(providerCalls, 1);
release(); hold = null; const initial = await settled(first.generationId); assert.equal(initial.status, 'ready');
const ready = await server.musicResource(uid, first.itemId, 'https://studio.test');
assert.equal(ready.result!.model, 'lyria-3.5'); assert.equal(ready.result!.preparedPrompt, 'Prepared musical direction');
assert(Math.abs(ready.result!.durationSeconds! - 3) < 0.1); assert.equal(ready.result!.waveform.length, 256);
assert(ready.result!.waveform.some(p => p > 0)); assert.equal(ready.result!.assets[0].mimeType, 'audio/mpeg');
assert.equal(ready.result!.lyrics, '[Verse]\nHello');
const replayed = await server.submitMusic(uid, request, 'music-key-initial', null, 'key');
assert.equal(replayed.generationId, first.generationId); assert.equal(providerCalls, 1);
const publicJson = JSON.stringify(ready); for (const secret of ['receipt-', 'ownerUid', 'storage', 'leaseToken']) assert(!publicJson.includes(secret));
const wav = await server.submitMusic(uid, parseMusicRequest({ prompt: 'New take', output: { mode: 'clip', format: 'wav' }, vocals: 'vocals', lyrics: '[Verse]\nUse these words' }), 'music-key-version', first.itemId, 'key');
assert.equal((await settled(wav.generationId)).status, 'ready');
const next = await server.musicResource(uid, first.itemId, ''); assert.equal(next.result!.assets[0].mimeType, 'audio/wav');
assert.equal(payloads.at(-1).model, 'lyria-3-clip-preview'); assert(!payloads.at(-1).response_format);
assert(payloads.at(-1).input.includes('Use these words'));
failure = true;
const failed = await server.submitMusic(uid, request, 'music-key-failed', first.itemId, 'key');
assert.equal((await settled(failed.generationId)).status, 'error'); failure = false;
assert.equal((await server.musicResource(uid, first.itemId, '')).result!.id, wav.generationId);
assert(!JSON.stringify(await server.musicResource(uid, first.itemId, '')).includes('SECRET'));
// Receipt recovery has no paid POST, and unknown outcomes never auto-regenerate.
const before = providerCalls;
const abandoned = { ...initial, id: 'recover', itemId: 'recover-item', status: 'generating', phase: 'downloading', assetId: null, leaseToken: 'old', leaseUntil: 1 };
documents.set('mediaGenerations/recover', abandoned); documents.set('mediaActivity/recover', abandoned);
documents.set('mediaItems/music_recover-item', { ...documents.get(`mediaItems/music_${first.itemId}`), id: 'recover-item', latestGenerationId: 'recover', latestSuccessfulGenerationId: null });
assert.equal((await settled('recover')).status, 'ready'); assert.equal(providerCalls, before); assert.equal(retrievalCalls, 1);
const unknown = { ...abandoned, id: 'unknown', interactionId: null };
documents.set('mediaGenerations/unknown', unknown); documents.set('mediaActivity/unknown', unknown);
assert.equal((await settled('unknown')).status, 'interrupted'); assert.equal(providerCalls, before);
const stored = { ...abandoned, id: 'stored' };
documents.set('mediaGenerations/stored', stored); documents.set('mediaActivity/stored', stored);
documents.set('mediaAssets/music_stored', { ...documents.get(`mediaAssets/${initial.assetId}`), id: 'music_stored' });
assert.equal((await settled('stored')).status, 'ready'); assert.equal(providerCalls, before); assert.equal(retrievalCalls, 1);
const quota = structuredClone(documents.get('mediaQuotas/music_owner')!);
documents.set('mediaQuotas/music_owner', { ...quota, active: ['a', 'b', 'c'] });
await assert.rejects(server.submitMusic(uid, request, 'quota-music-key-123', null, 'key'), { code: 'too_many_in_progress' });
documents.set('mediaQuotas/music_owner', { ...quota, hourly: { key: { since: Date.now(), count: 30 } } });
await assert.rejects(server.submitMusic(uid, request, 'rate-music-key-1234', null, 'key'), { code: 'rate_limited' });
documents.set('mediaQuotas/music_owner', quota); assert.equal(providerCalls, before);
// Reference ownership, purpose and medium validation precede all paid work.
for (const [id, asset] of [['foreign', { ownerUid: 'other', mediaType: 'music' }], ['video-ref', { ownerUid: uid, mediaType: 'video' }], ['output-ref', { ownerUid: uid, mediaType: 'music', purpose: 'output' }]] as const) {
 documents.set(`mediaAssets/${id}`, { purpose: 'reference', mimeType: 'image/png', ...asset });
 await assert.rejects(server.submitMusic(uid, { ...request, referenceAssetId: id }, `reference-${id}`, null, 'key'), { code: 'reference_not_found' });
}
const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const oldKey = generateApiKey(), musicKey = generateApiKey();
for (const [key, scopes] of [[oldKey, ['images:read']], [musicKey, ['music:read', 'music:create', 'options:read']]] as const) documents.set(`apiKeys/${key.keyId}`, { ownerUid: uid, ownerEmail: 'owner@example.test', hash: key.hash, scopes, revokedAt: null });
const http = (path: string, token = musicKey.token) => new Request(`https://studio.test${path}`, { headers: { Authorization: `Bearer ${token}` } });
const musicRoute = await import('../../../studio/src/app/api/v1/music/route');
const generationRoute = await import('../../../studio/src/app/api/v1/generations/[id]/route');
const assetRoute = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const historyRoute = await import('../../../studio/src/app/api/v1/music/[id]/generations/route');
const itemRoute = await import('../../../studio/src/app/api/v1/music/[id]/route');
const optionsRoute = await import('../../../studio/src/app/api/v1/options/route');
assert.equal((await musicRoute.GET(http('/api/v1/music', 'missing'))).status, 401);
assert.equal((await musicRoute.GET(http('/api/v1/music', oldKey.token))).status, 403);
assert.equal((await generationRoute.GET(http(`/api/v1/generations/${initial.id}`, oldKey.token), { params: Promise.resolve({ id: initial.id }) })).status, 403);
assert.equal((await generationRoute.GET(http(`/api/v1/generations/${initial.id}`), { params: Promise.resolve({ id: initial.id }) })).status, 200);
const assetId = next.result!.assets[0].id;
assert.equal((await assetRoute.GET(http(`/api/v1/assets/${assetId}/content`, oldKey.token), { params: Promise.resolve({ id: assetId }) })).status, 403);
const download = await assetRoute.GET(http(`/api/v1/assets/${assetId}/content`), { params: Promise.resolve({ id: assetId }) });
assert.equal(download.status, 200); assert.equal(download.headers.get('Content-Type'), 'audio/wav');
assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
const mp3Download = await assetRoute.GET(http(`/api/v1/assets/${ready.result!.assets[0].id}/content?download=1`), { params: Promise.resolve({ id: ready.result!.assets[0].id }) });
assert(mp3Download.headers.get('Content-Disposition')!.endsWith('.mp3"'));
const history = await historyRoute.GET(http(`/api/v1/music/${first.itemId}/generations`), { params: Promise.resolve({ id: first.itemId }) });
assert.equal(history.status, 200); assert.equal((await history.json()).items.length, 3);
const patch = new Request(`https://studio.test/api/v1/music/${first.itemId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${musicKey.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Music acceptance' }) });
assert.equal((await itemRoute.PATCH(patch, { params: Promise.resolve({ id: first.itemId }) })).status, 200);
const caller = { kind: 'apiKey' as const, uid, keyId: musicKey.keyId, scopes: ['music:read' as const] };
assert((await listMedia(caller, new URL('https://studio.test/api/v1/media'))).items.every(j => j.type === 'music'));
assert((await listGenerations(caller, new URL('https://studio.test/api/v1/generations'))).items.every(j => j.type === 'music'));
const options = await optionsRoute.GET(http('/api/v1/options?media=music')); assert.equal(options.status, 200);
assert.equal((await options.json()).capabilities.continuation, false);
const uploadRoute = await import('../../../studio/src/app/api/v1/assets/route');
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#334455' } }).png().toBuffer();
const upload = await uploadRoute.POST(new Request('https://studio.test/api/v1/assets?media=music', { method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: png }));
assert.equal(upload.status, 201); const referenceId = (await upload.json()).id;
const reference = await server.submitMusic(uid, parseMusicRequest({ prompt: 'Inspired by this image', referenceAssetId: referenceId, vocals: 'vocals', lyrics: 'Keep my words', adaptation: { enabled: true } }), 'music-reference-success', null, 'key');
assert.equal((await settled(reference.generationId)).status, 'ready');
assert.equal(payloads.at(-1).input[0].type, 'image'); assert.equal(payloads.at(-1).input[0].mime_type, 'image/png');
assert(payloads.at(-1).input.at(-1).text.includes('Prepared musical direction')); assert(payloads.at(-1).input.at(-1).text.includes('Keep my words'));
assert.equal((await assetRoute.GET(http(`/api/v1/assets/${referenceId}/content`, oldKey.token), { params: Promise.resolve({ id: referenceId }) })).status, 403);
console.log(JSON.stringify({ passed: true, providerCalls, retrievalCalls }));
