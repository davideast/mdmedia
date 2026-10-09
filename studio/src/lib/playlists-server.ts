/**
 * Playlists for `/api/v1`, through the Admin SDK and scoped to one owner.
 *
 * Every change to the item list runs in a transaction that reads the playlist
 * as it is now and applies id-based edits to it, so the app and an agent can
 * edit the same playlist without overwriting each other.
 */

import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { apiError } from './api-auth';
import { adminDb } from './firebase-admin';
import type { NarrationPlacement } from './narration-api';
import { applyPlaylistOps, checkReorder, PlaylistOpError, type PlaylistOp, type PlaylistPosition } from './playlist-ops';
import { MAX_PLAYLIST_ITEMS, type NarrationStatus } from './types';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const LIST_LIMIT = 100;

export interface PlaylistItem {
  id: string;
  title: string;
  /** `missing` means the narration was deleted or has not been written yet. */
  status: NarrationStatus | 'missing';
  durationMs: number;
  createdAt: number | null;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  durationMs: number;
  counts: { ready: number; streaming: number; error: number; missing: number };
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  items: PlaylistItem[];
}

interface StoredPlaylist {
  ownerUid: string;
  title: string;
  description: string;
  narrationIds: string[];
  createdAt: number;
  updatedAt: number;
}

const playlists = () => adminDb().collection('playlists');
const narrationRef = (id: string) => adminDb().collection('narrations').doc(id);

function stored(data: FirebaseFirestore.DocumentData | undefined): StoredPlaylist {
  return {
    ownerUid: typeof data?.ownerUid === 'string' ? data.ownerUid : '',
    title: typeof data?.title === 'string' ? data.title : 'Untitled playlist',
    description: typeof data?.description === 'string' ? data.description : '',
    narrationIds: Array.isArray(data?.narrationIds) ? data.narrationIds.filter((id: unknown): id is string => typeof id === 'string') : [],
    createdAt: typeof data?.createdAt === 'number' ? data.createdAt : 0,
    updatedAt: typeof data?.updatedAt === 'number' ? data.updatedAt : 0,
  };
}

const notFound = () => new PlaylistOpError('playlist_not_found', 'No playlist with that id or title.');

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlaylistOpError('invalid_title', 'title must be non-empty text.');
  if (value.trim().length > MAX_TITLE) throw new PlaylistOpError('invalid_title', `title is limited to ${MAX_TITLE} characters.`);
  return value.trim();
}

function cleanDescription(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION) {
    throw new PlaylistOpError('invalid_description', `description must be text of at most ${MAX_DESCRIPTION} characters.`);
  }
  return value.trim();
}

async function readItems(ids: readonly string[]): Promise<PlaylistItem[]> {
  if (ids.length === 0) return [];
  const snapshots = await Promise.all(ids.map((id) => narrationRef(id).get()));
  return snapshots.map((snapshot, index) => {
    const data = snapshot.data();
    if (!snapshot.exists || !data) return { id: ids[index]!, title: '', status: 'missing', durationMs: 0, createdAt: null };
    return {
      id: ids[index]!,
      title: typeof data.title === 'string' ? data.title : '',
      status: data.status === 'ready' || data.status === 'error' ? data.status : 'streaming',
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : null,
    };
  });
}

function summarize(id: string, playlist: StoredPlaylist, items: PlaylistItem[]): PlaylistSummary {
  const counts = { ready: 0, streaming: 0, error: 0, missing: 0 };
  for (const item of items) counts[item.status] += 1;
  return {
    id,
    title: playlist.title,
    description: playlist.description,
    itemCount: playlist.narrationIds.length,
    durationMs: items.reduce((total, item) => total + item.durationMs, 0),
    counts,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
}

async function ownedPlaylist(uid: string, id: string, tx?: Transaction): Promise<{ ref: DocumentReference; playlist: StoredPlaylist }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw notFound();
  const ref = playlists().doc(id);
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  const playlist = stored(snapshot.data());
  if (!snapshot.exists || playlist.ownerUid !== uid) throw notFound();
  return { ref, playlist };
}

/** Finds one of `uid`'s playlists by id, or else by exact title (ignoring case). */
export async function resolvePlaylistId(uid: string, idOrTitle: string): Promise<string> {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(idOrTitle)) {
    const byId = await playlists().doc(idOrTitle).get();
    if (byId.exists && byId.data()?.ownerUid === uid) return byId.id;
  }
  const wanted = idOrTitle.trim().toLowerCase();
  const all = await playlists().where('ownerUid', '==', uid).get();
  const matches = all.docs.filter((doc) => String(doc.data().title ?? '').trim().toLowerCase() === wanted);
  if (matches.length > 1) {
    throw new PlaylistOpError('playlist_ambiguous', `${matches.length} playlists are titled "${idOrTitle}". Use the id instead.`, matches.map((doc) => doc.id));
  }
  if (!matches[0]) throw new PlaylistOpError('playlist_not_found', `No playlist with the id or title "${idOrTitle}".`);
  return matches[0].id;
}

/** Narrations `uid` cannot put in a playlist: not theirs, or nonexistent. */
async function foreignIds(uid: string, ids: readonly string[], tx?: Transaction): Promise<string[]> {
  if (ids.length === 0) return [];
  const refs = ids.map(narrationRef);
  const snapshots = await Promise.all(refs.map((ref) => (tx ? tx.get(ref) : ref.get())));
  return snapshots.filter((snapshot) => snapshot.data()?.ownerUid !== uid).map((snapshot) => snapshot.id);
}

function assertNoForeign(ids: string[]): void {
  if (ids.length) throw new PlaylistOpError('narration_not_found', `No narration of yours with id ${ids.map((id) => `"${id}"`).join(', ')}.`, ids);
}

export async function listPlaylists(uid: string): Promise<PlaylistSummary[]> {
  const snapshot = await playlists().where('ownerUid', '==', uid).orderBy('updatedAt', 'desc').limit(LIST_LIMIT).get();
  const lists = snapshot.docs.map((doc) => ({ id: doc.id, playlist: stored(doc.data()) }));
  const items = new Map((await readItems([...new Set(lists.flatMap(({ playlist }) => playlist.narrationIds))])).map((item) => [item.id, item]));
  return lists.map(({ id, playlist }) => summarize(id, playlist, playlist.narrationIds.map((narrationId) => items.get(narrationId)!)));
}

export async function getPlaylist(uid: string, id: string): Promise<PlaylistDetail> {
  const { playlist } = await ownedPlaylist(uid, id);
  const items = await readItems(playlist.narrationIds);
  return { ...summarize(id, playlist, items), items };
}

export async function createPlaylist(uid: string, input: { title?: unknown; description?: unknown; narrationIds?: unknown }): Promise<PlaylistDetail> {
  const title = cleanTitle(input.title);
  const description = input.description === undefined ? '' : cleanDescription(input.description);
  const ids = input.narrationIds === undefined ? [] : input.narrationIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new PlaylistOpError('invalid_items', 'narrationIds must be a list of narration ids.');
  const narrationIds = applyPlaylistOps([], ids.length ? [{ add: ids }] : []).narrationIds;
  assertNoForeign(await foreignIds(uid, narrationIds));
  const now = Date.now();
  const ref = playlists().doc();
  await ref.set({ ownerUid: uid, title, description, narrationIds, createdAt: now, updatedAt: now });
  return getPlaylist(uid, ref.id);
}

export async function updatePlaylistDetails(uid: string, id: string, patch: { title?: unknown; description?: unknown }): Promise<PlaylistDetail> {
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.title !== undefined) update.title = cleanTitle(patch.title);
  if (patch.description !== undefined) update.description = cleanDescription(patch.description);
  const { ref } = await ownedPlaylist(uid, id);
  await ref.update(update);
  return getPlaylist(uid, id);
}

/**
 * Applies id-based edits to the playlist as it is now, all or nothing.
 * `trustedIds` skips the ownership read for a narration the caller just
 * claimed and whose document may not be written yet.
 */
export async function editPlaylistItems(uid: string, id: string, ops: readonly PlaylistOp[], { trustedIds = [] }: { trustedIds?: string[] } = {}) {
  const result = await adminDb().runTransaction(async (tx) => {
    const { ref, playlist } = await ownedPlaylist(uid, id, tx);
    const toCheck = ops.flatMap((op) => ('add' in op ? op.add : [])).filter((narrationId) => !trustedIds.includes(narrationId) && !playlist.narrationIds.includes(narrationId));
    assertNoForeign(await foreignIds(uid, [...new Set(toCheck)], tx));
    const applied = applyPlaylistOps(playlist.narrationIds, ops);
    tx.update(ref, { narrationIds: applied.narrationIds, updatedAt: Date.now() });
    return applied;
  });
  return { ...(await getPlaylist(uid, id)), unchanged: result.unchanged };
}

/** Replaces the order; `order` must hold exactly the playlist's current items. */
export async function reorderPlaylist(uid: string, id: string, order: unknown): Promise<PlaylistDetail> {
  if (!Array.isArray(order) || !order.every((item) => typeof item === 'string')) throw new PlaylistOpError('invalid_order', 'order must be a list of narration ids.');
  await adminDb().runTransaction(async (tx) => {
    const { ref, playlist } = await ownedPlaylist(uid, id, tx);
    checkReorder(playlist.narrationIds, order);
    tx.update(ref, { narrationIds: order, updatedAt: Date.now() });
  });
  return getPlaylist(uid, id);
}

/** Deletes the playlist. The narrations in it are untouched. */
export async function deletePlaylist(uid: string, id: string): Promise<void> {
  const { ref } = await ownedPlaylist(uid, id);
  await ref.delete();
}

export interface PreparedPlacement {
  /** null when the playlist is to be created once the narration starts. */
  playlistId: string | null;
  title: string;
  position: PlaylistPosition;
}

/**
 * Checks a narrate-time placement before any audio is made: the playlist
 * exists (or may be created), has room, and holds the anchor of the position.
 */
export async function preparePlacement(uid: string, placement: NarrationPlacement, narrationId: string | undefined): Promise<PreparedPlacement> {
  let playlistId: string;
  try {
    playlistId = await resolvePlaylistId(uid, placement.playlist);
  } catch (error) {
    if (!(error instanceof PlaylistOpError && error.code === 'playlist_not_found' && placement.create)) throw error;
    if (typeof placement.position === 'object') {
      throw new PlaylistOpError('anchor_not_found', 'A new playlist is empty, so the position must be "start" or "end".');
    }
    return { playlistId: null, title: cleanTitle(placement.playlist), position: placement.position };
  }
  const { playlist } = await ownedPlaylist(uid, playlistId);
  if (!(narrationId && playlist.narrationIds.includes(narrationId))) {
    if (playlist.narrationIds.length >= MAX_PLAYLIST_ITEMS) {
      throw new PlaylistOpError('playlist_full', `"${playlist.title}" already holds ${MAX_PLAYLIST_ITEMS} items.`);
    }
    applyPlaylistOps(playlist.narrationIds, [{ add: ['__new__'], at: placement.position }]);
  }
  return { playlistId, title: playlist.title, position: placement.position };
}

/** Adds a just-started narration where `preparePlacement` said it would go. */
export async function placeNarration(uid: string, prepared: PreparedPlacement, narrationId: string) {
  if (prepared.playlistId === null) {
    const created = await createPlaylist(uid, { title: prepared.title });
    prepared = { ...prepared, playlistId: created.id };
  }
  const result = await editPlaylistItems(uid, prepared.playlistId!, [{ add: [narrationId], at: prepared.position }], { trustedIds: [narrationId] });
  return { id: result.id, title: result.title, position: result.items.findIndex((item) => item.id === narrationId) + 1 };
}

const PLAYLIST_ERROR_STATUS: Record<string, number> = {
  playlist_not_found: 404,
  narration_not_found: 404,
  playlist_ambiguous: 409,
  playlist_full: 409,
  invalid_order: 409,
  anchor_not_found: 400,
  not_in_playlist: 400,
  invalid_title: 400,
  invalid_description: 400,
  invalid_items: 400,
};


/** Turns a playlist error into its API response; anything else is rethrown. */
export function playlistErrorResponse(error: unknown): Response {
  if (!(error instanceof PlaylistOpError)) throw error;
  const response = apiError(PLAYLIST_ERROR_STATUS[error.code] ?? 400, error.code, error.message);
  if (!error.ids.length) return response;
  return Response.json({ error: { code: error.code, message: error.message, ids: error.ids } }, { status: response.status });
}
