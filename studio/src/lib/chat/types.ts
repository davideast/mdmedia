/**
 * Shared client + server contracts for Studio Contextual Chat.
 *
 * Pure TypeScript types and deterministic formatting helpers—no Node,
 * Firebase, or React imports so both browser bundles and API routes share it.
 */

export type RightColumnMode = 'inspector' | 'chat';

export const CHAT_MODELS = [
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
] as const;

export type ChatModelName = (typeof CHAT_MODELS)[number];

export const DEFAULT_CHAT_MODEL: ChatModelName = 'gemini-3.8-flash';

export const CHAT_MODEL_OPTIONS: ReadonlyArray<{
  value: ChatModelName;
  label: string;
  shortLabel: string;
  hint: string;
}> = [
  {
    value: 'gemini-4-argon',
    label: 'gemini-4-argon',
    shortLabel: 'gemini-4-argon',
    hint: 'Frontier reasoning and complex multi-step synthesis',
  },
  {
    value: 'gemini-3.8-flash',
    label: 'gemini-3.8-flash',
    shortLabel: 'gemini-3.8-flash',
    hint: 'Balanced speed and multimodal Studio tool use',
  },
  {
    value: 'gemini-3.5-flash-lite',
    label: 'gemini-3.5-flash-lite',
    shortLabel: 'gemini-3.5-flash-lite',
    hint: 'Fastest, lowest-latency responses and lookups',
  },
];

export const CHAT_EFFORT_LEVELS = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
] as const;

export type ChatEffortLevel = (typeof CHAT_EFFORT_LEVELS)[number];

export const DEFAULT_CHAT_EFFORT: ChatEffortLevel = 'auto';

export const CHAT_EFFORT_OPTIONS: ReadonlyArray<{
  value: ChatEffortLevel;
  label: string;
  shortLabel: string;
  hint: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    shortLabel: 'Auto',
    hint: 'Model adapts thinking depth to the prompt',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    shortLabel: 'Min',
    hint: 'Fastest direct answer with minimal thinking',
  },
  {
    value: 'low',
    label: 'Low',
    shortLabel: 'Low',
    hint: 'Light reasoning for quick questions and actions',
  },
  {
    value: 'medium',
    label: 'Medium',
    shortLabel: 'Med',
    hint: 'Balanced reasoning across context and tools',
  },
  {
    value: 'high',
    label: 'High',
    shortLabel: 'High',
    hint: 'Deepest thinking budget for complex synthesis',
  },
];

export function isChatModelName(value: unknown): value is ChatModelName {
  return typeof value === 'string' && (CHAT_MODELS as readonly string[]).includes(value);
}

export function isChatEffortLevel(value: unknown): value is ChatEffortLevel {
  return typeof value === 'string' && (CHAT_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function formatChatSelectorLabel(
  model: ChatModelName,
  effort: ChatEffortLevel,
): string {
  const modelOpt = CHAT_MODEL_OPTIONS.find((m) => m.value === model);
  const base = modelOpt?.shortLabel ?? model;
  if (effort === 'auto') return base;
  const effortOpt = CHAT_EFFORT_OPTIONS.find((e) => e.value === effort);
  return `${base} · ${effortOpt?.label ?? effort}`;
}

export type ChatMediaType = 'narration' | 'video' | 'image' | 'music' | 'sfx' | 'analysis';

export const CHAT_REFERENCE_KINDS = [
  'narration',
  'video',
  'image',
  'music',
  'sfx',
  'analysis',
  'tree',
  'tree-doc',
  'production',
  'cut',
  'storyboard',
  'character',
  'playlist',
] as const;

export type ChatReferenceKind = (typeof CHAT_REFERENCE_KINDS)[number];

export type ChatReferenceCategory =
  | 'all'
  | 'media'
  | 'docs'
  | 'production'
  | 'characters'
  | 'playlists';

export interface ChatEntityReference {
  /** Canonical URI, e.g. `mdmedia://narration/nar_1`, `mdmedia://tree-doc/t1/intro.md`, `mdmedia://character/rick@1`. */
  uri: string;
  kind: ChatReferenceKind;
  /** Primary entity identifier (`itemId`, `treeId`, `productionId`, `storyboardId`, `slug`, `playlistId`). */
  id: string;
  /** Secondary path, cut ID, generation ID, or character version string when applicable. */
  subId?: string;
  /** Primary human-readable title. */
  title: string;
  /** Secondary disambiguating context (e.g. `Handbook / 01-intro.md`, `Puck`, `Series · 3 cuts`, `ElevenLabs "Eric"`). */
  subtitle?: string;
  /** Compact monospace badge (`02:02`, `12 beats`, `rick@1`, `6 items`, `SFX · 0:04`). */
  metaLabel?: string;
  /** Character sub-kind (`person` vs `thing` prop) when `kind === 'character'`. */
  characterKind?: 'person' | 'thing';
  /** Cut review status when `kind === 'cut'`. */
  cutStatus?: 'review' | 'approved' | 'final' | 'none';
  /** Owned Studio asset ID for signed thumbnail lookup via `useMediaLinks`. */
  thumbnailAssetId?: string | null;
  /** Direct data/local image URL when not backed by an asset ID (e.g. storyboard beat concept image). */
  thumbnailUrl?: string | null;
  /** Navigation route in Studio (or `#character:<slug>@<version>` for the Character Inspector). */
  href: string;
  /** Optional `#Token` text inserted in the composer so user bubbles can replace it inline. */
  composerToken?: string;
  /** True when sourced from an unsaved browser workspace draft tab. */
  isLocalDraft?: boolean;
  updatedAt?: number;
}

export type ComposerDraftKind = 'narration' | 'image' | 'video' | 'music' | 'analysis';

export type SlashCommandId =
  | 'analyze'
  | 'narrate'
  | 'image'
  | 'video'
  | 'music'
  | 'doc'
  | 'find'
  | 'context'
  | 'open'
  | 'new';

/**
 * Tier-1 ambient pointer snapshot (~80–180 tokens) published by the active
 * Studio surface via `ChatContextBridge`. Deep content (full markdown,
 * transcripts, catalog items) is fetched lazily by Context Tools on demand.
 */
export type ActiveViewContext =
  | {
      surface: 'analysis';
      route: string;
      itemId: string;
      title: string;
      status?: string;
      sourceVideoId?: string | null;
      sourceYoutubeUrl?: string | null;
      playheadSeconds?: number | null;
    }
  | {
      surface: 'tree-doc';
      route: string;
      treeId: string;
      treeTitle?: string;
      docId?: string | null;
      docPath: string;
      docTitle?: string;
      activeHeading?: string | null;
      selectionExcerpt?: string | null;
    }
  | {
      surface: 'narration';
      route: string;
      itemId: string;
      title: string;
      voiceName?: string | null;
      playheadSeconds?: number | null;
      durationSeconds?: number | null;
    }
  | {
      surface: 'video' | 'image' | 'music';
      route: string;
      itemId: string;
      title: string;
      status?: string;
      generationId?: string | null;
      playheadSeconds?: number | null;
    }
  | {
      surface: 'composer';
      route: string;
      draftKind: ComposerDraftKind;
      draftTitle?: string;
      promptExcerpt?: string;
      selectedSourceId?: string | null;
    }
  | {
      surface: 'cut';
      route: string;
      productionId: string;
      cutId: string;
      title: string;
      playheadSeconds?: number | null;
      activeSceneId?: string | null;
    }
  | {
      surface: 'storyboard';
      route: string;
      storyboardId: string;
      title: string;
      selectedShotIndex?: number | null;
    }
  | {
      surface: 'library' | 'activity' | 'playlist';
      route: string;
      title?: string;
      activeFilter?: string | null;
      playlistId?: string | null;
    };

export function formatClockSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const whole = Math.floor(seconds);
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function truncateMiddle(text: string, max = 32): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Formats the single-line label shown inside `ChatAmbientPill`.
 * Returns `null` when the current surface has no meaningful focal context
 * (e.g. unfiltered `/library` or `/queue`).
 */
export function formatActiveViewPillLabel(ctx: ActiveViewContext | null): string | null {
  if (!ctx) return null;
  switch (ctx.surface) {
    case 'analysis': {
      const parts = ['Analysis', truncateMiddle(ctx.title || 'Untitled', 28)];
      const clock = formatClockSeconds(ctx.playheadSeconds);
      if (clock) parts.push(clock);
      return parts.join(' · ');
    }
    case 'tree-doc': {
      const docName = ctx.docTitle?.trim() || ctx.docPath.split('/').pop() || ctx.docPath;
      const parts = ['Doc', truncateMiddle(docName, 26)];
      if (ctx.selectionExcerpt?.trim()) {
        parts.push(`"${truncateMiddle(ctx.selectionExcerpt, 18)}"`);
      } else if (ctx.activeHeading?.trim()) {
        parts.push(`§${truncateMiddle(ctx.activeHeading, 18)}`);
      }
      return parts.join(' · ');
    }
    case 'narration': {
      const parts = ['Narration', truncateMiddle(ctx.title || 'Untitled', 26)];
      const clock = formatClockSeconds(ctx.playheadSeconds);
      if (clock) parts.push(clock);
      return parts.join(' · ');
    }
    case 'video':
    case 'image':
    case 'music': {
      const prefix = ctx.surface === 'video' ? 'Video' : ctx.surface === 'image' ? 'Image' : 'Music';
      const parts = [prefix, truncateMiddle(ctx.title || 'Untitled', 26)];
      const clock = formatClockSeconds(ctx.playheadSeconds);
      if (clock) parts.push(clock);
      return parts.join(' · ');
    }
    case 'composer': {
      const kindLabel =
        ctx.draftKind === 'analysis'
          ? 'Video Analysis'
          : ctx.draftKind === 'narration'
            ? 'Narration'
            : ctx.draftKind === 'video'
              ? 'Video'
              : ctx.draftKind === 'image'
                ? 'Image'
                : 'Music';
      return `Draft · ${kindLabel}`;
    }
    case 'cut': {
      const parts = ['Cut', truncateMiddle(ctx.title || ctx.cutId, 26)];
      const clock = formatClockSeconds(ctx.playheadSeconds);
      if (clock) parts.push(clock);
      return parts.join(' · ');
    }
    case 'storyboard': {
      const parts = ['Storyboard', truncateMiddle(ctx.title || 'Untitled', 24)];
      if (typeof ctx.selectedShotIndex === 'number') {
        parts.push(`Shot ${ctx.selectedShotIndex + 1}`);
      }
      return parts.join(' · ');
    }
    case 'playlist':
      return ctx.title ? `Playlist · ${truncateMiddle(ctx.title, 28)}` : 'Playlist';
    case 'library':
      return ctx.activeFilter ? `Library · ${ctx.activeFilter}` : null;
    case 'activity':
      return ctx.activeFilter ? `Activity · ${ctx.activeFilter}` : null;
  }
}

export type CardActionDescriptor =
  | {
      kind: 'confirm';
      label: string;
      primary?: boolean;
    }
  | {
      kind: 'edit-in-studio';
      label: string;
      draftKind: ComposerDraftKind;
      patch: Record<string, unknown>;
      href: string;
    }
  | {
      kind: 'open-route';
      label: string;
      href: string;
    }
  | {
      kind: 'seek';
      label: string;
      seconds: number;
    }
  | {
      kind: 'insert-into-doc';
      label: string;
      mediaType: ChatMediaType;
      itemId: string;
      altTitle: string;
    };

export type ActionCardState = 'staged' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type StagedMediaDeliveryMode = 'refine' | 'regenerate' | 'new_item';

export interface ActionCardRevisionTarget {
  itemId: string;
  title: string;
  fromGenerationId?: string | null;
  defaultMode: StagedMediaDeliveryMode;
  supportedModes: readonly StagedMediaDeliveryMode[];
}

export interface ConfirmStagedActionOverrides {
  deliveryMode?: StagedMediaDeliveryMode;
  targetItemId?: string | null;
  fromGenerationId?: string | null;
}

export type ChatResultPart =
  | {
      kind: 'media-embed';
      mediaType: ChatMediaType;
      itemId: string;
      generationId?: string | null;
      title: string;
      subtitle?: string;
      excerptMarkdown?: string;
      clipStartSeconds?: number;
    }
  | {
      kind: 'action-card';
      callId: string;
      toolName: string;
      state: ActionCardState;
      title: string;
      meta: string;
      previewMarkdown?: string;
      generationId?: string | null;
      itemId?: string | null;
      mediaType?: Exclude<ChatMediaType, 'sfx'>;
      targetRoute?: string | null;
      revisionTarget?: ActionCardRevisionTarget | null;
      progressPercent?: number | null;
      progressMessage?: string | null;
      errorMessage?: string | null;
      cardActions: readonly CardActionDescriptor[];
    }
  | {
      kind: 'link-list';
      items: readonly {
        label: string;
        href: string;
        kind: 'media' | 'route' | 'timestamp';
        mediaType?: ChatMediaType;
        seconds?: number;
      }[];
    };

export type ClientActionPayload =
  | { kind: 'open_route'; href: string }
  | { kind: 'seek_media'; seconds: number; play?: boolean }
  | { kind: 'prefill_draft'; draftKind: ComposerDraftKind; href: string; patch: Record<string, unknown> }
  | { kind: 'insert_markdown'; markdown: string; mode?: 'append' | 'cursor' };

export interface ChatThreadSummary {
  id: string;
  ownerUid: string;
  title: string;
  lastInteractionId: string | null;
  lastSurface: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredChatMessage {
  id: string;
  ownerUid: string;
  role: 'user' | 'assistant';
  text: string;
  slashCommand?: SlashCommandId | null;
  contextBadge?: { label: string; href?: string } | null;
  references?: ChatEntityReference[];
  thoughtSummary?: { durationMs: number; steps: string[] } | null;
  resultParts?: ChatResultPart[];
  interactionId?: string | null;
  model?: ChatModelName | null;
  effort?: ChatEffortLevel | null;
  createdAt: number;
}

export interface ChatStagedAction {
  callId: string;
  threadId: string;
  messageId: string;
  ownerUid: string;
  toolName: string;
  validatedInput: Record<string, unknown>;
  state: 'staged' | 'submitted' | 'canceled';
  generationId?: string | null;
  resultItemId?: string | null;
  targetRoute?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ChatSseEvent =
  | { type: 'turn.start'; threadId: string; userMessageId: string; assistantMessageId: string }
  | { type: 'thought.delta'; headline: string; delta: string }
  | { type: 'thought.done'; durationMs: number }
  | { type: 'tool.start'; callId: string; toolName: string; label: string }
  | { type: 'client.action'; action: ClientActionPayload }
  | { type: 'tool.result'; callId: string; toolName: string; parts: ChatResultPart[] }
  | { type: 'text.delta'; text: string }
  | { type: 'turn.done'; assistantMessage: StoredChatMessage; threadTitle: string }
  | { type: 'turn.error'; code: string; message: string };

const RESULT_PART_RANK: Record<ChatResultPart['kind'], number> = {
  'action-card': 0,
  'link-list': 1,
  'media-embed': 2,
};

/**
 * Orders result parts deterministically so `media-embed` cards always render
 * strictly last after prose, staged action cards, and compact link lists.
 */
export function orderChatResultParts(parts: readonly ChatResultPart[]): ChatResultPart[] {
  if (parts.length <= 1) return [...parts];
  return [...parts].sort((a, b) => RESULT_PART_RANK[a.kind] - RESULT_PART_RANK[b.kind]);
}

export interface ChatNarrationSourceMapBlock {
  mdStart: number;
  mdEnd: number;
  transcriptStart: number;
  transcriptEnd: number;
}

export interface ChatNarrationSourceMap {
  version: 1;
  blocks: ChatNarrationSourceMapBlock[];
}

export interface ChatNarrationWordTiming {
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

export interface ChatNarrationAlignedChunk {
  index: number;
  startMs: number;
  endMs: number;
  docOffset: number;
  text: string;
  words: ChatNarrationWordTiming[];
}

export type ChatNarrationStreamEvent =
  | {
      type: 'transcript';
      transcript: string;
      chunkOffsets: number[];
      sourceMap?: ChatNarrationSourceMap;
    }
  | {
      type: 'audio';
      chunkIndex: number;
      pcm: string;
    }
  | {
      type: 'chunk';
      chunk: ChatNarrationAlignedChunk;
    }
  | {
      type: 'done';
      durationMs: number;
    }
  | {
      type: 'error';
      message: string;
    };

/**
 * Shell-facing slice of `ChatProvider` consumed by `AppShell`, `ContextPanel`,
 * and `NavRail`.
 */
export interface ChatShellController {
  chatOpen: boolean;
  rightMode: RightColumnMode;
  openChat: (options?: { focusComposer?: boolean; initialSlashCommand?: SlashCommandId }) => void;
  closeChat: () => void;
  toggleChat: () => void;
  setRightMode: (mode: RightColumnMode) => void;
}
