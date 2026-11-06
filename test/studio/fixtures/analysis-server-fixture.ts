// Executed in an isolated process so SDK mocks cannot affect other tests.
import { mock } from 'bun:test';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    return { empty: entries.length === 0, docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction(run: (tx: any) => Promise<any>) {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = []; let writing = false;
  try { const result = await run({ get: (ref: Ref) => { assert(!writing, 'Read after write in transaction'); return ref.get(); }, set: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.set(data)); }, update: (ref: Ref, data: any) => { writing = true; writes.push(() => ref.update(data)); } }); for (const write of writes) await write(); return result; }
  finally { release(); }
} };
const bucket = { file(path: string) { return { async save(bytes: Buffer) { files.set(path, Buffer.from(bytes)); }, async download() { assert(files.has(path), 'Missing storage object'); return [files.get(path)]; },
  async delete() { files.delete(path); },
  async getMetadata() { assert(files.has(path), 'Missing storage object'); return [{ size: String(files.get(path)!.length) }]; },
  createReadStream(range: { start?: number; end?: number } = {}) { return Readable.from([files.get(path)!.subarray(range.start ?? 0, range.end === undefined ? undefined : range.end + 1)]); } }; } };

// A real three-second movie, so clip extraction runs ffmpeg exactly as it does in Studio.
const directory = await mkdtemp(join(tmpdir(), 'mdmedia-analysis-test-'));
let movie: Buffer;
try {
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', join(directory, 'movie.mp4')]);
  movie = await readFile(join(directory, 'movie.mp4'));
} finally { await rm(directory, { recursive: true, force: true }); }

// Gemini: `create` is the paid call; `get` reads a receipt. A `get` before the receipt is saved fails the run.
let creates = 0, gets = 0, uploads = 0, streams = 0;
let mode: 'ok' | 'reject' | 'network' | 'failed' = 'ok';
let createStatus: 'completed' | 'in_progress' = 'completed';
let answerPad = 0;
let hold: Promise<void> | null = null; let release!: () => void;
const payloads: any[] = [];
const jsonAnswer = '{"shots":[{"start":"00:01","description":"A red train arrives."},{"start":"00:02","description":"It leaves."}]}';
const answer = () => `# Shot list\n\n- **00:01** A red [train](https://example.test) arrives.\n- 00:02 It leaves.\n${'x'.repeat(answerPad)}`;
const completed = (id: string) => ({ id, status: 'completed', output_text: answer(), usage: { total_input_tokens: 100, total_output_tokens: 20, total_tokens: 120 },
  steps: [{ type: 'thought', summary: [{ type: 'text', text: 'Looking at frames' }] }] });
const client = {
  interactions: {
    async create(payload: any, options: any) {
      creates++; payloads.push(payload); assert.equal(options.maxRetries, 0); assert.equal(payload.background, true); if (hold) await hold;
      if (mode === 'reject') throw Object.assign(new Error('SECRET provider refusal'), { status: 400 });
      if (mode === 'network') throw new Error('SECRET network failure');
      const id = `interaction-${creates}`;
      return createStatus === 'in_progress' ? { id, status: 'in_progress' } : mode === 'failed' ? { id, status: 'failed', error: { message: 'SECRET' } }
        : payload.response_format ? { ...completed(id), output_text: jsonAnswer } : completed(id);
    },
    async get(id: string, params?: any) {
      // A stream of the running interaction is how progress arrives; it is not a poll.
      if (params?.stream) {
        streams++;
        return (async function* () { yield { event_type: 'step.delta', index: 1, delta: { type: 'thought_summary', content: { type: 'text', text: '**Looking at frames**\n\nScanning the opening.' } } }; })();
      }
      gets++;
      assert([...documents.values()].some(doc => doc.type === 'analysis' && doc.interactionId === id), 'Polled before the receipt was saved');
      return completed(id);
    },
  },
  files: {
    async upload({ config }: any) { uploads++; return { name: 'files/upload-1', state: 'ACTIVE', uri: 'https://generativelanguage.example/files/upload-1', mimeType: config.mimeType }; },
    async get({ name }: any) { return { name, state: 'ACTIVE', uri: `https://generativelanguage.example/${name}`, mimeType: 'video/mp4' }; },
  },
};
const narrationCalls: any[] = [];
let narrationOutcome: 'ok' | 'refused' = 'ok';
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, adminBucket: () => bucket, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer test-session' ? { uid: 'owner', email: 'owner@example.test' } : null,
  verifyIdToken: async () => null, adminAuth: () => ({}) }));
mock.module('../../../studio/src/lib/narration-start', () => ({
  async startNarration(args: any) {
    narrationCalls.push(structuredClone({ uid: args.uid, request: args.request, source: args.source }));
    if (narrationOutcome === 'refused') return { ok: false, status: 403, code: 'voice_not_allowed', message: 'You do not have access to that voice.' };
    documents.set(`narrations/${args.request.id}`, { id: args.request.id, ownerUid: args.uid, source: args.source, status: 'streaming' });
    return { ok: true, id: args.request.id, stream: new ReadableStream() };
  },
}));
const ttsEntry = Bun.resolveSync('mdmedia/tts', fileURLToPath(new URL('../../../studio/src/lib/', import.meta.url)));
mock.module(join(dirname(ttsEntry), 'gemini-client-factory.js'), () => ({ NodeEnvProvider: class {}, createGeminiClient: () => client }));
process.env.GEMINI_API_KEY = 'test-only-placeholder';

const server = await import('../../../studio/src/lib/analysis-server');
const { readUploadBytes } = await import('../../../studio/src/lib/assets-server');
const { listMedia, listGenerations } = await import('../../../studio/src/lib/media-catalog-server');
const { MediaError } = await import('../../../studio/src/lib/image-request');
const { generateApiKey } = await import('../../../studio/src/lib/api-key-token');
const analysesRoute = await import('../../../studio/src/app/api/v1/analyses/route');
const analysisRoute = await import('../../../studio/src/app/api/v1/analyses/[id]/route');
const generationsRoute = await import('../../../studio/src/app/api/v1/analyses/[id]/generations/route');
const generationRoute = await import('../../../studio/src/app/api/v1/generations/[id]/route');
const assetRoute = await import('../../../studio/src/app/api/v1/assets/[id]/content/route');
const uploadRoute = await import('../../../studio/src/app/api/v1/assets/route');
const { readMp4Duration } = await import('../../../src/video/mp4-duration');
const uid = 'owner'; const session = 'test-session'; const origin = 'https://studio.test';
const user = { kind: 'user' as const, uid, email: 'owner@example.test' };
const youtube = { kind: 'youtube', url: 'https://www.youtube.com/watch?v=9hE5-98ZeCg' };

const keys: Record<string, string> = {};
for (const [name, scopes] of Object.entries({
  createOnly: ['analyses:create', 'analyses:read'], withVideo: ['analyses:create', 'analyses:read', 'videos:read'],
  withNarration: ['analyses:create', 'analyses:read', 'narrations:create'], old: ['videos:read', 'images:read'],
})) { const key = generateApiKey(); keys[name] = key.token; documents.set(`apiKeys/${key.keyId}`, { ownerUid: uid, ownerEmail: 'owner@example.test', hash: key.hash, scopes, revokedAt: null }); }
let keySeq = 0;
const post = (path: string, body: unknown, token = session, key = `analysis-key-${++keySeq}-x`) => new Request(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
const get = (path: string, token = session) => new Request(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const createAnalysis = async (body: unknown, token = session, key?: string) => analysesRoute.POST(post('/api/v1/analyses', body, token, key));
async function created(response: Response) { const json = await response.json(); assert.equal(response.status, 202, JSON.stringify(json)); return json; }
async function waitFor(id: string, predicate: (job: any) => boolean) {
  for (let i = 0; i < 2000; i++) { await server.processAnalysisJobs(); const job = documents.get(`mediaGenerations/${id}`); if (job && predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out ${id}: ${JSON.stringify(documents.get(`mediaGenerations/${id}`))}`);
}
const settled = (id: string) => waitFor(id, job => !['queued', 'generating'].includes(job.status));
const analysisItems = () => [...documents.keys()].filter(path => path.startsWith('mediaItems/analysis_')).length;
const errorCode = async (response: Response) => (await response.json()).error?.code;

// Concurrent duplicates reserve one attempt; a YouTube link passes straight through as a video part.
hold = new Promise(resolve => { release = resolve; });
const firstBody = { prompt: '# Shot list\nList every shot with MM:SS.', source: youtube };
const duplicates = await Promise.all(Array.from({ length: 4 }, () => createAnalysis(firstBody, session, 'first-key-12345')));
const firstAccepted = await Promise.all(duplicates.map(created));
assert.equal(new Set(firstAccepted.map(value => value.generation.id)).size, 1);
const first = firstAccepted[0];
assert.equal(first.type, 'analysis');
// Held inside the paid create: the attempt is running and its receipt is not back yet.
await waitFor(first.generation.id, () => creates === 1);
assert.equal(creates, 1);
assert.equal(await errorCode(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'Again' }), params(first.id))), 'generation_in_progress');
assert.equal(await errorCode(await createAnalysis({ ...firstBody, prompt: 'Different' }, session, 'first-key-12345')), 'idempotency_conflict');
release(); hold = null;
const firstJob = await settled(first.generation.id);
assert.equal(firstJob.status, 'ready'); assert.equal(firstJob.interactionId, 'interaction-1');
assert.deepEqual(payloads[0].input[0], { type: 'video', uri: youtube.url }); assert.equal(payloads[0].input[1].text, firstBody.prompt); assert.equal(payloads[0].model, 'gemini-3.8-flash');
assert.match(payloads[0].system_instruction, /well-structured Markdown document/);
const ready = await (await analysisRoute.GET(get(`/api/v1/analyses/${first.id}`), params(first.id))).json();
assert.equal(ready.result.id, first.generation.id); assert.equal(ready.result.assets[0].mimeType, 'text/markdown');
assert.deepEqual(ready.result.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120 }); assert.deepEqual(ready.result.trace, ['Looking at frames']);
assert.equal(ready.result.interactionId, 'interaction-1'); assert.equal(ready.result.narrationId, null);
assert.equal(ready.sourcePreview, 'Shot list 00:01 A red train arrives. 00:02 It leaves.');
assert(!JSON.stringify(ready).includes('ownerUid')); assert(!JSON.stringify(ready).includes('media/owner')); assert(!JSON.stringify(ready).includes('SECRET'));
const content = await assetRoute.GET(get(`/api/v1/assets/${ready.result.assets[0].id}/content`), params(ready.result.assets[0].id));
assert.equal(content.status, 200); assert.equal(content.headers.get('content-type'), 'text/markdown; charset=utf-8'); assert.equal(await content.text(), answer().trim());
const download = await assetRoute.GET(get(`/api/v1/assets/${ready.result.assets[0].id}/content?download=1`), params(ready.result.assets[0].id));
assert.match(download.headers.get('content-disposition')!, /\.md"$/);
const replay = await created(await createAnalysis(firstBody, session, 'first-key-12345'));
assert.equal(replay.replayed, true); assert.equal(replay.generation.id, first.generation.id); assert.equal(creates, 1);

// The receipt is saved before the first poll (the fake `get` asserts it).
createStatus = 'in_progress';
const polled = await created(await createAnalysis({ prompt: 'Summarize', source: youtube }));
// While it runs, the latest step is on the generation as one plain line; it is cleared when the attempt ends.
await waitFor(polled.generation.id, job => job.progress === 'Looking at frames');
assert.equal((await (await generationRoute.GET(get(`/api/v1/generations/${polled.generation.id}`), params(polled.generation.id))).json()).progress, 'Looking at frames');
const polledJob = await settled(polled.generation.id);
assert.equal(polledJob.status, 'ready'); assert.equal(polledJob.progress, null); assert.equal(gets, 1); assert.equal(streams, 1);
assert.deepEqual(payloads.at(-1).generation_config, { thinking_summaries: 'auto' });
assert.equal((await (await generationRoute.GET(get(`/api/v1/generations/${polled.generation.id}`), params(polled.generation.id))).json()).progress, null);
createStatus = 'completed';

// Uploads: raw video bytes, the provider's MIME types, a size cap. Small videos go inline; big ones through the Files API.
const upload = (bytes: Uint8Array, type = 'video/mp4', token = session) => uploadRoute.POST(new Request(`${origin}/api/v1/assets?media=analysis`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: bytes }));
const small = await upload(movie);
assert.equal(small.status, 201); const smallAsset = await small.json();
assert.equal(documents.get(`mediaAssets/${smallAsset.id}`)!.mediaType, 'analysis'); assert.equal(documents.get(`mediaAssets/${smallAsset.id}`)!.purpose, 'reference');
assert(Math.abs(smallAsset.durationMs - 3000) < 100);
assert.equal(await errorCode(await upload(movie, 'image/png')), 'unsupported_video');
assert.equal((await upload(movie, 'video/mp4', keys.old)).status, 403);
const tooLarge = () => new MediaError(413, 'video_too_large', 'too large'); const missing = () => new MediaError(400, 'missing_video', 'missing');
await assert.rejects(readUploadBytes(new Request(origin, { method: 'POST', body: new Uint8Array(11) }), 10, tooLarge, missing), { code: 'video_too_large' });
await assert.rejects(readUploadBytes(new Request(origin, { method: 'POST', headers: { 'content-length': '11' }, body: new Uint8Array(1) }), 10, tooLarge, missing), { code: 'video_too_large' });
await assert.rejects(readUploadBytes(new Request(origin, { method: 'POST', body: new Uint8Array(0) }), 10, tooLarge, missing), { code: 'missing_video' });
assert.equal((await readUploadBytes(new Request(origin, { method: 'POST', body: new Uint8Array(10) }), 10, tooLarge, missing)).length, 10);
const inline = await created(await createAnalysis({ prompt: 'Describe it', source: { kind: 'asset', assetId: smallAsset.id }, mediaResolution: 'low', processing: { mode: 'static', fps: 2 } }));
assert.equal((await settled(inline.generation.id)).status, 'ready');
assert.equal(Buffer.from(payloads.at(-1).input[0].data, 'base64').compare(movie), 0); assert.equal(payloads.at(-1).input[0].mime_type, 'video/mp4');
assert.equal(payloads.at(-1).input[0].resolution, 'low'); assert.deepEqual(payloads.at(-1).input[0].processing, { type: 'static', fps: 2 }); assert.equal(uploads, 0);
const big = await upload(new Uint8Array(21 * 1024 * 1024));
const bigAsset = await big.json();
const viaFiles = await created(await createAnalysis({ prompt: 'Describe it', source: { kind: 'asset', assetId: bigAsset.id } }));
assert.equal((await settled(viaFiles.generation.id)).status, 'ready');
assert.equal(uploads, 1); assert.equal(payloads.at(-1).input[0].uri, 'https://generativelanguage.example/files/upload-1'); assert.equal(payloads.at(-1).input[0].data, undefined);
assert(!JSON.stringify(documents.get(`mediaGenerations/${viaFiles.generation.id}`)).includes('generativelanguage'), 'File URIs are temporary and never stored');
documents.set('mediaAssets/foreign-video', { id: 'foreign-video', ownerUid: 'other', mediaType: 'analysis', purpose: 'reference', mimeType: 'video/mp4', path: 'x' });
assert.equal(await errorCode(await createAnalysis({ prompt: 'x', source: { kind: 'asset', assetId: 'foreign-video' } })), 'source_not_found');

// A Studio video: reading it needs videos:read as well, checked before acceptance; clips are extracted locally.
documents.set('mediaItems/video_v1', { id: 'v1', type: 'video', ownerUid: uid, title: 'Train', status: 'ready', latestGenerationId: 'vgen1', latestSuccessfulGenerationId: 'vgen1' });
documents.set('mediaGenerations/vgen1', { id: 'vgen1', type: 'video', ownerUid: uid, itemId: 'v1', status: 'ready', assetId: 'video_vgen1', parentGenerationId: null, clipNumber: 1, parentDurationSeconds: 0, durationSeconds: 3, clipAssetId: null });
documents.set('mediaAssets/video_vgen1', { id: 'video_vgen1', ownerUid: uid, mediaType: 'video', purpose: 'output', path: `media/${uid}/video_vgen1/original`, thumbnailPath: '', mimeType: 'video/mp4', durationMs: 3000, generationId: 'vgen1', itemId: 'v1' });
files.set(`media/${uid}/video_vgen1/original`, movie);
const itemsBefore = analysisItems();
const fromVideoBody = { prompt: 'What happens?', source: { kind: 'video', videoItemId: 'v1' } };
assert.equal(await errorCode(await createAnalysis(fromVideoBody, keys.createOnly)), 'insufficient_scope');
assert.equal(analysisItems(), itemsBefore);
const fromVideo = await created(await createAnalysis(fromVideoBody, keys.withVideo));
assert.equal(fromVideo.generation.request.source.generationId, 'vgen1');
assert.equal((await settled(fromVideo.generation.id)).status, 'ready'); assert.equal(Buffer.from(payloads.at(-1).input[0].data, 'base64').compare(movie), 0);
const fromClip = await created(await createAnalysis({ prompt: 'This clip?', source: { kind: 'video', videoItemId: 'v1', clip: 1 } }));
assert.equal((await settled(fromClip.generation.id)).status, 'ready');
assert(Math.abs(readMp4Duration(Buffer.from(payloads.at(-1).input[0].data, 'base64'))! - 3) < 0.2);
assert.equal(await errorCode(await createAnalysis({ prompt: 'x', source: { kind: 'video', videoItemId: 'v1', clip: 2 } })), 'invalid_clip');
await assert.rejects(server.submitAnalysis('other', await server.prepareAnalysis({ kind: 'user', uid: 'other', email: 'o@example.test' }, fromVideoBody, null), fromVideoBody, 'other-key-12345', null), { code: 'not_found' });

// Validation happens before acceptance.
for (const [body, code] of [
  [{ ...firstBody, extra: true }, 'unknown_fields'], [{ prompt: 'x' }, 'missing_source'], [{ prompt: '', source: youtube }, 'invalid_prompt'],
  [{ prompt: 'x', source: { kind: 'youtube', url: 'https://vimeo.com/1' } }, 'invalid_analysis'],
  [{ prompt: 'x', source: youtube, processing: { mode: 'agentic', fps: 1 } }, 'invalid_analysis'],
  [{ prompt: 'x', source: youtube, model: 'gemini-2.5-flash', processing: { mode: 'agentic' } }, 'invalid_analysis'],
  [{ prompt: 'x', source: youtube, mediaResolution: 'huge' }, 'invalid_media_resolution'],
  [{ prompt: 'x', source: youtube, previousInteractionId: 'interaction-1' }, 'follow_up_needs_item'],
] as const) assert.equal(await errorCode(await createAnalysis(body)), code, JSON.stringify(body));

// A failed re-run never replaces the last good result.
mode = 'reject';
const rejected = await created(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'Only the second half' }), params(first.id)));
const rejectedJob = await settled(rejected.generation.id);
assert.equal(rejectedJob.error.code, 'provider_rejected'); assert(!JSON.stringify(rejectedJob).includes('SECRET'));
assert.deepEqual(rejectedJob.request.source, youtube, 'A re-run keeps the earlier source');
const afterReject = await server.analysisResource(uid, first.id, origin);
assert.equal(afterReject.result!.id, first.generation.id); assert.equal(afterReject.latestGeneration.status, 'error');
mode = 'failed';
const failed = await created(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'Try again' }), params(first.id)));
assert.equal((await settled(failed.generation.id)).error.code, 'analysis_failed');
mode = 'ok';

// Follow-ups reuse Gemini's context for this item's own receipts only, and send no video.
const followUp = await created(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'And the second shot?', previousInteractionId: 'interaction-1' }), params(first.id)));
assert.equal((await settled(followUp.generation.id)).status, 'ready');
assert.equal(payloads.at(-1).previous_interaction_id, 'interaction-1'); assert.equal(payloads.at(-1).input.length, 1); assert.equal(payloads.at(-1).input[0].type, 'text');
assert.equal(await errorCode(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'x', previousInteractionId: documents.get(`mediaGenerations/${polled.generation.id}`)!.interactionId }), params(first.id))), 'follow_up_not_found');
assert.equal(await errorCode(await generationsRoute.POST(post(`/api/v1/analyses/${first.id}/generations`, { prompt: 'x', previousInteractionId: 'interaction-1', source: youtube }), params(first.id))), 'invalid_follow_up');

// Structured output: a schema asks Gemini for JSON, which is stored and served as JSON. Follow-ups keep the schema; null returns to Markdown.
const schema = { type: 'object', properties: { shots: { type: 'array', items: { type: 'object', properties: { start: { type: 'string' }, description: { type: 'string' } } } } }, required: ['shots'] };
for (const responseSchema of [[], 'shots', { enum: [[1, 2]] }, { description: 'x'.repeat(32_001) }]) {
  assert.equal(await errorCode(await createAnalysis({ prompt: 'x', source: youtube, responseSchema })), 'invalid_response_schema', JSON.stringify(responseSchema).slice(0, 40));
}
assert.equal(await errorCode(await createAnalysis({ prompt: 'x', source: youtube, responseSchema: schema, narrate: true })), 'invalid_narrate');
const structured = await created(await createAnalysis({ prompt: 'Shots as JSON', source: youtube, responseSchema: schema }));
assert.equal((await settled(structured.generation.id)).status, 'ready');
assert.deepEqual(payloads.at(-1).response_format, { type: 'text', mime_type: 'application/json', schema });
assert.equal(payloads.at(-1).system_instruction, undefined);
const structuredItem = await (await analysisRoute.GET(get(`/api/v1/analyses/${structured.id}`), params(structured.id))).json();
assert.equal(structuredItem.result.assets[0].mimeType, 'application/json'); assert.deepEqual(structuredItem.request.responseSchema, schema);
assert.equal(structuredItem.sourcePreview, '00:01 · A red train arrives. · 00:02 · It leaves.');
const jsonAsset = structuredItem.result.assets[0].id;
const jsonContent = await assetRoute.GET(get(`/api/v1/assets/${jsonAsset}/content`), params(jsonAsset));
assert.equal(jsonContent.headers.get('content-type'), 'application/json; charset=utf-8'); assert.deepEqual(JSON.parse(await jsonContent.text()), JSON.parse(jsonAnswer));
assert.match((await assetRoute.GET(get(`/api/v1/assets/${jsonAsset}/content?download=1`), params(jsonAsset))).headers.get('content-disposition')!, /\.json"$/);
const structuredFollowUp = await created(await generationsRoute.POST(post(`/api/v1/analyses/${structured.id}/generations`, { prompt: 'Only the first?', previousInteractionId: structuredItem.result.interactionId }), params(structured.id)));
assert.equal((await settled(structuredFollowUp.generation.id)).status, 'ready'); assert.deepEqual(payloads.at(-1).response_format.schema, schema);
const markdownAgain = await created(await generationsRoute.POST(post(`/api/v1/analyses/${structured.id}/generations`, { prompt: 'Describe it', responseSchema: null }), params(structured.id)));
assert.equal((await settled(markdownAgain.generation.id)).status, 'ready'); assert.equal(payloads.at(-1).response_format, undefined);
assert.equal((await (await analysisRoute.GET(get(`/api/v1/analyses/${structured.id}`), params(structured.id))).json()).result.assets[0].mimeType, 'text/markdown');
const history = await (await generationsRoute.GET(get(`/api/v1/analyses/${first.id}/generations`), params(first.id))).json();
assert.equal(history.items.length, 4);

// Lease recovery reads the receipt or the saved answer and never pays twice; with neither, it stops.
const template = documents.get(`mediaGenerations/${first.generation.id}`)!;
const abandon = (id: string, patch: Record<string, unknown>) => {
  const job = { ...template, id, itemId: `item-${id}`, status: 'generating', phase: 'analyzing', assetId: null, leaseToken: 'old', leaseUntil: 1, ...patch };
  documents.set(`mediaGenerations/${id}`, job); documents.set(`mediaActivity/${id}`, { id, status: 'generating' });
  documents.set(`mediaItems/analysis_item-${id}`, { ...documents.get(`mediaItems/analysis_${first.id}`), id: `item-${id}`, latestGenerationId: id, latestSuccessfulGenerationId: null, status: 'generating' });
};
const createsBefore = creates, getsBefore = gets;
abandon('recover-receipt', { interactionId: 'interaction-1' });
assert.equal((await settled('recover-receipt')).status, 'ready'); assert.equal(creates, createsBefore); assert.equal(gets, getsBefore + 1);
abandon('recover-unknown', { interactionId: null });
const unknown = await settled('recover-unknown'); assert.equal(unknown.status, 'interrupted'); assert.equal(unknown.error.code, 'generation_interrupted'); assert.equal(creates, createsBefore);
abandon('recover-saved', { interactionId: null });
documents.set('mediaAssets/analysis_recover-saved', { ...documents.get(`mediaAssets/analysis_${first.generation.id}`), id: 'analysis_recover-saved', generationId: 'recover-saved', path: 'media/owner/analysis_recover-saved/original' });
files.set('media/owner/analysis_recover-saved/original', Buffer.from('# Saved before the crash'));
assert.equal((await settled('recover-saved')).status, 'ready'); assert.equal(creates, createsBefore); assert.equal(gets, getsBefore + 1);
assert.equal(documents.get('mediaItems/analysis_item-recover-saved')!.sourcePreview, 'Saved before the crash');

// narrate: validated with its scopes before the paid analysis runs.
const itemsBeforeNarrate = analysisItems();
for (const [narrate, token, code] of [
  [true, keys.createOnly, 'insufficient_scope'], [{ markdown: 'x' }, session, 'invalid_narrate'], [{ id: 'my-narration-1' }, session, 'invalid_narrate'],
  [{ tone: 'calm' }, session, 'unknown_fields'], [{ voice: 'Nobody' }, session, 'invalid_voice'], [{ visibility: 'public' }, keys.withNarration, 'visibility_not_allowed'],
  [{ playlist: 'Lectures' }, keys.withNarration, 'insufficient_scope'], ['yes', session, 'invalid_narrate'],
] as const) assert.equal(await errorCode(await createAnalysis({ prompt: 'x', source: youtube, narrate }, token)), code, JSON.stringify(narrate));
assert.equal(analysisItems(), itemsBeforeNarrate); assert.equal(narrationCalls.length, 0);

// After the answer is saved, one narration starts from it with a deterministic id and provenance.
const narrated = await created(await createAnalysis({ prompt: 'Script this', source: youtube, narrate: { voice: 'Puck' } }, keys.withNarration));
assert.equal(narrated.generation.narrationId, `narr_${narrated.generation.id}`);
const narratedJob = await settled(narrated.generation.id);
assert.equal(narratedJob.status, 'ready'); assert.equal(narratedJob.narrationError, null); assert.equal(narrationCalls.length, 1);
assert.deepEqual(narrationCalls[0].source, { kind: 'analysis', analysisId: narrated.id, generationId: narrated.generation.id });
assert.equal(narrationCalls[0].request.id, `narr_${narrated.generation.id}`); assert.equal(narrationCalls[0].request.markdown, answer().trim());
assert.equal(narrationCalls[0].request.voice, 'Puck'); assert.equal(narrationCalls[0].request.visibility, 'private');
assert.equal(narratedJob.narration.request.voice, 'Puck', 'The resolved narration options are snapshotted on the generation');
// Recovery of the same attempt finds the narration and never starts another.
documents.set(`mediaGenerations/${narrated.generation.id}`, { ...narratedJob, status: 'generating', leaseToken: 'old', leaseUntil: 1 });
assert.equal((await settled(narrated.generation.id)).status, 'ready'); assert.equal(narrationCalls.length, 1); assert.equal(creates, createsBefore + 1);
// A refused narration and an answer over the narration limit leave the analysis ready.
narrationOutcome = 'refused';
const refused = await created(await createAnalysis({ prompt: 'Script this', source: youtube, narrate: true }));
const refusedJob = await settled(refused.generation.id);
assert.equal(refusedJob.status, 'ready'); assert.equal(refusedJob.narrationError.code, 'voice_not_allowed'); assert.equal(narrationCalls.length, 2);
narrationOutcome = 'ok'; answerPad = 200_001;
const long = await created(await createAnalysis({ prompt: 'Everything', source: youtube, narrate: true }));
const longJob = await settled(long.generation.id);
assert.equal(longJob.status, 'ready'); assert.equal(longJob.narrationError.code, 'narration_too_long'); assert.equal(narrationCalls.length, 2);
answerPad = 0;

// Catalog, activity, generation and asset reads include analyses only with analyses:read; old keys gain nothing.
const keyCaller = (scopes: string[]) => ({ kind: 'apiKey' as const, uid, keyId: 'key', scopes: scopes as any });
const catalog = await listMedia(keyCaller(['analyses:read']), new URL(`${origin}/api/v1/media`));
assert(catalog.items.length > 0 && catalog.items.every(item => item.type === 'analysis'));
assert((await listMedia(keyCaller(['videos:read']), new URL(`${origin}/api/v1/media`))).items.every(item => item.type !== 'analysis'));
await assert.rejects(listMedia(keyCaller(['videos:read']), new URL(`${origin}/api/v1/media?type=analysis`)), { code: 'insufficient_scope' });
assert((await listGenerations(keyCaller(['analyses:read']), new URL(`${origin}/api/v1/generations?type=analysis`))).items.some(item => item.id === first.generation.id));
await assert.rejects(listGenerations(keyCaller(['videos:read']), new URL(`${origin}/api/v1/generations?type=analysis`)), { code: 'insufficient_scope' });
assert.equal((await generationRoute.GET(get(`/api/v1/generations/${first.generation.id}`, keys.old), params(first.generation.id))).status, 403);
assert.equal((await generationRoute.GET(get(`/api/v1/generations/${first.generation.id}`, keys.createOnly), params(first.generation.id))).status, 200);
assert.equal((await assetRoute.GET(get(`/api/v1/assets/${ready.result.assets[0].id}/content`, keys.old), params(ready.result.assets[0].id))).status, 403);
assert.equal((await analysesRoute.GET(get('/api/v1/analyses', keys.old))).status, 403);
assert.equal((await analysesRoute.GET(get('/api/v1/analyses', keys.createOnly))).status, 200);

// Small helpers.
assert.equal(server.narrationIdFor('abcdefghijklmnopqrst'), 'narr_abcdefghijklmnopqrst');
assert.match(server.narrationIdFor('x'), /^narr_[0-9a-f]{40}$/);
assert.equal(server.markdownExcerpt('```js\ncode\n```\n> quote', 9), 'code quo…');
assert.equal(server.jsonExcerpt('{"a":["One", 2, {"b": true}]}'), 'One · 2 · true'); assert.equal(server.jsonExcerpt('{}'), '{}');
// Progress writes keep only the newest line, at most one per interval, capped; stop drops the rest.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const progressWrites: string[] = []; const writer = server.progressWriter(async line => { progressWrites.push(line); }, 30);
writer.report('First'); writer.report('Second'); writer.report('Third\n line');
assert.deepEqual(progressWrites, ['First']); await sleep(60); assert.deepEqual(progressWrites, ['First', 'Third line']);
writer.report('x'.repeat(400)); await sleep(60); assert.equal(progressWrites.at(-1)!.length, 160);
writer.report('Kept'); writer.report('Dropped'); writer.stop(); await sleep(60); assert.equal(progressWrites.at(-1), 'Kept'); assert(!progressWrites.includes('Dropped'));
console.log(JSON.stringify({ passed: true, creates, gets, uploads, narrations: narrationCalls.length }));
