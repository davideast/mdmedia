import { apiError, authorize, readJsonObject } from '../../../../../../lib/api-auth';
import {
  ChatStoreError,
  getServerChatStore,
} from '../../../../../../lib/chat/chat-store-server';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function chatErrorResponse(error: unknown): Response {
  if (error instanceof ChatStoreError) {
    return apiError(error.status, error.code, error.message);
  }
  console.error('[chat/threads/:id] unexpected error:', error);
  return apiError(500, 'internal_error', 'Unexpected server error.');
}

/** GET /api/v1/chat/threads/[id] — returns `{ thread, messages }`. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const threadId = decodeId((await context.params).id);
  try {
    const store = getServerChatStore();
    const thread = await store.getThread(caller.uid, threadId);
    if (!thread) {
      return apiError(404, 'not_found', 'That chat thread is not available to you.');
    }
    const messages = await store.listMessages(caller.uid, thread.id);
    return Response.json({ thread, messages }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
}

/** PATCH /api/v1/chat/threads/[id] — renames thread `title`. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
    return apiError(400, 'invalid_title', 'Send a non-empty `title` of 1–120 characters.');
  }

  const threadId = decodeId((await context.params).id);
  try {
    const thread = await getServerChatStore().updateThread(caller.uid, threadId, {
      title: body.title.trim(),
    });
    return Response.json({ thread }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
}

/** DELETE /api/v1/chat/threads/[id] — deletes thread, messages, and staged actions. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const threadId = decodeId((await context.params).id);
  try {
    await getServerChatStore().deleteThread(caller.uid, threadId);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
}
