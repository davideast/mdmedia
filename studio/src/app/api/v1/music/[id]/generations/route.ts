import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { adminDb } from '@/lib/firebase-admin';
import { parseMusicRequest } from '@/lib/music-request';
import { readIdempotencyKey } from '@/lib/image-request';
import { generationResource, musicResource, loadMusicItem, submitMusic, type MusicGeneration } from '@/lib/music-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const POST = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'music:create'); if (caller instanceof Response) return caller;
  const id = (await context.params).id;
  const item = await loadMusicItem(caller.uid, id);
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const accepted = await submitMusic(caller.uid, parseMusicRequest(body, item.request), readIdempotencyKey(request), id, caller.kind === 'apiKey' ? caller.keyId : null, body);
  const music = await musicResource(caller.uid, id, apiOrigin(request));
  // An old idempotency key names its original attempt even if a newer version exists.
  const generation = await adminDb().collection('mediaGenerations').doc(accepted.generationId).get();
  return mediaJson({ id, type: 'music', generation: await generationResource(generation.data() as MusicGeneration, apiOrigin(request)), links: music.links, replayed: accepted.replayed }, 202);
});
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'music:read'); if (caller instanceof Response) return caller;
  const id = (await context.params).id; await loadMusicItem(caller.uid, id);
  const url = new URL(request.url); const cursor = url.searchParams.get('cursor');
  let query = adminDb().collection('mediaGenerations').where('ownerUid', '==', caller.uid).where('itemId', '==', id).where('type', '==', 'music').orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(50);
  if (cursor) { const { parseMediaQuery } = await import('@/lib/media-catalog-server'); const after = parseMediaQuery(url, ['music']).cursor; if (after) query = query.startAfter(after.createdAt, after.id); }
  const page = await query.get(); const last = page.docs.at(-1);
  return mediaJson({ items: await Promise.all(page.docs.map(doc => generationResource(doc.data() as MusicGeneration, apiOrigin(request)))), nextCursor: page.docs.length === 50 && last ? { createdAt: last.data().createdAt, id: last.id } : null });
});
