// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';

process.env.MDMEDIA_MEDIA_LINK_SECRET = 'a fixture secret that is long enough to sign with';

type Data = Record<string, unknown>;
const documents = new Map<string, Data>();
const files = new Map<string, Buffer>();
let transactionTail = Promise.resolve();
class Ref {
  constructor(readonly path: string) {}
  get id() { return this.path.split('/').at(-1)!; }
  async get() { const data = documents.get(this.path); return { ref: this, id: this.id, exists: !!data, data: () => data ? structuredClone(data) : undefined }; }
  async set(data: Data) { documents.set(this.path, structuredClone(data)); }
  async update(patch: Data) { documents.set(this.path, { ...documents.get(this.path), ...structuredClone(patch) }); }
  async delete() { documents.delete(this.path); }
}
class Query {
  constructor(readonly collection: string, readonly filters: Array<[string, unknown]> = []) {}
  doc(id: string) { return new Ref(`${this.collection}/${id}`); }
  where(field: string, _op: string, value: unknown) { return new Query(this.collection, [...this.filters, [field, value]]); }
  orderBy() { return this; }
  limit() { return this; }
  async get() {
    const depth = this.collection.split('/').length + 1;
    const entries = [...documents.entries()].filter(([path, data]) => path.startsWith(`${this.collection}/`) && path.split('/').length === depth && this.filters.every(([field, value]) => data[field] === value));
    return { empty: entries.length === 0, docs: entries.map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
type Tx = { get(ref: Ref): ReturnType<Ref['get']>; set(ref: Ref, data: Data): void; update(ref: Ref, data: Data): void; delete(ref: Ref): void };
const db = { collection: (name: string) => new Query(name), async runTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = [];
  try {
    const result = await run({ get: (ref) => ref.get(), set: (ref, data) => { writes.push(() => ref.set(data)); }, update: (ref, data) => { writes.push(() => ref.update(data)); }, delete: (ref) => { writes.push(() => ref.delete()); } });
    for (const step of writes) await step();
    return result;
  } finally { release(); }
} };
let streamedRanges: Array<{ start?: number; end?: number }> = [];
const bucket = { file(path: string) { return {
  async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); },
  async download() { assert(files.has(path), `Missing ${path}`); return [files.get(path)]; },
  async getMetadata() { assert(files.has(path), `Missing ${path}`); return [{ size: String(files.get(path)!.length) }]; },
  createReadStream(range: { start?: number; end?: number } = {}) { streamedRanges.push(range); return Readable.from([files.get(path)!.subarray(range.start ?? 0, range.end === undefined ? undefined : range.end + 1)]); },
}; } };
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : header === 'Bearer other-session' ? { uid: 'intruder', email: 'eve@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));

// Two assets of the owner's: a "video" and a still with a thumbnail; one of someone else's.
const video = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const still = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#335577' } }).jpeg().toBuffer();
const asset = (id: string, ownerUid: string, mimeType: string, bytes: Buffer, thumbnail = '') => {
  documents.set(`mediaAssets/${id}`, { id, ownerUid, purpose: 'production', mediaType: mimeType.startsWith('video/') ? 'video' : 'image', generationId: null, itemId: null,
    path: `media/${ownerUid}/${id}/original`, thumbnailPath: thumbnail, mimeType, width: 32, height: 24, byteLength: bytes.length, createdAt: 1, contentSha256: id.padEnd(64, '0') });
  files.set(`media/${ownerUid}/${id}/original`, bytes);
  if (thumbnail) files.set(thumbnail, Buffer.from('webp thumbnail'));
};
asset('pmvideo', 'owner', 'video/mp4', video);
asset('pmstill', 'owner', 'image/jpeg', still, 'media/owner/pmstill/thumbnail.webp');
asset('pmtheirs', 'intruder', 'video/mp4', video);

const links = await import('../../../studio/src/app/api/v1/assets/links/route');
const content = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const { mediaLinkQuery, mediaLinkSecret } = await import('../../../studio/src/lib/media-links');

const origin = 'https://studio.test';
const ask = (body: unknown, token: string | null = 'test-session') => links.POST(new Request(`${origin}/api/v1/assets/links`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}));
const fetchLink = (url: string, headers: Record<string, string> = {}, method = 'GET') => {
  const id = new URL(url).pathname.split('/')[4]!;
  const request = new Request(url, { method, headers });
  return (method === 'HEAD' ? content.HEAD : content.GET)(request, { params: Promise.resolve({ id }) });
};
const errorCode = async (response: Response) => (await response.json()).error.code;

// --- Asking for links: signed in, your own assets only.
assert.equal((await ask({ ids: ['pmvideo'] }, null)).status, 401);
assert.equal((await ask({ ids: [] })).status, 400);
assert.equal((await ask({ ids: ['../x'] })).status, 400);
const answer = await (await ask({ ids: ['pmvideo', 'pmstill', 'pmtheirs', 'pmmissing'] })).json();
assert.deepEqual(Object.keys(answer.links).sort(), ['pmstill', 'pmvideo']);
assert.ok(answer.expiresAt - Date.now() >= 15 * 60_000 - 1000 && answer.expiresAt - Date.now() <= 20 * 60_000);
assert.equal(answer.links.pmvideo.thumbnail, null);
assert.match(answer.links.pmstill.thumbnail, /&thumbnail=1$/);
const videoUrl: string = answer.links.pmvideo.content;
assert.match(videoUrl, /^https:\/\/studio\.test\/api\/v1\/assets\/pmvideo\/content\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);

// --- A player's requests: no Authorization header, byte ranges honoured.
streamedRanges = [];
const ranged = await fetchLink(videoUrl, { Range: 'bytes=1000-1999' });
assert.equal(ranged.status, 206);
assert.equal(ranged.headers.get('content-range'), 'bytes 1000-1999/5000');
assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
assert.ok(ranged.headers.get('etag'));
assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), video.subarray(1000, 2000));
assert.deepEqual(streamedRanges, [{ start: 1000, end: 1999 }]);
assert.match(ranged.headers.get('cache-control')!, /^private, max-age=\d+$/);
const tail = await fetchLink(videoUrl, { Range: 'bytes=-100' });
assert.equal(tail.status, 206); assert.equal(tail.headers.get('content-range'), 'bytes 4900-4999/5000');
const whole = await fetchLink(videoUrl);
assert.equal(whole.status, 200); assert.equal((await whole.arrayBuffer()).byteLength, 5000);
const outside = await fetchLink(videoUrl, { Range: 'bytes=9000-' });
assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), 'bytes */5000');
const head = await fetchLink(videoUrl, { Range: 'bytes=0-9' }, 'HEAD');
assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '10');
const etag = ranged.headers.get('etag')!;
assert.equal((await fetchLink(videoUrl, { 'If-None-Match': etag })).status, 304);
// Images and thumbnails come whole.
const thumb = await fetchLink(answer.links.pmstill.thumbnail);
assert.equal(thumb.status, 200); assert.equal(thumb.headers.get('content-type'), 'image/webp');
assert.equal((await fetchLink(answer.links.pmstill.content)).headers.get('content-type'), 'image/jpeg');

// --- Refused: expired, tampered, for another asset, half a link, someone else's asset.
const secret = mediaLinkSecret();
const past = Math.floor(Date.now() / 1000) - 60;
const expired = await fetchLink(`${origin}/api/v1/assets/pmvideo/content?${mediaLinkQuery(secret, { assetId: 'pmvideo', ownerUid: 'owner', exp: past })}`, { Range: 'bytes=0-9' });
assert.equal(expired.status, 403); assert.equal(await errorCode(expired), 'link_expired');
const url = new URL(videoUrl);
const tampered = new URL(url); tampered.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 300));
assert.equal(await errorCode(await fetchLink(tampered.toString())), 'invalid_link');
const badSig = new URL(url); const sig = url.searchParams.get('sig')!; badSig.searchParams.set('sig', `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`);
assert.equal(await errorCode(await fetchLink(badSig.toString())), 'invalid_link');
const otherAsset = videoUrl.replace('/pmvideo/', '/pmstill/');
const wrongAsset = await fetchLink(otherAsset);
assert.equal(wrongAsset.status, 403); assert.equal(await errorCode(wrongAsset), 'invalid_link');
assert.equal(await errorCode(await fetchLink(videoUrl.replace('/pmvideo/', '/pmtheirs/'))), 'invalid_link');
assert.equal(await errorCode(await fetchLink(videoUrl.replace('/pmvideo/', '/pmmissing/'))), 'invalid_link');
assert.equal(await errorCode(await fetchLink(`${origin}/api/v1/assets/pmvideo/content?sig=${sig}`)), 'invalid_link');
// Without a link or a header, the route still asks you to sign in.
assert.equal((await fetchLink(`${origin}/api/v1/assets/pmvideo/content`)).status, 401);
// With the header, links are ignored and the owner check applies as before.
assert.equal((await fetchLink(otherAsset, { Authorization: 'Bearer other-session' })).status, 404);
assert.equal((await fetchLink(`${origin}/api/v1/assets/pmvideo/content`, { Authorization: 'Bearer test-session', Range: 'bytes=0-1' })).status, 206);

console.log(JSON.stringify({ passed: true, assertions: 'links for own assets only, signed ranges 206/416/304/HEAD, thumbnails, expired/tampered/wrong-asset/foreign refusals, header path unchanged' }));
