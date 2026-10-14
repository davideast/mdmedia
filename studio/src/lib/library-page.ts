import { matchesWork } from './workspace-navigation';

export const LIBRARY_PAGE_SIZE = 50;
export const LIBRARY_SCAN_LIMIT = 500;
export type LibraryCursor = { createdAt: number; id: string };
export type LibraryRecord = { id: string; data: Record<string, unknown> };
export type LibrarySource = (after: LibraryCursor | null, limit: number) => Promise<LibraryRecord[]>;

export function readLibraryCursor(value: string | null): LibraryCursor | null {
  if (!value) return null;
  const cursor: unknown = JSON.parse(value);
  if (!cursor || typeof cursor !== 'object') throw new Error('Invalid cursor');
  const { createdAt, id } = cursor as LibraryCursor;
  if (!Number.isFinite(createdAt) || typeof id !== 'string' || !id || id.length > 1500 || id.includes('/')) throw new Error('Invalid cursor');
  return { createdAt, id };
}

/** Bound both reads and rendered results. Sparse text searches continue via the cursor.
 * No external search index is available yet; this scans owner-scoped pages on demand. */
export async function readLibraryPage(source: LibrarySource, search: string, after: LibraryCursor | null) {
  const items: LibraryRecord[] = [];
  let cursor = after;
  let scanned = 0;
  while (scanned < LIBRARY_SCAN_LIMIT) {
    const batch = await source(cursor, Math.min(100, LIBRARY_SCAN_LIMIT - scanned));
    if (!batch.length) return { items, nextCursor: null, scanned };
    for (const item of batch) {
      scanned++;
      cursor = { createdAt: Number(item.data.createdAt), id: item.id };
      if (item.data.status !== 'error' && matchesWork(`${item.data.title ?? ''} ${item.data.transcript ?? ''} ${item.id}`, search)) items.push(item);
      if (items.length === LIBRARY_PAGE_SIZE || scanned === LIBRARY_SCAN_LIMIT) return { items, nextCursor: cursor, scanned };
    }
    if (batch.length < 100) return { items, nextCursor: null, scanned };
  }
  return { items, nextCursor: cursor, scanned };
}
