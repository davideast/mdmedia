'use client';

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
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

export async function createPlaylist(
  ownerUid: string,
  title: string,
  description = '',
  initialNarrationIds: string[] = [],
): Promise<string> {
  const cleanTitle = title.trim().slice(0, 200);
  if (!cleanTitle) {
    throw new Error('Playlist title cannot be empty.');
  }
  const now = Date.now();
  const created = await addDoc(playlistsCollection(), {
    ownerUid,
    title: cleanTitle,
    description: description.trim(),
    narrationIds: initialNarrationIds.slice(0, MAX_PLAYLIST_ITEMS),
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
}

export async function updatePlaylist(
  id: string,
  patch: {
    title?: string;
    description?: string;
    narrationIds?: string[];
  },
): Promise<void> {
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
  if (patch.narrationIds !== undefined) {
    payload.narrationIds = patch.narrationIds.slice(0, MAX_PLAYLIST_ITEMS);
  }
  await updateDoc(playlistRef(id), payload);
}

/**
 * Adds or removes `narrationId` on `playlist`. Returns `true` if added,
 * `false` if removed.
 */
export async function toggleNarrationInPlaylist(
  playlist: Playlist,
  narrationId: string,
): Promise<boolean> {
  const exists = playlist.narrationIds.includes(narrationId);
  const nextIds = exists
    ? playlist.narrationIds.filter((id) => id !== narrationId)
    : [...playlist.narrationIds, narrationId].slice(0, MAX_PLAYLIST_ITEMS);
  await updatePlaylist(playlist.id, { narrationIds: nextIds });
  return !exists;
}

export async function reorderPlaylistTracks(
  playlistId: string,
  narrationIds: string[],
): Promise<void> {
  await updatePlaylist(playlistId, { narrationIds });
}

export async function deletePlaylist(id: string): Promise<void> {
  await deleteDoc(playlistRef(id));
}
