import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkOps,
  readTreeFolder,
  syncTreeFolder,
  type TreeSyncClient,
} from '../../src/cli/studio-tree-sync.js';
import {
  StudioApiError,
  type ProductionAsset,
  type ProductionMediaUpload,
  type TreeDetail,
  type TreeDocument,
  type TreeOp,
} from '../../src/remote/client.js';
import { parseMediaUri } from '../../studio/src/lib/markdown-word-aligner';
import { InMemoryTreeStore } from '../../studio/src/lib/tree-fakes';
import type { TreeOp as StoreTreeOp } from '../../studio/src/lib/tree-types';

const UID = 'user_test';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function writeFiles(files: Record<string, Buffer | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-tree-sync-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/** A small bundle: two docs, three image paths of which two share bytes, and a manifest. */
function bundle(overrides: Record<string, Buffer | string> = {}): Record<string, Buffer | string> {
  const cover = Buffer.concat([PNG, Buffer.from('cover')]);
  const detail = Buffer.concat([JPEG, Buffer.from('detail')]);
  const files: Record<string, Buffer | string> = {
    'start-here.md': '# Art research\n\n![Cover](images/cover.png)\n',
    'works/river.md': '# River\n\n![River](../images/cover.png)\n\n![Detail](../images/detail.jpg)\n\n![Copy](../images/cover-copy.png)\n',
    'works/zebra.md': '# Zebra\n',
    'images/cover.png': cover,
    'images/cover-copy.png': cover,
    'images/detail.jpg': detail,
    ...overrides,
  };
  const image = (rel: string) => ({ path: rel, sha256: sha256(files[rel] as Buffer), bytes: (files[rel] as Buffer).length });
  if (!('tree.json' in overrides)) {
    files['tree.json'] = JSON.stringify({
      version: 1,
      title: 'Art research',
      description: 'Exported library',
      nodes: [
        { path: 'start-here.md', title: 'Start here' },
        { path: 'works' },
        { path: 'works/zebra.md', title: 'Zebra' },
        { path: 'works/river.md', title: 'River' },
      ],
      images: ['images/cover.png', 'images/cover-copy.png', 'images/detail.jpg'].map(image),
    });
  }
  return files;
}

/** Studio as the sync sees it: the in-memory tree store and production media kept by hash. */
function fakeStudio() {
  const store = new InMemoryTreeStore(UID);
  const media = new Map<string, ProductionAsset>();
  const calls = { applyTreeOps: 0, uploads: 0, docReads: 0 };
  const asStudioError = (error: unknown): never => {
    const e = error as { status?: number; code?: string; message?: string };
    if (typeof e.status === 'number') throw new StudioApiError(e.status, e.code ?? 'error', e.message ?? '');
    throw error;
  };
  const client: TreeSyncClient = {
    async getTree(idOrTitle) {
      return (await store.getTree(UID, idOrTitle).catch(asStudioError)) as unknown as TreeDetail;
    },
    async createTree(input) {
      return (await store.createTree(UID, input)) as unknown as TreeDetail;
    },
    async applyTreeOps(id, ops: TreeOp[]) {
      calls.applyTreeOps += 1;
      return (await store.applyOps(UID, id, ops as unknown as StoreTreeOp[]).catch(asStudioError)) as unknown as TreeDetail;
    },
    async getTreeDocument(treeId, node) {
      calls.docReads += 1;
      return (await store.getDocument(UID, treeId, node).catch(asStudioError)) as unknown as TreeDocument;
    },
    async findProductionMedia(hashes) {
      return new Map(hashes.filter((h) => media.has(h)).map((h) => [h, media.get(h)!]));
    },
    async uploadProductionMedia(upload: ProductionMediaUpload) {
      calls.uploads += 1;
      const bytes = Buffer.from(await upload.body.arrayBuffer());
      expect(sha256(bytes)).toBe(upload.sha256);
      const asset: ProductionAsset = {
        id: `pm${upload.sha256.slice(0, 16)}`, mediaType: 'image', mimeType: upload.mimeType, byteLength: bytes.length,
        sha256: upload.sha256, width: 1, height: 1, links: { content: '', thumbnail: null },
      };
      media.set(upload.sha256, asset);
      return asset;
    },
  };
  return { store, media, calls, client };
}

describe('mdmedia studio tree sync', () => {
  it('creates the tree, uploads each image once by hash, binds its paths, and orders it like tree.json', async () => {
    const dir = writeFiles(bundle());
    const studio = fakeStudio();
    const report = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir));

    expect(report.created).toBe(true);
    expect(report.images.uploaded.map((u) => u.path)).toEqual(['images/cover.png', 'images/detail.jpg']);
    expect(report.images.bound.sort()).toEqual(['images/cover-copy.png', 'images/cover.png', 'images/detail.jpg']);
    expect(report.documents.written.sort()).toEqual(['start-here.md', 'works/river.md', 'works/zebra.md']);

    const tree = await studio.store.getTree(UID, 'Art research');
    expect(tree.description).toBe('Exported library');
    expect(tree.rootIds.map((id) => tree.nodes[id]!.path)).toEqual(['start-here.md', 'works']);
    const works = Object.values(tree.nodes).find((n) => n.path === 'works')!;
    expect(works.childIds.map((id) => tree.nodes[id]!.path)).toEqual(['works/zebra.md', 'works/river.md']);
    // A relative image link in a doc resolves to the uploaded asset, as the reader resolves it.
    const cover = studio.media.get(sha256(Buffer.concat([PNG, Buffer.from('cover')])))!;
    expect(parseMediaUri('../images/cover.png', tree.pathAssets, 'works/river.md')).toEqual({ type: 'asset', id: cover.id });
    expect(tree.pathAssets['images/cover-copy.png']).toEqual({ type: 'asset', id: cover.id });
    const doc = await studio.store.getDocument(UID, tree.id, 'start-here.md');
    expect(doc.title).toBe('Start here');
  });

  it('changes nothing on a second sync of the same folder', async () => {
    const dir = writeFiles(bundle());
    const studio = fakeStudio();
    await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir));
    const before = await studio.store.getTree(UID, 'Art research');
    const calls = { ...studio.calls };

    const again = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir));

    expect(again.created).toBe(false);
    expect(again.images.uploaded).toEqual([]);
    expect(again.images.bound).toEqual([]);
    expect(again.images.reused).toBe(3);
    expect(again.documents.written).toEqual([]);
    expect(again.documents.unchanged).toBe(3);
    expect(again.reorderedFolders).toEqual([]);
    expect(studio.calls.applyTreeOps).toBe(calls.applyTreeOps);
    expect(studio.calls.uploads).toBe(calls.uploads);
    const after = await studio.store.getTree(UID, 'Art research');
    expect(after.revision).toBe(before.revision);
    expect(Object.keys(after.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
  });

  it('writes only the changed document and rebinds a replaced image', async () => {
    const studio = fakeStudio();
    await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(writeFiles(bundle())));
    const replaced = Buffer.concat([JPEG, Buffer.from('new detail')]);
    const dir = writeFiles(bundle({ 'works/zebra.md': '# Zebra\n\nStripes.\n', 'images/detail.jpg': replaced }));

    const report = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir));

    expect(report.documents.written).toEqual(['works/zebra.md']);
    expect(report.images.uploaded.map((u) => u.path)).toEqual(['images/detail.jpg']);
    expect(report.images.bound).toEqual(['images/detail.jpg']);
    const tree = await studio.store.getTree(UID, 'Art research');
    expect(tree.pathAssets['images/detail.jpg']!.id).toBe(studio.media.get(sha256(replaced))!.id);
  });

  it('removes documents the folder no longer has only with prune', async () => {
    const studio = fakeStudio();
    await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(writeFiles(bundle())));
    const files = bundle();
    delete files['works/zebra.md'];
    const manifest = JSON.parse(files['tree.json'] as string) as { nodes: Array<{ path: string }> };
    manifest.nodes = manifest.nodes.filter((n) => n.path !== 'works/zebra.md');
    files['tree.json'] = JSON.stringify(manifest);
    const dir = writeFiles(files);

    const kept = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir));
    expect(kept.documents.removed).toEqual([]);
    expect((await studio.store.getTree(UID, 'Art research')).docCount).toBe(3);

    const pruned = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(dir), { prune: true });
    expect(pruned.documents.removed).toEqual(['works/zebra.md']);
    expect((await studio.store.getTree(UID, 'Art research')).docCount).toBe(2);
  });

  it('reports a dry run without creating, uploading or writing anything', async () => {
    const studio = fakeStudio();
    const report = await syncTreeFolder(studio.client, 'Art research', await readTreeFolder(writeFiles(bundle())), { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.treeId).toBeNull();
    expect(report.images.uploaded).toHaveLength(2);
    expect(report.documents.written).toHaveLength(3);
    expect(studio.calls).toEqual({ applyTreeOps: 0, uploads: 0, docReads: 0 });
    expect(await studio.store.listTrees(UID)).toEqual([]);
  });

  it('refuses a folder whose images do not match tree.json, or that it cannot store', async () => {
    const files = bundle();
    const manifest = JSON.parse(files['tree.json'] as string) as { images: Array<{ sha256: string }> };
    manifest.images[0]!.sha256 = '0'.repeat(64);
    await expect(readTreeFolder(writeFiles({ ...files, 'tree.json': JSON.stringify(manifest) }))).rejects.toThrow('does not match');
    await expect(readTreeFolder(writeFiles({ ...bundle(), 'images/fake.png': 'not an image' }))).rejects.toThrow('Not a PNG, JPEG or WebP');
    await expect(readTreeFolder(writeFiles({ ...bundle(), 'tree.json': '{"version":2}' }))).rejects.toThrow('version');
  });

  it('works without a tree.json, keeping first headings as titles', async () => {
    const studio = fakeStudio();
    const dir = writeFiles({ 'notes/a.md': '# Alpha\n', 'b.md': '# Beta\n' });
    const report = await syncTreeFolder(studio.client, 'Plain', await readTreeFolder(dir));
    expect(report.documents.written.sort()).toEqual(['b.md', 'notes/a.md']);
    expect((await studio.store.getDocument(UID, report.treeId!, 'notes/a.md')).title).toBe('Alpha');
    const again = await syncTreeFolder(studio.client, 'Plain', await readTreeFolder(dir));
    expect(again.documents.written).toEqual([]);
  });

  it('splits large syncs into bounded requests', () => {
    const ops: TreeOp[] = Array.from({ length: 95 }, (_, i) => ({ op: 'put_doc', path: `d${i}.md`, markdown: 'x' }));
    expect(chunkOps(ops).map((c) => c.length)).toEqual([40, 40, 15]);
    const big: TreeOp[] = Array.from({ length: 3 }, (_, i) => ({ op: 'put_doc', path: `b${i}.md`, markdown: 'y'.repeat(600 * 1024) }));
    expect(chunkOps(big).map((c) => c.length)).toEqual([1, 1, 1]);
  });
});
