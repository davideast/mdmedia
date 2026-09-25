'use client';

/**
 * Client-side access to `narrations/{id}`.
 *
 * Every read goes through {@link toNarration}, so callers always receive a
 * fully-populated {@link Narration} even if a document was written by an
 * older build.
 */

import {
  arrayRemove,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase';
import { getMediaStore } from '@/lib/media-store';
import { removeOfflineNarration } from '@/lib/offline-manager';
import { multicastSubscribe } from '@/lib/subscription-pool';
import {
  DEFAULT_VOICE,
  MAX_SHARED_WITH,
  VOICES,
  type Narration,
  type NarrationStatus,
  type Visibility,
  type VoiceName,
} from '@/lib/types';

/** The newest narrations a library view will render at once. */
export const NARRATION_PAGE_SIZE = 100;

const VISIBILITIES: readonly Visibility[] = ['private', 'shared', 'public'];
const STATUSES: readonly NarrationStatus[] = ['streaming', 'ready', 'error'];

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asVoice(value: unknown): VoiceName {
  return typeof value === 'string' && (VOICES as readonly string[]).includes(value)
    ? (value as VoiceName)
    : DEFAULT_VOICE;
}

function asVisibility(value: unknown): Visibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value)
    ? (value as Visibility)
    : 'private';
}

function asStatus(value: unknown): NarrationStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as NarrationStatus)
    : 'ready';
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Shape a raw snapshot into a {@link Narration}.
 *
 * This is applied explicitly at each read site rather than through
 * `withConverter`. A converter binds to a *reference*, and reference kinds are
 * not uniformly covered across Firestore implementations — Pyric's SharedWorker
 * client, for one, provides `withConverter` on document references but not on
 * collection references, so the collection query threw. Mapping the snapshot
 * directly is ordinary Firebase, is just as type-safe, and depends on nothing
 * but `snapshot.data()`.
 */
export function toNarration(snapshot: {
  id: string;
  data: () => DocumentData | undefined;
}): Narration {
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  const narration: Narration = {
    id: snapshot.id,
    ownerUid: asString(data.ownerUid),
    title: asString(data.title, 'Untitled'),
    sourceMarkdown: asString(data.sourceMarkdown),
    transcript: asString(data.transcript),
    voice: asVoice(data.voice),
    promptStyle: asString(data.promptStyle),
    adapted: data.adapted === true,
    status: asStatus(data.status),
    durationMs: asNumber(data.durationMs),
    audioPath: asString(data.audioPath),
    timingsPath: asString(data.timingsPath),
    visibility: asVisibility(data.visibility),
    sharedWith: asStringList(data.sharedWith),
    sharedWithLabels: asStringMap(data.sharedWithLabels),
    authorName: asString(data.authorName),
    authorPhoto: asString(data.authorPhoto),
    createdAt: asNumber(data.createdAt),
    updatedAt: asNumber(data.updatedAt),
  };
  if (typeof data.errorMessage === 'string' && data.errorMessage.length > 0) {
    narration.errorMessage = data.errorMessage;
  }
  return narration;
}

function narrationsCollection() {
  return collection(db(), 'narrations');
}

function narrationRef(id: string) {
  return doc(db(), 'narrations', id);
}

/**
 * Newest narrations belonging to one person.
 *
 * The `ownerUid` equality filter is what makes this query provable against the
 * `list` rule — Rules are authorization, not filters, so the constraint has to
 * be part of the query.
 */
export function watchMyNarrations(uid: string, cb: (narrations: Narration[]) => void): Unsubscribe {
  return multicastSubscribe<Narration[]>(
    `my-narrations:${uid}`,
    (onData, onError) => {
      const q = query(
        narrationsCollection(),
        where('ownerUid', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(NARRATION_PAGE_SIZE),
      );
      return onSnapshot(
        q,
        (snapshot) => {
          onData(snapshot.docs.map(toNarration).filter((item) => item.status !== 'error'));
        },
        (error) => {
          onError?.(error);
        },
      );
    },
    cb,
  );
}

export function watchNarration(id: string, cb: (narration: Narration | null) => void): Unsubscribe {
  return multicastSubscribe<Narration | null>(
    `narration:${id}`,
    (onData, onError) => {
      return onSnapshot(
        narrationRef(id),
        (snapshot) => {
          onData(snapshot.exists() ? toNarration(snapshot) : null);
        },
        (error) => {
          onError?.(error);
        },
      );
    },
    cb,
  );
}

export async function getNarrationOnce(id: string): Promise<Narration | null> {
  const snapshot = await getDoc(narrationRef(id));
  return snapshot.exists() ? toNarration(snapshot) : null;
}

/**
 * Change who can reach a narration. `sharedWith` and `sharedWithLabels` are
 * always written alongside the visibility so they can never disagree, and both
 * are trimmed to the same bound the Rules enforce.
 */
export function updateVisibility(
  id: string,
  visibility: Visibility,
  sharedWith: string[],
  sharedWithLabels?: Record<string, string>,
): void {
  const recipients = visibility === 'shared' ? sharedWith.slice(0, MAX_SHARED_WITH) : [];
  const labels: Record<string, string> = {};
  if (visibility === 'shared' && sharedWithLabels) {
    for (const uid of recipients) {
      if (typeof sharedWithLabels[uid] === 'string') {
        labels[uid] = sharedWithLabels[uid]!;
      }
    }
  }
  void updateDoc(doc(db(), 'narrations', id), {
    visibility,
    sharedWith: recipients,
    sharedWithLabels: labels,
    updatedAt: Date.now(),
  }).catch((err) => {
    console.error(`[narrations] failed to update visibility for ${id}:`, err);
  });
}

export function updateNarrationTitle(id: string, title: string): void {
  const trimmed = title.trim().slice(0, 200);
  if (trimmed.length === 0) return;
  void updateDoc(doc(db(), 'narrations', id), {
    title: trimmed,
    updatedAt: Date.now(),
  }).catch((err) => {
    console.error(`[narrations] failed to update narration title for ${id}:`, err);
  });
  void (async () => {
    try {
      const mediaStore = getMediaStore();
      const timings = await mediaStore.getTimings(id);
      if (timings && timings.title !== trimmed) {
        await mediaStore.saveTimings(id, {
          ...timings,
          title: trimmed,
        });
      }
    } catch {
      // Non-fatal if offline media store cannot be patched
    }
  })();
}

export async function deleteNarration(id: string): Promise<void> {
  // 1. Optimistic direct client-side Firestore document deletion.
  // Firestore mutations update the local cache immediately, notifying active onSnapshot
  // listeners synchronously, and queue the write for server sync with rollback capabilities.
  // We explicitly avoid client-side transactions because transactions require
  // active server connectivity and fail when offline.
  const narrationRef = doc(db(), 'narrations', id);
  void deleteDoc(narrationRef).catch((err) => {
    console.error(`[narrations] failed to delete narration ${id}:`, err);
  });

  // 2. Clean up local OPFS offline track immediately (non-fatal if missing)
  try {
    await removeOfflineNarration(id).catch(() => {});
  } catch {
    // Non-fatal if offline media store cleanup encounters an issue
  }

  // 3. Optimistically remove the narration from user's playlists
  const currentUid = auth().currentUser?.uid;
  if (currentUid) {
    void (async () => {
      try {
        const q = query(
          collection(db(), 'playlists'),
          where('ownerUid', '==', currentUid),
          where('narrationIds', 'array-contains', id),
        );
        const snap = await getDocs(q);
        await Promise.all(
          snap.docs.map((pDoc) =>
            updateDoc(pDoc.ref, {
              narrationIds: arrayRemove(id),
              updatedAt: Date.now(),
            }),
          ),
        );
      } catch (err) {
        console.warn(`[narrations] playlist cleanup failed for ${id}:`, err);
      }
    })();
  }

  // 4. Out-of-band server purge for Cloud Storage assets & in-flight stream cancellation.
  // Dispatched in the background without blocking the caller or breaking offline support.
  void (async () => {
    try {
      const user = auth().currentUser;
      const token = user ? await user.getIdToken().catch(() => null) : null;
      if (!token) return;
      await fetch(`/api/narrations/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      console.warn(`[narrations] background storage purge for ${id} failed:`, err);
    }
  })();
}

export { generateNarrationId } from './narration-request';
