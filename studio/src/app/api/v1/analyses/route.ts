import { authorize, readJsonObject } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { readIdempotencyKey } from '@/lib/image-request';
import { analysisGenerationResource, analysisResource, loadAnalysisGeneration, prepareAnalysis, submitAnalysis } from '@/lib/analysis-server';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { listMedia } from '@/lib/media-catalog-server';
import { applyCreateRetention, splitCreateRetention } from '@/lib/retention-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'analyses:create'); if (caller instanceof Response) return caller;
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const { rest, patch } = splitCreateRetention(body);
  const key = readIdempotencyKey(request);
  const accepted = await submitAnalysis(caller.uid, await prepareAnalysis(caller, rest, null), rest, key, null);
  await applyCreateRetention(caller.uid, 'analysis', accepted.itemId, patch, accepted.replayed);
  const analysis = await analysisResource(caller.uid, accepted.itemId, apiOrigin(request));
  return mediaJson({ id: analysis.id, type: 'analysis', generation: await analysisGenerationResource(await loadAnalysisGeneration(caller.uid, accepted.generationId), apiOrigin(request)), links: analysis.links, replayed: accepted.replayed }, 202, { Location: analysis.links.self });
});
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'analyses:read'); if (caller instanceof Response) return caller;
  const url = new URL(request.url); url.searchParams.set('type', 'analysis');
  return mediaJson(await listMedia(caller, url));
});
