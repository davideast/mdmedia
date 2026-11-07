import { apiError, authorize, readJsonObject } from '../../../../../lib/api-auth';
import { createChatNarrationStream } from '../../../../../lib/chat/chat-narration-server';

export const runtime = 'nodejs';

const MAX_CHAT_NARRATE_CHARS = 32_000;

/**
 * POST /api/v1/chat/narrate
 *
 * Streams ephemeral verbatim 24 kHz 16-bit mono PCM + word-aligned chunks for a
 * single assistant chat message as `application/x-ndjson`.
 */
export async function POST(request: Request): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : '';
  if (!markdown) {
    return apiError(400, 'missing_markdown', 'Provide non-empty message markdown to narrate.');
  }
  if (markdown.length > MAX_CHAT_NARRATE_CHARS) {
    return apiError(
      400,
      'markdown_too_long',
      `Chat message narration is limited to ${MAX_CHAT_NARRATE_CHARS.toLocaleString('en-US')} characters.`,
    );
  }

  const stream = createChatNarrationStream({
    uid: caller.uid,
    markdown,
    signal: request.signal,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
