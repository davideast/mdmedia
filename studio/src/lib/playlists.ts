'use client';

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore';

import { db } from './firebase';
import { multicastSubscribe } from './subscription-pool';
import { MAX_PLAYLIST_ITEMS, type Playlist } from './types';

const PLAYLIST_PAGE_SIZE = 100;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function toPlaylist(snapshot: {
  id: string;
  data: () => DocumentData | undefined;
}): Playlist {
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  return {
    id: snapshot.id,
    ownerUid: asString(data.ownerUid),
    title: asString(data.title, 'Untitled playlist'),
    description: asString(data.description),
    narrationIds: asStringList(data.narrationIds).slice(0, MAX_PLAYLIST_ITEMS),
    createdAt: asNumber(data.createdAt),
    updatedAt: asNumber(data.updatedAt),
  };
}

function playlistsCollection() {
  return collection(db(), 'playlists');
}

function playlistRef(id: string) {
  return doc(db(), 'playlists', id);
}

/** Watch all playlists owned by `uid`, most recently updated first. */
export function watchMyPlaylists(
  uid: string,
  cb: (playlists: Playlist[]) => void,
): Unsubscribe {
  return multicastSubscribe<Playlist[]>(
    `my-playlists:${uid}`,
    (onData) => {
      const q = query(
        playlistsCollection(),
        where('ownerUid', '==', uid),
        orderBy('updatedAt', 'desc'),
        limit(PLAYLIST_PAGE_SIZE),
      );
      return onSnapshot(q, (snapshot) => {
        onData(snapshot.docs.map(toPlaylist));
      });
    },
    cb,
  );
}

export function createPlaylist(
  ownerUid: string,
  title: string,
  description = '',
  initialNarrationIds: string[] = [],
): string {
  const cleanTitle = title.trim().slice(0, 200);
  if (!cleanTitle) {
    throw new Error('Playlist title cannot be empty.');
  }
  const now = Date.now();
  const newRef = doc(playlistsCollection());
  void setDoc(newRef, {
    ownerUid,
    title: cleanTitle,
    description: description.trim(),
    narrationIds: initialNarrationIds.slice(0, MAX_PLAYLIST_ITEMS),
    createdAt: now,
    updatedAt: now,
  }).catch((err) => {
    console.error(`[playlists] failed to create playlist ${newRef.id}:`, err);
  });
  return newRef.id;
}

export function updatePlaylist(
  id: string,
  patch: {
    title?: string;
    description?: string;
  },
): void {
  const payload: Record<string, unknown> = {
    updatedAt: Date.now(),
  };
  if (patch.title !== undefined) {
    const cleanTitle = patch.title.trim().slice(0, 200);
    if (!cleanTitle) throw new Error('Playlist title cannot be empty.');
    payload.title = cleanTitle;
  }
  if (patch.description !== undefined) {
    payload.description = patch.description.trim();
  }
  void updateDoc(playlistRef(id), payload).catch((err) => {
    console.error(`[playlists] failed to update playlist ${id}:`, err);
  });
}

/**
 * Adds or removes `narrationId` on `playlist`. Returns `true` if added,
 * `false` if removed. The write is an atomic array change, so it never
 * overwrites an edit an agent made to the same playlist in the meantime.
 */
export function toggleNarrationInPlaylist(
  playlist: Playlist,
  narrationId: string,
): boolean {
  const exists = playlist.narrationIds.includes(narrationId);
  if (!exists && playlist.narrationIds.length >= MAX_PLAYLIST_ITEMS) {
    throw new Error(`A playlist holds at most ${MAX_PLAYLIST_ITEMS} items.`);
  }
  void updateDoc(playlistRef(playlist.id), {
    narrationIds: exists ? arrayRemove(narrationId) : arrayUnion(narrationId),
    updatedAt: Date.now(),
  }).catch((err) => {
    console.error(`[playlists] failed to update playlist ${playlist.id}:`, err);
  });
  return !exists;
}

/**
 * Moves one track to `toIndex`, applied to the playlist as it is when the
 * write lands, so tracks added or removed elsewhere are kept.
 */
export async function moveTrackInPlaylist(
  playlistId: string,
  narrationId: string,
  toIndex: number,
): Promise<void> {
  await runTransaction(db(), async (tx) => {
    const ref = playlistRef(playlistId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) return;
    const current = toPlaylist({ id: snapshot.id, data: () => snapshot.data() }).narrationIds;
    if (!current.includes(narrationId)) return;
    const next = current.filter((id) => id !== narrationId);
    next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, narrationId);
    tx.update(ref, { narrationIds: next, updatedAt: Date.now() });
  });
}

export function deletePlaylist(id: string): void {
  void deleteDoc(playlistRef(id)).catch((err) => {
    console.error(`[playlists] failed to delete playlist ${id}:`, err);
  });
}

