import { authorize } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { assetResource, readUploadBytes, saveImageAsset } from '@/lib/assets-server';
import { MAX_REFERENCE_BYTES, MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { MAX_VIDEO_BYTES } from '@/lib/video-request';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const media = new URL(request.url).searchParams.get('media') ?? 'image';
  if (media === 'analysis') return uploadAnalysisVideo(request);
  if (media !== 'image' && media !== 'video' && media !== 'music') throw new MediaError(400, 'invalid_type', 'Choose image, video, music, or analysis.');
  const caller = await authorize(request, media === 'music' ? 'music:create' : media === 'video' ? 'videos:create' : 'images:create'); if (caller instanceof Response) return caller;
  if (Number(request.headers.get('content-length')) > MAX_REFERENCE_BYTES) throw new MediaError(413, 'reference_too_large', 'Reference images must be at most 10 MiB.');
  // Raw image bytes avoid base64 inflation and unbounded multipart parsing.
  const reader = request.body?.getReader(); if (!reader) throw new MediaError(400, 'missing_image', 'Upload an image.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_REFERENCE_BYTES) { await reader.cancel(); throw new MediaError(413, 'reference_too_large', 'Reference images must be at most 10 MiB.'); } chunks.push(next.value); }
  const asset = await saveImageAsset(caller.uid, new Uint8Array(Buffer.concat(chunks)), 'reference', null, null, media);
  return mediaJson(assetResource(asset, apiOrigin(request)), 201);
});

/** A video for an analysis to watch: raw bytes in a supported video type, up to the Studio video limit. */
async function uploadAnalysisVideo(request: Request): Promise<Response> {
  const caller = await authorize(request, 'analyses:create'); if (caller instanceof Response) return caller;
  const { ANALYSIS_UPLOAD_TYPES, saveAnalysisReference } = await import('@/lib/analysis-server');
  const mimeType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!ANALYSIS_UPLOAD_TYPES.has(mimeType)) throw new MediaError(415, 'unsupported_video', `Send the video as raw bytes with Content-Type ${[...ANALYSIS_UPLOAD_TYPES].join(', ')}.`);
  const bytes = await readUploadBytes(request, MAX_VIDEO_BYTES,
    () => new MediaError(413, 'video_too_large', 'Videos for analysis must be at most 200 MiB. Use a YouTube link or a shorter clip.'),
    () => new MediaError(400, 'missing_video', 'Upload a video.'));
  return mediaJson(assetResource(await saveAnalysisReference(caller.uid, bytes, mimeType), apiOrigin(request)), 201);
}
