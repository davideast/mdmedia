import { authenticate, unauthorized } from '@/lib/api-auth';
import { listMedia } from '@/lib/media-catalog-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request); if (!caller) return unauthorized();
  return mediaJson(await listMedia(caller, new URL(request.url)));
});
