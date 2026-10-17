/**
 * Reading and writing retention for the signed-in owner's generations.
 *
 * Retention lives on the item itself: `narrations/{id}` for narrations, and
 * `mediaItems/{type}_{id}` for everything else. Clients never write it, so the
 * lock holds even against a hand-built Firestore request.
 */

import { adminDb } from './firebase-admin';
import { MediaError, validMediaId } from './image-request';
import { syncNarrationCatalog } from './media-catalog-server';
import type { MediaType } from './media-types';
import {
  DEFAULT_RETENTION,
  RetentionInputError,
  explainRetention,
  extractRetention,
  setDefaultTtl,
  type RetentionPatch,
  type RetentionSettings,
  type RetentionView,
} from './retention';
import { loadUserSettings } from './user-settings-server';

export interface StoredRetention {
  locked?: boolean;
  expiresAt?: number | null;
}

/**
 * The retention fields to copy when an item document is rewritten (a new
 * generation on an existing item), so regenerating never unlocks or resets it.
 */
export function carriedRetention(previous: StoredRetention | undefined): { locked: boolean; expiresAt: number | null } {
  return {
    locked: previous?.locked === true,
    expiresAt: typeof previous?.expiresAt === 'number' ? previous.expiresAt : null,
  };
}

const itemRef = (type: MediaType, id: string) =>
  type === 'narration'
    ? adminDb().collection('narrations').doc(id)
    : adminDb().collection('mediaItems').doc(`${type}_${id}`);

async function loadOwned(uid: string, type: MediaType, id: string) {
  const ref = validMediaId(id) ? itemRef(type, id) : null;
  const snapshot = ref ? await ref.get() : null;
  const data = snapshot?.data();
  if (!ref || !data || data.ownerUid !== uid || (type !== 'narration' && data.type !== type)) {
    throw new MediaError(404, 'not_found', `That ${type} is not available to you.`);
  }
  return { ref, data };
}

export async function loadRetentionSettings(uid: string): Promise<RetentionSettings> {
  return (await loadUserSettings(uid)).retention ?? DEFAULT_RETENTION;
}

export function retentionView(
  type: MediaType,
  data: { createdAt?: unknown } & StoredRetention,
  settings: RetentionSettings,
): RetentionView {
  const own = carriedRetention(data);
  const { expiresAt, source } = explainRetention(
    { type, createdAt: Number(data.createdAt ?? 0), ...own },
    settings,
  );
  return { ...own, effectiveExpiresAt: expiresAt, source };
}

export async function getRetention(uid: string, type: MediaType, id: string): Promise<RetentionView> {
  const { data } = await loadOwned(uid, type, id);
  return retentionView(type, data, await loadRetentionSettings(uid));
}

/** Applies a validated patch to one item and returns its new retention. */
export async function setRetention(uid: string, type: MediaType, id: string, patch: RetentionPatch): Promise<RetentionView> {
  const { ref, data } = await loadOwned(uid, type, id);
  // updatedAt is left alone: changing how long something is kept should not
  // reorder "recent" or make a finished narration look like it is streaming.
  await ref.update({ ...patch });
  if (type === 'narration') await syncNarrationCatalog(id);
  return retentionView(type, { ...data, ...patch }, await loadRetentionSettings(uid));
}

/** Changes one default (a media type's, or the global one) in the owner's settings. */
export async function saveRetentionDefault(
  uid: string,
  target: MediaType | 'global',
  ttl: string,
  retroactive: boolean,
  now = Date.now(),
): Promise<RetentionSettings> {
  let next: RetentionSettings;
  try {
    next = setDefaultTtl(await loadRetentionSettings(uid), target, ttl, now, retroactive);
  } catch (error) {
    throw new MediaError(400, 'invalid_retention', error instanceof Error ? error.message : 'Invalid retention default.');
  }
  // A field path replaces the whole map, so removing a type's default sticks.
  await adminDb().collection('users').doc(uid).update({ 'settings.retention': next });
  return next;
}

/** Lifts `ttl` / `retention` out of a create body; bad input becomes a 400. */
export function splitCreateRetention(body: Record<string, unknown>): { rest: Record<string, unknown>; patch: RetentionPatch | undefined } {
  try {
    const { rest, patch } = extractRetention(body, Date.now());
    return { rest: rest as Record<string, unknown>, patch };
  } catch (error) {
    if (error instanceof RetentionInputError) throw new MediaError(400, 'invalid_retention', error.message);
    throw error;
  }
}

/** Applies retention requested at creation. A replayed request keeps the original's. */
export async function applyCreateRetention(
  uid: string,
  type: MediaType,
  itemId: string,
  patch: RetentionPatch | undefined,
  replayed: boolean,
): Promise<void> {
  if (patch && !replayed) await setRetention(uid, type, itemId, patch);
}
