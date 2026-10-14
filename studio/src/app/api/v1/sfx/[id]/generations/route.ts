import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { adminDb } from '@/lib/firebase-admin';
import { parseSfxRequest } from '@/lib/sfx-request';
import { readIdempotencyKey } from '@/lib/image-request';
import { generationResource, sfxResource, loadSfxItem, submitSfx, type SfxGeneration } from '@/lib/sfx-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const POST = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'sfx:create'); if (caller instanceof Response) return caller;
  const id = (await context.params).id;
  const item = await loadSfxItem(caller.uid, id);
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const accepted = await submitSfx(caller.uid, parseSfxRequest(body, item.request), readIdempotencyKey(request), id, caller.kind === 'apiKey' ? caller.keyId : null, body);
  const sfx = await sfxResource(caller.uid, id, apiOrigin(request));
  // An old idempotency key names its original attempt even if a newer version exists.
  const generation = await adminDb().collection('mediaGenerations').doc(accepted.generationId).get();
  return mediaJson({ id, type: 'sfx', generation: await generationResource(generation.data() as SfxGeneration, apiOrigin(request)), links: sfx.links, replayed: accepted.replayed }, 202);
});
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'sfx:read'); if (caller instanceof Response) return caller;
  const id = (await context.params).id; await loadSfxItem(caller.uid, id);
  const url = new URL(request.url); const cursor = url.searchParams.get('cursor');
  let query = adminDb().collection('mediaGenerations').where('ownerUid', '==', caller.uid).where('itemId', '==', id).where('type', '==', 'sfx').orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(50);
  if (cursor) { const { parseMediaQuery } = await import('@/lib/media-catalog-server'); const after = parseMediaQuery(url, ['sfx']).cursor; if (after) query = query.startAfter(after.createdAt, after.id); }
  const page = await query.get(); const last = page.docs.at(-1);
  return mediaJson({ items: await Promise.all(page.docs.map(doc => generationResource(doc.data() as SfxGeneration, apiOrigin(request)))), nextCursor: page.docs.length === 50 && last ? { createdAt: last.data().createdAt, id: last.id } : null });
});
