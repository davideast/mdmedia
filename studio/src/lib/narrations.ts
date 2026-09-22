'use client';

/**
 * Client-side access to `narrations/{id}`.
 *
 * Every read goes through {@link toNarration}, so callers always receive a
 * fully-populated {@link Narration} even if a document was written by an
 * older build.
 */

import {
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
    (onData) => {
      const q = query(
        narrationsCollection(),
        where('ownerUid', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(NARRATION_PAGE_SIZE),
      );
      return onSnapshot(q, (snapshot) => {
        onData(snapshot.docs.map(toNarration).filter((item) => item.status !== 'error'));
      });
    },
    cb,
  );
}

export function watchNarration(id: string, cb: (narration: Narration | null) => void): Unsubscribe {
  return multicastSubscribe<Narration | null>(
    `narration:${id}`,
    (onData) => {
      return onSnapshot(narrationRef(id), (snapshot) => {
        onData(snapshot.exists() ? toNarration(snapshot) : null);
      });
    },
    cb,
  );
}

export async function getNarrationOnce(id: string): Promise<Narration | null> {
  const snapshot = await getDoc(narrationRef(id));
  return snapshot.exists() ? toNarration(snapshot) : null;
}

/**
 * Change who can reach a narration. `sharedWith` is always written alongside
 * the visibility so the two can never disagree, and it is trimmed to the same
 * bound the Rules enforce.
 */
export async function updateVisibility(
  id: string,
  visibility: Visibility,
  sharedWith: string[],
): Promise<void> {
  const recipients = visibility === 'shared' ? sharedWith.slice(0, MAX_SHARED_WITH) : [];
  await updateDoc(doc(db(), 'narrations', id), {
    visibility,
    sharedWith: recipients,
    updatedAt: Date.now(),
  });
}

export async function updateNarrationTitle(id: string, title: string): Promise<void> {
  const trimmed = title.trim().slice(0, 200);
  if (trimmed.length === 0) return;
  await updateDoc(doc(db(), 'narrations', id), {
    title: trimmed,
    updatedAt: Date.now(),
  });
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
}

export async function deleteNarration(id: string): Promise<void> {
  await deleteDoc(doc(db(), 'narrations', id));
  try {
    await removeOfflineNarration(id).catch(() => {});
  } catch {
    // Non-fatal if offline media store cleanup encounters an issue
  }
  try {
    const currentUid = auth().currentUser?.uid;
    if (currentUid) {
      const q = query(
        collection(db(), 'playlists'),
        where('ownerUid', '==', currentUid),
        where('narrationIds', 'array-contains', id),
      );
      const snap = await getDocs(q);
      await Promise.all(
        snap.docs.map((pDoc) => {
          const nextIds = ((pDoc.data().narrationIds as string[]) ?? []).filter((item) => item !== id);
          return updateDoc(pDoc.ref, { narrationIds: nextIds, updatedAt: Date.now() });
        }),
      );
    }
  } catch {
    // Non-fatal if playlist cleanup encounters an issue
  }
}
