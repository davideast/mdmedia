import { adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import type { Caller } from './api-auth';
import { hasScope } from './api-auth';
import type { MediaSummary, MediaType } from './media-types';
import { matchesWork } from './workspace-navigation';

export function narrationSummary(id: string, data: Record<string, unknown>): MediaSummary & { ownerUid: string } {
  return { id, type: 'narration', ownerUid: String(data.ownerUid), title: String(data.title ?? 'Narration'),
    status: data.status === 'streaming' ? 'generating' : data.status === 'error' ? 'error' : 'ready',
    createdAt: Number(data.createdAt), updatedAt: Number(data.updatedAt), href: `/narration/${id}`, thumbnailAssetId: null,
    durationMs: Number(data.durationMs ?? 0), sourcePreview: String(data.sourceMarkdown ?? data.transcript ?? '').slice(0, 4000) };
}
export async function syncNarrationCatalog(id: string) {
  const ref = adminDb().collection('mediaItems').doc(`narration_${id}`);
  const snapshot = await adminDb().collection('narrations').doc(id).get();
  if (snapshot.exists) {
    const summary = narrationSummary(id, snapshot.data()!);
    await Promise.all([ref.set(summary), adminDb().collection('mediaActivity').doc(`narration_${id}`).set({ ...summary, id: `narration_${id}`, itemId: id, phase: summary.status })]);
  } else await Promise.all([ref.delete(), adminDb().collection('mediaActivity').doc(`narration_${id}`).delete()]);
}
/** Bounded legacy migration. Clients continue until indexing=false before browsing. */
export async function backfillNarrationCatalog(uid: string): Promise<boolean> {
  const marker = adminDb().collection('mediaCatalogMigrations').doc(uid);
  const state = (await marker.get()).data();
  if (state?.complete) return true;
  let query = adminDb().collection('narrations').where('ownerUid', '==', uid).orderBy('__name__', 'asc').limit(100);
  if (state?.after) query = query.startAfter(state.after);
  const page = await query.get();
  // Read current source in sync rather than overwrite newer catalog values with an old snapshot.
  await Promise.all(page.docs.map(doc => syncNarrationCatalog(doc.id)));
  await marker.set({ after: page.docs.at(-1)?.id ?? state?.after ?? '', complete: page.docs.length < 100 });
  return page.docs.length < 100;
}
export const allowedMediaTypes = (caller: Caller): MediaType[] => [
  ...(hasScope(caller, 'narrations:read') ? ['narration' as const] : []),
  ...(hasScope(caller, 'images:read') ? ['image' as const] : []),
  ...(hasScope(caller, 'videos:read') ? ['video' as const] : []),
  ...(hasScope(caller, 'music:read') ? ['music' as const] : []),
];
export interface MediaCursor { createdAt: number; id: string }
export function parseMediaQuery(url: URL, allowed: MediaType[]) {
  const type = url.searchParams.get('type');
  if (type && !['narration', 'image', 'video', 'music'].includes(type)) throw new MediaError(400, 'invalid_type', 'Unknown media type.');
  if (type && !allowed.includes(type as MediaType)) throw new MediaError(403, 'insufficient_scope', 'This connection cannot read that media type.');
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (q.length > 200) throw new MediaError(400, 'invalid_query', 'Search is limited to 200 characters.');
  let cursor: MediaCursor | null = null;
  const raw = url.searchParams.get('cursor');
  if (raw) {
    try {
      if (raw.length > 2048) throw new Error();
      cursor = JSON.parse(raw);
      if (!cursor || !Number.isFinite(cursor.createdAt) || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(cursor.id)) throw new Error();
    } catch { throw new MediaError(400, 'invalid_cursor', 'Invalid page cursor.'); }
  }
  return { types: type ? [type as MediaType] : allowed, q, cursor };
}
/** One cross-medium index, bounded reads and stable ordering for tied timestamps. */
export async function listMedia(caller: Caller, url: URL) {
  const { types, q, cursor: after } = parseMediaQuery(url, allowedMediaTypes(caller));
  if (!types.length) throw new MediaError(403, 'insufficient_scope', 'This connection cannot read media.');
  if (types.includes('narration') && !await backfillNarrationCatalog(caller.uid)) return { items: [], nextCursor: null, indexing: true };
  const items: MediaSummary[] = [];
  let cursor = after;
  let scanned = 0;
  while (scanned < 500) {
    let query = adminDb().collection('mediaItems').where('ownerUid', '==', caller.uid)
      .where('type', 'in', types).orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(100);
    if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
    const page = await query.get();
    for (const snapshot of page.docs) {
      scanned++;
      cursor = { createdAt: Number(snapshot.data().createdAt), id: snapshot.id };
      let data = snapshot.data() as MediaSummary;
      if (data.type === 'narration') {
        const source = await adminDb().collection('narrations').doc(data.id).get();
        if (!source.exists || source.data()?.ownerUid !== caller.uid) continue;
        data = narrationSummary(data.id, source.data()!);
      }
      if (matchesWork(`${data.title} ${data.sourcePreview ?? ''} ${data.id}`, q)) {
        items.push({ id: data.id, type: data.type, title: data.title, status: data.status,
          createdAt: data.createdAt, updatedAt: data.updatedAt, href: data.href, thumbnailAssetId: data.thumbnailAssetId,
          ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }) });
      }
      if (items.length === 50 || scanned >= 500) return { items, nextCursor: cursor, indexing: false };
    }
    if (page.docs.length < 100) return { items, nextCursor: null, indexing: false };
  }
  return { items, nextCursor: cursor, indexing: false };
}

export async function listGenerations(caller: Caller, url: URL) {
  const { types, q, cursor } = parseMediaQuery(url, allowedMediaTypes(caller));
  if (!types.length) throw new MediaError(403, 'insufficient_scope', 'This connection cannot read generations.');
  const status = url.searchParams.get('status');
  if (status && !['queued', 'generating', 'ready', 'error', 'interrupted'].includes(status)) throw new MediaError(400, 'invalid_status', 'Unknown generation status.');
  if (types.includes('narration') && !await backfillNarrationCatalog(caller.uid)) return { items: [], nextCursor: null, indexing: true };
  let query = adminDb().collection('mediaActivity').where('ownerUid', '==', caller.uid).where('type', 'in', types).orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(50);
  if (status) query = query.where('status', '==', status);
  if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
  const page = await query.get(); const last = page.docs.at(-1);
  const items = (await Promise.all(page.docs.map(async doc => {
    let data = doc.data();
    if (data.type === 'narration') {
      const source = await adminDb().collection('narrations').doc(data.itemId).get();
      if (!source.exists || source.data()?.ownerUid !== caller.uid) return null;
      const summary = narrationSummary(data.itemId, source.data()!);
      data = { ...data, ...summary, id: data.id, phase: summary.status };
    }
    if (data.type === 'video' || data.type === 'music') {
      const source = (await adminDb().collection('mediaItems').doc(`${data.type}_${data.itemId}`).get()).data();
      if (!source || source.ownerUid !== caller.uid || source.type !== data.type) return null;
      data = { ...data, title: source.title };
    }
    return { id: data.id, itemId: data.itemId, type: data.type, title: data.title, status: data.status, phase: data.phase,
      createdAt: data.createdAt, updatedAt: data.updatedAt, href: data.href };
  }))).filter(item => item !== null && (!status || item.status === status) && matchesWork(`${item.title} ${item.id}`, q));
  return { items, nextCursor: page.docs.length === 50 && last ? { createdAt: last.data().createdAt, id: last.id } : null, indexing: false };
}
