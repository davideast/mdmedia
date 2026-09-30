import { downloadMediaStore, readDownloadCatalog, updateDownloadCatalog } from './download-catalog';
import { downloadNarration } from './offline-manager';
import type { Narration, Playlist } from './types';

/** Save the new playlist snapshot only after every track is safely on the device. */
export async function savePlaylistDownload(
  uid: string,
  playlist: Playlist,
  narrations: Map<string, Narration>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const ids = [...playlist.narrationIds];
  if (ids.length === 0) throw new Error('Add a narration before downloading this playlist.');
  const tracks = ids.map((id) => narrations.get(id));
  if (tracks.some((track) => !track || track.status !== 'ready')) {
    throw new Error('Every narration must be ready before this playlist can be downloaded.');
  }
  const previous = (await readDownloadCatalog(uid)).playlists.find((item) => item.id === playlist.id);
  await updateDownloadCatalog(uid, (current) => ({
    ...current,
    pendingPlaylists: [
      ...current.pendingPlaylists.filter((item) => item.id !== playlist.id),
      {
        id: playlist.id,
        title: playlist.title,
        description: playlist.description,
        narrationIds: ids,
        sourceUpdatedAt: playlist.updatedAt,
        savedAt: Date.now(),
      },
    ],
  }));
  onProgress?.(0, ids.length);
  for (let index = 0; index < ids.length; index++) {
    const narration = tracks[index]!;
    // A failed update never replaces the completed playlist snapshot. Newly
    // saved tracks stay in the account store, so retry need only fetch missing ones.
    if (!(await downloadMediaStore(uid).has(narration.id))) {
      await downloadNarration(narration.id, {
        title: narration.title,
        sourceMarkdown: narration.sourceMarkdown,
        adapted: narration.adapted,
        voice: narration.voice,
      }, uid, false);
    }
    onProgress?.(index + 1, ids.length);
  }
  const next = await updateDownloadCatalog(uid, (current) => ({
    ...current,
    tracks: Object.fromEntries([
      ...Object.entries(current.tracks),
      ...tracks.map((narration) => [narration!.id, {
        id: narration!.id,
        title: narration!.title,
        durationMs: narration!.durationMs,
        voice: narration!.voice,
        savedAt: current.tracks[narration!.id]?.savedAt ?? Date.now(),
      }] as const),
    ]),
    pendingPlaylists: current.pendingPlaylists.filter((item) => item.id !== playlist.id),
    playlists: [
      ...current.playlists.filter((item) => item.id !== playlist.id),
      {
        id: playlist.id,
        title: playlist.title,
        description: playlist.description,
        narrationIds: ids,
        sourceUpdatedAt: playlist.updatedAt,
        savedAt: Date.now(),
      },
    ],
  }));
  for (const id of previous?.narrationIds ?? []) {
    if (next.individualIds.includes(id) || next.playlists.some((item) => item.narrationIds.includes(id)) || next.pendingPlaylists.some((item) => item.narrationIds.includes(id))) continue;
    await downloadMediaStore(uid).delete(id);
    await updateDownloadCatalog(uid, (current) => {
      const updatedTracks = { ...current.tracks };
      delete updatedTracks[id];
      return { ...current, tracks: updatedTracks };
    });
  }
}
