/**
 * Multi-step Gemini Interactions streaming agent loop for Studio Contextual Chat.
 *
 * Implements:
 * - SSE framing (`formatSseEvent`, `parseSseFrames`)
 * - Progressive thought summary extraction (`extractThoughtHeadline`)
 * - Compact Tier-1 `[Active Studio View]` context injection
 * - Step-0 `/slash` command `tool_choice` pinning (`single` & `context-then-tool`), reverting to `auto` on Steps 1..4
 * - Automatic Step-0 fallback to compact transcript replay when `previous_interaction_id` expires (400/404)
 * - Staged action persistence (`chatStagedActions/{callId}`) and `StoredChatMessage` persistence
 * - Clean `AbortSignal` cancellation
 */

import { randomUUID } from 'node:crypto';
import type { Interactions } from '@google/genai';
import { createGeminiClient } from 'mdmedia/tts';
import type { Caller } from '../api-auth';
import { validMediaId } from '../image-request';
import {
  deriveThreadTitle,
  getServerChatStore,
  type ChatStorePort,
} from './chat-store-server';
import { recommendedToolForReferenceKind } from './references';
import { extractLeadingSlashCommand, getSlashCommand } from './slash-commands';
import {
  executeChatToolCall,
  getAllowedToolsForCaller,
  getChatTool,
  toGeminiFunctionDeclarations,
} from './tools';
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  formatActiveViewPillLabel,
  formatClockSeconds,
  isChatEffortLevel,
  isChatModelName,
  orderChatResultParts,
  type ActiveViewContext,
  type ChatEffortLevel,
  type ChatEntityReference,
  type ChatModelName,
  type ChatResultPart,
  type ChatSseEvent,
  type ChatThreadSummary,
  type SlashCommandId,
  type StoredChatMessage,
} from './types';

export { DEFAULT_CHAT_EFFORT, DEFAULT_CHAT_MODEL };
export const MAX_TOOL_STEPS = 5;
const MAX_HEADLINE_CHARS = 96;

export interface ChatInteractionsClient {
  create(
    params: Interactions.CreateModelInteractionParamsStreaming,
    options?: { maxRetries?: number; fetchOptions?: { signal?: AbortSignal } },
  ): Promise<AsyncIterable<Interactions.InteractionSSEEvent>>;
}

function defaultInteractionsClient(): ChatInteractionsClient {
  const client = createGeminiClient();
  return {
    create(params, options) {
      return client.interactions.create({ ...params, stream: true }, options);
    },
  };
}

export function configuredChatModel(): string {
  return process.env.STUDIO_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

export function formatSseEvent(event: ChatSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseSseFrames(raw: string): ChatSseEvent[] {
  const events: ChatSseEvent[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as ChatSseEvent;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed or comment frames
    }
  }
  return events;
}

/**
 * Extracts a concise `**Bold Headline**` or clean first line (<= 96 chars)
 * from a Gemini thought summary chunk, matching `progressLine` in video analysis.
 */
export function extractThoughtHeadline(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const boldMatch = /^\*\*([^*]+)\*\*/.exec(trimmed);
  const candidate = (boldMatch ? boldMatch[1]! : trimmed.split('\n')[0] ?? '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate) return null;
  return candidate.length > MAX_HEADLINE_CHARS
    ? `${candidate.slice(0, MAX_HEADLINE_CHARS - 1).trimEnd()}…`
    : candidate;
}

export function buildActiveViewPromptBlock(viewContext: ActiveViewContext | null): string | null {
  if (!viewContext) return null;
  const lines: string[] = ['[Active Studio View]'];
  lines.push(`surface: ${viewContext.surface}`);
  lines.push(`route: ${viewContext.route}`);

  switch (viewContext.surface) {
    case 'analysis': {
      lines.push(`itemId: ${viewContext.itemId}`);
      lines.push(`title: ${viewContext.title}`);
      if (viewContext.status) lines.push(`status: ${viewContext.status}`);
      if (viewContext.sourceVideoId) lines.push(`sourceVideoId: ${viewContext.sourceVideoId}`);
      if (viewContext.sourceYoutubeUrl) lines.push(`sourceYoutubeUrl: ${viewContext.sourceYoutubeUrl}`);
      const clock = formatClockSeconds(viewContext.playheadSeconds);
      if (clock) lines.push(`playhead: ${clock} (${viewContext.playheadSeconds}s)`);
      break;
    }
    case 'tree-doc': {
      lines.push(`treeId: ${viewContext.treeId}`);
      if (viewContext.treeTitle) lines.push(`treeTitle: ${viewContext.treeTitle}`);
      lines.push(`docPath: ${viewContext.docPath}`);
      if (viewContext.docTitle) lines.push(`docTitle: ${viewContext.docTitle}`);
      if (viewContext.activeHeading) lines.push(`activeHeading: ${viewContext.activeHeading}`);
      if (viewContext.selectionExcerpt) {
        lines.push(`selectedText: ${JSON.stringify(viewContext.selectionExcerpt.slice(0, 600))}`);
      }
      break;
    }
    case 'narration': {
      lines.push(`itemId: ${viewContext.itemId}`);
      lines.push(`title: ${viewContext.title}`);
      if (viewContext.voiceName) lines.push(`voice: ${viewContext.voiceName}`);
      const clock = formatClockSeconds(viewContext.playheadSeconds);
      if (clock) lines.push(`playhead: ${clock} (${viewContext.playheadSeconds}s)`);
      break;
    }
    case 'video':
    case 'image':
    case 'music': {
      lines.push(`itemId: ${viewContext.itemId}`);
      lines.push(`title: ${viewContext.title}`);
      if (viewContext.status) lines.push(`status: ${viewContext.status}`);
      if (viewContext.generationId) lines.push(`generationId: ${viewContext.generationId}`);
      const clock = formatClockSeconds(viewContext.playheadSeconds);
      if (clock) lines.push(`playhead: ${clock} (${viewContext.playheadSeconds}s)`);
      break;
    }
    case 'composer': {
      lines.push(`draftKind: ${viewContext.draftKind}`);
      if (viewContext.draftTitle) lines.push(`draftTitle: ${viewContext.draftTitle}`);
      if (viewContext.promptExcerpt) {
        lines.push(`promptExcerpt: ${JSON.stringify(viewContext.promptExcerpt.slice(0, 400))}`);
      }
      if (viewContext.selectedSourceId) lines.push(`selectedSourceId: ${viewContext.selectedSourceId}`);
      break;
    }
    case 'cut': {
      lines.push(`productionId: ${viewContext.productionId}`);
      lines.push(`cutId: ${viewContext.cutId}`);
      lines.push(`title: ${viewContext.title}`);
      if (viewContext.activeSceneId) lines.push(`activeSceneId: ${viewContext.activeSceneId}`);
      const clock = formatClockSeconds(viewContext.playheadSeconds);
      if (clock) lines.push(`playhead: ${clock} (${viewContext.playheadSeconds}s)`);
      break;
    }
    case 'storyboard': {
      lines.push(`storyboardId: ${viewContext.storyboardId}`);
      lines.push(`title: ${viewContext.title}`);
      if (typeof viewContext.selectedShotIndex === 'number') {
        lines.push(`selectedShotIndex: ${viewContext.selectedShotIndex}`);
      }
      break;
    }
    case 'library':
    case 'activity':
    case 'playlist': {
      if (viewContext.title) lines.push(`title: ${viewContext.title}`);
      if (viewContext.activeFilter) lines.push(`activeFilter: ${viewContext.activeFilter}`);
      if (viewContext.playlistId) lines.push(`playlistId: ${viewContext.playlistId}`);
      break;
    }
  }

  return lines.join('\n');
}

export function buildReferencedItemsPromptBlock(
  references: readonly ChatEntityReference[] | undefined,
): string | null {
  if (!references || references.length === 0) return null;
  const lines: string[] = ['[Referenced Studio Items]'];
  for (const ref of references) {
    const tool = recommendedToolForReferenceKind(ref.kind);
    const parts = [
      `- kind=${ref.kind}`,
      `title=${JSON.stringify(ref.title)}`,
      `uri=${ref.uri}`,
      `id=${JSON.stringify(ref.id)}`,
      ...(ref.subId ? [`subId=${JSON.stringify(ref.subId)}`] : []),
      ...(ref.characterKind ? [`characterKind=${ref.characterKind}`] : []),
      ...(ref.metaLabel ? [`meta=${JSON.stringify(ref.metaLabel)}`] : []),
      `href=${ref.href}`,
      ...(ref.isLocalDraft ? ['localDraft=true'] : [`inspectWith=${tool}`]),
    ];
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

export function buildRecentThreadMediaPromptBlock(
  messages: readonly StoredChatMessage[],
): string | null {
  if (messages.length === 0) return null;
  const byKey = new Map<
    string,
    { mediaType: string; itemId: string; generationId: string | null; title: string }
  >();

  for (const msg of messages) {
    if (!msg.resultParts) continue;
    for (const part of msg.resultParts) {
      if (
        part.kind === 'action-card' &&
        part.mediaType &&
        part.itemId &&
        part.state !== 'staged' &&
        part.state !== 'canceled' &&
        part.state !== 'failed'
      ) {
        const key = `${part.mediaType}:${part.itemId}`;
        byKey.delete(key);
        byKey.set(key, {
          mediaType: part.mediaType,
          itemId: part.itemId,
          generationId: part.generationId ?? null,
          title: part.title,
        });
      } else if (part.kind === 'media-embed' && part.itemId) {
        const key = `${part.mediaType}:${part.itemId}`;
        const prev = byKey.get(key);
        byKey.delete(key);
        byKey.set(key, {
          mediaType: part.mediaType,
          itemId: part.itemId,
          generationId: part.generationId ?? prev?.generationId ?? null,
          title: part.title || prev?.title || part.itemId,
        });
      }
    }
  }

  if (byKey.size === 0) return null;
  const entries = [...byKey.values()].slice(-8);
  const lines: string[] = ['[Recent Thread Media Items]'];
  entries.forEach((entry, index) => {
    const isLatest = index === entries.length - 1;
    const fields = [
      `- ${entry.mediaType}`,
      `title=${JSON.stringify(entry.title)}`,
      `itemId=${JSON.stringify(entry.itemId)}`,
      ...(entry.generationId ? [`generationId=${JSON.stringify(entry.generationId)}`] : []),
      `uri=mdmedia://${entry.mediaType}/${entry.itemId}`,
      ...(isLatest ? ['(latest)'] : []),
    ];
    lines.push(fields.join(' '));
  });
  return lines.join('\n');
}

function buildSystemInstruction(slashCommand: SlashCommandId | null): string {
  const base = [
    'You are the contextual Studio assistant inside mdmedia Studio.',
    'Keep responses concise, calm, editorial, and grounded in actual Studio items.',
    'When [Active Studio View], [Referenced Studio Items], or [Recent Thread Media Items] is present, call Context Tools (`read_media_item`, `read_tree_document`, `read_tree`, `read_production`, `read_production_cut`, `read_storyboard`, `read_character`, `read_playlist`, `search_library`, `list_activity`) whenever you need full transcripts, analysis answers, document Markdown, storyboard beats, character sheets, cut timelines, or playlist items.',
    'When citing Studio items in your prose, format them as Markdown links with their canonical `mdmedia://` URI (for example `[The overnight process](mdmedia://narration/nar_123)`, `[Storage Doc](mdmedia://tree-doc/tree_1/arch/storage.md)`, `[Episode 1](mdmedia://production/prod_1)`, `[Opening Board](mdmedia://storyboard/sb_1)`, or `[Rick](mdmedia://character/rick@1)`) so the UI renders interactive type-differentiated entity chips.',
    'When the user asks to modify, adjust, refine, or create a new version of an existing image, video, music track, or analysis (from [Active Studio View], [Referenced Studio Items], or [Recent Thread Media Items]), pass `targetItemId` to `generate_image`, `generate_video`, `generate_music`, or `analyze_video` instead of creating a separate standalone item. For `generate_image`, use `action: "refine"` (with `fromGenerationId` when available) to edit details while preserving composition and style, `action: "regenerate"` for a fresh version on the same item, and omit `targetItemId` (`action: "initial"`) only when the user wants a separate new image.',
    'Paid media generations (`analyze_video`, `create_narration`, `generate_image`, `generate_video`, `generate_music`) and document writes (`insert_media_into_document`, `upsert_tree_document`) stage an interactive confirmation card rendered below your message. Never claim a staged job has already completed, and never say the card is "above"—briefly confirm what was staged so the user can click the action button on the card below.',
  ];
  const entry = getSlashCommand(slashCommand);
  if (entry?.toolName) {
    base.push(
      `The user invoked /${entry.command}, requesting help via \`${entry.toolName}\` (${entry.summary}). Gather any needed context first if required, then invoke \`${entry.toolName}\`.`,
    );
  }
  return base.join('\n\n');
}

function buildCompactHistoryTranscript(messages: readonly StoredChatMessage[]): string {
  if (messages.length === 0) return '';
  const recent = messages.slice(-16);
  const lines = ['[Previous Thread History]'];
  for (const msg of recent) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant';
    const snippet = msg.text.trim().slice(0, 1500);
    if (snippet) {
      lines.push(`${speaker}: ${snippet}`);
    }
    if (msg.references && msg.references.length > 0) {
      const refNotes = msg.references
        .map((r) => `${r.uri} (${JSON.stringify(r.title)})`)
        .join(', ');
      lines.push(`${speaker} references: ${refNotes}`);
    }
    if (msg.resultParts && msg.resultParts.length > 0) {
      const cardNotes = msg.resultParts
        .map((p) => {
          if (p.kind === 'action-card') {
            const ids = [
              p.itemId ? `itemId=${JSON.stringify(p.itemId)}` : null,
              p.generationId ? `generationId=${JSON.stringify(p.generationId)}` : null,
            ]
              .filter(Boolean)
              .join(' ');
            return `[ActionCard ${p.toolName} state=${p.state}${ids ? ` ${ids}` : ''} title=${JSON.stringify(p.title)}]`;
          }
          if (p.kind === 'media-embed') {
            const genSuffix = p.generationId ? ` generationId=${JSON.stringify(p.generationId)}` : '';
            return `[MediaEmbed mdmedia://${p.mediaType}/${p.itemId}${genSuffix} title=${JSON.stringify(p.title)}]`;
          }
          return null;
        })
        .filter(Boolean);
      if (cardNotes.length > 0) {
        lines.push(`${speaker} attachments: ${cardNotes.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

function isExpiredInteractionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = Number((error as { status?: unknown; code?: unknown }).status ?? (error as { code?: unknown }).code);
  if (status === 400 || status === 404) return true;
  const msg = String((error as { message?: unknown }).message ?? '');
  return /\b(404|400)\b|not[_\s-]?found|expired|previous_interaction_id/i.test(msg);
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError';
}

interface ExtractedFunctionCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PendingFunctionCallAcc {
  id: string;
  name: string;
  initialArgs: Record<string, unknown>;
  argChunks: string;
}

export interface RunChatTurnParams {
  caller: Caller;
  threadId: string;
  text: string;
  slashCommand?: SlashCommandId | null;
  viewContext?: ActiveViewContext | null;
  contextBadge?: { label: string; href?: string } | null;
  references?: ChatEntityReference[];
  threadTitleHint?: string | null;
  userMessageId?: string;
  assistantMessageId?: string;
  origin: string;
  signal: AbortSignal;
  store?: ChatStorePort;
  interactionsClient?: ChatInteractionsClient;
  model?: string;
  effort?: ChatEffortLevel | null;
  onEvent?: (event: ChatSseEvent) => void | Promise<void>;
}

export interface RunChatTurnResult {
  aborted: boolean;
  events: ChatSseEvent[];
  userMessage: StoredChatMessage;
  assistantMessage: StoredChatMessage | null;
  thread: ChatThreadSummary;
}

export async function runChatTurn(params: RunChatTurnParams): Promise<RunChatTurnResult> {
  const {
    caller,
    threadId,
    origin,
    signal,
    onEvent,
  } = params;
  const chatStore = params.store ?? getServerChatStore();
  const interactionsClient = params.interactionsClient ?? defaultInteractionsClient();
  const model = params.model?.trim() || configuredChatModel();
  const effort: ChatEffortLevel =
    params.effort && isChatEffortLevel(params.effort) ? params.effort : DEFAULT_CHAT_EFFORT;
  const normalizedModel: ChatModelName | null = isChatModelName(model) ? model : null;

  const events: ChatSseEvent[] = [];
  const emit = async (event: ChatSseEvent) => {
    events.push(event);
    if (onEvent) {
      await onEvent(event);
    }
  };

  // Resolve explicit or leading `/command` token
  let effectiveSlashCommand: SlashCommandId | null = params.slashCommand ?? null;
  let effectiveUserText = params.text.trim();
  if (!effectiveSlashCommand) {
    const parsedLeading = extractLeadingSlashCommand(effectiveUserText);
    if (parsedLeading.slashCommand && parsedLeading.slashCommand.pinMode !== 'client-only') {
      effectiveSlashCommand = parsedLeading.slashCommand.command;
      if (parsedLeading.remainingText) {
        effectiveUserText = parsedLeading.remainingText;
      }
    }
  }

  const viewContext = params.viewContext ?? null;
  const fallbackTitleSource =
    effectiveUserText || params.text || params.references?.[0]?.title || '';
  const initialTitle =
    params.threadTitleHint?.trim() ||
    deriveThreadTitle(fallbackTitleSource, 'New chat');

  const thread = await chatStore.ensureThread(caller.uid, {
    id: threadId,
    title: initialTitle,
    lastSurface: viewContext?.surface ?? null,
  });

  // Load prior messages BEFORE appending the new user message so Step-0 fallback & thread media context have clean history
  const priorMessages =
    thread.messageCount > 0 || Boolean(thread.lastInteractionId)
      ? await chatStore.listMessages(caller.uid, thread.id)
      : [];

  const userMessageId =
    params.userMessageId && validMediaId(params.userMessageId)
      ? params.userMessageId
      : `msg_u_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const assistantMessageId =
    params.assistantMessageId && validMediaId(params.assistantMessageId)
      ? params.assistantMessageId
      : `msg_a_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  const resolvedBadge =
    params.contextBadge !== undefined
      ? params.contextBadge
      : viewContext
        ? (() => {
            const label = formatActiveViewPillLabel(viewContext);
            return label ? { label, href: viewContext.route } : null;
          })()
        : null;

  const userMessage: StoredChatMessage = {
    id: userMessageId,
    ownerUid: caller.uid,
    role: 'user',
    text: params.text.trim(),
    slashCommand: effectiveSlashCommand,
    contextBadge: resolvedBadge,
    ...(params.references && params.references.length > 0
      ? { references: params.references }
      : {}),
    createdAt: Date.now(),
  };

  const shouldUpdateTitle = thread.messageCount === 0 || thread.title === 'New chat';
  const appendedUser = await chatStore.appendMessage(caller.uid, thread.id, userMessage, {
    ...(shouldUpdateTitle ? { title: initialTitle } : {}),
    lastSurface: viewContext?.surface ?? thread.lastSurface,
  });
  let currentThread = appendedUser.thread;

  if (signal.aborted) {
    return {
      aborted: true,
      events,
      userMessage,
      assistantMessage: null,
      thread: currentThread,
    };
  }

  await emit({
    type: 'turn.start',
    threadId: currentThread.id,
    userMessageId,
    assistantMessageId,
  });

  const allowedTools = getAllowedToolsForCaller(caller);
  const allowedToolNames = new Set(allowedTools.map((t) => t.name));
  const geminiTools = toGeminiFunctionDeclarations(allowedTools);
  const systemInstruction = buildSystemInstruction(effectiveSlashCommand);

  const viewBlock = buildActiveViewPromptBlock(viewContext);
  const referencedBlock = buildReferencedItemsPromptBlock(params.references);
  const recentMediaBlock = buildRecentThreadMediaPromptBlock(priorMessages);
  const userPromptLine =
    effectiveUserText ||
    params.text.trim() ||
    (params.references && params.references.length > 0
      ? 'Please inspect and summarize the referenced Studio item(s).'
      : '');
  const baseUserTurnInput = [viewBlock, referencedBlock, recentMediaBlock, userPromptLine]
    .filter(Boolean)
    .join('\n\n');

  const computeStepToolChoice = (stepIndex: number): Interactions.GenerationConfig['tool_choice'] => {
    if (stepIndex > 0) return 'auto';
    const entry = getSlashCommand(effectiveSlashCommand);
    if (!entry?.toolName || !allowedToolNames.has(entry.toolName)) {
      return 'auto';
    }
    if (entry.pinMode === 'single') {
      return {
        allowed_tools: {
          mode: 'any',
          tools: [entry.toolName],
        },
      };
    }
    if (entry.pinMode === 'context-then-tool') {
      const contextReaders = allowedTools
        .filter((t) => t.kind === 'context' && t.policy === 'auto-read')
        .map((t) => t.name);
      const tools = Array.from(new Set([...contextReaders, entry.toolName]));
      return {
        allowed_tools: {
          mode: 'any',
          tools,
        },
      };
    }
    return 'auto';
  };

  let previousInteractionId: string | undefined = currentThread.lastInteractionId ?? undefined;
  let latestInteractionId: string | null = currentThread.lastInteractionId;
  let stepInput: Interactions.CreateModelInteractionParamsStreaming['input'] = baseUserTurnInput;

  // If there was no `lastInteractionId` on an existing thread that already had messages, include compact history
  if (!previousInteractionId && priorMessages.length > 0) {
    const replayBlock = buildCompactHistoryTranscript(priorMessages);
    if (replayBlock) {
      stepInput = `${replayBlock}\n\n${baseUserTurnInput}`;
    }
  }

  let assistantText = '';
  const assistantCreatedAt = Math.max(Date.now(), userMessage.createdAt + 1);
  const collectedResultParts: ChatResultPart[] = [];
  const seenMediaEmbedKeys = new Set<string>();
  const thoughtHeadlines: string[] = [];
  const seenHeadlines = new Set<string>();
  let thoughtStartedAt: number | null = null;
  let totalThoughtDurationMs = 0;
  let thoughtBlockOpen = false;

  const persistAssistantSnapshot = async (
    finalInteractionId: string | null,
    updateThreadInteractionId: boolean,
  ): Promise<StoredChatMessage> => {
    const thoughtSummary =
      thoughtHeadlines.length > 0 || totalThoughtDurationMs > 0
        ? {
            durationMs: Math.max(1, totalThoughtDurationMs),
            steps: [...thoughtHeadlines],
          }
        : null;
    const orderedParts = orderChatResultParts(collectedResultParts);
    const snapshot: StoredChatMessage = {
      id: assistantMessageId,
      ownerUid: caller.uid,
      role: 'assistant',
      text: assistantText.trim(),
      thoughtSummary,
      ...(orderedParts.length > 0 ? { resultParts: orderedParts } : {}),
      interactionId: finalInteractionId,
      model: normalizedModel,
      effort,
      createdAt: assistantCreatedAt,
    };
    const persisted = await chatStore.appendMessage(caller.uid, currentThread.id, snapshot, {
      ...(updateThreadInteractionId ? { lastInteractionId: finalInteractionId } : {}),
      lastSurface: viewContext?.surface ?? currentThread.lastSurface,
    });
    currentThread = persisted.thread;
    return persisted.message;
  };

  const flushPartialIfNonEmpty = async (): Promise<StoredChatMessage | null> => {
    if (!collectedResultParts.some((p) => p.kind === 'action-card')) {
      return null;
    }
    try {
      return await persistAssistantSnapshot(null, false);
    } catch {
      return null;
    }
  };

  const closeThoughtBlockIfOpen = async () => {
    if (!thoughtBlockOpen) return;
    const elapsed = thoughtStartedAt !== null ? Math.max(1, Date.now() - thoughtStartedAt) : 1;
    totalThoughtDurationMs += elapsed;
    thoughtBlockOpen = false;
    thoughtStartedAt = null;
    await emit({ type: 'thought.done', durationMs: totalThoughtDurationMs });
  };

  const recordHeadline = (headline: string | null) => {
    if (!headline || seenHeadlines.has(headline)) return;
    seenHeadlines.add(headline);
    thoughtHeadlines.push(headline);
  };

  try {
    for (let stepIdx = 0; stepIdx <= MAX_TOOL_STEPS; stepIdx++) {
      if (signal.aborted) {
        return {
          aborted: true,
          events,
          userMessage,
          assistantMessage: null,
          thread: currentThread,
        };
      }

      const allowToolsThisStep = stepIdx < MAX_TOOL_STEPS && geminiTools.length > 0;
      const toolChoice = allowToolsThisStep ? computeStepToolChoice(stepIdx) : 'none';

      const buildRequestPayload = (
        prevId: string | undefined,
        inputPayload: Interactions.CreateModelInteractionParamsStreaming['input'],
      ): Interactions.CreateModelInteractionParamsStreaming => ({
        model,
        input: inputPayload,
        system_instruction: systemInstruction,
        store: true,
        stream: true,
        ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
        ...(prevId ? { previous_interaction_id: prevId } : {}),
        generation_config: {
          thinking_summaries: 'auto',
          ...(effort !== 'auto' ? { thinking_level: effort } : {}),
          ...(geminiTools.length > 0 ? { tool_choice: toolChoice } : {}),
        },
      });

      let stepFunctionCalls: ExtractedFunctionCall[] = [];
      let retriedExpiredOnStep0 = false;

      while (true) {
        const thoughtByStepIndex = new Map<number, string>();
        const pendingCallsByIndex = new Map<number, PendingFunctionCallAcc>();
        let completedSteps: Interactions.Step[] | undefined;
        let emittedAnyEventInAttempt = false;

        try {
          const stream = await interactionsClient.create(
            buildRequestPayload(previousInteractionId, stepInput),
            { maxRetries: 0, fetchOptions: { signal } },
          );

          for await (const rawEvent of stream) {
            if (signal.aborted) {
              const partial = await flushPartialIfNonEmpty();
              return {
                aborted: true,
                events,
                userMessage,
                assistantMessage: partial,
                thread: currentThread,
              };
            }

            const event = rawEvent as Interactions.InteractionSSEEvent & {
              event_type: string;
              index?: number;
              step?: Interactions.Step;
              delta?: Record<string, unknown>;
              interaction?: { id?: string; status?: string; steps?: Interactions.Step[] };
              error?: { code?: string | number; message?: string };
            };

            if (event.event_type === 'interaction.created') {
              if (event.interaction?.id) {
                latestInteractionId = event.interaction.id;
              }
              continue;
            }

            if (event.event_type === 'error') {
              const err = new Error(event.error?.message || 'Gemini interaction stream failed.');
              (err as Error & { code?: unknown }).code = event.error?.code;
              throw err;
            }

            if (event.event_type === 'step.start' && event.step) {
              const idx = event.index ?? 0;
              if (event.step.type === 'function_call') {
                pendingCallsByIndex.set(idx, {
                  id: event.step.id,
                  name: event.step.name,
                  initialArgs:
                    event.step.arguments && typeof event.step.arguments === 'object'
                      ? (event.step.arguments as Record<string, unknown>)
                      : {},
                  argChunks: '',
                });
              } else if (event.step.type === 'thought') {
                if (thoughtStartedAt === null) {
                  thoughtStartedAt = Date.now();
                }
              }
              continue;
            }

            if (event.event_type === 'step.delta' && event.delta) {
              const idx = event.index ?? 0;
              const deltaType = event.delta.type;

              if (deltaType === 'thought_summary') {
                const contentObj = event.delta.content as { text?: string } | string | undefined;
                const deltaText =
                  typeof contentObj === 'string'
                    ? contentObj
                    : typeof contentObj?.text === 'string'
                      ? contentObj.text
                      : typeof event.delta.text === 'string'
                        ? event.delta.text
                        : '';
                if (deltaText) {
                  emittedAnyEventInAttempt = true;
                  if (!thoughtBlockOpen) {
                    thoughtBlockOpen = true;
                    thoughtStartedAt = Date.now();
                  }
                  const combined = (thoughtByStepIndex.get(idx) ?? '') + deltaText;
                  thoughtByStepIndex.set(idx, combined);
                  const headline = extractThoughtHeadline(combined) ?? 'Thinking…';
                  if (/^\s*\*\*[^*]+\*\*/.test(combined)) {
                    recordHeadline(headline);
                  }
                  await emit({
                    type: 'thought.delta',
                    headline,
                    delta: deltaText,
                  });
                }
                continue;
              }

              if (deltaType === 'text') {
                const chunk = typeof event.delta.text === 'string' ? event.delta.text : '';
                if (chunk) {
                  emittedAnyEventInAttempt = true;
                  await closeThoughtBlockIfOpen();
                  assistantText += chunk;
                  await emit({ type: 'text.delta', text: chunk });
                }
                continue;
              }

              if (deltaType === 'arguments_delta') {
                const pending = pendingCallsByIndex.get(idx);
                if (pending && typeof event.delta.arguments === 'string') {
                  pending.argChunks += event.delta.arguments;
                }
                continue;
              }
            }

            if (event.event_type === 'step.stop') {
              const idx = event.index ?? 0;
              const accumulatedThought = thoughtByStepIndex.get(idx);
              if (accumulatedThought) {
                recordHeadline(extractThoughtHeadline(accumulatedThought));
              }
              continue;
            }

            if (event.event_type === 'interaction.completed') {
              if (event.interaction?.id) {
                latestInteractionId = event.interaction.id;
              }
              completedSteps = event.interaction?.steps;
              continue;
            }
          }

          // Finalize any open thought summaries from this step
          for (const [, text] of thoughtByStepIndex) {
            recordHeadline(extractThoughtHeadline(text));
          }

          if (completedSteps && completedSteps.length > 0) {
            for (const s of completedSteps) {
              if (s.type === 'thought' && Array.isArray(s.summary)) {
                for (const item of s.summary) {
                  if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
                    recordHeadline(extractThoughtHeadline(item.text));
                  }
                }
              }
            }

            const completedFnCalls = completedSteps.filter(
              (s): s is Interactions.FunctionCallStep => s.type === 'function_call',
            );
            if (completedFnCalls.length > 0) {
              stepFunctionCalls = completedFnCalls.map((fn) => ({
                id: fn.id,
                name: fn.name,
                arguments:
                  fn.arguments && typeof fn.arguments === 'object'
                    ? (fn.arguments as Record<string, unknown>)
                    : {},
              }));
            }

            // Fallback: if model_output text was only present in `interaction.completed.steps`
            if (!emittedAnyEventInAttempt && stepFunctionCalls.length === 0) {
              for (const s of completedSteps) {
                if (s.type === 'model_output' && Array.isArray(s.content)) {
                  for (const part of s.content) {
                    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text) {
                      await closeThoughtBlockIfOpen();
                      assistantText += part.text;
                      await emit({ type: 'text.delta', text: part.text });
                    }
                  }
                }
              }
            }
          }

          if (stepFunctionCalls.length === 0 && pendingCallsByIndex.size > 0) {
            stepFunctionCalls = [...pendingCallsByIndex.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, pending]) => {
                let parsedArgs = pending.initialArgs;
                if (pending.argChunks.trim()) {
                  try {
                    const parsed = JSON.parse(pending.argChunks);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                      parsedArgs = parsed as Record<string, unknown>;
                    }
                  } catch {
                    // Keep initialArgs if delta JSON was partial
                  }
                }
                return {
                  id: pending.id,
                  name: pending.name,
                  arguments: parsedArgs,
                };
              });
          }

          break;
        } catch (err) {
          if (isAbortError(err, signal)) {
            const partial = await flushPartialIfNonEmpty();
            return {
              aborted: true,
              events,
              userMessage,
              assistantMessage: partial,
              thread: currentThread,
            };
          }

          if (
            stepIdx === 0 &&
            !retriedExpiredOnStep0 &&
            Boolean(previousInteractionId) &&
            !emittedAnyEventInAttempt &&
            isExpiredInteractionError(err)
          ) {
            retriedExpiredOnStep0 = true;
            previousInteractionId = undefined;
            latestInteractionId = null;
            const replayBlock = buildCompactHistoryTranscript(priorMessages);
            stepInput = replayBlock ? `${replayBlock}\n\n${baseUserTurnInput}` : baseUserTurnInput;
            continue;
          }

          throw err;
        }
      }

      if (stepFunctionCalls.length === 0 || !allowToolsThisStep) {
        await closeThoughtBlockIfOpen();
        break;
      }

      await closeThoughtBlockIfOpen();

      // Execute each requested tool call and assemble FunctionResultStep[]
      const functionResultSteps: Interactions.FunctionResultStep[] = [];
      for (const fnCall of stepFunctionCalls) {
        if (signal.aborted) {
          return {
            aborted: true,
            events,
            userMessage,
            assistantMessage: null,
            thread: currentThread,
          };
        }

        const safeCallId =
          fnCall.id && validMediaId(fnCall.id)
            ? fnCall.id
            : `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const toolDef = getChatTool(fnCall.name);

        await emit({
          type: 'tool.start',
          callId: safeCallId,
          toolName: fnCall.name,
          label: toolDef?.runningLabel ?? `Running ${fnCall.name}…`,
        });

        const outcome = await executeChatToolCall(fnCall.name, fnCall.arguments, {
          caller,
          origin,
          threadId: currentThread.id,
          messageId: assistantMessageId,
          callId: safeCallId,
          viewContext,
          confirmedByUser: false,
          signal,
        });

        if (signal.aborted) {
          return {
            aborted: true,
            events,
            userMessage,
            assistantMessage: null,
            thread: currentThread,
          };
        }

        if (outcome.stagedPayload && !outcome.isError) {
          const now = Date.now();
          await chatStore.putStagedAction(caller.uid, {
            callId: safeCallId,
            threadId: currentThread.id,
            messageId: assistantMessageId,
            ownerUid: caller.uid,
            toolName: fnCall.name,
            validatedInput: outcome.stagedPayload.validatedInput,
            state: 'staged',
            generationId: null,
            resultItemId: null,
            targetRoute: outcome.stagedPayload.targetRoute ?? null,
            createdAt: now,
            updatedAt: now,
          });
        }

        if (outcome.clientAction && !outcome.isError) {
          await emit({
            type: 'client.action',
            action: outcome.clientAction,
          });
        }

        const rawUiParts = outcome.uiParts ?? [];
        const uiParts = rawUiParts.filter((part) => {
          if (part.kind !== 'media-embed') return true;
          const key = `${part.mediaType}:${part.itemId}`;
          if (seenMediaEmbedKeys.has(key)) return false;
          seenMediaEmbedKeys.add(key);
          return true;
        });
        if (uiParts.length > 0) {
          collectedResultParts.push(...uiParts);
          if (uiParts.some((part) => part.kind === 'action-card')) {
            await persistAssistantSnapshot(null, false);
          }
        }

        await emit({
          type: 'tool.result',
          callId: safeCallId,
          toolName: fnCall.name,
          parts: uiParts,
        });

        functionResultSteps.push({
          type: 'function_result',
          call_id: fnCall.id || safeCallId,
          name: fnCall.name,
          ...(outcome.isError ? { is_error: true } : {}),
          result: outcome.modelSummary,
        });
      }

      previousInteractionId = latestInteractionId ?? undefined;
      stepInput = functionResultSteps;
    }

    if (signal.aborted) {
      const partial = await flushPartialIfNonEmpty();
      return {
        aborted: true,
        events,
        userMessage,
        assistantMessage: partial,
        thread: currentThread,
      };
    }

    const persistedMessage = await persistAssistantSnapshot(latestInteractionId, true);

    await emit({
      type: 'turn.done',
      assistantMessage: persistedMessage,
      threadTitle: currentThread.title,
    });

    return {
      aborted: false,
      events,
      userMessage,
      assistantMessage: persistedMessage,
      thread: currentThread,
    };
  } catch (error) {
    if (isAbortError(error, signal)) {
      const partial = await flushPartialIfNonEmpty();
      return {
        aborted: true,
        events,
        userMessage,
        assistantMessage: partial,
        thread: currentThread,
      };
    }

    await closeThoughtBlockIfOpen();
    const code =
      error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'chat_turn_failed';
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Studio Chat could not complete this turn.';

    await emit({
      type: 'turn.error',
      code,
      message,
    });

    return {
      aborted: false,
      events,
      userMessage,
      assistantMessage: null,
      thread: currentThread,
    };
  }
}

export function createChatTurnSseStream(params: Omit<RunChatTurnParams, 'onEvent'>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (event: ChatSseEvent) => {
        if (closed || params.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          closed = true;
        }
      };

      try {
        await runChatTurn({
          ...params,
          onEvent: safeEnqueue,
        });
      } catch (err) {
        if (!params.signal.aborted) {
          safeEnqueue({
            type: 'turn.error',
            code: 'internal_error',
            message: err instanceof Error ? err.message : 'Unexpected streaming error.',
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Stream already closed by reader disconnect
          }
        }
      }
    },
  });
}
