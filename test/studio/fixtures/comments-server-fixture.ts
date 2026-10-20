// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';

type Data = Record<string, unknown>;
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
class Query {
  constructor(readonly collection: string, readonly filters: Array<[string, string, unknown]> = [], readonly cap = Infinity) {}
  doc(id = `auto${++sequence}`) { return new Ref(`${this.collection}/${id}`); }
  where(field: string, op: string, value: unknown) { return new Query(this.collection, [...this.filters, [field, op, value]], this.cap); }
  orderBy() { return this; }
  limit(cap: number) { return new Query(this.collection, this.filters, cap); }
  async get() {
    const depth = this.collection.split('/').length + 1;
    const entries = [...documents.entries()]
      .filter(([path]) => path.startsWith(`${this.collection}/`) && path.split('/').length === depth)
      .filter(([, data]) => this.filters.every(([field, op, expected]) => op === '==' && data[field] === expected));
    return { empty: entries.length === 0, size: entries.length, docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, data: () => structuredClone(documents.get(path)) }; }) };
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
const bucket = { file(path: string) { return {
  async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); },
  async delete() { files.delete(path); },
  createWriteStream() {
    const chunks: Buffer[] = [];
    return new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) { files.set(path, Buffer.concat(chunks)); done(); } });
  },
}; } };
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : header === 'Bearer other-session' ? { uid: 'intruder', email: 'eve@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));

const directory = await mkdtemp(join(tmpdir(), 'mdmedia-comments-test-'));
let mp4: Buffer;
let preview: Buffer;
try {
  const make = async (color: string, name: string) => {
    const file = join(directory, name);
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:r=24`, '-t', '3', '-c:v', 'libx264', '-threads', '1', '-movflags', '+faststart', file]);
    return readFile(file);
  };
  mp4 = await make('blue', 'take.mp4');
  preview = await make('red', 'preview.mp4');
} finally { await rm(directory, { recursive: true, force: true }); }
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa3300' } }).png().toBuffer();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const keys = { agent: generateApiKey(), reader: generateApiKey(), productionsOnly: generateApiKey() };
const scopes = { agent: ['productions:read', 'productions:write', 'comments:read', 'comments:write'], reader: ['comments:read'], productionsOnly: ['productions:read', 'productions:write'] };
for (const [name, key] of Object.entries(keys)) {
  documents.set(`apiKeys/${key.keyId}`, { ownerUid: 'owner', ownerEmail: 'owner@example.test', hash: key.hash, scopes: scopes[name as keyof typeof scopes], revokedAt: null, lastUsedAt: Date.now() });
}
const productionsRoute = await import('../../../studio/src/app/api/v1/productions/route');
const productionRoute = await import('../../../studio/src/app/api/v1/productions/[id]/route');
const cutRoute = await import('../../../studio/src/app/api/v1/productions/[id]/cuts/[cutId]/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/productions/media/[sha256]/route');
const threadsRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/route');
const threadRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/route');
const messagesRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/messages/route');
const suggestionsRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/suggestions/route');
const suggestionRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/suggestions/[suggestionId]/route');
const claimRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/claim/route');
const contextRoute = await import('../../../studio/src/app/api/v1/productions/[id]/threads/[threadId]/context/route');
const decisionsRoute = await import('../../../studio/src/app/api/v1/productions/[id]/decisions/route');
const heartbeatRoute = await import('../../../studio/src/app/api/v1/comments/heartbeat/route');

const origin = 'https://studio.test';
const json = (method: string, path: string, token: string, body?: unknown) =>
  new Request(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const upload = async (bytes: Buffer, mediaType: string, mimeType: string) => (await uploadRoute.PUT(
  new Request(`${origin}/api/v1/productions/media/${sha(bytes)}?mediaType=${mediaType}&durationMs=3000`, { method: 'PUT', headers: { Authorization: `Bearer ${keys.agent.token}`, 'Content-Type': mimeType }, body: bytes }),
  params({ sha256: sha(bytes) }),
)).json();
const agent = keys.agent.token;
const owner = 'test-session';

// --- A production with a timed cut (a shot, a colour, one line with words) and a rendered take.
const take = await upload(mp4, 'video', 'video/mp4');
const previewAsset = await upload(preview, 'video', 'video/mp4');
const still = await upload(png, 'image', 'image/png');
const production = await (await productionsRoute.POST(json('POST', '/api/v1/productions', agent, { slug: 'big-hal', title: 'Big Hal' }))).json();
const cutFile = {
  format: 'mdmedia.cut@1', meta: { title: 'Big Hal', fps: 24, width: 64, height: 48, version: 'Take 5' }, media: { root: '.' },
  segments: [{ id: 'hood', src: `asset:${take.id}`, in: 0, out: 2 }, { id: 'finish', src: 'color:black', in: 0, out: 1 }],
  lines: [
    { id: 'thisone', speaker: 'Hal', text: 'This one even comes with...', src: `asset:${take.id}`, at: 0.2, duration: 1 },
    { id: 'wheels', speaker: 'Hal', text: 'Wheels!', src: `asset:${take.id}`, at: 1.8, duration: 0.8 },
  ],
};
const putCut = (cutId: string, body: unknown) => cutRoute.PUT(json('PUT', `/api/v1/productions/${production.id}/cuts/${cutId}`, agent, body), params({ id: production.id, cutId }));
assert.equal((await putCut('take5', { label: 'Take 5 (shot by shot)', status: 'review', kind: 'cut', order: 4, cut: cutFile, renderedAssetId: take.id })).status, 201);
assert.equal((await putCut('take6', { label: 'Take 6 (wheels in one breath)', status: 'review', kind: 'rendered', order: 5, renderedAssetId: take.id })).status, 201);
const P = `/api/v1/productions/${production.id}`;

// --- Scopes: a productions-only key can't touch comments; a read-only one can't write.
assert.equal((await threadsRoute.GET(json('GET', `${P}/threads`, keys.productionsOnly.token), params({ id: production.id }))).status, 403);
assert.equal((await threadsRoute.POST(json('POST', `${P}/threads`, keys.reader.token, { cutId: 'take5', time: 1, text: 'x' }), params({ id: production.id }))).status, 403);
assert.equal((await threadsRoute.GET(json('GET', `${P}/threads`, keys.reader.token), params({ id: production.id }))).status, 200);

// --- The owner comments at 2.2 s: anchored server-side on the resolved cut, during "Wheels!" over the finish shot.
const created = await threadsRoute.POST(json('POST', `${P}/threads`, owner, { cutId: 'take5', time: 2.2, text: 'Wheels lands like a reveal.', view: '4:3', frameAssetId: still.id }), params({ id: production.id }));
assert.equal(created.status, 201, await created.clone().text());
const thread = await created.json();
assert.equal(thread.author, 'owner'); assert.equal(thread.status, 'open'); assert.equal(thread.needsAgent, true);
assert.deepEqual(thread.anchor.items.map((i: { kind: string; id: string }) => `${i.kind}:${i.id}`), ['segment:finish', 'line:thisone', 'line:wheels', 'gap:thisone-wheels']);
assert.deepEqual(thread.anchor.items[0], { kind: 'segment', id: 'finish', start: 2, end: 3 });
assert.equal(thread.snapshot.frameAssetId, still.id); assert.equal(thread.statusLine.text, 'Waiting for an agent');
assert.equal(documents.get(`productions/${production.id}/threads/${thread.id}`)!.ownerUid, 'owner');
// Bad comments: outside the video, on a rendered-only version, an image that isn't yours, another owner's production.
assert.equal((await threadsRoute.POST(json('POST', `${P}/threads`, owner, { cutId: 'take5', time: 9, text: 'x' }), params({ id: production.id }))).status, 400);
assert.equal((await threadsRoute.POST(json('POST', `${P}/threads`, owner, { cutId: 'take6', time: 1, text: 'x' }), params({ id: production.id }))).status, 422);
assert.equal((await threadsRoute.POST(json('POST', `${P}/threads`, owner, { cutId: 'take5', time: 1, text: 'x', frameAssetId: take.id }), params({ id: production.id }))).status, 400);
assert.equal((await threadsRoute.POST(json('POST', `${P}/threads`, 'other-session', { cutId: 'take5', time: 1, text: 'x' }), params({ id: production.id }))).status, 404);
const T = `${P}/threads/${thread.id}`;
const at = (route: string) => params({ id: production.id, threadId: thread.id, ...(route ? { suggestionId: route } : {}) });

// --- An agent sees it waiting, says it's there, and claims it; another agent can't.
let waiting = await (await threadsRoute.GET(json('GET', `${P}/threads?needsAgent=1&cutId=take5`, agent), params({ id: production.id }))).json();
assert.deepEqual(waiting.threads.map((t: { id: string }) => t.id), [thread.id]);
const beat = await (await heartbeatRoute.POST(json('POST', '/api/v1/comments/heartbeat', agent, { agent: 'editor', productionId: production.id }))).json();
assert.equal(beat.agent, 'editor'); assert.equal(beat.productionId, production.id);
assert.equal([...documents.keys()].filter((k) => k.startsWith('commentAgents/')).length, 1);
let claimed = await (await claimRoute.POST(json('POST', `${T}/claim`, agent, { agent: 'editor' }), at(''))).json();
assert.equal(claimed.status, 'in-progress'); assert.equal(claimed.claim.agent, 'editor'); assert.equal(claimed.statusLine.text, 'Agent working');
assert.equal((await claimRoute.POST(json('POST', `${T}/claim`, agent, { agent: 'other' }), at(''))).status, 409);
waiting = await (await threadsRoute.GET(json('GET', `${P}/threads?needsAgent=1`, agent), params({ id: production.id }))).json();
assert.equal(waiting.threads.length, 0);

// --- The context bundle: the anchored items with their neighbours and words, versions, media, and what's missing.
const bundle = await (await contextRoute.GET(json('GET', `${T}/context`, keys.reader.token), at(''))).json();
assert.equal(bundle.format, 'mdmedia.thread-context@2');
assert.deepEqual(bundle.anchored.segments.map((s: { id: string }) => s.id), ['finish']);
assert.deepEqual(bundle.anchored.lines, ['thisone', 'wheels']);
assert.equal(bundle.anchored.gaps[0].id, 'thisone-wheels');
assert.deepEqual(bundle.lines.map((l: { id: string; anchored: boolean }) => [l.id, l.anchored]), [['thisone', true], ['wheels', true]]);
assert.equal(bundle.neighbours.segments[0].before.id, 'hood'); assert.equal(bundle.neighbours.segments[0].cuts[0].at, 2);
assert.deepEqual(bundle.history.versions.map((v: { id: string }) => v.id), ['take5', 'take6']);
assert.equal(bundle.version.label, 'Take 5 (shot by shot)'); assert.equal(bundle.version.unchanged, true);
assert.equal(bundle.media.snapshot, still.id); assert.ok(bundle.media.links[take.id]);
assert.ok(bundle.missing.some((m: { need: string }) => m.need.startsWith('how each take was generated')));
assert.ok(bundle.missing.some((m: { need: string }) => m.need === 'the decision log'));
assert.deepEqual(bundle.writeTo.messages, `${origin}${T}/messages`);

// --- Options: one message offers them, lettered in round 1; previews must be your videos. The claim ends.
const option = { title: 'Say it in one breath', approach: 'One take.', steps: ['Generate.'], cost: { generations: 2, minutes: 25 }, risks: ['Two takes.'], checks: [{ passed: true, notes: 'Heard as one delivery.' }], keeps: ['d3'], overturns: ['d9'], creates: ['hal6-wheels-t1'] };
assert.equal((await suggestionsRoute.POST(json('POST', `${T}/suggestions`, agent, { suggestions: [option] }), at(''))).status, 400);
assert.equal((await suggestionsRoute.POST(json('POST', `${T}/suggestions`, agent, { message: 'x', suggestions: [{ ...option, previews: [{ assetId: still.id }] }] }), at(''))).status, 400);
const offered = await (await suggestionsRoute.POST(json('POST', `${T}/suggestions`, agent, {
  agent: 'editor', message: 'I read this as: say it plainly.', suggestions: [{ ...option, previews: [{ assetId: previewAsset.id }, { assetId: take.id, label: 'without the ride' }] }, { title: 'Close the gap', cost: { generations: 0, minutes: 5 } }],
}), at(''))).json();
assert.deepEqual(offered.suggestions.map((s: { round: number; letter: string; state: string }) => `${s.letter}${s.round}:${s.state}`), ['A1:proposed', 'B1:proposed']);
assert.equal(offered.suggestions[0].previews[0].durationMs, 3000); assert.equal(offered.suggestions[0].previews[1].label, 'without the ride');
assert.deepEqual(offered.message.suggestions, offered.suggestions.map((s: { id: string }) => s.id));
assert.equal(offered.message.author, 'agent:editor');
let detail = await (await threadRoute.GET(json('GET', T, agent), at(''))).json();
assert.equal(detail.thread.status, 'addressed'); assert.equal(detail.thread.claim, null); assert.equal(detail.thread.statusLine.text, '2 options to review');
const [a, b] = offered.suggestions;

// --- The owner replies at a time on a preview, and on another cut; times are checked against each video.
const onPreview = await messagesRoute.POST(json('POST', `${T}/messages`, owner, { text: 'The slap is late here.', at: { video: { kind: 'preview', suggestionId: a.id, assetId: previewAsset.id }, time: 1.5 } }), at(''));
assert.equal(onPreview.status, 201);
assert.deepEqual((await onPreview.json()).at, { video: { kind: 'preview', suggestionId: a.id, assetId: previewAsset.id }, time: 1.5 });
assert.equal((await messagesRoute.POST(json('POST', `${T}/messages`, owner, { text: 'x', at: { video: { kind: 'preview', suggestionId: a.id, assetId: previewAsset.id }, time: 30 } }), at(''))).status, 400);
assert.equal((await messagesRoute.POST(json('POST', `${T}/messages`, owner, { text: 'x', at: { video: { kind: 'preview', suggestionId: a.id, assetId: still.id }, time: 1 } }), at(''))).status, 400);
const onCut = await (await messagesRoute.POST(json('POST', `${T}/messages`, owner, { text: 'Compare with here.', at: { video: { kind: 'cut', cutId: 'take5' }, time: 0.5 } }), at(''))).json();
assert.deepEqual(onCut.at.anchor.map((i: { kind: string; id: string }) => `${i.kind}:${i.id}`), ['segment:hood', 'line:thisone']);
detail = await (await threadRoute.GET(json('GET', T, agent), at(''))).json();
assert.equal(detail.thread.status, 'open'); assert.equal(detail.messages.length, 3);

// --- Accept and reject: accepting leaves it open for an agent; applying makes it addressed, as a cut of the production.
assert.equal((await suggestionRoute.PATCH(json('PATCH', `${T}/suggestions/${b.id}`, owner, { state: 'rejected' }), at(b.id))).status, 200);
const accepted = await (await suggestionRoute.PATCH(json('PATCH', `${T}/suggestions/${a.id}`, owner, { state: 'accepted' }), at(a.id))).json();
assert.equal(accepted.state, 'accepted'); assert.equal(accepted.stateChangedBy, 'owner');
detail = await (await threadRoute.GET(json('GET', T, agent), at(''))).json();
assert.equal(detail.thread.status, 'open'); assert.equal(detail.thread.statusLine.text, 'You accepted Option A · round 1');
assert.equal((await suggestionRoute.PATCH(json('PATCH', `${T}/suggestions/${a.id}`, agent, { state: 'applied' }), at(a.id))).status, 400);
assert.equal((await suggestionRoute.PATCH(json('PATCH', `${T}/suggestions/${a.id}`, agent, { state: 'applied', appliedAs: 'take9' }), at(a.id))).status, 400);
const applied = await (await suggestionRoute.PATCH(json('PATCH', `${T}/suggestions/${a.id}`, agent, { state: 'applied', appliedAs: 'take6', agent: 'editor' }), at(a.id))).json();
assert.equal(applied.appliedAs, 'take6'); assert.equal(applied.stateChangedBy, 'agent:editor');
const presented = await (await messagesRoute.POST(json('POST', `${T}/messages`, agent, { agent: 'editor', text: 'Applied as Take 6.', version: { cutId: 'take6' }, replyTo: onCut.id }), at(''))).json();
assert.deepEqual(presented.version, { cutId: 'take6' }); assert.equal(presented.replyTo, onCut.id);
assert.equal((await messagesRoute.POST(json('POST', `${T}/messages`, agent, { text: 'x', version: { cutId: 'nope' } }), at(''))).status, 400);
detail = await (await threadRoute.GET(json('GET', T, agent), at(''))).json();
assert.equal(detail.thread.status, 'addressed'); assert.equal(detail.thread.statusLine.text, 'Addressed in Take 6');

// --- Status outright, and resolve; a resolved thread can't be claimed.
const resolved = await (await threadRoute.PATCH(json('PATCH', T, agent, { status: 'resolved' }), at(''))).json();
assert.equal(resolved.statusLine.text, 'Resolved');
assert.equal((await threadRoute.PATCH(json('PATCH', T, agent, { status: 'done' }), at(''))).status, 400);
assert.equal((await claimRoute.POST(json('POST', `${T}/claim`, agent, { agent: 'editor' }), at(''))).status, 409);
claimed = await (await claimRoute.DELETE(json('DELETE', `${T}/claim`, agent), at(''))).json();
assert.equal(claimed.status, 'resolved');

// --- Decisions: per production, linked to threads and versions; ids are unique.
const decision = await decisionsRoute.POST(json('POST', `${P}/decisions`, agent, { id: 'd11-hal-delivery', source: 'owner direction', take: 'Take 5 review', quote: 'Like something totally normal.', text: 'Wheels is said like any feature.', threadIds: [thread.id], cutIds: ['take5'] }), params({ id: production.id }));
assert.equal(decision.status, 201);
assert.equal((await decisionsRoute.POST(json('POST', `${P}/decisions`, agent, { id: 'd11-hal-delivery', text: 'again' }), params({ id: production.id }))).status, 409);
assert.equal((await decisionsRoute.POST(json('POST', `${P}/decisions`, agent, { text: 'x', cutIds: ['take99'] }), params({ id: production.id }))).status, 400);
assert.equal((await decisionsRoute.POST(json('POST', `${P}/decisions`, agent, { kind: 'constraint', text: 'A generation is at most 8 s.' }), params({ id: production.id }))).status, 201);
const log = await (await decisionsRoute.GET(json('GET', `${P}/decisions`, keys.reader.token), params({ id: production.id }))).json();
assert.deepEqual(log.decisions.map((d: { id: string }) => d.id), ['d11-hal-delivery']); assert.equal(log.constraints.length, 1);
const bundleAfter = await (await contextRoute.GET(json('GET', `${T}/context`, agent), at(''))).json();
assert.deepEqual(bundleAfter.decisions.relevant, ['d11-hal-delivery']);
assert.equal(bundleAfter.messages.length, 4); assert.equal(bundleAfter.suggestions.length, 2);

// --- Owners only.
assert.equal((await threadRoute.GET(json('GET', T, 'other-session'), at(''))).status, 404);
assert.equal((await messagesRoute.POST(json('POST', `${T}/messages`, 'other-session', { text: 'x' }), at(''))).status, 404);
assert.equal((await threadRoute.GET(json('GET', `${P}/threads/nope`, agent), params({ id: production.id, threadId: 'nope' }))).status, 404);

// --- Deleting the production deletes its comments and decisions too.
assert.equal((await productionRoute.DELETE(json('DELETE', P, agent), params({ id: production.id }))).status, 204);
assert.equal([...documents.keys()].filter((k) => k.startsWith('productions/')).length, 0);

console.log(JSON.stringify({ passed: true, assertions: 'scopes, server-side anchors, claims and heartbeats, context bundle, options and rounds, timed replies on previews and cuts, accept/reject/apply and statuses, decisions, ownership, cascade delete' }));
