import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { adminDb } from '@/lib/firebase-admin';
import { readIdempotencyKey } from '@/lib/image-request';
import { videoGenerationResource, videoResource, loadVideoItem, loadVideoGeneration, submitVideo, type VideoGeneration } from '@/lib/video-server';
import { parseMediaQuery } from '@/lib/media-catalog-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const POST = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'videos:create'); if (caller instanceof Response) return caller;
  const id = (await context.params).id;
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const accepted = await submitVideo(caller.uid, body, readIdempotencyKey(request), id, caller.kind === 'apiKey' ? caller.keyId : null);
  const video = await videoResource(caller.uid, id, apiOrigin(request));
  return mediaJson({ id, type: 'video', generation: await videoGenerationResource(await loadVideoGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: video.links, replayed: accepted.replayed }, 202);
});
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'videos:read'); if (caller instanceof Response) return caller;
  const id = (await context.params).id; await loadVideoItem(caller.uid, id);
  const { cursor } = parseMediaQuery(new URL(request.url), ['video']);
  let query = adminDb().collection('mediaGenerations').where('ownerUid', '==', caller.uid).where('type', '==', 'video').where('itemId', '==', id).orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(50);
  if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
  const page = await query.get(); const last = page.docs.at(-1);
  return mediaJson({ items: await Promise.all(page.docs.map(doc => videoGenerationResource(doc.data() as VideoGeneration, apiOrigin(request)))), nextCursor: page.docs.length === 50 && last ? { createdAt: last.data().createdAt, id: last.id } : null });
});
