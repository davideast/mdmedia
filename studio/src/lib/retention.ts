/**
 * How long a generation is kept.
 *
 * Pure, so the browser, the API and the sweeper decide expiry the same way.
 * An item resolves, in order, to: locked (kept, and cannot be deleted), its own
 * expiry, the default for its media type, the global default, or kept forever.
 */

import { MEDIA_TYPES, type MediaType } from './media-types';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const MAX_TTL_MS = 10 * 365 * UNIT_MS.d;

/** A default TTL, e.g. `7d`. It reaches only items created at or after `since`; 0 reaches them all. */
export interface TtlDefault {
  ttl: string;
  since: number;
}

export interface RetentionSettings {
  global: TtlDefault | null;
  /** A key set to `null` keeps that type forever; a missing key inherits the global default. */
  byType: Partial<Record<MediaType, TtlDefault | null>>;
}

export const DEFAULT_RETENTION: RetentionSettings = { global: null, byType: {} };

/** The retention state stored on an item. Server-owned: clients never write it. */
export interface Retention {
  locked: boolean;
  expiresAt: number | null;
}

export interface RetainedItem extends Retention {
  type: MediaType;
  createdAt: number;
  status: 'generating' | 'ready' | 'error';
}

/** Milliseconds for `90m`, `6h`, `3d` or `2w`; undefined for anything else. */
export function parseTtl(text: string): number | undefined {
  const match = /^(\d+)([mhdw])$/.exec(text.trim().toLowerCase());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms > 0 && ms <= MAX_TTL_MS ? ms : undefined;
}

function defaultFor(type: MediaType, settings: RetentionSettings): TtlDefault | null {
  return type in settings.byType ? settings.byType[type] ?? null : settings.global;
}

export type RetentionSource = 'locked' | 'item' | 'type-default' | 'global-default' | 'none';

/** When the item expires and which rule decided it, for showing people why. */
export function explainRetention(
  item: Pick<RetainedItem, 'type' | 'createdAt' | 'locked' | 'expiresAt'>,
  settings: RetentionSettings,
): { expiresAt: number | null; source: RetentionSource } {
  if (item.locked) return { expiresAt: null, source: 'locked' };
  if (typeof item.expiresAt === 'number') return { expiresAt: item.expiresAt, source: 'item' };
  const fallback = defaultFor(item.type, settings);
  const source = item.type in settings.byType ? 'type-default' : 'global-default';
  if (!fallback || item.createdAt < fallback.since) return { expiresAt: null, source: 'none' };
  const ms = parseTtl(fallback.ttl);
  return ms === undefined ? { expiresAt: null, source: 'none' } : { expiresAt: item.createdAt + ms, source };
}

/** When the item expires, or null if it is kept. */
export function resolveExpiry(
  item: Pick<RetainedItem, 'type' | 'createdAt' | 'locked' | 'expiresAt'>,
  settings: RetentionSettings,
): number | null {
  return explainRetention(item, settings).expiresAt;
}

export function isExpired(item: RetainedItem, settings: RetentionSettings, now: number): boolean {
  if (item.status === 'generating') return false;
  const expiresAt = resolveExpiry(item, settings);
  return expiresAt !== null && expiresAt <= now;
}

/** A locked item stays until it is unlocked, whether the request comes from a person, the API or the sweeper. */
export function canDelete(item: Pick<Retention, 'locked'>): boolean {
  return !item.locked;
}

/**
 * Sets one default. `keep` stops that type expiring even under a global
 * default; `inherit` removes the type's own setting. A new default reaches only
 * items created from now on unless `retroactive` is set.
 */
export function setDefaultTtl(
  current: RetentionSettings,
  target: MediaType | 'global',
  ttl: string,
  now: number,
  retroactive: boolean,
): RetentionSettings {
  const special = ttl === 'keep' || ttl === 'inherit';
  if (!special && parseTtl(ttl) === undefined) throw new Error(`"${ttl}" is not a valid TTL. Use a number and m, h, d or w, like 36h.`);
  const entry: TtlDefault = { ttl, since: retroactive ? 0 : now };
  if (target === 'global') {
    if (ttl === 'inherit') throw new Error('The global default has nothing to inherit from. Use keep.');
    return { ...current, global: ttl === 'keep' ? null : entry };
  }
  const byType = { ...current.byType };
  if (ttl === 'inherit') delete byType[target];
  else byType[target] = ttl === 'keep' ? null : entry;
  return { ...current, byType };
}

function readDefault(value: unknown): TtlDefault | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const { ttl, since } = value as Record<string, unknown>;
  if (typeof ttl !== 'string' || parseTtl(ttl) === undefined) return undefined;
  return { ttl, since: typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : 0 };
}

/** Reads stored settings, dropping anything unreadable so a bad value can never expire work. */
export function readRetentionSettings(value: unknown): RetentionSettings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const byType: RetentionSettings['byType'] = {};
  const stored = raw.byType && typeof raw.byType === 'object' ? (raw.byType as Record<string, unknown>) : {};
  for (const { type } of MEDIA_TYPES) {
    if (!(type in stored)) continue;
    const read = readDefault(stored[type]);
    if (read !== undefined) byType[type] = read;
  }
  const global = readDefault(raw.global);
  return { global: global ?? null, byType };
}

/** A request to change one item's retention. Only the keys present change. */
export interface RetentionPatch {
  locked?: boolean;
  /** An absolute time, or null to clear the item's own expiry. */
  expiresAt?: number | null;
}

/** Bad retention input; routes turn it into a 400. */
export class RetentionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionInputError';
  }
}

const TTL_HINT = 'Use a number and m, h, d or w, like 36h.';

/**
 * Reads `{ ttl?, expiresAt?, locked? }`. A ttl is relative to `now` and becomes
 * an absolute expiry; `null` clears it. Anything else is refused, so a typo can
 * never silently leave work with the wrong lifetime.
 */
export function parseRetentionPatch(value: unknown, now: number): RetentionPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetentionInputError('Send retention as an object like { "ttl": "36h" } or { "locked": true }.');
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== 'ttl' && key !== 'expiresAt' && key !== 'locked');
  if (unknown.length > 0) throw new RetentionInputError(`Unknown retention field: ${unknown.join(', ')}. Use ttl, expiresAt or locked.`);
  if (Object.keys(raw).length === 0) throw new RetentionInputError('Send at least one of ttl, expiresAt or locked.');
  if ('ttl' in raw && 'expiresAt' in raw) throw new RetentionInputError('Send either ttl or expiresAt, not both.');

  const patch: RetentionPatch = {};
  if ('locked' in raw) {
    if (typeof raw.locked !== 'boolean') throw new RetentionInputError('locked must be true or false.');
    patch.locked = raw.locked;
  }
  if ('ttl' in raw) {
    if (raw.ttl === null) patch.expiresAt = null;
    else {
      const ms = typeof raw.ttl === 'string' ? parseTtl(raw.ttl) : undefined;
      if (ms === undefined) throw new RetentionInputError(`"${String(raw.ttl)}" is not a valid ttl. ${TTL_HINT}`);
      patch.expiresAt = now + ms;
    }
  }
  if ('expiresAt' in raw) {
    if (raw.expiresAt === null) patch.expiresAt = null;
    else {
      const at = typeof raw.expiresAt === 'number' ? raw.expiresAt : typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN;
      if (!Number.isFinite(at)) throw new RetentionInputError('expiresAt must be a timestamp in milliseconds or an ISO date.');
      if (at <= now) throw new RetentionInputError('expiresAt must be in the future.');
      patch.expiresAt = at;
    }
  }
  return patch;
}

/**
 * Splits retention out of a create body (`ttl` shorthand or a `retention`
 * object) so the rest can still be validated strictly by the type's own parser.
 */
export function extractRetention(body: unknown, now: number): { rest: unknown; patch: RetentionPatch | undefined } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { rest: body, patch: undefined };
  const { ttl, retention, ...rest } = body as Record<string, unknown>;
  if (ttl === undefined && retention === undefined) return { rest: body, patch: undefined };
  if (ttl !== undefined && retention !== undefined) throw new RetentionInputError('Send either ttl or retention, not both.');
  return { rest, patch: parseRetentionPatch(ttl !== undefined ? { ttl } : retention, now) };
}
