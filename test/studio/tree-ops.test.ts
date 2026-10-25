import { describe, expect, it } from 'bun:test';
import {
  applyTreeOpsState,
  deriveDocTitle,
  formatMediaMarkdownRef,
  MAX_SERIALIZED_TREE_BYTES,
  normalizeVirtualPath,
  resolveTreeNode,
  walkTreeOrder,
} from '../../studio/src/lib/tree-ops';
import {
  MAX_PREVIOUS_PATHS,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  TreeOpError,
  type TreeDetail,
  type TreeDocument,
  type TreeNodeId,
} from '../../studio/src/lib/tree-types';

function makeEmptyTree(id = 'tr_1'): TreeDetail {
  return {
    id,
    title: 'Test Tree',
    description: '',
    nodeCount: 0,
    docCount: 0,
    selectedCount: 0,
    rootIds: [],
    nodes: {},
    selectedNodeIds: [],
    selectionSets: {},
    pathAssets: {},
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('tree-ops pure state engine', () => {
  it('normalizes paths and rejects invalid segments, control characters, and depth > 12', () => {
    expect(normalizeVirtualPath(' /docs/architecture\\storage.md/ ')).toBe('docs/architecture/storage.md');

    expect(() => normalizeVirtualPath('')).toThrow(TreeOpError);
    expect(() => normalizeVirtualPath('docs//storage.md')).toThrow(TreeOpError);
    expect(() => normalizeVirtualPath('docs/../secret.md')).toThrow(TreeOpError);
    expect(() => normalizeVirtualPath('docs/./file.md')).toThrow(TreeOpError);
    expect(() => normalizeVirtualPath('docs/bad\u0000name.md')).toThrow(TreeOpError);
    expect(() => normalizeVirtualPath(`docs/${'a'.repeat(201)}.md`)).toThrow(TreeOpError);

    // Depth 12 is allowed
    const depth12 = Array.from({ length: MAX_TREE_DEPTH }, (_, i) => `seg${i + 1}`).join('/');
    expect(normalizeVirtualPath(depth12)).toBe(depth12);

    // Depth 13 is rejected with max_depth_exceeded
    const depth13 = `${depth12}/extra.md`;
    let caught: TreeOpError | null = null;
    try {
      normalizeVirtualPath(depth13);
    } catch (err) {
      caught = err as TreeOpError;
    }
    expect(caught).toBeInstanceOf(TreeOpError);
    expect(caught?.code).toBe('max_depth_exceeded');
  });

  it('rejects NUL bytes in markdown and leaves original state untouched on failure', () => {
    const initial = makeEmptyTree();
    const initialDocs = new Map<TreeNodeId, TreeDocument>();

    const step1 = applyTreeOpsState(initial, initialDocs, [
      { op: 'put_doc', path: 'intro.md', markdown: '# Intro\n\nValid doc.' },
    ]);
    expect(step1.detail.docCount).toBe(1);

    // Second op in batch fails due to NUL byte; step1 state must remain unmutated
    expect(() =>
      applyTreeOpsState(step1.detail, step1.docs, [
        { op: 'put_doc', path: 'second.md', markdown: '# Second\n\nStill valid' },
        { op: 'put_doc', path: 'bad.md', markdown: 'Invalid \u0000 byte' },
      ]),
    ).toThrow(TreeOpError);

    expect(step1.detail.docCount).toBe(1);
    expect(step1.docs.size).toBe(1);
  });

  it('rejects moving a folder into itself or its descendant, and enforces max depth on subtree moves', () => {
    const initial = makeEmptyTree();
    const { detail, docs } = applyTreeOpsState(initial, new Map(), [
      { op: 'put_doc', path: 'a/b/c/doc.md', markdown: '# Deep Doc' },
      { op: 'mkdir', path: 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10' },
    ]);

    // Cycle check: moving 'a' into 'a' or 'a/b/sub'
    expect(() =>
      applyTreeOpsState(detail, docs, [{ op: 'move', target: 'a', toPath: 'a' }]),
    ).toThrow(TreeOpError);

    expect(() =>
      applyTreeOpsState(detail, docs, [{ op: 'move', target: 'a', toPath: 'a/b/nested' }]),
    ).toThrow(TreeOpError);

    // Subtree depth check: moving 'a' (which has depth-4 child 'a/b/c/doc.md') under 'd1/.../d10' (depth 10) -> total depth 14 > 12
    expect(() =>
      applyTreeOpsState(detail, docs, [
        { op: 'move', target: 'a', toPath: 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/a' },
      ]),
    ).toThrow(TreeOpError);
  });

  it('bounds previousPaths to MAX_PREVIOUS_PATHS (10) and updates subtree doc paths on folder move', () => {
    let detail = makeEmptyTree();
    let docs = new Map<TreeNodeId, TreeDocument>();

    const created = applyTreeOpsState(detail, docs, [
      { op: 'put_doc', path: 'folder-0/guide.md', markdown: '# Guide' },
    ]);
    detail = created.detail;
    docs = created.docs;

    const docNode = resolveTreeNode(detail, 'folder-0/guide.md')!.node;

    for (let i = 1; i <= 14; i++) {
      const moved = applyTreeOpsState(detail, docs, [
        { op: 'move', target: `folder-${i - 1}`, toPath: `folder-${i}` },
      ]);
      detail = moved.detail;
      docs = moved.docs;
      expect(moved.touchedDocNodeIds).toContain(docNode.id);
    }

    const updatedDocNode = detail.nodes[docNode.id]!;
    expect(updatedDocNode.path).toBe('folder-14/guide.md');
    expect(updatedDocNode.previousPaths).toHaveLength(MAX_PREVIOUS_PATHS);
    expect(updatedDocNode.previousPaths[0]).toBe('folder-13/guide.md');
    expect(updatedDocNode.previousPaths[MAX_PREVIOUS_PATHS - 1]).toBe('folder-4/guide.md');
    expect(docs.get(docNode.id)?.path).toBe('folder-14/guide.md');
  });

  it('normalizes selectedNodeIds into canonical pre-order walkTreeOrder across select, move, and reorder', () => {
    const initial = makeEmptyTree();
    const s1 = applyTreeOpsState(initial, new Map(), [
      { op: 'put_doc', path: 'first.md', markdown: '# First' },
      { op: 'put_doc', path: 'second.md', markdown: '# Second' },
      { op: 'put_doc', path: 'third.md', markdown: '# Third' },
      { op: 'select', mode: 'set', targets: ['third.md', 'first.md'] },
    ]);

    const firstId = resolveTreeNode(s1.detail, 'first.md')!.node.id;
    const secondId = resolveTreeNode(s1.detail, 'second.md')!.node.id;
    const thirdId = resolveTreeNode(s1.detail, 'third.md')!.node.id;

    expect(s1.selectionChanged).toBe(true);
    expect(s1.detail.selectedNodeIds).toEqual([firstId, thirdId]);

    // Reordering root so third.md comes first automatically re-normalizes selectedNodeIds order
    const s2 = applyTreeOpsState(s1.detail, s1.docs, [
      { op: 'reorder', folderPath: '', childOrder: [thirdId, secondId, firstId] },
    ]);
    expect(s2.detail.selectedNodeIds).toEqual([thirdId, firstId]);
  });

  it('builds a 1,000-node tree within the 900 KB serialized topology limit and rejects node 1,001', () => {
    const initial = makeEmptyTree();
    // Create 10 folders, each containing 99 docs = 10 + 990 = 1,000 nodes total
    const ops = [];
    for (let f = 0; f < 10; f++) {
      const folder = `section-${f}`;
      for (let d = 0; d < 99; d++) {
        ops.push({
          op: 'put_doc' as const,
          path: `${folder}/doc-${d}.md`,
          markdown: `# Document ${f}-${d}\n\nBody text.`,
        });
      }
    }

    const res = applyTreeOpsState(initial, new Map(), ops);
    expect(res.detail.nodeCount).toBe(MAX_TREE_NODES);
    expect(res.detail.docCount).toBe(990);

    const serializedBytes = Buffer.byteLength(JSON.stringify(res.detail), 'utf8');
    expect(serializedBytes).toBeLessThan(MAX_SERIALIZED_TREE_BYTES);

    // Ensure TreeNodeMeta contains zero badge/noise fields (Rule 0 / Rule 1)
    const sampleNode = Object.values(res.detail.nodes)[0]!;
    expect('mediaTypes' in sampleNode).toBe(false);
    expect('durationMs' in sampleNode).toBe(false);
    expect('wordCount' in sampleNode).toBe(false);

    // Adding one more node exceeds MAX_TREE_NODES (1000)
    expect(() =>
      applyTreeOpsState(res.detail, res.docs, [
        { op: 'put_doc', path: 'overflow.md', markdown: '# Too many' },
      ]),
    ).toThrow(TreeOpError);
  });

  it('derives document titles and formats media markdown refs accurately', () => {
    expect(deriveDocTitle('# **Hello** _World_\n\nBody', 'fallback.md')).toBe('Hello World');
    expect(deriveDocTitle('No heading here.', '01-intro.md')).toBe('01-intro');

    expect(formatMediaMarkdownRef({ type: 'image', id: 'img_123' }, 'Diagram')).toBe(
      '![Diagram](mdmedia://image/img_123)',
    );
    expect(formatMediaMarkdownRef({ type: 'music', id: 'mus_1', generationId: 'gen_2' }, 'Theme')).toBe(
      '[Theme](mdmedia://music/mus_1@gen_2)',
    );
    expect(formatMediaMarkdownRef({ type: 'mermaid', id: 'graph LR; A-->B;' })).toBe(
      '```mermaid\ngraph LR; A-->B;\n```',
    );
  });
});
