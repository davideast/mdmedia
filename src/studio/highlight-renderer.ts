import { lexer } from 'marked';
import type { ChunkTiming } from '../storage/types.js';
import { getActiveWordAtPosition } from '../audio/player/word-aligner.js';
import { mapChunkToMarkdown } from '../chunker/markdown-mapper.js';

export interface HighlightedMarkdownBlock {
  type: 'paragraph' | 'code';
  text: string;
  isActive: boolean;
  timestampBadge?: string;
  beforeWord: string;
  activeWord: string;
  afterWord: string;
}

interface RawBlock {
  type: 'paragraph' | 'code';
  text: string;
  startOffset: number;
  endOffset: number;
}

/** Minimal structural shape of a track, to avoid importing the storage barrel here. */
interface TrackLike {
  transcript?: string;
  chunkTimings?: ChunkTiming[];
}

/** Minimal structural shape of a conversation turn. */
interface TurnLike {
  markdown?: string;
  track?: TrackLike;
}

export interface TranscriptSource {
  /** The text to render — always the text the timings were computed against. */
  text: string;
  chunkTimings: ChunkTiming[];
}

/**
 * Picks the display text and chunk timings as a matched pair.
 *
 * `chunkTimings[].text` indexes whatever was actually spoken. When a narration
 * adapter rewrote the document before synthesis, that is `track.transcript`, not
 * the original `turn.markdown`. Rendering the original against adapted timings
 * makes `mapChunkToMarkdown` drift or return null, and highlights silently vanish
 * for most of playback — so text and timings must come from the same source.
 *
 * Falls back to the original markdown only when there are no timings to honour.
 */
export function resolveTranscriptSource(
  turn?: TurnLike | null,
  track?: TrackLike | null
): TranscriptSource {
  const timed = [track, turn?.track].find((t) => t?.chunkTimings && t.chunkTimings.length > 0);

  if (timed) {
    // Prefer the spoken transcript; fall back to the turn's markdown only if the
    // track never stored one (pre-transcript tracks).
    return {
      text: timed.transcript ?? turn?.markdown ?? '',
      chunkTimings: timed.chunkTimings ?? [],
    };
  }

  // No timings: nothing can be highlighted, so show the most human-readable text.
  return {
    text: turn?.markdown ?? track?.transcript ?? '',
    chunkTimings: [],
  };
}

function formatTimestampBadge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
}

function segmentMarkdown(markdown: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const topTokens = lexer(markdown);
  let cursor = 0;

  for (const token of topTokens) {
    const idx = markdown.indexOf(token.raw, cursor);
    const startOffset = idx !== -1 ? idx : cursor;
    cursor = startOffset + token.raw.length;

    if (token.type === 'space') {
      continue;
    }

    const raw = token.raw;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const trimmed = raw.slice(lead, raw.length - trail);

    if (trimmed.length > 0) {
      blocks.push({
        type: token.type === 'code' ? 'code' : 'paragraph',
        text: trimmed,
        startOffset: startOffset + lead,
        endOffset: startOffset + lead + trimmed.length,
      });
    }
  }

  return blocks;
}

export function buildHighlightedMarkdownBlocks(
  markdown: string,
  chunkTimings: ChunkTiming[],
  positionMs: number
): HighlightedMarkdownBlock[] {
  if (!markdown || !markdown.trim()) {
    return [];
  }

  const rawBlocks = segmentMarkdown(markdown);
  if (rawBlocks.length === 0) {
    return [];
  }

  const blockStartMs = new Map<number, number>();
  for (const chunk of chunkTimings) {
    const docHighlight = mapChunkToMarkdown(markdown, chunk);
    if (!docHighlight) continue;

    const blockIdx = rawBlocks.findIndex(
      (b) =>
        b.type === 'paragraph' &&
        docHighlight.docCharStart >= b.startOffset &&
        docHighlight.docCharStart < b.endOffset
    );
    if (blockIdx !== -1) {
      const existing = blockStartMs.get(blockIdx);
      if (existing === undefined || chunk.startMs < existing) {
        blockStartMs.set(blockIdx, chunk.startMs);
      }
    }
  }

  let activeBlockIdx = -1;
  let activeWordSpan: { start: number; end: number } | null = null;

  const activeChunk = chunkTimings.find(
    (c) => positionMs >= c.startMs && positionMs <= c.endMs
  );

  if (activeChunk) {
    const wordHighlight = getActiveWordAtPosition(activeChunk, positionMs);
    const docHighlight = mapChunkToMarkdown(
      markdown,
      activeChunk,
      wordHighlight ?? undefined
    );

    if (docHighlight) {
      activeBlockIdx = rawBlocks.findIndex(
        (b) =>
          b.type === 'paragraph' &&
          docHighlight.docCharStart >= b.startOffset &&
          docHighlight.docCharStart < b.endOffset
      );

      if (activeBlockIdx !== -1 && wordHighlight) {
        const block = rawBlocks[activeBlockIdx];
        const relStart = Math.max(
          0,
          Math.min(block.text.length, docHighlight.docCharStart - block.startOffset)
        );
        const relEnd = Math.max(
          relStart,
          Math.min(block.text.length, docHighlight.docCharEnd - block.startOffset)
        );
        activeWordSpan = { start: relStart, end: relEnd };
      }
    }
  }

  return rawBlocks.map((block, idx): HighlightedMarkdownBlock => {
    const isActive = idx === activeBlockIdx && block.type === 'paragraph';
    const startMs = blockStartMs.get(idx);
    const timestampBadge =
      block.type === 'paragraph' && startMs !== undefined
        ? formatTimestampBadge(startMs)
        : undefined;

    if (isActive && activeWordSpan) {
      return {
        type: block.type,
        text: block.text,
        isActive: true,
        timestampBadge,
        beforeWord: block.text.slice(0, activeWordSpan.start),
        activeWord: block.text.slice(activeWordSpan.start, activeWordSpan.end),
        afterWord: block.text.slice(activeWordSpan.end),
      };
    }

    return {
      type: block.type,
      text: block.text,
      isActive,
      timestampBadge,
      beforeWord: block.text,
      activeWord: '',
      afterWord: '',
    };
  });
}
