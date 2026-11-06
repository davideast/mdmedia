import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { adminDb } from '@/lib/firebase-admin';
import { readIdempotencyKey } from '@/lib/image-request';
import { analysisGenerationResource, analysisResource, loadAnalysisGeneration, loadAnalysisItem, prepareAnalysis, submitAnalysis, type AnalysisGeneration } from '@/lib/analysis-server';
import { parseMediaQuery } from '@/lib/media-catalog-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
/** Re-runs with edited settings (omitted fields keep the last request), or asks a follow-up with `previousInteractionId`. */
export const POST = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'analyses:create'); if (caller instanceof Response) return caller;
  const id = (await context.params).id;
  const item = await loadAnalysisItem(caller.uid, id);
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const key = readIdempotencyKey(request);
  const accepted = await submitAnalysis(caller.uid, await prepareAnalysis(caller, body, item), body, key, id);
  const analysis = await analysisResource(caller.uid, id, apiOrigin(request));
  // An old idempotency key names its original attempt even if a newer one exists.
  return mediaJson({ id, type: 'analysis', generation: await analysisGenerationResource(await loadAnalysisGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: analysis.links, replayed: accepted.replayed }, 202);
});
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const caller = await authorize(request, 'analyses:read'); if (caller instanceof Response) return caller;
  const id = (await context.params).id; await loadAnalysisItem(caller.uid, id);
  const { cursor } = parseMediaQuery(new URL(request.url), ['analysis']);
  let query = adminDb().collection('mediaGenerations').where('ownerUid', '==', caller.uid).where('type', '==', 'analysis').where('itemId', '==', id).orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(50);
  if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
  const page = await query.get(); const last = page.docs.at(-1);
  return mediaJson({ items: await Promise.all(page.docs.map(doc => analysisGenerationResource(doc.data() as AnalysisGeneration, apiOrigin(request)))), nextCursor: page.docs.length === 50 && last ? { createdAt: last.data().createdAt, id: last.id } : null });
});
