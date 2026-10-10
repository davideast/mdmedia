import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { readIdempotencyKey } from '@/lib/image-request';
import { videoGenerationResource, videoResource, loadVideoGeneration, submitVideo } from '@/lib/video-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { listMedia } from '@/lib/media-catalog-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'videos:create'); if (caller instanceof Response) return caller;
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const accepted = await submitVideo(caller.uid, body, readIdempotencyKey(request), null, caller.kind === 'apiKey' ? caller.keyId : null);
  const video = await videoResource(caller.uid, accepted.itemId, apiOrigin(request));
  return mediaJson({ id: video.id, type: 'video', generation: await videoGenerationResource(await loadVideoGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: video.links, replayed: accepted.replayed }, 202, { Location: video.links.self });
});
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'videos:read'); if (caller instanceof Response) return caller;
  const url = new URL(request.url); url.searchParams.set('type', 'video');
  return mediaJson(await listMedia(caller, url));
});
