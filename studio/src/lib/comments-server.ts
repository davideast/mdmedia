/**
 * Review comments on a production's cuts, for `/api/v1`, through the Admin
 * SDK and scoped to one owner.
 *
 *   productions/{id}/threads/{threadId}                         a Thread, plus { ownerUid, cutId }
 *   productions/{id}/threads/{threadId}/messages/{messageId}    a Message, plus { ownerUid, productionId }
 *   productions/{id}/threads/{threadId}/suggestions/{id}        a Suggestion, plus { ownerUid, productionId }
 *   productions/{id}/decisions/{decisionId}                     a Decision, plus { ownerUid, productionId }
 *   commentAgents/{id}                                          an AgentHeartbeat, plus { ownerUid }
 *
 * The shapes are `mdmedia/threads`'. Owners read them live with the client
 * SDK; every write comes through here, because only the server can anchor a
 * comment on the resolved cut, check that previews are the owner's media, and
 * keep a thread's status in step with what was said.
 *
 * Status follows the conversation: the owner's comment or reply, or an
 * accepted option, leaves a thread `open` for an agent; an agent's claim makes
 * it `in-progress`; an agent's reply, options or applied version make it
 * `addressed`. Anyone with `comments:write` may set it outright.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from 'firebase-admin/firestore';
import {
  anchorAt,
  CLAIM_MS,
  DECISION_SOURCES,
  optionLetter,
  overlaysAt,
  statusLine,
  SUGGESTION_STATES,
  THREAD_STATUSES,
  wordsAround,
  type AgentHeartbeat,
  type Decision,
  type DecisionSource,
  type Message,
  type Preview,
  type Suggestion,
  type SuggestionCheck,
  type SuggestionState,
  type Thread,
  type ThreadStatus,
  type TimedRef,
} from 'mdmedia/threads';
import { apiError, type Caller } from './api-auth';
import { num, readDecision, readMessage, readSuggestion, readThread } from './comments-shape';
import { adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import { loadOwnedAssets } from './production-media-server';
import { getProduction, getProductionCut, ProductionError, productionErrorResponse, type ProductionDetail } from './productions-server';

const MAX_TEXT = 20_000;
const MAX_TITLE = 300;
const MAX_ITEMS = 60;
const MAX_ITEM_TEXT = 6000;
const MAX_CHECKS_BYTES = 200_000;
const MAX_PREVIEWS = 12;
const MAX_SUGGESTIONS = 12;
const MAX_THREADS = 500;
const AGENT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const CUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export class CommentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CommentError';
  }
}

/** Runs a comments route: its errors and the productions' become their responses, anything unexpected a plain 500. */
export async function commentsApi(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommentError) return apiError(error.status, error.code, error.message);
    if (error instanceof ProductionError) return productionErrorResponse(error);
    if (error instanceof MediaError) return apiError(error.status, error.code, error.message);
    console.error('[comments] Request failed:', error instanceof Error ? error.message : 'unknown');
    return apiError(500, 'comments_unavailable', 'Studio could not complete that request. Try again.');
  }
}

const invalid = (code: string, message: string) => new CommentError(400, code, message);
const threadNotFound = () => new CommentError(404, 'thread_not_found', 'This production has no such thread.');

// ---------------------------------------------------------------------------
// Paths and ids

const db = () => adminDb();
const threadsOf = (productionId: string) => db().collection(`productions/${productionId}/threads`);
const messagesOf = (productionId: string, threadId: string) => db().collection(`productions/${productionId}/threads/${threadId}/messages`);
const suggestionsOf = (productionId: string, threadId: string) => db().collection(`productions/${productionId}/threads/${threadId}/suggestions`);
const decisionsOf = (productionId: string) => db().collection(`productions/${productionId}/decisions`);
const agents = () => db().collection('commentAgents');

/** Ids that sort by time and never collide: `th…`, `m…`, `s…`, `d…`. */
export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}${now.toString(36)}${randomBytes(5).toString('hex')}`;
}

/** The author a caller writes as: the signed-in owner, or an agent named in the request (default `agent`). */
export function authorOf(caller: Caller, agent: unknown): string {
  if (caller.kind === 'user') return 'owner';
  return `agent:${agentName(agent ?? 'agent')}`;
}

function agentName(value: unknown): string {
  if (typeof value !== 'string' || !AGENT.test(value)) throw invalid('invalid_agent', 'agent must be a short name: lowercase letters, digits and "-", like "editor".');
  return value;
}

const isAgent = (author: string) => author.startsWith('agent:');

/** Strips undefined fields: Firestore refuses them. */
function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Resources

export interface ThreadResource extends Thread {
  /** The thread's one status line, as Studio shows it. */
  statusLine: { tone: string; text: string };
  /** True when an agent should pick it up: open, or in progress with no live claim. */
  needsAgent: boolean;
  links: { self: string; context: string };
}

export interface ThreadDetail {
  thread: ThreadResource;
  messages: Message[];
  suggestions: Suggestion[];
}

const cutLabeller = (production: ProductionDetail) => (cutId: string) => {
  const label = production.cuts.find((cut) => cut.id === cutId)?.label ?? cutId;
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
};

function threadResource(thread: Thread, suggestions: Suggestion[], production: ProductionDetail, origin: string, now = Date.now()): ThreadResource {
  const self = `${origin}/api/v1/productions/${thread.productionId}/threads/${thread.id}`;
  const claimed = Boolean(thread.claim && thread.claim.expiresAt > now);
  return {
    ...thread,
    statusLine: statusLine(thread, suggestions, cutLabeller(production), now),
    needsAgent: thread.status === 'open' || (thread.status === 'in-progress' && !claimed),
    links: { self, context: `${self}/context` },
  };
}

async function ownedThread(uid: string, productionId: string, threadId: string, tx?: Transaction): Promise<{ ref: FirebaseFirestore.DocumentReference; thread: Thread }> {
  if (!ID.test(threadId)) throw threadNotFound();
  const ref = threadsOf(productionId).doc(threadId);
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  const data = snapshot.data();
  if (!snapshot.exists || data?.ownerUid !== uid) throw threadNotFound();
  return { ref, thread: readThread(threadId, data) };
}

async function listSuggestions(uid: string, productionId: string, threadId: string): Promise<Suggestion[]> {
  const snapshot = await suggestionsOf(productionId, threadId).where('ownerUid', '==', uid).get();
  return snapshot.docs.map((doc) => readSuggestion(doc.id, doc.data())).sort((a, b) => a.round - b.round || a.letter.localeCompare(b.letter));
}

async function listMessages(uid: string, productionId: string, threadId: string): Promise<Message[]> {
  const snapshot = await messagesOf(productionId, threadId).where('ownerUid', '==', uid).get();
  return snapshot.docs.map((doc) => readMessage(doc.id, doc.data())).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Threads

/** The production's threads, or one cut's, in timeline order; `needsAgent` lists only those an agent should pick up. */
export async function listThreads(uid: string, productionId: string, origin: string, filter: { cutId?: string | null; needsAgent?: boolean } = {}): Promise<ThreadResource[]> {
  const production = await getProduction(uid, productionId, origin);
  const snapshot = await threadsOf(productionId).where('ownerUid', '==', uid).limit(MAX_THREADS).get();
  const threads = snapshot.docs.map((doc) => readThread(doc.id, doc.data())).filter((t) => !filter.cutId || t.version.cutId === filter.cutId);
  const resources = await Promise.all(threads.map(async (t) => threadResource(t, await listSuggestions(uid, productionId, t.id), production, origin)));
  return resources
    .filter((t) => !filter.needsAgent || t.needsAgent)
    .sort((a, b) => a.version.cutId.localeCompare(b.version.cutId) || a.anchor.time - b.anchor.time || a.createdAt - b.createdAt);
}

export async function getThread(uid: string, productionId: string, threadId: string, origin: string): Promise<ThreadDetail> {
  const production = await getProduction(uid, productionId, origin);
  const { thread } = await ownedThread(uid, productionId, threadId);
  const [messages, suggestions] = await Promise.all([listMessages(uid, productionId, threadId), listSuggestions(uid, productionId, threadId)]);
  return { thread: threadResource(thread, suggestions, production, origin), messages, suggestions };
}

function cleanText(value: unknown, field: string, max = MAX_TEXT, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim())) throw invalid(`invalid_${field}`, `${field} must be ${required ? 'non-empty ' : ''}text.`);
  if (value.length > max) throw invalid(`invalid_${field}`, `${field} is limited to ${max.toLocaleString('en-US')} characters.`);
  return value.trim();
}

function cleanTime(value: unknown, length: number, field = 'time'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > length + 0.05) throw invalid(`invalid_${field}`, `${field} must be seconds within the video (0 to ${length}).`);
  return Math.round(Math.min(value, length) * 1000) / 1000;
}

/**
 * `{ cutId, time, text, range?: { start, end, why }, view?: '4:3' | '16:9', frameAssetId?, agent? }`:
 * a new comment, anchored on the cut as Studio resolves it now.
 */
export async function createThread(caller: Caller, productionId: string, body: Record<string, unknown>, origin: string): Promise<ThreadResource> {
  const uid = caller.uid;
  const author = authorOf(caller, body.agent);
  const text = cleanText(body.text, 'text');
  if (typeof body.cutId !== 'string' || !CUT_ID.test(body.cutId)) throw invalid('invalid_cut_id', 'cutId must name one of the production\'s cuts.');
  const production = await getProduction(uid, productionId, origin);
  const cut = await getProductionCut(uid, productionId, body.cutId, origin);
  if (!cut.timeline) throw new CommentError(422, 'cut_not_timed', 'Comments anchor on a cut with a timeline; this version is a rendered video only, or no longer resolves.');
  const time = cleanTime(body.time, cut.timeline.length);
  let range: Thread['anchor']['range'];
  if (body.range !== undefined && body.range !== null) {
    const raw = body.range as Record<string, unknown>;
    const start = cleanTime(raw.start, cut.timeline.length, 'range');
    const end = cleanTime(raw.end, cut.timeline.length, 'range');
    if (!(start <= time && time <= end)) throw invalid('invalid_range', 'range must contain time.');
    range = { start, end, why: cleanText(raw.why, 'range', 2000, false) };
  }
  const view = body.view === '16:9' ? '16:9' : '4:3';
  let frameAssetId: string | null = null;
  if (body.frameAssetId !== undefined && body.frameAssetId !== null) {
    const asset = typeof body.frameAssetId === 'string' ? (await loadOwnedAssets(uid, [body.frameAssetId])).get(body.frameAssetId) : undefined;
    if (!asset || !asset.mimeType.startsWith('image/')) throw invalid('asset_not_found', 'frameAssetId must be one of your image assets.');
    frameAssetId = asset.id;
  }
  const now = Date.now();
  const id = newId('th', now);
  const thread: Thread = {
    id, productionId,
    version: { cutId: cut.id, cutUpdatedAt: cut.updatedAt },
    anchor: { time, ...(range ? { range } : {}), items: anchorAt(cut.timeline, time) },
    snapshot: { at: time, view, frameAssetId, overlays: overlaysAt(cut.timeline, time), window: 2, words: wordsAround(cut.timeline, time, 2) },
    text, author, status: isAgent(author) ? 'addressed' : 'open', claim: null, createdAt: now, updatedAt: now,
  };
  await threadsOf(productionId).doc(id).set(clean({ ...thread, ownerUid: uid, cutId: cut.id }));
  return threadResource(thread, [], production, origin, now);
}

/** `{ status }`: sets a thread's status outright. Resolving ends any claim. */
export async function setThreadStatus(uid: string, productionId: string, threadId: string, body: Record<string, unknown>, origin: string): Promise<ThreadResource> {
  if (!(THREAD_STATUSES as readonly unknown[]).includes(body.status)) throw invalid('invalid_status', `status must be one of ${THREAD_STATUSES.join(', ')}.`);
  const status = body.status as ThreadStatus;
  await getProduction(uid, productionId, origin);
  await db().runTransaction(async (tx) => {
    const { ref } = await ownedThread(uid, productionId, threadId, tx);
    tx.update(ref, { status, ...(status === 'resolved' || status === 'open' ? { claim: null } : {}), updatedAt: Date.now() });
  });
  return (await getThread(uid, productionId, threadId, origin)).thread;
}

/**
 * `{ agent, minutes? }`: an agent takes the thread for `minutes` (default 20,
 * at most 120), making it `in-progress`. Claiming again renews it. Another
 * agent's live claim is `409 claimed`.
 */
export async function claimThread(caller: Caller, productionId: string, threadId: string, body: Record<string, unknown>, origin: string): Promise<ThreadResource> {
  const agent = agentName(body.agent ?? 'agent');
  const minutes = body.minutes === undefined ? CLAIM_MS / 60_000 : body.minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 120) throw invalid('invalid_minutes', 'minutes must be more than 0 and at most 120.');
  await getProduction(caller.uid, productionId, origin);
  await db().runTransaction(async (tx) => {
    const { ref, thread } = await ownedThread(caller.uid, productionId, threadId, tx);
    const now = Date.now();
    if (thread.status === 'resolved') throw new CommentError(409, 'thread_resolved', 'This thread is resolved.');
    if (thread.claim && thread.claim.expiresAt > now && thread.claim.agent !== agent) {
      throw new CommentError(409, 'claimed', `Agent "${thread.claim.agent}" is working on this thread until ${new Date(thread.claim.expiresAt).toISOString()}.`);
    }
    const at = thread.claim?.agent === agent && thread.claim.expiresAt > now ? thread.claim.at : now;
    tx.update(ref, { claim: { agent, at, expiresAt: now + minutes * 60_000 }, status: 'in-progress', updatedAt: now });
  });
  return (await getThread(caller.uid, productionId, threadId, origin)).thread;
}

/** Ends a claim. A thread still in progress goes back to `open`. */
export async function releaseThread(uid: string, productionId: string, threadId: string, origin: string): Promise<ThreadResource> {
  await getProduction(uid, productionId, origin);
  await db().runTransaction(async (tx) => {
    const { ref, thread } = await ownedThread(uid, productionId, threadId, tx);
    tx.update(ref, { claim: null, ...(thread.status === 'in-progress' ? { status: 'open' } : {}), updatedAt: Date.now() });
  });
  return (await getThread(uid, productionId, threadId, origin)).thread;
}

// ---------------------------------------------------------------------------
// Messages

/** Checks a timed reference and, on a cut, anchors it on the cut as it is now. */
async function timedRef(uid: string, productionId: string, threadId: string, raw: unknown, origin: string): Promise<TimedRef> {
  const at = raw as Record<string, unknown>;
  const video = at?.video as Record<string, unknown> | undefined;
  if (!at || typeof at !== 'object' || !video || typeof video !== 'object') throw invalid('invalid_at', 'at must be { video: { kind: "cut", cutId } | { kind: "preview", suggestionId, assetId }, time }.');
  if (video.kind === 'cut') {
    if (typeof video.cutId !== 'string' || !CUT_ID.test(video.cutId)) throw invalid('invalid_at', 'at.video.cutId must name one of the production\'s cuts.');
    const cut = await getProductionCut(uid, productionId, video.cutId, origin);
    const length = cut.timeline?.length ?? cut.lengthSeconds ?? Infinity;
    const time = cleanTime(at.time, length, 'at');
    return { video: { kind: 'cut', cutId: cut.id }, time, ...(cut.timeline ? { anchor: anchorAt(cut.timeline, time) } : {}) };
  }
  if (video.kind === 'preview') {
    if (typeof video.suggestionId !== 'string' || !ID.test(video.suggestionId) || typeof video.assetId !== 'string') throw invalid('invalid_at', 'at.video needs the suggestionId and the preview\'s assetId.');
    const snapshot = await suggestionsOf(productionId, threadId).doc(video.suggestionId).get();
    const suggestion = snapshot.exists && snapshot.data()?.ownerUid === uid ? readSuggestion(snapshot.id, snapshot.data()) : null;
    const preview = suggestion?.previews.find((p) => p.assetId === video.assetId);
    if (!preview) throw invalid('invalid_at', 'at.video must be one of this thread\'s previews.');
    const length = preview.durationMs !== undefined ? preview.durationMs / 1000 : Infinity;
    return { video: { kind: 'preview', suggestionId: video.suggestionId, assetId: video.assetId }, time: cleanTime(at.time, length, 'at') };
  }
  throw invalid('invalid_at', 'at.video.kind must be "cut" or "preview".');
}

/**
 * `{ text, replyTo?, at?: { video, time }, version?: { cutId }, agent?, keepClaim? }`.
 * The owner's reply leaves the thread open for an agent; an agent's marks it
 * addressed and ends its claim (unless `keepClaim`).
 */
export async function postMessage(caller: Caller, productionId: string, threadId: string, body: Record<string, unknown>, origin: string): Promise<Message> {
  const uid = caller.uid;
  const author = authorOf(caller, body.agent);
  const text = cleanText(body.text, 'text');
  const production = await getProduction(uid, productionId, origin);
  await ownedThread(uid, productionId, threadId);
  const at = body.at === undefined || body.at === null ? undefined : await timedRef(uid, productionId, threadId, body.at, origin);
  let version: Message['version'];
  if (body.version !== undefined && body.version !== null) {
    const cutId = (body.version as Record<string, unknown>).cutId;
    if (typeof cutId !== 'string' || !production.cuts.some((cut) => cut.id === cutId)) throw invalid('invalid_version', 'version.cutId must name one of the production\'s cuts.');
    version = { cutId };
  }
  let replyTo: string | undefined;
  if (body.replyTo !== undefined && body.replyTo !== null) {
    if (typeof body.replyTo !== 'string' || !ID.test(body.replyTo)) throw invalid('invalid_reply_to', 'replyTo must be a message id.');
    const replied = await messagesOf(productionId, threadId).doc(body.replyTo).get();
    if (!replied.exists || replied.data()?.ownerUid !== uid) throw invalid('invalid_reply_to', 'replyTo must be a message on this thread.');
    replyTo = body.replyTo;
  }
  const now = Date.now();
  const message: Message = { id: newId('m', now), threadId, author, text, ...(replyTo ? { replyTo } : {}), ...(at ? { at } : {}), ...(version ? { version } : {}), createdAt: now };
  await db().runTransaction(async (tx) => {
    const { ref, thread } = await ownedThread(uid, productionId, threadId, tx);
    const status: ThreadStatus = isAgent(author) ? 'addressed' : 'open';
    const keepClaim = isAgent(author) && body.keepClaim === true;
    tx.set(messagesOf(productionId, threadId).doc(message.id), clean({ ...message, ownerUid: uid, productionId }));
    tx.update(ref, { status: keepClaim ? thread.status : status, ...(keepClaim ? {} : { claim: null }), updatedAt: now });
  });
  return message;
}

// ---------------------------------------------------------------------------
// Suggestions

function cleanList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every((v) => typeof v === 'string' && v.length <= MAX_ITEM_TEXT)) {
    throw invalid(`invalid_${field}`, `${field} must be a list of at most ${MAX_ITEMS} texts.`);
  }
  return (value as string[]).map((v) => v.trim()).filter(Boolean);
}

interface SuggestionInput {
  title: string;
  approach: string;
  steps: string[];
  cost: Suggestion['cost'];
  risks: string[];
  checks: SuggestionCheck[];
  previews: Preview[];
  keeps: string[];
  overturns: string[];
  creates: string[];
  revises?: string;
}

function parseSuggestion(raw: unknown, index: number): SuggestionInput {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== 'object') throw invalid('invalid_suggestion', `suggestions[${index}] must be an object.`);
  const cost = (s.cost ?? {}) as Record<string, unknown>;
  const count = (v: unknown, field: string) => {
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw invalid('invalid_cost', `cost.${field} must be a number, 0 or more.`);
    return v;
  };
  const checks = s.checks === undefined ? [] : s.checks;
  if (!Array.isArray(checks) || Buffer.byteLength(JSON.stringify(checks)) > MAX_CHECKS_BYTES) throw invalid('invalid_checks', 'checks must be a list, at most 200 KB as JSON.');
  const previews = s.previews === undefined ? [] : s.previews;
  if (!Array.isArray(previews) || previews.length > MAX_PREVIEWS) throw invalid('invalid_previews', `previews must be a list of at most ${MAX_PREVIEWS}.`);
  return {
    title: cleanText(s.title, 'title', MAX_TITLE),
    approach: cleanText(s.approach, 'approach', MAX_ITEM_TEXT, false),
    steps: cleanList(s.steps, 'steps'),
    cost: { generations: count(cost.generations, 'generations'), minutes: count(cost.minutes, 'minutes') },
    risks: cleanList(s.risks, 'risks'),
    checks: checks as SuggestionCheck[],
    previews: previews.map((p: unknown) => {
      const preview = p as Record<string, unknown>;
      if (!preview || typeof preview.assetId !== 'string') throw invalid('invalid_previews', 'Each preview is { assetId, label? }: upload it as production media first.');
      return { assetId: preview.assetId, ...(typeof preview.label === 'string' && preview.label.trim() ? { label: preview.label.trim().slice(0, 120) } : {}) };
    }),
    keeps: cleanList(s.keeps, 'keeps'),
    overturns: cleanList(s.overturns, 'overturns'),
    creates: cleanList(s.creates, 'creates'),
    ...(typeof s.revises === 'string' && ID.test(s.revises) ? { revises: s.revises } : {}),
  };
}

/**
 * `{ message, suggestions: [{ title, approach, steps, cost, risks, checks, previews: [{ assetId, label? }], keeps, overturns, creates, revises? }],
 *    agent?, round? }`: an agent's options, lettered A, B, … in a new round
 * (or `round`), offered by one message. The thread becomes addressed and the
 * claim ends.
 */
export async function postSuggestions(caller: Caller, productionId: string, threadId: string, body: Record<string, unknown>, origin: string): Promise<{ message: Message; suggestions: Suggestion[] }> {
  const uid = caller.uid;
  const author = authorOf(caller, body.agent);
  if (!Array.isArray(body.suggestions) || body.suggestions.length === 0 || body.suggestions.length > MAX_SUGGESTIONS) {
    throw invalid('invalid_suggestions', `suggestions must be a list of 1 to ${MAX_SUGGESTIONS} options.`);
  }
  const inputs = body.suggestions.map(parseSuggestion);
  // A round is one message and its options: the message says what the agent read and recommends.
  const text = cleanText(body.message, 'message');
  await getProduction(uid, productionId, origin);
  await ownedThread(uid, productionId, threadId);
  // Previews are the owner's video uploads, with their lengths.
  const previewIds = inputs.flatMap((s) => s.previews.map((p) => p.assetId));
  const assets = await loadOwnedAssets(uid, previewIds);
  const missing = previewIds.filter((id) => !assets.get(id)?.mimeType.startsWith('video/'));
  if (missing.length) throw invalid('asset_not_found', `Previews must be your uploaded videos; not: ${[...new Set(missing)].slice(0, 10).join(', ')}.`);
  for (const s of inputs) for (const p of s.previews) { const d = assets.get(p.assetId)?.durationMs; if (d !== undefined) p.durationMs = d; }

  const existing = await listSuggestions(uid, productionId, threadId);
  const latest = Math.max(0, ...existing.map((s) => s.round));
  let round = latest + 1;
  if (body.round !== undefined) {
    if (typeof body.round !== 'number' || !Number.isInteger(body.round) || body.round < 1 || body.round > latest + 1) throw invalid('invalid_round', `round must be a round of this thread, 1 to ${latest + 1}.`);
    round = body.round;
  }
  for (const s of inputs) if (s.revises && !existing.some((e) => e.id === s.revises)) throw invalid('invalid_revises', `revises names no option on this thread: ${s.revises}.`);
  const taken = existing.filter((s) => s.round === round).length;
  const now = Date.now();
  const suggestions: Suggestion[] = inputs.map((input, i) => ({
    id: newId('s', now + i), threadId, author, round, letter: optionLetter(taken + i), ...input, state: 'proposed', createdAt: now,
  }));
  const message: Message = { id: newId('m', now), threadId, author, text, suggestions: suggestions.map((s) => s.id), createdAt: now };
  await db().runTransaction(async (tx) => {
    const { ref } = await ownedThread(uid, productionId, threadId, tx);
    for (const s of suggestions) tx.set(suggestionsOf(productionId, threadId).doc(s.id), clean({ ...s, ownerUid: uid, productionId }));
    tx.set(messagesOf(productionId, threadId).doc(message.id), clean({ ...message, ownerUid: uid, productionId }));
    tx.update(ref, { status: 'addressed', claim: null, updatedAt: now });
  });
  return { message, suggestions };
}

/**
 * `{ state, appliedAs? }`: the owner accepts or rejects an option; an agent
 * marks one applied as a version (`appliedAs`, one of the production's cuts).
 * Accepting leaves the thread open for an agent to apply it; applying marks it
 * addressed; rejecting the last waiting option opens it again.
 */
export async function setSuggestionState(caller: Caller, productionId: string, threadId: string, suggestionId: string, body: Record<string, unknown>, origin: string): Promise<Suggestion> {
  const uid = caller.uid;
  if (!(SUGGESTION_STATES as readonly unknown[]).includes(body.state)) throw invalid('invalid_state', `state must be one of ${SUGGESTION_STATES.join(', ')}.`);
  const state = body.state as SuggestionState;
  const production = await getProduction(uid, productionId, origin);
  let appliedAs: string | undefined;
  if (state === 'applied') {
    if (typeof body.appliedAs !== 'string' || !production.cuts.some((cut) => cut.id === body.appliedAs)) throw invalid('invalid_applied_as', 'An applied option needs appliedAs: the cut id of the version it became.');
    appliedAs = body.appliedAs;
  }
  if (!ID.test(suggestionId)) throw new CommentError(404, 'suggestion_not_found', 'This thread has no such option.');
  const by = authorOf(caller, body.agent);
  const all = await listSuggestions(uid, productionId, threadId);
  let updated: Suggestion | null = null;
  await db().runTransaction(async (tx) => {
    const { ref } = await ownedThread(uid, productionId, threadId, tx);
    const sRef = suggestionsOf(productionId, threadId).doc(suggestionId);
    const snapshot = await tx.get(sRef);
    if (!snapshot.exists || snapshot.data()?.ownerUid !== uid) throw new CommentError(404, 'suggestion_not_found', 'This thread has no such option.');
    const now = Date.now();
    const before = readSuggestion(suggestionId, snapshot.data());
    updated = { ...before, state, stateChangedAt: now, stateChangedBy: by, ...(appliedAs ? { appliedAs } : {}) };
    const after = all.map((s) => (s.id === suggestionId ? updated! : s));
    const stillWaiting = after.some((s) => s.state === 'proposed' && s.round === before.round) && !after.some((s) => s.round === before.round && (s.state === 'accepted' || s.state === 'applied'));
    const status: ThreadStatus | null = state === 'accepted' ? 'open' : state === 'applied' ? 'addressed' : state === 'rejected' && !stillWaiting && !after.some((s) => s.state === 'accepted') ? 'open' : null;
    tx.update(sRef, clean({ state, stateChangedAt: now, stateChangedBy: by, ...(appliedAs ? { appliedAs } : {}) }));
    tx.update(ref, { ...(status ? { status } : {}), ...(state === 'applied' ? { claim: null } : {}), updatedAt: now });
  });
  return updated!;
}

// ---------------------------------------------------------------------------
// Decisions

export async function listDecisions(uid: string, productionId: string, origin: string): Promise<{ decisions: Decision[]; constraints: Decision[] }> {
  await getProduction(uid, productionId, origin);
  const snapshot = await decisionsOf(productionId).where('ownerUid', '==', uid).get();
  const all = snapshot.docs.map((doc) => readDecision(doc.id, doc.data())).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return { decisions: all.filter((d) => d.kind === 'decision'), constraints: all.filter((d) => d.kind === 'constraint') };
}

/** `{ text, kind?, take?, source?, quote?, revised?, threadIds?, cutIds? }`: adds one decision (or constraint) at the end of the log. */
export async function addDecision(uid: string, productionId: string, body: Record<string, unknown>, origin: string): Promise<Decision> {
  const production = await getProduction(uid, productionId, origin);
  const text = cleanText(body.text, 'text', MAX_ITEM_TEXT);
  const kind = body.kind === 'constraint' ? 'constraint' : 'decision';
  if (body.source !== undefined && !(DECISION_SOURCES as readonly unknown[]).includes(body.source)) throw invalid('invalid_source', `source must be one of ${DECISION_SOURCES.join(', ')}.`);
  const threadIds = cleanList(body.threadIds, 'threadIds');
  const cutIds = cleanList(body.cutIds, 'cutIds');
  const unknownCuts = cutIds.filter((id) => !production.cuts.some((cut) => cut.id === id));
  if (unknownCuts.length) throw invalid('invalid_cut_ids', `No such cuts: ${unknownCuts.join(', ')}.`);
  for (const threadId of threadIds) await ownedThread(uid, productionId, threadId).catch(() => { throw invalid('invalid_thread_ids', `No such thread: ${threadId}.`); });
  const existing = await decisionsOf(productionId).where('ownerUid', '==', uid).get();
  const now = Date.now();
  const id = typeof body.id === 'string' && ID.test(body.id) ? body.id : newId('d', now);
  if (existing.docs.some((doc) => doc.id === id)) throw new CommentError(409, 'decision_exists', `The log already has a decision "${id}".`);
  const decision: Decision = {
    id, kind,
    ...(body.take === undefined ? {} : { take: cleanText(body.take, 'take', 200) }),
    ...(body.source === undefined ? {} : { source: body.source as DecisionSource }),
    ...(body.quote === undefined ? {} : { quote: cleanText(body.quote, 'quote', MAX_ITEM_TEXT) }),
    text,
    ...(body.revised === undefined ? {} : { revised: cleanText(body.revised, 'revised', 2000) }),
    threadIds, cutIds,
    order: Math.max(0, ...existing.docs.map((doc) => num(doc.data().order) + 1)),
    createdAt: now,
  };
  await decisionsOf(productionId).doc(id).set(clean({ ...decision, ownerUid: uid, productionId }));
  return decision;
}

// ---------------------------------------------------------------------------
// Heartbeats

const heartbeatId = (uid: string, agent: string, productionId: string | null) =>
  `ag${createHash('sha256').update(`comment-agent\0${uid}\0${agent}\0${productionId ?? '*'}`).digest('hex').slice(0, 28)}`;

/** `{ agent, productionId? }`: an agent says it is watching for comments (on one production, or all of the owner's). */
export async function heartbeat(uid: string, body: Record<string, unknown>, origin: string): Promise<AgentHeartbeat> {
  const agent = agentName(body.agent ?? 'agent');
  let productionId: string | null = null;
  if (body.productionId !== undefined && body.productionId !== null) {
    if (typeof body.productionId !== 'string') throw invalid('invalid_production', 'productionId must be a production id.');
    productionId = (await getProduction(uid, body.productionId, origin)).id;
  }
  const beat: AgentHeartbeat = { agent, productionId, seenAt: Date.now() };
  await agents().doc(heartbeatId(uid, agent, productionId)).set({ ...beat, ownerUid: uid });
  return beat;
}

/** Removes a production's threads, their messages and options, and its decisions (the production is being deleted). */
export async function deleteProductionComments(productionId: string): Promise<void> {
  const threads = await threadsOf(productionId).get();
  for (const thread of threads.docs) {
    const [messages, suggestions] = await Promise.all([messagesOf(productionId, thread.id).get(), suggestionsOf(productionId, thread.id).get()]);
    await Promise.all([...messages.docs, ...suggestions.docs].map((doc) => doc.ref.delete()));
    await thread.ref.delete();
  }
  const decisions = await decisionsOf(productionId).get();
  await Promise.all(decisions.docs.map((doc) => doc.ref.delete()));
}

export { listMessages, listSuggestions, readThread };
