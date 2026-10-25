import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from '../../studio/node_modules/react-dom/server';
import {
  parseMarkdownToSpeakableParagraphs,
  parseMarkdownToSpeakableSegments,
} from '../../src/chunker/index';
import { TreeDocumentReader } from '../../studio/src/components/reader/tree-document-reader';
import {
  alignMarkdownWords,
  buildTranscriptSourceMap,
  parseMediaUri,
} from '../../studio/src/lib/markdown-word-aligner';
import type { TreeDocument, TreeMediaRef } from '../../studio/src/lib/tree-types';
import type { AlignedWord } from '../../studio/src/lib/types';

function makeAlignedWordsFromTranscript(transcript: string): AlignedWord[] {
  const words: AlignedWord[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let clockMs = 100;

  while ((match = regex.exec(transcript)) !== null) {
    const token = match[0];
    if (/^[#>*+-]+$/.test(token)) continue;
    const charStart = match.index;
    const charEnd = charStart + token.length;
    words.push({
      startMs: clockMs,
      endMs: clockMs + 220,
      charStart,
      charEnd,
    });
    clockMs += 250;
  }

  return words;
}

describe('parseMarkdownToSpeakableSegments & buildTranscriptSourceMap', () => {
  const sampleMarkdown = [
    '# System Architecture Overview',
    '',
    'Welcome to the **Studio** tree reader with *inline* word alignment and [official guide](https://example.com/guide).',
    '',
    '- First bullet point with `treeDocs` lookup',
    '- Second bullet point for move-resilient routing',
    '',
    '1. Step one initializes topology',
    '2. Step two streams audio chunks',
    '',
    '> Every layout container uses intrinsic CSS Grid.',
    '',
    '```ts',
    'export const ignoredCode = 42;',
    '```',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[Tree] --> B[Reader]',
    '```',
    '',
    '<div>Raw HTML block skipped</div>',
    '',
    'Final conclusion paragraph.',
  ].join('\n');

  it('extracts speakable segments with accurate [mdStart, mdEnd] spans while skipping code, mermaid, and HTML blocks', () => {
    const segments = parseMarkdownToSpeakableSegments(sampleMarkdown);

    expect(segments.length).toBe(8);
    expect(segments[0]?.text).toBe('System Architecture Overview.');
    expect(sampleMarkdown.slice(segments[0]!.mdStart, segments[0]!.mdEnd)).toContain(
      '# System Architecture Overview',
    );

    // Code block, Mermaid diagram, and HTML block must not appear in speakable segments
    for (const seg of segments) {
      expect(seg.text).not.toContain('ignoredCode');
      expect(seg.text).not.toContain('flowchart');
      expect(seg.text).not.toContain('Raw HTML block');
      expect(seg.mdStart).toBeGreaterThanOrEqual(0);
      expect(seg.mdEnd).toBeGreaterThan(seg.mdStart);
      expect(seg.mdEnd).toBeLessThanOrEqual(sampleMarkdown.length);
    }

    // Backwards compatibility check on parseMarkdownToSpeakableParagraphs
    const legacyParagraphs = parseMarkdownToSpeakableParagraphs(
      '# Title\n\nSimple paragraph.',
    );
    expect(legacyParagraphs).toEqual(['Title.', 'Simple paragraph.']);
  });

  it('builds a version-1 TranscriptSourceMap whose transcript slices match every paragraph', () => {
    const { transcript, paragraphs, sourceMap } =
      buildTranscriptSourceMap(sampleMarkdown);

    expect(sourceMap.version).toBe(1);
    expect(sourceMap.blocks).toHaveLength(paragraphs.length);

    sourceMap.blocks.forEach((block, index) => {
      expect(transcript.slice(block.transcriptStart, block.transcriptEnd)).toBe(
        paragraphs[index],
      );
      expect(sampleMarkdown.slice(block.mdStart, block.mdEnd).length).toBeGreaterThan(
        0,
      );
    });
  });
});

describe('alignMarkdownWords', () => {
  const richMarkdown = [
    '# Unified Reader',
    '',
    'Read **formatted** prose with *italic* terms, `subgrid` tokens, and [deep links](https://example.com/docs/deep).',
    '',
    '- Unordered item alpha',
    '- Unordered item beta',
    '',
    '1. Ordered first step',
    '2. Ordered second step',
    '',
    '> Blockquote wisdom stays aligned.',
    '',
    '```ts',
    'function neverSpoken() { return true; }',
    '```',
    '',
    '```mermaid',
    'graph LR;',
    '  X --> Y;',
    '```',
    '',
    'Closing sentence after blocks.',
  ].join('\n');

  it('maps speakable words across headings, paragraphs, formatting, links, lists, and blockquotes to exact AlignedWord.startMs', () => {
    const { transcript, sourceMap } = buildTranscriptSourceMap(richMarkdown);
    const words = makeAlignedWordsFromTranscript(transcript);

    const alignment = alignMarkdownWords(richMarkdown, words, sourceMap);

    expect(alignment.fallbackToPlain).toBe(false);
    expect(alignment.matchRatio).toBeGreaterThanOrEqual(0.95);

    // Verify specific words inside different Markdown constructs resolve to their exact AlignedWord
    const checkWord = (targetSubstring: string, wordText: string) => {
      const subIdx = richMarkdown.indexOf(targetSubstring);
      expect(subIdx).toBeGreaterThanOrEqual(0);
      const wordOffset = subIdx + targetSubstring.indexOf(wordText);
      const aligned = alignment.alignedByMdOffset.get(wordOffset);
      expect(aligned).toBeDefined();
      const transcriptSlice = transcript
        .slice(aligned!.charStart, aligned!.charEnd)
        .toLowerCase();
      expect(transcriptSlice).toContain(wordText.toLowerCase());
      return aligned!;
    };

    const wHeading = checkWord('# Unified Reader', 'Unified');
    const wBold = checkWord('**formatted**', 'formatted');
    const wItalic = checkWord('*italic*', 'italic');
    const wCode = checkWord('`subgrid`', 'subgrid');
    const wLink = checkWord('[deep links]', 'deep');
    const wBullet = checkWord('- Unordered item alpha', 'alpha');
    const wOrdered = checkWord('2. Ordered second step', 'second');
    const wQuote = checkWord('> Blockquote wisdom', 'wisdom');
    const wClosing = checkWord('Closing sentence', 'Closing');

    // Monotonically increasing startMs across the document order
    expect(wHeading.startMs).toBeLessThan(wBold.startMs);
    expect(wBold.startMs).toBeLessThan(wItalic.startMs);
    expect(wItalic.startMs).toBeLessThan(wCode.startMs);
    expect(wCode.startMs).toBeLessThan(wLink.startMs);
    expect(wLink.startMs).toBeLessThan(wBullet.startMs);
    expect(wBullet.startMs).toBeLessThan(wOrdered.startMs);
    expect(wOrdered.startMs).toBeLessThan(wQuote.startMs);
    expect(wQuote.startMs).toBeLessThan(wClosing.startMs);

    // Words inside fenced code blocks or Mermaid diagrams must NOT be aligned
    const codeFnOffset = richMarkdown.indexOf('neverSpoken');
    expect(alignment.alignedByMdOffset.get(codeFnOffset)).toBeUndefined();
  });

  it('aligns across the full document when sourceMap is omitted', () => {
    const { transcript } = buildTranscriptSourceMap(richMarkdown);
    const words = makeAlignedWordsFromTranscript(transcript);

    const alignment = alignMarkdownWords(richMarkdown, words);
    expect(alignment.fallbackToPlain).toBe(false);
    expect(alignment.matchRatio).toBeGreaterThanOrEqual(0.95);
  });

  it('sets fallbackToPlain: true when matchRatio drops below 85%', () => {
    const { transcript, sourceMap } = buildTranscriptSourceMap(richMarkdown);
    const allWords = makeAlignedWordsFromTranscript(transcript);
    // Keep only the first 3 aligned words (~10% of the document)
    const partialWords = allWords.slice(0, 3);

    const alignment = alignMarkdownWords(richMarkdown, partialWords, sourceMap);
    expect(alignment.matchRatio).toBeLessThan(0.85);
    expect(alignment.fallbackToPlain).toBe(true);
  });

  it('aligns server narrations generated with preserveHeadings: true', () => {
    const { transcript, sourceMap } = buildTranscriptSourceMap(richMarkdown, {
      preserveHeadings: true,
    });
    const words = makeAlignedWordsFromTranscript(transcript);

    const alignment = alignMarkdownWords(richMarkdown, words, sourceMap);
    expect(alignment.fallbackToPlain).toBe(false);
    expect(alignment.matchRatio).toBeGreaterThanOrEqual(0.95);
  });
});

describe('parseMediaUri', () => {
  const pathAssets: Record<string, TreeMediaRef> = {
    'assets/hero.png': { type: 'image', id: 'img_hero_1' },
    'diagrams/flow.mp4': { type: 'video', id: 'vid_flow_2', generationId: 'gen_9' },
  };

  it('parses canonical mdmedia:// URIs with and without @generationId', () => {
    expect(parseMediaUri('mdmedia://image/img_123')).toEqual({
      type: 'image',
      id: 'img_123',
    });
    expect(parseMediaUri('mdmedia://image/img_123@gen_456')).toEqual({
      type: 'image',
      id: 'img_123',
      generationId: 'gen_456',
    });
    expect(parseMediaUri('mdmedia://video/vid_789@gen_clip2')).toEqual({
      type: 'video',
      id: 'vid_789',
      generationId: 'gen_clip2',
    });
    expect(parseMediaUri('mdmedia://music/mus_101')).toEqual({
      type: 'music',
      id: 'mus_101',
    });
    expect(parseMediaUri('mdmedia://sfx/sfx_202')).toEqual({
      type: 'sfx',
      id: 'sfx_202',
    });
    expect(parseMediaUri('mdmedia://asset/ast_303')).toEqual({
      type: 'asset',
      id: 'ast_303',
    });
  });

  it('resolves relative paths against pathAssets and normalizes leading ./ or ../', () => {
    expect(parseMediaUri('./assets/hero.png', pathAssets)).toEqual({
      type: 'image',
      id: 'img_hero_1',
    });
    expect(parseMediaUri('/assets/hero.png', pathAssets)).toEqual({
      type: 'image',
      id: 'img_hero_1',
    });
    expect(parseMediaUri('assets/hero.png', pathAssets)).toEqual({
      type: 'image',
      id: 'img_hero_1',
    });
    expect(
      parseMediaUri('../diagrams/flow.mp4', pathAssets, 'guides/intro.md'),
    ).toEqual({
      type: 'video',
      id: 'vid_flow_2',
      generationId: 'gen_9',
    });
    expect(parseMediaUri('./assets/missing.png', pathAssets)).toBeNull();
  });

  it('returns null for external https://, http://, data:, and javascript: URLs', () => {
    expect(
      parseMediaUri('https://example.com/tracker.png', pathAssets),
    ).toBeNull();
    expect(parseMediaUri('http://example.com/image.jpg', pathAssets)).toBeNull();
    expect(
      parseMediaUri('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', pathAssets),
    ).toBeNull();
    expect(parseMediaUri('javascript:alert(1)', pathAssets)).toBeNull();
  });
});

describe('<TreeDocumentReader /> unified rendering, word highlighting & XSS safety', () => {
  const docMarkdown = [
    '# Unified Tree Reader',
    '',
    'Click any **spoken** word to seek playback.',
    '',
    '> Blockquote uses a 2px rule column.',
    '',
    '![Studio Hero](mdmedia://image/img_99)',
    '',
    '![External Beacon](https://evil.example.com/beacon.png)',
    '',
    '[Unsafe JS Link](javascript:alert(1))',
    '',
    '<script>window.pwned = true;</script>',
  ].join('\n');

  const doc: TreeDocument = {
    id: 'doc_1',
    treeId: 'tr_1',
    nodeId: 'nd_1',
    path: 'overview.md',
    title: 'Unified Tree Reader',
    markdown: docMarkdown,
    contentHash: 'hash_1',
    narrationId: 'nar_1',
    narrationStatus: 'ready',
    narrationStale: false,
    updatedAt: 1000,
  };

  it('renders interactive word buttons, highlights the active word, renders media cards, and blocks external <img> and XSS', () => {
    const { transcript, sourceMap } = buildTranscriptSourceMap(docMarkdown);
    const words = makeAlignedWordsFromTranscript(transcript);
    const activeWord = words[4]!; // "spoken"

    const html = renderToStaticMarkup(
      createElement(TreeDocumentReader, {
        document: doc,
        pathAssets: {},
        words,
        sourceMap,
        activeCharStart: activeWord.charStart,
        activeCharEnd: activeWord.charEnd,
        spokenThrough: activeWord.charEnd,
        audioLoaded: true,
        loadedDurationMs: 10_000,
        highlightColor: 'amber',
      }),
    );

    // Interactive word buttons and active highlight marker
    expect(html).toContain('role="button"');
    expect(html).toContain('data-word-active="true"');
    expect(html).toContain('data-spoken="true"');
    expect(html).toContain(`data-start-ms="${activeWord.startMs}"`);

    // Blockquote 2-column grid rule
    expect(html).toContain('grid-cols-[2px_minmax(0,1fr)]');

    // Internal mdmedia:// image rendered as DocumentMediaCard
    expect(html).toContain('data-media-type="image"');
    expect(html).toContain('data-media-id="img_99"');

    // External image rendered as safe external link, never an <img> tag
    expect(html).toContain('data-external-image="true"');
    expect(html).toContain('href="https://evil.example.com/beacon.png"');
    expect(html).not.toContain('<img src="https://evil.example.com/beacon.png"');

    // Unsafe javascript: link and raw <script> tag neutralized
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<script>window.pwned');
    expect(html).toContain('&lt;script&gt;');
  });

  it('highlights and makes already-synthesized words clickable even while streaming partial chunks', () => {
    const { transcript, sourceMap } = buildTranscriptSourceMap(docMarkdown, {
      preserveHeadings: true,
    });
    const allWords = makeAlignedWordsFromTranscript(transcript);
    const streamingWords = allWords.slice(0, 5); // Only first 5 words arrived so far
    const activeWord = streamingWords[4]!; // "spoken"

    const html = renderToStaticMarkup(
      createElement(TreeDocumentReader, {
        document: doc,
        pathAssets: {},
        words: streamingWords,
        sourceMap,
        activeCharStart: activeWord.charStart,
        activeCharEnd: activeWord.charEnd,
        spokenThrough: activeWord.charEnd,
        audioLoaded: true,
        loadedDurationMs: 2_000,
        highlightColor: 'amber',
      }),
    );

    expect(html).toContain('data-word-active="true"');
    expect(html).toContain(`data-start-ms="${activeWord.startMs}"`);
    expect(html).toContain('data-word-selectable="true"');
    expect(html).toContain('hover:bg-foreground/10 active:bg-foreground/20');
    // Ungenerated blocks and words after the first 5 words are dimmed and non-selectable
    expect(html).toContain('data-spoken="false"');
    expect(html).toContain('data-word-selectable="false"');
    expect(html).toContain('text-ink-faint');
  });

  it('dims the entire document and disables word hover states when narration mode is toggled before audio is generated', () => {
    const html = renderToStaticMarkup(
      createElement(TreeDocumentReader, {
        document: doc,
        pathAssets: {},
        words: [],
        activeCharStart: null,
        activeCharEnd: null,
        spokenThrough: 0,
        audioLoaded: false,
        loadedDurationMs: 0,
        narrationActive: true,
        onSeekWord: () => {},
      }),
    );

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-word-selectable="true"');
    expect(html).not.toContain('hover:bg-foreground/10');
    expect(html).toContain('data-spoken="false"');
    expect(html).toContain('data-word-selectable="false"');
    expect(html).toContain('text-ink-faint');
  });

  it('resolves internal document links and .md codespans to canonical tree URLs', () => {
    const linkMarkdown = [
      '# Overview',
      '',
      'See [System Design](architecture/01-system-design.md) or `operations/01-runbook.md`.',
    ].join('\n');

    const html = renderToStaticMarkup(
      createElement(TreeDocumentReader, {
        document: { ...doc, markdown: linkMarkdown },
        pathAssets: {},
        words: [],
        activeCharStart: null,
        activeCharEnd: null,
        spokenThrough: 0,
        audioLoaded: false,
        loadedDurationMs: 0,
        resolveDocHref: (raw) => `/trees/tr_1/${raw}?node=nd_target`,
      }),
    );

    expect(html).toContain('href="/trees/tr_1/architecture/01-system-design.md?node=nd_target"');
    expect(html).toContain('href="/trees/tr_1/operations/01-runbook.md?node=nd_target"');
  });
});

