import { describe, expect, it } from 'bun:test';
import { mapChunkToMarkdown } from '../../src/chunker/markdown-mapper.js';
import type { ChunkTiming } from '../../src/storage/types.js';
import type { WordHighlight } from '../../src/audio/player/word-aligner.js';

describe('MarkdownChunkMapper (Seam 3)', () => {
  const sampleMarkdown = [
    '# Refactoring PlaybackEngine',
    '',
    '```ts',
    'public history: TrackMetadata[] = [];',
    '```',
    '',
    'We added a history stack to PlaybackEngine so calling prev() rewinds.',
  ].join('\n');

  it('resolves the active paragraph character range within fullMarkdown skipping code blocks', () => {
    const chunk: ChunkTiming = {
      chunkIndex: 1,
      startMs: 1000,
      endMs: 5000,
      text: 'We added a history stack to PlaybackEngine so calling prev() rewinds.',
    };

    const docHighlight = mapChunkToMarkdown(sampleMarkdown, chunk);
    expect(docHighlight).not.toBeNull();

    const extracted = sampleMarkdown.slice(docHighlight!.docCharStart, docHighlight!.docCharEnd);
    expect(extracted).toBe('We added a history stack to PlaybackEngine so calling prev() rewinds.');
  });

  it('resolves the exact word span within fullMarkdown when wordHighlight is provided', () => {
    const chunk: ChunkTiming = {
      chunkIndex: 1,
      startMs: 1000,
      endMs: 5000,
      text: 'We added a history stack to PlaybackEngine so calling prev() rewinds.',
    };

    const wordHighlight: WordHighlight = {
      wordIndex: 3,
      word: 'history',
      charStart: 11,
      charEnd: 18,
    };

    const docHighlight = mapChunkToMarkdown(sampleMarkdown, chunk, wordHighlight);
    expect(docHighlight).not.toBeNull();

    const extractedWord = sampleMarkdown.slice(docHighlight!.docCharStart, docHighlight!.docCharEnd);
    expect(extractedWord).toBe('history');
  });

  it('expands highlight to cover full inline code tick span (e.g. `origin/main`) and ignores markdown link URL targets', () => {
    const markdownWithLinksAndCode =
      'The implementation from [PR #283](https://github.com/google-labs-code/jitro-cli/pull/283) branched off `origin/main` at commit `4f5d6c9`.';
    const chunk: ChunkTiming = {
      chunkIndex: 0,
      startMs: 0,
      endMs: 4000,
      text: 'The implementation from PR #283 branched off origin/main at commit 4f5d6c9.',
    };

    // Word highlight on "origin/main" (starts at char 45 in chunk.text)
    const wordHighlight: WordHighlight = {
      wordIndex: 7,
      word: 'origin/main',
      charStart: chunk.text.indexOf('origin/main'),
      charEnd: chunk.text.indexOf('origin/main') + 'origin/main'.length,
    };

    const docHighlight = mapChunkToMarkdown(markdownWithLinksAndCode, chunk, wordHighlight);
    expect(docHighlight).not.toBeNull();

    const extractedSpan = markdownWithLinksAndCode.slice(
      docHighlight!.docCharStart,
      docHighlight!.docCharEnd
    );
    expect(extractedSpan).toBe('`origin/main`');
  });

  it('does not jump forward prematurely into a long codespan path when plain text words match path sub-words', () => {
    const markdown =
      'At the core of the system, all playback state flows directly through the playback engine module, located at `src/audio/player/playback-engine.ts`.';
    const chunk: ChunkTiming = {
      chunkIndex: 0,
      startMs: 0,
      endMs: 7000,
      text: 'At the core of the system, all playback state flows directly through the playback engine module, located at src/audio/player/playback-engine.ts.',
    };

    // 1. Plain text "playback" at index 31
    const wPlayback1: WordHighlight = {
      wordIndex: 7,
      word: 'playback',
      charStart: chunk.text.indexOf('all playback state') + 'all '.length,
      charEnd: chunk.text.indexOf('all playback state') + 'all playback'.length,
    };
    const docH1 = mapChunkToMarkdown(markdown, chunk, wPlayback1);
    expect(docH1).not.toBeNull();
    expect(markdown.slice(docH1!.docCharStart, docH1!.docCharEnd)).toBe('playback');
    expect(docH1!.docCharStart).toBe(markdown.indexOf('all playback state') + 'all '.length);

    // 2. Plain text "playback" at index 73
    const wPlayback2: WordHighlight = {
      wordIndex: 13,
      word: 'playback',
      charStart: chunk.text.indexOf('the playback engine') + 'the '.length,
      charEnd: chunk.text.indexOf('the playback engine') + 'the playback'.length,
    };
    const docH2 = mapChunkToMarkdown(markdown, chunk, wPlayback2);
    expect(docH2).not.toBeNull();
    expect(markdown.slice(docH2!.docCharStart, docH2!.docCharEnd)).toBe('playback');
    expect(docH2!.docCharStart).toBe(markdown.indexOf('the playback engine') + 'the '.length);

    // 3. Plain text "engine" at index 82
    const wEngine: WordHighlight = {
      wordIndex: 14,
      word: 'engine',
      charStart: chunk.text.indexOf('playback engine module') + 'playback '.length,
      charEnd: chunk.text.indexOf('playback engine module') + 'playback engine'.length,
    };
    const docH3 = mapChunkToMarkdown(markdown, chunk, wEngine);
    expect(docH3).not.toBeNull();
    expect(markdown.slice(docH3!.docCharStart, docH3!.docCharEnd)).toBe('engine');
    expect(docH3!.docCharStart).toBe(markdown.indexOf('playback engine module') + 'playback '.length);

    // 4. File path "src/audio/player/playback-engine.ts." aligns to the codespan
    const wPath: WordHighlight = {
      wordIndex: 18,
      word: 'src/audio/player/playback-engine.ts.',
      charStart: chunk.text.indexOf('src/audio/player/playback-engine.ts.'),
      charEnd: chunk.text.indexOf('src/audio/player/playback-engine.ts.') + 'src/audio/player/playback-engine.ts.'.length,
    };
    const docH4 = mapChunkToMarkdown(markdown, chunk, wPath);
    expect(docH4).not.toBeNull();
    expect(markdown.slice(docH4!.docCharStart, docH4!.docCharEnd)).toBe('`src/audio/player/playback-engine.ts`');
  });
});
