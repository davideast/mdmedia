import { downloadMediaStore, readDownloadCatalog } from './download-catalog';

/** Ignore superseded selections, stops, and account changes at each async boundary. */
export async function loadDownloadedTrack(uid: string, id: string, current: () => boolean) {
  const media = await downloadMediaStore(uid).getTrack(id);
  if (!current()) return null;
  if (!media) throw new Error('This download is missing from this device.');
  const catalog = await readDownloadCatalog(uid);
  if (!current()) return null;
  const track = catalog.tracks[id];
  if (!track) throw new Error('This download is not in your library.');
  return { media, track };
}
