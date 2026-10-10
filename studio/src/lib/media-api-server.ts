import { apiError } from './api-auth';
import { MediaError } from './image-request';
export async function mediaApi(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); }
  catch (error) {
    if (error instanceof MediaError) return apiError(error.status, error.code, error.message, error.status === 429 ? { 'Retry-After': '30' } : undefined);
    console.error('[media] Request failed:', error instanceof Error ? error.name : 'unknown');
    return apiError(500, 'media_unavailable', 'Studio could not complete that request. Try again.');
  }
}
export const mediaJson = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
