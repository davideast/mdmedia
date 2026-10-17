/**
 * Deletes generations whose time is up.
 *
 * `sweepExpired` is the one place that decides what goes: it applies
 * `isExpired` to every item, never touches a locked or still-generating one,
 * and deletes at most `limit` per run so a mistaken default cannot wipe a
 * library in a single pass. `startRetentionSweeper` runs it on a timer inside
 * the server, the same way the media workers run.
 */

import type { DocumentData, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';

import { adminBucket, adminDb } from './firebase-admin';
import type { MediaType } from './media-types';
import { purgeNarrationData, STALE_STREAMING_MS } from './narration-server';
import { DEFAULT_RETENTION, isExpired, resolveExpiry, type RetainedItem, type RetentionSettings } from './retention';
import { loadRetentionSettings } from './retention-server';

export interface SweepCandidate {
  type: MediaType;
  id: string;
  ownerUid: string;
  title: string;
  expiresAt: number;
}

export interface SweepReport {
  checked: number;
  expired: SweepCandidate[];
  purged: number;
  failed: number;
  /** True when more items had expired than this run was allowed to delete. */
  truncated: boolean;
}

export interface SweepOptions {
  now?: number;
  /** Report what would be deleted without deleting it. */
  dryRun?: boolean;
  /** The most items one run deletes. */
  limit?: number;
  /** Look only at this person's items. */
  uid?: string;
  /** Evaluate against changed settings, to preview a default before saving it. */
  adjust?: (settings: RetentionSettings) => RetentionSettings;
}

/** Thrown when something tries to delete a locked item. */
export class MediaLockedError extends Error {
  constructor(type: MediaType) {
    super(`This ${type} is locked. Unlock it before deleting it.`);
    this.name = 'MediaLockedError';
  }
}

const PAGE = 200;
const OTHER_TYPES: MediaType[] = ['image', 'video', 'music', 'sfx'];

async function* pages(base: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let after: string | undefined;
  for (;;) {
    let query = base.orderBy('__name__').limit(PAGE);
    if (after !== undefined) query = query.startAfter(after);
    const { docs } = await query.get();
    if (docs.length === 0) return;
    yield docs;
    if (docs.length < PAGE) return;
    after = docs.at(-1)!.id;
  }
}

/**
 * Deletes an image, video, music or sfx item with everything it owns: stored
 * files, generations, assets, activity and idempotency records. The item
 * document goes last, so a run that fails partway is simply finished by the next.
 */
export async function purgeMediaItem(uid: string, type: Exclude<MediaType, 'narration'>, id: string): Promise<void> {
  const itemRef = adminDb().collection('mediaItems').doc(`${type}_${id}`);
  const item = (await itemRef.get()).data();
  if (!item || item.ownerUid !== uid || item.type !== type) return;
  if (item.locked === true) throw new MediaLockedError(type);

  const owned = (collection: string) =>
    adminDb().collection(collection).where('itemId', '==', id).where('ownerUid', '==', uid).get();
  const [assets, generations, activity, requests] = await Promise.all([
    owned('mediaAssets'), owned('mediaGenerations'), owned('mediaActivity'), owned('mediaRequests'),
  ]);

  const bucket = adminBucket();
  const paths = assets.docs.flatMap((doc) => [doc.data().path, doc.data().thumbnailPath]).filter((path): path is string => typeof path === 'string' && path.length > 0);
  await Promise.all(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
  await Promise.all([...assets.docs, ...generations.docs, ...activity.docs, ...requests.docs].map((doc) => doc.ref.delete()));
  await itemRef.delete();
}

const mediaStatus = (status: unknown): RetainedItem['status'] =>
  status === 'queued' || status === 'generating' ? 'generating' : status === 'ready' ? 'ready' : 'error';

const narrationStatus = (data: DocumentData, now: number): RetainedItem['status'] => {
  if (data.status === 'error') return 'error';
  if (data.status !== 'streaming') return 'ready';
  // A narration stuck "streaming" long past any real synthesis was interrupted.
  return now - Number(data.updatedAt || data.createdAt || 0) > STALE_STREAMING_MS ? 'error' : 'generating';
};

export async function sweepExpired(options: SweepOptions = {}): Promise<SweepReport> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 25;
  const settingsCache = new Map<string, RetentionSettings>();
  const settingsFor = async (owner: string) => {
    let settings = settingsCache.get(owner);
    if (!settings) {
      settings = await loadRetentionSettings(owner).catch(() => DEFAULT_RETENTION);
      settings = options.adjust ? options.adjust(settings) : settings;
      settingsCache.set(owner, settings);
    }
    return settings;
  };

  const expired: SweepCandidate[] = [];
  let checked = 0;
  const consider = async (type: MediaType, id: string, data: DocumentData, status: RetainedItem['status']) => {
    const owner = data.ownerUid;
    if (typeof owner !== 'string') return;
    checked += 1;
    const item: RetainedItem = {
      type, status, createdAt: Number(data.createdAt ?? 0), locked: data.locked === true,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    };
    const settings = await settingsFor(owner);
    if (!isExpired(item, settings, now)) return;
    expired.push({ type, id, ownerUid: owner, title: String(data.title ?? ''), expiresAt: resolveExpiry(item, settings)! });
  };

  const narrations = adminDb().collection('narrations');
  const media = adminDb().collection('mediaItems');
  for await (const docs of pages(options.uid ? narrations.where('ownerUid', '==', options.uid) : narrations)) {
    for (const doc of docs) await consider('narration', doc.id, doc.data(), narrationStatus(doc.data(), now));
  }
  for await (const docs of pages(options.uid ? media.where('ownerUid', '==', options.uid) : media)) {
    for (const doc of docs) {
      const data = doc.data();
      if (OTHER_TYPES.includes(data.type)) await consider(data.type, String(data.id ?? doc.id), data, mediaStatus(data.status));
    }
  }

  expired.sort((a, b) => a.expiresAt - b.expiresAt);
  if (options.dryRun) return { checked, expired, purged: 0, failed: 0, truncated: false };

  let purged = 0;
  let failed = 0;
  for (const item of expired.slice(0, limit)) {
    try {
      if (item.type === 'narration') await purgeNarrationData(item.id, item.ownerUid);
      else await purgeMediaItem(item.ownerUid, item.type, item.id);
      purged += 1;
      console.info(`[retention] deleted expired ${item.type} ${item.id}`);
    } catch (error) {
      failed += 1;
      console.error(`[retention] could not delete ${item.type} ${item.id}:`, error instanceof Error ? error.message : 'unknown error');
    }
  }
  return { checked, expired, purged, failed, truncated: expired.length > limit };
}

const globalSweeper = globalThis as typeof globalThis & { __mdmediaRetentionSweeper?: { timer: ReturnType<typeof setInterval> | null; running: boolean } };
const sweeper = globalSweeper.__mdmediaRetentionSweeper ??= { timer: null, running: false };

/**
 * Starts the periodic sweep. `MDMEDIA_RETENTION_SWEEP=off` disables it,
 * `MDMEDIA_RETENTION_DRY_RUN=1` only logs what it would delete, and
 * `MDMEDIA_RETENTION_INTERVAL_MS` changes the 60 second cadence (10 s minimum).
 */
export function startRetentionSweeper(): void {
  if (sweeper.timer || process.env.MDMEDIA_RETENTION_SWEEP === 'off') return;
  const interval = Math.max(10_000, Number(process.env.MDMEDIA_RETENTION_INTERVAL_MS) || 60_000);
  const dryRun = process.env.MDMEDIA_RETENTION_DRY_RUN === '1';
  const tick = async () => {
    if (sweeper.running) return;
    sweeper.running = true;
    try {
      const report = await sweepExpired({ dryRun });
      if (dryRun && report.expired.length > 0) console.info(`[retention] dry run: ${report.expired.length} item(s) would be deleted`);
    } catch (error) {
      console.error('[retention] sweep failed:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      sweeper.running = false;
    }
  };
  // Give the sandbox and workers a moment to come up before the first pass.
  const first = setTimeout(() => void tick(), 30_000);
  first.unref();
  sweeper.timer = setInterval(() => void tick(), interval);
  sweeper.timer.unref();
}
