import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import React, { createElement, type ReactElement } from 'react';

const studioReactDomServer = resolve(
  import.meta.dir,
  '../../studio/node_modules/react-dom/server.js',
);
if (!existsSync(studioReactDomServer)) {
  const req = createRequire(import.meta.url);
  const reactDomPkg = req('react-dom/package.json') as { version?: string };
  if (reactDomPkg.version && React.version !== reactDomPkg.version) {
    Object.defineProperty(React, 'version', {
      value: reactDomPkg.version,
      configurable: true,
      writable: true,
    });
  }
}
const { renderToStaticMarkup } = (await import(
  existsSync(studioReactDomServer)
    ? '../../studio/node_modules/react-dom/server'
    : 'react-dom/server'
)) as {
  renderToStaticMarkup: (element: ReactElement) => string;
};
import { TreeDocumentReader } from '../../studio/src/components/reader/tree-document-reader';
import { TooltipProvider } from '../../studio/src/components/ui/tooltip';
import {
  DEFAULT_GALLERY_FILTERS,
  countItems,
  filterGallery,
  isDefaultFilters,
  madeFacts,
  NOT_RECORDED,
  originLabel,
  parseGalleryBlock,
  presentFacets,
  recordedOr,
  stepItem,
  toggleValue,
  verdictLabel,
  visibleItemOrder,
  type GalleryBlock,
  type GalleryFilters,
} from '../../studio/src/lib/gallery-block';
import type { TreeDocument, TreeMediaRef } from '../../studio/src/lib/tree-types';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Work ${id}`,
    image: `images/${id === 'b1' ? SHA_B : SHA_A}.png`,
    href: `works/${id}.md`,
    origin: 'generated',
    verdict: 'accepted',
    made: {},
    ...extra,
  };
}

const BODY = {
  version: 1,
  title: 'Art research',
  futureField: { ignored: true },
  groups: [
    {
      id: 'intaglio',
      title: 'Intaglio-inspired linework',
      summary: 'Etched lines and plate tone.',
      href: 'directions/intaglio.md#overview',
      color: 'ignored',
      items: [
        item('a1', {
          origin: 'documented',
          verdict: null,
          caption: 'A river etched in fine lines.',
          made: {
            summary: 'Museum print.',
            source: { label: 'The Met record', url: 'https://www.metmuseum.org/art/1' },
          },
        }),
        item('a2', { verdict: 'rejected' }),
        item('a3', {
          verdict: 'awaiting-feedback',
          made: {
            prompt: 'Line one\nLine two',
            promptBasis: 'Recorded in generation.json',
            tool: 'Gemini image',
            model: null,
            settings: [{ label: 'Mode', value: 'image edit' }, { label: 'Broken' }],
            references: [{ label: 'River plate', role: 'style', image: `images/${SHA_B}.png` }],
            parent: { title: 'Work a2', href: 'works/a2.md' },
            records: [{ label: 'generation.json', href: 'records/a3/generation.json' }],
            note: 'The generation log is not retained here.',
          },
        }),
      ],
    },
    {
      id: 'woodcut',
      title: 'Woodcut',
      items: [
        item('b1', { origin: 'unknown', verdict: 'revision-requested' }),
        item('b2', { origin: 'mystery', verdict: 'maybe' }),
      ],
    },
  ],
};

function parsedBlock(body: unknown = BODY): GalleryBlock {
  const result = parseGalleryBlock(JSON.stringify(body));
  if (!result.ok) throw new Error(result.reason);
  return result.block;
}

const ids = (block: GalleryBlock, filters: GalleryFilters) =>
  visibleItemOrder(filterGallery(block, filters)).map((entry) => entry.id);

describe('parseGalleryBlock', () => {
  it('reads a version 1 body, keeping group and item order', () => {
    const block = parsedBlock();
    expect(block.version).toBe(1);
    expect(block.title).toBe('Art research');
    expect(block.groups.map((group) => group.id)).toEqual(['intaglio', 'woodcut']);
    expect(block.groups[0]!.items.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3']);
    expect(block.groups[0]!.href).toBe('directions/intaglio.md#overview');
    expect(block.groups[1]!.summary).toBeNull();
    expect(block.groups[1]!.href).toBeNull();
  });

  it('ignores unknown fields and narrows unknown enum values', () => {
    const block = parsedBlock();
    expect(JSON.stringify(block)).not.toContain('futureField');
    expect(JSON.stringify(block)).not.toContain('ignored');
    const b2 = block.groups[1]!.items[1]!;
    expect(b2.origin).toBe('unknown');
    expect(b2.verdict).toBeNull();
  });

  it('keeps prompts verbatim and drops incomplete settings, references and unsafe sources', () => {
    const made = parsedBlock().groups[0]!.items[2]!.made;
    expect(made.prompt).toBe('Line one\nLine two');
    expect(made.settings).toEqual([{ label: 'Mode', value: 'image edit' }]);
    expect(made.references).toEqual([
      { label: 'River plate', role: 'style', image: `images/${SHA_B}.png` },
    ]);
    expect(made.parent).toEqual({ title: 'Work a2', href: 'works/a2.md' });
    expect(made.records).toEqual([{ label: 'generation.json', href: 'records/a3/generation.json' }]);

    const unsafe = parsedBlock({
      groups: [
        {
          id: 'g',
          title: 'G',
          items: [item('x', { made: { source: { label: 'Bad', url: 'javascript:alert(1)' } } })],
        },
      ],
    });
    expect(unsafe.groups[0]!.items[0]!.made.source).toBeNull();
  });

  it('defaults every missing made field to null or empty, never inventing values', () => {
    const made = parsedBlock().groups[1]!.items[0]!.made;
    expect(made).toEqual({
      summary: null,
      prompt: null,
      promptBasis: null,
      tool: null,
      model: null,
      settings: [],
      references: [],
      parent: null,
      source: null,
      records: [],
      note: null,
    });
  });

  it('skips malformed items and groups and duplicate ids rather than failing the block', () => {
    const block = parsedBlock({
      version: 1,
      groups: [
        { id: 'g1', title: 'One', items: [item('x'), { id: 'no-image', title: 'T' }, 'nope', item('x')] },
        { id: 'g1', title: 'Duplicate group', items: [item('y')] },
        { title: 'No id', items: [item('z')] },
        { id: 'g2', title: 'No items' },
      ],
    });
    expect(block.title).toBeNull();
    expect(block.groups.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(block.groups[0]!.items.map((entry) => entry.id)).toEqual(['x']);
    expect(block.groups[1]!.items).toEqual([]);
  });

  it('keeps a work that appears in several groups, with a key per group for navigation', () => {
    const block = parsedBlock({
      version: 1,
      groups: [
        { id: 'washes', title: 'Washes', items: [item('laundromat'), item('pigment')] },
        { id: 'gouache', title: 'Gouache', items: [item('laundromat')] },
      ],
    });
    expect(countItems(block)).toBe(3);
    const order = visibleItemOrder(filterGallery(block, DEFAULT_GALLERY_FILTERS));
    expect(order.map((entry) => entry.key)).toEqual(['washes/laundromat', 'washes/pigment', 'gouache/laundromat']);
    expect(stepItem(order, 'washes/pigment', 1)?.key).toBe('gouache/laundromat');
    expect(stepItem(order, 'gouache/laundromat', -1)?.key).toBe('washes/pigment');
  });

  it('refuses bodies that are not JSON, not objects, have no groups, or use another version', () => {
    for (const source of ['{ not json', '[]', '"text"', '{"version":1}', '{"groups":{}}', '{"version":2,"groups":[]}']) {
      const result = parseGalleryBlock(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(parseGalleryBlock('{"groups":[]}').ok).toBe(true);
  });
});

describe('gallery labels', () => {
  it('names origins and verdicts in plain words', () => {
    expect(originLabel('documented')).toBe('Documented artwork');
    expect(originLabel('generated')).toBe('Generated study');
    expect(originLabel('unknown')).toBe('Unknown origin');
    expect(verdictLabel('accepted')).toBe('Accepted');
    expect(verdictLabel('awaiting-feedback')).toBe('Awaiting feedback');
    expect(verdictLabel('revision-requested')).toBe('Revision requested');
    expect(verdictLabel('rejected')).toBe('Rejected');
    expect(verdictLabel(null)).toBe('No verdict');
  });

  it('shows "Not recorded" for a missing tool, model or prompt', () => {
    expect(NOT_RECORDED).toBe('Not recorded');
    expect(recordedOr(null)).toBe('Not recorded');
    expect(recordedOr('Gemini image')).toBe('Gemini image');
    const facts = madeFacts(parsedBlock().groups[0]!.items[2]!.made);
    expect(facts).toEqual([
      { label: 'Tool', value: 'Gemini image', recorded: true },
      { label: 'Model', value: 'Not recorded', recorded: false },
    ]);
  });

  it('offers chips only for the origins and verdicts the block uses', () => {
    expect(presentFacets(parsedBlock())).toEqual({
      origins: ['documented', 'generated', 'unknown'],
      verdicts: ['awaiting-feedback', 'revision-requested', 'rejected', 'none'],
    });
  });
});

describe('gallery filters', () => {
  const block = parsedBlock();

  it('hides rejected items by default', () => {
    expect(DEFAULT_GALLERY_FILTERS.hideRejected).toBe(true);
    expect(isDefaultFilters(DEFAULT_GALLERY_FILTERS)).toBe(true);
    expect(ids(block, DEFAULT_GALLERY_FILTERS)).toEqual(['a1', 'a3', 'b1', 'b2']);
    expect(ids(block, { ...DEFAULT_GALLERY_FILTERS, hideRejected: false })).toEqual([
      'a1', 'a2', 'a3', 'b1', 'b2',
    ]);
  });

  it('filters by direction, origin and verdict together', () => {
    expect(ids(block, { ...DEFAULT_GALLERY_FILTERS, groups: ['woodcut'] })).toEqual(['b1', 'b2']);
    expect(ids(block, { ...DEFAULT_GALLERY_FILTERS, origins: ['documented', 'unknown'] })).toEqual([
      'a1', 'b1', 'b2',
    ]);
    expect(ids(block, { ...DEFAULT_GALLERY_FILTERS, verdicts: ['none'] })).toEqual(['a1', 'b2']);
    expect(
      ids(block, { ...DEFAULT_GALLERY_FILTERS, groups: ['intaglio'], origins: ['generated'] }),
    ).toEqual(['a3']);
  });

  it('shows rejected items when the verdict filter names them, even with Hide rejected on', () => {
    expect(ids(block, { ...DEFAULT_GALLERY_FILTERS, verdicts: ['rejected'] })).toEqual(['a2']);
  });

  it('drops rows with no visible items and reports an empty result', () => {
    const rows = filterGallery(block, { ...DEFAULT_GALLERY_FILTERS, verdicts: ['revision-requested'] });
    expect(rows.map((row) => row.group.id)).toEqual(['woodcut']);
    expect(
      filterGallery(block, { ...DEFAULT_GALLERY_FILTERS, groups: ['intaglio'], origins: ['unknown'] }),
    ).toEqual([]);
  });

  it('toggles chip selections', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
    expect(isDefaultFilters({ ...DEFAULT_GALLERY_FILTERS, hideRejected: false })).toBe(false);
  });

  it('steps through the visible items in row order and stops at either end', () => {
    const order = visibleItemOrder(filterGallery(block, DEFAULT_GALLERY_FILTERS));
    const keyOf = (id: string): string => order.find((entry) => entry.id === id)?.key ?? id;
    expect(stepItem(order, keyOf('a1'), 1)?.id).toBe('a3');
    expect(stepItem(order, keyOf('a3'), 1)?.id).toBe('b1');
    expect(stepItem(order, keyOf('b1'), -1)?.id).toBe('a3');
    expect(stepItem(order, keyOf('a1'), -1)).toBeNull();
    expect(stepItem(order, keyOf('b2'), 1)).toBeNull();
    expect(stepItem(order, keyOf('a2'), 1)).toBeNull();
  });
});

describe('<TreeDocumentReader /> gallery fences', () => {
  const pathAssets: Record<string, TreeMediaRef> = {
    [`images/${SHA_A}.png`]: { type: 'asset', id: 'pm_a' },
    [`images/${SHA_B}.png`]: { type: 'asset', id: 'pm_b' },
  };
  const baseDoc: TreeDocument = {
    id: 'doc_g',
    treeId: 'tr_g',
    nodeId: 'nd_g',
    path: 'gallery.md',
    title: 'Gallery',
    markdown: '',
    contentHash: 'hash_g',
    narrationId: null,
    narrationStatus: 'unvoiced',
    narrationStale: false,
    updatedAt: 1,
  };

  const render = (markdown: string) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(TreeDocumentReader, {
          document: { ...baseDoc, markdown },
          pathAssets,
          words: [],
          activeCharStart: null,
          activeCharEnd: null,
          spokenThrough: 0,
          audioLoaded: false,
          loadedDurationMs: 0,
          resolveDocHref: (raw) => `/trees/tr_g/${raw}`,
        }),
      ),
    );

  it('renders a gallery fence as filterable rows of cards and leaves mermaid alone', () => {
    const html = render(
      [
        '# Gallery',
        '',
        '```gallery',
        JSON.stringify(BODY, null, 2),
        '```',
        '',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
      ].join('\n'),
    );

    expect(html).toContain('data-gallery-block="ready"');
    expect(html).toContain('Art research');
    expect(html).toContain('data-gallery-group="intaglio"');
    expect(html).toContain('data-gallery-group="woodcut"');
    expect(html).toContain('data-gallery-item="a1"');
    expect(html).toContain('data-gallery-item="a3"');
    // Hide rejected is on by default.
    expect(html).not.toContain('data-gallery-item="a2"');
    expect(html).toMatch(/role="switch" aria-checked="true" data-gallery-filter="hide-rejected"/);
    expect(html).toContain('Documented artwork');
    expect(html).toContain('Generated study');
    expect(html).toContain('No verdict');
    expect(html).toContain('Revision requested');
    // Group "Read more" resolves like any doc link in the tree.
    expect(html).toContain('href="/trees/tr_g/directions/intaglio.md#overview"');
    // The JSON body is not shown as code.
    expect(html).not.toContain('futureField');

    expect(html).toContain('data-media-type="mermaid"');
  });

  it('falls back to the code block with a notice when the body is not a gallery', () => {
    const html = render(['```gallery', '{ "title": "no groups" }', '```'].join('\n'));
    expect(html).toContain('data-gallery-block="invalid"');
    expect(html).toContain('it has no groups');
    expect(html).toContain('no groups');
    expect(html).not.toContain('data-gallery-block="ready"');

    const broken = render(['```gallery', '{ not json', '```'].join('\n'));
    expect(broken).toContain('data-gallery-block="invalid"');
    expect(broken).toContain('not valid JSON');
  });
});
