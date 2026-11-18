import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { imageTypeOf, sha256OfFile } from '../production/probe.js';
import {
  StudioApiError,
  type ProductionAsset,
  type ProductionMediaUpload,
  type TreeDetail,
  type TreeDocument,
  type TreeMediaRef,
  type TreeNodeId,
  type TreeOp,
} from '../remote/client.js';

/**
 * Syncs a local folder of Markdown and images into a Studio tree, idempotently:
 *
 * 1. Reads every `.md` document and every PNG, JPEG or WebP image under the
 *    folder, and the optional `tree.json` manifest (order, titles, hashes).
 * 2. Hashes each image and asks Studio which it already has. Only the others
 *    upload. Images are stored as production media, one asset per owner and
 *    SHA-256, so a re-sync, or another tree using the same file, reuses them.
 * 3. Binds each image's path in the tree to its asset, so relative Markdown
 *    image links render. A binding that already points at the asset is left.
 * 4. Writes a document only when it is new or its Markdown or title changed.
 * 5. Orders each folder's children as the manifest lists them.
 * 6. With `prune`, removes documents the folder no longer has.
 *
 * Nothing is sent when nothing changed, so the tree's revision stays put.
 */

export const TREE_MANIFEST_FILE = 'tree.json';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.hg', '.svn', 'dist', 'build']);
const SHA256 = /^[0-9a-f]{64}$/;
/** Ops and Markdown bytes per request, under Firestore's 500-write batch and comfortable request sizes. */
const MAX_OPS_PER_REQUEST = 40;
const MAX_MARKDOWN_BYTES_PER_REQUEST = 1024 * 1024;
const DOC_FETCH_CONCURRENCY = 8;
const UPLOAD_CONCURRENCY = 4;

/** The optional `tree.json` beside the documents. */
export interface TreeSyncManifest {
  version: 1;
  /** Title for a tree the sync creates. */
  title?: string;
  description?: string;
  /** Folders and documents in reading order; a document's `title` overrides its first heading. */
  nodes?: Array<{ path: string; title?: string }>;
  /** Images with the hash and size they must have. */
  images?: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface LocalDocument {
  path: string;
  markdown: string;
  title?: string;
}

export interface LocalImage {
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface LocalTreeFolder {
  dir: string;
  documents: LocalDocument[];
  images: LocalImage[];
  /** Node paths in reading order, from the manifest. */
  order: string[];
  title?: string;
  description?: string;
}

/** The Studio calls a sync makes; `StudioClient` has them all. */
export interface TreeSyncClient {
  getTree(idOrTitle: string): Promise<TreeDetail>;
  createTree(input: { title: string; description?: string }): Promise<TreeDetail>;
  applyTreeOps(treeIdOrTitle: string, ops: TreeOp[], options?: { expectedRevision?: number }): Promise<TreeDetail>;
  getTreeDocument(treeId: string, nodeIdOrPath: string): Promise<TreeDocument>;
  findProductionMedia(hashes: readonly string[]): Promise<Map<string, ProductionAsset>>;
  uploadProductionMedia(upload: ProductionMediaUpload): Promise<ProductionAsset>;
}

export interface TreeSyncOptions {
  /** Remove documents the folder no longer has. */
  prune?: boolean;
  /** Report what would change without changing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Opens a file as an upload body; default `fs.openAsBlob`. */
  open?: (file: string) => Promise<Blob>;
}

export interface TreeSyncReport {
  treeId: string | null;
  title: string;
  created: boolean;
  dryRun: boolean;
  revision: number | null;
  documents: { total: number; written: string[]; unchanged: number; removed: string[] };
  images: { total: number; uploaded: Array<{ path: string; sha256: string; assetId: string }>; reused: number; bound: string[] };
  reorderedFolders: string[];
}

const toPosix = (p: string) => p.split(path.sep).join('/');

function parseManifest(raw: string, file: string): TreeSyncManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must be a JSON object.`);
  const manifest = parsed as Record<string, unknown>;
  if (manifest.version !== 1) throw new Error(`${file}: only "version": 1 is supported.`);
  const text = (key: string) => {
    const value = manifest[key];
    if (value !== undefined && typeof value !== 'string') throw new Error(`${file}: "${key}" must be text.`);
    return value as string | undefined;
  };
  const list = (key: string) => {
    const value = manifest[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${file}: "${key}" must be a list.`);
    return value as unknown[];
  };
  const nodes = list('nodes').map((entry, i) => {
    const node = entry as { path?: unknown; title?: unknown };
    if (!node || typeof node.path !== 'string' || !node.path.trim()) throw new Error(`${file}: nodes[${i}] needs a "path".`);
    if (node.title !== undefined && typeof node.title !== 'string') throw new Error(`${file}: nodes[${i}].title must be text.`);
    return { path: node.path, ...(node.title !== undefined ? { title: node.title } : {}) };
  });
  const images = list('images').map((entry, i) => {
    const image = entry as { path?: unknown; sha256?: unknown; bytes?: unknown };
    if (!image || typeof image.path !== 'string' || typeof image.sha256 !== 'string' || !SHA256.test(image.sha256) || typeof image.bytes !== 'number') {
      throw new Error(`${file}: images[${i}] needs "path", a lowercase hex "sha256" and "bytes".`);
    }
    return { path: image.path, sha256: image.sha256, bytes: image.bytes };
  });
  const title = text('title');
  const description = text('description');
  return { version: 1, ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), nodes, images };
}

/**
 * Reads a folder for a sync: its Markdown documents, its images with their
 * hashes, and `tree.json` when present. A manifest that names a missing file,
 * or an image whose bytes don't match its hash, fails the read.
 */
export async function readTreeFolder(dirPath: string): Promise<LocalTreeFolder> {
  const dir = path.resolve(dirPath);
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`--from-dir "${dirPath}" is not a directory.`);

  const markdownFiles: string[] = [];
  const imageFiles: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md') markdownFiles.push(full);
        else if (IMAGE_EXTENSIONS.has(ext)) imageFiles.push(full);
      }
    }
  }
  await walk(dir);

  const manifestFile = path.join(dir, TREE_MANIFEST_FILE);
  const manifest = fs.existsSync(manifestFile)
    ? parseManifest(await fs.promises.readFile(manifestFile, 'utf8'), TREE_MANIFEST_FILE)
    : null;
  const titles = new Map((manifest?.nodes ?? []).filter((n) => n.title !== undefined).map((n) => [n.path, n.title!]));

  const documents: LocalDocument[] = [];
  for (const file of markdownFiles.sort()) {
    const rel = toPosix(path.relative(dir, file));
    const title = titles.get(rel);
    documents.push({ path: rel, markdown: await fs.promises.readFile(file, 'utf8'), ...(title !== undefined ? { title } : {}) });
  }

  const images: LocalImage[] = [];
  const unsupported: string[] = [];
  for (const file of imageFiles.sort()) {
    const rel = toPosix(path.relative(dir, file));
    const mimeType = await imageTypeOf(file);
    if (!mimeType) {
      unsupported.push(rel);
      continue;
    }
    const bytes = (await fs.promises.stat(file)).size;
    images.push({ path: rel, file, sha256: await sha256OfFile(file), bytes, mimeType });
  }
  if (unsupported.length > 0) throw new Error(`Not a PNG, JPEG or WebP image: ${unsupported.join(', ')}`);

  if (manifest) {
    const byPath = new Map(images.map((image) => [image.path, image]));
    for (const expected of manifest.images ?? []) {
      const image = byPath.get(expected.path);
      if (!image) throw new Error(`${TREE_MANIFEST_FILE} lists ${expected.path}, which is not in the folder.`);
      if (image.sha256 !== expected.sha256 || image.bytes !== expected.bytes) {
        throw new Error(`${expected.path} does not match the hash and size ${TREE_MANIFEST_FILE} records for it.`);
      }
    }
    const docPaths = new Set(documents.map((d) => d.path));
    for (const node of manifest.nodes ?? []) {
      if (node.path.toLowerCase().endsWith('.md') && !docPaths.has(node.path)) {
        throw new Error(`${TREE_MANIFEST_FILE} lists ${node.path}, which is not in the folder.`);
      }
    }
  }

  return {
    dir,
    documents,
    images,
    order: (manifest?.nodes ?? []).map((n) => n.path),
    ...(manifest?.title !== undefined ? { title: manifest.title } : {}),
    ...(manifest?.description !== undefined ? { description: manifest.description } : {}),
  };
}

/** SHA-256 of Markdown as Studio computes a document's `contentHash`. */
export function markdownHash(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Splits ops into requests bounded by count and Markdown size. */
export function chunkOps(ops: readonly TreeOp[]): TreeOp[][] {
  const chunks: TreeOp[][] = [];
  let current: TreeOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = op.op === 'put_doc' ? Buffer.byteLength(op.markdown, 'utf8') : 0;
    if (current.length > 0 && (current.length >= MAX_OPS_PER_REQUEST || bytes + size > MAX_MARKDOWN_BYTES_PER_REQUEST)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const sameRef = (a: TreeMediaRef | undefined, b: TreeMediaRef) =>
  a !== undefined && a.type === b.type && a.id === b.id && (a.generationId ?? null) === (b.generationId ?? null);

/**
 * The reorder ops that make each folder list its children as `order` does.
 * Children the order doesn't name keep their current relative order, after
 * the named ones. A folder already in order gets no op.
 */
export function planReorders(tree: TreeDetail, order: readonly string[]): TreeOp[] {
  const rank = new Map<string, number>();
  order.forEach((p, i) => {
    if (!rank.has(p)) rank.set(p, i);
  });
  const ops: TreeOp[] = [];
  const consider = (folderPath: string, childIds: readonly TreeNodeId[]) => {
    const ranked = childIds
      .map((id, i) => ({ id, i, rank: rank.get(tree.nodes[id]?.path ?? '') ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((entry) => entry.id);
    if (ranked.some((id, i) => id !== childIds[i])) ops.push({ op: 'reorder', folderPath, childOrder: ranked });
  };
  consider('', tree.rootIds);
  for (const node of Object.values(tree.nodes)) {
    if (node.kind === 'folder' && node.childIds.length > 1) consider(node.path, node.childIds);
  }
  return ops;
}

function isNotFound(error: unknown): boolean {
  return error instanceof StudioApiError && error.status === 404;
}

/** Syncs `folder` into the tree named by `treeRef` (an id or exact title), creating the tree when it is missing. */
export async function syncTreeFolder(
  client: TreeSyncClient,
  treeRef: string,
  folder: LocalTreeFolder,
  options: TreeSyncOptions = {},
): Promise<TreeSyncReport> {
  const log = options.log ?? (() => {});
  const open = options.open ?? ((file: string) => fs.openAsBlob(file));
  const dryRun = options.dryRun === true;

  let tree: TreeDetail | null = null;
  try {
    tree = await client.getTree(treeRef);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const created = tree === null;
  if (tree === null && !dryRun) {
    tree = await client.createTree({ title: treeRef, ...(folder.description !== undefined ? { description: folder.description } : {}) });
    log(`Created tree "${tree.title}" (${tree.id}).`);
  }

  const report: TreeSyncReport = {
    treeId: tree?.id ?? null,
    title: tree?.title ?? treeRef,
    created,
    dryRun,
    revision: tree?.revision ?? null,
    documents: { total: folder.documents.length, written: [], unchanged: 0, removed: [] },
    images: { total: folder.images.length, uploaded: [], reused: 0, bound: [] },
    reorderedFolders: [],
  };

  // Images: ask by hash, upload the rest, bind each path to its asset.
  const assets = new Map<string, ProductionAsset>();
  if (folder.images.length > 0) {
    const found = await client.findProductionMedia(folder.images.map((image) => image.sha256));
    for (const [sha, asset] of found) assets.set(sha, asset);
  }
  const missing = [...new Map(folder.images.filter((image) => !assets.has(image.sha256)).map((image) => [image.sha256, image])).values()];
  report.images.reused = folder.images.filter((image) => assets.has(image.sha256)).length;
  if (missing.length > 0) log(`${dryRun ? 'Would upload' : 'Uploading'} ${missing.length} of ${folder.images.length} images.`);
  if (!dryRun) {
    await mapLimit(missing, UPLOAD_CONCURRENCY, async (image) => {
      const asset = await client.uploadProductionMedia({
        sha256: image.sha256,
        mediaType: 'image',
        mimeType: image.mimeType,
        byteLength: image.bytes,
        body: await open(image.file),
      });
      if (asset.sha256 && asset.sha256 !== image.sha256) throw new Error(`Studio stored ${image.path} under a different hash.`);
      assets.set(image.sha256, asset);
      report.images.uploaded.push({ path: image.path, sha256: image.sha256, assetId: asset.id });
      log(`Uploaded ${image.path}`);
    });
  } else {
    for (const image of missing) report.images.uploaded.push({ path: image.path, sha256: image.sha256, assetId: '' });
  }
  report.images.uploaded.sort((a, b) => a.path.localeCompare(b.path));

  const ops: TreeOp[] = [];
  for (const image of folder.images) {
    const asset = assets.get(image.sha256);
    const ref: TreeMediaRef = { type: 'asset', id: asset?.id ?? '' };
    if (asset && sameRef(tree?.pathAssets[image.path], ref)) continue;
    report.images.bound.push(image.path);
    if (asset) ops.push({ op: 'bind_asset', virtualPath: image.path, ref });
  }

  // Documents: write only what is new or changed.
  const docNodes = new Map(
    Object.values(tree?.nodes ?? {})
      .filter((node) => node.kind === 'doc')
      .map((node) => [node.path, node]),
  );
  const existing = folder.documents.filter((doc) => docNodes.has(doc.path));
  const current = new Map<string, TreeDocument>();
  if (tree) {
    const treeId = tree.id;
    const fetched = await mapLimit(existing, DOC_FETCH_CONCURRENCY, (doc) => client.getTreeDocument(treeId, docNodes.get(doc.path)!.id));
    fetched.forEach((document, i) => current.set(existing[i]!.path, document));
  }
  for (const doc of folder.documents) {
    const remote = current.get(doc.path);
    const unchanged = remote !== undefined
      && remote.contentHash === markdownHash(doc.markdown)
      && (doc.title === undefined || remote.title === doc.title.trim());
    if (unchanged) {
      report.documents.unchanged += 1;
      continue;
    }
    report.documents.written.push(doc.path);
    ops.push({ op: 'put_doc', path: doc.path, markdown: doc.markdown, ...(doc.title !== undefined ? { title: doc.title } : {}) });
  }

  if (options.prune) {
    const keep = new Set(folder.documents.map((doc) => doc.path));
    const stale = [...docNodes.keys()].filter((p) => !keep.has(p)).sort();
    report.documents.removed = stale;
    if (stale.length > 0) ops.push({ op: 'remove', targets: stale.map((p) => docNodes.get(p)!.id), recursive: false });
  }

  if (dryRun) return report;
  if (!tree) throw new Error('No tree to sync into.');

  let latest: TreeDetail = tree;
  const chunks = chunkOps(ops);
  for (const [i, chunk] of chunks.entries()) {
    latest = await client.applyTreeOps(latest.id, chunk);
    log(`Applied ${chunk.length} changes (${i + 1}/${chunks.length}).`);
  }

  const reorders = planReorders(latest, folder.order);
  if (reorders.length > 0) {
    latest = await client.applyTreeOps(latest.id, reorders);
    report.reorderedFolders = reorders.map((op) => (op.op === 'reorder' ? op.folderPath || '/' : ''));
  }
  report.treeId = latest.id;
  report.title = latest.title;
  report.revision = latest.revision;
  return report;
}

export function formatSyncReport(report: TreeSyncReport): string {
  const verb = report.dryRun ? 'Would sync' : 'Synced';
  const lines = [
    `${verb} "${report.title}"${report.treeId ? ` (${report.treeId}, rev ${report.revision})` : ' (new tree)'}${report.created && !report.dryRun ? ', created' : ''}.`,
    `Documents: ${report.documents.written.length} written, ${report.documents.unchanged} unchanged${report.documents.removed.length ? `, ${report.documents.removed.length} removed` : ''} (of ${report.documents.total}).`,
    `Images: ${report.images.uploaded.length} uploaded, ${report.images.reused} already in Studio, ${report.images.bound.length} bound (of ${report.images.total}).`,
  ];
  if (report.reorderedFolders.length > 0) lines.push(`Reordered: ${report.reorderedFolders.join(', ')}.`);
  return lines.join('\n');
}
