import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  where,
  type DocumentData,
} from 'firebase/firestore';
import { auth, currentIdToken, db } from './firebase';
import { normalizeVirtualPath, resolveTreeNode, walkTreeOrder } from './tree-fakes';

export { normalizeVirtualPath };
import {
  TreeOpError,
  type TreeClientPort,
  type TreeCompileRequest,
  type TreeCompileResult,
  type TreeDetail,
  type TreeDocument,
  type TreeId,
  type TreeMediaRef,
  type TreeNarrationOptions,
  type TreeNodeId,
  type TreeNodeMeta,
  type TreeOp,
  type TreeSelectionSet,
  type TreeSelectionState,
  type TreeSummary,
} from './tree-types';
import type { NarrationStatus } from './types';

export interface ResolvedTreeRouteTarget {
  node: TreeNodeMeta | null;
  matchedVia: 'id' | 'path' | 'previous_path' | 'default_first_doc' | 'none';
  canonicalHref: string | null;
}

export interface BrowserTreeClient extends TreeClientPort {
  createTree(input: {
    title: string;
    description?: string;
    ops?: readonly TreeOp[];
  }): Promise<TreeDetail>;
  updateTreeMeta(
    treeId: TreeId,
    patch: { title?: string; description?: string },
  ): Promise<TreeDetail>;
  deleteTree(treeId: TreeId): Promise<void>;
}

/**
 * Builds the canonical deep link for a node inside a tree.
 * Includes both the human-readable virtual path and `?node=<id>` for move resilience.
 */
export function buildTreeNodeHref(
  treeId: TreeId,
  node: Pick<TreeNodeMeta, 'id' | 'path'>,
): string {
  const encodedTreeId = encodeURIComponent(treeId);
  const encodedPath = node.path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const pathSuffix = encodedPath ? `/${encodedPath}` : '';
  return `/trees/${encodedTreeId}${pathSuffix}?node=${encodeURIComponent(node.id)}`;
}

/**
 * Resolves the target tree node for `/trees/[treeId]/[[...path]]` routes.
 *
 * Priority:
 * 1. Explicit `?node=<nodeId>` query parameter (provides `canonicalHref` if path segments are stale).
 * 2. Non-empty `pathSegments` resolved via exact path (with or without `.md`) or `previousPaths`
 *    (provides `canonicalHref` when matched via `previous_path`).
 * 3. Empty `pathSegments` (tree root) defaults to the first `'doc'` node in `walkTreeOrder`.
 */
export function resolveTreeRouteTarget(
  tree: Pick<TreeDetail, 'rootIds' | 'nodes'> & { id?: TreeId },
  pathSegments: readonly string[] | undefined,
  nodeParam?: string | null,
  explicitTreeId?: TreeId,
): ResolvedTreeRouteTarget {
  const resolvedTreeId = explicitTreeId ?? tree.id ?? '';
  const decodedSegments = (pathSegments ?? [])
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .map((seg) => seg.trim())
    .filter(Boolean);
  const joinedPath = decodedSegments.join('/');

  const trimmedNodeId = nodeParam?.trim();
  if (trimmedNodeId && tree.nodes[trimmedNodeId]) {
    const node = tree.nodes[trimmedNodeId]!;
    const pathMatches = joinedPath === node.path;
    return {
      node,
      matchedVia: 'id',
      canonicalHref:
        !pathMatches && resolvedTreeId
          ? buildTreeNodeHref(resolvedTreeId, node)
          : null,
    };
  }

  if (decodedSegments.length > 0) {
    const resolved = resolveTreeNode(tree, joinedPath);
    if (resolved) {
      const needsRedirect =
        resolved.matchedVia === 'previous_path' ||
        (resolved.matchedVia === 'id' && joinedPath !== resolved.node.path);
      return {
        node: resolved.node,
        matchedVia: resolved.matchedVia,
        canonicalHref:
          needsRedirect && resolvedTreeId
            ? buildTreeNodeHref(resolvedTreeId, resolved.node)
            : null,
      };
    }
    return {
      node: null,
      matchedVia: 'none',
      canonicalHref: null,
    };
  }

  const ordered = walkTreeOrder(tree.rootIds, tree.nodes);
  const firstDoc = ordered.find((n) => n.kind === 'doc') ?? null;
  if (firstDoc) {
    return {
      node: firstDoc,
      matchedVia: 'default_first_doc',
      canonicalHref: null,
    };
  }

  return {
    node: null,
    matchedVia: 'none',
    canonicalHref: null,
  };
}

/**
 * Extracts `treeId` and virtual `pathSegments` from a browser pathname under `/trees/*`.
 */
export function parseTreePathname(pathname: string): {
  treeId: TreeId | null;
  pathSegments: string[];
} {
  if (!pathname.startsWith('/trees/')) {
    return { treeId: null, pathSegments: [] };
  }
  const rawParts = pathname
    .slice('/trees/'.length)
    .split('/')
    .filter(Boolean);
  if (rawParts.length === 0) {
    return { treeId: null, pathSegments: [] };
  }
  let treeId = rawParts[0]!;
  try {
    treeId = decodeURIComponent(treeId);
  } catch {
    // Keep raw segment if malformed URI encoding
  }
  const pathSegments = rawParts.slice(1).map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  return { treeId, pathSegments };
}

/**
 * Collects all descendant `'doc'` node IDs under `nodeId` (or `[nodeId]` if it is itself a doc).
 */
export function getDescendantDocIds(
  tree: Pick<TreeDetail, 'nodes'>,
  nodeId: TreeNodeId,
): TreeNodeId[] {
  const root = tree.nodes[nodeId];
  if (!root) return [];
  if (root.kind === 'doc') return [root.id];

  const docIds: TreeNodeId[] = [];
  const visit = (folder: TreeNodeMeta) => {
    for (const childId of folder.childIds) {
      const child = tree.nodes[childId];
      if (!child) continue;
      if (child.kind === 'doc') {
        docIds.push(child.id);
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return docIds;
}

/**
 * Computes the tri-state selection status for a folder based on its descendant documents.
 */
export function computeFolderSelectionState(
  tree: Pick<TreeDetail, 'nodes' | 'selectedNodeIds'>,
  folderId: TreeNodeId,
): boolean | 'indeterminate' {
  const descendantDocs = getDescendantDocIds(tree, folderId);
  if (descendantDocs.length === 0) return false;
  const selectedSet = new Set(tree.selectedNodeIds);
  let selectedCount = 0;
  for (const id of descendantDocs) {
    if (selectedSet.has(id)) selectedCount += 1;
  }
  if (selectedCount === 0) return false;
  if (selectedCount === descendantDocs.length) return true;
  return 'indeterminate';
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asNarrationStatus(value: unknown): 'unvoiced' | NarrationStatus {
  if (value === 'streaming' || value === 'ready' || value === 'error') {
    return value;
  }
  return 'unvoiced';
}

function toTreeNodeMeta(id: string, raw: unknown): TreeNodeMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const kind = data.kind === 'folder' ? 'folder' : 'doc';
  return {
    id: asString(data.id, id),
    kind,
    name: asString(data.name, id),
    path: asString(data.path, id),
    previousPaths: asStringArray(data.previousPaths),
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
    childIds: asStringArray(data.childIds),
    docId: typeof data.docId === 'string' ? data.docId : null,
    narrationId: typeof data.narrationId === 'string' ? data.narrationId : null,
    narrationStatus: asNarrationStatus(data.narrationStatus),
    narrationContentHash:
      typeof data.narrationContentHash === 'string' ? data.narrationContentHash : null,
    updatedAt: asNumber(data.updatedAt),
  };
}

function toTreeDetail(id: string, data: DocumentData | undefined): TreeDetail {
  const raw = (data ?? {}) as Record<string, unknown>;
  const rawNodes =
    raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)
      ? (raw.nodes as Record<string, unknown>)
      : {};
  const nodes: Record<TreeNodeId, TreeNodeMeta> = {};
  for (const [nodeId, value] of Object.entries(rawNodes)) {
    const parsed = toTreeNodeMeta(nodeId, value);
    if (parsed) nodes[nodeId] = parsed;
  }

  const rawSets =
    raw.selectionSets && typeof raw.selectionSets === 'object' && !Array.isArray(raw.selectionSets)
      ? (raw.selectionSets as Record<string, unknown>)
      : {};
  const selectionSets: Record<string, TreeSelectionSet> = {};
  for (const [setId, value] of Object.entries(rawSets)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    selectionSets[setId] = {
      id: asString(item.id, setId),
      title: asString(item.title, setId),
      nodeIds: asStringArray(item.nodeIds),
      ...(typeof item.instructions === 'string' ? { instructions: item.instructions } : {}),
      updatedAt: asNumber(item.updatedAt),
    };
  }

  const rawPathAssets =
    raw.pathAssets && typeof raw.pathAssets === 'object' && !Array.isArray(raw.pathAssets)
      ? (raw.pathAssets as Record<string, unknown>)
      : {};
  const pathAssets: Record<string, TreeMediaRef> = {};
  for (const [virtualPath, value] of Object.entries(rawPathAssets)) {
    if (!value || typeof value !== 'object') continue;
    const ref = value as Record<string, unknown>;
    if (typeof ref.type === 'string' && typeof ref.id === 'string') {
      pathAssets[virtualPath] = {
        type: ref.type as TreeMediaRef['type'],
        id: ref.id,
        ...(typeof ref.generationId === 'string' ? { generationId: ref.generationId } : {}),
      };
    }
  }

  const selectedNodeIds = asStringArray(raw.selectedNodeIds);
  const nodeValues = Object.values(nodes);
  const docCount = nodeValues.filter((n) => n.kind === 'doc').length;

  return {
    id,
    title: asString(raw.title, 'Untitled tree'),
    description: asString(raw.description, ''),
    nodeCount: asNumber(raw.nodeCount, nodeValues.length),
    docCount: asNumber(raw.docCount, docCount),
    selectedCount: asNumber(raw.selectedCount, selectedNodeIds.length),
    rootIds: asStringArray(raw.rootIds),
    nodes,
    selectedNodeIds,
    selectionSets,
    pathAssets,
    revision: asNumber(raw.revision, 1),
    createdAt: asNumber(raw.createdAt),
    updatedAt: asNumber(raw.updatedAt),
  };
}

function toTreeDocument(id: string, data: DocumentData | undefined): TreeDocument {
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    id,
    treeId: asString(raw.treeId),
    nodeId: asString(raw.nodeId),
    path: asString(raw.path),
    title: asString(raw.title, 'Untitled'),
    markdown: asString(raw.markdown),
    contentHash: asString(raw.contentHash),
    narrationId: typeof raw.narrationId === 'string' ? raw.narrationId : null,
    narrationStatus: asNarrationStatus(raw.narrationStatus),
    narrationStale: raw.narrationStale === true,
    updatedAt: asNumber(raw.updatedAt),
  };
}

async function authedTreeFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await currentIdToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  if (response.status === 204) {
    return undefined as T;
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errObj =
      payload?.error && typeof payload.error === 'object'
        ? (payload.error as Record<string, unknown>)
        : payload;
    const code =
      typeof errObj?.code === 'string' ? errObj.code : 'request_failed';
    const message =
      typeof errObj?.message === 'string'
        ? errObj.message
        : `Tree API request failed (${response.status}).`;
    throw new TreeOpError(code, message, response.status);
  }
  return payload as T;
}

/**
 * Browser implementation of `TreeClientPort` using Firebase `onSnapshot` for live
 * topology/selection/document subscriptions and authenticated REST calls to `/api/v1/trees/*`.
 */
export function createBrowserTreeClient(): BrowserTreeClient {
  const cachedTrees = new Map<TreeId, TreeDetail>();
  const cachedDocs = new Map<string, TreeDocument>();

  const mergeTreeAndSelection = (
    base: TreeDetail | null,
    selection: TreeSelectionState | null,
  ): TreeDetail | null => {
    if (!base) return null;
    if (!selection) return base;
    const validDocIds = selection.nodeIds.filter(
      (id) => base.nodes[id]?.kind === 'doc',
    );
    return {
      ...base,
      selectedNodeIds: validDocIds,
      selectedCount: validDocIds.length,
      revision: Math.max(base.revision, selection.revision),
      updatedAt: Math.max(base.updatedAt, selection.updatedAt),
    };
  };

  return {
    async listTrees(): Promise<TreeSummary[]> {
      const data = await authedTreeFetch<TreeSummary[] | { trees?: TreeSummary[] }>(
        '/api/v1/trees',
      );
      if (Array.isArray(data)) return data;
      return Array.isArray(data?.trees) ? data.trees : [];
    },

    async createTree(input): Promise<TreeDetail> {
      const data = await authedTreeFetch<TreeDetail | { tree?: TreeDetail }>(
        '/api/v1/trees',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      );
      const tree =
        data && typeof data === 'object' && 'tree' in data && data.tree
          ? data.tree
          : (data as TreeDetail);
      if (tree?.id) cachedTrees.set(tree.id, tree);
      return tree;
    },

    async updateTreeMeta(treeId, patch): Promise<TreeDetail> {
      const data = await authedTreeFetch<TreeDetail | { tree?: TreeDetail }>(
        `/api/v1/trees/${encodeURIComponent(treeId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      );
      const tree =
        data && typeof data === 'object' && 'tree' in data && data.tree
          ? data.tree
          : (data as TreeDetail);
      if (tree?.id) cachedTrees.set(tree.id, tree);
      return tree;
    },

    async deleteTree(treeId): Promise<void> {
      await authedTreeFetch<void>(
        `/api/v1/trees/${encodeURIComponent(treeId)}`,
        { method: 'DELETE' },
      );
      cachedTrees.delete(treeId);
    },

    watchTree(treeId: TreeId, onUpdate: (tree: TreeDetail | null) => void): () => void {
      let cancelled = false;
      let baseTree: TreeDetail | null = cachedTrees.get(treeId) ?? null;
      let selectionState: TreeSelectionState | null = null;

      if (baseTree) {
        onUpdate(baseTree);
      }

      const emit = () => {
        if (cancelled) return;
        const merged = mergeTreeAndSelection(baseTree, selectionState);
        if (merged) {
          cachedTrees.set(treeId, merged);
        } else {
          cachedTrees.delete(treeId);
        }
        onUpdate(merged);
      };

      let unsubTree: (() => void) | null = null;
      let unsubSelection: (() => void) | null = null;

      try {
        const treeRef = doc(db(), 'trees', treeId);
        const selectionRef = doc(db(), 'trees', treeId, 'state', 'selection');

        unsubTree = onSnapshot(
          treeRef,
          (snapshot) => {
            if (cancelled) return;
            if (!snapshot.exists()) {
              baseTree = null;
              emit();
              return;
            }
            baseTree = toTreeDetail(snapshot.id, snapshot.data());
            emit();
          },
          () => {
            void authedTreeFetch<TreeDetail | { tree?: TreeDetail }>(
              `/api/v1/trees/${encodeURIComponent(treeId)}`,
            )
              .then((data) => {
                if (cancelled) return;
                baseTree =
                  data && typeof data === 'object' && 'tree' in data && data.tree
                    ? data.tree
                    : (data as TreeDetail);
                emit();
              })
              .catch(() => {
                if (!cancelled) onUpdate(null);
              });
          },
        );

        unsubSelection = onSnapshot(
          selectionRef,
          (snapshot) => {
            if (cancelled) return;
            if (!snapshot.exists()) {
              selectionState = null;
              if (baseTree) emit();
              return;
            }
            const raw = (snapshot.data() ?? {}) as Record<string, unknown>;
            selectionState = {
              nodeIds: asStringArray(raw.nodeIds),
              revision: asNumber(raw.revision, 1),
              updatedAt: asNumber(raw.updatedAt),
            };
            if (baseTree) emit();
          },
          () => {
            // Selection subdocument is optional; ignore listener errors if absent
          },
        );
      } catch {
        void authedTreeFetch<TreeDetail | { tree?: TreeDetail }>(
          `/api/v1/trees/${encodeURIComponent(treeId)}`,
        )
          .then((data) => {
            if (cancelled) return;
            baseTree =
              data && typeof data === 'object' && 'tree' in data && data.tree
                ? data.tree
                : (data as TreeDetail);
            emit();
          })
          .catch(() => {
            if (!cancelled) onUpdate(null);
          });
      }

      return () => {
        cancelled = true;
        unsubTree?.();
        unsubSelection?.();
      };
    },

    watchDocument(
      treeId: TreeId,
      nodeId: TreeNodeId,
      onUpdate: (doc: TreeDocument | null) => void,
    ): () => void {
      let cancelled = false;
      let unsubDoc: (() => void) | null = null;
      const docCacheKey = `${treeId}:${nodeId}`;
      const cachedDoc = cachedDocs.get(docCacheKey);
      if (cachedDoc) {
        onUpdate(cachedDoc);
      }

      const emitDoc = (nextDoc: TreeDocument | null) => {
        if (cancelled) return;
        if (nextDoc) {
          cachedDocs.set(docCacheKey, nextDoc);
        } else {
          cachedDocs.delete(docCacheKey);
        }
        onUpdate(nextDoc);
      };

      const fetchViaApi = async () => {
        try {
          const data = await authedTreeFetch<TreeDocument | { document?: TreeDocument }>(
            `/api/v1/trees/${encodeURIComponent(treeId)}/nodes/${encodeURIComponent(nodeId)}`,
          );
          if (cancelled) return;
          const resolved =
            data && typeof data === 'object' && 'document' in data && data.document
              ? data.document
              : (data as TreeDocument);
          emitDoc(resolved ?? null);
        } catch {
          if (!cancelled) emitDoc(null);
        }
      };

      const handleDocSnapshot = (docId: string, data: DocumentData | undefined) => {
        if (cancelled) return;
        const raw = (data ?? {}) as Record<string, unknown>;
        if (typeof raw.storagePath === 'string' && raw.storagePath.length > 0 && !raw.markdown) {
          void fetchViaApi();
          return;
        }
        emitDoc(toTreeDocument(docId, data));
      };

      try {
        const knownDocId = cachedTrees.get(treeId)?.nodes[nodeId]?.docId ?? null;
        if (knownDocId) {
          unsubDoc = onSnapshot(
            doc(db(), 'treeDocs', knownDocId),
            (snapshot) => {
              if (cancelled) return;
              if (!snapshot.exists()) {
                void fetchViaApi();
                return;
              }
              handleDocSnapshot(snapshot.id, snapshot.data());
            },
            () => {
              void fetchViaApi();
            },
          );
        } else {
          const uid = auth().currentUser?.uid;
          if (!uid) {
            void fetchViaApi();
            return () => {
              cancelled = true;
            };
          }
          const q = query(
            collection(db(), 'treeDocs'),
            where('ownerUid', '==', uid),
            where('treeId', '==', treeId),
            where('nodeId', '==', nodeId),
            limit(1),
          );
          unsubDoc = onSnapshot(
            q,
            (snapshot) => {
              if (cancelled) return;
              const first = snapshot.docs[0];
              if (!first) {
                void fetchViaApi();
                return;
              }
              handleDocSnapshot(first.id, first.data());
            },
            () => {
              void fetchViaApi();
            },
          );
        }
      } catch {
        void fetchViaApi();
      }

      return () => {
        cancelled = true;
        unsubDoc?.();
      };
    },

    async applyOps(
      treeId: TreeId,
      ops: readonly TreeOp[],
      options?: { expectedRevision?: number },
    ): Promise<TreeDetail> {
      const data = await authedTreeFetch<TreeDetail | { tree?: TreeDetail }>(
        `/api/v1/trees/${encodeURIComponent(treeId)}/ops`,
        {
          method: 'POST',
          body: JSON.stringify({
            ops,
            ...(options?.expectedRevision !== undefined
              ? { expectedRevision: options.expectedRevision }
              : {}),
          }),
        },
      );
      const tree =
        data && typeof data === 'object' && 'tree' in data && data.tree
          ? data.tree
          : (data as TreeDetail);
      if (tree?.id) cachedTrees.set(tree.id, tree);
      return tree;
    },

    async compileSelection(
      treeId: TreeId,
      request: TreeCompileRequest,
    ): Promise<TreeCompileResult> {
      const data = await authedTreeFetch<TreeCompileResult | { result?: TreeCompileResult }>(
        `/api/v1/trees/${encodeURIComponent(treeId)}/compile`,
        {
          method: 'POST',
          body: JSON.stringify(request),
        },
      );
      return data && typeof data === 'object' && 'result' in data && data.result
        ? data.result
        : (data as TreeCompileResult);
    },

    async startNodeNarration(
      treeId: TreeId,
      nodeId: TreeNodeId,
      options?: TreeNarrationOptions,
    ): Promise<{ narrationId: string }> {
      try {
        const data = await authedTreeFetch<{
          narrationId?: string;
          document?: { narrationId?: string | null };
          node?: { narrationId?: string | null };
        }>(
          `/api/v1/trees/${encodeURIComponent(treeId)}/nodes/${encodeURIComponent(nodeId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              narrate: true,
              ...(options?.voice ? { voice: options.voice } : {}),
              ...(options?.voiceProvider ? { voiceProvider: options.voiceProvider } : {}),
              ...(options?.voiceId ? { voiceId: options.voiceId } : {}),
              ...(options?.promptStyle !== undefined ? { promptStyle: options.promptStyle } : {}),
            }),
          },
        );
        const narrationId =
          data?.narrationId ?? data?.document?.narrationId ?? data?.node?.narrationId;
        if (narrationId) return { narrationId };
      } catch {
        // Fallback to compile endpoint for single-node narration
      }
      const compiled = await this.compileSelection(treeId, {
        targets: [nodeId],
        narrate: true,
        ...(options?.voice ? { voice: options.voice } : {}),
        ...(options?.voiceProvider ? { voiceProvider: options.voiceProvider } : {}),
        ...(options?.voiceId ? { voiceId: options.voiceId } : {}),
        ...(options?.promptStyle !== undefined ? { promptStyle: options.promptStyle } : {}),
      });
      if (!compiled.narrationId) {
        throw new TreeOpError('narration_failed', 'Could not start narration for document.', 500);
      }
      return { narrationId: compiled.narrationId };
    },
  };
}
