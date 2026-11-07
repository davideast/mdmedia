/**
 * Action Tools (`kind: 'action'`) for Studio Contextual Chat.
 *
 * Implements the 3-tier execution policy:
 * - `client-immediate`: Reversible UI navigation, media seeking, and draft prefill.
 * - `staged-confirm`: Paid media generations and tree document writes. Validates
 *   all parameters and ownership up front, NEVER charges quota or mutates Firestore
 *   during the chat turn, and returns `stagedPayload` + a `'staged'` `action-card`.
 */

import { hasScope } from '../../api-auth';
import { loadAnalysisItem, prepareAnalysis } from '../../analysis-server';
import { DEFAULT_IMAGE_MODEL, MediaError, parseImageRequest, readImageDefaults, validMediaId } from '../../image-request';
import { imageDefaults, loadImageItem } from '../../image-server';
import { parseMusicRequest, readMusicDefaults } from '../../music-request';
import { loadMusicItem, musicDefaults } from '../../music-server';
import { resolveNarrationBody } from '../../narration-api';
import { readSettings } from '../../settings';
import { deriveDocTitle, formatMediaMarkdownRef, normalizeVirtualPath } from '../../tree-helpers';
import { validateMarkdownContent } from '../../tree-ops';
import { TreeOpError, type TreeDocument } from '../../tree-types';
import { getServerTreeStore } from '../../trees-server';
import { loadUserSettings } from '../../user-settings-server';
import { parseVideoRequest, readVideoDefaults } from '../../video-request';
import { loadVideoItem, videoDefaults } from '../../video-server';
import {
  formatClockSeconds,
  type ActionCardRevisionTarget,
  type ChatMediaType,
  type ChatResultPart,
  type ComposerDraftKind,
  type StagedMediaDeliveryMode,
} from '../types';
import { parseMdmediaUri } from './context-tools';
import type { ChatToolContext, ChatToolDefinition, ChatToolOutcome } from './types';

function errorOutcome(code: string, message: string): ChatToolOutcome<Record<string, unknown>> {
  return {
    isError: true,
    modelSummary: { error: code, message },
  };
}

function deriveShortTitle(rawTitle: string | undefined, promptOrBody: string, fallback: string): string {
  if (rawTitle?.trim()) {
    return rawTitle.trim().slice(0, 100);
  }
  const firstLine = promptOrBody
    .trim()
    .split('\n')[0]
    ?.replace(/^\s*#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  if (!firstLine) return fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine;
}

export function buildTreeDocHref(treeId: string, docPath: string): string {
  const encodedTree = encodeURIComponent(treeId);
  const encodedSegments = docPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return encodedSegments ? `/trees/${encodedTree}/${encodedSegments}` : `/trees/${encodedTree}`;
}

export function resolveStudioTargetHref(rawTarget: string): {
  href: string;
  mediaType?: ChatMediaType;
  itemId?: string;
} | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;

  const parsedUri = parseMdmediaUri(trimmed);
  if (parsedUri) {
    const href =
      parsedUri.mediaType === 'sfx'
        ? '/library?type=sfx'
        : `/${parsedUri.mediaType}/${encodeURIComponent(parsedUri.itemId)}`;
    return {
      href,
      mediaType: parsedUri.mediaType,
      itemId: parsedUri.itemId,
    };
  }

  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    /[\u0000-\u001f\\]/.test(trimmed) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  ) {
    return null;
  }

  return { href: trimmed };
}

/**
 * Returns `true` when a real or emulated Firestore backend is configured in the
 * current process. Avoids opening unconfigured `firebase-admin` gRPC channels
 * (which enter multi-second retry backoff on non-GCP CI runners) during offline
 * unit tests.
 */
export function hasConfiguredFirestoreEnv(): boolean {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID?.trim() ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
      process.env.FIRESTORE_EMULATOR_HOST?.trim() ||
      process.env.PYRIC_SANDBOX?.trim() ||
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
      process.env.GCLOUD_PROJECT?.trim(),
  );
}

/**
 * Normalizes a raw Studio item reference (`abc123`, `mdmedia://image/abc123`, or `/image/abc123`)
 * into a bare item ID, validating media type when specified.
 */
export function normalizeMediaItemId(
  raw: string | undefined | null,
  expectedType?: ChatMediaType,
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsedUri = parseMdmediaUri(trimmed);
  if (parsedUri) {
    if (expectedType && parsedUri.mediaType !== expectedType) {
      return null;
    }
    return parsedUri.itemId;
  }

  const routeMatch = /^\/(narration|video|image|music|sfx|analysis)\/([^/?#]+)/i.exec(trimmed);
  if (routeMatch) {
    const kind = routeMatch[1]!.toLowerCase() as ChatMediaType;
    if (expectedType && kind !== expectedType) {
      return null;
    }
    try {
      return decodeURIComponent(routeMatch[2]!);
    } catch {
      return routeMatch[2]!;
    }
  }

  return trimmed;
}

/**
 * Computes added and removed line counts between `before` and `after` using
 * bounded LCS when small, or linear prefix/suffix diffing for large files.
 */
export function computeLineDelta(before: string, after: string): {
  added: number;
  removed: number;
  summary: string;
} {
  if (before === after) {
    return { added: 0, removed: 0, summary: '+0 / -0 lines' };
  }
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  if (aMid.length === 0 || bMid.length === 0) {
    const added = bMid.length;
    const removed = aMid.length;
    return { added, removed, summary: `+${added} / -${removed} lines` };
  }

  if (aMid.length * bMid.length <= 40_000) {
    const cols = bMid.length + 1;
    const dp = new Int32Array((aMid.length + 1) * cols);
    for (let i = 1; i <= aMid.length; i++) {
      for (let j = 1; j <= bMid.length; j++) {
        const idx = i * cols + j;
        if (aMid[i - 1] === bMid[j - 1]) {
          dp[idx] = dp[(i - 1) * cols + (j - 1)]! + 1;
        } else {
          const up = dp[(i - 1) * cols + j]!;
          const left = dp[i * cols + (j - 1)]!;
          dp[idx] = up >= left ? up : left;
        }
      }
    }
    const common = dp[aMid.length * cols + bMid.length]!;
    const removed = aMid.length - common;
    const added = bMid.length - common;
    return { added, removed, summary: `+${added} / -${removed} lines` };
  }

  const removed = aMid.length;
  const added = bMid.length;
  return { added, removed, summary: `+${added} / -${removed} lines` };
}

function findHeadingRange(
  lines: readonly string[],
  targetHeading: string,
): { headingLineIdx: number; endLineIdx: number; level: number } | null {
  const normalizedTarget = targetHeading
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^§\s*/, '')
    .toLowerCase();
  if (!normalizedTarget) return null;

  let inFence = false;
  let headingLineIdx = -1;
  let targetLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    const cleanText = match[2]!
      .replace(/\s+#+\s*$/, '')
      .replace(/[*_`~]/g, '')
      .trim()
      .toLowerCase();
    if (headingLineIdx === -1) {
      if (cleanText === normalizedTarget || cleanText.includes(normalizedTarget)) {
        headingLineIdx = i;
        targetLevel = level;
      }
    } else if (level <= targetLevel) {
      return { headingLineIdx, endLineIdx: i, level: targetLevel };
    }
  }

  if (headingLineIdx === -1) return null;
  return { headingLineIdx, endLineIdx: lines.length, level: targetLevel };
}

export function insertMarkdownSnippetIntoDoc(
  existingMarkdown: string,
  snippet: string,
  options: { mode?: 'append' | 'after-heading'; heading?: string },
): { ok: true; nextMarkdown: string; previewSnippet: string } | { ok: false; message: string } {
  const cleanSnippet = snippet.trim();
  const mode = options.mode ?? (options.heading?.trim() ? 'after-heading' : 'append');

  if (mode === 'after-heading' || options.heading?.trim()) {
    const targetHeading = options.heading?.trim() ?? '';
    if (!targetHeading) {
      return { ok: false, message: 'Provide `heading` when `mode` is "after-heading".' };
    }
    const lines = existingMarkdown.split('\n');
    const range = findHeadingRange(lines, targetHeading);
    if (!range) {
      return { ok: false, message: `Heading "${targetHeading}" was not found in the document.` };
    }
    const before = lines.slice(0, range.headingLineIdx + 1);
    const after = lines.slice(range.headingLineIdx + 1);
    const nextLines = [...before, '', cleanSnippet, ...(after[0]?.trim() === '' ? after : ['', ...after])];
    const nextMarkdown = nextLines.join('\n').replace(/\n{3,}/g, '\n\n');
    const previewSnippet = [lines[range.headingLineIdx]!, '', cleanSnippet].join('\n');
    return { ok: true, nextMarkdown, previewSnippet };
  }

  const trimmedExisting = existingMarkdown.trimEnd();
  const nextMarkdown = trimmedExisting ? `${trimmedExisting}\n\n${cleanSnippet}\n` : `${cleanSnippet}\n`;
  const tailContext = trimmedExisting ? trimmedExisting.split('\n').slice(-1)[0] ?? '' : '';
  const previewSnippet = tailContext ? `${tailContext}\n\n${cleanSnippet}` : cleanSnippet;
  return { ok: true, nextMarkdown, previewSnippet };
}

export function applyDocumentMarkdownEdit(
  existingMarkdown: string | null,
  incomingMarkdown: string,
  options: { mode?: 'replace' | 'append' | 'replace-section'; sectionHeading?: string },
): { ok: true; nextMarkdown: string } | { ok: false; message: string } {
  const mode = options.mode ?? 'replace';
  if (mode === 'replace' || existingMarkdown === null) {
    if (mode === 'replace-section' && existingMarkdown === null) {
      return { ok: false, message: 'Cannot use `replace-section` on a document that does not exist yet.' };
    }
    return { ok: true, nextMarkdown: incomingMarkdown };
  }

  if (mode === 'append') {
    const base = existingMarkdown.trimEnd();
    const addition = incomingMarkdown.trim();
    const nextMarkdown = base ? `${base}\n\n${addition}\n` : incomingMarkdown;
    return { ok: true, nextMarkdown };
  }

  if (mode === 'replace-section') {
    const heading = options.sectionHeading?.trim() ?? '';
    if (!heading) {
      return { ok: false, message: 'Provide `sectionHeading` when `mode` is "replace-section".' };
    }
    const lines = existingMarkdown.split('\n');
    const range = findHeadingRange(lines, heading);
    if (!range) {
      return { ok: false, message: `Section heading "${heading}" was not found in the document.` };
    }
    const replacementTrimmed = incomingMarkdown.trim();
    const hasHeadingPrefix = /^\s{0,3}#{1,6}\s+/.test(replacementTrimmed);
    const replacementBlock = hasHeadingPrefix
      ? replacementTrimmed
      : `${lines[range.headingLineIdx]!}\n\n${replacementTrimmed}`;
    const before = lines.slice(0, range.headingLineIdx);
    const after = lines.slice(range.endLineIdx);
    const pieces: string[] = [];
    if (before.length > 0) pieces.push(before.join('\n').trimEnd());
    pieces.push(replacementBlock);
    if (after.length > 0) pieces.push(after.join('\n').trimStart());
    const trailing = existingMarkdown.endsWith('\n') ? '\n' : '';
    return { ok: true, nextMarkdown: `${pieces.join('\n\n')}${trailing}` };
  }

  return { ok: false, message: `Unsupported edit mode "${String(mode)}".` };
}

// ============================================================================
// 1. Client-Immediate Tools (`policy: 'client-immediate'`)
// ============================================================================

export interface OpenInStudioInput {
  target?: string;
  href?: string;
  uri?: string;
  label?: string;
}

export const openInStudioTool: ChatToolDefinition<OpenInStudioInput, Record<string, unknown>> = {
  name: 'open_in_studio',
  runningLabel: 'Opening in Studio…',
  kind: 'action',
  policy: 'client-immediate',
  requiredScopes: ['chat:use'],
  slashCommand: 'open',
  description:
    'Navigates the main Studio workspace to an internal route (e.g. "/analysis/abc", "/trees/t1/notes.md", "/library?type=video") or an `mdmedia://<type>/<id>` URI without closing chat.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Internal Studio route ("/video/123", "/trees/...") or canonical URI ("mdmedia://analysis/123").',
      },
      href: {
        type: 'string',
        description: 'Alias for `target` when passing an internal route path.',
      },
      uri: {
        type: 'string',
        description: 'Alias for `target` when passing an `mdmedia://<type>/<id>` URI.',
      },
      label: {
        type: 'string',
        description: 'Optional display label for the navigation receipt chip.',
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const raw = input.uri?.trim() || input.href?.trim() || input.target?.trim() || '';
    const resolved = resolveStudioTargetHref(raw);
    if (!resolved) {
      return errorOutcome(
        'invalid_target',
        'Provide an internal Studio route starting with "/" or an `mdmedia://<type>/<id>` URI.',
      );
    }

    const label =
      input.label?.trim() ||
      (resolved.mediaType && resolved.itemId
        ? `Open ${resolved.mediaType} ${resolved.itemId}`
        : `Open ${resolved.href}`);

    return {
      modelSummary: {
        opened: true,
        href: resolved.href,
        label,
      },
      clientAction: {
        kind: 'open_route',
        href: resolved.href,
      },
      uiParts: [
        {
          kind: 'link-list',
          items: [
            {
              label,
              href: resolved.href,
              kind: resolved.mediaType ? 'media' : 'route',
              ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
            },
          ],
        },
      ],
    };
  },
};

export interface SeekMediaInput {
  seconds: number;
  play?: boolean;
  label?: string;
}

export const seekMediaTool: ChatToolDefinition<SeekMediaInput, Record<string, unknown>> = {
  name: 'seek_media',
  runningLabel: 'Seeking player…',
  kind: 'action',
  policy: 'client-immediate',
  requiredScopes: ['chat:use'],
  description:
    'Seeks the active Studio media player (video, analysis source video, narration audio, or production cut) to `seconds` and optionally starts playback.',
  parameters: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: 'Timestamp in seconds (>= 0) to seek to.',
      },
      play: {
        type: 'boolean',
        description: 'Optional: whether to immediately start playback after seeking.',
      },
      label: {
        type: 'string',
        description: 'Optional short caption for the timestamp chip.',
      },
    },
    required: ['seconds'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (typeof input.seconds !== 'number' || !Number.isFinite(input.seconds) || input.seconds < 0) {
      return errorOutcome('invalid_seconds', '`seconds` must be a finite number >= 0.');
    }

    const clock = formatClockSeconds(input.seconds) ?? '00:00';
    const chipLabel = input.label?.trim() ? `${clock} · ${input.label.trim()}` : clock;
    const href = ctx.viewContext?.route || '#';

    return {
      modelSummary: {
        seeked: true,
        seconds: input.seconds,
        clock,
        play: input.play ?? null,
      },
      clientAction: {
        kind: 'seek_media',
        seconds: input.seconds,
        ...(typeof input.play === 'boolean' ? { play: input.play } : {}),
      },
      uiParts: [
        {
          kind: 'link-list',
          items: [
            {
              label: chipLabel,
              href,
              kind: 'timestamp',
              seconds: input.seconds,
            },
          ],
        },
      ],
    };
  },
};

export interface PrefillComposerDraftInput {
  draftKind: ComposerDraftKind;
  patch: Record<string, unknown>;
}

const VALID_DRAFT_KINDS = new Set<ComposerDraftKind>(['analysis', 'narration', 'image', 'video', 'music']);

export const prefillComposerDraftTool: ChatToolDefinition<PrefillComposerDraftInput, Record<string, unknown>> = {
  name: 'prefill_composer_draft',
  runningLabel: 'Preparing Studio composer…',
  kind: 'action',
  policy: 'client-immediate',
  requiredScopes: ['chat:use'],
  description:
    'Populates a Studio composer draft (`analysis`, `narration`, `image`, `video`, or `music`) and opens the composer so the user can fine-tune parameters.',
  parameters: {
    type: 'object',
    properties: {
      draftKind: {
        type: 'string',
        enum: ['analysis', 'narration', 'image', 'video', 'music'],
        description: 'Target Studio composer surface.',
      },
      patch: {
        type: 'object',
        description: 'Draft fields to prefill (e.g. `{ prompt, title, aspectRatio, voice }`).',
      },
    },
    required: ['draftKind', 'patch'],
    additionalProperties: false,
  },
  async execute(input) {
    if (!VALID_DRAFT_KINDS.has(input.draftKind)) {
      return errorOutcome(
        'invalid_draft_kind',
        '`draftKind` must be one of: analysis, narration, image, video, music.',
      );
    }
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      return errorOutcome('invalid_patch', '`patch` must be a JSON object.');
    }

    const href = input.draftKind === 'narration' ? '/studio' : `/studio/${input.draftKind}`;
    return {
      modelSummary: {
        prefilled: true,
        draftKind: input.draftKind,
        href,
        fields: Object.keys(input.patch),
      },
      clientAction: {
        kind: 'prefill_draft',
        draftKind: input.draftKind,
        href,
        patch: input.patch,
      },
      uiParts: [
        {
          kind: 'link-list',
          items: [
            {
              label: `Open ${input.draftKind} composer`,
              href,
              kind: 'route',
            },
          ],
        },
      ],
    };
  },
};

// ============================================================================
// 2. Staged-Confirm Tools (`policy: 'staged-confirm'`)
// ============================================================================

export interface AnalyzeVideoInput {
  prompt: string;
  targetItemId?: string;
  videoItemId?: string;
  assetId?: string;
  youtubeUrl?: string;
  mode?: 'static' | 'agentic';
  startSeconds?: number;
  endSeconds?: number;
  fps?: number;
  narrate?: boolean;
  title?: string;
}

export const analyzeVideoTool: ChatToolDefinition<AnalyzeVideoInput, Record<string, unknown>> = {
  name: 'analyze_video',
  runningLabel: 'Staging video analysis…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['analyses:create'],
  slashCommand: 'analyze',
  description:
    'Validates and stages a Studio video analysis job on a Studio video (`videoItemId`), uploaded video (`assetId`), or YouTube URL (`youtubeUrl`), or adds a new version to an existing analysis (`targetItemId`). Defaults to the active video on screen when omitted.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Questions or analysis instructions for Gemini.',
      },
      targetItemId: {
        type: 'string',
        description:
          'Optional existing Studio analysis item ID (or `mdmedia://analysis/<id>`) when adding a new run/version to an existing analysis instead of creating a separate analysis item.',
      },
      videoItemId: {
        type: 'string',
        description: 'Optional Studio video item ID. Defaults to active video when viewing `/video/[id]` or `/analysis/[id]`.',
      },
      assetId: {
        type: 'string',
        description: 'Optional uploaded reference video asset ID.',
      },
      youtubeUrl: {
        type: 'string',
        description: 'Optional YouTube URL to analyze.',
      },
      mode: {
        type: 'string',
        enum: ['static', 'agentic'],
        description: 'Processing mode: "static" (supports clip start/end/fps) or "agentic" (deep multi-pass video inspection).',
      },
      startSeconds: {
        type: 'number',
        description: 'Optional clip start offset in seconds (static mode only).',
      },
      endSeconds: {
        type: 'number',
        description: 'Optional clip end offset in seconds (static mode only).',
      },
      fps: {
        type: 'number',
        description: 'Optional frame sampling rate in frames per second (static mode only).',
      },
      narrate: {
        type: 'boolean',
        description: 'Optional: automatically synthesize narration audio once the analysis completes.',
      },
      title: {
        type: 'string',
        description: 'Optional display title for the analysis.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cleanTargetId = normalizeMediaItemId(input.targetItemId, 'analysis');
    if (input.targetItemId?.trim() && (!cleanTargetId || !validMediaId(cleanTargetId))) {
      return errorOutcome('invalid_target_item', '`targetItemId` must be a valid Studio analysis item ID.');
    }

    let existingAnalysis: Awaited<ReturnType<typeof loadAnalysisItem>> | null = null;
    if (cleanTargetId) {
      if (!hasScope(ctx.caller, 'analyses:read')) {
        return errorOutcome('insufficient_scope', 'This API key cannot analyses read.');
      }
      if (hasConfiguredFirestoreEnv()) {
        try {
          existingAnalysis = await loadAnalysisItem(ctx.caller.uid, cleanTargetId);
        } catch (err) {
          if (err instanceof MediaError) {
            return errorOutcome(err.code, err.message);
          }
        }
      }
    }

    const normalizedVideoId = normalizeMediaItemId(input.videoItemId, 'video');
    let source: Record<string, unknown> | undefined;
    if (normalizedVideoId) {
      source = { kind: 'video', videoItemId: normalizedVideoId };
    } else if (input.assetId?.trim()) {
      source = { kind: 'asset', assetId: input.assetId.trim() };
    } else if (input.youtubeUrl?.trim()) {
      source = { kind: 'youtube', url: input.youtubeUrl.trim() };
    } else if (!existingAnalysis && ctx.viewContext?.surface === 'video' && ctx.viewContext.itemId) {
      source = { kind: 'video', videoItemId: ctx.viewContext.itemId };
    } else if (!existingAnalysis && ctx.viewContext?.surface === 'analysis') {
      if (ctx.viewContext.sourceVideoId) {
        source = { kind: 'video', videoItemId: ctx.viewContext.sourceVideoId };
      } else if (ctx.viewContext.sourceYoutubeUrl) {
        source = { kind: 'youtube', url: ctx.viewContext.sourceYoutubeUrl };
      }
    }

    const hasProcessing =
      input.mode !== undefined ||
      input.startSeconds !== undefined ||
      input.endSeconds !== undefined ||
      input.fps !== undefined;

    const processing = hasProcessing
      ? {
          mode: input.mode ?? 'static',
          ...(input.startSeconds !== undefined ? { startSeconds: input.startSeconds } : {}),
          ...(input.endSeconds !== undefined ? { endSeconds: input.endSeconds } : {}),
          ...(input.fps !== undefined ? { fps: input.fps } : {}),
        }
      : undefined;

    const analysisBody: Record<string, unknown> = {
      prompt: input.prompt,
      ...(source ? { source } : {}),
      ...(processing ? { processing } : {}),
      ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
    };

    try {
      const prepared = await prepareAnalysis(ctx.caller, analysisBody, existingAnalysis);
      const srcSummary =
        prepared.request.source.kind === 'youtube'
          ? 'YouTube'
          : prepared.request.source.kind === 'video'
            ? `Video ${prepared.request.source.videoItemId}`
            : `Asset ${prepared.request.source.assetId}`;
      const modeSummary = prepared.request.processing?.mode ?? 'default';
      const rangeSummary =
        prepared.request.processing?.startSeconds != null || prepared.request.processing?.endSeconds != null
          ? `${formatClockSeconds(prepared.request.processing?.startSeconds ?? 0) ?? '00:00'}–${formatClockSeconds(prepared.request.processing?.endSeconds ?? null) ?? 'end'}`
          : null;
      const meta = [
        cleanTargetId ? 'New version' : null,
        srcSummary,
        modeSummary,
        rangeSummary,
        prepared.narration ? 'with narration' : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const title = cleanTargetId
        ? input.title?.trim() || existingAnalysis?.title || deriveShortTitle(undefined, prepared.request.prompt, 'Video analysis')
        : deriveShortTitle(input.title, prepared.request.prompt, 'Video analysis');
      const targetRoute = cleanTargetId ? `/analysis/${encodeURIComponent(cleanTargetId)}` : '/studio/analysis';
      const revisionTarget: ActionCardRevisionTarget | null = cleanTargetId
        ? {
            itemId: cleanTargetId,
            title: existingAnalysis?.title || title,
            fromGenerationId: existingAnalysis?.latestSuccessfulGenerationId ?? null,
            defaultMode: 'regenerate',
            supportedModes: ['regenerate', 'new_item'],
          }
        : null;

      const draftPatch: Record<string, unknown> = {
        prompt: prepared.request.prompt,
        source: prepared.request.source,
        ...(prepared.request.processing ? { processing: prepared.request.processing } : {}),
        ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      };

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'analyze_video',
        state: 'staged',
        title,
        meta,
        previewMarkdown: prepared.request.prompt.slice(0, 360),
        mediaType: 'analysis',
        ...(cleanTargetId ? { itemId: cleanTargetId } : {}),
        targetRoute,
        ...(revisionTarget ? { revisionTarget } : {}),
        cardActions: [
          {
            kind: 'confirm',
            label: cleanTargetId ? 'Run new version' : 'Run analysis',
            primary: true,
          },
          {
            kind: 'edit-in-studio',
            label: 'Edit in Studio',
            draftKind: 'analysis',
            href: targetRoute,
            patch: draftPatch,
          },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'analyze_video',
          title,
          meta,
          targetItemId: cleanTargetId ?? null,
          deliveryMode: cleanTargetId ? 'regenerate' : 'new_item',
          note: 'Staged for user confirmation on the card below.',
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            analysisBody,
            ...(cleanTargetId ? { targetItemId: cleanTargetId, deliveryMode: 'regenerate' } : { deliveryMode: 'new_item' }),
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          },
          targetRoute,
        },
      };
    } catch (error) {
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface CreateNarrationInput {
  input: string;
  title?: string;
  voice?: string;
  instructions?: string;
}

export const createNarrationTool: ChatToolDefinition<CreateNarrationInput, Record<string, unknown>> = {
  name: 'create_narration',
  runningLabel: 'Staging narration…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['narrations:create'],
  slashCommand: 'narrate',
  description:
    'Validates and stages an audio narration synthesis from Markdown or script text (`input`) using the user’s voice settings.',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Markdown or script text to synthesize into spoken narration.',
      },
      title: {
        type: 'string',
        description: 'Optional narration title.',
      },
      voice: {
        type: 'string',
        description: 'Optional Gemini voice name or ElevenLabs voice ID (defaults to user’s default voice).',
      },
      instructions: {
        type: 'string',
        description: 'Optional rewrite/adaptation instructions.',
      },
    },
    required: ['input'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const settings = hasConfiguredFirestoreEnv()
      ? await loadUserSettings(ctx.caller.uid).catch(() => readSettings(undefined))
      : readSettings(undefined);
    const rawMarkdown = typeof input.input === 'string' ? input.input : '';
    const trimmedTitle = input.title?.trim();
    const markdownWithTitle =
      trimmedTitle && !/^\s{0,3}#\s+/.test(rawMarkdown)
        ? `# ${trimmedTitle}\n\n${rawMarkdown.trimStart()}`
        : rawMarkdown;

    const narrationBody: Record<string, unknown> = {
      markdown: markdownWithTitle,
      ...(input.voice?.trim() ? { voice: input.voice.trim() } : {}),
      ...(input.instructions !== undefined
        ? { instructions: input.instructions, rewriteForNarration: true }
        : {}),
    };

    const resolved = resolveNarrationBody(narrationBody, settings, {
      restricted: ctx.caller.kind === 'apiKey',
    });
    if (!resolved.ok) {
      return errorOutcome(resolved.code, resolved.message);
    }

    const wordCount = rawMarkdown.trim() ? rawMarkdown.trim().split(/\s+/).length : 0;
    const title = deriveShortTitle(trimmedTitle, rawMarkdown, 'Narration');
    const meta = `${resolved.request.voice} · ${wordCount.toLocaleString('en-US')} word${wordCount === 1 ? '' : 's'}`;
    const draftPatch: Record<string, unknown> = {
      markdown: markdownWithTitle,
      voice: resolved.request.voice,
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
    };

    const card: ChatResultPart = {
      kind: 'action-card',
      callId: ctx.callId,
      toolName: 'create_narration',
      state: 'staged',
      title,
      meta,
      previewMarkdown: rawMarkdown.trim().slice(0, 360),
      mediaType: 'narration',
      targetRoute: '/studio',
      cardActions: [
        { kind: 'confirm', label: 'Synthesize', primary: true },
        {
          kind: 'edit-in-studio',
          label: 'Edit in Studio',
          draftKind: 'narration',
          href: '/studio',
          patch: draftPatch,
        },
      ],
    };

    return {
      modelSummary: {
        staged: true,
        callId: ctx.callId,
        toolName: 'create_narration',
        title,
        voice: resolved.request.voice,
        wordCount,
        note: 'Staged for user confirmation on the card below.',
      },
      uiParts: [card],
      stagedPayload: {
        validatedInput: {
          narrationBody,
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
        },
        targetRoute: '/studio',
      },
    };
  },
};

export interface GenerateImageInput {
  prompt: string;
  targetItemId?: string;
  action?: 'initial' | 'refine' | 'regenerate';
  fromGenerationId?: string;
  referenceImageItemIds?: string[];
  aspectRatio?: string;
  model?: string;
  title?: string;
}

export const generateImageTool: ChatToolDefinition<GenerateImageInput, Record<string, unknown>> = {
  name: 'generate_image',
  runningLabel: 'Staging image generation…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['images:create'],
  slashCommand: 'image',
  description:
    'Validates and stages an image generation in Studio—either revising an existing image (`targetItemId` + `action: "refine"`), adding a new version to an existing image (`targetItemId` + `action: "regenerate"`), or creating a separate new image (`action: "initial"`).',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Detailed image prompt, or specific modification instructions when refining an existing image (`action: "refine"`).',
      },
      targetItemId: {
        type: 'string',
        description:
          'Existing Studio image item ID (or `mdmedia://image/<id>`) when revising or adding a new version to an existing image. Omit ONLY when creating a separate new image item.',
      },
      action: {
        type: 'string',
        enum: ['initial', 'refine', 'regenerate'],
        description:
          'Delivery mode: "refine" (default when `targetItemId` is set) edits the image while preserving composition/style from `fromGenerationId`; "regenerate" creates a fresh version on the same `targetItemId` item; "initial" creates a separate new image item.',
      },
      fromGenerationId: {
        type: 'string',
        description:
          'Optional generation ID on `targetItemId` to refine from (defaults to active generation on screen or the item’s latest successful generation).',
      },
      referenceImageItemIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional Studio image item IDs (or `mdmedia://image/<id>` URIs) whose rendered frames should guide generation as visual references.',
      },
      aspectRatio: {
        type: 'string',
        description: 'Optional aspect ratio (e.g. "16:9", "1:1", "9:16", "4:3", "3:4").',
      },
      model: {
        type: 'string',
        description: 'Optional Gemini image model ID.',
      },
      title: {
        type: 'string',
        description: 'Optional display title for the image.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      let cleanTargetId = normalizeMediaItemId(input.targetItemId, 'image');
      if (input.targetItemId?.trim() && (!cleanTargetId || !validMediaId(cleanTargetId))) {
        return errorOutcome('invalid_target_item', '`targetItemId` must be a valid Studio image ID.');
      }
      if (!cleanTargetId && (input.action === 'refine' || input.action === 'regenerate')) {
        if (ctx.viewContext?.surface === 'image' && validMediaId(ctx.viewContext.itemId)) {
          cleanTargetId = ctx.viewContext.itemId;
        } else {
          return errorOutcome(
            'missing_target_item',
            `Pass \`targetItemId\` when \`action\` is "${input.action}".`,
          );
        }
      }

      if (input.fromGenerationId?.trim() && !validMediaId(input.fromGenerationId.trim())) {
        return errorOutcome('invalid_generation', '`fromGenerationId` must be a valid generation ID.');
      }

      let existingItem: Awaited<ReturnType<typeof loadImageItem>> | null = null;
      if (cleanTargetId) {
        if (!hasScope(ctx.caller, 'images:read')) {
          return errorOutcome('insufficient_scope', 'This API key cannot images read.');
        }
        if (hasConfiguredFirestoreEnv()) {
          try {
            existingItem = await loadImageItem(ctx.caller.uid, cleanTargetId);
          } catch (err) {
            if (err instanceof MediaError) {
              return errorOutcome(err.code, err.message);
            }
          }
        }
      }

      const resolvedRefAssetIds: string[] = [];
      const deferredRefImageItemIds: string[] = [];
      if (Array.isArray(input.referenceImageItemIds) && input.referenceImageItemIds.length > 0) {
        if (!hasScope(ctx.caller, 'images:read')) {
          return errorOutcome('insufficient_scope', 'This API key cannot images read.');
        }
        for (const rawRef of input.referenceImageItemIds) {
          const refItemId = normalizeMediaItemId(rawRef, 'image');
          if (!refItemId || !validMediaId(refItemId)) {
            return errorOutcome(
              'invalid_reference_image',
              '`referenceImageItemIds` must contain valid Studio image IDs.',
            );
          }
          if (!hasConfiguredFirestoreEnv()) {
            if (!deferredRefImageItemIds.includes(refItemId)) {
              deferredRefImageItemIds.push(refItemId);
            }
            continue;
          }
          try {
            const refImg = await loadImageItem(ctx.caller.uid, refItemId);
            if (!refImg.thumbnailAssetId) {
              return errorOutcome(
                'image_not_ready',
                `Reference image "${refImg.title || refItemId}" has no finished frame yet.`,
              );
            }
            if (!resolvedRefAssetIds.includes(refImg.thumbnailAssetId)) {
              resolvedRefAssetIds.push(refImg.thumbnailAssetId);
            }
          } catch (err) {
            if (err instanceof MediaError) {
              return errorOutcome(err.code, err.message);
            }
            if (!deferredRefImageItemIds.includes(refItemId)) {
              deferredRefImageItemIds.push(refItemId);
            }
          }
        }
      }

      const userDefaults = hasConfiguredFirestoreEnv()
        ? await imageDefaults(ctx.caller.uid).catch(() => readImageDefaults(undefined))
        : readImageDefaults(undefined);
      const baseDefaults = existingItem?.request
        ? {
            ...existingItem.request,
            referenceAssetId: null,
            referenceAssetIds: [],
          }
        : userDefaults;

      let effectiveMode: StagedMediaDeliveryMode = 'new_item';
      let resolvedFromGenId: string | null = null;
      if (cleanTargetId) {
        const requestedRefine = input.action !== 'regenerate';
        resolvedFromGenId =
          input.fromGenerationId?.trim() ||
          (ctx.viewContext?.surface === 'image' &&
          ctx.viewContext.itemId === cleanTargetId &&
          ctx.viewContext.generationId
            ? ctx.viewContext.generationId
            : null) ||
          existingItem?.latestSuccessfulGenerationId ||
          null;
        if (requestedRefine && (!existingItem || Boolean(resolvedFromGenId))) {
          effectiveMode = 'refine';
        } else {
          effectiveMode = 'regenerate';
        }
      }

      const imageAction =
        effectiveMode === 'refine'
          ? 'refine'
          : effectiveMode === 'regenerate'
            ? 'regenerate'
            : undefined;

      const imageBody: Record<string, unknown> = {
        prompt: input.prompt,
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        ...(input.aspectRatio?.trim() ? { output: { aspectRatio: input.aspectRatio.trim() } } : {}),
        ...(resolvedRefAssetIds.length > 0 ? { referenceAssetIds: resolvedRefAssetIds } : {}),
        ...(imageAction ? { action: imageAction } : {}),
        ...(effectiveMode === 'refine' && resolvedFromGenId
          ? { fromGenerationId: resolvedFromGenId }
          : {}),
      };

      const request = parseImageRequest(imageBody, baseDefaults);
      const effectiveModel = request.model ?? DEFAULT_IMAGE_MODEL;
      const title = cleanTargetId
        ? input.title?.trim() || existingItem?.title || deriveShortTitle(undefined, request.prompt, 'Generated image')
        : deriveShortTitle(input.title, request.prompt, 'Generated image');
      const modeBadge =
        effectiveMode === 'refine'
          ? 'Revision'
          : effectiveMode === 'regenerate'
            ? 'New version'
            : null;
      const refCount = resolvedRefAssetIds.length + deferredRefImageItemIds.length;
      const meta = [
        modeBadge,
        request.output.aspectRatio,
        effectiveModel,
        refCount > 0 ? `${refCount} ref${refCount === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const targetRoute = cleanTargetId
        ? `/image/${encodeURIComponent(cleanTargetId)}`
        : '/studio/image';
      const confirmLabel =
        effectiveMode === 'refine'
          ? 'Generate revision'
          : effectiveMode === 'regenerate'
            ? 'Generate version'
            : 'Generate';

      const revisionTarget: ActionCardRevisionTarget | null = cleanTargetId
        ? {
            itemId: cleanTargetId,
            title: existingItem?.title || title,
            fromGenerationId: resolvedFromGenId,
            defaultMode: effectiveMode,
            supportedModes:
              existingItem && !existingItem.latestSuccessfulGenerationId && !resolvedFromGenId
                ? ['regenerate', 'new_item']
                : ['refine', 'regenerate', 'new_item'],
          }
        : null;

      const draftPatch: Record<string, unknown> = {
        prompt: request.prompt,
        aspectRatio: request.output.aspectRatio,
        model: effectiveModel,
        ...(resolvedRefAssetIds[0] ? { referenceAssetId: resolvedRefAssetIds[0] } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      };

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'generate_image',
        state: 'staged',
        title,
        meta,
        previewMarkdown: request.prompt.slice(0, 360),
        mediaType: 'image',
        ...(cleanTargetId ? { itemId: cleanTargetId } : {}),
        targetRoute,
        ...(revisionTarget ? { revisionTarget } : {}),
        cardActions: [
          { kind: 'confirm', label: confirmLabel, primary: true },
          {
            kind: 'edit-in-studio',
            label: 'Edit in Studio',
            draftKind: 'image',
            href: targetRoute,
            patch: draftPatch,
          },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'generate_image',
          title,
          targetItemId: cleanTargetId ?? null,
          deliveryMode: effectiveMode,
          fromGenerationId: resolvedFromGenId,
          aspectRatio: request.output.aspectRatio,
          model: effectiveModel,
          note: `Staged for user confirmation (${effectiveMode}) on the card below.`,
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            imageBody,
            request: request as unknown as Record<string, unknown>,
            deliveryMode: effectiveMode,
            ...(cleanTargetId ? { targetItemId: cleanTargetId } : {}),
            ...(resolvedFromGenId ? { fromGenerationId: resolvedFromGenId } : {}),
            ...(deferredRefImageItemIds.length > 0
              ? { referenceImageItemIds: deferredRefImageItemIds }
              : {}),
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          },
          targetRoute,
        },
      };
    } catch (error) {
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface GenerateVideoInput {
  prompt: string;
  targetItemId?: string;
  action?: 'initial' | 'continue' | 'regenerate_latest';
  fromGenerationId?: string;
  durationSeconds?: number;
  aspectRatio?: '16:9' | '9:16';
  startImageItemId?: string;
  title?: string;
}

export const generateVideoTool: ChatToolDefinition<GenerateVideoInput, Record<string, unknown>> = {
  name: 'generate_video',
  runningLabel: 'Staging video generation…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['videos:create'],
  slashCommand: 'video',
  description:
    'Validates and stages a Studio video clip generation (3–15s, 16:9 or 9:16)—either extending (`action: "continue"`) or creating a new version (`action: "regenerate_latest"`) on an existing video (`targetItemId`), or creating a separate new video (`action: "initial"`), optionally starting from a Studio image (`startImageItemId`).',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Shot description, camera motion, lighting, and action.',
      },
      targetItemId: {
        type: 'string',
        description:
          'Existing Studio video item ID (or `mdmedia://video/<id>`) when extending or creating a new version of an existing video. Omit when creating a separate new video.',
      },
      action: {
        type: 'string',
        enum: ['initial', 'continue', 'regenerate_latest'],
        description:
          '"continue" appends a continuation clip to `targetItemId`; "regenerate_latest" creates a new version of the latest clip on `targetItemId` (default when `targetItemId` is set); "initial" creates a separate new video.',
      },
      fromGenerationId: {
        type: 'string',
        description: 'Optional current generation ID on `targetItemId` (auto-resolved when omitted).',
      },
      durationSeconds: {
        type: 'number',
        description: 'Optional clip duration in whole seconds (3–15, default 10).',
      },
      aspectRatio: {
        type: 'string',
        enum: ['16:9', '9:16'],
        description: 'Optional aspect ratio ("16:9" landscape or "9:16" portrait).',
      },
      startImageItemId: {
        type: 'string',
        description: 'Optional Studio image item ID (or `mdmedia://image/<id>`) to animate as the first frame.',
      },
      title: {
        type: 'string',
        description: 'Optional display title for the video.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      let cleanTargetId = normalizeMediaItemId(input.targetItemId, 'video');
      if (input.targetItemId?.trim() && (!cleanTargetId || !validMediaId(cleanTargetId))) {
        return errorOutcome('invalid_target_item', '`targetItemId` must be a valid Studio video ID.');
      }
      if (!cleanTargetId && (input.action === 'continue' || input.action === 'regenerate_latest')) {
        if (ctx.viewContext?.surface === 'video' && validMediaId(ctx.viewContext.itemId)) {
          cleanTargetId = ctx.viewContext.itemId;
        } else {
          return errorOutcome(
            'missing_target_item',
            `Pass \`targetItemId\` when \`action\` is "${input.action}".`,
          );
        }
      }

      let existingVideo: Awaited<ReturnType<typeof loadVideoItem>> | null = null;
      if (cleanTargetId) {
        if (!hasScope(ctx.caller, 'videos:read')) {
          return errorOutcome('insufficient_scope', 'This API key cannot videos read.');
        }
        if (hasConfiguredFirestoreEnv()) {
          try {
            existingVideo = await loadVideoItem(ctx.caller.uid, cleanTargetId);
          } catch (err) {
            if (err instanceof MediaError) {
              return errorOutcome(err.code, err.message);
            }
          }
        }
      }

      const userDefaults = hasConfiguredFirestoreEnv()
        ? await videoDefaults(ctx.caller.uid).catch(() => readVideoDefaults(undefined))
        : readVideoDefaults(undefined);
      const baseDefaults = existingVideo?.request
        ? {
            ...existingVideo.request,
            referenceAssetId: null,
            referenceRole: 'reference' as const,
          }
        : userDefaults;

      let referenceAssetId: string | undefined;
      const startImageItemId = normalizeMediaItemId(input.startImageItemId, 'image') ?? undefined;
      if (input.startImageItemId?.trim() && (!startImageItemId || !validMediaId(startImageItemId))) {
        return errorOutcome('invalid_start_image', '`startImageItemId` must be a valid Studio image ID.');
      }

      if (startImageItemId) {
        if (!hasScope(ctx.caller, 'images:read')) {
          return errorOutcome('insufficient_scope', 'This API key cannot images read.');
        }
        if (hasConfiguredFirestoreEnv()) {
          try {
            const imgItem = await loadImageItem(ctx.caller.uid, startImageItemId);
            if (!imgItem.thumbnailAssetId) {
              return errorOutcome('image_not_ready', 'That image has no finished frame to animate yet.');
            }
            referenceAssetId = imgItem.thumbnailAssetId;
          } catch (err) {
            if (err instanceof MediaError) {
              return errorOutcome(err.code, err.message);
            }
          }
        }
      }

      let effectiveMode: StagedMediaDeliveryMode = 'new_item';
      let resolvedFromGenId: string | null = null;
      if (cleanTargetId) {
        resolvedFromGenId =
          input.fromGenerationId?.trim() ||
          existingVideo?.latestSuccessfulGenerationId ||
          existingVideo?.latestGenerationId ||
          (ctx.viewContext?.surface === 'video' &&
          ctx.viewContext.itemId === cleanTargetId &&
          ctx.viewContext.generationId
            ? ctx.viewContext.generationId
            : null);
        if (input.action === 'continue' && (!existingVideo || Boolean(existingVideo.latestSuccessfulGenerationId))) {
          effectiveMode = 'refine';
        } else {
          effectiveMode = 'regenerate';
        }
      }

      // Existing videos with a finished clip have locked shape and resolution in `submitVideo`.
      const lockedAspect =
        cleanTargetId && existingVideo?.latestSuccessfulGenerationId
          ? existingVideo.request.output.aspectRatio
          : input.aspectRatio;
      const outputPatch: Record<string, unknown> = {
        ...(lockedAspect ? { aspectRatio: lockedAspect } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      };

      const isContinuation = effectiveMode === 'refine' && Boolean(cleanTargetId);
      const videoSettingsBody: Record<string, unknown> = {
        prompt: input.prompt,
        ...(Object.keys(outputPatch).length > 0 ? { output: outputPatch } : {}),
        ...(referenceAssetId
          ? {
              referenceAssetId,
              referenceRole: isContinuation ? 'reference' : 'first_frame',
            }
          : {}),
      };

      const request = parseVideoRequest(videoSettingsBody, baseDefaults);
      const title = cleanTargetId
        ? input.title?.trim() || existingVideo?.title || deriveShortTitle(undefined, request.prompt, 'Generated video')
        : deriveShortTitle(input.title, request.prompt, 'Generated video');
      const modeBadge =
        effectiveMode === 'refine'
          ? 'Extend clip'
          : effectiveMode === 'regenerate'
            ? 'New version'
            : null;
      const metaParts = [
        modeBadge,
        `${request.output.durationSeconds}s`,
        request.output.aspectRatio,
        request.output.resolution,
        startImageItemId ? `from image ${startImageItemId}` : null,
      ].filter(Boolean);
      const meta = metaParts.join(' · ');

      const targetRoute = cleanTargetId
        ? `/video/${encodeURIComponent(cleanTargetId)}`
        : '/studio/video';
      const confirmLabel =
        effectiveMode === 'refine'
          ? 'Extend video'
          : effectiveMode === 'regenerate'
            ? 'Generate version'
            : 'Generate';

      const revisionTarget: ActionCardRevisionTarget | null = cleanTargetId
        ? {
            itemId: cleanTargetId,
            title: existingVideo?.title || title,
            fromGenerationId: resolvedFromGenId,
            defaultMode: effectiveMode,
            supportedModes:
              existingVideo && !existingVideo.latestSuccessfulGenerationId
                ? ['regenerate', 'new_item']
                : ['refine', 'regenerate', 'new_item'],
          }
        : null;

      const draftPatch: Record<string, unknown> = {
        prompt: request.prompt,
        durationSeconds: request.output.durationSeconds,
        aspectRatio: request.output.aspectRatio,
        ...(startImageItemId ? { startImageItemId } : {}),
        ...(referenceAssetId
          ? { referenceAssetId, referenceRole: isContinuation ? 'reference' : 'first_frame' }
          : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      };

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'generate_video',
        state: 'staged',
        title,
        meta,
        previewMarkdown: request.prompt.slice(0, 360),
        mediaType: 'video',
        ...(cleanTargetId ? { itemId: cleanTargetId } : {}),
        targetRoute,
        ...(revisionTarget ? { revisionTarget } : {}),
        cardActions: [
          { kind: 'confirm', label: confirmLabel, primary: true },
          {
            kind: 'edit-in-studio',
            label: 'Edit in Studio',
            draftKind: 'video',
            href: targetRoute,
            patch: draftPatch,
          },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'generate_video',
          title,
          targetItemId: cleanTargetId ?? null,
          deliveryMode: effectiveMode,
          durationSeconds: request.output.durationSeconds,
          aspectRatio: request.output.aspectRatio,
          startImageItemId: startImageItemId ?? null,
          note: `Staged for user confirmation (${effectiveMode}) on the card below.`,
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            videoBody: videoSettingsBody,
            deliveryMode: effectiveMode,
            ...(cleanTargetId ? { targetItemId: cleanTargetId } : {}),
            ...(resolvedFromGenId ? { fromGenerationId: resolvedFromGenId } : {}),
            ...(startImageItemId && !referenceAssetId ? { startImageItemId } : {}),
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          },
          targetRoute,
        },
      };
    } catch (error) {
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface GenerateMusicInput {
  prompt: string;
  targetItemId?: string;
  durationSeconds?: number;
  instrumental?: boolean;
  lyrics?: string;
  title?: string;
}

export const generateMusicTool: ChatToolDefinition<GenerateMusicInput, Record<string, unknown>> = {
  name: 'generate_music',
  runningLabel: 'Staging music generation…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['music:create'],
  slashCommand: 'music',
  description:
    'Validates and stages a music track or 30-second instrumental/vocal cue in Studio—either adding a new version to an existing track (`targetItemId`) or creating a separate new track.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Musical style, mood, tempo, and instrumentation.',
      },
      targetItemId: {
        type: 'string',
        description:
          'Optional existing Studio music item ID (or `mdmedia://music/<id>`) when adding a new version to an existing track instead of creating a separate track.',
      },
      durationSeconds: {
        type: 'number',
        description: 'Optional approximate duration in seconds (<= 45 selects a 30s clip; > 45 selects a full song).',
      },
      instrumental: {
        type: 'boolean',
        description: 'Set true for instrumental-only (no vocals), false for sung vocals.',
      },
      lyrics: {
        type: 'string',
        description: 'Optional lyrics to sing (omit when `instrumental` is true).',
      },
      title: {
        type: 'string',
        description: 'Optional display title for the track.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      if (
        input.durationSeconds !== undefined &&
        (typeof input.durationSeconds !== 'number' ||
          !Number.isFinite(input.durationSeconds) ||
          input.durationSeconds <= 0 ||
          input.durationSeconds > 600)
      ) {
        return errorOutcome('invalid_duration', '`durationSeconds` must be between 1 and 600 seconds.');
      }

      const cleanTargetId = normalizeMediaItemId(input.targetItemId, 'music');
      if (input.targetItemId?.trim() && (!cleanTargetId || !validMediaId(cleanTargetId))) {
        return errorOutcome('invalid_target_item', '`targetItemId` must be a valid Studio music ID.');
      }

      let existingMusic: Awaited<ReturnType<typeof loadMusicItem>> | null = null;
      if (cleanTargetId) {
        if (!hasScope(ctx.caller, 'music:read')) {
          return errorOutcome('insufficient_scope', 'This API key cannot music read.');
        }
        if (hasConfiguredFirestoreEnv()) {
          try {
            existingMusic = await loadMusicItem(ctx.caller.uid, cleanTargetId);
          } catch (err) {
            if (err instanceof MediaError) {
              return errorOutcome(err.code, err.message);
            }
          }
        }
      }

      const userDefaults = hasConfiguredFirestoreEnv()
        ? await musicDefaults(ctx.caller.uid).catch(() => readMusicDefaults(undefined))
        : readMusicDefaults(undefined);
      const baseDefaults = existingMusic?.request
        ? { ...existingMusic.request, referenceAssetId: null }
        : userDefaults;

      const mode =
        input.durationSeconds !== undefined
          ? input.durationSeconds <= 45
            ? 'clip'
            : 'song'
          : undefined;
      const vocals =
        input.instrumental === true
          ? 'instrumental'
          : input.instrumental === false || Boolean(input.lyrics?.trim())
            ? 'vocals'
            : undefined;

      const musicBody: Record<string, unknown> = {
        prompt: input.prompt,
        ...(mode ? { output: { mode } } : {}),
        ...(vocals ? { vocals } : {}),
        ...(input.lyrics !== undefined ? { lyrics: input.lyrics } : {}),
      };

      const request = parseMusicRequest(musicBody, baseDefaults);
      const title = cleanTargetId
        ? input.title?.trim() || existingMusic?.title || deriveShortTitle(undefined, request.prompt, 'Generated music')
        : deriveShortTitle(input.title, request.prompt, 'Generated music');
      const modeLabel = request.output.mode === 'clip' ? '30s clip' : 'Full song';
      const meta = [cleanTargetId ? 'New version' : null, modeLabel, request.vocals]
        .filter(Boolean)
        .join(' · ');

      const targetRoute = cleanTargetId
        ? `/music/${encodeURIComponent(cleanTargetId)}`
        : '/studio/music';
      const revisionTarget: ActionCardRevisionTarget | null = cleanTargetId
        ? {
            itemId: cleanTargetId,
            title: existingMusic?.title || title,
            fromGenerationId: existingMusic?.latestSuccessfulGenerationId ?? null,
            defaultMode: 'regenerate',
            supportedModes: ['regenerate', 'new_item'],
          }
        : null;

      const draftPatch: Record<string, unknown> = {
        prompt: request.prompt,
        mode: request.output.mode,
        vocals: request.vocals,
        ...(request.lyrics ? { lyrics: request.lyrics } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      };

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'generate_music',
        state: 'staged',
        title,
        meta,
        previewMarkdown: request.prompt.slice(0, 360),
        mediaType: 'music',
        ...(cleanTargetId ? { itemId: cleanTargetId } : {}),
        targetRoute,
        ...(revisionTarget ? { revisionTarget } : {}),
        cardActions: [
          {
            kind: 'confirm',
            label: cleanTargetId ? 'Generate version' : 'Generate',
            primary: true,
          },
          {
            kind: 'edit-in-studio',
            label: 'Edit in Studio',
            draftKind: 'music',
            href: targetRoute,
            patch: draftPatch,
          },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'generate_music',
          title,
          targetItemId: cleanTargetId ?? null,
          deliveryMode: cleanTargetId ? 'regenerate' : 'new_item',
          mode: request.output.mode,
          vocals: request.vocals,
          note: 'Staged for user confirmation on the card below.',
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            musicBody,
            request: request as unknown as Record<string, unknown>,
            deliveryMode: cleanTargetId ? 'regenerate' : 'new_item',
            ...(cleanTargetId ? { targetItemId: cleanTargetId } : {}),
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          },
          targetRoute,
        },
      };
    } catch (error) {
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface InsertMediaIntoDocumentInput {
  mediaType: ChatMediaType;
  itemId: string;
  generationId?: string;
  title?: string;
  treeId?: string;
  docPath?: string;
  heading?: string;
  mode?: 'append' | 'after-heading';
}

export const insertMediaIntoDocumentTool: ChatToolDefinition<InsertMediaIntoDocumentInput, Record<string, unknown>> = {
  name: 'insert_media_into_document',
  runningLabel: 'Staging media insertion…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['trees:manage'],
  description:
    'Formats a canonical `mdmedia://<type>/<id>` embed/link and stages inserting it into a Markdown tree document (defaulting to the active document on screen).',
  parameters: {
    type: 'object',
    properties: {
      mediaType: {
        type: 'string',
        enum: ['narration', 'video', 'image', 'music', 'sfx', 'analysis'],
        description: 'Media type to embed or link.',
      },
      itemId: {
        type: 'string',
        description: 'Media item ID.',
      },
      generationId: {
        type: 'string',
        description: 'Optional pinned generation ID.',
      },
      title: {
        type: 'string',
        description: 'Alt text or link label for the Markdown reference.',
      },
      treeId: {
        type: 'string',
        description: 'Target tree ID (defaults to active tree when viewing a tree document).',
      },
      docPath: {
        type: 'string',
        description: 'Target document virtual path (defaults to active document path).',
      },
      heading: {
        type: 'string',
        description: 'Optional Markdown heading to insert beneath when `mode` is "after-heading".',
      },
      mode: {
        type: 'string',
        enum: ['append', 'after-heading'],
        description: 'Insertion placement: "append" (end of document) or "after-heading".',
      },
    },
    required: ['mediaType', 'itemId'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!['narration', 'video', 'image', 'music', 'sfx', 'analysis'].includes(input.mediaType)) {
      return errorOutcome('invalid_media_type', 'Unsupported `mediaType`.');
    }
    const itemId = input.itemId?.trim() ?? '';
    if (!validMediaId(itemId)) {
      return errorOutcome('invalid_item_id', 'Provide a valid `itemId`.');
    }
    if (input.generationId !== undefined && input.generationId.trim() && !validMediaId(input.generationId.trim())) {
      return errorOutcome('invalid_generation_id', 'Provide a valid `generationId`.');
    }

    const defaultTreeId = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.treeId : '';
    const defaultDocPath = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.docPath : '';
    const treeId = input.treeId?.trim() || defaultTreeId;
    const docPath = input.docPath?.trim() || defaultDocPath;

    if (!treeId) {
      return errorOutcome('missing_tree_id', 'Provide `treeId` (no tree document is currently open).');
    }
    if (!docPath) {
      return errorOutcome('missing_doc_path', 'Provide `docPath` for the target document.');
    }

    try {
      const store = getServerTreeStore();
      const doc = await store.getDocument(ctx.caller.uid, treeId, docPath);
      const label = input.title?.trim() || `${input.mediaType[0]!.toUpperCase()}${input.mediaType.slice(1)}`;
      const mediaMarkdown = formatMediaMarkdownRef(
        {
          type: input.mediaType,
          id: itemId,
          ...(input.generationId?.trim() ? { generationId: input.generationId.trim() } : {}),
        },
        label,
      );

      const inserted = insertMarkdownSnippetIntoDoc(doc.markdown, mediaMarkdown, {
        mode: input.mode,
        heading: input.heading,
      });
      if (!inserted.ok) {
        return errorOutcome('invalid_insertion', inserted.message);
      }

      validateMarkdownContent(inserted.nextMarkdown);
      const delta = computeLineDelta(doc.markdown, inserted.nextMarkdown);
      const docHref = buildTreeDocHref(doc.treeId, doc.path);
      const cardTitle = `Insert ${input.mediaType} into ${doc.path}`;
      const meta = `${doc.path} · ${delta.summary}`;

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'insert_media_into_document',
        state: 'staged',
        title: cardTitle,
        meta,
        previewMarkdown: inserted.previewSnippet.slice(0, 360),
        targetRoute: docHref,
        cardActions: [
          { kind: 'confirm', label: 'Insert', primary: true },
          { kind: 'open-route', label: 'Open doc', href: docHref },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'insert_media_into_document',
          treeId: doc.treeId,
          path: doc.path,
          mediaMarkdown,
          lineDelta: delta,
          note: 'Staged for user confirmation. The user can click "Insert" on the card to commit.',
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            treeId: doc.treeId,
            path: doc.path,
            nodeId: doc.nodeId,
            title: doc.title,
            mediaMarkdown,
            mode: input.mode ?? (input.heading?.trim() ? 'after-heading' : 'append'),
            ...(input.heading?.trim() ? { heading: input.heading.trim() } : {}),
            nextMarkdown: inserted.nextMarkdown,
            expectedUpdatedAt: doc.updatedAt,
          },
          targetRoute: docHref,
        },
      };
    } catch (error) {
      if (error instanceof TreeOpError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface UpsertTreeDocumentInput {
  treeId?: string;
  path?: string;
  title?: string;
  markdown: string;
  mode?: 'replace' | 'append' | 'replace-section';
  sectionHeading?: string;
}

export const upsertTreeDocumentTool: ChatToolDefinition<UpsertTreeDocumentInput, Record<string, unknown>> = {
  name: 'upsert_tree_document',
  runningLabel: 'Staging document edit…',
  kind: 'action',
  policy: 'staged-confirm',
  requiredScopes: ['trees:manage'],
  slashCommand: 'doc',
  description:
    'Validates and stages creating or updating a Markdown document in a Studio tree (`replace`, `append`, or `replace-section`). Computes line delta without mutating until confirmed.',
  parameters: {
    type: 'object',
    properties: {
      treeId: {
        type: 'string',
        description: 'Tree ID or exact title (defaults to active tree when viewing a tree document).',
      },
      path: {
        type: 'string',
        description: 'Document virtual path, e.g. "notes/launch.md" (defaults to active document path when updating).',
      },
      title: {
        type: 'string',
        description: 'Optional document title.',
      },
      markdown: {
        type: 'string',
        description: 'Markdown content to write, append, or substitute into the target section.',
      },
      mode: {
        type: 'string',
        enum: ['replace', 'append', 'replace-section'],
        description: 'Edit mode: "replace" (default), "append", or "replace-section" (requires `sectionHeading`).',
      },
      sectionHeading: {
        type: 'string',
        description: 'Heading of the section to replace when `mode` is "replace-section".',
      },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (typeof input.markdown !== 'string') {
      return errorOutcome('invalid_markdown', '`markdown` must be a string.');
    }

    const defaultTreeId = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.treeId : '';
    const defaultPath = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.docPath : '';
    const requestedTreeId = input.treeId?.trim() || defaultTreeId;
    const rawPath = input.path?.trim() || defaultPath;

    if (!rawPath) {
      return errorOutcome('missing_path', 'Provide `path` for the Markdown document.');
    }

    try {
      validateMarkdownContent(input.markdown);
      const normalizedPath = normalizeVirtualPath(rawPath);
      const store = getServerTreeStore();

      let resolvedTreeId = requestedTreeId;
      let createTreeTitle: string | null = null;
      let existingDoc: TreeDocument | null = null;

      if (resolvedTreeId) {
        try {
          const tree = await store.getTree(ctx.caller.uid, resolvedTreeId);
          resolvedTreeId = tree.id;
          existingDoc = await store.getDocument(ctx.caller.uid, tree.id, normalizedPath).catch(() => null);
        } catch (err) {
          if (err instanceof TreeOpError && err.code === 'not_found' && input.treeId?.trim()) {
            return errorOutcome(err.code, err.message);
          }
          throw err;
        }
      } else {
        const trees = await store.listTrees(ctx.caller.uid);
        if (trees.length > 0) {
          resolvedTreeId = trees[0]!.id;
          existingDoc = await store
            .getDocument(ctx.caller.uid, resolvedTreeId, normalizedPath)
            .catch(() => null);
        } else {
          createTreeTitle = 'Workspace Notes';
        }
      }

      const canonicalPath = existingDoc?.path ?? normalizedPath;
      const editResult = applyDocumentMarkdownEdit(existingDoc?.markdown ?? null, input.markdown, {
        mode: input.mode,
        sectionHeading: input.sectionHeading,
      });
      if (!editResult.ok) {
        return errorOutcome('invalid_edit', editResult.message);
      }

      validateMarkdownContent(editResult.nextMarkdown);
      const delta = computeLineDelta(existingDoc?.markdown ?? '', editResult.nextMarkdown);
      const docTitle =
        input.title?.trim() ||
        existingDoc?.title ||
        deriveDocTitle(editResult.nextMarkdown, canonicalPath.split('/').pop() || canonicalPath);

      const docHref = resolvedTreeId ? buildTreeDocHref(resolvedTreeId, canonicalPath) : '/trees';
      const actionVerb = existingDoc ? 'Update' : 'Create';
      const cardTitle = `${actionVerb} ${canonicalPath}`;
      const meta = `${existingDoc ? (input.mode ?? 'replace') : 'new doc'} · ${delta.summary}`;

      const card: ChatResultPart = {
        kind: 'action-card',
        callId: ctx.callId,
        toolName: 'upsert_tree_document',
        state: 'staged',
        title: cardTitle,
        meta,
        previewMarkdown: input.markdown.trim().slice(0, 360),
        targetRoute: docHref,
        cardActions: [
          { kind: 'confirm', label: 'Apply edit', primary: true },
          { kind: 'open-route', label: 'Open doc', href: docHref },
        ],
      };

      return {
        modelSummary: {
          staged: true,
          callId: ctx.callId,
          toolName: 'upsert_tree_document',
          treeId: resolvedTreeId || null,
          createTreeTitle,
          path: canonicalPath,
          existed: Boolean(existingDoc),
          lineDelta: delta,
          expectedUpdatedAt: existingDoc?.updatedAt ?? null,
          note: 'Staged for user confirmation. The user can click "Apply edit" on the card to commit.',
        },
        uiParts: [card],
        stagedPayload: {
          validatedInput: {
            ...(resolvedTreeId ? { treeId: resolvedTreeId } : {}),
            ...(createTreeTitle ? { createTreeTitle } : {}),
            path: canonicalPath,
            ...(existingDoc ? { nodeId: existingDoc.nodeId } : {}),
            title: docTitle,
            markdown: input.markdown,
            mode: input.mode ?? 'replace',
            ...(input.sectionHeading?.trim() ? { sectionHeading: input.sectionHeading.trim() } : {}),
            nextMarkdown: editResult.nextMarkdown,
            expectedUpdatedAt: existingDoc?.updatedAt ?? null,
          },
          targetRoute: docHref,
        },
      };
    } catch (error) {
      if (error instanceof TreeOpError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export const ACTION_TOOLS: readonly ChatToolDefinition<any, any>[] = [
  openInStudioTool,
  seekMediaTool,
  prefillComposerDraftTool,
  analyzeVideoTool,
  createNarrationTool,
  generateImageTool,
  generateVideoTool,
  generateMusicTool,
  insertMediaIntoDocumentTool,
  upsertTreeDocumentTool,
];
