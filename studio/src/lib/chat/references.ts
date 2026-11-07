/**
 * Shared browser + server URI grammar, `#` trigger parsing, validation, and
 * display taxonomy metadata for universal Studio Contextual Chat `#` references.
 *
 * Pure TypeScript — zero Node, Firebase, or React imports.
 */

import {
  CHAT_REFERENCE_KINDS,
  type ChatEntityReference,
  type ChatMediaType,
  type ChatReferenceCategory,
  type ChatReferenceKind,
} from './types';

export const MAX_CHAT_MESSAGE_REFERENCES = 20;
export const MAX_HASH_TRIGGER_QUERY_CHARS = 56;

const VALID_REFERENCE_KIND_SET = new Set<string>(CHAT_REFERENCE_KINDS);
const VALID_MEDIA_KIND_SET = new Set<string>([
  'narration',
  'video',
  'image',
  'music',
  'sfx',
  'analysis',
]);

export const CHAT_REFERENCE_CATEGORIES: ReadonlyArray<{
  id: ChatReferenceCategory;
  label: string;
}> = [
  { id: 'all', label: 'All' },
  { id: 'media', label: 'Media' },
  { id: 'docs', label: 'Docs' },
  { id: 'production', label: 'Production' },
  { id: 'characters', label: 'Characters' },
  { id: 'playlists', label: 'Playlists' },
];

const HASH_PREFIX_ALIASES: Readonly<Record<string, ChatReferenceKind>> = {
  nar: 'narration',
  narration: 'narration',
  narrations: 'narration',
  vid: 'video',
  video: 'video',
  videos: 'video',
  img: 'image',
  image: 'image',
  images: 'image',
  music: 'music',
  sfx: 'sfx',
  sound: 'sfx',
  analysis: 'analysis',
  analyses: 'analysis',
  tree: 'tree',
  trees: 'tree',
  doc: 'tree-doc',
  docs: 'tree-doc',
  'tree-doc': 'tree-doc',
  prod: 'production',
  production: 'production',
  productions: 'production',
  cut: 'cut',
  cuts: 'cut',
  sb: 'storyboard',
  board: 'storyboard',
  storyboard: 'storyboard',
  storyboards: 'storyboard',
  char: 'character',
  character: 'character',
  characters: 'character',
  cast: 'character',
  prop: 'character',
  playlist: 'playlist',
  playlists: 'playlist',
};

export function isChatReferenceKind(value: unknown): value is ChatReferenceKind {
  return typeof value === 'string' && VALID_REFERENCE_KIND_SET.has(value);
}

export function isMediaReferenceKind(kind: ChatReferenceKind): kind is ChatMediaType {
  return VALID_MEDIA_KIND_SET.has(kind);
}

export function categoryForReferenceKind(kind: ChatReferenceKind): Exclude<ChatReferenceCategory, 'all'> {
  switch (kind) {
    case 'narration':
    case 'video':
    case 'image':
    case 'music':
    case 'sfx':
    case 'analysis':
      return 'media';
    case 'tree':
    case 'tree-doc':
      return 'docs';
    case 'production':
    case 'cut':
    case 'storyboard':
      return 'production';
    case 'character':
      return 'characters';
    case 'playlist':
      return 'playlists';
  }
}

export function matchesReferenceCategory(
  kind: ChatReferenceKind,
  category: ChatReferenceCategory,
): boolean {
  if (category === 'all') return true;
  return categoryForReferenceKind(kind) === category;
}

export function referenceKindLabel(
  kind: ChatReferenceKind,
  characterKind?: 'person' | 'thing',
): string {
  switch (kind) {
    case 'narration':
      return 'Narration';
    case 'video':
      return 'Video';
    case 'image':
      return 'Image';
    case 'music':
      return 'Music';
    case 'sfx':
      return 'Sound effect';
    case 'analysis':
      return 'Video analysis';
    case 'tree':
      return 'Tree';
    case 'tree-doc':
      return 'Tree doc';
    case 'production':
      return 'Production';
    case 'cut':
      return 'Cut';
    case 'storyboard':
      return 'Storyboard';
    case 'character':
      return characterKind === 'thing' ? 'Prop character' : 'Character';
    case 'playlist':
      return 'Playlist';
  }
}

export function referenceKindShortBadge(
  kind: ChatReferenceKind,
  characterKind?: 'person' | 'thing',
): string {
  switch (kind) {
    case 'narration':
      return 'NAR';
    case 'video':
      return 'VIDEO';
    case 'image':
      return 'IMG';
    case 'music':
      return 'MUSIC';
    case 'sfx':
      return 'SFX';
    case 'analysis':
      return 'ANALYSIS';
    case 'tree':
      return 'TREE';
    case 'tree-doc':
      return 'DOC';
    case 'production':
      return 'PROD';
    case 'cut':
      return 'CUT';
    case 'storyboard':
      return 'BOARD';
    case 'character':
      return characterKind === 'thing' ? 'PROP' : 'CHAR';
    case 'playlist':
      return 'LIST';
  }
}

export function recommendedToolForReferenceKind(kind: ChatReferenceKind): string {
  switch (kind) {
    case 'narration':
    case 'video':
    case 'image':
    case 'music':
    case 'sfx':
    case 'analysis':
      return 'read_media_item';
    case 'tree':
      return 'read_tree';
    case 'tree-doc':
      return 'read_tree_document';
    case 'production':
      return 'read_production';
    case 'cut':
      return 'read_production_cut';
    case 'storyboard':
      return 'read_storyboard';
    case 'character':
      return 'read_character';
    case 'playlist':
      return 'read_playlist';
  }
}

function encodeDocPathSegments(docPath: string): string {
  return docPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function decodeDocPathSegments(encodedPath: string): string {
  // Support both slash-separated encoded segments (`a/b%20c.md`) and single-encoded (`a%2Fb.md`)
  const firstPass = encodedPath.includes('/')
    ? encodedPath
        .split('/')
        .filter(Boolean)
        .map((seg) => decodeSafe(seg))
        .join('/')
    : decodeSafe(encodedPath);
  return firstPass.replace(/^\/+/, '');
}

export function routeForEntityReference(
  kind: ChatReferenceKind,
  id: string,
  subId?: string,
): string {
  const encodedId = encodeURIComponent(id);
  switch (kind) {
    case 'narration':
      return `/narration/${encodedId}`;
    case 'video':
      return `/video/${encodedId}`;
    case 'image':
      return `/image/${encodedId}`;
    case 'music':
      return `/music/${encodedId}`;
    case 'analysis':
      return `/analysis/${encodedId}`;
    case 'sfx':
      return `/library?type=sfx&q=${encodedId}`;
    case 'tree':
      return `/trees/${encodedId}`;
    case 'tree-doc': {
      const cleanSub = (subId ?? '').replace(/^\/+/, '');
      return cleanSub
        ? `/trees/${encodedId}/${encodeDocPathSegments(cleanSub)}`
        : `/trees/${encodedId}`;
    }
    case 'production':
      return `/productions/${encodedId}`;
    case 'cut':
      return subId
        ? `/productions/${encodedId}/cuts/${encodeURIComponent(subId)}`
        : `/productions/${encodedId}`;
    case 'storyboard':
      return `/storyboards/${encodedId}`;
    case 'character':
      return subId ? `#character:${id}@${subId}` : `#character:${id}`;
    case 'playlist':
      return `/playlists?id=${encodedId}`;
  }
}

export function formatChatEntityUri(input: {
  kind: ChatReferenceKind;
  id: string;
  subId?: string | null;
}): string {
  const cleanId = input.id.trim();
  const cleanSub = input.subId?.trim() || '';

  switch (input.kind) {
    case 'tree-doc':
      return `mdmedia://tree-doc/${encodeURIComponent(cleanId)}/${encodeDocPathSegments(cleanSub)}`;
    case 'cut':
      return `mdmedia://cut/${encodeURIComponent(cleanId)}/${encodeURIComponent(cleanSub)}`;
    case 'character':
      return cleanSub
        ? `mdmedia://character/${encodeURIComponent(cleanId)}@${encodeURIComponent(cleanSub)}`
        : `mdmedia://character/${encodeURIComponent(cleanId)}`;
    case 'narration':
    case 'video':
    case 'image':
    case 'music':
    case 'sfx':
    case 'analysis':
      return cleanSub
        ? `mdmedia://${input.kind}/${encodeURIComponent(cleanId)}@${encodeURIComponent(cleanSub)}`
        : `mdmedia://${input.kind}/${encodeURIComponent(cleanId)}`;
    case 'tree':
    case 'production':
    case 'storyboard':
    case 'playlist':
      return `mdmedia://${input.kind}/${encodeURIComponent(cleanId)}`;
  }
}

export interface ParsedChatEntityUri {
  uri: string;
  kind: ChatReferenceKind;
  id: string;
  subId?: string;
  href: string;
}

/**
 * Losslessly parses any `mdmedia://<kind>/...` URI across all 13 Studio entity kinds.
 */
export function parseChatEntityUri(rawHref: string): ParsedChatEntityUri | null {
  const trimmed = rawHref.trim();
  if (!trimmed.toLowerCase().startsWith('mdmedia://')) return null;

  const body = trimmed.slice('mdmedia://'.length);
  const slashIdx = body.indexOf('/');
  if (slashIdx <= 0) return null;

  const rawKind = body.slice(0, slashIdx).toLowerCase();
  if (!isChatReferenceKind(rawKind)) return null;

  const rest = body.slice(slashIdx + 1).trim();
  if (!rest || /\s/.test(rest)) return null;

  if (rawKind === 'tree-doc') {
    const nextSlash = rest.indexOf('/');
    if (nextSlash <= 0) return null;
    const treeId = decodeSafe(rest.slice(0, nextSlash).trim());
    const docPath = decodeDocPathSegments(rest.slice(nextSlash + 1).trim());
    if (!treeId || !docPath) return null;
    return {
      uri: formatChatEntityUri({ kind: 'tree-doc', id: treeId, subId: docPath }),
      kind: 'tree-doc',
      id: treeId,
      subId: docPath,
      href: routeForEntityReference('tree-doc', treeId, docPath),
    };
  }

  if (rawKind === 'cut') {
    const nextSlash = rest.indexOf('/');
    if (nextSlash <= 0) return null;
    const productionId = decodeSafe(rest.slice(0, nextSlash).trim());
    const cutId = decodeSafe(rest.slice(nextSlash + 1).trim());
    if (!productionId || !cutId || cutId.includes('/')) return null;
    return {
      uri: formatChatEntityUri({ kind: 'cut', id: productionId, subId: cutId }),
      kind: 'cut',
      id: productionId,
      subId: cutId,
      href: routeForEntityReference('cut', productionId, cutId),
    };
  }

  if (rest.includes('/')) return null;

  const atIdx = rest.indexOf('@');
  if (atIdx !== -1) {
    const id = decodeSafe(rest.slice(0, atIdx).trim());
    const subId = decodeSafe(rest.slice(atIdx + 1).trim());
    if (!id || !subId) return null;
    return {
      uri: formatChatEntityUri({ kind: rawKind, id, subId }),
      kind: rawKind,
      id,
      subId,
      href: routeForEntityReference(rawKind, id, subId),
    };
  }

  const id = decodeSafe(rest);
  if (!id) return null;
  return {
    uri: formatChatEntityUri({ kind: rawKind, id }),
    kind: rawKind,
    id,
    href: routeForEntityReference(rawKind, id),
  };
}

export function defaultEntityPillLabel(parsed: Pick<ParsedChatEntityUri, 'kind' | 'id' | 'subId'>): string {
  if (parsed.kind === 'character') {
    return parsed.subId ? `${parsed.id}@${parsed.subId}` : parsed.id;
  }
  if (parsed.kind === 'tree-doc' && parsed.subId) {
    const leaf = parsed.subId.split('/').pop() || parsed.subId;
    return leaf;
  }
  if (parsed.kind === 'cut' && parsed.subId) {
    return `${parsed.id} · ${parsed.subId}`;
  }
  const prefix = referenceKindLabel(parsed.kind);
  const shortId = parsed.id.length > 14 ? `${parsed.id.slice(0, 12)}…` : parsed.id;
  return `${prefix} · ${shortId}`;
}

/**
 * Formats the clean human-readable `#Token` inserted at cursor in `ChatComposer`.
 */
export function formatReferenceComposerToken(
  ref: Pick<ChatEntityReference, 'kind' | 'id' | 'subId' | 'title'>,
): string {
  if (ref.kind === 'character') {
    return ref.subId ? `#${ref.id}@${ref.subId}` : `#${ref.id}`;
  }
  const cleanTitle = ref.title
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/#/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const bounded =
    cleanTitle.length > 44 ? `${cleanTitle.slice(0, 43).trimEnd()}…` : cleanTitle;
  return `#${bounded || ref.id}`;
}

export interface ParsedHashQuery {
  kindFilter: ChatReferenceKind | null;
  search: string;
}

/**
 * Parses optional `#<prefix>:<search>` shorthand (e.g. `video:ocean`, `doc:intro`, `char:rick`).
 */
export function parseHashQuery(rawAfterHash: string): ParsedHashQuery {
  const colonIdx = rawAfterHash.indexOf(':');
  if (colonIdx > 0) {
    const prefix = rawAfterHash.slice(0, colonIdx).trim().toLowerCase();
    const mapped = HASH_PREFIX_ALIASES[prefix];
    if (mapped) {
      return {
        kindFilter: mapped,
        search: rawAfterHash.slice(colonIdx + 1).trimStart(),
      };
    }
  }
  return {
    kindFilter: null,
    search: rawAfterHash,
  };
}

export interface ActiveHashTrigger {
  /** Index of `#` in `text`. */
  startOffset: number;
  /** Current cursor index in `text`. */
  endOffset: number;
  /** Raw text between `#` and `endOffset`. */
  rawQuery: string;
  /** Optional explicit `#kind:` prefix filter. */
  kindFilter: ChatReferenceKind | null;
  /** Normalized search string passed to `/api/v1/chat/references`. */
  search: string;
}

function isTriggerBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return /[\s([{"'“‘—–-]/.test(ch);
}

/**
 * Detects an active `#...` reference trigger immediately before `cursorOffset`.
 *
 * - Supports `#` at start of input or after whitespace/opening punctuation.
 * - Ignores `# ` (hash followed immediately by whitespace, e.g. Markdown headings).
 * - Skips `#` occurrences that belong to an already-selected reference token
 *   followed by trailing text so typing after `#The overnight process ` does not
 *   re-open the popover until a new `#` is typed.
 */
export function extractActiveHashTrigger(
  text: string,
  cursorOffset: number,
  resolvedTokens: readonly string[] = [],
): ActiveHashTrigger | null {
  if (!text) return null;
  const clampedCursor = Math.max(0, Math.min(cursorOffset, text.length));
  if (clampedCursor === 0) return null;

  // Do not hijack a leading `/slash` token while the user is still typing the command name.
  if (text.startsWith('/') && !/\s/.test(text.slice(0, clampedCursor))) {
    return null;
  }

  // Find the start of the current line up to cursor.
  const lastNewline = text.lastIndexOf('\n', clampedCursor - 1);
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;

  // Mask out ranges covered by already-selected `#Token` occurrences that have been completed (followed by space/punctuation or before cursor).
  const resolvedRanges: Array<{ start: number; end: number }> = [];
  const sortedTokens = [...resolvedTokens]
    .filter((t) => t.startsWith('#') && t.length > 1)
    .sort((a, b) => b.length - a.length);

  for (const token of sortedTokens) {
    let fromIdx = lineStart;
    while (fromIdx < clampedCursor) {
      const found = text.indexOf(token, fromIdx);
      if (found === -1 || found >= clampedCursor) break;
      const beforeOk = isTriggerBoundaryChar(found > 0 ? text[found - 1] : undefined);
      const afterIdx = found + token.length;
      // Treat as resolved once completed with trailing delimiter (space/punct) or exact token when followed by space in text
      const nextCh = text[afterIdx];
      const completed =
        afterIdx < clampedCursor ||
        (nextCh !== undefined && /[\s.,;:!?)\]}"']/.test(nextCh));
      if (beforeOk && completed) {
        resolvedRanges.push({ start: found, end: afterIdx });
      }
      fromIdx = found + 1;
    }
  }

  const isInsideResolved = (pos: number): boolean =>
    resolvedRanges.some((r) => pos >= r.start && pos < r.end);

  // Scan backward from cursor to lineStart for the nearest eligible `#`.
  for (let idx = clampedCursor - 1; idx >= lineStart; idx--) {
    if (text[idx] !== '#') continue;
    // Ignore `##` or mid-word `foo#bar`
    if (!isTriggerBoundaryChar(idx > 0 ? text[idx - 1] : undefined)) continue;
    if (isInsideResolved(idx)) continue;

    const rawAfterHash = text.slice(idx + 1, clampedCursor);
    // `# ` (immediate whitespace) is a Markdown heading, not a reference lookup.
    if (rawAfterHash.length > 0 && /^\s/.test(rawAfterHash)) {
      return null;
    }
    // Bound multi-word queries so normal prose after an unclosed `#tag` does not stay open forever.
    if (rawAfterHash.length > MAX_HASH_TRIGGER_QUERY_CHARS) {
      return null;
    }
    const wordSpaces = (rawAfterHash.match(/\s+/g) ?? []).length;
    if (wordSpaces > 4) {
      return null;
    }

    const parsed = parseHashQuery(rawAfterHash);
    return {
      startOffset: idx,
      endOffset: clampedCursor,
      rawQuery: rawAfterHash,
      kindFilter: parsed.kindFilter,
      search: parsed.search,
    };
  }

  return null;
}

export type UserMessageInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reference'; reference: ChatEntityReference };

/**
 * Tokenizes a user message's text against its attached `references` so `#Title`
 * (or `#slug@version` / `mdmedia://...`) tokens render inline as rich chips,
 * while returning any remaining attached references that were not matched inline.
 */
export function tokenizeUserTextWithReferences(
  text: string,
  references: readonly ChatEntityReference[] | undefined,
): {
  segments: UserMessageInlineSegment[];
  unmatchedReferences: ChatEntityReference[];
} {
  if (!references || references.length === 0) {
    return {
      segments: text ? [{ kind: 'text', text }] : [],
      unmatchedReferences: [],
    };
  }

  const candidates = references.map((ref, refIndex) => {
    const tokens = new Set<string>();
    if (ref.composerToken?.trim()) tokens.add(ref.composerToken.trim());
    tokens.add(formatReferenceComposerToken(ref));
    if (ref.uri) tokens.add(ref.uri);
    return {
      refIndex,
      ref,
      tokens: [...tokens].filter(Boolean).sort((a, b) => b.length - a.length),
    };
  });

  const matchedIndices = new Set<number>();
  const segments: UserMessageInlineSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let earliestPos = -1;
    let earliestLen = 0;
    let earliestCandidate: (typeof candidates)[number] | null = null;

    for (const candidate of candidates) {
      for (const token of candidate.tokens) {
        const pos = text.indexOf(token, cursor);
        if (pos === -1) continue;
        const beforeOk = isTriggerBoundaryChar(pos > 0 ? text[pos - 1] : undefined);
        const afterCh = text[pos + token.length];
        const afterOk =
          afterCh === undefined || /[\s.,;:!?)\]}"'—–-]/.test(afterCh);
        if (!beforeOk || !afterOk) continue;

        if (
          earliestPos === -1 ||
          pos < earliestPos ||
          (pos === earliestPos && token.length > earliestLen)
        ) {
          earliestPos = pos;
          earliestLen = token.length;
          earliestCandidate = candidate;
        }
      }
    }

    if (earliestPos === -1 || !earliestCandidate) {
      segments.push({ kind: 'text', text: text.slice(cursor) });
      break;
    }

    if (earliestPos > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, earliestPos) });
    }
    segments.push({ kind: 'reference', reference: earliestCandidate.ref });
    matchedIndices.add(earliestCandidate.refIndex);
    cursor = earliestPos + earliestLen;
  }

  const unmatchedReferences = references.filter((_, idx) => !matchedIndices.has(idx));
  return { segments, unmatchedReferences };
}

/**
 * Validates `references` sent to `POST /api/v1/chat/threads/[id]/messages`.
 */
export function validateChatEntityReferences(
  raw: unknown,
): ChatEntityReference[] | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_CHAT_MESSAGE_REFERENCES) return 'invalid';

  const validated: ChatEntityReference[] = [];
  const seenUris = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'invalid';
    const obj = item as Record<string, unknown>;
    if (typeof obj.uri !== 'string' || obj.uri.length > 512) return 'invalid';
    const parsed = parseChatEntityUri(obj.uri);
    if (!parsed) return 'invalid';
    if (obj.kind !== undefined && obj.kind !== parsed.kind) return 'invalid';
    if (typeof obj.title !== 'string' || !obj.title.trim() || obj.title.length > 240) {
      return 'invalid';
    }
    if (seenUris.has(parsed.uri)) continue;
    seenUris.add(parsed.uri);

    const subtitle =
      typeof obj.subtitle === 'string' && obj.subtitle.trim()
        ? obj.subtitle.trim().slice(0, 240)
        : undefined;
    const metaLabel =
      typeof obj.metaLabel === 'string' && obj.metaLabel.trim()
        ? obj.metaLabel.trim().slice(0, 80)
        : undefined;
    const characterKind =
      obj.characterKind === 'person' || obj.characterKind === 'thing'
        ? obj.characterKind
        : undefined;
    const cutStatus =
      obj.cutStatus === 'review' ||
      obj.cutStatus === 'approved' ||
      obj.cutStatus === 'final' ||
      obj.cutStatus === 'none'
        ? obj.cutStatus
        : undefined;
    const thumbnailAssetId =
      typeof obj.thumbnailAssetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(obj.thumbnailAssetId)
        ? obj.thumbnailAssetId
        : null;
    const thumbnailUrl =
      typeof obj.thumbnailUrl === 'string' &&
      obj.thumbnailUrl.length <= 2048 &&
      (obj.thumbnailUrl.startsWith('/') || obj.thumbnailUrl.startsWith('https://'))
        ? obj.thumbnailUrl
        : null;
    const composerToken =
      typeof obj.composerToken === 'string' &&
      obj.composerToken.startsWith('#') &&
      obj.composerToken.length <= 80
        ? obj.composerToken
        : undefined;
    const href =
      typeof obj.href === 'string' &&
      (obj.href.startsWith('/') || obj.href.startsWith('#character:')) &&
      !obj.href.startsWith('//') &&
      obj.href.length <= 512
        ? obj.href
        : parsed.href;

    validated.push({
      uri: parsed.uri,
      kind: parsed.kind,
      id: parsed.id,
      ...(parsed.subId ? { subId: parsed.subId } : {}),
      title: obj.title.trim(),
      ...(subtitle ? { subtitle } : {}),
      ...(metaLabel ? { metaLabel } : {}),
      ...(characterKind ? { characterKind } : {}),
      ...(cutStatus ? { cutStatus } : {}),
      ...(thumbnailAssetId ? { thumbnailAssetId } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      href,
      ...(composerToken ? { composerToken } : {}),
      ...(obj.isLocalDraft === true ? { isLocalDraft: true } : {}),
    });
  }

  return validated.length > 0 ? validated : undefined;
}
