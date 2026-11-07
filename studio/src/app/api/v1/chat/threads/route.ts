import { apiError, authorize, readJsonObject } from '../../../../../lib/api-auth';
import {
  ChatStoreError,
  getServerChatStore,
} from '../../../../../lib/chat/chat-store-server';

export const runtime = 'nodejs';

function chatErrorResponse(error: unknown): Response {
  if (error instanceof ChatStoreError) {
    return apiError(error.status, error.code, error.message);
  }
  console.error('[chat/threads] unexpected error:', error);
  return apiError(500, 'internal_error', 'Unexpected server error.');
}

/** GET /api/v1/chat/threads — lists caller threads (default 20, max 30). */
export async function GET(request: Request): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const rawLimit = new URL(request.url).searchParams.get('limit');
  const parsedLimit = rawLimit !== null ? Number(rawLimit) : 20;
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return apiError(400, 'invalid_limit', '`limit` must be a positive integer.');
  }
  const limit = Math.min(Math.floor(parsedLimit), 30);

  try {
    const threads = await getServerChatStore().listThreads(caller.uid, limit);
    return Response.json({ threads }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
}

/** POST /api/v1/chat/threads — creates an empty chat thread owned by caller. */
export async function POST(request: Request): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  let body: Record<string, unknown> = {};
  const contentLength = request.headers.get('content-length');
  if (contentLength !== '0') {
    const rawText = await request.text();
    if (rawText.trim()) {
      try {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return apiError(400, 'invalid_body', 'Send a JSON object.');
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return apiError(400, 'invalid_json', 'The request body must be JSON.');
      }
    }
  }

  if (body.id !== undefined && typeof body.id !== 'string') {
    return apiError(400, 'invalid_id', '`id` must be a string.');
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    return apiError(400, 'invalid_title', '`title` must be a string.');
  }
  if (body.lastSurface !== undefined && body.lastSurface !== null && typeof body.lastSurface !== 'string') {
    return apiError(400, 'invalid_surface', '`lastSurface` must be a string or null.');
  }

  try {
    const thread = await getServerChatStore().createThread(caller.uid, {
      ...(typeof body.id === 'string' && body.id.trim() ? { id: body.id.trim() } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(body.lastSurface !== undefined ? { lastSurface: body.lastSurface as string | null } : {}),
    });
    return Response.json({ thread }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
}

// Re-export unused helper reference prevention: readJsonObject kept consistent with other routes
void readJsonObject;
