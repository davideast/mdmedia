/**
 * Playlist edits as pure functions over the ordered id list.
 *
 * Edits name items by id and positions by neighbouring ids, so applying one to
 * whatever the playlist holds right now (inside a transaction) never loses a
 * change someone else made in between. Shared by the API, the app, and tests.
 */

import { MAX_PLAYLIST_ITEMS } from './types';

export type PlaylistPosition = 'start' | 'end' | { before: string } | { after: string };

export type PlaylistOp =
  | { add: string[]; at?: PlaylistPosition }
  | { remove: string[] }
  | { move: string; to: PlaylistPosition };

export interface PlaylistOpsResult {
  narrationIds: string[];
  /** Adds of items already present and removes of items not present; both are no-ops. */
  unchanged: string[];
}

export class PlaylistOpError extends Error {
  constructor(readonly code: string, message: string, readonly ids: string[] = []) {
    super(message);
    this.name = 'PlaylistOpError';
  }
}

function insertionIndex(list: readonly string[], position: PlaylistPosition = 'end'): number {
  if (position === 'start') return 0;
  if (position === 'end') return list.length;
  const anchor = 'before' in position ? position.before : position.after;
  const index = list.indexOf(anchor);
  if (index < 0) throw new PlaylistOpError('anchor_not_found', `"${anchor}" is not in this playlist.`, [anchor]);
  return 'before' in position ? index : index + 1;
}

/** Applies `ops` in order. Throws `PlaylistOpError` and changes nothing if any op is invalid. */
export function applyPlaylistOps(current: readonly string[], ops: readonly PlaylistOp[]): PlaylistOpsResult {
  let list = [...current];
  const unchanged: string[] = [];
  for (const op of ops) {
    if ('add' in op) {
      const fresh = [...new Set(op.add)].filter((id) => {
        if (list.includes(id)) { unchanged.push(id); return false; }
        return true;
      });
      const index = insertionIndex(list, op.at);
      list = [...list.slice(0, index), ...fresh, ...list.slice(index)];
    } else if ('remove' in op) {
      for (const id of op.remove) if (!list.includes(id)) unchanged.push(id);
      list = list.filter((id) => !op.remove.includes(id));
    } else {
      if (!list.includes(op.move)) throw new PlaylistOpError('not_in_playlist', `"${op.move}" is not in this playlist.`, [op.move]);
      if (typeof op.to === 'object' && ('before' in op.to ? op.to.before : op.to.after) === op.move) continue;
      list = list.filter((id) => id !== op.move);
      const index = insertionIndex(list, op.to);
      list.splice(index, 0, op.move);
    }
  }
  if (list.length > MAX_PLAYLIST_ITEMS) {
    throw new PlaylistOpError('playlist_full', `A playlist holds at most ${MAX_PLAYLIST_ITEMS} items; this would make ${list.length}.`);
  }
  return { narrationIds: list, unchanged };
}

/** A full reorder must hold exactly the items already there, so nothing is dropped or added by accident. */
export function checkReorder(current: readonly string[], order: readonly string[]): void {
  const missing = current.filter((id) => !order.includes(id));
  const extra = order.filter((id) => !current.includes(id));
  if (missing.length || extra.length || new Set(order).size !== order.length) {
    throw new PlaylistOpError(
      'invalid_order',
      'order must list exactly the items in the playlist, once each. Read the playlist again and retry.',
      [...missing, ...extra],
    );
  }
}

/** Every narration id an edit would bring into the playlist. */
export function addedIds(ops: readonly PlaylistOp[]): string[] {
  return [...new Set(ops.flatMap((op) => ('add' in op ? op.add : [])))];
}

const isPosition = (value: unknown): value is PlaylistPosition =>
  value === 'start' || value === 'end' ||
  (typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (typeof (value as { before?: unknown }).before === 'string' || typeof (value as { after?: unknown }).after === 'string'));

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));

/** Validates untrusted ops from a request body; returns an error message for the first bad one. */
export function parsePlaylistOps(value: unknown): PlaylistOp[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'ops must be a non-empty list of { add }, { remove }, or { move } edits.';
  if (value.length > 50) return 'Send at most 50 edits at a time.';
  const ops: PlaylistOp[] = [];
  for (const [index, raw] of value.entries()) {
    const op = raw as Record<string, unknown>;
    const where = `ops[${index}]`;
    if (typeof raw !== 'object' || raw === null) return `${where} must be an object.`;
    if ('add' in op) {
      if (!isIdList(op.add)) return `${where}.add must be a list of narration ids.`;
      if (op.at !== undefined && !isPosition(op.at)) return `${where}.at must be "start", "end", { "before": id }, or { "after": id }.`;
      ops.push({ add: op.add, ...(op.at === undefined ? {} : { at: op.at as PlaylistPosition }) });
    } else if ('remove' in op) {
      if (!isIdList(op.remove)) return `${where}.remove must be a list of narration ids.`;
      ops.push({ remove: op.remove });
    } else if ('move' in op) {
      if (typeof op.move !== 'string') return `${where}.move must be a narration id.`;
      if (!isPosition(op.to)) return `${where}.to must be "start", "end", { "before": id }, or { "after": id }.`;
      ops.push({ move: op.move, to: op.to });
    } else {
      return `${where} must have add, remove, or move.`;
    }
  }
  return ops;
}

export function parsePlaylistPosition(value: unknown): PlaylistPosition | undefined | { error: string } {
  if (value === undefined || isPosition(value)) return value;
  return { error: 'playlistPosition must be "start", "end", { "before": id }, or { "after": id }.' };
}
