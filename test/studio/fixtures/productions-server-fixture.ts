// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import ffmpeg from 'ffmpeg-static';
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

// Media: a real MP4, a WAV, a PNG.
const directory = await mkdtemp(join(tmpdir(), 'mdmedia-production-test-'));
let mp4: Buffer;
try {
  const file = join(directory, 'take.mp4');
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=24', '-t', '3', '-c:v', 'libx264', '-threads', '1', '-movflags', '+faststart', file]);
  mp4 = await readFile(file);
} finally { await rm(directory, { recursive: true, force: true }); }
const pcm = Buffer.alloc(16000 * 2);
const wavHeader = Buffer.alloc(44);
wavHeader.write('RIFF', 0); wavHeader.writeUInt32LE(36 + pcm.length, 4); wavHeader.write('WAVE', 8); wavHeader.write('fmt ', 12);
wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20); wavHeader.writeUInt16LE(1, 22); wavHeader.writeUInt32LE(16000, 24);
wavHeader.writeUInt32LE(32000, 28); wavHeader.writeUInt16LE(2, 32); wavHeader.writeUInt16LE(16, 34); wavHeader.write('data', 36); wavHeader.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([wavHeader, pcm]);
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa3300' } }).png().toBuffer();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const keys = { read: generateApiKey(), write: generateApiKey(), old: generateApiKey() };
const scopes = { read: ['productions:read'], write: ['productions:read', 'productions:write'], old: ['videos:read', 'images:read'] };
for (const [name, key] of Object.entries(keys)) {
  documents.set(`apiKeys/${key.keyId}`, { ownerUid: 'owner', ownerEmail: 'owner@example.test', hash: key.hash, scopes: scopes[name as keyof typeof scopes], revokedAt: null, lastUsedAt: Date.now() });
}
const list = await import('../../../studio/src/app/api/v1/productions/route');
const one = await import('../../../studio/src/app/api/v1/productions/[id]/route');
const cutRoute = await import('../../../studio/src/app/api/v1/productions/[id]/cuts/[cutId]/route');
const lookup = await import('../../../studio/src/app/api/v1/productions/media/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/productions/media/[sha256]/route');
const content = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const { productionAssetId } = await import('../../../studio/src/lib/production-media-server');

const origin = 'https://studio.test';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (method: string, path: string, token: string, body?: unknown) =>
  new Request(`${origin}${path}`, { method, headers: { ...auth(token), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const upload = (bytes: Buffer, mediaType: string, mimeType: string, token = keys.write.token, hash = sha(bytes), extra = '') =>
  uploadRoute.PUT(new Request(`${origin}/api/v1/productions/media/${hash}?mediaType=${mediaType}${extra}`, { method: 'PUT', headers: { ...auth(token), 'Content-Type': mimeType }, body: bytes }), params({ sha256: hash }));

// --- Scopes: no credential, an old key, a read-only key.
assert.equal((await list.GET(json('GET', '/api/v1/productions', 'missing'))).status, 401);
assert.equal((await list.GET(json('GET', '/api/v1/productions', keys.old.token))).status, 403);
assert.equal((await list.GET(json('GET', '/api/v1/productions', keys.read.token))).status, 200);
assert.equal((await list.POST(json('POST', '/api/v1/productions', keys.read.token, { slug: 'x', title: 'X' }))).status, 403);
assert.equal((await upload(mp4, 'video', 'video/mp4', keys.read.token)).status, 403);

// --- Uploads: stored once per content hash, streamed, checked.
const take = await upload(mp4, 'video', 'video/mp4', keys.write.token, sha(mp4), '&durationMs=3000');
assert.equal(take.status, 201);
const takeAsset = await take.json();
assert.equal(takeAsset.id, productionAssetId('owner', sha(mp4)));
assert.equal(takeAsset.mediaType, 'video'); assert.equal(takeAsset.durationMs, 3000); assert.equal(takeAsset.links.thumbnail, null);
assert.equal(documents.get(`mediaAssets/${takeAsset.id}`)!.purpose, 'production');
assert.deepEqual(files.get(`media/owner/${takeAsset.id}/original`), mp4);
const again = await upload(mp4, 'video', 'video/mp4');
assert.equal(again.status, 200); assert.equal((await again.json()).id, takeAsset.id);
const voice = await (await upload(wav, 'voice', 'audio/wav')).json();
const still = await upload(png, 'image', 'image/png');
assert.equal(still.status, 201);
const stillAsset = await still.json();
assert.equal(stillAsset.width, 32); assert.ok(stillAsset.links.thumbnail);
// A body that doesn't hash to its path is refused, and nothing is left behind.
const wrong = await upload(wav, 'voice', 'audio/wav', keys.write.token, sha(mp4).replace(/^./, (c) => (c === 'a' ? 'b' : 'a')));
assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error.code, 'hash_mismatch');
assert.equal([...files.keys()].filter((path) => path.includes('/original')).length, 3);
// Bytes that aren't what their type says, an unknown type, a declared size over the bound.
const otherPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } }).png().toBuffer();
assert.equal((await upload(otherPng, 'video', 'video/mp4')).status, 415);
// An upload of bytes you already have answers with that asset, unread, whatever it was declared as.
assert.equal((await (await upload(png, 'video', 'video/mp4')).json()).mimeType, 'image/png');
assert.equal((await upload(wav, 'voice', 'text/html')).status, 415);
assert.equal((await upload(wav, 'podcast', 'audio/wav')).status, 400);
const huge = await uploadRoute.PUT(new Request(`${origin}/api/v1/productions/media/${sha(wav)}?mediaType=video`, { method: 'PUT', headers: { ...auth(keys.write.token), 'Content-Type': 'video/mp4', 'Content-Length': String(300 * 1024 * 1024) }, body: wav }), params({ sha256: sha(wav) }));
assert.equal(huge.status, 413);
// Lookup by hash: only what you have.
const found = await (await lookup.GET(json('GET', `/api/v1/productions/media?sha256=${sha(mp4)},${sha(png)},${'0'.repeat(64)}`, keys.read.token))).json();
assert.deepEqual(Object.keys(found.found).sort(), [sha(mp4), sha(png)].sort());
assert.equal((await lookup.GET(json('GET', '/api/v1/productions/media?sha256=nope', keys.read.token))).status, 400);
// Someone else's upload of the same bytes is their own asset.
const theirs = await (await upload(mp4, 'video', 'video/mp4', 'other-session')).json();
assert.notEqual(theirs.id, takeAsset.id);

// --- Productions: upserted by slug.
const createBody = { slug: 'night-wagon-the-argument', title: 'Night Wagon: The Argument', series: { title: 'Night Wagon' }, coverAssetId: stillAsset.id };
const created = await list.POST(json('POST', '/api/v1/productions', keys.write.token, createBody));
assert.equal(created.status, 201);
const production = await created.json();
const same = await list.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, title: 'Night Wagon: The Argument!' }));
assert.equal(same.status, 200);
assert.equal((await same.json()).id, production.id);
assert.equal(production.series.title, 'Night Wagon'); assert.equal(production.links.cover, `${origin}/api/v1/assets/${stillAsset.id}/content`);
assert.equal((await list.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, slug: 'Bad Slug' }))).status, 400);
assert.equal((await list.POST(json('POST', '/api/v1/productions', keys.write.token, { ...createBody, slug: 'x-other', coverAssetId: theirs.id }))).status, 400);

// --- Cuts.
const cutFile = {
  format: 'mdmedia.cut@1',
  meta: { title: 'Night Wagon', fps: 24, width: 64, height: 48, version: 'Take 9' },
  media: { root: '.' },
  output: 'takes/night-wagon-take9.mp4',
  segments: [
    { id: 'road', src: `asset:${takeAsset.id}`, in: 0, out: 2 },
    { id: 'logo', src: 'color:black', in: 0, out: 0.5 },
  ],
  lines: [{ id: 'hello', speaker: 'Buddy', text: 'Hello there.', src: `asset:${voice.id}`, at: 0.5, duration: 1 }],
  overlays: [{ id: 'title', src: `asset:${stillAsset.id}`, at: 0, until: 1 }],
};
const words = {
  format: 'mdmedia.cut-words@1',
  lines: { hello: { text: 'Hello there.', aligner: 'test', loss: null, fingerprint: { source: `asset:${voice.id}`, start: 0, end: 1, sha256: sha(wav) },
    words: [{ text: 'Hello', start: 0.1, end: 0.4 }, { text: 'there.', start: 0.45, end: 0.8 }] } },
};
const cutPath = (cutId: string) => `/api/v1/productions/${production.id}/cuts/${cutId}`;
const put = (cutId: string, body: unknown, token = keys.write.token) => cutRoute.PUT(json('PUT', cutPath(cutId), token, body), params({ id: production.id, cutId }));
const take9 = { label: 'Take 9 (opens on the road)', status: 'approved', kind: 'cut', notes: 'Opens on the road.', order: 1, createdAt: 1000, cut: cutFile, words, renderedAssetId: takeAsset.id, thumbs: { road: stillAsset.id }, source: { cut: 'docs/cuts/night-wagon-take9.cut.json' } };
const putCut = await put('take9', take9);
assert.equal(putCut.status, 201, await putCut.clone().text());
const take9Resource = await putCut.json();
assert.equal(take9Resource.lengthSeconds, 2.5);
assert.equal(take9Resource.cut.output, undefined);
assert.equal((await put('take9', take9)).status, 200);
// Sources must be uploaded assets, of the caller's.
assert.equal((await (await put('bad', { ...take9, cut: { ...cutFile, segments: [{ id: 'road', src: 'takes/road.mp4', in: 0, out: 2 }] } })).json()).error.code, 'unportable_source');
const foreign = await put('bad', { ...take9, cut: { ...cutFile, segments: [{ id: 'road', src: `asset:${theirs.id}`, in: 0, out: 2 }] } });
assert.equal(foreign.status, 400); assert.deepEqual((await foreign.json()).error.ids, [theirs.id]);
assert.equal((await put('bad', { ...take9, cut: { ...cutFile, extends: 'night-wagon-take8' } })).status, 422);
assert.equal((await put('bad', { ...take9, cut: { ...cutFile, segments: [{ id: 'road', src: `asset:${takeAsset.id}`, in: 2, out: 1 }] } })).status, 422);
assert.equal((await put('bad', { ...take9, renderedAssetId: voice.id })).status, 400);
// A rendered take with a poster and a long note: the summary carries the poster and the note, shortened at a word.
const longNote = `Take 1 note. ${'The hop over the cone jumps from night to day. '.repeat(60)}`;
assert.equal((await put('take1', { label: 'Take 1', status: 'none', kind: 'rendered', order: 0, createdAt: 500, renderedAssetId: takeAsset.id, posterAssetId: stillAsset.id, notes: longNote })).status, 201);
assert.equal((await put('bad-poster', { label: 'X', status: 'none', kind: 'rendered', order: 4, renderedAssetId: takeAsset.id, posterAssetId: takeAsset.id })).status, 400);
assert.equal((await put('take10', { ...take9, label: 'Take 10', status: 'review', order: 2, createdAt: 2000 })).status, 201);
assert.equal((await put('rendered-with-cut', { label: 'X', status: 'none', kind: 'rendered', order: 3, cut: cutFile, renderedAssetId: takeAsset.id })).status, 422);

// The full cut: resolved, words applied and checked against the asset's hash, with its assets' links.
const full = await (await cutRoute.GET(json('GET', cutPath('take9'), keys.read.token), params({ id: production.id, cutId: 'take9' }))).json();
assert.deepEqual(full.timeline.segments.map((s: { id: string; start: number }) => [s.id, s.start]), [['road', 0], ['logo', 2]]);
assert.deepEqual(full.timeline.lines[0].words, [{ text: 'Hello', start: 0.6, end: 0.9 }, { text: 'there.', start: 0.95, end: 1.3 }]);
assert.deepEqual(full.wordsSummary, { applied: ['hello'], stale: [], unchecked: [] });
assert.equal(full.timeline.segments[0].src.kind, 'asset');
assert.deepEqual(Object.keys(full.assets).sort(), [takeAsset.id, voice.id, stillAsset.id].sort());
assert.equal(full.links.rendered, `${origin}/api/v1/assets/${takeAsset.id}/content`);
assert.equal(full.thumbs.road, stillAsset.id);
// Words whose audio changed (another hash) are left out, not misapplied.
const staleWords = { ...words, lines: { hello: { ...words.lines.hello, fingerprint: { ...words.lines.hello.fingerprint, sha256: 'ff'.repeat(32) } } } };
// Without a createdAt, a replaced cut keeps the one it had.
await put('take10', { ...take9, label: 'Take 10', status: 'review', order: 2, words: staleWords, createdAt: undefined });
const take10 = await (await cutRoute.GET(json('GET', cutPath('take10'), keys.read.token), params({ id: production.id, cutId: 'take10' }))).json();
assert.equal(take10.wordsSummary.stale[0].id, 'hello'); assert.deepEqual(take10.timeline.lines[0].words, []);
assert.equal(take10.createdAt, 2000);

// The summary: cuts in order, approved and current pointers kept honest.
let detail = await (await one.GET(json('GET', `/api/v1/productions/${production.id}`, keys.read.token), params({ id: production.id }))).json();
assert.deepEqual(detail.cuts.map((c: { id: string }) => c.id), ['take1', 'take9', 'take10']);
const take1Summary = detail.cuts[0];
assert.equal(take1Summary.posterAssetId, stillAsset.id);
assert.equal(take1Summary.notesTruncated, true);
assert.ok(take1Summary.notes.length <= 2001 && take1Summary.notes.endsWith('…') && longNote.startsWith(take1Summary.notes.slice(0, -1)));
assert.equal(detail.cuts[1].notes, 'Opens on the road.'); assert.equal(detail.cuts[1].notesTruncated, false);
assert.equal(documents.get(`productions/${production.id}/cuts/take1`)!.notes, longNote.trim());
// Activity is the newest cut until something is reviewed.
assert.equal(detail.activityAt, 2000);
// A production with no current cut takes the last one in order when a cut arrives; it stays until changed.
assert.equal(detail.currentCutId, 'take9');
assert.equal(detail.approvedCutId, null);
const patch = (body: unknown, token = keys.write.token) => one.PATCH(json('PATCH', `/api/v1/productions/${production.id}`, token, body), params({ id: production.id }));
detail = await (await patch({ approvedCutId: 'take9', currentCutId: 'take9' })).json();
assert.equal(detail.approvedCutId, 'take9'); assert.equal(detail.currentCutId, 'take9');
// Approving a cut under review marks it approved; it stops being approved when its status changes.
detail = await (await patch({ approvedCutId: 'take10' })).json();
assert.equal(detail.cuts.find((c: { id: string }) => c.id === 'take10').status, 'approved');
assert.equal(documents.get(`productions/${production.id}/cuts/take10`)!.status, 'approved');
detail = await (await patch({ cuts: [{ id: 'take10', status: 'review', notes: 'Try the shorter punchline.' }] })).json();
assert.equal(detail.approvedCutId, null);
assert.equal(detail.cuts.find((c: { id: string }) => c.id === 'take10').notes, 'Try the shorter punchline.');
// A review counts as activity; pointing at the current cut alone does not.
assert.ok(detail.activityAt > 2000);
const reviewed = detail.activityAt;
detail = await (await patch({ currentCutId: 'take9' })).json();
assert.equal(detail.activityAt, reviewed);
assert.equal(documents.get(`productions/${production.id}/cuts/take10`)!.notes, 'Try the shorter punchline.');
assert.equal((await patch({ approvedCutId: 'take10', cuts: [{ id: 'take10', status: 'none' }] })).status, 409);
assert.equal((await patch({ approvedCutId: 'nope' })).status, 404);
assert.equal((await patch({ title: '' })).status, 400);
detail = await (await patch({ title: 'Night Wagon: The Argument', approvedCutId: 'take9' })).json();
assert.equal(detail.title, 'Night Wagon: The Argument');

// The listing groups by series.
const listing = await (await list.GET(json('GET', '/api/v1/productions', keys.read.token))).json();
assert.equal(listing.productions.length, 1);
assert.deepEqual(listing.series.map((s: { title: string; productionIds: string[] }) => [s.title, s.productionIds]), [['Night Wagon', [production.id]]]);
assert(!JSON.stringify(listing).includes('ownerUid'));

// Owners only.
assert.equal((await one.GET(json('GET', `/api/v1/productions/${production.id}`, 'other-session'), params({ id: production.id }))).status, 404);
assert.equal((await cutRoute.GET(json('GET', cutPath('take9'), 'other-session'), params({ id: production.id, cutId: 'take9' }))).status, 404);
assert.equal((await put('take9', take9, 'other-session')).status, 404);
assert.equal((await content.GET(new Request(`${origin}/api/v1/assets/${takeAsset.id}/content`, { headers: auth('other-session') }), params({ id: takeAsset.id }))).status, 404);

// --- The asset route: byte ranges for video and audio, whole images, production scope.
const get = (id: string, headers: Record<string, string> = {}, token = keys.read.token, query = '') =>
  content.GET(new Request(`${origin}/api/v1/assets/${id}/content${query}`, { headers: { ...auth(token), ...headers } }), params({ id }));
const whole = await get(takeAsset.id);
assert.equal(whole.status, 200); assert.equal(whole.headers.get('accept-ranges'), 'bytes');
assert.equal(whole.headers.get('content-length'), String(mp4.length));
assert.deepEqual(Buffer.from(await whole.arrayBuffer()), mp4);
const ranged = await get(takeAsset.id, { Range: 'bytes=4-11' });
assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), `bytes 4-11/${mp4.length}`);
assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('latin1'), mp4.subarray(4, 12).toString('latin1'));
const tail = await get(takeAsset.id, { Range: 'bytes=-10' });
assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 10);
const outside = await get(takeAsset.id, { Range: `bytes=${mp4.length}-` });
assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), `bytes */${mp4.length}`);
const etag = whole.headers.get('etag')!;
assert.equal((await get(takeAsset.id, { 'If-None-Match': etag })).status, 304);
assert.equal((await get(takeAsset.id, { Range: 'bytes=0-1', 'If-Range': '"stale"' })).status, 200);
const headResponse = await content.HEAD(new Request(`${origin}/api/v1/assets/${takeAsset.id}/content`, { method: 'HEAD', headers: { ...auth(keys.read.token), Range: 'bytes=0-99' } }), params({ id: takeAsset.id }));
assert.equal(headResponse.status, 206); assert.equal(headResponse.headers.get('content-length'), '100');
assert.equal((await get(voice.id, { Range: 'bytes=0-3' })).status, 206);
assert.equal((await get(takeAsset.id, {}, keys.old.token)).status, 403);
assert.equal((await get(takeAsset.id, {}, keys.read.token, '?thumbnail=1')).status, 404);
// Images and thumbnails are sent whole, as before.
const downloadsBefore = wholeDownloads;
const image = await get(stillAsset.id, { Range: 'bytes=0-3' });
assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
assert.equal((await get(stillAsset.id, {}, keys.read.token, '?thumbnail=1')).headers.get('content-type'), 'image/webp');
assert.equal(wholeDownloads, downloadsBefore + 2);
assert(streamedReads >= 4);

// --- Deleting: a cut, then the production with its cuts. Media stays.
assert.equal((await cutRoute.DELETE(json('DELETE', cutPath('take9'), keys.write.token), params({ id: production.id, cutId: 'take9' }))).status, 204);
detail = await (await one.GET(json('GET', `/api/v1/productions/${production.id}`, keys.read.token), params({ id: production.id }))).json();
assert.deepEqual(detail.cuts.map((c: { id: string }) => c.id), ['take1', 'take10']); assert.equal(detail.approvedCutId, null); assert.equal(detail.currentCutId, 'take10');
assert.equal((await cutRoute.DELETE(json('DELETE', cutPath('take9'), keys.write.token), params({ id: production.id, cutId: 'take9' }))).status, 404);
assert.equal((await one.DELETE(json('DELETE', `/api/v1/productions/${production.id}`, keys.write.token), params({ id: production.id }))).status, 204);
assert.equal([...documents.keys()].filter((path) => path.startsWith('productions/')).length, 0);
assert(documents.has(`mediaAssets/${takeAsset.id}`));

console.log(JSON.stringify({ passed: true, assertions: 'scopes, hashed streaming uploads and dedupe, upsert by slug, cut validation and resolution with words, pointers, series listing, ownership, byte ranges, deletes' }));
