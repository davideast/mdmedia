// Executed in an isolated process so SDK mocks cannot affect other tests. The in-memory Firestore and Storage are productions-server-fixture.ts's.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import sharp from 'sharp';

type Data = Record<string, unknown>;
type Sortable = string | number;
const documents = new Map<string, Data>();
const files = new Map<string, Buffer>();
let sequence = 0;
let transactionTail = Promise.resolve();
class Ref {
  constructor(readonly path: string) {}
  get id() { return this.path.split('/').at(-1)!; }
  async get() { const data = documents.get(this.path); return { ref: this, id: this.id, exists: !!data, data: () => data ? structuredClone(data) : undefined }; }
  async set(data: Data) { documents.set(this.path, structuredClone(data)); }
  async update(patch: Data) { assert(documents.has(this.path), `Missing ${this.path}`); documents.set(this.path, { ...documents.get(this.path), ...structuredClone(patch) }); }
  async delete() { documents.delete(this.path); }
}
interface Transaction { get(ref: Ref): ReturnType<Ref['get']>; set(ref: Ref, data: Data): void; update(ref: Ref, data: Data): void; delete(ref: Ref): void }
/** Collections at any depth: `productions/{id}/cuts` lists only that production's cuts. */
class Query {
  constructor(readonly collection: string, readonly filters: Array<[string, string, unknown]> = [], readonly orders: Array<[string, string]> = [], readonly cap = Infinity) {}
  doc(id = `auto${++sequence}`) { return new Ref(`${this.collection}/${id}`); }
  where(field: string, op: string, value: unknown) { return new Query(this.collection, [...this.filters, [field, op, value]], this.orders, this.cap); }
  orderBy(field: string, direction = 'asc') { return new Query(this.collection, this.filters, [...this.orders, [field, direction]], this.cap); }
  limit(cap: number) { return new Query(this.collection, this.filters, this.orders, cap); }
  async get() {
    const depth = this.collection.split('/').length + 1;
    let entries = [...documents.entries()].filter(([path]) => path.startsWith(`${this.collection}/`) && path.split('/').length === depth);
    entries = entries.filter(([, data]) => this.filters.every(([field, op, expected]) => op === '==' && data[field] === expected));
    for (const [field, direction] of [...this.orders].reverse()) entries.sort((a, b) => { const x = a[1][field] as Sortable; const y = b[1][field] as Sortable; return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'desc' ? -1 : 1); });
    return { empty: entries.length === 0, docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = []; let writing = false;
  const write = (step: () => Promise<void>) => { writing = true; writes.push(step); };
  try {
    const result = await run({
      get: (ref: Ref) => { assert(!writing, 'Read after write in transaction'); return ref.get(); },
      set: (ref: Ref, data: Data) => write(() => ref.set(data)),
      update: (ref: Ref, data: Data) => write(() => ref.update(data)),
      delete: (ref: Ref) => write(() => ref.delete()),
    });
    for (const step of writes) await step();
    return result;
  } finally { release(); }
} };
let wholeDownloads = 0;
let streamedReads = 0;
const bucket = { file(path: string) { return {
  async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); },
  async download() { assert(files.has(path), 'Missing storage object'); wholeDownloads++; return [files.get(path)]; },
  async getMetadata() { assert(files.has(path), 'Missing storage object'); return [{ size: String(files.get(path)!.length) }]; },
  async delete() { files.delete(path); },
  createReadStream(range: { start?: number; end?: number } = {}) { streamedReads++; return Readable.from([files.get(path)!.subarray(range.start ?? 0, range.end === undefined ? undefined : range.end + 1)]); },
  // Like Storage: nothing is visible until the stream finishes; a destroyed stream stores nothing.
  createWriteStream() {
    const chunks: Buffer[] = [];
    return new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) { files.set(path, Buffer.concat(chunks)); done(); } });
  },
}; } };
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : header === 'Bearer other-session' ? { uid: 'intruder', email: 'eve@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));

// Media: one PNG still (the same bytes for both characters' stills is fine), and someone else's.
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa3300' } }).png().toBuffer();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const keys = { read: generateApiKey(), write: generateApiKey() };
const scopes = { read: ['productions:read'], write: ['productions:read', 'productions:write'] };
for (const [name, key] of Object.entries(keys)) {
  documents.set(`apiKeys/${key.keyId}`, { ownerUid: 'owner', ownerEmail: 'owner@example.test', hash: key.hash, scopes: scopes[name as keyof typeof scopes], revokedAt: null, lastUsedAt: Date.now() });
}
const list = await import('../../../studio/src/app/api/v1/characters/route');
const one = await import('../../../studio/src/app/api/v1/characters/[id]/route');
const versionRoute = await import('../../../studio/src/app/api/v1/characters/[id]/versions/[version]/route');
const productions = await import('../../../studio/src/app/api/v1/productions/route');
const production = await import('../../../studio/src/app/api/v1/productions/[id]/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/productions/media/[sha256]/route');
const { characterId } = await import('../../../studio/src/lib/characters-server');

const origin = 'https://studio.test';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (method: string, path: string, token: string, body?: unknown) =>
  new Request(`${origin}${path}`, { method, headers: { ...auth(token), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const upload = async (bytes: Buffer, token: string) => (await uploadRoute.PUT(new Request(`${origin}/api/v1/productions/media/${sha(bytes)}?mediaType=image`, { method: 'PUT', headers: { ...auth(token), 'Content-Type': 'image/png' }, body: bytes }), params({ sha256: sha(bytes) }))).json();

const still = await upload(png, keys.write.token);
const theirs = await upload(png, 'other-session');

const rick = {
  format: 'mdmedia.character@1', id: 'rick', version: 1, name: 'Rick', kind: 'person', description: 'The hero of Night Wagon.',
  look: { description: 'a mid-30s man with a big dark mullet', never: ['aviator sunglasses'] },
  media: { root: '~/media' },
  stills: [{ id: 'driving', file: 'characters/rick/driving.png', from: { take: 'nw7-rick-lines-t1', at: 1 } }],
  voice: { provider: 'video-model', uses: ['on-camera'] },
  delivery: { register: 'grim and intense', never: ['never jokes'], reference: null },
  changelog: [{ version: 1, date: '2026-10-20', changes: 'First version.' }],
};
const putVersion = (slug: string, version: string, body: unknown, token = keys.write.token) =>
  versionRoute.PUT(json('PUT', `/api/v1/characters/${slug}/versions/${version}`, token, body), params({ id: slug, version }));

// --- Scopes.
assert.equal((await list.GET(json('GET', '/api/v1/characters', 'missing'))).status, 401);
assert.equal((await putVersion('rick', '1', { character: rick, stills: { driving: still.id } }, keys.read.token)).status, 403);

// --- A version is stored once, and never changes.
const created = await putVersion('rick', '1', { character: rick, stills: { driving: still.id } });
assert.equal(created.status, 201, await created.clone().text());
const v1 = await created.json();
assert.equal(v1.ref, 'rick@1'); assert.equal(v1.id, characterId('owner', 'rick'));
assert.equal(v1.links.stills.driving.content, `${origin}/api/v1/assets/${still.id}/content`);
assert.equal((await putVersion('rick', '1', { character: rick, stills: { driving: still.id } })).status, 200);
const changed = await putVersion('rick', '1', { character: { ...rick, description: 'Someone else.' }, stills: { driving: still.id } });
assert.equal(changed.status, 409); assert.equal((await changed.json()).error.code, 'version_exists');
// A body that isn't the version in the path, a bad file, a missing or foreign still.
assert.equal((await (await putVersion('rick', '2', { character: rick, stills: { driving: still.id } })).json()).error.code, 'invalid_character');
const bad = await putVersion('rick', '1', { character: { ...rick, name: '' }, stills: {} });
assert.equal(bad.status, 422); assert.ok((await bad.json()).error.errors.includes('name: expected non-empty text'));
assert.equal((await (await putVersion('rick', '1', { character: rick, stills: {} })).json()).error.code, 'invalid_stills');
const foreign = await putVersion('rick', '1', { character: rick, stills: { driving: theirs.id } });
assert.equal(foreign.status, 400); assert.deepEqual((await foreign.json()).error.ids, [theirs.id]);

// --- Version 2 joins it; version 1 stays as it was.
const rick2 = { ...rick, version: 2, description: 'The hero, now with a swap voice.', voice: { provider: 'elevenlabs', name: 'Adam', uses: ['swap'] }, changelog: [...rick.changelog, { version: 2, date: '2026-10-21', changes: 'A swap voice.' }] };
assert.equal((await putVersion('rick', '2', { character: rick2, stills: { driving: still.id } })).status, 201);
const listed = await (await list.GET(json('GET', '/api/v1/characters', keys.read.token))).json();
assert.equal(listed.characters.length, 1);
assert.equal(listed.characters[0].latestVersion, 2);
assert.deepEqual(listed.characters[0].versions.map((v: { version: number; changes: string }) => [v.version, v.changes]), [[1, 'First version.'], [2, 'A swap voice.']]);
const bySlug = await (await one.GET(json('GET', '/api/v1/characters/rick', keys.read.token), params({ id: 'rick' }))).json();
assert.equal(bySlug.latest.character.description, 'The hero, now with a swap voice.');
const old = await (await versionRoute.GET(json('GET', `/api/v1/characters/${v1.id}/versions/1`, keys.read.token), params({ id: v1.id, version: '1' }))).json();
assert.equal(old.character.description, 'The hero of Night Wagon.');
assert.equal((await versionRoute.GET(json('GET', '/api/v1/characters/rick/versions/9', keys.read.token), params({ id: 'rick', version: '9' }))).status, 404);
// Someone else sees none of it.
assert.equal((await one.GET(json('GET', '/api/v1/characters/rick', 'other-session'), params({ id: 'rick' }))).status, 404);
assert.equal((await (await list.GET(json('GET', '/api/v1/characters', 'other-session'))).json()).characters.length, 0);

// --- A production's cast links roles to versions, with what a page shows.
const createBody = { slug: 'night-wagon', title: 'Night Wagon', cast: [{ role: 'Rick', character: 'rick@1' }] };
const made = await productions.POST(json('POST', '/api/v1/productions', keys.write.token, createBody));
assert.equal(made.status, 201, await made.clone().text());
const p = await made.json();
assert.deepEqual(p.cast.map((m: { role: string; ref: string; name: string; stillAssetId: string; voice: string; referenceLines: number }) => [m.role, m.ref, m.name, m.stillAssetId, m.voice, m.referenceLines]),
  [['Rick', 'rick@1', 'Rick', still.id, "The video model's own voice (on camera)", 0]]);
// Leaving the cast out keeps it; a newer version is a deliberate move.
assert.equal((await (await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { slug: 'night-wagon', title: 'Night Wagon' }))).json()).cast[0].ref, 'rick@1');
const moved = await (await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, cast: [{ role: 'Rick', character: 'rick@2' }] }))).json();
assert.equal(moved.cast[0].ref, 'rick@2'); assert.equal(moved.cast[0].voice, 'ElevenLabs “Adam” (voice swap)');
assert.equal((await (await production.GET(json('GET', `/api/v1/productions/${p.id}`, keys.read.token), params({ id: p.id }))).json()).cast[0].ref, 'rick@2');
// A version you don't have, a role cast twice, a bad reference.
const missing = await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, cast: [{ role: 'Rick', character: 'rick@7' }] }));
assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, 'character_not_found');
assert.equal((await (await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, cast: [{ role: 'Rick', character: 'rick@1' }, { role: 'Rick', character: 'rick@2' }] }))).json()).error.code, 'invalid_cast');
assert.equal((await (await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, cast: [{ role: 'Rick', character: 'rick' }] }))).json()).error.code, 'invalid_cast');
// Another owner can't cast your characters.
assert.equal((await productions.POST(json('POST', '/api/v1/productions', 'other-session', createBody))).status, 400);
// An empty cast clears it.
assert.deepEqual((await (await productions.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, cast: [] }))).json()).cast, []);

console.log(JSON.stringify({ passed: true, assertions: 'scopes, versions stored once and never changed, listing and lookup by slug, ownership, casts linking roles to versions' }));
