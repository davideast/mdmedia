import { authorize } from '@/lib/api-auth';
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
  const caller = await authorize(request, 'images:read'); if (caller instanceof Response) return caller;
  startImageWorker();
  return mediaJson(await generationResource(await loadImageGeneration(caller.uid, (await context.params).id), apiOrigin(request)));
});
