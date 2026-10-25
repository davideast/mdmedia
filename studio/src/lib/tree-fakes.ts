import { createHash } from 'node:crypto';
import { deriveDocTitle, formatMediaMarkdownRef, normalizeVirtualPath, resolveTreeNode, walkTreeOrder } from './tree-helpers';
import {
  MAX_PREVIOUS_PATHS,
  MAX_TREE_NODES,
  TreeOpError,
  type NarrationStarterPort,
  type TreeClientPort,
  type TreeCompileRequest,
  type TreeCompileResult,
  type TreeDetail,
  type TreeDocument,
  type TreeId,
  type TreeNodeId,
  type TreeNodeMeta,
  type TreeOp,
  type TreeOrganizeEntry,
  type TreePosition,
  type TreeSelectionSet,
  type TreeStorePort,
  type TreeSummary,
} from './tree-types';
import type { VoiceName } from './types';

export function hashContent(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export { deriveDocTitle, formatMediaMarkdownRef, normalizeVirtualPath, resolveTreeNode, walkTreeOrder } from './tree-helpers';

interface StoredTreeRecord {
  ownerUid: string;
  detail: TreeDetail;
  docs: Map<TreeNodeId, TreeDocument>;
}

/**
 * In-memory implementation of both `TreeStorePort` and `TreeClientPort`.
 * Shared across Tracks 1–4 for fast, deterministic unit and integration testing.
 */
export class InMemoryTreeStore implements TreeStorePort, TreeClientPort {
  private trees = new Map<TreeId, StoredTreeRecord>();
  private idempotency = new Map<string, TreeDetail>();
  private treeListeners = new Map<TreeId, Set<(tree: TreeDetail | null) => void>>();
  private docListeners = new Map<string, Set<(doc: TreeDocument | null) => void>>();
  private idCounter = 0;

  constructor(
    private readonly defaultUid: string = 'user_test',
    private readonly narrationStarter?: NarrationStarterPort,
  ) {}

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  private emitTree(treeId: TreeId): void {
    const record = this.trees.get(treeId);
    const snapshot = record ? structuredClone(record.detail) : null;
    for (const listener of this.treeListeners.get(treeId) ?? []) {
      listener(snapshot);
    }
  }

  private emitDoc(treeId: TreeId, nodeId: TreeNodeId): void {
    const record = this.trees.get(treeId);
    const doc = record?.docs.get(nodeId) ?? null;
    const snapshot = doc ? structuredClone(doc) : null;
    for (const listener of this.docListeners.get(`${treeId}:${nodeId}`) ?? []) {
      listener(snapshot);
    }
  }

  private requireOwned(uid: string, idOrTitle: string): StoredTreeRecord {
    const direct = this.trees.get(idOrTitle);
    if (direct && direct.ownerUid === uid) return direct;
    const wanted = idOrTitle.trim().toLowerCase();
    const matches = [...this.trees.values()].filter(
      (r) => r.ownerUid === uid && r.detail.title.trim().toLowerCase() === wanted,
    );
    if (matches.length > 1) {
      throw new TreeOpError(
        'tree_ambiguous',
        `${matches.length} trees are titled "${idOrTitle}". Use the id instead.`,
        409,
        { ids: matches.map((m) => m.detail.id) },
      );
    }
    if (!matches[0]) {
      throw new TreeOpError('tree_not_found', `No tree with id or title "${idOrTitle}".`, 404);
    }
    return matches[0];
  }

  private summarize(detail: TreeDetail): TreeSummary {
    return {
      id: detail.id,
      title: detail.title,
      description: detail.description,
      nodeCount: detail.nodeCount,
      docCount: detail.docCount,
      selectedCount: detail.selectedCount,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
  }

  async listTrees(uid: string = this.defaultUid): Promise<TreeSummary[]> {
    return [...this.trees.values()]
      .filter((r) => r.ownerUid === uid)
      .sort((a, b) => b.detail.updatedAt - a.detail.updatedAt)
      .map((r) => structuredClone(this.summarize(r.detail)));
  }

  async getTree(uid: string, idOrTitle: string): Promise<TreeDetail> {
    const record = this.requireOwned(uid, idOrTitle);
    return structuredClone(record.detail);
  }

  async createTree(
    uid: string,
    input: { title: string; description?: string; ops?: readonly TreeOp[]; idempotencyKey?: string },
  ): Promise<TreeDetail> {
    if (input.idempotencyKey) {
      const cached = this.idempotency.get(`${uid}:create:${input.idempotencyKey}`);
      if (cached) return structuredClone(cached);
    }
    const title = input.title?.trim();
    if (!title) throw new TreeOpError('invalid_title', 'title must be non-empty text.', 400);
    if (title.length > 200) throw new TreeOpError('invalid_title', 'title is limited to 200 characters.', 400);
    const description = (input.description ?? '').trim();
    if (description.length > 2000) {
      throw new TreeOpError('invalid_description', 'description is limited to 2000 characters.', 400);
    }
    const now = Date.now();
    const id = this.nextId('tr');
    const detail: TreeDetail = {
      id,
      title,
      description,
      nodeCount: 0,
      docCount: 0,
      selectedCount: 0,
      rootIds: [],
      nodes: {},
      selectedNodeIds: [],
      selectionSets: {},
      pathAssets: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.trees.set(id, { ownerUid: uid, detail, docs: new Map() });
    if (input.ops && input.ops.length > 0) {
      await this.applyOps(uid, id, input.ops);
    }
    const created = structuredClone(this.trees.get(id)!.detail);
    if (input.idempotencyKey) {
      this.idempotency.set(`${uid}:create:${input.idempotencyKey}`, created);
    }
    this.emitTree(id);
    return created;
  }

  async updateTreeMeta(
    uid: string,
    treeId: TreeId,
    patch: { title?: string; description?: string },
  ): Promise<TreeDetail> {
    const record = this.requireOwned(uid, treeId);
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (!trimmed || trimmed.length > 200) {
        throw new TreeOpError('invalid_title', 'title must be 1 to 200 characters.', 400);
      }
      record.detail.title = trimmed;
    }
    if (patch.description !== undefined) {
      if (patch.description.length > 2000) {
        throw new TreeOpError('invalid_description', 'description is limited to 2000 characters.', 400);
      }
      record.detail.description = patch.description.trim();
    }
    record.detail.revision += 1;
    record.detail.updatedAt = Date.now();
    this.emitTree(record.detail.id);
    return structuredClone(record.detail);
  }

  async deleteTree(uid: string, treeId: TreeId): Promise<void> {
    const record = this.requireOwned(uid, treeId);
    const id = record.detail.id;
    this.trees.delete(id);
    this.emitTree(id);
  }

  private insertIntoList(list: TreeNodeId[], nodeId: TreeNodeId, at: TreePosition = 'end'): TreeNodeId[] {
    const without = list.filter((id) => id !== nodeId);
    if (at === 'start') return [nodeId, ...without];
    if (at === 'end') return [...without, nodeId];
    const anchor = 'before' in at ? at.before : at.after;
    const idx = without.indexOf(anchor);
    if (idx < 0) throw new TreeOpError('anchor_not_found', `Anchor "${anchor}" is not in the target folder.`);
    const insertIdx = 'before' in at ? idx : idx + 1;
    return [...without.slice(0, insertIdx), nodeId, ...without.slice(insertIdx)];
  }

  private ensureFolderChain(record: StoredTreeRecord, folderPath: string, now: number): TreeNodeId | null {
    if (!folderPath) return null;
    const parts = folderPath.split('/').filter(Boolean);
    let currentParentId: TreeNodeId | null = null;
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = Object.values(record.detail.nodes).find((n) => n.path === currentPath);
      if (existing) {
        if (existing.kind !== 'folder') {
          throw new TreeOpError('not_a_folder', `"${currentPath}" is a document, not a folder.`);
        }
        currentParentId = existing.id;
      } else {
        const id = this.nextId('nd');
        const folderNode: TreeNodeMeta = {
          id,
          kind: 'folder',
          name: part,
          path: currentPath,
          previousPaths: [],
          parentId: currentParentId,
          childIds: [],
          docId: null,
          narrationId: null,
          narrationStatus: 'unvoiced',
          narrationContentHash: null,
          updatedAt: now,
        };
        record.detail.nodes[id] = folderNode;
        if (currentParentId === null) {
          record.detail.rootIds.push(id);
        } else {
          record.detail.nodes[currentParentId]!.childIds.push(id);
        }
        currentParentId = id;
      }
    }
    return currentParentId;
  }

  private updateSubtreePaths(record: StoredTreeRecord, node: TreeNodeMeta, newPath: string, now: number): void {
    if (node.path !== newPath) {
      const nextPrev = [node.path, ...node.previousPaths.filter((p) => p !== node.path && p !== newPath)].slice(
        0,
        MAX_PREVIOUS_PATHS,
      );
      node.previousPaths = nextPrev;
      node.path = newPath;
      node.name = newPath.split('/').pop()!;
      node.updatedAt = now;
      const doc = record.docs.get(node.id);
      if (doc) {
        doc.path = newPath;
        doc.updatedAt = now;
      }
    }
    if (node.kind === 'folder') {
      for (const childId of node.childIds) {
        const child = record.detail.nodes[childId];
        if (child) {
          this.updateSubtreePaths(record, child, `${newPath}/${child.name}`, now);
        }
      }
    }
  }

  async applyOps(
    uidOrTreeId: string,
    treeIdOrOps: TreeId | readonly TreeOp[],
    maybeOps?: readonly TreeOp[] | { expectedRevision?: number; idempotencyKey?: string },
    maybeOptions?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<TreeDetail> {
    // Support both TreeStorePort.applyOps(uid, treeId, ops, options) and TreeClientPort.applyOps(treeId, ops, options)
    const isClientCall = Array.isArray(treeIdOrOps);
    const uid = isClientCall ? this.defaultUid : uidOrTreeId;
    const treeId = isClientCall ? uidOrTreeId : (treeIdOrOps as TreeId);
    const ops = (isClientCall ? treeIdOrOps : maybeOps) as readonly TreeOp[];
    const options = (isClientCall ? maybeOps : maybeOptions) as
      | { expectedRevision?: number; idempotencyKey?: string }
      | undefined;

    const baseRecord = this.requireOwned(uid, treeId);
    if (options?.idempotencyKey) {
      const cached = this.idempotency.get(`${uid}:ops:${baseRecord.detail.id}:${options.idempotencyKey}`);
      if (cached) return structuredClone(cached);
    }
    if (options?.expectedRevision !== undefined && options.expectedRevision !== baseRecord.detail.revision) {
      throw new TreeOpError(
        'revision_conflict',
        `Expected tree revision ${options.expectedRevision}, but current revision is ${baseRecord.detail.revision}.`,
        409,
        { currentRevision: baseRecord.detail.revision },
      );
    }

    // Work on a clone so failed transactions leave the store untouched
    const working: StoredTreeRecord = {
      ownerUid: baseRecord.ownerUid,
      detail: structuredClone(baseRecord.detail),
      docs: new Map([...baseRecord.docs.entries()].map(([k, v]) => [k, structuredClone(v)])),
    };
    const now = Date.now();
    const touchedDocNodes = new Set<TreeNodeId>();

    for (const op of ops) {
      switch (op.op) {
        case 'mkdir': {
          const path = normalizeVirtualPath(op.path);
          const segments = path.split('/');
          const parentPath = segments.slice(0, -1).join('/');
          const name = segments[segments.length - 1]!;
          const parentId = this.ensureFolderChain(working, parentPath, now);
          const existing = Object.values(working.detail.nodes).find((n) => n.path === path);
          if (existing) {
            if (existing.kind !== 'folder') {
              throw new TreeOpError('path_conflict', `"${path}" already exists as a document.`);
            }
            break;
          }
          const id = op.nodeId ?? this.nextId('nd');
          working.detail.nodes[id] = {
            id,
            kind: 'folder',
            name,
            path,
            previousPaths: [],
            parentId,
            childIds: [],
            docId: null,
            narrationId: null,
            narrationStatus: 'unvoiced',
            narrationContentHash: null,
            updatedAt: now,
          };
          if (parentId === null) {
            working.detail.rootIds = this.insertIntoList(working.detail.rootIds, id, op.at);
          } else {
            const parent = working.detail.nodes[parentId]!;
            parent.childIds = this.insertIntoList(parent.childIds, id, op.at);
          }
          break;
        }
        case 'put_doc': {
          if (/[\u0000]/.test(op.markdown)) {
            throw new TreeOpError('invalid_markdown', 'Markdown cannot contain NUL bytes.');
          }
          const path = normalizeVirtualPath(op.path);
          const segments = path.split('/');
          const parentPath = segments.slice(0, -1).join('/');
          const name = segments[segments.length - 1]!;
          const parentId = this.ensureFolderChain(working, parentPath, now);
          const contentHash = hashContent(op.markdown);
          const existing =
            (op.nodeId ? working.detail.nodes[op.nodeId] : undefined) ??
            Object.values(working.detail.nodes).find((n) => n.path === path);

          if (existing) {
            if (existing.kind !== 'doc') {
              throw new TreeOpError('path_conflict', `"${path}" is a folder, not a document.`);
            }
            existing.updatedAt = now;
            const prevDoc = working.docs.get(existing.id);
            const title = op.title?.trim() || deriveDocTitle(op.markdown, name);
            const stale =
              existing.narrationId !== null &&
              existing.narrationContentHash !== null &&
              existing.narrationContentHash !== contentHash;
            working.docs.set(existing.id, {
              id: existing.docId ?? prevDoc?.id ?? this.nextId('doc'),
              treeId: working.detail.id,
              nodeId: existing.id,
              path: existing.path,
              title,
              markdown: op.markdown,
              contentHash,
              narrationId: existing.narrationId,
              narrationStatus: existing.narrationStatus,
              narrationStale: stale,
              updatedAt: now,
            });
            touchedDocNodes.add(existing.id);
          } else {
            const id = op.nodeId ?? this.nextId('nd');
            const docId = this.nextId('doc');
            const title = op.title?.trim() || deriveDocTitle(op.markdown, name);
            const node: TreeNodeMeta = {
              id,
              kind: 'doc',
              name,
              path,
              previousPaths: [],
              parentId,
              childIds: [],
              docId,
              narrationId: null,
              narrationStatus: 'unvoiced',
              narrationContentHash: null,
              updatedAt: now,
            };
            working.detail.nodes[id] = node;
            if (parentId === null) {
              working.detail.rootIds = this.insertIntoList(working.detail.rootIds, id, op.at);
            } else {
              const parent = working.detail.nodes[parentId]!;
              parent.childIds = this.insertIntoList(parent.childIds, id, op.at);
            }
            working.docs.set(id, {
              id: docId,
              treeId: working.detail.id,
              nodeId: id,
              path,
              title,
              markdown: op.markdown,
              contentHash,
              narrationId: null,
              narrationStatus: 'unvoiced',
              narrationStale: false,
              updatedAt: now,
            });
            touchedDocNodes.add(id);
          }
          break;
        }
        case 'move': {
          const resolved = resolveTreeNode(working.detail, op.target);
          if (!resolved) throw new TreeOpError('node_not_found', `Node "${op.target}" not found.`, 404);
          const node = resolved.node;
          const toPath = normalizeVirtualPath(op.toPath);
          if (node.kind === 'folder' && (toPath === node.path || toPath.startsWith(`${node.path}/`))) {
            throw new TreeOpError('invalid_move', `Cannot move folder "${node.path}" into itself ("${toPath}").`);
          }
          const collision = Object.values(working.detail.nodes).find((n) => n.path === toPath && n.id !== node.id);
          if (collision) {
            throw new TreeOpError('path_conflict', `A node already exists at "${toPath}".`);
          }
          if (node.parentId === null) {
            working.detail.rootIds = working.detail.rootIds.filter((id) => id !== node.id);
          } else {
            const oldParent = working.detail.nodes[node.parentId];
            if (oldParent) oldParent.childIds = oldParent.childIds.filter((id) => id !== node.id);
          }
          const segments = toPath.split('/');
          const newParentPath = segments.slice(0, -1).join('/');
          const newParentId = this.ensureFolderChain(working, newParentPath, now);
          node.parentId = newParentId;
          if (newParentId === null) {
            working.detail.rootIds = this.insertIntoList(working.detail.rootIds, node.id, op.at);
          } else {
            const newParent = working.detail.nodes[newParentId]!;
            newParent.childIds = this.insertIntoList(newParent.childIds, node.id, op.at);
          }
          this.updateSubtreePaths(working, node, toPath, now);
          break;
        }
        case 'reorder': {
          const folderPath = op.folderPath.trim().replace(/^\/+|\/+$/g, '');
          let currentIds: TreeNodeId[];
          let folderNode: TreeNodeMeta | null = null;
          if (!folderPath) {
            currentIds = working.detail.rootIds;
          } else {
            const resolved = resolveTreeNode(working.detail, folderPath);
            if (!resolved || resolved.node.kind !== 'folder') {
              throw new TreeOpError('not_a_folder', `Folder "${op.folderPath}" not found.`, 404);
            }
            folderNode = resolved.node;
            currentIds = folderNode.childIds;
          }
          const resolvedOrder = op.childOrder.map((entry) => {
            if (currentIds.includes(entry)) return entry;
            const byName = currentIds.find(
              (id) => working.detail.nodes[id]?.name === entry || working.detail.nodes[id]?.path === entry,
            );
            if (!byName) throw new TreeOpError('invalid_order', `"${entry}" is not a child of "${op.folderPath || '/'}".`);
            return byName;
          });
          if (
            resolvedOrder.length !== currentIds.length ||
            new Set(resolvedOrder).size !== currentIds.length ||
            !currentIds.every((id) => resolvedOrder.includes(id))
          ) {
            throw new TreeOpError(
              'invalid_order',
              'childOrder must list every direct child of the folder exactly once.',
            );
          }
          if (folderNode) {
            folderNode.childIds = resolvedOrder;
          } else {
            working.detail.rootIds = resolvedOrder;
          }
          break;
        }
        case 'remove': {
          const toDelete = new Set<TreeNodeId>();
          const collect = (node: TreeNodeMeta) => {
            if (node.kind === 'folder' && node.childIds.length > 0 && op.recursive === false) {
              throw new TreeOpError('folder_not_empty', `Folder "${node.path}" is not empty.`);
            }
            toDelete.add(node.id);
            for (const childId of node.childIds) {
              const child = working.detail.nodes[childId];
              if (child) collect(child);
            }
          };
          for (const target of op.targets) {
            const resolved = resolveTreeNode(working.detail, target);
            if (resolved) collect(resolved.node);
          }
          for (const id of toDelete) {
            const node = working.detail.nodes[id];
            if (!node) continue;
            if (node.parentId === null) {
              working.detail.rootIds = working.detail.rootIds.filter((r) => r !== id);
            } else if (working.detail.nodes[node.parentId]) {
              working.detail.nodes[node.parentId]!.childIds = working.detail.nodes[node.parentId]!.childIds.filter(
                (c) => c !== id,
              );
            }
            delete working.detail.nodes[id];
            working.docs.delete(id);
          }
          working.detail.selectedNodeIds = working.detail.selectedNodeIds.filter((id) => !toDelete.has(id));
          break;
        }
        case 'select': {
          if (op.mode === 'clear') {
            working.detail.selectedNodeIds = [];
            break;
          }
          const matchedDocIds: TreeNodeId[] = [];
          const addDocDescendants = (node: TreeNodeMeta) => {
            if (node.kind === 'doc') matchedDocIds.push(node.id);
            else {
              for (const childId of node.childIds) {
                const child = working.detail.nodes[childId];
                if (child) addDocDescendants(child);
              }
            }
          };
          for (const target of op.targets) {
            const resolved = resolveTreeNode(working.detail, target);
            if (!resolved) throw new TreeOpError('node_not_found', `Node "${target}" not found.`, 404);
            addDocDescendants(resolved.node);
          }
          const nextSet = new Set(op.mode === 'set' ? [] : working.detail.selectedNodeIds);
          if (op.mode === 'set' || op.mode === 'add') {
            for (const id of matchedDocIds) nextSet.add(id);
          } else if (op.mode === 'remove') {
            for (const id of matchedDocIds) nextSet.delete(id);
          }
          // Order selectedNodeIds in canonical tree order
          const ordered = walkTreeOrder(working.detail.rootIds, working.detail.nodes)
            .filter((n) => n.kind === 'doc' && nextSet.has(n.id))
            .map((n) => n.id);
          working.detail.selectedNodeIds = ordered;
          break;
        }
        case 'save_selection_set': {
          const title = op.title.trim();
          if (!title) throw new TreeOpError('invalid_title', 'Selection set title cannot be empty.');
          const setId = op.id?.trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || this.nextId('sel');
          const nodeIds: TreeNodeId[] = [];
          for (const target of op.targets) {
            const resolved = resolveTreeNode(working.detail, target);
            if (!resolved) throw new TreeOpError('node_not_found', `Node "${target}" not found.`, 404);
            if (resolved.node.kind === 'doc') nodeIds.push(resolved.node.id);
          }
          const preset: TreeSelectionSet = {
            id: setId,
            title,
            nodeIds: [...new Set(nodeIds)],
            ...(op.instructions ? { instructions: op.instructions } : {}),
            updatedAt: now,
          };
          working.detail.selectionSets[setId] = preset;
          break;
        }
        case 'delete_selection_set': {
          delete working.detail.selectionSets[op.id];
          break;
        }
        case 'bind_asset': {
          const virtualPath = normalizeVirtualPath(op.virtualPath);
          working.detail.pathAssets[virtualPath] = op.ref;
          break;
        }
        case 'replace_media_ref': {
          const doc = working.docs.get(op.nodeId);
          const node = working.detail.nodes[op.nodeId];
          if (!doc || !node) throw new TreeOpError('node_not_found', `Document node "${op.nodeId}" not found.`, 404);
          const replacement = formatMediaMarkdownRef(op.to);
          if (op.from.type === 'mermaid') {
            const fence = `\`\`\`mermaid\n${op.from.id}\n\`\`\``;
            if (doc.markdown.includes(fence)) {
              doc.markdown =
                op.placement === 'replace'
                  ? doc.markdown.replace(fence, replacement)
                  : doc.markdown.replace(fence, `${fence}\n\n${replacement}`);
            } else {
              doc.markdown = `${doc.markdown.trimEnd()}\n\n${replacement}\n`;
            }
          } else {
            const targetUri = `mdmedia://${op.from.type}/${op.from.id}`;
            const regex = new RegExp(`!?\\[[^\\]]*\\]\\(${targetUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)`);
            const match = doc.markdown.match(regex);
            if (match && match[0]) {
              doc.markdown =
                op.placement === 'replace'
                  ? doc.markdown.replace(match[0], replacement)
                  : doc.markdown.replace(match[0], `${match[0]}\n\n${replacement}`);
            } else {
              doc.markdown = `${doc.markdown.trimEnd()}\n\n${replacement}\n`;
            }
          }
          doc.contentHash = hashContent(doc.markdown);
          doc.narrationStale =
            node.narrationId !== null &&
            node.narrationContentHash !== null &&
            node.narrationContentHash !== doc.contentHash;
          doc.updatedAt = now;
          node.updatedAt = now;
          touchedDocNodes.add(node.id);
          break;
        }
        case 'organize': {
          const applyEntries = (entries: readonly TreeOrganizeEntry[]) => {
            for (const entry of entries) {
              const targetKey = entry.nodeId ?? entry.target;
              if (targetKey) {
                const resolved = resolveTreeNode(working.detail, targetKey);
                if (!resolved) throw new TreeOpError('node_not_found', `Node "${targetKey}" not found.`, 404);
                const toPath = normalizeVirtualPath(entry.path);
                if (resolved.node.path !== toPath) {
                  // Reuse move logic by moving node to toPath
                  const node = resolved.node;
                  if (node.parentId === null) {
                    working.detail.rootIds = working.detail.rootIds.filter((id) => id !== node.id);
                  } else if (working.detail.nodes[node.parentId]) {
                    working.detail.nodes[node.parentId]!.childIds = working.detail.nodes[
                      node.parentId
                    ]!.childIds.filter((id) => id !== node.id);
                  }
                  const segs = toPath.split('/');
                  const newParentId = this.ensureFolderChain(working, segs.slice(0, -1).join('/'), now);
                  node.parentId = newParentId;
                  if (newParentId === null) working.detail.rootIds.push(node.id);
                  else working.detail.nodes[newParentId]!.childIds.push(node.id);
                  this.updateSubtreePaths(working, node, toPath, now);
                }
              } else {
                this.ensureFolderChain(working, normalizeVirtualPath(entry.path), now);
              }
              if (entry.children && entry.children.length > 0) {
                applyEntries(entry.children);
              }
            }
          };
          applyEntries(op.entries);
          break;
        }
      }
    }

    const allNodes = Object.values(working.detail.nodes);
    if (allNodes.length > MAX_TREE_NODES) {
      throw new TreeOpError(
        'tree_too_large',
        `A tree holds at most ${MAX_TREE_NODES} nodes (got ${allNodes.length}).`,
      );
    }
    working.detail.nodeCount = allNodes.length;
    working.detail.docCount = allNodes.filter((n) => n.kind === 'doc').length;
    working.detail.selectedCount = working.detail.selectedNodeIds.length;
    working.detail.revision += 1;
    working.detail.updatedAt = now;

    this.trees.set(working.detail.id, working);
    const snapshot = structuredClone(working.detail);
    if (options?.idempotencyKey) {
      this.idempotency.set(`${uid}:ops:${working.detail.id}:${options.idempotencyKey}`, snapshot);
    }
    this.emitTree(working.detail.id);
    for (const nodeId of touchedDocNodes) {
      this.emitDoc(working.detail.id, nodeId);
    }
    return snapshot;
  }

  async getDocument(uid: string, treeId: TreeId, nodeIdOrPath: string): Promise<TreeDocument> {
    const record = this.requireOwned(uid, treeId);
    const resolved = resolveTreeNode(record.detail, nodeIdOrPath);
    if (!resolved || resolved.node.kind !== 'doc') {
      throw new TreeOpError('doc_not_found', `Document "${nodeIdOrPath}" not found in tree.`, 404);
    }
    const doc = record.docs.get(resolved.node.id);
    if (!doc) throw new TreeOpError('doc_not_found', `Document "${nodeIdOrPath}" content not found.`, 404);
    return structuredClone(doc);
  }

  async compileSelection(
    uidOrTreeId: string,
    treeIdOrRequest: TreeId | TreeCompileRequest,
    maybeRequest?: TreeCompileRequest,
  ): Promise<TreeCompileResult> {
    const isClientCall = typeof treeIdOrRequest === 'object';
    const uid = isClientCall ? this.defaultUid : uidOrTreeId;
    const treeId = isClientCall ? uidOrTreeId : (treeIdOrRequest as TreeId);
    const request = (isClientCall ? treeIdOrRequest : maybeRequest)!;

    const record = this.requireOwned(uid, treeId);
    let targetIds: TreeNodeId[];
    if (request.targets && request.targets.length > 0) {
      const requested = new Set<TreeNodeId>();
      for (const t of request.targets) {
        const res = resolveTreeNode(record.detail, t);
        if (!res) throw new TreeOpError('node_not_found', `Node "${t}" not found.`, 404);
        if (res.node.kind === 'doc') requested.add(res.node.id);
      }
      targetIds = walkTreeOrder(record.detail.rootIds, record.detail.nodes)
        .filter((n) => requested.has(n.id))
        .map((n) => n.id);
    } else if (request.preset) {
      const preset =
        record.detail.selectionSets[request.preset] ??
        Object.values(record.detail.selectionSets).find(
          (s) => s.title.toLowerCase() === request.preset!.trim().toLowerCase(),
        );
      if (!preset) throw new TreeOpError('preset_not_found', `Selection preset "${request.preset}" not found.`, 404);
      const set = new Set(preset.nodeIds);
      targetIds = walkTreeOrder(record.detail.rootIds, record.detail.nodes)
        .filter((n) => set.has(n.id))
        .map((n) => n.id);
    } else {
      const set = new Set(record.detail.selectedNodeIds);
      targetIds = walkTreeOrder(record.detail.rootIds, record.detail.nodes)
        .filter((n) => set.has(n.id))
        .map((n) => n.id);
    }

    if (targetIds.length === 0) {
      throw new TreeOpError('empty_selection', 'Select at least one document to compile.');
    }

    const docs = targetIds.map((id) => record.docs.get(id)).filter((d): d is TreeDocument => Boolean(d));
    const title = request.title?.trim() || `${record.detail.title} Briefing`;
    const sections = docs.map((d) => {
      const trimmed = d.markdown.trim();
      if (/^#\s+/.test(trimmed)) {
        return trimmed.replace(/^#(\s+)/, '##$1');
      }
      return `## ${d.title}\n\n${trimmed}`;
    });
    const instructionsNote = request.instructions?.trim()
      ? `> **Briefing focus:** ${request.instructions.trim()}\n\n`
      : '';
    const markdown = `# ${title}\n\n${instructionsNote}${sections.join('\n\n---\n\n')}\n`;

    let savedNode: TreeNodeMeta | undefined;
    if (request.saveAsPath) {
      const updated = await this.applyOps(uid, record.detail.id, [
        { op: 'put_doc', path: request.saveAsPath, title, markdown },
      ]);
      savedNode = resolveTreeNode(updated, request.saveAsPath)?.node;
    }

    let narrationId: string | undefined;
    if (request.narrate && this.narrationStarter) {
      const started = await this.narrationStarter.start(uid, {
        markdown,
        title,
        voice: request.voice,
        voiceProvider: request.voiceProvider,
        voiceId: request.voiceId,
        promptStyle: request.promptStyle,
        instructions: request.instructions,
        origin: { treeId: record.detail.id, nodeId: savedNode?.id },
      });
      narrationId = started.narrationId;
      if (savedNode) {
        const freshRecord = this.requireOwned(uid, record.detail.id);
        const node = freshRecord.detail.nodes[savedNode.id];
        const doc = freshRecord.docs.get(savedNode.id);
        if (node && doc) {
          node.narrationId = narrationId;
          node.narrationStatus = 'ready';
          node.narrationContentHash = doc.contentHash;
          doc.narrationId = narrationId;
          doc.narrationStatus = 'ready';
          doc.narrationStale = false;
          savedNode = structuredClone(node);
        }
      }
    }

    return {
      title,
      markdown,
      sourceNodeIds: targetIds,
      ...(savedNode ? { savedNode } : {}),
      ...(narrationId ? { narrationId } : {}),
    };
  }

  async clearNarrationReferences(uid: string, narrationId: string): Promise<void> {
    for (const record of this.trees.values()) {
      if (record.ownerUid !== uid) continue;
      let changed = false;
      for (const node of Object.values(record.detail.nodes)) {
        if (node.narrationId === narrationId) {
          node.narrationId = null;
          node.narrationStatus = 'unvoiced';
          node.narrationContentHash = null;
          const doc = record.docs.get(node.id);
          if (doc) {
            doc.narrationId = null;
            doc.narrationStatus = 'unvoiced';
            doc.narrationStale = false;
          }
          changed = true;
        }
      }
      if (changed) {
        record.detail.revision += 1;
        record.detail.updatedAt = Date.now();
        this.emitTree(record.detail.id);
      }
    }
  }

  // ==========================================================================
  // TreeClientPort methods
  // ==========================================================================
  watchTree(treeId: TreeId, onUpdate: (tree: TreeDetail | null) => void): () => void {
    let set = this.treeListeners.get(treeId);
    if (!set) {
      set = new Set();
      this.treeListeners.set(treeId, set);
    }
    set.add(onUpdate);
    const current = this.trees.get(treeId);
    onUpdate(current ? structuredClone(current.detail) : null);
    return () => {
      set?.delete(onUpdate);
    };
  }

  watchDocument(
    treeId: TreeId,
    nodeId: TreeNodeId,
    onUpdate: (doc: TreeDocument | null) => void,
  ): () => void {
    const key = `${treeId}:${nodeId}`;
    let set = this.docListeners.get(key);
    if (!set) {
      set = new Set();
      this.docListeners.set(key, set);
    }
    set.add(onUpdate);
    const current = this.trees.get(treeId)?.docs.get(nodeId) ?? null;
    onUpdate(current ? structuredClone(current) : null);
    return () => {
      set?.delete(onUpdate);
    };
  }

  async startNodeNarration(
    treeId: TreeId,
    nodeId: TreeNodeId,
    options?: {
      voice?: VoiceName;
      voiceProvider?: 'gemini' | 'elevenlabs';
      voiceId?: string;
      promptStyle?: string;
    },
  ): Promise<{ narrationId: string }> {
    const record = this.requireOwned(this.defaultUid, treeId);
    const node = record.detail.nodes[nodeId];
    const doc = record.docs.get(nodeId);
    if (!node || !doc) throw new TreeOpError('doc_not_found', `Document node "${nodeId}" not found.`, 404);
    const narrationId = this.narrationStarter
      ? (
          await this.narrationStarter.start(this.defaultUid, {
            markdown: doc.markdown,
            title: doc.title,
            voice: options?.voice,
            voiceProvider: options?.voiceProvider,
            voiceId: options?.voiceId,
            promptStyle: options?.promptStyle,
            origin: { treeId: record.detail.id, nodeId },
          })
        ).narrationId
      : this.nextId('nar');
    node.narrationId = narrationId;
    node.narrationStatus = 'ready';
    node.narrationContentHash = doc.contentHash;
    doc.narrationId = narrationId;
    doc.narrationStatus = 'ready';
    doc.narrationStale = false;
    this.emitTree(record.detail.id);
    this.emitDoc(record.detail.id, nodeId);
    return { narrationId };
  }
}
