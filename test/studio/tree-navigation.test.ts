import { describe, expect, it } from 'bun:test';
import {
  buildTreeNodeHref,
  computeFolderSelectionState,
  getDescendantDocIds,
  parseTreePathname,
  resolveTreeRouteTarget,
} from '../../studio/src/lib/tree-client';
import {
  InMemoryTreeStore,
  resolveTreeNode,
  walkTreeOrder,
} from '../../studio/src/lib/tree-fakes';
import {
  WorkspaceStore,
  treeNodeWorkspaceId,
  workspaceRoute,
} from '../../studio/src/lib/workspace';
import {
  isWorkRoute,
  workspaceItems,
} from '../../studio/src/lib/workspace-navigation';

describe('Tree URL & Route Resolution (buildTreeNodeHref & resolveTreeRouteTarget)', () => {
  it('builds canonical node hrefs with URL-encoded path segments and ?node=<id>', () => {
    const href = buildTreeNodeHref('tr_alpha', {
      id: 'nd_42',
      path: 'architecture/01 storage & media.md',
    });
    expect(href).toBe(
      '/trees/tr_alpha/architecture/01%20storage%20%26%20media.md?node=nd_42',
    );
  });

  it('resolves exact ?node=<nodeId> even when URL path segments are stale and returns canonicalHref', async () => {
    const store = new InMemoryTreeStore('user_1');
    const tree = await store.createTree('user_1', {
      title: 'Q4 Architecture',
      ops: [
        { op: 'put_doc', path: 'overview/01-vision.md', markdown: '# Vision' },
        { op: 'put_doc', path: 'backend/storage.md', markdown: '# Storage' },
      ],
    });

    const storageNode = resolveTreeNode(tree, 'backend/storage.md')!.node;

    // Move backend/storage.md -> core/01-storage.md
    const movedTree = await store.applyOps('user_1', tree.id, [
      { op: 'move', target: storageNode.id, toPath: 'core/01-storage.md' },
    ]);

    // Stale path in URL with valid ?node=<id> returns the node + new canonicalHref for history.replaceState
    const staleResolution = resolveTreeRouteTarget(
      movedTree,
      ['backend', 'storage.md'],
      storageNode.id,
    );
    expect(staleResolution.node?.id).toBe(storageNode.id);
    expect(staleResolution.matchedVia).toBe('id');
    expect(staleResolution.canonicalHref).toBe(
      buildTreeNodeHref(movedTree.id, movedTree.nodes[storageNode.id]!),
    );

    // Current canonical path in URL with valid ?node=<id> has canonicalHref === null
    const freshResolution = resolveTreeRouteTarget(
      movedTree,
      ['core', '01-storage.md'],
      storageNode.id,
    );
    expect(freshResolution.node?.id).toBe(storageNode.id);
    expect(freshResolution.matchedVia).toBe('id');
    expect(freshResolution.canonicalHref).toBeNull();
  });

  it('resolves exact virtual paths both with and without .md extension', async () => {
    const store = new InMemoryTreeStore('user_1');
    const tree = await store.createTree('user_1', {
      title: 'Docs',
      ops: [
        {
          op: 'put_doc',
          path: 'architecture/media-resolution.md',
          markdown: '# Media Resolution',
        },
      ],
    });

    const expectedNode = resolveTreeNode(
      tree,
      'architecture/media-resolution.md',
    )!.node;

    const withExtension = resolveTreeRouteTarget(tree, [
      'architecture',
      'media-resolution.md',
    ]);
    expect(withExtension.node?.id).toBe(expectedNode.id);
    expect(withExtension.matchedVia).toBe('path');
    expect(withExtension.canonicalHref).toBeNull();

    const withoutExtension = resolveTreeRouteTarget(tree, [
      'architecture',
      'media-resolution',
    ]);
    expect(withoutExtension.node?.id).toBe(expectedNode.id);
    expect(withoutExtension.matchedVia).toBe('path');
    expect(withoutExtension.canonicalHref).toBeNull();
  });

  it('resolves historical previousPaths after move and organize operations', async () => {
    const store = new InMemoryTreeStore('user_1');
    const tree = await store.createTree('user_1', {
      title: 'Design System',
      ops: [
        { op: 'put_doc', path: 'drafts/subgrid.md', markdown: '# Subgrid' },
        { op: 'put_doc', path: 'drafts/tokens.md', markdown: '# Tokens' },
      ],
    });

    const subgridNode = resolveTreeNode(tree, 'drafts/subgrid.md')!.node;
    const tokensNode = resolveTreeNode(tree, 'drafts/tokens.md')!.node;

    // 1. Move operation
    const afterMove = await store.applyOps('user_1', tree.id, [
      { op: 'move', target: subgridNode.id, toPath: 'standards/subgrid.md' },
    ]);

    const resolvedAfterMove = resolveTreeRouteTarget(afterMove, [
      'drafts',
      'subgrid.md',
    ]);
    expect(resolvedAfterMove.node?.id).toBe(subgridNode.id);
    expect(resolvedAfterMove.matchedVia).toBe('previous_path');
    expect(resolvedAfterMove.canonicalHref).toBe(
      `/trees/${encodeURIComponent(afterMove.id)}/standards/subgrid.md?node=${encodeURIComponent(subgridNode.id)}`,
    );

    // 2. Declarative organize operation
    const afterOrganize = await store.applyOps('user_1', tree.id, [
      {
        op: 'organize',
        entries: [
          {
            path: 'foundations',
            children: [
              { path: 'foundations/01-subgrid.md', nodeId: subgridNode.id },
              { path: 'foundations/02-tokens.md', nodeId: tokensNode.id },
            ],
          },
        ],
      },
    ]);

    const resolvedViaFirstPath = resolveTreeRouteTarget(afterOrganize, [
      'drafts',
      'subgrid',
    ]);
    expect(resolvedViaFirstPath.node?.id).toBe(subgridNode.id);
    expect(resolvedViaFirstPath.matchedVia).toBe('previous_path');
    expect(resolvedViaFirstPath.canonicalHref).toBe(
      `/trees/${encodeURIComponent(afterOrganize.id)}/foundations/01-subgrid.md?node=${encodeURIComponent(subgridNode.id)}`,
    );

    const resolvedTokensPrev = resolveTreeRouteTarget(afterOrganize, [
      'drafts',
      'tokens.md',
    ]);
    expect(resolvedTokensPrev.node?.id).toBe(tokensNode.id);
    expect(resolvedTokensPrev.matchedVia).toBe('previous_path');
    expect(resolvedTokensPrev.canonicalHref).toBe(
      `/trees/${encodeURIComponent(afterOrganize.id)}/foundations/02-tokens.md?node=${encodeURIComponent(tokensNode.id)}`,
    );
  });

  it('defaults to the first document in walkTreeOrder when visiting /trees/[treeId]', async () => {
    const store = new InMemoryTreeStore('user_1');
    const tree = await store.createTree('user_1', {
      title: 'Handbook',
      ops: [
        { op: 'mkdir', path: '00-empty-folder' },
        { op: 'put_doc', path: '01-getting-started/welcome.md', markdown: '# Welcome' },
        { op: 'put_doc', path: '02-deep-dive/engine.md', markdown: '# Engine' },
      ],
    });

    const orderedDocs = walkTreeOrder(tree.rootIds, tree.nodes).filter(
      (n) => n.kind === 'doc',
    );
    expect(orderedDocs.length).toBe(2);

    const rootResolution = resolveTreeRouteTarget(tree, undefined, null);
    expect(rootResolution.matchedVia).toBe('default_first_doc');
    expect(rootResolution.node?.id).toBe(orderedDocs[0]!.id);
    expect(rootResolution.node?.path).toBe('01-getting-started/welcome.md');
    expect(rootResolution.canonicalHref).toBeNull();
  });

  it('computes tri-state folder selection and parses tree pathnames', async () => {
    const store = new InMemoryTreeStore('user_1');
    const tree = await store.createTree('user_1', {
      title: 'Selection Tree',
      ops: [
        { op: 'put_doc', path: 'guides/a.md', markdown: '# A' },
        { op: 'put_doc', path: 'guides/b.md', markdown: '# B' },
      ],
    });
    const guidesFolder = resolveTreeNode(tree, 'guides')!.node;
    const docA = resolveTreeNode(tree, 'guides/a.md')!.node;

    expect(getDescendantDocIds(tree, guidesFolder.id)).toEqual([
      docA.id,
      resolveTreeNode(tree, 'guides/b.md')!.node.id,
    ]);
    expect(computeFolderSelectionState(tree, guidesFolder.id)).toBe(false);

    const partialTree = await store.applyOps('user_1', tree.id, [
      { op: 'select', targets: [docA.id], mode: 'set' },
    ]);
    expect(computeFolderSelectionState(partialTree, guidesFolder.id)).toBe(
      'indeterminate',
    );

    const fullTree = await store.applyOps('user_1', tree.id, [
      { op: 'select', targets: [guidesFolder.id], mode: 'set' },
    ]);
    expect(computeFolderSelectionState(fullTree, guidesFolder.id)).toBe(true);

    expect(parseTreePathname('/trees/tr_99/guides/a.md')).toEqual({
      treeId: 'tr_99',
      pathSegments: ['guides', 'a.md'],
    });
    expect(parseTreePathname('/library')).toEqual({
      treeId: null,
      pathSegments: [],
    });
  });

  it('isolates workspace state keys per treeId:nodeId so documents in the same tree preserve independent scroll and fields', () => {
    expect(treeNodeWorkspaceId('tr_100', 'nd_1')).toBe('tr_100:nd_1');
    expect(treeNodeWorkspaceId('tr_100', 'nd_2')).toBe('tr_100:nd_2');

    const routeA = workspaceRoute(
      '/trees/tr_100/overview/01-vision.md?node=nd_1',
    );
    const routeB = workspaceRoute(
      '/trees/tr_100/architecture/storage.md?node=nd_2',
    );
    expect(routeA?.key).toBe('/trees/tr_100:nd_1');
    expect(routeB?.key).toBe('/trees/tr_100:nd_2');
    expect(routeA?.key).not.toBe(routeB?.key);

    const workspace = new WorkspaceStore('user_test');
    const tabA = workspace.visit(
      '/trees/tr_100/overview/01-vision.md?node=nd_1',
    );
    expect(tabA).not.toBeNull();
    workspace.updateTab(tabA!.id, { scrollTop: 320, pinned: true });
    workspace.setField(tabA!.id, 'presetDraft', 'Core Overview');

    const tabB = workspace.visit(
      '/trees/tr_100/architecture/storage.md?node=nd_2',
    );
    expect(tabB).not.toBeNull();
    expect(tabB!.id).not.toBe(tabA!.id);
    workspace.updateTab(tabB!.id, { scrollTop: 840 });

    // Re-visiting node 1 restores its independent scrollTop and fields
    const revisitedA = workspace.visit(
      '/trees/tr_100/overview/01-vision.md?node=nd_1',
    );
    expect(revisitedA?.id).toBe(tabA!.id);
    expect(revisitedA?.scrollTop).toBe(320);
    expect(revisitedA?.fields.presetDraft).toBe('Core Overview');

    const snapshot = workspace.getSnapshot();
    const savedB = snapshot.tabs.find((t) => t.id === tabB!.id);
    expect(savedB?.scrollTop).toBe(840);

    expect(isWorkRoute('/trees/tr_100/overview/01-vision.md?node=nd_1')).toBe(
      true,
    );
    const items = workspaceItems(snapshot);
    expect(items.some((item) => item.key === '/trees/tr_100:nd_1')).toBe(true);
    expect(items.some((item) => item.key === '/trees/tr_100:nd_2')).toBe(true);
  });
});
