import { authenticate, unauthorized } from '@/lib/api-auth';
import { listGenerations } from '@/lib/media-catalog-server';
import { startVideoWorker } from '@/lib/video-server';
import { startImageWorker } from '@/lib/image-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request); if (!caller) return unauthorized();
  startImageWorker(); startVideoWorker(); return mediaJson(await listGenerations(caller, new URL(request.url)));
});
