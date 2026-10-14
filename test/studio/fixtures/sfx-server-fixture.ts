// Executed in an isolated process so SDK and fetch mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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

const directory = await mkdtemp(join(tmpdir(), 'mdmedia-sfx-test-'));
let mp3: Buffer, pcm: Buffer;
try {
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', join(directory, 'test.mp3')]);
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '2', '-ac', '1', '-f', 's16le', join(directory, 'test.pcm')]);
  mp3 = await readFile(join(directory, 'test.mp3')); pcm = await readFile(join(directory, 'test.pcm'));
} finally { await rm(directory, { recursive: true, force: true }); }
let providerCalls = 0;
let hold: Promise<void> | null = null, release!: () => void;
let failure: number | null = null, respond: Buffer | null = null;
const calls: Array<{ url: URL; key: string | null; body: any }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)); assert(url.pathname.endsWith('/v1/sound-generation'));
  providerCalls++; calls.push({ url, key: new Headers(init?.headers).get('xi-api-key'), body: JSON.parse(String(init?.body)) }); if (hold) await hold;
  if (failure) return new Response('SECRET rejected prompt', { status: failure });
  return new Response(respond ?? (url.searchParams.get('output_format')?.startsWith('pcm_') ? pcm : mp3), { status: 200 });
}) as typeof fetch;
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));
// Studio's own sharp, so a thumbnail can fail once after ElevenLabs has been paid.
const realSharp = sharp; let sharpFailures = 0;
mock.module(Bun.resolveSync('sharp', fileURLToPath(new URL('../../../studio/src/lib/', import.meta.url))), () => ({ default: (input: Buffer) => {
  if (sharpFailures > 0) { sharpFailures--; throw new Error('Thumbnail failed'); }
  return realSharp(input);
} }));
process.env.ELEVENLABS_API_KEY = 'test-eleven-placeholder'; delete process.env.ELEVEN_LABS_KEY;
const server = await import('../../../studio/src/lib/sfx-server');
const { parseSfxRequest } = await import('../../../studio/src/lib/sfx-request');
const { listMedia, listGenerations } = await import('../../../studio/src/lib/media-catalog-server');
const uid = 'owner';
const request = parseSfxRequest({ prompt: 'Heavy wooden door creaks open' });
async function waitFor(id: string, predicate: (job: any) => boolean) {
  for (let i = 0; i < 1500; i++) { await server.processSfxJobs(); const job = await server.loadSfxGeneration(uid, id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${id}`);
}
const settled = (id: string) => waitFor(id, job => !['queued', 'generating'].includes(job.status));
hold = new Promise(resolve => { release = resolve; });
const duplicates = await Promise.all(Array.from({ length: 8 }, () => server.submitSfx(uid, request, 'sfx-key-initial', null, 'key')));
assert.equal(new Set(duplicates.map(a => a.generationId)).size, 1);
const first = duplicates[0]; await waitFor(first.generationId, job => job.phase === 'generating');
assert.equal(providerCalls, 1);
await assert.rejects(server.submitSfx(uid, request, 'distinct-pending-key', first.itemId, 'key'), { code: 'generation_in_progress' });
await assert.rejects(server.submitSfx(uid, { ...request, prompt: 'Changed' }, 'sfx-key-initial', null, 'key'), { code: 'idempotency_conflict' });
await assert.rejects(server.loadSfxItem('other', first.itemId), { code: 'not_found' });
await assert.rejects(server.loadSfxGeneration('other', first.generationId), { code: 'not_found' });
const musicServer = await import('../../../studio/src/lib/music-server');
await musicServer.processMusicJobs(); assert.equal(providerCalls, 1);
release(); hold = null; const initial = await settled(first.generationId); assert.equal(initial.status, 'ready');
assert.equal(calls[0].key, 'test-eleven-placeholder'); assert.equal(calls[0].url.searchParams.get('output_format'), 'mp3_44100_128');
assert.deepEqual(calls[0].body, { text: 'Heavy wooden door creaks open', model_id: 'eleven_text_to_sound_v2', prompt_influence: 0.3, loop: false });
const ready = await server.sfxResource(uid, first.itemId, 'https://studio.test');
assert.equal(ready.type, 'sfx'); assert.equal(ready.href, '/library'); assert.equal(ready.links.web, 'https://studio.test/library');
assert.equal(ready.links.generations, `https://studio.test/api/v1/sfx/${first.itemId}/generations`);
assert.equal(ready.result!.provider, 'elevenlabs'); assert.equal(ready.result!.model, 'eleven_text_to_sound_v2');
assert.equal(ready.result!.preparedPrompt, 'Heavy wooden door creaks open'); assert.equal(ready.result!.links.web, 'https://studio.test/library');
assert(Math.abs(ready.result!.durationSeconds! - 2) < 0.1); assert.equal(ready.result!.waveform.length, 256);
assert(ready.result!.waveform.some(p => p > 0)); assert.equal(ready.result!.assets[0].mimeType, 'audio/mpeg');
assert.equal(ready.result!.assets[0].id, `sfx_${first.generationId}`); assert(ready.durationMs > 1900);
const replayed = await server.submitSfx(uid, request, 'sfx-key-initial', null, 'key');
assert.equal(replayed.generationId, first.generationId); assert(replayed.replayed); assert.equal(providerCalls, 1);
const publicJson = JSON.stringify(ready); for (const secret of ['test-eleven', 'ownerUid', 'storage', 'leaseToken']) assert(!publicJson.includes(secret));
// A new attempt sends only what changes; the saved prompt carries over.
const item = await server.loadSfxItem(uid, first.itemId);
const wav = await server.submitSfx(uid, parseSfxRequest({ output: { format: 'wav', durationSeconds: 2, loop: true }, promptInfluence: 0.9 }, item.request), 'sfx-key-version', first.itemId, 'key');
assert.equal((await settled(wav.generationId)).status, 'ready');
assert.equal(calls.at(-1)!.url.searchParams.get('output_format'), 'pcm_44100');
assert.deepEqual(calls.at(-1)!.body, { text: 'Heavy wooden door creaks open', model_id: 'eleven_text_to_sound_v2', duration_seconds: 2, prompt_influence: 0.9, loop: true });
const next = await server.sfxResource(uid, first.itemId, ''); assert.equal(next.result!.assets[0].mimeType, 'audio/wav');
assert.equal(next.request.output.format, 'wav');
failure = 400;
const failed = await server.submitSfx(uid, request, 'sfx-key-failed', first.itemId, 'key');
const rejected = await settled(failed.generationId); assert.equal(rejected.status, 'error'); assert.equal(rejected.error.code, 'provider_rejected');
assert.equal((await server.sfxResource(uid, first.itemId, '')).result!.id, wav.generationId);
assert(!JSON.stringify(await server.sfxResource(uid, first.itemId, '')).includes('SECRET'));
// Every ElevenLabs 4xx is a refusal, including ones outside the common set such as 402 for exhausted credit.
failure = 402;
const unpaid = await server.submitSfx(uid, request, 'sfx-key-unpaid', null, 'key');
const refused = await settled(unpaid.generationId); assert.equal(refused.status, 'error'); assert.equal(refused.error.code, 'provider_rejected');
// A server failure has no receipt to retrieve: one call, no retry, explicit interruption.
failure = 500; const before500 = providerCalls;
const broken = await server.submitSfx(uid, request, 'sfx-key-server-error', first.itemId, 'key');
const interrupted = await settled(broken.generationId); assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.error.code, 'generation_interrupted');
assert.equal(providerCalls, before500 + 1); failure = null;
// Paid audio is stored before decoding, so a failed thumbnail finishes from storage without another call.
sharpFailures = 1; const beforeThumbnail = providerCalls;
const thumbnailFailed = await server.submitSfx(uid, request, 'sfx-key-thumbnail', null, 'key');
const thumbnailed = await settled(thumbnailFailed.generationId); assert.equal(thumbnailed.status, 'ready'); assert.equal(sharpFailures, 0);
assert.equal(providerCalls, beforeThumbnail + 1); assert(files.get(`media/${uid}/sfx_${thumbnailFailed.generationId}/original`)!.equals(mp3));
assert(Math.abs((await server.sfxResource(uid, thumbnailFailed.itemId, '')).result!.durationSeconds! - 2) < 0.1);
// Audio that cannot be decoded, even from storage, ends as an error rather than an unknown outcome.
respond = Buffer.from('not audio');
const undecodable = await server.submitSfx(uid, request, 'sfx-key-undecodable', null, 'key');
const garbled = await settled(undecodable.generationId); assert.equal(garbled.status, 'error'); assert.equal(garbled.error.code, 'invalid_sfx');
assert.equal(providerCalls, beforeThumbnail + 2); respond = null;
// Recovery finishes from saved output and never makes a new paid call.
const before = providerCalls;
const abandoned = { ...initial, id: 'recover', itemId: 'recover-item', status: 'generating', phase: 'generating', assetId: null, leaseToken: 'old', leaseUntil: 1 };
documents.set('mediaGenerations/recover', abandoned); documents.set('mediaActivity/recover', abandoned);
documents.set('mediaItems/sfx_recover-item', { ...documents.get(`mediaItems/sfx_${first.itemId}`), id: 'recover-item', latestGenerationId: 'recover', latestSuccessfulGenerationId: null });
files.set(`media/${uid}/sfx_recover/original`, mp3);
assert.equal((await settled('recover')).status, 'ready'); assert.equal(providerCalls, before);
assert.equal((await server.sfxResource(uid, 'recover-item', '')).result!.id, 'recover');
const unknown = { ...abandoned, id: 'unknown' };
documents.set('mediaGenerations/unknown', unknown); documents.set('mediaActivity/unknown', unknown);
assert.equal((await settled('unknown')).status, 'interrupted'); assert.equal(providerCalls, before);
const garbage = { ...abandoned, id: 'garbage' };
documents.set('mediaGenerations/garbage', garbage); documents.set('mediaActivity/garbage', garbage);
files.set(`media/${uid}/sfx_garbage/original`, Buffer.from('not audio'));
const unreadable = await settled('garbage'); assert.equal(unreadable.status, 'error'); assert.equal(unreadable.error.code, 'invalid_sfx'); assert.equal(providerCalls, before);
const stored = { ...abandoned, id: 'stored' };
documents.set('mediaGenerations/stored', stored); documents.set('mediaActivity/stored', stored);
documents.set('mediaAssets/sfx_stored', { ...documents.get(`mediaAssets/${initial.assetId}`), id: 'sfx_stored' });
assert.equal((await settled('stored')).status, 'ready'); assert.equal(providerCalls, before);
const quota = structuredClone(documents.get('mediaQuotas/sfx_owner')!);
assert.deepEqual(quota.active, []);
documents.set('mediaQuotas/sfx_owner', { ...quota, active: ['a', 'b', 'c'] });
await assert.rejects(server.submitSfx(uid, request, 'quota-sfx-key-1234', null, 'key'), { code: 'too_many_in_progress' });
documents.set('mediaQuotas/sfx_owner', { ...quota, hourly: { key: { since: Date.now(), count: 30 } } });
await assert.rejects(server.submitSfx(uid, request, 'rate-sfx-key-12345', null, 'key'), { code: 'rate_limited' });
documents.set('mediaQuotas/sfx_owner', quota);
delete process.env.ELEVENLABS_API_KEY;
await assert.rejects(server.submitSfx(uid, request, 'unconfigured-sfx-key', null, 'key'), { code: 'provider_unavailable' });
// A key removed after acceptance fails the queued attempt as unavailable, not as an unknown outcome.
const beforeUnconfigured = providerCalls;
const unconfigured = { ...initial, id: 'unconfigured', itemId: 'unconfigured-item', status: 'queued', phase: 'queued', assetId: null, leaseToken: null, leaseUntil: 0 };
documents.set('mediaGenerations/unconfigured', unconfigured); documents.set('mediaActivity/unconfigured', unconfigured);
documents.set('mediaItems/sfx_unconfigured-item', { ...documents.get(`mediaItems/sfx_${first.itemId}`), id: 'unconfigured-item', status: 'queued', latestGenerationId: 'unconfigured', latestSuccessfulGenerationId: null });
const unavailable = await settled('unconfigured'); assert.equal(unavailable.status, 'error'); assert.equal(unavailable.error.code, 'provider_unavailable');
assert.equal(providerCalls, beforeUnconfigured); assert.equal(documents.get('mediaItems/sfx_unconfigured-item')!.status, 'error');
process.env.ELEVEN_LABS_KEY = 'test-eleven-legacy';
const legacy = await server.submitSfx(uid, request, 'legacy-sfx-key-1234', null, 'key');
assert.equal((await settled(legacy.generationId)).status, 'ready'); assert.equal(calls.at(-1)!.key, 'test-eleven-legacy');
const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const musicKey = generateApiKey(), sfxKey = generateApiKey();
for (const [key, scopes] of [[musicKey, ['music:read', 'music:create', 'options:read']], [sfxKey, ['sfx:read', 'sfx:create', 'options:read']]] as const) documents.set(`apiKeys/${key.keyId}`, { ownerUid: uid, ownerEmail: 'owner@example.test', hash: key.hash, scopes, revokedAt: null });
const http = (path: string, token = sfxKey.token, init: RequestInit = {}) => new Request(`https://studio.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
const sfxRoute = await import('../../../studio/src/app/api/v1/sfx/route');
const generationRoute = await import('../../../studio/src/app/api/v1/generations/[id]/route');
const assetRoute = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const historyRoute = await import('../../../studio/src/app/api/v1/sfx/[id]/generations/route');
const itemRoute = await import('../../../studio/src/app/api/v1/sfx/[id]/route');
const optionsRoute = await import('../../../studio/src/app/api/v1/options/route');
const params = (id: string) => ({ params: Promise.resolve({ id }) });
assert.equal((await sfxRoute.GET(http('/api/v1/sfx', 'missing'))).status, 401);
assert.equal((await sfxRoute.GET(http('/api/v1/sfx', musicKey.token))).status, 403);
const listed = await sfxRoute.GET(http('/api/v1/sfx')); assert.equal(listed.status, 200);
const page = await listed.json(); assert(page.items.length >= 3 && page.items.every((entry: { type: string }) => entry.type === 'sfx')); assert.equal(page.indexing, false);
const body = { prompt: 'Glass shatters', output: { durationSeconds: 1.5 } };
assert.equal((await sfxRoute.POST(http('/api/v1/sfx', sfxKey.token, { method: 'POST', body: JSON.stringify(body) }))).status, 400);
assert.equal((await sfxRoute.POST(http('/api/v1/sfx', sfxKey.token, { method: 'POST', headers: { 'Idempotency-Key': 'route-sfx-key-1' }, body: JSON.stringify({ ...body, lyrics: 'x' }) }))).status, 400);
assert.equal((await sfxRoute.POST(http('/api/v1/sfx', musicKey.token, { method: 'POST', headers: { 'Idempotency-Key': 'route-sfx-key-1' }, body: JSON.stringify(body) }))).status, 403);
const created = await sfxRoute.POST(http('/api/v1/sfx', sfxKey.token, { method: 'POST', headers: { 'Idempotency-Key': 'route-sfx-key-1' }, body: JSON.stringify(body) }));
assert.equal(created.status, 202); const accepted = await created.json();
assert.equal(accepted.type, 'sfx'); assert.equal(accepted.replayed, false); assert.equal(created.headers.get('Location'), `https://studio.test/api/v1/sfx/${accepted.id}`);
assert.deepEqual(accepted.generation.request, { prompt: 'Glass shatters', output: { format: 'mp3', durationSeconds: 1.5, loop: false }, promptInfluence: 0.3 });
assert.equal((await settled(accepted.generation.id)).status, 'ready');
const attempt = await historyRoute.POST(http(`/api/v1/sfx/${accepted.id}/generations`, sfxKey.token, { method: 'POST', headers: { 'Idempotency-Key': 'route-sfx-key-2' }, body: JSON.stringify({ promptInfluence: 0.5 }) }), params(accepted.id));
assert.equal(attempt.status, 202); const retried = await attempt.json();
assert.equal(retried.generation.request.prompt, 'Glass shatters'); assert.equal(retried.generation.request.output.durationSeconds, 1.5); assert.equal(retried.generation.request.promptInfluence, 0.5);
assert.equal((await settled(retried.generation.id)).status, 'ready');
const fetched = await itemRoute.GET(http(`/api/v1/sfx/${accepted.id}`), params(accepted.id));
assert.equal(fetched.status, 200); assert.equal((await fetched.json()).latestGenerationId, retried.generation.id);
assert.equal((await itemRoute.GET(http(`/api/v1/sfx/${accepted.id}`, musicKey.token), params(accepted.id))).status, 403);
assert.equal((await itemRoute.GET(http('/api/v1/sfx/missing'), params('missing'))).status, 404);
assert.equal((await generationRoute.GET(http(`/api/v1/generations/${initial.id}`, musicKey.token), params(initial.id))).status, 403);
const generation = await generationRoute.GET(http(`/api/v1/generations/${initial.id}`), params(initial.id));
assert.equal(generation.status, 200); assert.equal((await generation.json()).type, 'sfx');
const assetId = next.result!.assets[0].id;
assert.equal((await assetRoute.GET(http(`/api/v1/assets/${assetId}/content`, musicKey.token), params(assetId))).status, 403);
const download = await assetRoute.GET(http(`/api/v1/assets/${assetId}/content`), params(assetId));
assert.equal(download.status, 200); assert.equal(download.headers.get('Content-Type'), 'audio/wav');
assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
const thumbnail = await assetRoute.GET(http(`/api/v1/assets/${assetId}/content?thumbnail=1`), params(assetId));
assert.equal(thumbnail.headers.get('Content-Type'), 'image/webp');
const mp3Download = await assetRoute.GET(http(`/api/v1/assets/${ready.result!.assets[0].id}/content?download=1`), params(ready.result!.assets[0].id));
assert.equal(mp3Download.headers.get('Content-Type'), 'audio/mpeg'); assert(mp3Download.headers.get('Content-Disposition')!.endsWith('.mp3"'));
const history = await historyRoute.GET(http(`/api/v1/sfx/${first.itemId}/generations`), params(first.itemId));
assert.equal(history.status, 200); const versions = await history.json();
assert.equal(versions.items.length, 4); assert.equal(versions.nextCursor, null); assert.equal(versions.items[0].id, broken.generationId);
const patch = await itemRoute.PATCH(http(`/api/v1/sfx/${first.itemId}`, sfxKey.token, { method: 'PATCH', body: JSON.stringify({ title: 'Door acceptance' }) }), params(first.itemId));
assert.equal(patch.status, 200); assert.equal((await patch.json()).title, 'Door acceptance');
assert.equal((await itemRoute.PATCH(http(`/api/v1/sfx/${first.itemId}`, sfxKey.token, { method: 'PATCH', body: JSON.stringify({ title: '' }) }), params(first.itemId))).status, 400);
const caller = { kind: 'apiKey' as const, uid, keyId: sfxKey.keyId, scopes: ['sfx:read' as const] };
assert((await listMedia(caller, new URL('https://studio.test/api/v1/media'))).items.every(j => j.type === 'sfx'));
const activity = await listGenerations(caller, new URL('https://studio.test/api/v1/generations'));
assert(activity.items.length && activity.items.every(j => j.type === 'sfx'));
assert.equal(activity.items.find(j => j.itemId === first.itemId)!.title, 'Door acceptance');
const musicCaller = { kind: 'apiKey' as const, uid, keyId: musicKey.keyId, scopes: ['music:read' as const] };
assert(!(await listMedia(musicCaller, new URL('https://studio.test/api/v1/media'))).items.some(j => j.type === 'sfx'));
await assert.rejects(listMedia(musicCaller, new URL('https://studio.test/api/v1/media?type=sfx')), { code: 'insufficient_scope' });
const options = await optionsRoute.GET(http('/api/v1/options?media=sfx')); assert.equal(options.status, 200);
const described = await options.json();
assert.deepEqual({ ...described, defaults: undefined }, { type: 'sfx', available: true, provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', defaults: undefined,
  capabilities: { formats: ['mp3', 'wav'], durationSeconds: { min: 0.5, max: 30 }, promptInfluence: { min: 0, max: 1 }, loop: true }, limits: { promptCharacters: 4000 }, visibility: ['private'] });
assert.deepEqual(described.defaults, { prompt: '', output: { format: 'mp3', durationSeconds: null, loop: false }, promptInfluence: 0.3 });
console.log(JSON.stringify({ passed: true, providerCalls }));
