import { MediaStoreService, OpfsStorageAdapter } from './media-store';
import type { NarrationTimingsFile } from './wav';

export interface DownloadedTrack {
  id: string;
  title: string;
  durationMs: number;
  voice: string;
  savedAt: number;
}

export interface DownloadedPlaylist {
  id: string;
  title: string;
  description: string;
  narrationIds: string[];
  sourceUpdatedAt: number;
  savedAt: number;
}

export interface DownloadCatalog {
  version: 2;
  tracks: Record<string, DownloadedTrack>;
  individualIds: string[];
  playlists: DownloadedPlaylist[];
  pendingPlaylists: DownloadedPlaylist[];
}

const empty = (): DownloadCatalog => ({ version: 2, tracks: {}, individualIds: [], playlists: [], pendingPlaylists: [] });
const listeners = new Set<() => void>();

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed() {
  for (const listener of listeners) listener();
}

function safeUid(uid: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(uid)) throw new Error('Invalid account identifier');
  return uid;
}

async function directory(uid: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle('mdmedia-audio', { create: true });
  const users = await app.getDirectoryHandle('users', { create: true });
  return users.getDirectoryHandle(safeUid(uid), { create: true });
}

export function downloadMediaStore(uid: string): MediaStoreService {
  return new MediaStoreService(new OpfsStorageAdapter(), true, `users/${safeUid(uid)}/`);
}

export async function readDownloadCatalog(uid: string): Promise<DownloadCatalog> {
  try {
    const handle = await (await directory(uid)).getFileHandle('catalog.json');
    const value = JSON.parse(await (await handle.getFile()).text()) as DownloadCatalog;
    if (value.version !== 2 || !value.tracks || !Array.isArray(value.playlists) || !Array.isArray(value.individualIds)) return empty();
    return { ...value, pendingPlaylists: Array.isArray(value.pendingPlaylists) ? value.pendingPlaylists : [] };
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return empty();
    throw error;
  }
}

const queues = new Map<string, Promise<unknown>>();

export async function updateDownloadCatalog(uid: string, edit: (current: DownloadCatalog) => DownloadCatalog | Promise<DownloadCatalog>): Promise<DownloadCatalog> {
  const previous = queues.get(uid) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const next = await edit(await readDownloadCatalog(uid));
    const handle = await (await directory(uid)).getFileHandle('catalog.json', { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(JSON.stringify(next)); } finally { await writable.close(); }
    changed();
    return next;
  });
  queues.set(uid, operation);
  try { return await operation; } finally { if (queues.get(uid) === operation) queues.delete(uid); }
}

export function trackFromTimings(id: string, timings: NarrationTimingsFile, voice = ''): DownloadedTrack {
  return {
    id,
    title: timings.title || 'Untitled narration',
    durationMs: timings.durationMs || 0,
    voice,
    savedAt: Date.now(),
  };
}

/** A partial playlist owns saved audio while its download can still be resumed. */
export function isDownloadReferenced(catalog: DownloadCatalog, id: string): boolean {
  return catalog.individualIds.includes(id) ||
    [...catalog.playlists, ...catalog.pendingPlaylists].some((playlist) => playlist.narrationIds.includes(id));
}

/** Ownership decisions, file deletion, and catalog writes share the account queue. */
export async function removeUnreferencedDownloads(uid: string, ids: Iterable<string>): Promise<void> {
  await updateDownloadCatalog(uid, async (current) => {
    const tracks = { ...current.tracks };
    for (const id of ids) {
      if (isDownloadReferenced(current, id)) continue;
      await downloadMediaStore(uid).delete(id);
      delete tracks[id];
    }
    return { ...current, tracks };
  });
}

export async function removeIndividualDownload(uid: string, id: string): Promise<void> {
  await updateDownloadCatalog(uid, (current) => ({
    ...current,
    individualIds: current.individualIds.filter((item) => item !== id),
  }));
  await removeUnreferencedDownloads(uid, [id]);
}

export async function removeDownloadedPlaylist(uid: string, id: string): Promise<void> {
  const removedIds = new Set<string>();
  await updateDownloadCatalog(uid, (current) => {
    const removed = current.playlists.find((item) => item.id === id);
    if (!removed) return current;
    for (const trackId of [...removed.narrationIds, ...(current.pendingPlaylists.find((item) => item.id === id)?.narrationIds ?? [])]) removedIds.add(trackId);
    return { ...current,
      playlists: current.playlists.filter((item) => item.id !== id),
      pendingPlaylists: current.pendingPlaylists.filter((item) => item.id !== id),
    };
  });
  await removeUnreferencedDownloads(uid, removedIds);
}

export async function removePendingPlaylist(uid: string, id: string): Promise<void> {
  const removedIds = new Set<string>();
  await updateDownloadCatalog(uid, (current) => {
    for (const trackId of current.pendingPlaylists.find((item) => item.id === id)?.narrationIds ?? []) removedIds.add(trackId);
    return { ...current, pendingPlaylists: current.pendingPlaylists.filter((item) => item.id !== id) };
  });
  await removeUnreferencedDownloads(uid, removedIds);
}

export async function listLegacyDownloads(): Promise<Array<{ id: string; timings: NarrationTimingsFile }>> {
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('mdmedia-audio');
    const narrations = await app.getDirectoryHandle('narrations');
    const result: Array<{ id: string; timings: NarrationTimingsFile }> = [];
    for await (const [name] of narrations as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (!name.endsWith('.timings.json')) continue;
      const id = name.slice(0, -'.timings.json'.length);
      if (!(await new MediaStoreService(new OpfsStorageAdapter()).has(id))) continue;
      const file = await narrations.getFileHandle(name);
      result.push({ id, timings: JSON.parse(await (await file.getFile()).text()) as NarrationTimingsFile });
    }
    return result;
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return [];
    throw error;
  }
}

export async function importLegacyDownloads(uid: string, tracks: Array<{ id: string; timings: NarrationTimingsFile }>): Promise<void> {
  const legacy = new MediaStoreService(new OpfsStorageAdapter());
  const destination = downloadMediaStore(uid);
  for (const track of tracks) {
    const saved = await legacy.getTrack(track.id);
    if (!saved) continue;
    await updateDownloadCatalog(uid, async (current) => {
      await destination.saveTrack(track.id, saved.audioBlob, saved.timings);
      return ({
      ...current,
      tracks: { ...current.tracks, [track.id]: trackFromTimings(track.id, saved.timings) },
      individualIds: current.individualIds.includes(track.id) ? current.individualIds : [...current.individualIds, track.id],
      });
    });
    await legacy.delete(track.id);
  }
}
