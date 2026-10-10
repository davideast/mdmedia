import { authenticate, hasScope, forbiddenScope, unauthorized } from '@/lib/api-auth';
import { loadOwnedAsset } from '@/lib/assets-server';
import { adminBucket } from '@/lib/firebase-admin';
import { mediaApi } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => mediaApi(async () => {
  const caller = await authenticate(request); if (!caller) return unauthorized();
  const asset = await loadOwnedAsset(caller.uid, (await context.params).id);
  const scope = asset.mediaType === 'music' ? 'music:read' : asset.mediaType === 'video' ? 'videos:read' : 'images:read';
  if (!hasScope(caller, scope)) return forbiddenScope(scope);
  const thumbnail = new URL(request.url).searchParams.get('thumbnail') === '1';
  const [bytes] = await adminBucket().file(thumbnail ? asset.thumbnailPath : asset.path).download();
  const mimeType = thumbnail ? 'image/webp' : asset.mimeType;
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff',
    ...(new URL(request.url).searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="${asset.id}.${mimeType === 'audio/mpeg' ? 'mp3' : mimeType.split('/')[1]}"` } : {}) } });
});
