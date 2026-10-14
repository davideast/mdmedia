import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { adminDb } from '@/lib/firebase-admin';
import { MediaError } from '@/lib/image-request';
import { imageResource, loadImageItem } from '@/lib/image-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'images:read'); if (caller instanceof Response) return caller;
  return mediaJson(await imageResource(caller.uid, (await context.params).id, apiOrigin(request)));
});
export const PATCH = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'images:create'); if (caller instanceof Response) return caller;
  const id = (await context.params).id; await loadImageItem(caller.uid, id);
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  if (Object.keys(body).some(key => key !== 'title') || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw new MediaError(400, 'invalid_title', 'Send a title of 1–200 characters.');
  await adminDb().collection('mediaItems').doc(`image_${id}`).update({ title: body.title.trim(), updatedAt: Date.now() });
  return mediaJson(await imageResource(caller.uid, id, apiOrigin(request)));
});
