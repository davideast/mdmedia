/**
 * Read-only Context Tools (`kind: 'context'`, `policy: 'auto-read'`) for Studio Contextual Chat.
 *
 * Every tool enforces caller scope + `ownerUid` isolation and bounds returned
 * text payloads (default 12,000 chars, max 24,000 chars) with `offset`/`limit`.
 */

import { hasScope, type Caller } from '../../api-auth';
import type { ApiKeyScope } from '../../api-key-token';
import { analysisResource } from '../../analysis-server';
import { loadOwnedAsset } from '../../assets-server';
import {
  CharacterError,
  getCharacter,
  getCharacterVersion,
  listCharacters,
} from '../../characters-server';
import { adminBucket, adminDb } from '../../firebase-admin';
import { MediaError, validMediaId } from '../../image-request';
import { imageResource } from '../../image-server';
import { allowedMediaTypes, listGenerations, listMedia } from '../../media-catalog-server';
import type { MediaType } from '../../media-types';
import { musicResource } from '../../music-server';
import { PlaylistOpError } from '../../playlist-ops';
import { getPlaylist, listPlaylists, resolvePlaylistId } from '../../playlists-server';
import { getProduction, getProductionCut, listProductions, ProductionError } from '../../productions-server';
import { sfxResource } from '../../sfx-server';
import { getStoryboard, listStoryboards } from '../../storyboard-server';
import { walkTreeOrder } from '../../tree-helpers';
import { TreeOpError } from '../../tree-types';
import { getServerTreeStore } from '../../trees-server';
import type { Narration } from '../../types';
import { videoResource } from '../../video-server';
import {
  formatActiveViewPillLabel,
  formatClockSeconds,
  type ActiveViewContext,
  type ChatMediaType,
  type ChatResultPart,
} from '../types';
import type { ChatToolContext, ChatToolDefinition, ChatToolOutcome } from './types';

export const DEFAULT_TEXT_LIMIT = 12_000;
export const MAX_TEXT_LIMIT = 24_000;

export interface ParsedMdmediaUri {
  mediaType: ChatMediaType;
  itemId: string;
  generationId: string | null;
}

const MDMEDIA_URI_RE =
  /^mdmedia:\/\/(narration|video|image|music|sfx|analysis)\/([A-Za-z0-9_-]{1,128})(?:@([A-Za-z0-9_-]{1,128}))?$/;

const EMBEDDED_MDMEDIA_RE =
  /mdmedia:\/\/(narration|video|image|music|sfx|analysis)\/([A-Za-z0-9_-]{1,128})(?:@([A-Za-z0-9_-]{1,128}))?/g;

export function parseMdmediaUri(raw: string): ParsedMdmediaUri | null {
  const match = MDMEDIA_URI_RE.exec(raw.trim());
  if (!match) return null;
  return {
    mediaType: match[1] as ChatMediaType,
    itemId: match[2]!,
    generationId: match[3] ?? null,
  };
}

export function mediaReadScopeForType(mediaType: ChatMediaType): ApiKeyScope {
  switch (mediaType) {
    case 'analysis':
      return 'analyses:read';
    case 'narration':
      return 'narrations:read';
    case 'video':
      return 'videos:read';
    case 'image':
      return 'images:read';
    case 'music':
      return 'music:read';
    case 'sfx':
      return 'sfx:read';
  }
}

export function sliceTextWindow(
  fullText: string,
  rawOffset?: unknown,
  rawLimit?: unknown,
): {
  text: string;
  offset: number;
  limit: number;
  totalChars: number;
  hasMore: boolean;
  nextOffset: number | null;
} {
  const offset =
    typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : 0;
  const requestedLimit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : DEFAULT_TEXT_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_TEXT_LIMIT);
  const totalChars = fullText.length;
  const text = fullText.slice(offset, offset + limit);
  const nextPos = offset + text.length;
  const hasMore = nextPos < totalChars;
  return {
    text,
    offset,
    limit,
    totalChars,
    hasMore,
    nextOffset: hasMore ? nextPos : null,
  };
}

export function extractMarkdownHeadings(markdown: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  const lines = markdown.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      headings.push({
        level: match[1]!.length,
        text: match[2]!.replace(/\s+#+\s*$/, '').trim(),
      });
    }
  }
  return headings;
}

export function extractSectionUnderHeading(markdown: string, targetHeading: string): string | null {
  const normalizedTarget = targetHeading
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^§\s*/, '')
    .toLowerCase();
  if (!normalizedTarget) return markdown;

  const lines = markdown.split('\n');
  let inFence = false;
  let startIdx = -1;
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
    const cleanText = match[2]!.replace(/\s+#+\s*$/, '').replace(/[*_`~]/g, '').trim().toLowerCase();
    if (startIdx === -1) {
      if (cleanText === normalizedTarget || cleanText.includes(normalizedTarget)) {
        startIdx = i;
        targetLevel = level;
      }
    } else if (level <= targetLevel) {
      return lines.slice(startIdx, i).join('\n').trim();
    }
  }

  if (startIdx === -1) return null;
  return lines.slice(startIdx).join('\n').trim();
}

export function extractEmbeddedMdmediaRefs(markdown: string): ParsedMdmediaUri[] {
  const seen = new Set<string>();
  const results: ParsedMdmediaUri[] = [];
  let match: RegExpExecArray | null;
  EMBEDDED_MDMEDIA_RE.lastIndex = 0;
  while ((match = EMBEDDED_MDMEDIA_RE.exec(markdown)) !== null) {
    const mediaType = match[1] as ChatMediaType;
    const itemId = match[2]!;
    const generationId = match[3] ?? null;
    const key = `${mediaType}:${itemId}:${generationId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ mediaType, itemId, generationId });
  }
  return results;
}

function errorOutcome(code: string, message: string): ChatToolOutcome<Record<string, unknown>> {
  return {
    isError: true,
    modelSummary: { error: code, message },
  };
}

async function defaultLoadOwnedNarration(uid: string, itemId: string): Promise<Narration> {
  if (!validMediaId(itemId)) {
    throw new MediaError(404, 'not_found', 'That narration is not available to you.');
  }
  const snap = await adminDb().collection('narrations').doc(itemId).get();
  const data = snap.data() as Narration | undefined;
  if (!snap.exists || !data || data.ownerUid !== uid) {
    throw new MediaError(404, 'not_found', 'That narration is not available to you.');
  }
  return { ...data, id: snap.id };
}

async function defaultLoadAnalysisAnswerText(
  uid: string,
  generationId: string | null | undefined,
  fallbackPreview?: string,
): Promise<string> {
  if (generationId) {
    try {
      const asset = await loadOwnedAsset(uid, `analysis_${generationId}`);
      const [bytes] = await adminBucket().file(asset.path).download();
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // Fall back to direct generationId lookup or preview when storage is absent
    }
  }
  return fallbackPreview ?? '';
}

export interface ChatMediaReaderDeps {
  analysisResource: typeof analysisResource;
  loadAnalysisAnswerText: typeof defaultLoadAnalysisAnswerText;
  loadOwnedNarration: typeof defaultLoadOwnedNarration;
  videoResource: typeof videoResource;
  imageResource: typeof imageResource;
  musicResource: typeof musicResource;
  sfxResource: typeof sfxResource;
  listMedia: typeof listMedia;
  listGenerations: typeof listGenerations;
  getProduction: typeof getProduction;
  listProductions: typeof listProductions;
  getStoryboard: typeof getStoryboard;
  listStoryboards: typeof listStoryboards;
  getCharacter: typeof getCharacter;
  getCharacterVersion: typeof getCharacterVersion;
  listCharacters: typeof listCharacters;
  getPlaylist: typeof getPlaylist;
  listPlaylists: typeof listPlaylists;
  resolvePlaylistId: typeof resolvePlaylistId;
}

const DEFAULT_MEDIA_READER_DEPS: ChatMediaReaderDeps = {
  analysisResource,
  loadAnalysisAnswerText: defaultLoadAnalysisAnswerText,
  loadOwnedNarration: defaultLoadOwnedNarration,
  videoResource,
  imageResource,
  musicResource,
  sfxResource,
  listMedia,
  listGenerations,
  getProduction,
  listProductions,
  getStoryboard,
  listStoryboards,
  getCharacter,
  getCharacterVersion,
  listCharacters,
  getPlaylist,
  listPlaylists,
  resolvePlaylistId,
};

let mediaReaderDepsOverride: Partial<ChatMediaReaderDeps> | null = null;

export function setChatMediaReaderDepsForTests(deps: Partial<ChatMediaReaderDeps> | null): void {
  mediaReaderDepsOverride = deps;
}

function mediaDeps(): ChatMediaReaderDeps {
  return mediaReaderDepsOverride
    ? { ...DEFAULT_MEDIA_READER_DEPS, ...mediaReaderDepsOverride }
    : DEFAULT_MEDIA_READER_DEPS;
}

async function buildFocusedItemDetails(caller: Caller, ctx: ChatToolContext): Promise<Record<string, unknown> | null> {
  const view = ctx.viewContext;
  if (!view) return null;
  const deps = mediaDeps();

  try {
    switch (view.surface) {
      case 'analysis': {
        if (!hasScope(caller, 'analyses:read')) return null;
        const res = await deps.analysisResource(caller.uid, view.itemId, ctx.origin);
        return {
          type: 'analysis',
          id: res.id,
          title: res.title,
          status: res.status,
          source: res.request.source,
          model: res.latestGeneration.model,
          narrationId: res.result?.narrationId ?? res.latestGeneration.narrationId,
          sourcePreview: res.sourcePreview ?? null,
        };
      }
      case 'video': {
        if (!hasScope(caller, 'videos:read')) return null;
        const res = await deps.videoResource(caller.uid, view.itemId, ctx.origin);
        return {
          type: 'video',
          id: res.id,
          title: res.title,
          status: res.status,
          durationMs: res.durationMs ?? null,
          aspectRatio: res.request.output.aspectRatio,
          resolution: res.request.output.resolution,
          clipCount: res.clips.length,
          canContinue: res.canContinue,
        };
      }
      case 'image': {
        if (!hasScope(caller, 'images:read')) return null;
        const res = await deps.imageResource(caller.uid, view.itemId, ctx.origin);
        return {
          type: 'image',
          id: res.id,
          title: res.title,
          status: res.status,
          model: res.latestGeneration?.model ?? null,
          aspectRatio: res.request.output.aspectRatio,
          resolution: res.request.output.resolution,
        };
      }
      case 'music': {
        if (!hasScope(caller, 'music:read')) return null;
        const res = await deps.musicResource(caller.uid, view.itemId, ctx.origin);
        return {
          type: 'music',
          id: res.id,
          title: res.title,
          status: res.status,
          durationMs: res.durationMs ?? null,
          mode: res.request.output.mode,
          vocals: res.request.vocals,
        };
      }
      case 'narration': {
        if (!hasScope(caller, 'narrations:read')) return null;
        const narration = await deps.loadOwnedNarration(caller.uid, view.itemId);
        return {
          type: 'narration',
          id: narration.id,
          title: narration.title,
          status: narration.status,
          voice: narration.voice,
          durationMs: narration.durationMs,
          adapted: narration.adapted,
          charCount: (narration.transcript || narration.sourceMarkdown || '').length,
        };
      }
      case 'tree-doc': {
        if (!hasScope(caller, 'trees:manage')) return null;
        const store = getServerTreeStore();
        const tree = await store.getTree(caller.uid, view.treeId);
        let docMeta: Record<string, unknown> | null = null;
        if (view.docPath) {
          const doc = await store.getDocument(caller.uid, tree.id, view.docPath).catch(() => null);
          if (doc) {
            docMeta = {
              docId: doc.id,
              nodeId: doc.nodeId,
              path: doc.path,
              title: doc.title,
              charCount: doc.markdown.length,
              headings: extractMarkdownHeadings(doc.markdown).slice(0, 30),
              narrationId: doc.narrationId,
              narrationStatus: doc.narrationStatus,
              updatedAt: doc.updatedAt,
            };
          }
        }
        return {
          type: 'tree-doc',
          treeId: tree.id,
          treeTitle: tree.title,
          docCount: tree.docCount,
          revision: tree.revision,
          document: docMeta,
        };
      }
      case 'cut': {
        if (!hasScope(caller, 'productions:read')) return null;
        const prod = await getProduction(caller.uid, view.productionId, ctx.origin);
        const cut = await getProductionCut(caller.uid, view.productionId, view.cutId, ctx.origin).catch(() => null);
        return {
          type: 'cut',
          productionId: prod.id,
          productionTitle: prod.title,
          cutId: view.cutId,
          cutLabel: cut?.label ?? view.title,
          status: cut?.status ?? null,
          lengthSeconds: cut?.lengthSeconds ?? null,
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export const getActiveViewContextTool: ChatToolDefinition<Record<string, unknown>, Record<string, unknown>> = {
  name: 'get_active_view_context',
  runningLabel: 'Inspecting active view…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['chat:use'],
  slashCommand: 'context',
  description:
    'Returns the normalized ActiveViewContext currently open on the user’s Studio screen plus enriched metadata (headings, duration, source video, or draft state) when permitted by scope.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx) {
    const pillLabel = formatActiveViewPillLabel(ctx.viewContext);
    const focusedItem = await buildFocusedItemDetails(ctx.caller, ctx);
    return {
      modelSummary: {
        activeView: ctx.viewContext,
        pillLabel,
        focusedItem,
      },
    };
  },
};

export interface ReadMediaItemInput {
  uri?: string;
  mediaType?: ChatMediaType;
  itemId?: string;
  offset?: number;
  limit?: number;
}

/**
 * Returns `true` when `mediaType` + `itemId` refers to the item already open in
 * the middle Studio panel so chat tools can return full content to the model
 * without echoing a redundant `ChatMediaEmbed` player card.
 */
export function isItemAlreadyOpenInView(
  viewContext: ActiveViewContext | null | undefined,
  mediaType: ChatMediaType,
  itemId: string,
  activeTreeNarrationId?: string | null,
): boolean {
  if (!viewContext || !itemId) return false;
  if (
    (viewContext.surface === 'narration' ||
      viewContext.surface === 'analysis' ||
      viewContext.surface === 'video' ||
      viewContext.surface === 'image' ||
      viewContext.surface === 'music') &&
    viewContext.surface === mediaType &&
    viewContext.itemId === itemId
  ) {
    return true;
  }
  if (
    mediaType === 'video' &&
    viewContext.surface === 'analysis' &&
    Boolean(viewContext.sourceVideoId) &&
    viewContext.sourceVideoId === itemId
  ) {
    return true;
  }
  if (
    mediaType === 'narration' &&
    Boolean(activeTreeNarrationId) &&
    activeTreeNarrationId === itemId
  ) {
    return true;
  }
  return false;
}

export const readMediaItemTool: ChatToolDefinition<ReadMediaItemInput, Record<string, unknown>> = {
  name: 'read_media_item',
  runningLabel: 'Reading media item…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['chat:use'],
  description:
    'Reads a Studio media item by `mdmedia://<type>/<id>` URI or `{ mediaType, itemId }`, returning metadata, transcripts or video analysis markdown (paginated via `offset` and `limit`), and an inline media embed.',
  parameters: {
    type: 'object',
    properties: {
      uri: {
        type: 'string',
        description: 'Canonical mdmedia URI, e.g. "mdmedia://analysis/abc123" or "mdmedia://narration/xyz".',
      },
      mediaType: {
        type: 'string',
        enum: ['narration', 'video', 'image', 'music', 'sfx', 'analysis'],
        description: 'Media type if `uri` is not provided.',
      },
      itemId: {
        type: 'string',
        description: 'Item ID if `uri` is not provided.',
      },
      offset: {
        type: 'number',
        description: 'Character offset for reading transcripts or analysis answers (default 0).',
      },
      limit: {
        type: 'number',
        description: 'Maximum characters to return (default 12000, max 24000).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    let mediaType: ChatMediaType | undefined = input.mediaType;
    let itemId: string | undefined = input.itemId?.trim();

    if (typeof input.uri === 'string' && input.uri.trim()) {
      const parsed = parseMdmediaUri(input.uri);
      if (!parsed) {
        return errorOutcome(
          'invalid_uri',
          'URI must match mdmedia://<narration|video|image|music|sfx|analysis>/<id>.',
        );
      }
      mediaType = parsed.mediaType;
      itemId = parsed.itemId;
    }

    if (!mediaType || !['narration', 'video', 'image', 'music', 'sfx', 'analysis'].includes(mediaType)) {
      return errorOutcome('invalid_media_type', 'Provide a valid `uri` or `mediaType` + `itemId`.');
    }
    if (!itemId || !validMediaId(itemId)) {
      return errorOutcome('invalid_item_id', 'Provide a valid `itemId`.');
    }

    const neededScope = mediaReadScopeForType(mediaType);
    if (!hasScope(ctx.caller, neededScope)) {
      return errorOutcome('insufficient_scope', `This API key cannot ${neededScope.replace(':', ' ')}.`);
    }

    const deps = mediaDeps();
    let activeTreeNarrationId: string | null = null;
    if (mediaType === 'narration' && ctx.viewContext?.surface === 'tree-doc') {
      activeTreeNarrationId = await getServerTreeStore()
        .getDocument(ctx.caller.uid, ctx.viewContext.treeId, ctx.viewContext.docPath)
        .then((doc) => doc.narrationId ?? null)
        .catch(() => null);
    }

    try {
      switch (mediaType) {
        case 'narration': {
          const narration = await deps.loadOwnedNarration(ctx.caller.uid, itemId);
          const bodyText = narration.transcript || narration.sourceMarkdown || '';
          const slice = sliceTextWindow(bodyText, input.offset, input.limit);
          const durationClock = formatClockSeconds(narration.durationMs ? narration.durationMs / 1000 : null);
          const subtitle = [durationClock, narration.voice].filter(Boolean).join(' · ') || undefined;
          const suppressEmbed = isItemAlreadyOpenInView(
            ctx.viewContext,
            'narration',
            narration.id,
            activeTreeNarrationId,
          );
          const uiParts: ChatResultPart[] = [
            {
              kind: 'media-embed',
              mediaType: 'narration',
              itemId: narration.id,
              title: narration.title,
              subtitle,
            },
          ];
          return {
            modelSummary: {
              uri: `mdmedia://narration/${narration.id}`,
              mediaType: 'narration',
              id: narration.id,
              title: narration.title,
              status: narration.status,
              voice: narration.voice,
              durationMs: narration.durationMs,
              adapted: narration.adapted,
              content: slice.text,
              offset: slice.offset,
              limit: slice.limit,
              totalChars: slice.totalChars,
              hasMore: slice.hasMore,
              nextOffset: slice.nextOffset,
            },
            ...(!suppressEmbed ? { uiParts } : {}),
          };
        }
        case 'analysis': {
          const res = await deps.analysisResource(ctx.caller.uid, itemId, ctx.origin);
          const targetGenId = res.result?.id ?? res.latestSuccessfulGenerationId ?? res.latestGenerationId;
          const fullAnswer = await deps.loadAnalysisAnswerText(ctx.caller.uid, targetGenId, res.sourcePreview);
          const slice = sliceTextWindow(fullAnswer, input.offset, input.limit);
          const sourceLabel =
            res.request.source.kind === 'youtube'
              ? 'YouTube'
              : res.request.source.kind === 'video'
                ? `Video ${res.request.source.videoItemId}`
                : `Asset ${res.request.source.assetId}`;
          const suppressEmbed = isItemAlreadyOpenInView(ctx.viewContext, 'analysis', res.id);
          const uiParts: ChatResultPart[] = [
            {
              kind: 'media-embed',
              mediaType: 'analysis',
              itemId: res.id,
              generationId: targetGenId,
              title: res.title,
              subtitle: `${sourceLabel} · ${res.status}`,
              excerptMarkdown: fullAnswer ? fullAnswer.slice(0, 360) : res.sourcePreview,
            },
          ];
          return {
            modelSummary: {
              uri: `mdmedia://analysis/${res.id}`,
              mediaType: 'analysis',
              id: res.id,
              title: res.title,
              status: res.status,
              source: res.request.source,
              prompt: res.request.prompt,
              model: res.latestGeneration.model,
              narrationId: res.result?.narrationId ?? res.latestGeneration.narrationId,
              answer: slice.text,
              offset: slice.offset,
              limit: slice.limit,
              totalChars: slice.totalChars,
              hasMore: slice.hasMore,
              nextOffset: slice.nextOffset,
            },
            ...(!suppressEmbed ? { uiParts } : {}),
          };
        }
        case 'video': {
          const res = await deps.videoResource(ctx.caller.uid, itemId, ctx.origin);
          const durationClock = formatClockSeconds(res.durationMs ? res.durationMs / 1000 : null);
          const subtitle = [durationClock, res.request.output.aspectRatio, res.latestGeneration.model]
            .filter(Boolean)
            .join(' · ');
          const suppressEmbed = isItemAlreadyOpenInView(ctx.viewContext, 'video', res.id);
          return {
            modelSummary: {
              uri: `mdmedia://video/${res.id}`,
              mediaType: 'video',
              id: res.id,
              title: res.title,
              status: res.status,
              durationMs: res.durationMs ?? null,
              prompt: res.request.prompt,
              output: res.request.output,
              model: res.latestGeneration.model,
              clipCount: res.clips.length,
              canContinue: res.canContinue,
            },
            ...(!suppressEmbed
              ? {
                  uiParts: [
                    {
                      kind: 'media-embed',
                      mediaType: 'video',
                      itemId: res.id,
                      generationId: res.result?.id ?? res.latestGenerationId,
                      title: res.title,
                      subtitle: subtitle || undefined,
                    },
                  ],
                }
              : {}),
          };
        }
        case 'image': {
          const res = await deps.imageResource(ctx.caller.uid, itemId, ctx.origin);
          const subtitle = [res.request.output.aspectRatio, res.latestGeneration?.model].filter(Boolean).join(' · ');
          const suppressEmbed = isItemAlreadyOpenInView(ctx.viewContext, 'image', res.id);
          return {
            modelSummary: {
              uri: `mdmedia://image/${res.id}`,
              mediaType: 'image',
              id: res.id,
              title: res.title,
              status: res.status,
              prompt: res.request.prompt,
              output: res.request.output,
              model: res.latestGeneration?.model ?? null,
            },
            ...(!suppressEmbed
              ? {
                  uiParts: [
                    {
                      kind: 'media-embed',
                      mediaType: 'image',
                      itemId: res.id,
                      generationId: res.result?.id ?? res.latestGenerationId,
                      title: res.title,
                      subtitle: subtitle || undefined,
                    },
                  ],
                }
              : {}),
          };
        }
        case 'music': {
          const res = await deps.musicResource(ctx.caller.uid, itemId, ctx.origin);
          const durationClock = formatClockSeconds(res.durationMs ? res.durationMs / 1000 : null);
          const subtitle = [durationClock, res.request.vocals, res.latestGeneration.model].filter(Boolean).join(' · ');
          const lyrics = res.result?.lyrics ?? res.latestGeneration.lyrics ?? res.request.lyrics ?? '';
          const lyricsSlice = sliceTextWindow(lyrics, input.offset, input.limit);
          const suppressEmbed = isItemAlreadyOpenInView(ctx.viewContext, 'music', res.id);
          return {
            modelSummary: {
              uri: `mdmedia://music/${res.id}`,
              mediaType: 'music',
              id: res.id,
              title: res.title,
              status: res.status,
              durationMs: res.durationMs ?? null,
              prompt: res.request.prompt,
              output: res.request.output,
              vocals: res.request.vocals,
              lyrics: lyricsSlice.text,
              model: res.latestGeneration.model,
            },
            ...(!suppressEmbed
              ? {
                  uiParts: [
                    {
                      kind: 'media-embed',
                      mediaType: 'music',
                      itemId: res.id,
                      generationId: res.result?.id ?? res.latestGenerationId,
                      title: res.title,
                      subtitle: subtitle || undefined,
                    },
                  ],
                }
              : {}),
          };
        }
        case 'sfx': {
          const res = await deps.sfxResource(ctx.caller.uid, itemId, ctx.origin);
          const durationClock = formatClockSeconds(res.durationMs ? res.durationMs / 1000 : null);
          const suppressEmbed = isItemAlreadyOpenInView(ctx.viewContext, 'sfx', res.id);
          return {
            modelSummary: {
              uri: `mdmedia://sfx/${res.id}`,
              mediaType: 'sfx',
              id: res.id,
              title: res.title,
              status: res.status,
              durationMs: res.durationMs ?? null,
              prompt: res.request.prompt,
              model: res.latestGeneration.model,
            },
            ...(!suppressEmbed
              ? {
                  uiParts: [
                    {
                      kind: 'media-embed',
                      mediaType: 'sfx',
                      itemId: res.id,
                      generationId: res.result?.id ?? res.latestGenerationId,
                      title: res.title,
                      subtitle: durationClock ?? 'Sound effect',
                    },
                  ],
                }
              : {}),
          };
        }
      }
    } catch (error) {
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface SearchLibraryInput {
  query?: string;
  type?: ChatMediaType;
  status?: string;
  limit?: number;
}

function normalizeStatusFilter(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'succeeded' || s === 'complete' || s === 'completed') return 'ready';
  if (s === 'running' || s === 'streaming') return 'generating';
  if (s === 'failed') return 'error';
  return s;
}

export const searchLibraryTool: ChatToolDefinition<SearchLibraryInput, Record<string, unknown>> = {
  name: 'search_library',
  runningLabel: 'Searching library…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['chat:use'],
  slashCommand: 'find',
  description:
    'Searches the user’s Studio media library across narrations, videos, images, music, sound effects, and analyses by query, type, and status (max 20 results).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional search keywords matched against title and prompt/source preview.',
      },
      type: {
        type: 'string',
        enum: ['narration', 'video', 'image', 'music', 'sfx', 'analysis'],
        description: 'Optional media type filter.',
      },
      status: {
        type: 'string',
        description: 'Optional status filter (e.g. "ready", "generating", "queued", "error").',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 10, max 20).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const allowed = allowedMediaTypes(ctx.caller);
    if (input.type && !allowed.includes(input.type as MediaType)) {
      const scope = mediaReadScopeForType(input.type);
      return errorOutcome('insufficient_scope', `This API key cannot ${scope.replace(':', ' ')}.`);
    }
    if (allowed.length === 0) {
      return errorOutcome('insufficient_scope', 'This API key has no media read scopes.');
    }

    const cap = Math.min(Math.max(typeof input.limit === 'number' ? Math.floor(input.limit) : 10, 1), 20);
    const q = (input.query ?? '').trim().slice(0, 200);
    const statusFilter = normalizeStatusFilter(input.status);

    const url = new URL('/api/v1/media', ctx.origin);
    if (q) url.searchParams.set('q', q);
    if (input.type) url.searchParams.set('type', input.type);

    const catalog = await mediaDeps().listMedia(ctx.caller, url);
    const qLower = q.toLowerCase();
    const filtered = catalog.items
      .filter((item) => {
        if (statusFilter && item.status !== statusFilter) return false;
        if (!qLower) return true;
        const hay = `${item.title} ${item.sourcePreview ?? ''} ${item.id}`.toLowerCase();
        return hay.includes(qLower) || qLower.split(/\s+/).every((tok) => hay.includes(tok));
      })
      .slice(0, cap);

    const readyTop = filtered
      .filter(
        (item) =>
          item.status === 'ready' &&
          !isItemAlreadyOpenInView(ctx.viewContext, item.type as ChatMediaType, item.id),
      )
      .slice(0, 4);
    const uiParts: ChatResultPart[] = readyTop.map((item) => {
      const clock = formatClockSeconds(item.durationMs ? item.durationMs / 1000 : null);
      return {
        kind: 'media-embed',
        mediaType: item.type as ChatMediaType,
        itemId: item.id,
        title: item.title,
        subtitle: clock ?? item.type,
      };
    });

    const embeddedIds = new Set(readyTop.map((i) => `${i.type}:${i.id}`));
    const remainder = filtered.filter((i) => !embeddedIds.has(`${i.type}:${i.id}`));
    if (remainder.length > 0) {
      uiParts.push({
        kind: 'link-list',
        items: remainder.map((item) => ({
          label: item.title,
          href: item.href || `/${item.type}/${item.id}`,
          kind: 'media' as const,
          mediaType: item.type as ChatMediaType,
        })),
      });
    }

    return {
      modelSummary: {
        count: filtered.length,
        indexing: catalog.indexing,
        items: filtered.map((item) => ({
          uri: `mdmedia://${item.type}/${item.id}`,
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          href: item.href,
          durationMs: item.durationMs ?? null,
          updatedAt: item.updatedAt,
        })),
      },
      ...(uiParts.length > 0 ? { uiParts } : {}),
    };
  },
};

export interface ReadTreeInput {
  treeId?: string;
}

export const readTreeTool: ChatToolDefinition<ReadTreeInput, Record<string, unknown>> = {
  name: 'read_tree',
  runningLabel: 'Reading workspace tree…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['trees:manage'],
  description:
    'Lists all document trees owned by the user (when `treeId` is omitted and no tree is active) or reads the hierarchical folder/document structure of a specific tree.',
  parameters: {
    type: 'object',
    properties: {
      treeId: {
        type: 'string',
        description: 'Tree ID or exact tree title. Defaults to the active tree if viewing a tree document.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const store = getServerTreeStore();
    const effectiveTreeId =
      input.treeId?.trim() ||
      (ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.treeId : '');

    try {
      if (!effectiveTreeId) {
        const trees = await store.listTrees(ctx.caller.uid);
        return {
          modelSummary: {
            mode: 'list',
            count: trees.length,
            trees: trees.slice(0, 50).map((t) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              docCount: t.docCount,
              nodeCount: t.nodeCount,
              updatedAt: t.updatedAt,
            })),
          },
        };
      }

      const detail = await store.getTree(ctx.caller.uid, effectiveTreeId);
      const selectedSet = new Set(detail.selectedNodeIds);
      const orderedNodes = walkTreeOrder(detail.rootIds, detail.nodes).map((node) => ({
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.path,
        parentId: node.parentId,
        narrationId: node.narrationId,
        narrationStatus: node.narrationStatus,
        selected: selectedSet.has(node.id),
      }));

      return {
        modelSummary: {
          mode: 'detail',
          id: detail.id,
          title: detail.title,
          description: detail.description,
          revision: detail.revision,
          docCount: detail.docCount,
          nodeCount: detail.nodeCount,
          nodes: orderedNodes.slice(0, 300),
          truncatedNodes: orderedNodes.length > 300,
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

export interface ReadTreeDocumentInput {
  treeId?: string;
  path?: string;
  heading?: string;
  offset?: number;
  limit?: number;
}

export const readTreeDocumentTool: ChatToolDefinition<ReadTreeDocumentInput, Record<string, unknown>> = {
  name: 'read_tree_document',
  runningLabel: 'Reading document…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['trees:manage'],
  description:
    'Reads a Markdown document from a Studio tree by `{ treeId, path }`, defaulting to the active document on screen. Supports extracting a specific `heading` section and paginating via `offset` and `limit`.',
  parameters: {
    type: 'object',
    properties: {
      treeId: {
        type: 'string',
        description: 'Tree ID or title (defaults to active tree when viewing a tree document).',
      },
      path: {
        type: 'string',
        description: 'Document virtual path or node ID (defaults to active document path).',
      },
      heading: {
        type: 'string',
        description: 'Optional Markdown heading title to extract just that section.',
      },
      offset: {
        type: 'number',
        description: 'Character offset for pagination (default 0).',
      },
      limit: {
        type: 'number',
        description: 'Maximum characters to return (default 12000, max 24000).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const defaultTreeId = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.treeId : '';
    const defaultPath = ctx.viewContext?.surface === 'tree-doc' ? ctx.viewContext.docPath : '';
    const treeId = input.treeId?.trim() || defaultTreeId;
    const docPath = input.path?.trim() || defaultPath;

    if (!treeId) {
      return errorOutcome('missing_tree_id', 'Provide `treeId` (no tree document is currently open).');
    }
    if (!docPath) {
      return errorOutcome('missing_path', 'Provide `path` for the tree document to read.');
    }

    try {
      const store = getServerTreeStore();
      const doc = await store.getDocument(ctx.caller.uid, treeId, docPath);
      const mediaRefs = extractEmbeddedMdmediaRefs(doc.markdown);
      const headings = extractMarkdownHeadings(doc.markdown);

      let targetMarkdown = doc.markdown;
      if (input.heading?.trim()) {
        const extracted = extractSectionUnderHeading(doc.markdown, input.heading);
        if (extracted === null) {
          return errorOutcome(
            'heading_not_found',
            `Heading "${input.heading}" was not found in "${doc.path}". Available headings: ${headings.map((h) => h.text).join(', ') || 'none'}.`,
          );
        }
        targetMarkdown = extracted;
      }

      const slice = sliceTextWindow(targetMarkdown, input.offset, input.limit);
      return {
        modelSummary: {
          treeId: doc.treeId,
          docId: doc.id,
          nodeId: doc.nodeId,
          path: doc.path,
          title: doc.title,
          heading: input.heading?.trim() || null,
          content: slice.text,
          offset: slice.offset,
          limit: slice.limit,
          totalChars: slice.totalChars,
          hasMore: slice.hasMore,
          nextOffset: slice.nextOffset,
          headings: headings.slice(0, 50),
          mediaRefs: mediaRefs.map((ref) => ({
            uri: `mdmedia://${ref.mediaType}/${ref.itemId}${ref.generationId ? `@${ref.generationId}` : ''}`,
            mediaType: ref.mediaType,
            itemId: ref.itemId,
            generationId: ref.generationId,
          })),
          narrationId: doc.narrationId,
          narrationStatus: doc.narrationStatus,
          updatedAt: doc.updatedAt,
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

export interface ReadProductionCutInput {
  productionId?: string;
  cutId?: string;
}

export const readProductionCutTool: ChatToolDefinition<ReadProductionCutInput, Record<string, unknown>> = {
  name: 'read_production_cut',
  runningLabel: 'Reading production cut…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['productions:read'],
  description:
    'Reads a production and its cut timeline, scenes, and review notes (defaulting to the active cut when viewing a cut in Studio).',
  parameters: {
    type: 'object',
    properties: {
      productionId: {
        type: 'string',
        description: 'Production ID (defaults to active production when on a cut view).',
      },
      cutId: {
        type: 'string',
        description: 'Cut ID (defaults to active cut or production’s current cut).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const defaultProdId = ctx.viewContext?.surface === 'cut' ? ctx.viewContext.productionId : '';
    const defaultCutId = ctx.viewContext?.surface === 'cut' ? ctx.viewContext.cutId : '';
    const productionId = input.productionId?.trim() || defaultProdId;

    try {
      if (!productionId) {
        const list = await listProductions(ctx.caller.uid, ctx.origin);
        return {
          modelSummary: {
            mode: 'list',
            productions: list.productions.slice(0, 25).map((p) => ({
              id: p.id,
              slug: p.slug,
              title: p.title,
              currentCutId: p.currentCutId,
              approvedCutId: p.approvedCutId,
              cutCount: p.cutCount,
              updatedAt: p.updatedAt,
            })),
          },
        };
      }

      const production = await getProduction(ctx.caller.uid, productionId, ctx.origin);
      const cutId = input.cutId?.trim() || defaultCutId || production.currentCutId || production.approvedCutId || '';
      if (!cutId) {
        return {
          modelSummary: {
            mode: 'production_only',
            production: {
              id: production.id,
              slug: production.slug,
              title: production.title,
              cuts: production.cuts,
              cast: production.cast,
            },
          },
        };
      }

      const cut = await getProductionCut(ctx.caller.uid, production.id, cutId, ctx.origin);
      return {
        modelSummary: {
          mode: 'cut',
          production: {
            id: production.id,
            slug: production.slug,
            title: production.title,
            currentCutId: production.currentCutId,
            approvedCutId: production.approvedCutId,
          },
          cut: {
            id: cut.id,
            label: cut.label,
            status: cut.status,
            kind: cut.kind,
            lengthSeconds: cut.lengthSeconds,
            notes: cut.notes.slice(0, 4000),
            timeline: cut.timeline,
            errors: cut.errors,
            assetCount: Object.keys(cut.assets).length,
          },
        },
      };
    } catch (error) {
      if (error instanceof ProductionError) {
        return errorOutcome(error.code, error.message);
      }
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface ListActivityInput {
  status?: string;
  type?: ChatMediaType;
  limit?: number;
}

export const listActivityTool: ChatToolDefinition<ListActivityInput, Record<string, unknown>> = {
  name: 'list_activity',
  runningLabel: 'Checking background activity…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['chat:use'],
  description:
    'Lists recent and running background media generations (queued, generating, ready, error, interrupted) for the signed-in user.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Optional status filter: queued, generating, ready, error, or interrupted.',
      },
      type: {
        type: 'string',
        enum: ['narration', 'video', 'image', 'music', 'sfx', 'analysis'],
        description: 'Optional media type filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum generations to return (default 15, max 30).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const allowed = allowedMediaTypes(ctx.caller);
    if (allowed.length === 0) {
      return errorOutcome('insufficient_scope', 'This API key has no media read scopes.');
    }
    if (input.type && !allowed.includes(input.type as MediaType)) {
      const scope = mediaReadScopeForType(input.type);
      return errorOutcome('insufficient_scope', `This API key cannot ${scope.replace(':', ' ')}.`);
    }

    const url = new URL('/api/v1/generations', ctx.origin);
    if (input.type) url.searchParams.set('type', input.type);
    const normalizedStatus = normalizeStatusFilter(input.status);
    if (normalizedStatus) url.searchParams.set('status', normalizedStatus);

    try {
      const res = await mediaDeps().listGenerations(ctx.caller, url);
      const cap = Math.min(Math.max(typeof input.limit === 'number' ? Math.floor(input.limit) : 15, 1), 30);
      const items = res.items.slice(0, cap);
      return {
        modelSummary: {
          count: items.length,
          indexing: res.indexing,
          items,
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

export interface ReadProductionInput {
  productionId?: string;
}

export const readProductionTool: ChatToolDefinition<ReadProductionInput, Record<string, unknown>> = {
  name: 'read_production',
  runningLabel: 'Reading production…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['productions:read'],
  description:
    'Reads a production overview including series, cast roster (character versions, voices, registers), approved/current cut IDs, and cut summaries—or lists productions when `productionId` is omitted.',
  parameters: {
    type: 'object',
    properties: {
      productionId: {
        type: 'string',
        description: 'Production ID (omit to list recent productions).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const defaultProdId = ctx.viewContext?.surface === 'cut' ? ctx.viewContext.productionId : '';
    const rawId = input.productionId?.trim() || defaultProdId;
    const cleanId = rawId.replace(/^mdmedia:\/\/production\//i, '').trim();

    try {
      if (!cleanId) {
        const list = await mediaDeps().listProductions(ctx.caller.uid, ctx.origin);
        return {
          modelSummary: {
            mode: 'list',
            productions: list.productions.slice(0, 25).map((p) => ({
              id: p.id,
              uri: `mdmedia://production/${p.id}`,
              slug: p.slug,
              title: p.title,
              series: p.series,
              currentCutId: p.currentCutId,
              approvedCutId: p.approvedCutId,
              cutCount: p.cutCount,
              castCount: p.cast.length,
              updatedAt: p.updatedAt,
            })),
          },
        };
      }

      const production = await mediaDeps().getProduction(ctx.caller.uid, cleanId, ctx.origin);
      return {
        modelSummary: {
          mode: 'detail',
          production: {
            id: production.id,
            uri: `mdmedia://production/${production.id}`,
            href: `/productions/${encodeURIComponent(production.id)}`,
            slug: production.slug,
            title: production.title,
            series: production.series,
            currentCutId: production.currentCutId,
            approvedCutId: production.approvedCutId,
            cutCount: production.cutCount,
            cuts: production.cuts.map((c) => ({
              id: c.id,
              uri: `mdmedia://cut/${production.id}/${c.id}`,
              label: c.label,
              status: c.status,
              kind: c.kind,
              lengthSeconds: c.lengthSeconds,
              notes: c.notes.slice(0, 1200),
            })),
            cast: production.cast.map((m) => ({
              role: m.role,
              ref: m.ref,
              uri: `mdmedia://character/${m.slug}@${m.version}`,
              name: m.name,
              voice: m.voice,
              register: m.register,
              description: m.description.slice(0, 1200),
            })),
          },
        },
      };
    } catch (error) {
      if (error instanceof ProductionError) {
        return errorOutcome(error.code, error.message);
      }
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface ReadStoryboardInput {
  storyboardId?: string;
}

export const readStoryboardTool: ChatToolDefinition<ReadStoryboardInput, Record<string, unknown>> = {
  name: 'read_storyboard',
  runningLabel: 'Reading storyboard…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['storyboards:read'],
  description:
    'Reads a saved storyboard’s premise, revision, and ordered beats (title, purpose, summary, script, visual, notes, status, estimatedSeconds)—or lists storyboards when `storyboardId` is omitted.',
  parameters: {
    type: 'object',
    properties: {
      storyboardId: {
        type: 'string',
        description:
          'Storyboard ID or `mdmedia://storyboard/<id>` URI (defaults to the active storyboard when viewing one).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const defaultId =
      ctx.viewContext?.surface === 'storyboard' ? ctx.viewContext.storyboardId : '';
    const rawId = input.storyboardId?.trim() || defaultId;
    const cleanId = rawId.replace(/^mdmedia:\/\/storyboard\//i, '').trim();

    try {
      if (!cleanId) {
        const list = await mediaDeps().listStoryboards(ctx.caller.uid);
        return {
          modelSummary: {
            mode: 'list',
            storyboards: list.storyboards.slice(0, 30).map((sb) => ({
              id: sb.id,
              uri: `mdmedia://storyboard/${sb.id}`,
              href: `/storyboards/${encodeURIComponent(sb.id)}`,
              title: sb.title,
              beatCount: sb.beatCount,
              updatedAt: sb.updatedAt,
            })),
          },
        };
      }

      const sb = await mediaDeps().getStoryboard(ctx.caller.uid, cleanId);
      const beats = sb.storyboard?.document.beats ?? [];
      return {
        modelSummary: {
          mode: 'detail',
          storyboard: {
            id: sb.id,
            uri: `mdmedia://storyboard/${sb.id}`,
            href: `/storyboards/${encodeURIComponent(sb.id)}`,
            title: sb.title,
            revision: sb.storyboard?.revision ?? 0,
            premise: (sb.storyboard?.document.premise ?? '').slice(0, 4000),
            beatCount: beats.length,
            beats: beats.map((beat, index) => ({
              index: index + 1,
              id: beat.id,
              title: beat.title,
              status: beat.status,
              estimatedSeconds: beat.estimatedSeconds,
              purpose: beat.purpose.slice(0, 1000),
              ...(beat.summary ? { summary: beat.summary.slice(0, 1000) } : {}),
              script: beat.script.slice(0, 2000),
              visual: beat.visual.slice(0, 1500),
              notes: beat.notes.slice(0, 1000),
            })),
          },
        },
      };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string'
      ) {
        return errorOutcome(
          (error as { code: string }).code,
          error instanceof Error ? error.message : 'Storyboard unavailable.',
        );
      }
      throw error;
    }
  },
};

export interface ReadCharacterInput {
  characterId?: string;
  version?: number;
}

export const readCharacterTool: ChatToolDefinition<ReadCharacterInput, Record<string, unknown>> = {
  name: 'read_character',
  runningLabel: 'Reading character…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['productions:read'],
  description:
    'Reads a Studio character (`person` or `thing` prop) by slug, ID, or `slug@version` ref (e.g. `rick@1`), returning its description, voice, register, changelog, and reference stills—or lists all characters when `characterId` is omitted.',
  parameters: {
    type: 'object',
    properties: {
      characterId: {
        type: 'string',
        description:
          'Character slug, ID, `slug@version` ref, or `mdmedia://character/<slug>@<version>` URI.',
      },
      version: {
        type: 'number',
        description: 'Optional integer version (defaults to the version in `slug@version` or latestVersion).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const rawRef = (input.characterId ?? '')
      .trim()
      .replace(/^mdmedia:\/\/character\//i, '')
      .replace(/^#/, '')
      .trim();

    try {
      if (!rawRef) {
        const list = await mediaDeps().listCharacters(ctx.caller.uid, ctx.origin);
        return {
          modelSummary: {
            mode: 'list',
            characters: list.characters.slice(0, 40).map((ch) => ({
              id: ch.id,
              slug: ch.slug,
              uri:
                ch.latestVersion > 0
                  ? `mdmedia://character/${ch.slug}@${ch.latestVersion}`
                  : `mdmedia://character/${ch.slug}`,
              name: ch.name,
              kind: ch.kind,
              latestVersion: ch.latestVersion,
              updatedAt: ch.updatedAt,
            })),
          },
        };
      }

      let idOrSlug = rawRef;
      let requestedVersion =
        typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0
          ? input.version
          : undefined;
      const atIdx = rawRef.indexOf('@');
      if (atIdx > 0) {
        idOrSlug = rawRef.slice(0, atIdx).trim();
        const parsedVer = Number(rawRef.slice(atIdx + 1).trim());
        if (!requestedVersion && Number.isInteger(parsedVer) && parsedVer > 0) {
          requestedVersion = parsedVer;
        }
      }

      const summary = await mediaDeps().getCharacter(ctx.caller.uid, idOrSlug, ctx.origin);
      const versionResource =
        requestedVersion && requestedVersion !== summary.latestVersion
          ? await mediaDeps().getCharacterVersion(
              ctx.caller.uid,
              summary.id,
              requestedVersion,
              ctx.origin,
            )
          : summary.latest;

      return {
        modelSummary: {
          mode: 'detail',
          character: {
            id: summary.id,
            slug: summary.slug,
            name: summary.name,
            kind: summary.kind,
            latestVersion: summary.latestVersion,
            versions: summary.versions,
            activeVersion: versionResource
              ? {
                  version: versionResource.version,
                  ref: versionResource.ref,
                  uri: `mdmedia://character/${summary.slug}@${versionResource.version}`,
                  description: versionResource.character.description.slice(0, 8000),
                  register: (versionResource.character.delivery?.register ?? '').slice(0, 4000),
                  voice: versionResource.character.voice,
                  stills: versionResource.character.stills.map((s) => ({
                    ...s,
                    assetId: versionResource.stills[s.id] ?? null,
                  })),
                }
              : null,
          },
        },
      };
    } catch (error) {
      if (error instanceof CharacterError) {
        return errorOutcome(error.code, error.message);
      }
      if (error instanceof MediaError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export interface ReadPlaylistInput {
  playlistId?: string;
}

export const readPlaylistTool: ChatToolDefinition<ReadPlaylistInput, Record<string, unknown>> = {
  name: 'read_playlist',
  runningLabel: 'Reading playlist…',
  kind: 'context',
  policy: 'auto-read',
  requiredScopes: ['playlists:manage'],
  description:
    'Reads a playlist’s title, description, total duration, and ordered narration items—or lists playlists when `playlistId` is omitted.',
  parameters: {
    type: 'object',
    properties: {
      playlistId: {
        type: 'string',
        description:
          'Playlist ID, exact title, or `mdmedia://playlist/<id>` URI (defaults to active playlist when viewing one).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const defaultId =
      ctx.viewContext?.surface === 'playlist' && ctx.viewContext.playlistId
        ? ctx.viewContext.playlistId
        : '';
    const rawId = (input.playlistId ?? defaultId)
      .trim()
      .replace(/^mdmedia:\/\/playlist\//i, '')
      .trim();

    try {
      if (!rawId) {
        const lists = await mediaDeps().listPlaylists(ctx.caller.uid);
        return {
          modelSummary: {
            mode: 'list',
            playlists: lists.slice(0, 30).map((pl) => ({
              id: pl.id,
              uri: `mdmedia://playlist/${pl.id}`,
              href: `/playlists?id=${encodeURIComponent(pl.id)}`,
              title: pl.title,
              description: pl.description,
              itemCount: pl.itemCount,
              durationMs: pl.durationMs,
              updatedAt: pl.updatedAt,
            })),
          },
        };
      }

      const resolvedId = await mediaDeps().resolvePlaylistId(ctx.caller.uid, rawId);
      const detail = await mediaDeps().getPlaylist(ctx.caller.uid, resolvedId);
      return {
        modelSummary: {
          mode: 'detail',
          playlist: {
            id: detail.id,
            uri: `mdmedia://playlist/${detail.id}`,
            href: `/playlists?id=${encodeURIComponent(detail.id)}`,
            title: detail.title,
            description: detail.description,
            itemCount: detail.itemCount,
            durationMs: detail.durationMs,
            counts: detail.counts,
            items: detail.items.slice(0, 100).map((item, idx) => ({
              position: idx + 1,
              narrationId: item.id,
              uri: `mdmedia://narration/${item.id}`,
              title: item.title,
              status: item.status,
              durationMs: item.durationMs,
            })),
          },
        },
      };
    } catch (error) {
      if (error instanceof PlaylistOpError) {
        return errorOutcome(error.code, error.message);
      }
      throw error;
    }
  },
};

export const CONTEXT_TOOLS: readonly ChatToolDefinition<any, any>[] = [
  getActiveViewContextTool,
  readMediaItemTool,
  searchLibraryTool,
  readTreeTool,
  readTreeDocumentTool,
  readProductionTool,
  readProductionCutTool,
  readStoryboardTool,
  readCharacterTool,
  readPlaylistTool,
  listActivityTool,
];
