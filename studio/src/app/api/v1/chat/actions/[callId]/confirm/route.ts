import { apiError, authorize } from '../../../../../../../lib/api-auth';
import { apiOrigin } from '../../../../../../../lib/api-origin';
import {
  ChatConfirmError,
  confirmStagedChatAction,
} from '../../../../../../../lib/chat/chat-confirm-server';
import type {
  ConfirmStagedActionOverrides,
  StagedMediaDeliveryMode,
} from '../../../../../../../lib/chat/types';
import { validMediaId } from '../../../../../../../lib/image-request';

export const runtime = 'nodejs';

type Context = { params: Promise<{ callId: string }> };

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * POST /api/v1/chat/actions/[callId]/confirm
 *
 * Confirms and executes a staged chat action idempotently, returning
 * `{ ok: true, action, card }`.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const callId = decodeId((await context.params).callId).trim();
  if (!validMediaId(callId)) {
    return apiError(400, 'invalid_call_id', 'Invalid staged action callId.');
  }

  let overrides: ConfirmStagedActionOverrides | undefined;
  const rawBody = await request.text().catch(() => '');
  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = {
          ...(typeof parsed.deliveryMode === 'string'
            ? { deliveryMode: parsed.deliveryMode as StagedMediaDeliveryMode }
            : {}),
          ...(parsed.targetItemId === null || typeof parsed.targetItemId === 'string'
            ? { targetItemId: parsed.targetItemId }
            : {}),
          ...(parsed.fromGenerationId === null || typeof parsed.fromGenerationId === 'string'
            ? { fromGenerationId: parsed.fromGenerationId }
            : {}),
        };
      }
    } catch {
      return apiError(400, 'invalid_json', 'Send a valid JSON object.');
    }
  }

  try {
    const result = await confirmStagedChatAction({
      caller,
      callId,
      overrides,
      origin: apiOrigin(request),
      signal: request.signal,
    });
    return Response.json(
      {
        ok: true,
        action: result.action,
        card: result.card,
        replayed: result.replayed,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ChatConfirmError) {
      return apiError(error.status, error.code, error.message);
    }
    console.error('[chat/actions/:callId/confirm] unexpected error:', error);
    return apiError(500, 'internal_error', 'Could not confirm that staged action.');
  }
}
