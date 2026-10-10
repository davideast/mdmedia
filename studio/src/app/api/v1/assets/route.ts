import { authorize } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { assetResource, saveImageAsset } from '@/lib/assets-server';
import { MAX_REFERENCE_BYTES, MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'images:create'); if (caller instanceof Response) return caller;
  if (Number(request.headers.get('content-length')) > MAX_REFERENCE_BYTES) throw new MediaError(413, 'reference_too_large', 'Reference images must be at most 10 MiB.');
  // Raw image bytes avoid base64 inflation and unbounded multipart parsing.
  const reader = request.body?.getReader(); if (!reader) throw new MediaError(400, 'missing_image', 'Upload an image.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_REFERENCE_BYTES) { await reader.cancel(); throw new MediaError(413, 'reference_too_large', 'Reference images must be at most 10 MiB.'); } chunks.push(next.value); }
  const asset = await saveImageAsset(caller.uid, new Uint8Array(Buffer.concat(chunks)), 'reference');
  return mediaJson(assetResource(asset, apiOrigin(request)), 201);
});
