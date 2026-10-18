// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';

export const documents = new Map<string, Record<string, any>>();
export const deletedObjects: string[] = [];
/** Every document a collection query returned, so tests can see what a sweep read. */
export const queryReads = new Set<string>();
let sequence = 0;

function setPath(target: Record<string, any>, path: string, value: unknown) {
  const keys = path.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] = { ...(cursor[key] ?? {}) };
  cursor[keys.at(-1)!] = value;
}
class Ref {
  constructor(readonly path: string) {}
  get id() { return this.path.split('/').at(-1)!; }
  async get() { const data = documents.get(this.path); return { ref: this, id: this.id, exists: !!data, data: () => data ? structuredClone(data) : undefined }; }
  async set(data: Record<string, any>) { documents.set(this.path, structuredClone(data)); }
  async update(patch: Record<string, any>) {
    assert(documents.has(this.path), `Missing ${this.path}`);
    const next = structuredClone(documents.get(this.path)!);
    for (const [key, value] of Object.entries(patch)) setPath(next, key, structuredClone(value));
    documents.set(this.path, next);
  }
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
    entries = entries.filter(entry => this.filters.every(([field, op, expected]) => {
      const actual = value(entry, field);
      if (op === '==') return actual === expected;
      if (op === 'in') return expected.includes(actual);
      if (op === 'array-contains') return Array.isArray(actual) && actual.includes(expected);
      if (op === '<') return actual < expected;
      if (op === '<=') return actual <= expected;
      if (op === '>') return actual > expected;
      throw new Error(`Unsupported operator ${op}`);
    }));
    const compare = (entry: [string, any], other: any[]) => { for (let i = 0; i < this.orders.length; i++) { const [field, direction] = this.orders[i]!; const actual = value(entry, field); if (actual !== other[i]) return (actual < other[i] ? -1 : 1) * (direction === 'desc' ? -1 : 1); } return 0; };
    entries.sort((a, b) => compare(a, this.orders.map(([field]) => value(b, field))));
    if (this.after.length) entries = entries.filter(entry => compare(entry, this.after) > 0);
    const docs = entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, exists: true, data: () => structuredClone(documents.get(path)) }; });
    for (const doc of docs) queryReads.add(doc.ref.path);
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction(run: (tx: any) => Promise<any>) {
  const writes: (() => Promise<void>)[] = [];
  const result = await run({ get: (ref: Ref) => ref.get(), set: (ref: Ref, data: any) => { writes.push(() => ref.set(data)); }, update: (ref: Ref, data: any) => { writes.push(() => ref.update(data)); }, delete: (ref: Ref) => { writes.push(() => ref.delete()); } });
  for (const write of writes) await write();
  return result;
} };
const bucket = { file(path: string) { return { async delete() { deletedObjects.push(path); }, async save() {}, async exists() { return [true]; } }; } };

mock.module('../../../studio/src/lib/firebase-admin', () => ({
  adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}),
}));

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const call = (route: (request: Request, context: any) => Promise<Response>, url: string, init: RequestInit & { token?: string } = {}, params: Record<string, string> = {}) =>
  route(new Request(`https://studio.test${url}`, { ...init, headers: { ...(init.token === undefined ? { Authorization: 'Bearer test-session' } : init.token ? { Authorization: `Bearer ${init.token}` } : {}), 'Content-Type': 'application/json' } }), { params: Promise.resolve(params) });
export const json = (body: unknown) => JSON.stringify(body);

if (import.meta.main) {
  const now = Date.now();
  documents.set('users/owner', { settings: {} });
  documents.set('narrations/narr1', { ownerUid: 'owner', title: 'Long read', status: 'ready', createdAt: now - DAY, updatedAt: now - DAY, sourceMarkdown: 'x', durationMs: 1000 });
  documents.set('narrations/other1', { ownerUid: 'someone-else', title: 'Not yours', status: 'ready', createdAt: now - DAY, updatedAt: now - DAY });
  documents.set('mediaItems/image_img1', { id: 'img1', type: 'image', ownerUid: 'owner', title: 'Fox', status: 'ready', createdAt: now - DAY, updatedAt: now - DAY });
  documents.set('mediaItems/image_other', { id: 'other', type: 'image', ownerUid: 'someone-else', title: 'Theirs', status: 'ready', createdAt: now - DAY, updatedAt: now - DAY });

  const mediaRoute = await import('../../../studio/src/app/api/v1/media/[type]/[id]/route');
  const defaultsRoute = await import('../../../studio/src/app/api/v1/retention/route');
  const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
  const { NarrationLockedError, purgeNarrationData } = await import('../../../studio/src/lib/narration-server');
  const key = generateApiKey();
  documents.set(`apiKeys/${key.keyId}`, { ownerUid: 'owner', ownerEmail: 'owner@example.test', hash: key.hash, scopes: ['images:read'], revokedAt: null });

  // A narration gets a TTL from a relative time; the catalog mirror follows.
  let response = await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { ttl: '6h' } }) }, { type: 'narration', id: 'narr1' });
  assert.equal(response.status, 200);
  const set = (await response.json()).retention;
  assert.ok(Math.abs(set.expiresAt - (now + 6 * HOUR)) < 60_000);
  assert.equal(set.locked, false);
  assert.equal(set.source, 'item');
  assert.equal(documents.get('narrations/narr1')!.expiresAt, set.expiresAt);
  assert.equal(documents.get('narrations/narr1')!.updatedAt, now - DAY, 'changing retention must not touch updatedAt');
  assert.equal(documents.get('mediaItems/narration_narr1')!.expiresAt, set.expiresAt, 'the catalog mirrors retention');

  // Locking an image wins over its TTL, and GET explains why.
  await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { ttl: '1h' } }) }, { type: 'image', id: 'img1' });
  response = await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { locked: true } }) }, { type: 'image', id: 'img1' });
  assert.equal((await response.json()).retention.source, 'locked');
  response = await call(mediaRoute.GET, '/x', {}, { type: 'image', id: 'img1' });
  const locked = (await response.json()).retention;
  assert.deepEqual([locked.locked, locked.effectiveExpiresAt], [true, null]);

  // Clearing the TTL falls back to the type's default.
  response = await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { locked: false, ttl: null } }) }, { type: 'image', id: 'img1' });
  assert.deepEqual([(await response.json()).retention.source], ['none']);

  // Ownership, unknown types, scopes and bad input are all refused.
  assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { ttl: '1h' } }) }, { type: 'narration', id: 'other1' })).status, 404);
  assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { ttl: '1h' } }) }, { type: 'image', id: 'other' })).status, 404);
  assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { ttl: '1h' } }) }, { type: 'podcast', id: 'x' })).status, 404);
  assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', token: '', body: json({ retention: { ttl: '1h' } }) }, { type: 'image', id: 'img1' })).status, 401);
  assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', token: key.token, body: json({ retention: { ttl: '1h' } }) }, { type: 'image', id: 'img1' })).status, 403, 'a read-only key cannot change retention');
  assert.equal((await call(mediaRoute.GET, '/x', { token: key.token }, { type: 'image', id: 'img1' })).status, 200, 'a read key can read it');
  for (const body of [{ retention: { ttl: 'soon' } }, { retention: {} }, { title: 'x' }, { retention: { ttl: '1h' }, title: 'x' }]) {
    assert.equal((await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json(body) }, { type: 'image', id: 'img1' })).status, 400, JSON.stringify(body));
  }

  // Defaults: only a signed-in session may change them.
  response = await call(defaultsRoute.PUT, '/x', { method: 'PUT', body: json({ target: 'narration', ttl: '7d' }) });
  assert.equal(response.status, 200);
  const saved = documents.get('users/owner')!.settings.retention;
  assert.equal(saved.byType.narration.ttl, '7d');
  assert.ok(saved.byType.narration.since >= now);
  await call(defaultsRoute.PUT, '/x', { method: 'PUT', body: json({ target: 'video', ttl: 'keep' }) });
  await call(defaultsRoute.PUT, '/x', { method: 'PUT', body: json({ target: 'global', ttl: '30d', retroactive: true }) });
  const afterGlobal = documents.get('users/owner')!.settings.retention;
  assert.equal(afterGlobal.global.since, 0);
  assert.equal(afterGlobal.byType.video, null);
  await call(defaultsRoute.PUT, '/x', { method: 'PUT', body: json({ target: 'narration', ttl: 'inherit' }) });
  assert.equal('narration' in documents.get('users/owner')!.settings.retention.byType, false, 'inherit removes the type default');
  response = await call(defaultsRoute.GET, '/x');
  assert.equal((await response.json()).defaults.global.ttl, '30d');
  assert.equal((await call(defaultsRoute.PUT, '/x', { method: 'PUT', token: key.token, body: json({ target: 'global', ttl: '1h' }) })).status, 403);
  for (const body of [{ target: 'podcast', ttl: '1d' }, { target: 'global', ttl: 'soon' }, { target: 'global', ttl: 'inherit' }, { target: 'global' }, { target: 'global', ttl: '1d', extra: 1 }]) {
    assert.equal((await call(defaultsRoute.PUT, '/x', { method: 'PUT', body: json(body) })).status, 400, JSON.stringify(body));
  }

  // A locked narration cannot be purged, and nothing about it is touched.
  await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { locked: true } }) }, { type: 'narration', id: 'narr1' });
  await assert.rejects(() => purgeNarrationData('narr1', 'owner'), NarrationLockedError);
  assert.ok(documents.has('narrations/narr1'));
  assert.deepEqual(deletedObjects, []);
  await call(mediaRoute.PATCH, '/x', { method: 'PATCH', body: json({ retention: { locked: false } }) }, { type: 'narration', id: 'narr1' });
  assert.deepEqual(await purgeNarrationData('narr1', 'owner'), { deleted: true });
  assert.equal(documents.has('narrations/narr1'), false);
  assert.equal(documents.has('mediaItems/narration_narr1'), false);

  console.log(JSON.stringify({ passed: true }));
}
