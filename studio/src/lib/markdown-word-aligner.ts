import { lexer, type Token, type Tokens } from 'marked';
import {
  parseMarkdownToSpeakableSegments,
  type ParseMarkdownOptions,
  type SpeakableSegment,
} from 'mdmedia/chunker/markdown-parser';
import type {
  TranscriptSourceMap,
  TranscriptSourceMapBlock,
  TreeMediaRef,
} from './tree-types';
import type { AlignedChunk, AlignedWord } from './types';

export { parseMarkdownToSpeakableSegments, type ParseMarkdownOptions, type SpeakableSegment };

export interface MarkdownWordToken {
  text: string;
  normalized: string;
  rawStart: number;
  rawEnd: number;
  blockIndex: number;
  alignedWord?: AlignedWord;
}

export interface MarkdownBlockTokenAlignment {
  blockIndex: number;
  mdStart: number;
  mdEnd: number;
  tokens: MarkdownWordToken[];
}

export interface MarkdownAlignmentResult {
  alignedByMdOffset: Map<number, AlignedWord>;
  matchRatio: number;
  fallbackToPlain: boolean;
  tokensByBlock: MarkdownBlockTokenAlignment[];
}

export function normalizeSpeakableToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Builds the joined speakable transcript, paragraph list, and `TranscriptSourceMap`
 * mapping each Markdown block `[mdStart, mdEnd]` to `[transcriptStart, transcriptEnd]`.
 */
export function buildTranscriptSourceMap(
  markdown: string,
  options?: ParseMarkdownOptions,
  finalTranscript?: string,
): {
  transcript: string;
  paragraphs: string[];
  sourceMap: TranscriptSourceMap;
} {
  const segments = parseMarkdownToSpeakableSegments(markdown, options);
  const paragraphs: string[] = [];
  const blocks: TranscriptSourceMapBlock[] = [];
  let cursor = 0;

  for (const seg of segments) {
    paragraphs.push(seg.text);
    if (finalTranscript !== undefined) {
      const directIdx = finalTranscript.indexOf(seg.text, cursor);
      if (directIdx >= 0) {
        const transcriptStart = directIdx;
        const transcriptEnd = directIdx + seg.text.length;
        blocks.push({ mdStart: seg.mdStart, mdEnd: seg.mdEnd, transcriptStart, transcriptEnd });
        cursor = transcriptEnd;
        continue;
      }
      // If chunkSpeakableParagraphs split a >400-char paragraph across chunks, whitespace may be "\n\n" instead of " "
      const pattern = seg.text
        .trim()
        .split(/\s+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      const regex = new RegExp(pattern, 'g');
      regex.lastIndex = cursor;
      const match = regex.exec(finalTranscript);
      if (match && match.index >= cursor) {
        const transcriptStart = match.index;
        const transcriptEnd = match.index + match[0].length;
        blocks.push({ mdStart: seg.mdStart, mdEnd: seg.mdEnd, transcriptStart, transcriptEnd });
        cursor = transcriptEnd;
        continue;
      }
    }
    if (blocks.length > 0) {
      cursor += 2; // "\n\n" separator between paragraphs
    }
    const transcriptStart = cursor;
    const transcriptEnd = transcriptStart + seg.text.length;
    blocks.push({
      mdStart: seg.mdStart,
      mdEnd: seg.mdEnd,
      transcriptStart,
      transcriptEnd,
    });
    cursor = transcriptEnd;
  }

  return {
    transcript: finalTranscript ?? paragraphs.join('\n\n'),
    paragraphs,
    sourceMap: {
      version: 1,
      blocks,
    },
  };
}

const VALID_MDMEDIA_TYPES = new Set<TreeMediaRef['type']>([
  'image',
  'video',
  'music',
  'sfx',
  'narration',
  'asset',
  'mermaid',
]);

function normalizeRelativeAssetPath(rawHref: string, docPath?: string): string | null {
  const trimmed = rawHref.trim().split(/[?#]/)[0]?.trim() ?? '';
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/\\/g, '/');
  if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    const baseParts = docPath
      ? docPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').slice(0, -1)
      : [];
    const relParts = cleaned.split('/');
    const stack = [...baseParts];
    for (const part of relParts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join('/');
  }

  return cleaned.replace(/^\/+/, '');
}

/**
 * Resolves a Markdown link or image target into a `TreeMediaRef`:
 * - Canonical `mdmedia://<type>/<id>[@<generationId>]` URIs
 * - Relative asset paths bound in `pathAssets`
 * - Returns `null` for external `https://` / `http://` / `mailto:` / `data:` / `javascript:` URLs
 */
export function parseMediaUri(
  rawHref: string,
  pathAssets?: Record<string, TreeMediaRef>,
  docPath?: string,
): TreeMediaRef | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith('mdmedia://')) {
    const withoutScheme = trimmed.slice('mdmedia://'.length);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx <= 0) return null;

    const rawType = withoutScheme.slice(0, slashIdx).toLowerCase() as TreeMediaRef['type'];
    if (!VALID_MDMEDIA_TYPES.has(rawType)) return null;

    const rest = withoutScheme.slice(slashIdx + 1).trim();
    if (!rest) return null;

    const atIdx = rest.indexOf('@');
    if (atIdx !== -1) {
      const id = rest.slice(0, atIdx).trim();
      const generationId = rest.slice(atIdx + 1).trim();
      if (!id) return null;
      return generationId ? { type: rawType, id, generationId } : { type: rawType, id };
    }

    return { type: rawType, id: rest };
  }

  // Reject all external or non-asset schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    return null;
  }

  if (!pathAssets) return null;

  const normalizedRel = normalizeRelativeAssetPath(trimmed, docPath);
  if (normalizedRel && pathAssets[normalizedRel]) {
    return pathAssets[normalizedRel]!;
  }

  const directTrimmed = trimmed.replace(/^\.?\//, '');
  if (pathAssets[directTrimmed]) {
    return pathAssets[directTrimmed]!;
  }

  return null;
}

function pushWordsFromSlice(
  sliceText: string,
  sliceMdStart: number,
  blockIndex: number,
  out: MarkdownWordToken[],
): void {
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sliceText)) !== null) {
    const rawWord = match[0];
    const normalized = normalizeSpeakableToken(rawWord);
    if (!normalized) continue;
    const rawStart = sliceMdStart + match.index;
    const rawEnd = rawStart + rawWord.length;
    out.push({
      text: rawWord,
      normalized,
      rawStart,
      rawEnd,
      blockIndex,
    });
  }
}

function walkTokensWithCursor(
  tokens: Token[],
  markdown: string,
  cursorRef: { pos: number },
  blockEnd: number,
  blockIndex: number,
  out: MarkdownWordToken[],
): void {
  for (const token of tokens) {
    if (cursorRef.pos >= blockEnd) break;

    const foundIdx = token.raw ? markdown.indexOf(token.raw, cursorRef.pos) : -1;
    const tokenStart =
      foundIdx !== -1 && foundIdx < blockEnd ? foundIdx : cursorRef.pos;
    const tokenEnd = Math.min(blockEnd, tokenStart + (token.raw?.length ?? 0));

    switch (token.type) {
      case 'image':
      case 'html':
      case 'space':
      case 'hr':
      case 'br': {
        cursorRef.pos = tokenEnd;
        break;
      }

      case 'codespan': {
        const codeToken = token as Tokens.Codespan;
        const innerRel = codeToken.raw.indexOf(codeToken.text);
        const innerStart = tokenStart + (innerRel !== -1 ? innerRel : 1);
        pushWordsFromSlice(codeToken.text, innerStart, blockIndex, out);
        cursorRef.pos = tokenEnd;
        break;
      }

      case 'link': {
        const linkToken = token as Tokens.Link;
        const labelText = linkToken.text ?? '';
        // Skip links whose visible label is a raw URL (discarded by speech sanitizer)
        if (/^https?:\/\//i.test(labelText.trim())) {
          cursorRef.pos = tokenEnd;
          break;
        }
        cursorRef.pos = Math.min(blockEnd, tokenStart + 1); // after opening '['
        if (linkToken.tokens && linkToken.tokens.length > 0) {
          walkTokensWithCursor(linkToken.tokens, markdown, cursorRef, tokenEnd, blockIndex, out);
        } else if (labelText) {
          pushWordsFromSlice(labelText, cursorRef.pos, blockIndex, out);
        }
        // Always jump past the closing `](url)` so the URL itself is never tokenized
        cursorRef.pos = tokenEnd;
        break;
      }

      case 'strong':
      case 'em':
      case 'del': {
        const formatted = token as Tokens.Strong | Tokens.Em | Tokens.Del;
        const markerMatch = formatted.raw.match(/^([*_~]+)/);
        const markerLen = markerMatch ? markerMatch[1]!.length : 1;
        cursorRef.pos = Math.min(blockEnd, tokenStart + markerLen);
        if (formatted.tokens && formatted.tokens.length > 0) {
          walkTokensWithCursor(formatted.tokens, markdown, cursorRef, tokenEnd, blockIndex, out);
        } else if ('text' in formatted && typeof formatted.text === 'string') {
          pushWordsFromSlice(formatted.text, cursorRef.pos, blockIndex, out);
        }
        cursorRef.pos = tokenEnd;
        break;
      }

      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          cursorRef.pos = tokenStart;
          walkTokensWithCursor(textToken.tokens, markdown, cursorRef, tokenEnd, blockIndex, out);
          cursorRef.pos = tokenEnd;
        } else {
          pushWordsFromSlice(textToken.raw, tokenStart, blockIndex, out);
          cursorRef.pos = tokenEnd;
        }
        break;
      }

      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        cursorRef.pos = tokenStart;
        if (pToken.tokens && pToken.tokens.length > 0) {
          walkTokensWithCursor(pToken.tokens, markdown, cursorRef, tokenEnd, blockIndex, out);
        } else {
          pushWordsFromSlice(pToken.text, tokenStart, blockIndex, out);
        }
        cursorRef.pos = tokenEnd;
        break;
      }

      default: {
        if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
          cursorRef.pos = tokenStart;
          walkTokensWithCursor(
            (token as { tokens: Token[] }).tokens,
            markdown,
            cursorRef,
            tokenEnd,
            blockIndex,
            out,
          );
          cursorRef.pos = tokenEnd;
        } else if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          pushWordsFromSlice((token as { text: string }).text, tokenStart, blockIndex, out);
          cursorRef.pos = tokenEnd;
        } else {
          cursorRef.pos = tokenEnd;
        }
        break;
      }
    }
  }
}

export function extractMarkdownBlockTokens(markdown: string): MarkdownBlockTokenAlignment[] {
  const topTokens = lexer(markdown);
  const blocks: MarkdownBlockTokenAlignment[] = [];
  let cursor = 0;
  let blockIndex = 0;

  for (const token of topTokens) {
    const rawIdx = markdown.indexOf(token.raw, cursor);
    const mdStart = rawIdx !== -1 ? rawIdx : cursor;
    const mdEnd = mdStart + token.raw.length;
    cursor = mdEnd;

    switch (token.type) {
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const prefixMatch = hToken.raw.match(/^\s{0,3}#{1,6}[ \t]+/);
        const contentStart = mdStart + (prefixMatch ? prefixMatch[0].length : 0);
        const tokens: MarkdownWordToken[] = [];
        const cursorRef = { pos: contentStart };
        walkTokensWithCursor(hToken.tokens, markdown, cursorRef, mdEnd, blockIndex, tokens);
        if (tokens.length > 0) {
          blocks.push({ blockIndex, mdStart, mdEnd, tokens });
          blockIndex += 1;
        }
        break;
      }

      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        const tokens: MarkdownWordToken[] = [];
        const cursorRef = { pos: mdStart };
        walkTokensWithCursor(pToken.tokens, markdown, cursorRef, mdEnd, blockIndex, tokens);
        if (tokens.length > 0) {
          blocks.push({ blockIndex, mdStart, mdEnd, tokens });
          blockIndex += 1;
        }
        break;
      }

      case 'list': {
        const listToken = token as Tokens.List;
        let itemCursor = 0;
        for (const item of listToken.items) {
          const itemRelIdx = listToken.raw.indexOf(item.raw, itemCursor);
          const itemStart = mdStart + (itemRelIdx !== -1 ? itemRelIdx : itemCursor);
          const itemEnd = itemStart + item.raw.length;
          itemCursor = (itemRelIdx !== -1 ? itemRelIdx : itemCursor) + item.raw.length;

          const itemPrefix = item.raw.match(/^[ \t]*(?:[*+-]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/);
          const contentStart = itemStart + (itemPrefix ? itemPrefix[0].length : 0);
          const tokens: MarkdownWordToken[] = [];
          const cursorRef = { pos: contentStart };
          walkTokensWithCursor(item.tokens, markdown, cursorRef, itemEnd, blockIndex, tokens);
          if (tokens.length > 0) {
            blocks.push({ blockIndex, mdStart: itemStart, mdEnd: itemEnd, tokens });
            blockIndex += 1;
          }
        }
        break;
      }

      case 'blockquote': {
        const quoteToken = token as Tokens.Blockquote;
        const prefixMatch = quoteToken.raw.match(/^[ \t]*>[ \t]?/);
        const contentStart = mdStart + (prefixMatch ? prefixMatch[0].length : 0);
        const tokens: MarkdownWordToken[] = [];
        const cursorRef = { pos: contentStart };
        walkTokensWithCursor(quoteToken.tokens, markdown, cursorRef, mdEnd, blockIndex, tokens);
        if (tokens.length > 0) {
          blocks.push({ blockIndex, mdStart, mdEnd, tokens });
          blockIndex += 1;
        }
        break;
      }

      default:
        break;
    }
  }

  return blocks;
}

interface CandidateAlignedWord {
  word: AlignedWord;
  normalized: string;
}

function resolveCandidateWordNormalized(
  w: AlignedWord,
  transcript: string,
): string {
  const maybeNamed = w as AlignedWord & { word?: string; text?: string };
  if (typeof maybeNamed.word === 'string' && maybeNamed.word.length > 0) {
    return normalizeSpeakableToken(maybeNamed.word);
  }
  if (typeof maybeNamed.text === 'string' && maybeNamed.text.length > 0) {
    return normalizeSpeakableToken(maybeNamed.text);
  }
  if (
    w.charStart < 0 ||
    w.charEnd <= w.charStart ||
    w.charEnd > transcript.length
  ) {
    return '';
  }
  const slice = transcript.slice(w.charStart, w.charEnd);
  if (!slice || /\s/.test(slice)) {
    return '';
  }
  return normalizeSpeakableToken(slice);
}

function alignTokenSequence(
  mdTokens: MarkdownWordToken[],
  candidates: CandidateAlignedWord[],
): void {
  const n = mdTokens.length;
  const m = candidates.length;
  if (n === 0 || m === 0) return;

  if (n * m <= 250_000) {
    // Dynamic-programming LCS for optimal alignment within blocks
    const dp = new Int32Array((n + 1) * (m + 1));
    const width = m + 1;

    for (let i = n - 1; i >= 0; i--) {
      const mNorm = mdTokens[i]!.normalized;
      const rowOffset = i * width;
      const nextRowOffset = (i + 1) * width;
      for (let j = m - 1; j >= 0; j--) {
        if (mNorm.length > 0 && mNorm === candidates[j]!.normalized) {
          dp[rowOffset + j] = 1 + dp[nextRowOffset + j + 1]!;
        } else {
          const skipM = dp[nextRowOffset + j]!;
          const skipW = dp[rowOffset + j + 1]!;
          dp[rowOffset + j] = skipM >= skipW ? skipM : skipW;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      const mTok = mdTokens[i]!;
      const cWord = candidates[j]!;
      if (mTok.normalized.length > 0 && mTok.normalized === cWord.normalized) {
        mTok.alignedWord = cWord.word;
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j]! > dp[i * width + j + 1]!) {
        i += 1;
      } else {
        j += 1;
      }
    }
    return;
  }

  // Greedy windowed fallback for very large unmapped documents
  let j = 0;
  const windowSize = 16;
  for (let i = 0; i < n && j < m; i++) {
    const mTok = mdTokens[i]!;
    if (!mTok.normalized) continue;
    for (let look = 0; look < windowSize && j + look < m; look++) {
      if (candidates[j + look]!.normalized === mTok.normalized) {
        mTok.alignedWord = candidates[j + look]!.word;
        j = j + look + 1;
        break;
      }
    }
  }
}

function resolveWordFromChunks(
  w: AlignedWord,
  chunks: readonly AlignedChunk[] | undefined,
): string {
  if (!chunks || chunks.length === 0) return '';
  for (const chunk of chunks) {
    const relStart = w.charStart - chunk.docOffset;
    const relEnd = w.charEnd - chunk.docOffset;
    if (relStart >= 0 && relEnd > relStart && relEnd <= chunk.text.length) {
      const slice = chunk.text.slice(relStart, relEnd);
      if (slice && !/\s/.test(slice)) {
        const norm = normalizeSpeakableToken(slice);
        if (norm) return norm;
      }
    }
  }
  return '';
}

/**
 * Aligns speakable words inside a Markdown document to `AlignedWord[]` timings.
 * If `sourceMap` is provided, aligns within each block's `[transcriptStart, transcriptEnd]` slice;
 * otherwise aligns across the whole document.
 * Sets `fallbackToPlain: true` when `words.length > 0` and `matchRatio < 0.85`.
 */
export function alignMarkdownWords(
  markdown: string,
  words: readonly AlignedWord[],
  sourceMap?: TranscriptSourceMap,
  chunks?: readonly AlignedChunk[],
): MarkdownAlignmentResult {
  const tokensByBlock = extractMarkdownBlockTokens(markdown);
  const alignedByMdOffset = new Map<number, AlignedWord>();

  const allTokens: MarkdownWordToken[] = [];
  for (const block of tokensByBlock) {
    for (const token of block.tokens) {
      allTokens.push(token);
    }
  }

  if (allTokens.length === 0 || words.length === 0) {
    return {
      alignedByMdOffset,
      matchRatio: words.length === 0 ? 1 : 0,
      fallbackToPlain: false,
      tokensByBlock,
    };
  }

  const mapDefault = buildTranscriptSourceMap(markdown, { preserveHeadings: false });
  const mapPreserved = buildTranscriptSourceMap(markdown, { preserveHeadings: true });

  let defaultValid = 0;
  let preservedValid = 0;
  for (const w of words) {
    if (resolveCandidateWordNormalized(w, mapDefault.transcript)) defaultValid += 1;
    if (resolveCandidateWordNormalized(w, mapPreserved.transcript)) preservedValid += 1;
  }
  const bestMap = preservedValid > defaultValid ? mapPreserved : mapDefault;
  const bestTranscript = bestMap.transcript;
  const effectiveSourceMap =
    sourceMap && sourceMap.blocks.length > 0 ? sourceMap : bestMap.sourceMap;

  const candidates: CandidateAlignedWord[] = words.map((w) => ({
    word: w,
    normalized:
      resolveWordFromChunks(w, chunks) ||
      resolveCandidateWordNormalized(w, bestTranscript),
  }));

  const maxCandidateCharEnd = candidates.reduce(
    (max, c) => Math.max(max, c.word.charEnd),
    0,
  );

  if (effectiveSourceMap && effectiveSourceMap.blocks.length > 0) {
    for (const block of tokensByBlock) {
      const matchingMapBlocks = effectiveSourceMap.blocks.filter(
        (b) => b.mdStart < block.mdEnd && b.mdEnd > block.mdStart,
      );
      if (matchingMapBlocks.length === 0) continue;

      const tStart = Math.min(...matchingMapBlocks.map((b) => b.transcriptStart));
      const tEnd = Math.max(...matchingMapBlocks.map((b) => b.transcriptEnd));
      const blockCandidates = candidates.filter(
        (c) => c.word.charStart < tEnd && c.word.charEnd > tStart,
      );
      alignTokenSequence(block.tokens, blockCandidates);
    }

    const validCandidateCount = candidates.filter((c) => c.normalized.length > 0).length;
    const blockMatchedCount = allTokens.filter((t) => Boolean(t.alignedWord)).length;
    const expectedMinMatches = Math.min(allTokens.length, validCandidateCount) * 0.85;
    if (blockMatchedCount < expectedMinMatches) {
      const savedBlockMatches = allTokens.map((t) => t.alignedWord);
      for (const token of allTokens) {
        token.alignedWord = undefined;
      }
      const reachableBlockIndices = new Set<number>();
      for (const block of tokensByBlock) {
        const matchingMapBlocks = effectiveSourceMap.blocks.filter(
          (b) => b.mdStart < block.mdEnd && b.mdEnd > block.mdStart,
        );
        const tStart =
          matchingMapBlocks.length > 0
            ? Math.min(...matchingMapBlocks.map((b) => b.transcriptStart))
            : 0;
        if (tStart <= maxCandidateCharEnd + 32) {
          reachableBlockIndices.add(block.blockIndex);
        }
      }
      const reachableTokens =
        reachableBlockIndices.size > 0
          ? allTokens.filter((t) => reachableBlockIndices.has(t.blockIndex))
          : allTokens;
      alignTokenSequence(reachableTokens, candidates);
      const fullMatchedCount = allTokens.filter((t) => Boolean(t.alignedWord)).length;
      if (fullMatchedCount < blockMatchedCount) {
        allTokens.forEach((token, idx) => {
          token.alignedWord = savedBlockMatches[idx];
        });
      }
    }
  } else {
    alignTokenSequence(allTokens, candidates);
  }

  let matchedCount = 0;
  for (const token of allTokens) {
    if (token.alignedWord) {
      matchedCount += 1;
      alignedByMdOffset.set(token.rawStart, token.alignedWord);
      const leadingPunctMatch = token.text.match(/^[^a-zA-Z0-9]+/);
      if (leadingPunctMatch) {
        const trimmedStart = token.rawStart + leadingPunctMatch[0].length;
        if (!alignedByMdOffset.has(trimmedStart)) {
          alignedByMdOffset.set(trimmedStart, token.alignedWord);
        }
      }
    }
  }

  const matchRatio = matchedCount / allTokens.length;
  const fallbackToPlain = words.length > 0 && matchRatio < 0.85;

  return {
    alignedByMdOffset,
    matchRatio,
    fallbackToPlain,
    tokensByBlock,
  };
}
