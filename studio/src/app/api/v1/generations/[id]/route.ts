import { authorize, authenticate, hasScope, forbiddenScope, unauthorized } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { generationResource, loadImageGeneration, startImageWorker } from '@/lib/image-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => mediaApi(async () => {
  const id = (await context.params).id;
  if (id.startsWith('narration_')) {
    const caller = await authorize(request, 'narrations:read'); if (caller instanceof Response) return caller;
    const { loadReadableNarration } = await import('@/lib/narration-server');
    const { narrationSummary } = await import('@/lib/media-catalog-server');
    const source = await loadReadableNarration(id.slice(10), caller.uid);
    if (!source || source.ownerUid !== caller.uid) return new Response(null, { status: 404 });
    const summary = narrationSummary(id.slice(10), source as unknown as Record<string, unknown>);
    const data = { ...summary }; Reflect.deleteProperty(data, 'ownerUid');
    return mediaJson({ ...data, id, itemId: summary.id, phase: summary.status, links: { self: `${apiOrigin(request)}/api/v1/generations/${id}`, web: `${apiOrigin(request)}${summary.href}` } });
  }
  const caller = await authenticate(request); if (!caller) return unauthorized();
  const { adminDb } = await import('@/lib/firebase-admin');
  const { validMediaId, MediaError } = await import('@/lib/image-request');
  const data = validMediaId(id) ? (await adminDb().collection('mediaGenerations').doc(id).get()).data() : null;
  if (!data || data.ownerUid !== caller.uid) throw new MediaError(404, 'not_found', 'That generation is not available to you.');
  if (data.type === 'video') {
    if (!hasScope(caller, 'videos:read')) return forbiddenScope('videos:read');
    const { videoGenerationResource, loadVideoGeneration, startVideoWorker } = await import('@/lib/video-server');
    startVideoWorker(); return mediaJson(await videoGenerationResource(await loadVideoGeneration(caller.uid, id), apiOrigin(request)));
  }
  if (!hasScope(caller, 'images:read')) return forbiddenScope('images:read');
  startImageWorker();
  return mediaJson(await generationResource(await loadImageGeneration(caller.uid, (await context.params).id), apiOrigin(request)));
});
