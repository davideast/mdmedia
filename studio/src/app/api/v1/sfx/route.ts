import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { parseSfxRequest } from '@/lib/sfx-request';
import { readIdempotencyKey } from '@/lib/image-request';
import { generationResource, sfxDefaults, sfxResource, loadSfxGeneration, submitSfx } from '@/lib/sfx-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { listMedia } from '@/lib/media-catalog-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'sfx:create');
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const accepted = await submitSfx(caller.uid, parseSfxRequest(body, await sfxDefaults(caller.uid)), readIdempotencyKey(request), null, caller.kind === 'apiKey' ? caller.keyId : null, body);
  const sfx = await sfxResource(caller.uid, accepted.itemId, apiOrigin(request));
  return mediaJson({ id: sfx.id, type: 'sfx', generation: await generationResource(await loadSfxGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: sfx.links, replayed: accepted.replayed }, 202, { Location: sfx.links.self });
});
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'sfx:read');
  if (caller instanceof Response) return caller;
  const url = new URL(request.url); url.searchParams.set('type', 'sfx');
  return mediaJson(await listMedia(caller, url));
});
