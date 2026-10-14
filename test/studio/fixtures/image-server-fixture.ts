// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
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
    return { docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction(run: (tx: any) => Promise<any>) {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = []; let writing = false;
  try { const result = await run({ get: (ref: Ref) => { assert(!writing, 'Read after write in transaction'); return ref.get(); }, set: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.set(data)); }, update: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.update(data)); } }); for (const write of writes) await write(); return result; }
  finally { release(); }
} };
const bucket = { file(path: string) { return { async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); }, async download() { assert(files.has(path), 'Missing storage object'); return [files.get(path)]; } }; } };
const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
let providerCalls = 0;
let failProvider = false;
let holdProvider: Promise<void> | null = null;
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true, verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null, verifyIdToken: async () => null, adminAuth: () => ({}) }));
// Match Studio's resolved engine whether installed locally or through the root workspace link.
const ttsEntry = Bun.resolveSync('mdmedia/tts', fileURLToPath(new URL('../../../studio/src/lib/', import.meta.url)));
mock.module(join(dirname(ttsEntry), 'gemini-client-factory.js'), () => ({ NodeEnvProvider: class {}, createGeminiClient: () => ({ models: { generateContent: async (request: any) => {
  if (request.config.systemInstruction) return { text: 'Prepared visual brief' };
  providerCalls++; if (holdProvider) await holdProvider;
  if (failProvider) throw new Error('network failed with SECRET in its message');
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] };
} } }) }));
process.env.GEMINI_API_KEY = 'test-only-placeholder';
const server = await import('../../../studio/src/lib/image-server');
const { parseImageRequest } = await import('../../../studio/src/lib/image-request');
const { listMedia, listGenerations } = await import('../../../studio/src/lib/media-catalog-server');
const req = parseImageRequest({ prompt: 'Draw a harbor', adaptation: { enabled: true } });
const uid = 'owner';
async function waitFor(id: string, predicate: (job: any) => boolean) {
  for (let i = 0; i < 200; i++) { await server.processImageJobs(); const job = await server.loadImageGeneration(uid, id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${id}: ${JSON.stringify(documents.get(`mediaGenerations/${id}`))}`);
}
// Concurrent duplicate HTTP submissions reserve one attempt and consume one quota slot.
let releaseProvider!: () => void;
holdProvider = new Promise(resolve => { releaseProvider = resolve; });
const accepted = await Promise.all(Array.from({ length: 8 }, () => server.submitImage(uid, req, 'same-key-12345', null, 'key')));
assert.equal(new Set(accepted.map(result => result.generationId)).size, 1);
const first = accepted[0];
await server.processImageJobs(); await waitFor(first.generationId, job => job.phase === 'generating');
assert.equal(providerCalls, 1); assert.equal(documents.get('mediaQuotas/owner')!.active.length, 1);
await assert.rejects(server.submitImage(uid, { ...req, prompt: 'Different' }, 'same-key-12345', null, 'key'), { code: 'idempotency_conflict' });
await assert.rejects(server.loadImageItem('intruder', first.itemId), { code: 'not_found' });
await assert.rejects(server.loadImageGeneration('intruder', first.generationId), { code: 'not_found' });
releaseProvider(); holdProvider = null;
await waitFor(first.generationId, job => job.status === 'ready');
const ready = await server.imageResource(uid, first.itemId, 'https://studio.test');
assert.equal(ready.result!.assets[0].width, 24); assert.equal(ready.result!.preparedPrompt, 'Prepared visual brief');
assert.equal((ready as any).ownerUid, undefined);
assert.equal(documents.get('mediaQuotas/owner')!.active.length, 0);
// Regeneration is a new immutable attempt. Failure preserves the prior successful asset.
failProvider = true;
const next = await server.submitImage(uid, { ...req, prompt: 'New source' }, 'next-key-12345', first.itemId, 'key');
await server.processImageJobs(); await waitFor(next.generationId, job => job.status === 'interrupted');
const failed = await server.imageResource(uid, first.itemId, 'https://studio.test');
assert.equal(failed.result!.id, first.generationId); assert.equal(failed.latestGeneration!.id, next.generationId);
assert(!JSON.stringify(failed).includes('SECRET'));
const replay = await server.submitImage(uid, req, 'same-key-12345', null, 'key'); assert.equal(replay.generationId, first.generationId); assert.equal(providerCalls, 2);
// An expired provider lease is recovered without another paid submission.
const abandoned = { ...documents.get(`mediaGenerations/${next.generationId}`)!, id: 'abandoned', status: 'generating', leaseToken: 'old', leaseUntil: 1, assetId: null };
documents.set('mediaGenerations/abandoned', abandoned); documents.set('mediaActivity/abandoned', { ...abandoned, href: `/image/${first.itemId}` });
await waitFor('abandoned', job => job.status === 'interrupted'); assert.equal(documents.get('mediaGenerations/abandoned')!.status, 'interrupted'); assert.equal(providerCalls, 2);
// Foreign reference IDs and scoped catalog reads never reveal another owner's content.
documents.set('mediaAssets/foreign', { ownerUid: 'intruder' });
await assert.rejects(server.submitImage(uid, { ...req, referenceAssetId: 'foreign' }, 'foreign-key-123', null, 'key'), { code: 'reference_not_found' });
const caller = { kind: 'apiKey' as const, uid, keyId: 'key', scopes: ['images:read' as const] };
const catalog = await listMedia(caller, new URL('https://studio.test/api/v1/media'));
assert.equal(catalog.items.length, 1); assert.equal(catalog.items[0].id, first.itemId);
await assert.rejects(listMedia(caller, new URL('https://studio.test/api/v1/media?type=narration')), { code: 'insufficient_scope' });
// Activity checks source records, so deletion and title/status edits remain visible
// even if an asynchronous catalog checkpoint has not finished yet.
documents.set('mediaCatalogMigrations/owner', { complete: true });
documents.set('mediaActivity/narration_deleted', { id: 'narration_deleted', itemId: 'deleted', ownerUid: uid, type: 'narration', title: 'Deleted', status: 'ready', createdAt: 1 });
documents.set('mediaActivity/narration_live', { id: 'narration_live', itemId: 'live', ownerUid: uid, type: 'narration', title: 'Old title', status: 'generating', createdAt: 2 });
documents.set('narrations/live', { ownerUid: uid, title: 'New title', status: 'ready', createdAt: 2, updatedAt: 3 });
const narrationCaller = { ...caller, scopes: ['narrations:read' as const] };
const activity = await listGenerations(narrationCaller, new URL('https://studio.test/api/v1/generations'));
assert.equal(activity.items.length, 1); assert.equal(activity.items[0]!.title, 'New title'); assert.equal((activity.items[0] as any).ownerUid, undefined);
assert.equal((await listGenerations(narrationCaller, new URL('https://studio.test/api/v1/generations?status=generating'))).items.length, 0);
const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const oldKey = generateApiKey();
documents.set(`apiKeys/${oldKey.keyId}`, { ownerUid: uid, ownerEmail: 'owner@example.test', hash: oldKey.hash, scopes: ['narrations:read'], revokedAt: null });
const imagesRoute = await import('../../../studio/src/app/api/v1/images/route');
const imageRoute = await import('../../../studio/src/app/api/v1/images/[id]/route');
const assetRoute = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/assets/route');
const createRequest = (token: string, body: any = req) => new Request('https://studio.test/api/v1/images', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key-12345' }, body: JSON.stringify(body) });
assert.equal((await imagesRoute.POST(createRequest('missing'))).status, 401);
assert.equal((await imagesRoute.POST(createRequest(oldKey.token))).status, 403);
assert.equal((await imagesRoute.POST(createRequest('test-session', { prompt: 'draw', provider: 'openai' }))).status, 400);
const replayResponse = await imagesRoute.POST(createRequest('test-session'));
assert.equal(replayResponse.status, 202);
assert.equal((await replayResponse.json()).generation.id, first.generationId);
assert.equal(providerCalls, 2);
assert.equal((await imageRoute.GET(new Request('https://studio.test/api/v1/images/other', { headers: { Authorization: 'Bearer test-session' } }), { params: Promise.resolve({ id: 'other' }) })).status, 404);
assert.equal((await assetRoute.GET(new Request('https://studio.test/api/v1/assets/foreign/content', { headers: { Authorization: 'Bearer test-session' } }), { params: Promise.resolve({ id: 'foreign' }) })).status, 404);
assert.equal((await uploadRoute.POST(new Request('https://studio.test/api/v1/assets', { method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: 'not-an-image' }))).status, 400);
console.log(JSON.stringify({ passed: true, providerCalls, assertions: 'concurrent idempotency, ownership, immutable versions, failure retention, storage metadata, interruption recovery, scoped catalog' }));
