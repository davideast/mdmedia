import { describe, expect, it } from 'bun:test';
import { InMemoryTreeStore } from '../../studio/src/lib/tree-fakes';
import { runTreeStoreContract } from './tree-store-contract';

runTreeStoreContract('InMemoryTreeStore', (narrationStarter) => new InMemoryTreeStore('user_a', narrationStarter));

describe('InMemoryTreeStore TreeClientPort subscriptions', () => {
  it('notifies watchTree and watchDocument subscribers on mutations', async () => {
    const store = new InMemoryTreeStore('user_a');
    const created = await store.createTree('user_a', {
      title: 'Live Tree',
      ops: [{ op: 'put_doc', path: 'readme.md', markdown: '# Initial' }],
    });
    const nodeId = created.rootIds[0]!;

    const treeSnapshots: number[] = [];
    const docSnapshots: string[] = [];

    const unsubTree = store.watchTree(created.id, (t) => {
      if (t) treeSnapshots.push(t.revision);
    });
    const unsubDoc = store.watchDocument(created.id, nodeId, (d) => {
      if (d) docSnapshots.push(d.markdown);
    });

    await store.applyOps(created.id, [{ op: 'put_doc', path: 'readme.md', markdown: '# Updated' }]);
    const { narrationId } = await store.startNodeNarration(created.id, nodeId);
    expect(narrationId).toBeDefined();

    unsubTree();
    unsubDoc();

    expect(treeSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(docSnapshots).toEqual(['# Initial', '# Updated', '# Updated']);
  });
});
