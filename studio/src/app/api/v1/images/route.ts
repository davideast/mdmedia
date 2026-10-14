import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { parseImageRequest, readIdempotencyKey } from '@/lib/image-request';
import { generationResource, imageDefaults, imageResource, loadImageGeneration, submitImage } from '@/lib/image-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { listMedia } from '@/lib/media-catalog-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'images:create');
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const accepted = await submitImage(caller.uid, parseImageRequest(body, await imageDefaults(caller.uid)), readIdempotencyKey(request), null, caller.kind === 'apiKey' ? caller.keyId : null, body);
  const image = await imageResource(caller.uid, accepted.itemId, apiOrigin(request));
  return mediaJson({ id: image.id, type: 'image', generation: await generationResource(await loadImageGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: image.links, replayed: accepted.replayed }, 202, { Location: image.links.self });
});
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'images:read');
  if (caller instanceof Response) return caller;
  const url = new URL(request.url); url.searchParams.set('type', 'image');
  return mediaJson(await listMedia(caller, url));
});
