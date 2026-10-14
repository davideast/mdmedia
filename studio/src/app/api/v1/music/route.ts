import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { parseMusicRequest } from '@/lib/music-request';
import { readIdempotencyKey } from '@/lib/image-request';
import { generationResource, musicDefaults, musicResource, loadMusicGeneration, submitMusic } from '@/lib/music-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { listMedia } from '@/lib/media-catalog-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'music:create');
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const accepted = await submitMusic(caller.uid, parseMusicRequest(body, await musicDefaults(caller.uid)), readIdempotencyKey(request), null, caller.kind === 'apiKey' ? caller.keyId : null, body);
  const music = await musicResource(caller.uid, accepted.itemId, apiOrigin(request));
  return mediaJson({ id: music.id, type: 'music', generation: await generationResource(await loadMusicGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: music.links, replayed: accepted.replayed }, 202, { Location: music.links.self });
});
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'music:read');
  if (caller instanceof Response) return caller;
  const url = new URL(request.url); url.searchParams.set('type', 'music');
  return mediaJson(await listMedia(caller, url));
});
