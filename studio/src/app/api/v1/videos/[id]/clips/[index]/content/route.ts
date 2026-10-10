import { authorize } from '@/lib/api-auth';
import { loadOwnedAsset } from '@/lib/assets-server';
import { MediaError } from '@/lib/image-request';
import { videoClipContent } from '@/lib/video-assets-server';
import { loadVideoGeneration, loadVideoItem, videoClips } from '@/lib/video-server';
import { mediaApi } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const GET = (request: Request, context: { params: Promise<{ id: string; index: string }> }) => mediaApi(async () => {
  const caller = await authorize(request, 'videos:read'); if (caller instanceof Response) return caller;
  const { id, index } = await context.params; const item = await loadVideoItem(caller.uid, id);
  const url = new URL(request.url); const generationId = url.searchParams.get('generationId') ?? item.latestSuccessfulGenerationId;
  if (!generationId) throw new MediaError(404, 'not_found', 'This video has no completed clips.');
  const generation = await loadVideoGeneration(caller.uid, generationId);
  if (generation.itemId !== id || generation.status !== 'ready' || !generation.assetId) throw new MediaError(404, 'not_found', 'That version is not available.');
  const clip = (await videoClips(caller.uid, generation, '')).find(clip => String(clip.index) === index);
  if (!clip) throw new MediaError(404, 'not_found', 'That clip is not available.');
  const thumbnail = url.searchParams.get('thumbnail') === '1';
  const bytes = await videoClipContent(await loadOwnedAsset(caller.uid, generation.assetId), clip.index, clip.startSeconds, clip.endSeconds, thumbnail);
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': thumbnail ? 'image/webp' : 'video/mp4', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    ...(!thumbnail ? { 'Content-Disposition': `attachment; filename="clip-${clip.index}.mp4"` } : {}) } });
});
