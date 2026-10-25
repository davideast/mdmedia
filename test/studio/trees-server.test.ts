import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  clearNarrationReferences,
  createFirestoreTreeStore,
  createInMemoryTreePersistenceAdapter,
  MAX_FIRESTORE_BATCH_DOCS,
  setServerTreeStoreForTests,
  treeBlobObjectPath,
} from '../../studio/src/lib/trees-server';
import { resolveTreeNode } from '../../studio/src/lib/tree-ops';
import {
  MAX_INLINE_DOC_BYTES,
  type NarrationStarterPort,
} from '../../studio/src/lib/tree-types';
import { runTreeStoreContract } from './tree-store-contract';

runTreeStoreContract('FirestoreTreeStore', (narrationStarter) => {
  const { db, storage } = createInMemoryTreePersistenceAdapter();
  return createFirestoreTreeStore({ db, storage, narrationStarter });
});

describe('FirestoreTreeStore storage spillover, batching, and detached narrations', () => {
  it('spills >200 KB markdown to Cloud Storage at trees/{uid}/{treeId}/blobs/{docId}.md and transparently loads it in getDocument and compileSelection', async () => {
    const { db, storage } = createInMemoryTreePersistenceAdapter();
    const store = createFirestoreTreeStore({ db, storage });

    const largeBody = `# Large Architecture Spec\n\n${'A'.repeat(MAX_INLINE_DOC_BYTES + 8192)}`;
    expect(Buffer.byteLength(largeBody, 'utf8')).toBeGreaterThan(MAX_INLINE_DOC_BYTES);

    const tree = await store.createTree('user_spill', {
      title: 'Spillover Tree',
      ops: [
        { op: 'put_doc', path: 'specs/large.md', markdown: largeBody },
        { op: 'put_doc', path: 'specs/small.md', markdown: '# Small Spec\n\nShort inline body.' },
      ],
    });

    const largeNode = resolveTreeNode(tree, 'specs/large.md')!.node;
    const smallNode = resolveTreeNode(tree, 'specs/small.md')!.node;
    const expectedBlobPath = treeBlobObjectPath('user_spill', tree.id, largeNode.docId!);

    // Verify raw Firestore record has empty inline markdown and points to storagePath
    const rawLargeRecord = await db.getDocumentRecord(largeNode.docId!);
    expect(rawLargeRecord).not.toBeNull();
    expect(rawLargeRecord?.markdown).toBe('');
    expect(rawLargeRecord?.storagePath).toBe(expectedBlobPath);
    expect(rawLargeRecord?.byteSize).toBe(Buffer.byteLength(largeBody, 'utf8'));

    // Verify blob exists in Cloud Storage at trees/{uid}/{treeId}/blobs/{docId}.md
    expect(await storage.readBlob(expectedBlobPath)).toBe(largeBody);

    // Small doc stays inline with storagePath: null
    const rawSmallRecord = await db.getDocumentRecord(smallNode.docId!);
    expect(rawSmallRecord?.storagePath).toBeNull();
    expect(rawSmallRecord?.markdown).toContain('Short inline body.');

    // Transparent retrieval via getDocument
    const fetchedLarge = await store.getDocument('user_spill', tree.id, 'specs/large.md');
    expect(fetchedLarge.markdown).toBe(largeBody);

    // Transparent retrieval via compileSelection
    const compiled = await store.compileSelection('user_spill', tree.id, {
      targets: ['specs/large.md', 'specs/small.md'],
      title: 'Combined Specs',
    });
    expect(compiled.markdown).toContain(largeBody);
    expect(compiled.markdown).toContain('Short inline body.');

    // Updating large.md back below 200 KB removes the spillover blob and stores inline
    const shrunkBody = '# Large Spec Shrunk\n\nNow fits inline.';
    await store.applyOps('user_spill', tree.id, [
      { op: 'put_doc', path: 'specs/large.md', markdown: shrunkBody },
    ]);
    expect(await storage.readBlob(expectedBlobPath)).toBeNull();
    const rawAfterShrink = await db.getDocumentRecord(largeNode.docId!);
    expect(rawAfterShrink?.storagePath).toBeNull();
    expect(rawAfterShrink?.markdown).toBe(shrunkBody);
  });

  it('commits >400 documents in chunks of 400 before updating the tree topology document', async () => {
    const { db, storage } = createInMemoryTreePersistenceAdapter();
    const store = createFirestoreTreeStore({ db, storage });

    const tree = await store.createTree('user_batch', { title: 'Bulk Import Tree' });

    const docCount = 450;
    const ops = Array.from({ length: docCount }, (_, i) => ({
      op: 'put_doc' as const,
      path: `docs/file-${String(i).padStart(3, '0')}.md`,
      markdown: `# Doc ${i}\n\nContent for document ${i}.`,
    }));

    const updated = await store.applyOps('user_batch', tree.id, ops);
    expect(updated.docCount).toBe(docCount);
    expect(updated.nodeCount).toBe(docCount + 1); // 1 'docs' folder + 450 docs

    // Verify 450 docs were committed in two chunks: 400 and 50
    expect(db.batchCommits.map((c) => c.putCount)).toEqual([MAX_FIRESTORE_BATCH_DOCS, 50]);
  });

  it('persists selection state in trees/{treeId}/state/selection and preserves detached narrations when deleting a tree', async () => {
    const { db, storage } = createInMemoryTreePersistenceAdapter();
    const detachedNarrations = new Map<string, { uid: string; title: string; markdown: string }>();
    let narSeq = 0;

    const narrationStarter: NarrationStarterPort = {
      async start(uid, input) {
        narSeq += 1;
        const narrationId = `nar_detached_${narSeq}`;
        detachedNarrations.set(narrationId, {
          uid,
          title: input.title,
          markdown: input.markdown,
        });
        return { narrationId };
      },
    };

    const store = createFirestoreTreeStore({ db, storage, narrationStarter });
    const tree = await store.createTree('user_owner', {
      title: 'Narrated Tree',
      ops: [
        {
          op: 'put_doc',
          path: 'chapter-1.md',
          markdown: `# Chapter 1\n\n${'B'.repeat(MAX_INLINE_DOC_BYTES + 1024)}`,
        },
        { op: 'select', mode: 'set', targets: ['chapter-1.md'] },
      ],
    });

    // Selection state subdocument is populated
    const selectionState = await db.getSelectionState(tree.id);
    expect(selectionState?.nodeIds).toHaveLength(1);

    // Start node narration and compile narration
    const nodeId = tree.rootIds[0]!;
    const { narrationId: nodeNarrationId } = await store.startNodeNarration('user_owner', tree.id, nodeId);
    const compiled = await store.compileSelection('user_owner', tree.id, {
      narrate: true,
      saveAsPath: 'compiled.md',
    });

    expect(detachedNarrations.has(nodeNarrationId)).toBe(true);
    expect(detachedNarrations.has(compiled.narrationId!)).toBe(true);
    expect(storage.blobs.size).toBeGreaterThan(0);

    // Delete the tree: topology, selection state, treeDocs, and blobs are deleted, but detached narrations survive
    await store.deleteTree('user_owner', tree.id);

    expect(await db.getTreeDoc(tree.id)).toBeNull();
    expect(await db.getSelectionState(tree.id)).toBeNull();
    expect(await db.listDocumentRecordsByTree('user_owner', tree.id)).toHaveLength(0);
    expect(storage.blobs.size).toBe(0);

    // Detached narrations remain untouched in the user's library
    expect(detachedNarrations.size).toBe(2);
    expect(detachedNarrations.get(nodeNarrationId)?.title).toBe('Chapter 1');
  });

  it('resets referencing tree nodes and treeDocs to unvoiced when clearNarrationReferences is called (including via narration-server purgeNarrationData)', async () => {
    const { db, storage } = createInMemoryTreePersistenceAdapter();
    let narSeq = 0;
    const narrationStarter: NarrationStarterPort = {
      async start() {
        narSeq += 1;
        return { narrationId: `nar_to_clear_${narSeq}` };
      },
    };

    const store = createFirestoreTreeStore({ db, storage, narrationStarter });
    setServerTreeStoreForTests(store);

    try {
      const tree = await store.createTree('user_clear', {
        title: 'Reference Reset Tree',
        ops: [{ op: 'put_doc', path: 'voice-me.md', markdown: '# Voice Me\n\nHello world.' }],
      });
      const nodeId = tree.rootIds[0]!;
      const { narrationId } = await store.startNodeNarration('user_clear', tree.id, nodeId);

      // Edit the doc so narrationStale becomes true before clearing
      await store.applyOps('user_clear', tree.id, [
        { op: 'put_doc', path: 'voice-me.md', markdown: '# Voice Me\n\nEdited text.' },
      ]);

      const beforeClearDoc = await store.getDocument('user_clear', tree.id, nodeId);
      expect(beforeClearDoc.narrationId).toBe(narrationId);
      expect(beforeClearDoc.narrationStale).toBe(true);

      await clearNarrationReferences('user_clear', narrationId);

      const afterTree = await store.getTree('user_clear', tree.id);
      const afterNode = afterTree.nodes[nodeId]!;
      expect(afterNode.narrationId).toBeNull();
      expect(afterNode.narrationStatus).toBe('unvoiced');
      expect(afterNode.narrationContentHash).toBeNull();

      const afterDoc = await store.getDocument('user_clear', tree.id, nodeId);
      expect(afterDoc.narrationId).toBeNull();
      expect(afterDoc.narrationStatus).toBe('unvoiced');
      expect(afterDoc.narrationStale).toBe(false);
    } finally {
      setServerTreeStoreForTests(null);
    }

    // Verify narration-server.ts calls clearNarrationReferences inside purgeNarrationData
    const narrationServerSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/narration-server.ts'),
      'utf8',
    );
    expect(narrationServerSource).toContain('clearNarrationReferences(uid, id)');
  });
});
