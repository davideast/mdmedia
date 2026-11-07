import { apiError, authorize, readJsonObject } from '../../../../../../../lib/api-auth';
import { apiOrigin } from '../../../../../../../lib/api-origin';
import { createChatTurnSseStream } from '../../../../../../../lib/chat/chat-agent-server';
import {
  ChatStoreError,
  deriveThreadTitle,
  getServerChatStore,
} from '../../../../../../../lib/chat/chat-store-server';
import { validateChatEntityReferences } from '../../../../../../../lib/chat/references';
import { getSlashCommand } from '../../../../../../../lib/chat/slash-commands';
import {
  CHAT_EFFORT_LEVELS,
  CHAT_MODELS,
  isChatEffortLevel,
  isChatModelName,
  type ActiveViewContext,
  type ChatEffortLevel,
  type ChatModelName,
  type SlashCommandId,
} from '../../../../../../../lib/chat/types';
import { validMediaId } from '../../../../../../../lib/image-request';
import { loadUserSettings } from '../../../../../../../lib/user-settings-server';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const MAX_MESSAGE_CHARS = 32_000;

const VALID_SURFACES = new Set<string>([
  'analysis',
  'tree-doc',
  'narration',
  'video',
  'image',
  'music',
  'composer',
  'cut',
  'storyboard',
  'library',
  'activity',
  'playlist',
]);

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function validateViewContext(raw: unknown): ActiveViewContext | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.surface !== 'string' || !VALID_SURFACES.has(obj.surface)) return 'invalid';
  if (typeof obj.route !== 'string' || !obj.route.startsWith('/')) return 'invalid';
  return obj as unknown as ActiveViewContext;
}

function validateContextBadge(raw: unknown): { label: string; href?: string } | null | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.label !== 'string' || !obj.label.trim() || obj.label.length > 160) return 'invalid';
  if (obj.href !== undefined && (typeof obj.href !== 'string' || !obj.href.startsWith('/'))) {
    return 'invalid';
  }
  return {
    label: obj.label.trim(),
    ...(typeof obj.href === 'string' ? { href: obj.href } : {}),
  };
}

/**
 * POST /api/v1/chat/threads/[id]/messages
 *
 * Auto-creates thread `[id]` if missing (owned by `caller.uid`) and streams
 * `ChatSseEvent` frames (`text/event-stream`).
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const threadId = decodeId((await context.params).id).trim();
  if (!validMediaId(threadId)) {
    return apiError(400, 'invalid_thread_id', 'Invalid thread ID.');
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  let slashCommand: SlashCommandId | null = null;
  if (body.slashCommand !== undefined && body.slashCommand !== null) {
    if (typeof body.slashCommand !== 'string') {
      return apiError(400, 'invalid_slash_command', '`slashCommand` must be a valid command name.');
    }
    const entry = getSlashCommand(body.slashCommand);
    if (!entry || entry.pinMode === 'client-only') {
      return apiError(400, 'invalid_slash_command', `Unsupported server slash command "${body.slashCommand}".`);
    }
    slashCommand = entry.command;
  }

  const references = validateChatEntityReferences(body.references);
  if (references === 'invalid') {
    return apiError(
      400,
      'invalid_references',
      '`references` must be a list of up to 20 valid Studio entity references.',
    );
  }

  if (!text && !slashCommand && (!references || references.length === 0)) {
    return apiError(400, 'missing_text', 'Enter a message to send.');
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return apiError(
      400,
      'message_too_long',
      `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.`,
    );
  }

  const viewContext = validateViewContext(body.viewContext);
  if (viewContext === 'invalid') {
    return apiError(400, 'invalid_view_context', '`viewContext` has an invalid shape.');
  }

  const contextBadge = validateContextBadge(body.contextBadge);
  if (contextBadge === 'invalid') {
    return apiError(400, 'invalid_context_badge', '`contextBadge` must be `{ label, href? }` or null.');
  }

  if (
    body.threadTitleHint !== undefined &&
    body.threadTitleHint !== null &&
    (typeof body.threadTitleHint !== 'string' || body.threadTitleHint.length > 160)
  ) {
    return apiError(400, 'invalid_thread_title_hint', '`threadTitleHint` must be a string up to 160 characters.');
  }

  if (body.userMessageId !== undefined && (typeof body.userMessageId !== 'string' || !validMediaId(body.userMessageId))) {
    return apiError(400, 'invalid_message_id', 'Invalid `userMessageId`.');
  }
  if (
    body.assistantMessageId !== undefined &&
    (typeof body.assistantMessageId !== 'string' || !validMediaId(body.assistantMessageId))
  ) {
    return apiError(400, 'invalid_message_id', 'Invalid `assistantMessageId`.');
  }

  let requestedModel: ChatModelName | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (!isChatModelName(body.model)) {
      return apiError(
        400,
        'invalid_chat_model',
        `Chat model must be one of ${CHAT_MODELS.join(', ')}.`,
      );
    }
    requestedModel = body.model;
  }

  let requestedEffort: ChatEffortLevel | undefined;
  if (body.effort !== undefined && body.effort !== null) {
    if (!isChatEffortLevel(body.effort)) {
      return apiError(
        400,
        'invalid_chat_effort',
        `Chat effort must be one of ${CHAT_EFFORT_LEVELS.join(', ')}.`,
      );
    }
    requestedEffort = body.effort;
  }

  if (requestedModel === undefined || requestedEffort === undefined) {
    try {
      const saved = await loadUserSettings(caller.uid);
      if (requestedModel === undefined) requestedModel = saved.chatModel;
      if (requestedEffort === undefined) requestedEffort = saved.chatEffort;
    } catch {
      // Fall back to server defaults if user profile is unavailable
    }
  }

  const effectivePrompt =
    text ||
    (slashCommand ? `/${slashCommand}` : '') ||
    (references?.map((r) => `#${r.title}`).join(' ') ?? '');
  const titleHint =
    (typeof body.threadTitleHint === 'string' && body.threadTitleHint.trim()) ||
    deriveThreadTitle(effectivePrompt, 'New chat');

  // Verify or create owned thread before starting SSE stream so 404/ownership errors return JSON HTTP status
  try {
    await getServerChatStore().ensureThread(caller.uid, {
      id: threadId,
      title: titleHint,
      lastSurface: viewContext?.surface ?? null,
    });
  } catch (error) {
    if (error instanceof ChatStoreError) {
      return apiError(error.status, error.code, error.message);
    }
    throw error;
  }

  const stream = createChatTurnSseStream({
    caller,
    threadId,
    text: effectivePrompt,
    slashCommand,
    viewContext,
    ...(contextBadge !== undefined ? { contextBadge } : {}),
    ...(references ? { references } : {}),
    threadTitleHint: titleHint,
    ...(typeof body.userMessageId === 'string' ? { userMessageId: body.userMessageId } : {}),
    ...(typeof body.assistantMessageId === 'string' ? { assistantMessageId: body.assistantMessageId } : {}),
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(requestedEffort ? { effort: requestedEffort } : {}),
    origin: apiOrigin(request),
    signal: request.signal,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
