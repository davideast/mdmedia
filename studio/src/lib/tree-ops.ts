import {
  MAX_PREVIOUS_PATHS,
  MAX_TREE_NODES,
  TreeOpError,
  type TreeDetail,
  type TreeDocId,
  type TreeDocument,
  type TreeNodeId,
  type TreeNodeMeta,
  type TreeOp,
  type TreeOrganizeEntry,
  type TreePosition,
  type TreeSelectionSet,
} from './tree-types';
import {
  deriveDocTitle,
  formatMediaMarkdownRef,
  hashContent,
  normalizeVirtualPath,
  resolveTreeNode,
  walkTreeOrder,
} from './tree-fakes';

export {
  deriveDocTitle,
  formatMediaMarkdownRef,
  hashContent,
  normalizeVirtualPath,
  resolveTreeNode,
  walkTreeOrder,
};

/** Hard cap on serialized topology document size in Firestore (~900 KB under the 1 MiB limit). */
export const MAX_SERIALIZED_TREE_BYTES = 900 * 1024;

export interface ApplyTreeOpsOptions {
  now?: number;
  nextId?: (prefix: string) => string;
}

export interface ApplyTreeOpsStateInput extends ApplyTreeOpsOptions {
  detail: TreeDetail;
  docs: ReadonlyMap<TreeNodeId, TreeDocument> | Record<TreeNodeId, TreeDocument>;
  ops: readonly TreeOp[];
}

export interface ApplyTreeOpsStateResult {
  detail: TreeDetail;
  docs: Map<TreeNodeId, TreeDocument>;
  touchedDocNodeIds: TreeNodeId[];
  deletedDocNodeIds: TreeNodeId[];
  deletedDocIds: TreeDocId[];
  selectionChanged: boolean;
  topologyChanged: boolean;
}

export function validateTreeTitle(raw: string): string {
  const title = raw?.trim();
  if (!title) {
    throw new TreeOpError('invalid_title', 'title must be non-empty text.', 400);
  }
  if (title.length > 200) {
    throw new TreeOpError('invalid_title', 'title is limited to 200 characters.', 400);
  }
  if (/[\u0000-\u001f]/.test(title)) {
    throw new TreeOpError('invalid_title', 'title cannot contain control characters.', 400);
  }
  return title;
}

export function validateTreeDescription(raw?: string): string {
  const description = (raw ?? '').trim();
  if (description.length > 2000) {
    throw new TreeOpError('invalid_description', 'description is limited to 2000 characters.', 400);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description)) {
    throw new TreeOpError('invalid_description', 'description cannot contain control characters.', 400);
  }
  return description;
}

export function validateMarkdownContent(markdown: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(markdown)) {
    throw new TreeOpError('invalid_markdown', 'Markdown cannot contain NUL or control characters.', 400);
  }
}

function insertIntoList(list: TreeNodeId[], nodeId: TreeNodeId, at: TreePosition = 'end'): TreeNodeId[] {
  const without = list.filter((id) => id !== nodeId);
  if (at === 'start') return [nodeId, ...without];
  if (at === 'end') return [...without, nodeId];
  const anchor = 'before' in at ? at.before : at.after;
  const idx = without.indexOf(anchor);
  if (idx < 0) {
    throw new TreeOpError('anchor_not_found', `Anchor "${anchor}" is not in the target folder.`, 400);
  }
  const insertIdx = 'before' in at ? idx : idx + 1;
  return [...without.slice(0, insertIdx), nodeId, ...without.slice(insertIdx)];
}

function toDocMap(
  docs: ReadonlyMap<TreeNodeId, TreeDocument> | Record<TreeNodeId, TreeDocument>,
): Map<TreeNodeId, TreeDocument> {
  if (docs instanceof Map) {
    return new Map([...docs.entries()].map(([k, v]) => [k, structuredClone(v)]));
  }
  const record = docs as Record<TreeNodeId, TreeDocument>;
  return new Map(Object.entries(record).map(([k, v]) => [k, structuredClone(v)]));
}

/**
 * Pure state transition engine for `TreeDetail` and its associated `TreeDocument` map.
 * Supports both `(detail, docs, ops, options?)` and `({ detail, docs, ops, ... })` signatures.
 */
export function applyTreeOpsState(
  detailOrInput: TreeDetail | ApplyTreeOpsStateInput,
  maybeDocs?: ReadonlyMap<TreeNodeId, TreeDocument> | Record<TreeNodeId, TreeDocument>,
  maybeOps?: readonly TreeOp[],
  maybeOptions?: ApplyTreeOpsOptions,
): ApplyTreeOpsStateResult {
  const isInputObject =
    typeof detailOrInput === 'object' &&
    detailOrInput !== null &&
    'detail' in detailOrInput &&
    'docs' in detailOrInput &&
    'ops' in detailOrInput;

  const inputDetail = isInputObject ? detailOrInput.detail : detailOrInput;
  const inputDocs = isInputObject ? detailOrInput.docs : maybeDocs!;
  const ops = isInputObject ? detailOrInput.ops : maybeOps!;
  const options: ApplyTreeOpsOptions = isInputObject ? detailOrInput : (maybeOptions ?? {});

  const now = options.now ?? Date.now();
  let localCounter = Object.keys(inputDetail.nodes).length + 1;
  const nextId =
    options.nextId ??
    ((prefix: string) => {
      localCounter += 1;
      return `${prefix}_${now.toString(36)}_${localCounter}`;
    });

  const detail = structuredClone(inputDetail);
  const docs = toDocMap(inputDocs);
  const touchedDocNodes = new Set<TreeNodeId>();
  const deletedDocNodes = new Set<TreeNodeId>();
  const deletedDocIds = new Set<TreeDocId>();
  const prevSelectionKey = detail.selectedNodeIds.join('\u0000');
  let explicitSelectOp = false;
  let topologyChanged = false;

  const ensureFolderChain = (folderPath: string): TreeNodeId | null => {
    if (!folderPath) return null;
    const normalized = normalizeVirtualPath(folderPath);
    const parts = normalized.split('/').filter(Boolean);
    let currentParentId: TreeNodeId | null = null;
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = Object.values(detail.nodes).find((n) => n.path === currentPath);
      if (existing) {
        if (existing.kind !== 'folder') {
          throw new TreeOpError('not_a_folder', `"${currentPath}" is a document, not a folder.`, 400);
        }
        currentParentId = existing.id;
      } else {
        let id = nextId('nd');
        while (detail.nodes[id]) {
          id = nextId('nd');
        }
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
        detail.nodes[id] = folderNode;
        if (currentParentId === null) {
          detail.rootIds.push(id);
        } else {
          detail.nodes[currentParentId]!.childIds.push(id);
        }
        currentParentId = id;
        topologyChanged = true;
      }
    }
    return currentParentId;
  };

  const updateSubtreePaths = (node: TreeNodeMeta, rawNewPath: string): void => {
    const newPath = normalizeVirtualPath(rawNewPath);
    if (node.path !== newPath) {
      const nextPrev = [node.path, ...node.previousPaths.filter((p) => p !== node.path && p !== newPath)].slice(
        0,
        MAX_PREVIOUS_PATHS,
      );
      node.previousPaths = nextPrev;
      node.path = newPath;
      node.name = newPath.split('/').pop()!;
      node.updatedAt = now;
      const doc = docs.get(node.id);
      if (doc) {
        doc.path = newPath;
        doc.updatedAt = now;
        touchedDocNodes.add(node.id);
      }
    }
    if (node.kind === 'folder') {
      for (const childId of node.childIds) {
        const child = detail.nodes[childId];
        if (child) {
          updateSubtreePaths(child, `${newPath}/${child.name}`);
        }
      }
    }
  };

  for (const op of ops) {
    switch (op.op) {
      case 'mkdir': {
        const path = normalizeVirtualPath(op.path);
        const segments = path.split('/');
        const parentPath = segments.slice(0, -1).join('/');
        const name = segments[segments.length - 1]!;
        const parentId = ensureFolderChain(parentPath);
        const existing = Object.values(detail.nodes).find((n) => n.path === path);
        if (existing) {
          if (existing.kind !== 'folder') {
            throw new TreeOpError('path_conflict', `"${path}" already exists as a document.`, 400);
          }
          if (op.at !== undefined) {
            if (parentId === null) {
              detail.rootIds = insertIntoList(detail.rootIds, existing.id, op.at);
            } else {
              const parent = detail.nodes[parentId]!;
              parent.childIds = insertIntoList(parent.childIds, existing.id, op.at);
            }
            topologyChanged = true;
          }
          break;
        }
        let id = op.nodeId ?? nextId('nd');
        if (!op.nodeId) {
          while (detail.nodes[id]) id = nextId('nd');
        }
        detail.nodes[id] = {
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
          detail.rootIds = insertIntoList(detail.rootIds, id, op.at);
        } else {
          const parent = detail.nodes[parentId]!;
          parent.childIds = insertIntoList(parent.childIds, id, op.at);
        }
        topologyChanged = true;
        break;
      }

      case 'put_doc': {
        validateMarkdownContent(op.markdown);
        const path = normalizeVirtualPath(op.path);
        const segments = path.split('/');
        const parentPath = segments.slice(0, -1).join('/');
        const name = segments[segments.length - 1]!;
        const parentId = ensureFolderChain(parentPath);
        const contentHash = hashContent(op.markdown);
        const existing =
          (op.nodeId ? detail.nodes[op.nodeId] : undefined) ??
          Object.values(detail.nodes).find((n) => n.path === path);

        if (existing) {
          if (existing.kind !== 'doc') {
            throw new TreeOpError('path_conflict', `"${path}" is a folder, not a document.`, 400);
          }
          if (existing.path !== path) {
            const collision = Object.values(detail.nodes).find((n) => n.path === path && n.id !== existing.id);
            if (collision) {
              throw new TreeOpError('path_conflict', `A node already exists at "${path}".`, 400);
            }
            if (existing.parentId === null) {
              detail.rootIds = detail.rootIds.filter((id) => id !== existing.id);
            } else if (detail.nodes[existing.parentId]) {
              detail.nodes[existing.parentId]!.childIds = detail.nodes[existing.parentId]!.childIds.filter(
                (id) => id !== existing.id,
              );
            }
            existing.parentId = parentId;
            if (parentId === null) {
              detail.rootIds = insertIntoList(detail.rootIds, existing.id, op.at);
            } else {
              detail.nodes[parentId]!.childIds = insertIntoList(detail.nodes[parentId]!.childIds, existing.id, op.at);
            }
            updateSubtreePaths(existing, path);
          } else if (op.at !== undefined) {
            if (parentId === null) {
              detail.rootIds = insertIntoList(detail.rootIds, existing.id, op.at);
            } else {
              detail.nodes[parentId]!.childIds = insertIntoList(detail.nodes[parentId]!.childIds, existing.id, op.at);
            }
          }
          existing.updatedAt = now;
          const prevDoc = docs.get(existing.id);
          const title = op.title?.trim() || deriveDocTitle(op.markdown, name);
          const stale =
            existing.narrationId !== null &&
            existing.narrationContentHash !== null &&
            existing.narrationContentHash !== contentHash;
          const docId = existing.docId ?? prevDoc?.id ?? nextId('doc');
          existing.docId = docId;
          docs.set(existing.id, {
            id: docId,
            treeId: detail.id,
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
          deletedDocNodes.delete(existing.id);
          deletedDocIds.delete(docId);
          topologyChanged = true;
        } else {
          let id = op.nodeId ?? nextId('nd');
          if (!op.nodeId) {
            while (detail.nodes[id]) id = nextId('nd');
          }
          const docId = nextId('doc');
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
          detail.nodes[id] = node;
          if (parentId === null) {
            detail.rootIds = insertIntoList(detail.rootIds, id, op.at);
          } else {
            const parent = detail.nodes[parentId]!;
            parent.childIds = insertIntoList(parent.childIds, id, op.at);
          }
          docs.set(id, {
            id: docId,
            treeId: detail.id,
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
          deletedDocNodes.delete(id);
          topologyChanged = true;
        }
        break;
      }

      case 'move': {
        const resolved = resolveTreeNode(detail, op.target);
        if (!resolved) {
          throw new TreeOpError('node_not_found', `Node "${op.target}" not found.`, 404);
        }
        const node = resolved.node;
        const toPath = normalizeVirtualPath(op.toPath);
        if (node.kind === 'folder' && (toPath === node.path || toPath.startsWith(`${node.path}/`))) {
          throw new TreeOpError('invalid_move', `Cannot move folder "${node.path}" into itself ("${toPath}").`, 400);
        }
        const collision = Object.values(detail.nodes).find((n) => n.path === toPath && n.id !== node.id);
        if (collision) {
          throw new TreeOpError('path_conflict', `A node already exists at "${toPath}".`, 400);
        }
        if (node.parentId === null) {
          detail.rootIds = detail.rootIds.filter((id) => id !== node.id);
        } else {
          const oldParent = detail.nodes[node.parentId];
          if (oldParent) oldParent.childIds = oldParent.childIds.filter((id) => id !== node.id);
        }
        const segments = toPath.split('/');
        const newParentPath = segments.slice(0, -1).join('/');
        const newParentId = ensureFolderChain(newParentPath);
        node.parentId = newParentId;
        if (newParentId === null) {
          detail.rootIds = insertIntoList(detail.rootIds, node.id, op.at);
        } else {
          const newParent = detail.nodes[newParentId]!;
          newParent.childIds = insertIntoList(newParent.childIds, node.id, op.at);
        }
        updateSubtreePaths(node, toPath);
        topologyChanged = true;
        break;
      }

      case 'reorder': {
        const folderPath = op.folderPath.trim().replace(/^\/+|\/+$/g, '');
        let currentIds: TreeNodeId[];
        let folderNode: TreeNodeMeta | null = null;
        if (!folderPath) {
          currentIds = detail.rootIds;
        } else {
          const resolved = resolveTreeNode(detail, folderPath);
          if (!resolved || resolved.node.kind !== 'folder') {
            throw new TreeOpError('not_a_folder', `Folder "${op.folderPath}" not found.`, 404);
          }
          folderNode = resolved.node;
          currentIds = folderNode.childIds;
        }
        const resolvedOrder = op.childOrder.map((entry) => {
          if (currentIds.includes(entry)) return entry;
          const byName = currentIds.find(
            (id) => detail.nodes[id]?.name === entry || detail.nodes[id]?.path === entry,
          );
          if (!byName) {
            throw new TreeOpError('invalid_order', `"${entry}" is not a child of "${op.folderPath || '/'}".`, 400);
          }
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
            400,
          );
        }
        if (folderNode) {
          folderNode.childIds = resolvedOrder;
          folderNode.updatedAt = now;
        } else {
          detail.rootIds = resolvedOrder;
        }
        topologyChanged = true;
        break;
      }

      case 'remove': {
        const toDelete = new Set<TreeNodeId>();
        const collect = (node: TreeNodeMeta) => {
          if (node.kind === 'folder' && node.childIds.length > 0 && op.recursive === false) {
            throw new TreeOpError('folder_not_empty', `Folder "${node.path}" is not empty.`, 400);
          }
          toDelete.add(node.id);
          for (const childId of node.childIds) {
            const child = detail.nodes[childId];
            if (child) collect(child);
          }
        };
        for (const target of op.targets) {
          const resolved = resolveTreeNode(detail, target);
          if (resolved) collect(resolved.node);
        }
        for (const id of toDelete) {
          const node = detail.nodes[id];
          if (!node) continue;
          if (node.parentId === null) {
            detail.rootIds = detail.rootIds.filter((r) => r !== id);
          } else if (detail.nodes[node.parentId]) {
            detail.nodes[node.parentId]!.childIds = detail.nodes[node.parentId]!.childIds.filter((c) => c !== id);
          }
          const existingDoc = docs.get(id);
          const docId = node.docId ?? existingDoc?.id;
          if (node.kind === 'doc') {
            deletedDocNodes.add(id);
            touchedDocNodes.delete(id);
            if (docId) deletedDocIds.add(docId);
          }
          delete detail.nodes[id];
          docs.delete(id);
          topologyChanged = true;
        }
        detail.selectedNodeIds = detail.selectedNodeIds.filter((id) => !toDelete.has(id));
        break;
      }

      case 'select': {
        explicitSelectOp = true;
        if (op.mode === 'clear') {
          detail.selectedNodeIds = [];
          break;
        }
        const matchedDocIds: TreeNodeId[] = [];
        const addDocDescendants = (node: TreeNodeMeta) => {
          if (node.kind === 'doc') matchedDocIds.push(node.id);
          else {
            for (const childId of node.childIds) {
              const child = detail.nodes[childId];
              if (child) addDocDescendants(child);
            }
          }
        };
        for (const target of op.targets) {
          const resolved = resolveTreeNode(detail, target);
          if (!resolved) {
            throw new TreeOpError('node_not_found', `Node "${target}" not found.`, 404);
          }
          addDocDescendants(resolved.node);
        }
        const nextSet = new Set(op.mode === 'set' ? [] : detail.selectedNodeIds);
        if (op.mode === 'set' || op.mode === 'add') {
          for (const id of matchedDocIds) nextSet.add(id);
        } else if (op.mode === 'remove') {
          for (const id of matchedDocIds) nextSet.delete(id);
        }
        detail.selectedNodeIds = walkTreeOrder(detail.rootIds, detail.nodes)
          .filter((n) => n.kind === 'doc' && nextSet.has(n.id))
          .map((n) => n.id);
        break;
      }

      case 'save_selection_set': {
        const title = op.title.trim();
        if (!title) {
          throw new TreeOpError('invalid_title', 'Selection set title cannot be empty.', 400);
        }
        const setId =
          op.id?.trim() ||
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
          nextId('sel');
        const nodeIds: TreeNodeId[] = [];
        for (const target of op.targets) {
          const resolved = resolveTreeNode(detail, target);
          if (!resolved) {
            throw new TreeOpError('node_not_found', `Node "${target}" not found.`, 404);
          }
          if (resolved.node.kind === 'doc') nodeIds.push(resolved.node.id);
        }
        const preset: TreeSelectionSet = {
          id: setId,
          title,
          nodeIds: [...new Set(nodeIds)],
          ...(op.instructions ? { instructions: op.instructions } : {}),
          updatedAt: now,
        };
        detail.selectionSets[setId] = preset;
        topologyChanged = true;
        break;
      }

      case 'delete_selection_set': {
        if (detail.selectionSets[op.id]) {
          delete detail.selectionSets[op.id];
          topologyChanged = true;
        }
        break;
      }

      case 'bind_asset': {
        const virtualPath = normalizeVirtualPath(op.virtualPath);
        detail.pathAssets[virtualPath] = op.ref;
        topologyChanged = true;
        break;
      }

      case 'replace_media_ref': {
        const doc = docs.get(op.nodeId);
        const node = detail.nodes[op.nodeId];
        if (!doc || !node) {
          throw new TreeOpError('node_not_found', `Document node "${op.nodeId}" not found.`, 404);
        }
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
        } else if (op.from.type === 'text') {
          const targetSnippet = op.from.id.trim();
          if (targetSnippet && doc.markdown.includes(targetSnippet)) {
            if (op.placement === 'replace') {
              doc.markdown = doc.markdown.replace(targetSnippet, replacement);
            } else {
              const idx = doc.markdown.indexOf(targetSnippet);
              const afterSnippet = idx + targetSnippet.length;
              const nextDoubleNewline = doc.markdown.indexOf('\n\n', afterSnippet);
              const blockEnd = nextDoubleNewline === -1 ? doc.markdown.length : nextDoubleNewline;
              doc.markdown =
                doc.markdown.slice(0, blockEnd).trimEnd() +
                `\n\n${replacement}` +
                doc.markdown.slice(blockEnd);
            }
          } else {
            doc.markdown = `${doc.markdown.trimEnd()}\n\n${replacement}\n`;
          }
        } else {
          const targetUri = `mdmedia://${op.from.type}/${op.from.id}`;
          const regex = new RegExp(`!?\\[[^\\]]*\\]\\(${targetUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)`);
          let match = doc.markdown.match(regex);
          if (!match) {
            const boundEntry = Object.entries(detail.pathAssets).find(
              ([, ref]) => ref.id === op.from.id,
            );
            if (boundEntry) {
              const escapedVirtualPath = boundEntry[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const assetRegex = new RegExp(`!?\\[[^\\]]*\\]\\((?:\\.\\.\\/|\\.\\/|\\/)*${escapedVirtualPath}[^)]*\\)`);
              match = doc.markdown.match(assetRegex);
            }
          }
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
        topologyChanged = true;
        break;
      }

      case 'organize': {
        const applyEntries = (entries: readonly TreeOrganizeEntry[]) => {
          for (const entry of entries) {
            const targetKey = entry.nodeId ?? entry.target;
            if (targetKey) {
              const resolved = resolveTreeNode(detail, targetKey);
              if (!resolved) {
                throw new TreeOpError('node_not_found', `Node "${targetKey}" not found.`, 404);
              }
              const toPath = normalizeVirtualPath(entry.path);
              const node = resolved.node;
              if (node.kind === 'folder' && toPath !== node.path && toPath.startsWith(`${node.path}/`)) {
                throw new TreeOpError('invalid_move', `Cannot move folder "${node.path}" into itself ("${toPath}").`, 400);
              }
              if (node.path !== toPath) {
                const collision = Object.values(detail.nodes).find((n) => n.path === toPath && n.id !== node.id);
                if (collision) {
                  throw new TreeOpError('path_conflict', `A node already exists at "${toPath}".`, 400);
                }
                if (node.parentId === null) {
                  detail.rootIds = detail.rootIds.filter((id) => id !== node.id);
                } else if (detail.nodes[node.parentId]) {
                  detail.nodes[node.parentId]!.childIds = detail.nodes[node.parentId]!.childIds.filter(
                    (id) => id !== node.id,
                  );
                }
                const segs = toPath.split('/');
                const newParentId = ensureFolderChain(segs.slice(0, -1).join('/'));
                node.parentId = newParentId;
                if (newParentId === null) detail.rootIds.push(node.id);
                else detail.nodes[newParentId]!.childIds.push(node.id);
                updateSubtreePaths(node, toPath);
              }
              if (entry.title && node.kind === 'doc') {
                const doc = docs.get(node.id);
                if (doc) {
                  doc.title = validateTreeTitle(entry.title);
                  doc.updatedAt = now;
                  touchedDocNodes.add(node.id);
                }
              }
              topologyChanged = true;
            } else {
              ensureFolderChain(normalizeVirtualPath(entry.path));
              topologyChanged = true;
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

  // Always normalize selectedNodeIds into canonical pre-order tree order
  if (detail.selectedNodeIds.length > 0) {
    const selectedSet = new Set(detail.selectedNodeIds);
    detail.selectedNodeIds = walkTreeOrder(detail.rootIds, detail.nodes)
      .filter((n) => n.kind === 'doc' && selectedSet.has(n.id))
      .map((n) => n.id);
  }

  const allNodes = Object.values(detail.nodes);
  if (allNodes.length > MAX_TREE_NODES) {
    throw new TreeOpError(
      'tree_too_large',
      `A tree holds at most ${MAX_TREE_NODES} nodes (got ${allNodes.length}).`,
      400,
    );
  }

  detail.nodeCount = allNodes.length;
  detail.docCount = allNodes.filter((n) => n.kind === 'doc').length;
  detail.selectedCount = detail.selectedNodeIds.length;
  detail.revision += 1;
  detail.updatedAt = now;

  const serializedBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
  if (serializedBytes > MAX_SERIALIZED_TREE_BYTES) {
    throw new TreeOpError(
      'tree_too_large',
      `Serialized tree topology (${serializedBytes} bytes) exceeds maximum allowed size (${MAX_SERIALIZED_TREE_BYTES} bytes).`,
      400,
    );
  }

  const nextSelectionKey = detail.selectedNodeIds.join('\u0000');
  const selectionChanged = explicitSelectOp || nextSelectionKey !== prevSelectionKey;

  return {
    detail,
    docs,
    touchedDocNodeIds: [...touchedDocNodes],
    deletedDocNodeIds: [...deletedDocNodes],
    deletedDocIds: [...deletedDocIds],
    selectionChanged,
    topologyChanged,
  };
}
