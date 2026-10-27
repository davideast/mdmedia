"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  computeFolderSelectionState,
  createBrowserTreeClient,
  parseTreePathname,
  resolveTreeRouteTarget,
  type ResolvedTreeRouteTarget,
} from "@/lib/tree-client";
import type {
  TreeClientPort,
  TreeCompileRequest,
  TreeCompileResult,
  TreeDetail,
  TreeDocument,
  TreeId,
  TreeNarrationOptions,
  TreeNodeId,
  TreeNodeMeta,
  TreeOp,
} from "@/lib/tree-types";

export interface TreeContextValue {
  client: TreeClientPort;
  treeId: TreeId | null;
  tree: TreeDetail | null;
  loadingTree: boolean;
  activeNode: TreeNodeMeta | null;
  activeDocument: TreeDocument | null;
  loadingDocument: boolean;
  routeResolution: ResolvedTreeRouteTarget;
  expandedFolderIds: ReadonlySet<TreeNodeId>;
  toggleFolder: (folderId: TreeNodeId) => void;
  setFolderExpanded: (folderId: TreeNodeId, expanded: boolean) => void;
  expandAncestors: (nodeId: TreeNodeId) => void;
  getFolderSelectionState: (folderId: TreeNodeId) => boolean | "indeterminate";
  toggleSelectNode: (nodeId: TreeNodeId) => Promise<TreeDetail | null>;
  clearSelection: () => Promise<TreeDetail | null>;
  applyPresetSelection: (presetId: string) => Promise<TreeDetail | null>;
  saveSelectionPreset: (title: string, instructions?: string) => Promise<TreeDetail | null>;
  deleteSelectionPreset: (presetId: string) => Promise<TreeDetail | null>;
  compileSelection: (request?: TreeCompileRequest) => Promise<TreeCompileResult | null>;
  startNodeNarration: (
    nodeId?: TreeNodeId,
    options?: TreeNarrationOptions,
  ) => Promise<{ narrationId: string } | null>;
  applyOps: (
    ops: readonly TreeOp[],
    options?: { expectedRevision?: number },
  ) => Promise<TreeDetail | null>;
}

const TreeContext = createContext<TreeContextValue | null>(null);

// Shared bridge so sibling shell panels (<NavRail> and <ContextPanel>) inside <AppShell>
// stay synchronized with the active <TreeProvider> rendered by the /trees/[treeId] route.
let activeBridgeValue: TreeContextValue | null = null;
const bridgeListeners = new Set<() => void>();

function subscribeBridge(listener: () => void): () => void {
  bridgeListeners.add(listener);
  return () => {
    bridgeListeners.delete(listener);
  };
}

function getBridgeSnapshot(): TreeContextValue | null {
  return activeBridgeValue;
}

function publishBridgeValue(next: TreeContextValue | null): void {
  if (activeBridgeValue === next) return;
  activeBridgeValue = next;
  for (const listener of bridgeListeners) {
    listener();
  }
}

let defaultBrowserClient: TreeClientPort | null = null;
function getDefaultBrowserClient(): TreeClientPort {
  if (!defaultBrowserClient) {
    defaultBrowserClient = createBrowserTreeClient();
  }
  return defaultBrowserClient;
}

function collectAncestorFolderIds(
  tree: TreeDetail,
  nodeId: TreeNodeId,
): TreeNodeId[] {
  const ancestors: TreeNodeId[] = [];
  let cursor = tree.nodes[nodeId]?.parentId ?? null;
  const visited = new Set<TreeNodeId>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const parent = tree.nodes[cursor];
    if (!parent) break;
    if (parent.kind === "folder") {
      ancestors.push(parent.id);
    }
    cursor = parent.parentId;
  }
  return ancestors;
}

export interface TreeProviderProps {
  client?: TreeClientPort;
  treeId?: TreeId | null;
  pathSegments?: readonly string[];
  nodeParam?: string | null;
  children: ReactNode;
}

function useInternalTreeState(options: {
  client?: TreeClientPort;
  treeId?: TreeId | null;
  pathSegments?: readonly string[];
  nodeParam?: string | null;
  enabled: boolean;
}): TreeContextValue {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const parsedFromUrl = useMemo(() => parseTreePathname(pathname ?? ""), [pathname]);

  const client = useMemo(
    () => options.client ?? getDefaultBrowserClient(),
    [options.client],
  );
  const treeId =
    options.treeId !== undefined ? options.treeId : parsedFromUrl.treeId;
  const pathSegments =
    options.pathSegments !== undefined
      ? options.pathSegments
      : parsedFromUrl.pathSegments;
  const nodeParam =
    options.nodeParam !== undefined
      ? options.nodeParam
      : searchParams?.get("node") ?? null;

  const [rawTree, setTree] = useState<TreeDetail | null>(null);
  const [loadedTreeId, setLoadedTreeId] = useState<TreeId | null>(null);
  const [rawDocument, setActiveDocument] = useState<TreeDocument | null>(null);
  const [loadedDocNodeId, setLoadedDocNodeId] = useState<TreeNodeId | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<TreeNodeId>>(
    () => new Set(),
  );
  const initializedTreeRef = useRef<TreeId | null>(null);

  const tree =
    options.enabled && treeId && rawTree?.id === treeId ? rawTree : null;
  const loadingTree = Boolean(
    options.enabled && treeId && loadedTreeId !== treeId && !tree,
  );

  useEffect(() => {
    if (!options.enabled || !treeId) {
      return;
    }
    return client.watchTree(treeId, (nextTree) => {
      setTree(nextTree);
      setLoadedTreeId(treeId);
    });
  }, [client, treeId, options.enabled]);

  const routeResolution = useMemo<ResolvedTreeRouteTarget>(() => {
    if (!tree) {
      return { node: null, matchedVia: "none", canonicalHref: null };
    }
    return resolveTreeRouteTarget(tree, pathSegments, nodeParam, tree.id);
  }, [tree, pathSegments, nodeParam]);

  const activeNode = routeResolution.node;

  // Auto-expand folders on initial load (all folders for <= 100 nodes, or root folders for larger trees)
  // and ancestors of the active node
  useEffect(() => {
    if (!tree) return;
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      if (initializedTreeRef.current !== tree.id) {
        initializedTreeRef.current = tree.id;
        const COLLAPSED_REFERENCE_ROOTS = new Set([
          "works",
          "taxonomy",
          "comparisons",
          "explorations",
          "styles",
          "queue",
        ]);
        if (tree.nodeCount <= 120) {
          for (const node of Object.values(tree.nodes)) {
            const topSegment = node.path.split("/")[0]?.toLowerCase() ?? "";
            if (
              node.kind === "folder" &&
              !COLLAPSED_REFERENCE_ROOTS.has(topSegment) &&
              !next.has(node.id)
            ) {
              next.add(node.id);
              changed = true;
            }
          }
        } else {
          for (const rootId of tree.rootIds) {
            const rootNode = tree.nodes[rootId];
            if (
              rootNode?.kind === "folder" &&
              !COLLAPSED_REFERENCE_ROOTS.has(rootNode.name.toLowerCase()) &&
              !next.has(rootId)
            ) {
              next.add(rootId);
              changed = true;
            }
          }
        }
      }
      if (activeNode) {
        for (const folderId of collectAncestorFolderIds(tree, activeNode.id)) {
          if (!next.has(folderId)) {
            next.add(folderId);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [tree, activeNode]);

  const activeTreeId = tree?.id ?? null;
  const activeDocNodeId =
    activeNode?.kind === "doc" ? activeNode.id : null;

  useEffect(() => {
    if (!options.enabled || !activeTreeId || !activeDocNodeId) {
      return;
    }
    return client.watchDocument(activeTreeId, activeDocNodeId, (nextDoc) => {
      setActiveDocument(nextDoc);
      setLoadedDocNodeId(activeDocNodeId);
    });
  }, [client, activeTreeId, activeDocNodeId, options.enabled]);

  const activeDocument =
    options.enabled &&
    activeTreeId &&
    activeDocNodeId &&
    rawDocument?.nodeId === activeDocNodeId
      ? rawDocument
      : null;

  const effectiveLoadingDocument = Boolean(
    options.enabled &&
      activeTreeId &&
      activeDocNodeId &&
      loadedDocNodeId !== activeDocNodeId &&
      !activeDocument,
  );

  const toggleFolder = useCallback((folderId: TreeNodeId) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const setFolderExpanded = useCallback((folderId: TreeNodeId, expanded: boolean) => {
    setExpandedFolderIds((prev) => {
      const has = prev.has(folderId);
      if (has === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(folderId);
      else next.delete(folderId);
      return next;
    });
  }, []);

  const expandAncestors = useCallback(
    (nodeId: TreeNodeId) => {
      if (!tree) return;
      const ancestors = collectAncestorFolderIds(tree, nodeId);
      if (ancestors.length === 0) return;
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of ancestors) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [tree],
  );

  const getFolderSelectionState = useCallback(
    (folderId: TreeNodeId): boolean | "indeterminate" => {
      if (!tree) return false;
      return computeFolderSelectionState(tree, folderId);
    },
    [tree],
  );

  const applyOps = useCallback(
    async (
      ops: readonly TreeOp[],
      opOptions?: { expectedRevision?: number },
    ): Promise<TreeDetail | null> => {
      if (!tree) return null;
      const updated = await client.applyOps(tree.id, ops, opOptions);
      setTree(updated);
      return updated;
    },
    [client, tree],
  );

  const toggleSelectNode = useCallback(
    async (nodeId: TreeNodeId): Promise<TreeDetail | null> => {
      if (!tree) return null;
      const node = tree.nodes[nodeId];
      if (!node) return null;

      let mode: "add" | "remove";
      if (node.kind === "folder") {
        const folderState = computeFolderSelectionState(tree, node.id);
        mode = folderState === true ? "remove" : "add";
      } else {
        const isSelected = tree.selectedNodeIds.includes(node.id);
        mode = isSelected ? "remove" : "add";
      }

      const updated = await client.applyOps(tree.id, [
        { op: "select", targets: [node.id], mode },
      ]);
      setTree(updated);
      return updated;
    },
    [client, tree],
  );

  const clearSelection = useCallback(async (): Promise<TreeDetail | null> => {
    if (!tree) return null;
    const updated = await client.applyOps(tree.id, [
      { op: "select", targets: [], mode: "clear" },
    ]);
    setTree(updated);
    return updated;
  }, [client, tree]);

  const applyPresetSelection = useCallback(
    async (presetId: string): Promise<TreeDetail | null> => {
      if (!tree) return null;
      const preset = tree.selectionSets[presetId];
      if (!preset) return null;
      const updated = await client.applyOps(tree.id, [
        { op: "select", targets: preset.nodeIds, mode: "set" },
      ]);
      setTree(updated);
      return updated;
    },
    [client, tree],
  );

  const saveSelectionPreset = useCallback(
    async (title: string, instructions?: string): Promise<TreeDetail | null> => {
      if (!tree || tree.selectedNodeIds.length === 0) return null;
      const trimmed = title.trim();
      if (!trimmed) return null;
      const updated = await client.applyOps(tree.id, [
        {
          op: "save_selection_set",
          title: trimmed,
          targets: tree.selectedNodeIds,
          ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
        },
      ]);
      setTree(updated);
      return updated;
    },
    [client, tree],
  );

  const deleteSelectionPreset = useCallback(
    async (presetId: string): Promise<TreeDetail | null> => {
      if (!tree) return null;
      const updated = await client.applyOps(tree.id, [
        { op: "delete_selection_set", id: presetId },
      ]);
      setTree(updated);
      return updated;
    },
    [client, tree],
  );

  const compileSelection = useCallback(
    async (request: TreeCompileRequest = {}): Promise<TreeCompileResult | null> => {
      if (!tree) return null;
      return client.compileSelection(tree.id, request);
    },
    [client, tree],
  );

  const startNodeNarration = useCallback(
    async (
      targetNodeId?: TreeNodeId,
      narrationOptions?: TreeNarrationOptions,
    ): Promise<{ narrationId: string } | null> => {
      const resolvedNodeId = targetNodeId ?? activeNode?.id;
      if (!tree || !resolvedNodeId) return null;
      return client.startNodeNarration(tree.id, resolvedNodeId, narrationOptions);
    },
    [client, tree, activeNode?.id],
  );

  return useMemo<TreeContextValue>(
    () => ({
      client,
      treeId,
      tree,
      loadingTree,
      activeNode,
      activeDocument,
      loadingDocument: effectiveLoadingDocument,
      routeResolution,
      expandedFolderIds,
      toggleFolder,
      setFolderExpanded,
      expandAncestors,
      getFolderSelectionState,
      toggleSelectNode,
      clearSelection,
      applyPresetSelection,
      saveSelectionPreset,
      deleteSelectionPreset,
      compileSelection,
      startNodeNarration,
      applyOps,
    }),
    [
      client,
      treeId,
      tree,
      loadingTree,
      activeNode,
      activeDocument,
      effectiveLoadingDocument,
      routeResolution,
      expandedFolderIds,
      toggleFolder,
      setFolderExpanded,
      expandAncestors,
      getFolderSelectionState,
      toggleSelectNode,
      clearSelection,
      applyPresetSelection,
      saveSelectionPreset,
      deleteSelectionPreset,
      compileSelection,
      startNodeNarration,
      applyOps,
    ],
  );
}

export function TreeProvider({
  client,
  treeId,
  pathSegments,
  nodeParam,
  children,
}: TreeProviderProps) {
  const value = useInternalTreeState({
    client,
    treeId,
    pathSegments,
    nodeParam,
    enabled: true,
  });

  useEffect(() => {
    publishBridgeValue(value);
  }, [value]);

  useEffect(() => {
    return () => {
      publishBridgeValue(null);
    };
  }, []);

  return <TreeContext.Provider value={value}>{children}</TreeContext.Provider>;
}

export function useOptionalTreeContext(): TreeContextValue | null {
  return useContext(TreeContext);
}

export function useTreeContext(): TreeContextValue {
  const direct = useContext(TreeContext);
  const bridge = useSyncExternalStore(
    subscribeBridge,
    getBridgeSnapshot,
    getBridgeSnapshot,
  );
  const existing = direct ?? bridge;
  const fallback = useInternalTreeState({
    enabled: existing === null,
  });
  return existing ?? fallback;
}
