import { describe, expect, it } from 'bun:test';
import {
  resolveTreeNode,
  walkTreeOrder,
} from '../../studio/src/lib/tree-fakes';
import {
  MAX_PREVIOUS_PATHS,
  TreeOpError,
  type NarrationStarterPort,
  type TreeStorePort,
} from '../../studio/src/lib/tree-types';

export interface TreeStoreContractContext {
  store: TreeStorePort;
  startedNarrations: Array<{
    uid: string;
    markdown: string;
    title: string;
    voice?: string;
    origin?: { treeId: string; nodeId?: string };
    narrationId: string;
  }>;
}

export function runTreeStoreContract(
  label: string,
  createContext: (narrationStarter: NarrationStarterPort) => Promise<TreeStorePort> | TreeStorePort,
): void {
  describe(`TreeStorePort contract (${label})`, () => {
    const setup = async (): Promise<TreeStoreContractContext> => {
      const startedNarrations: TreeStoreContractContext['startedNarrations'] = [];
      let counter = 0;
      const narrationStarter: NarrationStarterPort = {
        async start(uid, input) {
          counter += 1;
          const narrationId = `nar_contract_${counter}`;
          startedNarrations.push({ uid, ...input, narrationId });
          return { narrationId };
        },
      };
      const store = await createContext(narrationStarter);
      return { store, startedNarrations };
    };

    it('creates, lists, resolves by title or id, updates metadata, and deletes trees', async () => {
      const { store } = await setup();
      const created = await store.createTree('user_a', {
        title: 'Engineering Handbook',
        description: 'Architecture and onboarding',
      });
      expect(created.title).toBe('Engineering Handbook');
      expect(created.description).toBe('Architecture and onboarding');
      expect(created.revision).toBe(1);

      const list = await store.listTrees('user_a');
      expect(list.map((t) => t.id)).toContain(created.id);

      const byTitle = await store.getTree('user_a', 'engineering handbook');
      expect(byTitle.id).toBe(created.id);

      const updated = await store.updateTreeMeta('user_a', created.id, {
        title: 'Updated Handbook',
      });
      expect(updated.title).toBe('Updated Handbook');
      expect(updated.revision).toBeGreaterThan(created.revision);

      await store.deleteTree('user_a', created.id);
      await expect(store.getTree('user_a', created.id)).rejects.toBeInstanceOf(TreeOpError);
    });

    it('replays idempotent createTree and applyOps calls without duplicating operations', async () => {
      const { store } = await setup();
      const firstCreate = await store.createTree('user_a', {
        title: 'Idempotent Tree',
        idempotencyKey: 'create-key-1',
      });
      const secondCreate = await store.createTree('user_a', {
        title: 'Idempotent Tree',
        idempotencyKey: 'create-key-1',
      });
      expect(secondCreate.id).toBe(firstCreate.id);

      const afterOp1 = await store.applyOps(
        'user_a',
        firstCreate.id,
        [{ op: 'put_doc', path: 'intro.md', markdown: '# Intro\n\nWelcome.' }],
        { idempotencyKey: 'op-key-1' },
      );
      const afterOp2 = await store.applyOps(
        'user_a',
        firstCreate.id,
        [{ op: 'put_doc', path: 'intro.md', markdown: '# Intro\n\nWelcome.' }],
        { idempotencyKey: 'op-key-1' },
      );
      expect(afterOp2.revision).toBe(afterOp1.revision);
      expect(afterOp2.docCount).toBe(1);
    });

    it('enforces expectedRevision optimistic concurrency control with 409 conflict', async () => {
      const { store } = await setup();
      const tree = await store.createTree('user_a', { title: 'OCC Tree' });
      const rev1 = tree.revision;

      const updated = await store.applyOps(
        'user_a',
        tree.id,
        [{ op: 'mkdir', path: 'guides' }],
        { expectedRevision: rev1 },
      );
      expect(updated.revision).toBe(rev1 + 1);

      let caught: TreeOpError | null = null;
      try {
        await store.applyOps(
          'user_a',
          tree.id,
          [{ op: 'mkdir', path: 'stale' }],
          { expectedRevision: rev1 },
        );
      } catch (err) {
        caught = err as TreeOpError;
      }
      expect(caught).toBeInstanceOf(TreeOpError);
      expect(caught?.status).toBe(409);
      expect(caught?.code).toBe('revision_conflict');
    });

    it('supports put_doc, mkdir, move with bounded previousPaths, reorder, and remove', async () => {
      const { store } = await setup();
      const tree = await store.createTree('user_a', {
        title: 'Docs',
        ops: [
          { op: 'put_doc', path: '01-overview.md', markdown: '# System Overview\n\nHello.' },
          { op: 'put_doc', path: 'guides/setup.md', markdown: '# Setup Guide\n\nInstall bun.' },
          { op: 'put_doc', path: 'guides/deploy.md', markdown: '# Deployment\n\nShip it.' },
        ],
      });

      expect(tree.docCount).toBe(3);
      expect(tree.nodeCount).toBe(4); // 1 folder ('guides') + 3 docs

      const setupNode = resolveTreeNode(tree, 'guides/setup.md')?.node;
      expect(setupNode).toBeDefined();

      // Move setup.md 12 times to verify previousPaths is capped at MAX_PREVIOUS_PATHS (10)
      let currentTree = tree;
      for (let i = 1; i <= 12; i++) {
        currentTree = await store.applyOps('user_a', tree.id, [
          { op: 'move', target: setupNode!.id, toPath: `archive/v${i}/setup.md` },
        ]);
      }
      const movedNode = currentTree.nodes[setupNode!.id]!;
      expect(movedNode.path).toBe('archive/v12/setup.md');
      expect(movedNode.previousPaths).toHaveLength(MAX_PREVIOUS_PATHS);
      expect(movedNode.previousPaths[0]).toBe('archive/v11/setup.md');

      // Resolve via historical path
      const viaPrev = resolveTreeNode(currentTree, 'archive/v11/setup.md');
      expect(viaPrev?.node.id).toBe(setupNode!.id);
      expect(viaPrev?.matchedVia).toBe('previous_path');

      // Reject moving a folder into itself
      await expect(
        store.applyOps('user_a', tree.id, [
          { op: 'move', target: 'archive', toPath: 'archive/sub/nested' },
        ]),
      ).rejects.toBeInstanceOf(TreeOpError);

      // Reorder root nodes
      const reversedRoots = [...currentTree.rootIds].reverse();
      const reordered = await store.applyOps('user_a', tree.id, [
        { op: 'reorder', folderPath: '', childOrder: reversedRoots },
      ]);
      expect(reordered.rootIds).toEqual(reversedRoots);

      // Remove archive recursively
      const afterRemove = await store.applyOps('user_a', tree.id, [
        { op: 'remove', targets: ['archive'], recursive: true },
      ]);
      expect(afterRemove.nodes[setupNode!.id]).toBeUndefined();
    });

    it('orders selections in canonical tree order, expands folders to descendant docs, and compiles + narrates', async () => {
      const { store, startedNarrations } = await setup();
      const tree = await store.createTree('user_a', {
        title: 'Book',
        ops: [
          { op: 'put_doc', path: 'ch1/a.md', markdown: 'Chapter 1A content.' },
          { op: 'put_doc', path: 'ch1/b.md', markdown: 'Chapter 1B content.' },
          { op: 'put_doc', path: 'ch2/c.md', markdown: 'Chapter 2C content.' },
        ],
      });

      // Select ch2/c.md first, then ch1 folder; selection must be normalized into tree order (a, b, c)
      const afterSelect = await store.applyOps('user_a', tree.id, [
        { op: 'select', mode: 'set', targets: ['ch2/c.md', 'ch1'] },
      ]);
      const orderedPaths = afterSelect.selectedNodeIds.map((id) => afterSelect.nodes[id]!.path);
      expect(orderedPaths).toEqual(['ch1/a.md', 'ch1/b.md', 'ch2/c.md']);

      // Compile selection, save back into tree, and start a detached narration
      const compiled = await store.compileSelection('user_a', tree.id, {
        title: 'Full Book Narration',
        saveAsPath: 'compiled/full-book.md',
        narrate: true,
      });

      expect(compiled.title).toBe('Full Book Narration');
      expect(compiled.markdown).toContain('Chapter 1A content.');
      expect(compiled.markdown.indexOf('Chapter 1A content.')).toBeLessThan(
        compiled.markdown.indexOf('Chapter 2C content.'),
      );
      expect(compiled.savedNode?.path).toBe('compiled/full-book.md');
      expect(compiled.narrationId).toBeDefined();
      expect(startedNarrations).toHaveLength(1);

      // Editing a narrated document marks narrationStale: true
      await store.applyOps('user_a', tree.id, [
        {
          op: 'put_doc',
          path: 'compiled/full-book.md',
          markdown: '# Full Book Narration\n\nUpdated text after narration.',
        },
      ]);
      const editedDoc = await store.getDocument('user_a', tree.id, 'compiled/full-book.md');
      expect(editedDoc.narrationStale).toBe(true);

      // Clearing narration references resets narrationId and narrationStatus to 'unvoiced'
      if (store.clearNarrationReferences && compiled.narrationId) {
        await store.clearNarrationReferences('user_a', compiled.narrationId);
        const clearedDoc = await store.getDocument('user_a', tree.id, 'compiled/full-book.md');
        expect(clearedDoc.narrationId).toBeNull();
        expect(clearedDoc.narrationStatus).toBe('unvoiced');
        expect(clearedDoc.narrationStale).toBe(false);
      }
    });

    it('replaces or inserts media references via replace_media_ref and supports declarative organize', async () => {
      const { store } = await setup();
      const tree = await store.createTree('user_a', {
        title: 'Media Tree',
        ops: [
          {
            op: 'put_doc',
            path: 'scene.md',
            markdown: '# Scene\n\n![Hero](mdmedia://image/img_1)\n\n```mermaid\ngraph TD;\nA-->B;\n```\n',
          },
        ],
      });
      const sceneNode = resolveTreeNode(tree, 'scene.md')!.node;

      await store.applyOps('user_a', tree.id, [
        {
          op: 'replace_media_ref',
          nodeId: sceneNode.id,
          from: { type: 'image', id: 'img_1' },
          to: { type: 'video', id: 'vid_99' },
          placement: 'insert_below',
        },
        {
          op: 'replace_media_ref',
          nodeId: sceneNode.id,
          from: { type: 'mermaid', id: 'graph TD;\nA-->B;' },
          to: { type: 'image', id: 'img_diagram' },
          placement: 'replace',
        },
      ]);

      const updatedDoc = await store.getDocument('user_a', tree.id, sceneNode.id);
      expect(updatedDoc.markdown).toContain('![Hero](mdmedia://image/img_1)');
      expect(updatedDoc.markdown).toContain('![Media](mdmedia://video/vid_99)');
      expect(updatedDoc.markdown).toContain('![Media](mdmedia://image/img_diagram)');
      expect(updatedDoc.markdown).not.toContain('```mermaid');

      // Declarative organize moves scene.md into a new hierarchy
      const organized = await store.applyOps('user_a', tree.id, [
        {
          op: 'organize',
          entries: [
            {
              path: 'acts/act-1',
              children: [{ path: 'acts/act-1/opening-scene.md', nodeId: sceneNode.id }],
            },
          ],
        },
      ]);
      const walked = walkTreeOrder(organized.rootIds, organized.nodes).map((n) => n.path);
      expect(walked).toEqual(['acts', 'acts/act-1', 'acts/act-1/opening-scene.md']);
    });
  });
}
