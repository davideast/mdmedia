/**
 * Productions for `/api/v1`, through the Admin SDK and scoped to one owner.
 *
 *   productions/{id}              { ownerUid, title, slug, seriesId, seriesTitle, coverAssetId,
 *                                   currentCutId, approvedCutId, cuts: [summary], createdAt, updatedAt }
 *   productions/{id}/cuts/{cutId} { ownerUid, productionId, label, status, kind, notes, order,
 *                                   createdAt, updatedAt, lengthSeconds, cut, words, renderedAssetId,
 *                                   thumbs, source }
 *   series/{id}                   { ownerUid, title, slug, createdAt, updatedAt }
 *
 * A production's `cast` links roles (its cuts' speakers) to character
 * versions (`characters-server.ts`), with what a page shows of each.
 *
 * A production is one piece (an episode or a commercial); its cuts are the
 * reviewable versions. A `cut` cut holds the cut file, `extends` already
 * merged and every media source an `asset:<id>` of the owner's, with its words
 * file beside it; a `rendered` cut is only a finished video, for takes made
 * before cut files existed. The production keeps a summary of every cut, in
 * order, so a listing is one query.
 *
 * Production and series ids derive from the owner and the slug, so pushing
 * the same production again updates it in place. Every change runs in a
 * transaction that reads the production as it is now.
 */

import { createHash } from 'node:crypto';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import {
  applyWords,
  cutSourceRefs,
  parseCut,
  parseWordsFile,
  resolveCut,
  type CutError,
  type CutFile,
  type Timeline,
  type WordsFile,
} from 'mdmedia/cut';
import { apiError } from './api-auth';
import type { StoredAsset } from './assets-server';
import { CharacterError, readCastMember, resolveCast, type CastMember } from './characters-server';
import { deleteProductionComments } from './comments-server';
import { adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import { loadOwnedAssets, productionAssetResource, type ProductionAssetResource } from './production-media-server';

export const CUT_STATUSES = ['review', 'approved', 'final', 'none'] as const;
export type CutStatus = (typeof CUT_STATUSES)[number];
export const CUT_KINDS = ['cut', 'rendered'] as const;
export type CutKind = (typeof CUT_KINDS)[number];

const MAX_TITLE = 200;
const MAX_LABEL = 200;
const MAX_NOTES = 4000;
const MAX_CUTS = 200;
const MAX_THUMBS = 400;
/** Firestore's document limit is 1 MiB; leave room for the fields around the cut and its words. */
const MAX_CUT_DOC_BYTES = 900_000;
const LIST_LIMIT = 200;
/** A cut's summary carries its note for listings, up to this long. */
const SUMMARY_NOTES = 2000;
/** If a production's summaries would outgrow this, their notes are cut shorter still. */
const MAX_SUMMARIES_BYTES = 700_000;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ProductionError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProductionError';
  }
}

const ERROR_STATUS: Record<string, number> = {
  production_not_found: 404,
  cut_not_found: 404,
  asset_not_found: 400,
  invalid_cut: 422,
  conflicting_status: 409,
  too_many_cuts: 409,
  cut_too_large: 413,
  character_not_found: 400,
};

/** Turns a production error into its API response; anything else is rethrown. */
export function productionErrorResponse(error: unknown): Response {
  if (!(error instanceof ProductionError)) throw error;
  const status = ERROR_STATUS[error.code] ?? 400;
  if (!Object.keys(error.details).length) return apiError(status, error.code, error.message);
  return Response.json({ error: { code: error.code, message: error.message, ...error.details } }, { status });
}

/** Runs a production route: its own errors become their responses, anything unexpected a plain 500. */
export async function productionApi(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProductionError) return productionErrorResponse(error);
    if (error instanceof MediaError) return apiError(error.status, error.code, error.message);
    console.error('[productions] Request failed:', error instanceof Error ? error.message : 'unknown');
    return apiError(500, 'productions_unavailable', 'Studio could not complete that request. Try again.');
  }
}

export const noStore = { 'Cache-Control': 'no-store' };

// ---------------------------------------------------------------------------
// Stored shapes

export interface CutSummary {
  id: string;
  label: string;
  status: CutStatus;
  kind: CutKind;
  /** The cut's length; for a rendered cut, its video's, when known. */
  lengthSeconds: number | null;
  createdAt: number;
  order: number;
  /** The finished video, when there is one. */
  renderedAssetId: string | null;
  /** A still from the finished video, for listings. */
  posterAssetId: string | null;
  /** The review note, shortened for listings (see `notesTruncated`); the cut has it whole. */
  notes: string;
  notesTruncated: boolean;
}

interface StoredProduction {
  ownerUid: string;
  title: string;
  slug: string;
  seriesId: string | null;
  seriesTitle: string | null;
  coverAssetId: string | null;
  currentCutId: string | null;
  approvedCutId: string | null;
  cuts: CutSummary[];
  /** Who plays whom: each role and the character version that plays it. */
  cast: CastMember[];
  createdAt: number;
  updatedAt: number;
  /** When a cut's status or the approved cut last changed. */
  reviewedAt: number;
}

export interface CutSource {
  /** The cut file it was pushed from, relative to the repository. */
  cut?: string;
  /** The rendered file, relative to the media root. */
  rendered?: string;
}

interface StoredCut {
  ownerUid: string;
  productionId: string;
  label: string;
  status: CutStatus;
  kind: CutKind;
  notes: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  lengthSeconds: number | null;
  cut: CutFile | null;
  words: WordsFile | null;
  renderedAssetId: string | null;
  posterAssetId: string | null;
  /** Segment id → image asset id. */
  thumbs: Record<string, string>;
  source: CutSource | null;
}

// ---------------------------------------------------------------------------
// Resources

export interface SeriesRef {
  id: string;
  title: string;
}

export interface ProductionCutSummary extends CutSummary {
  links: { self: string; rendered: string | null };
}

export interface ProductionSummary {
  id: string;
  slug: string;
  title: string;
  series: SeriesRef | null;
  coverAssetId: string | null;
  currentCutId: string | null;
  approvedCutId: string | null;
  cutCount: number;
  /** Every cut, in order. */
  cuts: ProductionCutSummary[];
  /** Who plays whom, in the manifest's order. */
  cast: CastMember[];
  createdAt: number;
  updatedAt: number;
  /** The latest of its newest cut and its last review: what a listing sorts by. */
  activityAt: number;
  links: { self: string; cover: string | null; coverThumbnail: string | null };
}

export type ProductionDetail = ProductionSummary;

export interface SeriesSummary extends SeriesRef {
  slug: string;
  /** Its productions in the listing's order. */
  productionIds: string[];
}

export interface ProductionList {
  productions: ProductionSummary[];
  series: SeriesSummary[];
}

export interface WordsSummary {
  applied: string[];
  stale: Array<{ id: string; reason: string }>;
  unchecked: string[];
}

export interface ProductionCutResource {
  id: string;
  productionId: string;
  label: string;
  status: CutStatus;
  kind: CutKind;
  notes: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  lengthSeconds: number | null;
  renderedAssetId: string | null;
  posterAssetId: string | null;
  thumbs: Record<string, string>;
  source: CutSource | null;
  /** The stored cut file: `extends` merged, every source an `asset:` ref. Null for a rendered cut. */
  cut: CutFile | null;
  words: WordsFile | null;
  /** The cut resolved, with its fresh words applied. Null for a rendered cut, or when it doesn't resolve (see `errors`). */
  timeline: Timeline | null;
  wordsSummary: WordsSummary | null;
  errors: CutError[];
  /** Every asset the cut names (sources, rendered video, thumbnails), by id. */
  assets: Record<string, ProductionAssetResource>;
  links: { self: string; production: string; rendered: string | null };
}

// ---------------------------------------------------------------------------
// Helpers

const productions = () => adminDb().collection('productions');
const seriesCollection = () => adminDb().collection('series');
const cutsOf = (productionId: string) => adminDb().collection(`productions/${productionId}/cuts`);

const digest = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length);

/** The production id for `uid`'s production with this slug. */
export const productionId = (uid: string, slug: string) => `pr${digest(`production\0${uid}\0${slug}`, 24)}`;
/** The series id for `uid`'s series with this slug. */
export const seriesId = (uid: string, slug: string) => `se${digest(`series\0${uid}\0${slug}`, 24)}`;

export function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

const isStatus = (value: unknown): value is CutStatus => (CUT_STATUSES as readonly unknown[]).includes(value);
const isKind = (value: unknown): value is CutKind => (CUT_KINDS as readonly unknown[]).includes(value);
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
const idOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null);

function readSummary(value: unknown): CutSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  return {
    id: v.id,
    label: str(v.label, v.id),
    status: isStatus(v.status) ? v.status : 'none',
    kind: isKind(v.kind) ? v.kind : 'cut',
    lengthSeconds: typeof v.lengthSeconds === 'number' ? v.lengthSeconds : null,
    createdAt: num(v.createdAt, 0),
    order: num(v.order, 0),
    renderedAssetId: idOrNull(v.renderedAssetId),
    posterAssetId: idOrNull(v.posterAssetId),
    notes: str(v.notes, ''),
    notesTruncated: v.notesTruncated === true,
  };
}

/** A note as a summary carries it: whole when it's short, else cut at a word with an ellipsis. */
export function summaryNotes(notes: string, max = SUMMARY_NOTES): Pick<CutSummary, 'notes' | 'notesTruncated'> {
  const chars = [...notes];
  if (chars.length <= max) return { notes, notesTruncated: false };
  const cut = chars.slice(0, max).join('');
  const word = cut.replace(/\s+\S*$/, '');
  return { notes: `${(word.length > max * 0.6 ? word : cut).trimEnd()}…`, notesTruncated: true };
}

/**
 * Keeps a production's summaries well inside Firestore's document limit: if
 * their notes make them too large, every note is shortened further. The
 * full notes stay on the cuts.
 */
function fitSummaries(cuts: CutSummary[]): CutSummary[] {
  if (Buffer.byteLength(JSON.stringify(cuts)) <= MAX_SUMMARIES_BYTES) return cuts;
  return cuts.map((cut) => (cut.notesTruncated || [...cut.notes].length > 240 ? { ...cut, ...summaryNotes(cut.notes.replace(/…$/, ''), 240), notesTruncated: true } : cut));
}

function stored(data: FirebaseFirestore.DocumentData | undefined): StoredProduction {
  return {
    ownerUid: str(data?.ownerUid, ''),
    title: str(data?.title, 'Untitled production'),
    slug: str(data?.slug, ''),
    seriesId: idOrNull(data?.seriesId),
    seriesTitle: idOrNull(data?.seriesTitle),
    coverAssetId: idOrNull(data?.coverAssetId),
    currentCutId: idOrNull(data?.currentCutId),
    approvedCutId: idOrNull(data?.approvedCutId),
    cuts: Array.isArray(data?.cuts) ? data.cuts.map(readSummary).filter((cut: CutSummary | null): cut is CutSummary => cut !== null) : [],
    cast: Array.isArray(data?.cast) ? data.cast.map(readCastMember).filter((member: CastMember | null): member is CastMember => member !== null) : [],
    createdAt: num(data?.createdAt, 0),
    updatedAt: num(data?.updatedAt, 0),
    reviewedAt: num(data?.reviewedAt, 0),
  };
}

function storedCut(data: FirebaseFirestore.DocumentData | undefined): StoredCut {
  return {
    ownerUid: str(data?.ownerUid, ''),
    productionId: str(data?.productionId, ''),
    label: str(data?.label, ''),
    status: isStatus(data?.status) ? data.status : 'none',
    kind: isKind(data?.kind) ? data.kind : 'cut',
    notes: str(data?.notes, ''),
    order: num(data?.order, 0),
    createdAt: num(data?.createdAt, 0),
    updatedAt: num(data?.updatedAt, 0),
    lengthSeconds: typeof data?.lengthSeconds === 'number' ? data.lengthSeconds : null,
    cut: data?.cut && typeof data.cut === 'object' ? (data.cut as CutFile) : null,
    words: data?.words && typeof data.words === 'object' ? (data.words as WordsFile) : null,
    renderedAssetId: idOrNull(data?.renderedAssetId),
    posterAssetId: idOrNull(data?.posterAssetId),
    thumbs: data?.thumbs && typeof data.thumbs === 'object' ? Object.fromEntries(Object.entries(data.thumbs).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
    source: data?.source && typeof data.source === 'object' ? (data.source as CutSource) : null,
  };
}

const notFound = () => new ProductionError('production_not_found', 'No production of yours with that id.');
const cutNotFound = (cutId: string) => new ProductionError('cut_not_found', `This production has no cut "${cutId}".`);

async function ownedProduction(uid: string, id: string, tx?: Transaction): Promise<{ ref: DocumentReference; production: StoredProduction }> {
  if (!DOC_ID.test(id)) throw notFound();
  const ref = productions().doc(id);
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  const production = stored(snapshot.data());
  if (!snapshot.exists || production.ownerUid !== uid) throw notFound();
  return { ref, production };
}

function cleanText(value: unknown, field: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new ProductionError(`invalid_${field}`, `${field} must be ${required ? 'non-empty ' : ''}text.`);
  if (value.trim().length > max) throw new ProductionError(`invalid_${field}`, `${field} is limited to ${max} characters.`);
  return value.trim();
}

function cleanAssetId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ASSET_ID.test(value)) throw new ProductionError('invalid_asset', `${field} must be an asset id or null.`);
  return value;
}

const sortCuts = (cuts: CutSummary[]) => [...cuts].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** Keeps the pointers honest: the current cut exists (defaulting to the last), the approved cut is approved or final. */
function settle(production: StoredProduction): Pick<StoredProduction, 'cuts' | 'currentCutId' | 'approvedCutId'> {
  const cuts = sortCuts(production.cuts);
  const has = (id: string | null) => id !== null && cuts.some((cut) => cut.id === id);
  const currentCutId = has(production.currentCutId) ? production.currentCutId : (cuts.at(-1)?.id ?? null);
  const approved = cuts.find((cut) => cut.id === production.approvedCutId);
  const approvedCutId = approved && (approved.status === 'approved' || approved.status === 'final') ? approved.id : null;
  return { cuts, currentCutId, approvedCutId };
}

function cutLinks(origin: string, productionId: string, cut: Pick<CutSummary, 'id' | 'renderedAssetId'>) {
  return {
    self: `${origin}/api/v1/productions/${productionId}/cuts/${encodeURIComponent(cut.id)}`,
    rendered: cut.renderedAssetId ? `${origin}/api/v1/assets/${cut.renderedAssetId}/content` : null,
  };
}

function summarize(id: string, production: StoredProduction, origin: string): ProductionSummary {
  const cuts = sortCuts(production.cuts);
  const cover = production.coverAssetId ? `${origin}/api/v1/assets/${production.coverAssetId}/content` : null;
  return {
    id,
    slug: production.slug,
    title: production.title,
    series: production.seriesId ? { id: production.seriesId, title: production.seriesTitle ?? '' } : null,
    coverAssetId: production.coverAssetId,
    currentCutId: production.currentCutId,
    approvedCutId: production.approvedCutId,
    cutCount: cuts.length,
    cuts: cuts.map((cut) => ({ ...cut, links: cutLinks(origin, id, cut) })),
    cast: production.cast,
    createdAt: production.createdAt,
    updatedAt: production.updatedAt,
    activityAt: Math.max(production.reviewedAt, ...cuts.map((cut) => cut.createdAt), cuts.length ? 0 : production.createdAt),
    links: { self: `${origin}/api/v1/productions/${id}`, cover, coverThumbnail: cover ? `${cover}?thumbnail=1` : null },
  };
}

// ---------------------------------------------------------------------------
// Cuts: checking and resolving

/** Every `src` in a cut, in file order: the cut format's own list, so a bed's parts are included. */
export function cutSources(cut: CutFile): string[] {
  return cutSourceRefs(cut);
}

/** The asset ids a cut's sources name. */
export function cutAssetIds(cut: CutFile): string[] {
  return [...new Set(cutSources(cut).filter((ref) => ref.startsWith('asset:')).map((ref) => ref.slice('asset:'.length)))];
}

/**
 * Resolves a stored cut with its fresh words. Words are checked against each
 * asset's content hash, so words for a line whose audio changed are left out.
 */
export function resolveStoredCut(cut: CutFile, words: WordsFile | null, assets: Map<string, StoredAsset>): { timeline: Timeline | null; words: WordsSummary | null; errors: CutError[] } {
  const sha256 = (ref: string) => (ref.startsWith('asset:') ? assets.get(ref.slice('asset:'.length))?.contentSha256 : undefined);
  let merged = cut;
  let summary: WordsSummary | null = null;
  if (words) {
    const merge = applyWords(cut, words, { sha256 });
    merged = merge.cut;
    summary = { applied: merge.applied, stale: merge.stale, unchecked: merge.unchecked };
  }
  const resolved = resolveCut(merged);
  return resolved.ok ? { timeline: resolved.value, words: summary, errors: [] } : { timeline: null, words: summary, errors: resolved.errors };
}

interface CutInput {
  label: string;
  status: CutStatus;
  kind: CutKind;
  notes: string;
  order: number;
  createdAt: number | null;
  cut: CutFile | null;
  words: WordsFile | null;
  renderedAssetId: string | null;
  posterAssetId: string | null;
  thumbs: Record<string, string>;
  source: CutSource | null;
  lengthSeconds: number | null;
}

function parseCutInput(body: Record<string, unknown>): CutInput {
  const label = cleanText(body.label, 'label', MAX_LABEL, true);
  if (!isStatus(body.status)) throw new ProductionError('invalid_status', `status must be one of ${CUT_STATUSES.join(', ')}.`);
  if (!isKind(body.kind)) throw new ProductionError('invalid_kind', `kind must be one of ${CUT_KINDS.join(', ')}.`);
  const notes = body.notes === undefined ? '' : cleanText(body.notes, 'notes', MAX_NOTES, false);
  if (typeof body.order !== 'number' || !Number.isInteger(body.order) || body.order < 0 || body.order > 100_000) {
    throw new ProductionError('invalid_order', 'order must be a whole number, 0 or more.');
  }
  const createdAt = body.createdAt === undefined ? null : body.createdAt;
  if (createdAt !== null && (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0)) {
    throw new ProductionError('invalid_created_at', 'createdAt must be milliseconds since the epoch.');
  }
  const renderedAssetId = cleanAssetId(body.renderedAssetId, 'renderedAssetId');
  const posterAssetId = cleanAssetId(body.posterAssetId, 'posterAssetId');
  const thumbsRaw = body.thumbs ?? {};
  if (typeof thumbsRaw !== 'object' || thumbsRaw === null || Array.isArray(thumbsRaw) || Object.keys(thumbsRaw).length > MAX_THUMBS) {
    throw new ProductionError('invalid_thumbs', `thumbs must map segment ids to image asset ids, at most ${MAX_THUMBS}.`);
  }
  const thumbs: Record<string, string> = {};
  for (const [segment, asset] of Object.entries(thumbsRaw)) {
    if (!/^[A-Za-z0-9_]{1,80}$/.test(segment) || typeof asset !== 'string' || !ASSET_ID.test(asset)) {
      throw new ProductionError('invalid_thumbs', `thumbs.${segment} must be an image asset id.`);
    }
    thumbs[segment] = asset;
  }
  let source: CutSource | null = null;
  if (body.source !== undefined && body.source !== null) {
    const raw = body.source as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProductionError('invalid_source', 'source must be { cut?, rendered? }.');
    source = {};
    if (raw.cut !== undefined) source.cut = cleanText(raw.cut, 'source', 400, true);
    if (raw.rendered !== undefined) source.rendered = cleanText(raw.rendered, 'source', 400, true);
  }
  const lengthSeconds = body.lengthSeconds === undefined || body.lengthSeconds === null ? null : body.lengthSeconds;
  if (lengthSeconds !== null && (typeof lengthSeconds !== 'number' || !Number.isFinite(lengthSeconds) || lengthSeconds < 0)) {
    throw new ProductionError('invalid_length', 'lengthSeconds must be a number of seconds.');
  }

  if (body.kind === 'rendered') {
    if (body.cut !== undefined && body.cut !== null) throw new ProductionError('invalid_cut', 'A rendered cut has no cut file; send kind "cut" with one.');
    if (body.words !== undefined && body.words !== null) throw new ProductionError('invalid_cut', 'A rendered cut has no words file.');
    if (!renderedAssetId) throw new ProductionError('invalid_cut', 'A rendered cut needs its renderedAssetId.');
    return { label, status: body.status, kind: 'rendered', notes, order: body.order, createdAt, cut: null, words: null, renderedAssetId, posterAssetId, thumbs, source, lengthSeconds };
  }
  const parsed = parseCut(body.cut);
  if (!parsed.ok) throw new ProductionError('invalid_cut', 'The cut file has errors. Merge any extends before sending it.', { errors: parsed.errors });
  const unportable = [...new Set(cutSources(parsed.value).filter((ref) => !ref.startsWith('asset:') && !ref.startsWith('color:')))];
  if (unportable.length) {
    throw new ProductionError('unportable_source', 'Every source must be an uploaded asset ("asset:<id>") or a color.', { sources: unportable.slice(0, 20) });
  }
  let words: WordsFile | null = null;
  if (body.words !== undefined && body.words !== null) {
    const parsedWords = parseWordsFile(body.words);
    if (!parsedWords.ok) throw new ProductionError('invalid_words', `The words file has errors: ${parsedWords.message}`);
    words = parsedWords.value;
  }
  // The rendered output is `renderedAssetId`; a path to it means nothing here.
  const cut: CutFile = { ...parsed.value };
  delete cut.output;
  return { label, status: body.status, kind: 'cut', notes, order: body.order, createdAt, cut, words, renderedAssetId, posterAssetId, thumbs, source, lengthSeconds };
}

/** Checks the assets a cut names are the owner's, of the right kind. */
async function checkAssets(uid: string, input: Pick<CutInput, 'cut' | 'renderedAssetId' | 'posterAssetId' | 'thumbs'>): Promise<Map<string, StoredAsset>> {
  const sourceIds = input.cut ? cutAssetIds(input.cut) : [];
  const ids = [...sourceIds, ...(input.renderedAssetId ? [input.renderedAssetId] : []), ...(input.posterAssetId ? [input.posterAssetId] : []), ...Object.values(input.thumbs)];
  const assets = await loadOwnedAssets(uid, ids);
  const missing = [...new Set(ids.filter((id) => !assets.has(id)))];
  if (missing.length) throw new ProductionError('asset_not_found', 'These assets are not yours, or do not exist. Upload them first.', { ids: missing.slice(0, 50) });
  if (input.renderedAssetId && !assets.get(input.renderedAssetId)!.mimeType.startsWith('video/')) {
    throw new ProductionError('invalid_asset', 'renderedAssetId must be a video asset.');
  }
  const notImages = [...Object.values(input.thumbs), ...(input.posterAssetId ? [input.posterAssetId] : [])].filter((id) => !assets.get(id)!.mimeType.startsWith('image/'));
  if (notImages.length) throw new ProductionError('invalid_asset', 'Thumbnails and posters must be image assets.', { ids: notImages.slice(0, 50) });
  return assets;
}

// ---------------------------------------------------------------------------
// Productions

export async function listProductions(uid: string, origin: string): Promise<ProductionList> {
  const [snapshot, seriesSnapshot] = await Promise.all([
    productions().where('ownerUid', '==', uid).orderBy('updatedAt', 'desc').limit(LIST_LIMIT).get(),
    seriesCollection().where('ownerUid', '==', uid).get(),
  ]);
  const list = snapshot.docs.map((doc) => summarize(doc.id, stored(doc.data()), origin)).sort((a, b) => b.activityAt - a.activityAt || b.updatedAt - a.updatedAt);
  const series = new Map<string, SeriesSummary>();
  for (const doc of seriesSnapshot.docs) {
    const data = doc.data();
    series.set(doc.id, { id: doc.id, title: str(data.title, ''), slug: str(data.slug, ''), productionIds: [] });
  }
  for (const production of list) {
    if (!production.series) continue;
    const entry = series.get(production.series.id) ?? { id: production.series.id, title: production.series.title, slug: '', productionIds: [] };
    entry.productionIds.push(production.id);
    series.set(entry.id, entry);
  }
  return { productions: list, series: [...series.values()].sort((a, b) => a.title.localeCompare(b.title)) };
}

export async function getProduction(uid: string, id: string, origin: string): Promise<ProductionDetail> {
  const { production } = await ownedProduction(uid, id);
  return summarize(id, production, origin);
}

/**
 * Creates or updates `uid`'s production with this slug:
 * `{ slug, title, series?: { title, slug? } | null, coverAssetId?, cast? }`.
 * Its cuts and pointers are left as they are. `cast` is
 * `[{ role, character: "rick@1" }]`, every version already stored
 * (`PUT /api/v1/characters/{id}/versions/{version}`); leaving it out keeps
 * the cast, `[]` clears it.
 */
export async function upsertProduction(uid: string, body: Record<string, unknown>, origin: string): Promise<{ production: ProductionDetail; created: boolean }> {
  if (typeof body.slug !== 'string' || !SLUG_PATTERN.test(body.slug) || body.slug.length > 80) {
    throw new ProductionError('invalid_slug', 'slug must be lowercase words joined by hyphens, at most 80 characters, like "night-wagon-the-argument".');
  }
  const slug = body.slug;
  const title = cleanText(body.title, 'title', MAX_TITLE, true);
  let series: { id: string; title: string; slug: string } | null | undefined;
  if (body.series === null) series = null;
  else if (body.series !== undefined) {
    const raw = body.series as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProductionError('invalid_series', 'series must be { title, slug? } or null.');
    const seriesTitle = cleanText(raw.title, 'series', MAX_TITLE, true);
    const seriesSlug = raw.slug === undefined ? slugify(seriesTitle) : raw.slug;
    if (typeof seriesSlug !== 'string' || !SLUG_PATTERN.test(seriesSlug)) throw new ProductionError('invalid_series', 'series.slug must be lowercase words joined by hyphens.');
    series = { id: seriesId(uid, seriesSlug), title: seriesTitle, slug: seriesSlug };
  }
  const coverAssetId = body.coverAssetId === undefined ? undefined : cleanAssetId(body.coverAssetId, 'coverAssetId');
  if (coverAssetId) {
    const cover = (await loadOwnedAssets(uid, [coverAssetId])).get(coverAssetId);
    if (!cover) throw new ProductionError('asset_not_found', 'The cover is not one of your assets.', { ids: [coverAssetId] });
    if (!cover.mimeType.startsWith('image/')) throw new ProductionError('invalid_asset', 'The cover must be an image asset.');
  }

  let cast: CastMember[] | undefined;
  if (body.cast !== undefined) {
    try {
      cast = await resolveCast(uid, body.cast);
    } catch (error) {
      if (error instanceof CharacterError) throw new ProductionError(error.code, error.message, error.details);
      throw error;
    }
  }

  const id = productionId(uid, slug);
  const now = Date.now();
  const created = await adminDb().runTransaction(async (tx) => {
    const ref = productions().doc(id);
    const seriesRef = series ? seriesCollection().doc(series.id) : null;
    const [snapshot, seriesSnapshot] = await Promise.all([tx.get(ref), seriesRef ? tx.get(seriesRef) : Promise.resolve(null)]);
    const existing = snapshot.exists ? stored(snapshot.data()) : null;
    if (existing && existing.ownerUid !== uid) throw notFound();
    if (series && seriesRef) {
      const before = seriesSnapshot?.data();
      tx.set(seriesRef, { ownerUid: uid, title: series.title, slug: series.slug, createdAt: num(before?.createdAt, now), updatedAt: now });
    }
    const seriesFields = series === undefined ? {} : { seriesId: series?.id ?? null, seriesTitle: series?.title ?? null };
    if (existing) {
      tx.update(ref, { title, ...seriesFields, ...(coverAssetId === undefined ? {} : { coverAssetId }), ...(cast === undefined ? {} : { cast }), updatedAt: now });
      return false;
    }
    const production: StoredProduction = {
      ownerUid: uid, title, slug, seriesId: series?.id ?? null, seriesTitle: series?.title ?? null,
      coverAssetId: coverAssetId ?? null, currentCutId: null, approvedCutId: null, cuts: [], cast: cast ?? [], createdAt: now, updatedAt: now, reviewedAt: 0,
    };
    tx.set(ref, production);
    return true;
  });
  return { production: await getProduction(uid, id, origin), created };
}

interface CutPatch {
  id: string;
  status?: CutStatus;
  label?: string;
  notes?: string;
}

/**
 * `{ title?, coverAssetId?, approvedCutId?, currentCutId?, cuts?: [{ id, status?, label?, notes? }] }`.
 * Approving a cut that is not yet approved or final marks it approved; a cut
 * that stops being approved or final stops being the approved cut.
 */
export async function updateProduction(uid: string, id: string, patch: Record<string, unknown>, origin: string): Promise<ProductionDetail> {
  const title = patch.title === undefined ? undefined : cleanText(patch.title, 'title', MAX_TITLE, true);
  const coverAssetId = patch.coverAssetId === undefined ? undefined : cleanAssetId(patch.coverAssetId, 'coverAssetId');
  const pointer = (key: 'approvedCutId' | 'currentCutId'): string | null | undefined => {
    const value = patch[key];
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || !CUT_ID_PATTERN.test(value)) throw new ProductionError('invalid_cut_id', `${key} must be a cut id or null.`);
    return value;
  };
  const approvedCutId = pointer('approvedCutId');
  const currentCutId = pointer('currentCutId');
  const cutPatches: CutPatch[] = [];
  if (patch.cuts !== undefined) {
    if (!Array.isArray(patch.cuts) || patch.cuts.length > MAX_CUTS) throw new ProductionError('invalid_cuts', 'cuts must be a list of { id, status?, label?, notes? }.');
    for (const raw of patch.cuts as unknown[]) {
      const item = raw as Record<string, unknown>;
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !CUT_ID_PATTERN.test(item.id)) throw new ProductionError('invalid_cuts', 'Each cut needs its id.');
      if (item.status !== undefined && !isStatus(item.status)) throw new ProductionError('invalid_status', `status must be one of ${CUT_STATUSES.join(', ')}.`);
      cutPatches.push({
        id: item.id,
        ...(item.status === undefined ? {} : { status: item.status as CutStatus }),
        ...(item.label === undefined ? {} : { label: cleanText(item.label, 'label', MAX_LABEL, true) }),
        ...(item.notes === undefined ? {} : { notes: cleanText(item.notes, 'notes', MAX_NOTES, false) }),
      });
    }
  }
  if (coverAssetId) {
    const cover = (await loadOwnedAssets(uid, [coverAssetId])).get(coverAssetId);
    if (!cover || !cover.mimeType.startsWith('image/')) throw new ProductionError('asset_not_found', 'The cover must be one of your image assets.', { ids: [coverAssetId] });
  }

  await adminDb().runTransaction(async (tx) => {
    const { ref, production } = await ownedProduction(uid, id, tx);
    const cuts = production.cuts.map((cut) => ({ ...cut }));
    const byId = new Map(cuts.map((cut) => [cut.id, cut]));
    for (const cutPatch of cutPatches) if (!byId.has(cutPatch.id)) throw cutNotFound(cutPatch.id);
    for (const key of [approvedCutId, currentCutId]) if (key && !byId.has(key)) throw cutNotFound(key);

    const cutChanges = new Map<string, Partial<Pick<StoredCut, 'status' | 'label' | 'notes'>>>();
    const change = (cutId: string, fields: Partial<Pick<StoredCut, 'status' | 'label' | 'notes'>>) => cutChanges.set(cutId, { ...cutChanges.get(cutId), ...fields });
    let reviewed = false;
    for (const { id: cutId, ...fields } of cutPatches) {
      const cut = byId.get(cutId)!;
      if (fields.status && fields.status !== cut.status) reviewed = true;
      if (fields.status) cut.status = fields.status;
      if (fields.label) cut.label = fields.label;
      if (fields.notes !== undefined) Object.assign(cut, summaryNotes(fields.notes));
      change(cutId, fields);
    }
    let approved = production.approvedCutId;
    if (approvedCutId !== undefined) {
      if (approvedCutId !== production.approvedCutId) reviewed = true;
      approved = approvedCutId;
      const cut = approvedCutId ? byId.get(approvedCutId)! : null;
      if (cut && cut.status !== 'approved' && cut.status !== 'final') {
        if (cutPatches.some((p) => p.id === cut.id && p.status)) {
          throw new ProductionError('conflicting_status', `"${cut.id}" can't be the approved cut with status "${cut.status}".`);
        }
        cut.status = 'approved';
        change(cut.id, { status: 'approved' });
      }
    }
    const settled = settle({ ...production, cuts, approvedCutId: approved, currentCutId: currentCutId === undefined ? production.currentCutId : currentCutId });
    const now = Date.now();
    for (const [cutId, fields] of cutChanges) tx.update(cutsOf(id).doc(cutId), { ...fields, updatedAt: now });
    if (settled.approvedCutId !== production.approvedCutId) reviewed = true;
    tx.update(ref, {
      ...settled,
      cuts: fitSummaries(settled.cuts),
      ...(title === undefined ? {} : { title }),
      ...(coverAssetId === undefined ? {} : { coverAssetId }),
      ...(reviewed ? { reviewedAt: now } : {}),
      updatedAt: now,
    });
  });
  return getProduction(uid, id, origin);
}

/** Deletes the production, its cuts, and its comments and decisions. Its media assets are kept: other productions may use them. */
export async function deleteProduction(uid: string, id: string): Promise<void> {
  const { ref } = await ownedProduction(uid, id);
  const cuts = await cutsOf(id).get();
  await Promise.all(cuts.docs.map((doc) => cutsOf(id).doc(doc.id).delete()));
  await deleteProductionComments(id);
  await ref.delete();
}

// ---------------------------------------------------------------------------
// Cuts

async function cutResource(uid: string, productionId: string, cutId: string, cut: StoredCut, origin: string): Promise<ProductionCutResource> {
  const sourceIds = cut.cut ? cutAssetIds(cut.cut) : [];
  const assets = await loadOwnedAssets(uid, [...sourceIds, ...(cut.renderedAssetId ? [cut.renderedAssetId] : []), ...(cut.posterAssetId ? [cut.posterAssetId] : []), ...Object.values(cut.thumbs)]);
  const resolved = cut.cut ? resolveStoredCut(cut.cut, cut.words, assets) : { timeline: null, words: null, errors: [] };
  const links = cutLinks(origin, productionId, { id: cutId, renderedAssetId: cut.renderedAssetId });
  return {
    id: cutId,
    productionId,
    label: cut.label,
    status: cut.status,
    kind: cut.kind,
    notes: cut.notes,
    order: cut.order,
    createdAt: cut.createdAt,
    updatedAt: cut.updatedAt,
    lengthSeconds: cut.lengthSeconds,
    renderedAssetId: cut.renderedAssetId,
    posterAssetId: cut.posterAssetId,
    thumbs: cut.thumbs,
    source: cut.source,
    cut: cut.cut,
    words: cut.words,
    timeline: resolved.timeline,
    wordsSummary: resolved.words,
    errors: resolved.errors,
    assets: Object.fromEntries([...assets].map(([assetId, asset]) => [assetId, productionAssetResource(asset, origin)])),
    links: { self: links.self, production: `${origin}/api/v1/productions/${productionId}`, rendered: links.rendered },
  };
}

export async function getProductionCut(uid: string, id: string, cutId: string, origin: string): Promise<ProductionCutResource> {
  await ownedProduction(uid, id);
  if (!CUT_ID_PATTERN.test(cutId)) throw cutNotFound(cutId);
  const snapshot = await cutsOf(id).doc(cutId).get();
  const cut = storedCut(snapshot.data());
  if (!snapshot.exists || cut.ownerUid !== uid) throw cutNotFound(cutId);
  return cutResource(uid, id, cutId, cut, origin);
}

/**
 * Replaces one cut of the production, or adds it:
 * `{ label, status, kind, notes?, order, createdAt?, cut?, words?, renderedAssetId?, thumbs?, source?, lengthSeconds? }`.
 * A `cut` cut must resolve; its length is the timeline's.
 */
export async function putProductionCut(uid: string, id: string, cutId: string, body: Record<string, unknown>, origin: string): Promise<{ cut: ProductionCutResource; created: boolean }> {
  if (!CUT_ID_PATTERN.test(cutId)) throw new ProductionError('invalid_cut_id', 'A cut id is letters, digits, "_" and "-", at most 80 characters.');
  const input = parseCutInput(body);
  await ownedProduction(uid, id);
  const assets = await checkAssets(uid, input);

  let lengthSeconds = input.lengthSeconds;
  if (input.cut) {
    const resolved = resolveStoredCut(input.cut, input.words, assets);
    if (!resolved.timeline) throw new ProductionError('invalid_cut', 'The cut does not resolve.', { errors: resolved.errors });
    lengthSeconds = resolved.timeline.length;
  } else if (lengthSeconds === null) {
    const duration = assets.get(input.renderedAssetId!)?.durationMs;
    lengthSeconds = duration === undefined ? null : Math.round(duration) / 1000;
  }

  const created = await adminDb().runTransaction(async (tx) => {
    const { ref, production } = await ownedProduction(uid, id, tx);
    const cutRef = cutsOf(id).doc(cutId);
    const before = await tx.get(cutRef);
    const previous = before.exists ? storedCut(before.data()) : null;
    const now = Date.now();
    const doc: StoredCut = {
      ownerUid: uid, productionId: id, label: input.label, status: input.status, kind: input.kind, notes: input.notes,
      order: input.order, createdAt: input.createdAt ?? previous?.createdAt ?? now, updatedAt: now, lengthSeconds,
      cut: input.cut, words: input.words, renderedAssetId: input.renderedAssetId, posterAssetId: input.posterAssetId, thumbs: input.thumbs, source: input.source,
    };
    if (Buffer.byteLength(JSON.stringify(doc)) > MAX_CUT_DOC_BYTES) throw new ProductionError('cut_too_large', 'The cut and its words are too large to store.');
    const summary: CutSummary = {
      id: cutId, label: doc.label, status: doc.status, kind: doc.kind, lengthSeconds, createdAt: doc.createdAt, order: doc.order,
      renderedAssetId: doc.renderedAssetId, posterAssetId: doc.posterAssetId, ...summaryNotes(doc.notes),
    };
    const cuts = [...production.cuts.filter((cut) => cut.id !== cutId), summary];
    if (cuts.length > MAX_CUTS) throw new ProductionError('too_many_cuts', `A production holds at most ${MAX_CUTS} cuts.`);
    tx.set(cutRef, doc);
    const settled = settle({ ...production, cuts });
    tx.update(ref, { ...settled, cuts: fitSummaries(settled.cuts), updatedAt: now });
    return !previous;
  });
  return { cut: await getProductionCut(uid, id, cutId, origin), created };
}

export async function deleteProductionCut(uid: string, id: string, cutId: string): Promise<void> {
  if (!CUT_ID_PATTERN.test(cutId)) throw cutNotFound(cutId);
  await adminDb().runTransaction(async (tx) => {
    const { ref, production } = await ownedProduction(uid, id, tx);
    if (!production.cuts.some((cut) => cut.id === cutId)) throw cutNotFound(cutId);
    tx.delete(cutsOf(id).doc(cutId));
    tx.update(ref, { ...settle({ ...production, cuts: production.cuts.filter((cut) => cut.id !== cutId) }), updatedAt: Date.now() });
  });
}
