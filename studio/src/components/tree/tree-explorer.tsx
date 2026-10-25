"use client";

import { useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  ListChecks,
  Minus,
  Plus,
  Volume2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { buildTreeNodeHref, normalizeVirtualPath } from "@/lib/tree-client";
import {
  type TreeDetail,
  type TreeNodeId,
  type TreeNodeMeta,
} from "@/lib/tree-types";
import { useTreeContext } from "./tree-provider";

interface VisibleTreeRow {
  node: TreeNodeMeta;
  depth: number;
  expanded: boolean;
}

function collectMatchingNodeIds(
  tree: TreeDetail,
  rawQuery: string,
): Set<TreeNodeId> | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return null;

  const visibleIds = new Set<TreeNodeId>();
  for (const node of Object.values(tree.nodes)) {
    const label = node.name.replace(/\.md$/i, "").toLowerCase();
    if (
      label.includes(query) ||
      node.path.toLowerCase().includes(query)
    ) {
      visibleIds.add(node.id);
      let parentId = node.parentId;
      const seen = new Set<TreeNodeId>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        visibleIds.add(parentId);
        parentId = tree.nodes[parentId]?.parentId ?? null;
      }
    }
  }
  return visibleIds;
}

function flattenVisibleTree(
  tree: TreeDetail,
  expandedFolderIds: ReadonlySet<TreeNodeId>,
  filterSet: Set<TreeNodeId> | null,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const visit = (ids: readonly TreeNodeId[], depth: number) => {
    for (const id of ids) {
      if (filterSet && !filterSet.has(id)) continue;
      const node = tree.nodes[id];
      if (!node) continue;
      const isExpanded =
        node.kind === "folder" &&
        (filterSet !== null || expandedFolderIds.has(node.id));
      rows.push({
        node,
        depth,
        expanded: isExpanded,
      });
      if (node.kind === "folder" && isExpanded && node.childIds.length > 0) {
        visit(node.childIds, depth + 1);
      }
    }
  };

  visit(tree.rootIds, 0);
  return rows;
}

export interface TreeExplorerProps {
  docked?: boolean;
  onNavigate?: () => void;
}

export function TreeExplorer({
  docked = false,
  onNavigate,
}: TreeExplorerProps) {
  const router = useRouter();
  const {
    tree,
    activeNode,
    expandedFolderIds,
    toggleFolder,
    setFolderExpanded,
    getFolderSelectionState,
    toggleSelectNode,
    clearSelection,
    applyOps,
  } = useTreeContext();

  const [filterQuery, setFilterQuery] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [submittingFolder, setSubmittingFolder] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);

  const activeFolderPath = useMemo(() => {
    if (!activeNode) return "";
    if (activeNode.kind === "folder") return activeNode.path;
    const slashIndex = activeNode.path.lastIndexOf("/");
    return slashIndex > 0 ? activeNode.path.slice(0, slashIndex) : "";
  }, [activeNode]);

  const filterSet = useMemo(
    () => (tree ? collectMatchingNodeIds(tree, filterQuery) : null),
    [tree, filterQuery],
  );

  const visibleRows = useMemo(
    () =>
      tree ? flattenVisibleTree(tree, expandedFolderIds, filterSet) : [],
    [tree, expandedFolderIds, filterSet],
  );

  const maxDepth = useMemo(() => {
    let max = 1;
    for (const row of visibleRows) {
      if (row.depth + 1 > max) max = row.depth + 1;
    }
    return Math.min(max, 8);
  }, [visibleRows]);

  if (docked) {
    return (
      <div className="grid place-items-center py-2">
        <Link
          href="/trees"
          onClick={onNavigate}
          aria-label={tree?.title ? `Trees (${tree.title})` : "Trees"}
          title={tree?.title ?? "Trees"}
          className="grid size-8 place-items-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground transition-colors hover:opacity-90"
        >
          <FolderTree size={16} strokeWidth={2} />
        </Link>
      </div>
    );
  }

  if (!tree) {
    return (
      <section aria-label="Tree explorer" className="grid gap-2 py-2">
        <Link
          href="/trees"
          onClick={onNavigate}
          className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          <span className="truncate">All trees</span>
        </Link>
      </section>
    );
  }

  const showFilter = tree.nodeCount > 3;
  const hasSelection = tree.selectedNodeIds.length > 0;
  const showCheckboxes = selectionMode || hasSelection;
  const selectedSet = new Set(tree.selectedNodeIds);

  const handleToggleSelectionMode = () => {
    if (showCheckboxes) {
      setSelectionMode(false);
      if (hasSelection) {
        void clearSelection();
      }
    } else {
      setSelectionMode(true);
    }
  };

  const handleOpenBriefing = () => {
    router.push(`/trees/${encodeURIComponent(tree.id)}?briefing=1`);
    onNavigate?.();
  };

  const handleCreateFolder = async () => {
    const raw = newFolderPath.trim();
    if (!raw || submittingFolder) return;
    setSubmittingFolder(true);
    try {
      const normalized = normalizeVirtualPath(raw);
      const updated = await applyOps([{ op: "mkdir", path: normalized }]);
      if (updated) {
        for (const node of Object.values(updated.nodes)) {
          if (
            node.kind === "folder" &&
            (node.path === normalized || normalized.startsWith(`${node.path}/`))
          ) {
            setFolderExpanded(node.id, true);
          }
        }
      }
      setNewFolderPath("");
      setCreatingFolder(false);
      toast.success(`Created folder "${normalized}"`);
    } catch (error) {
      toast.error((error as Error).message || "Could not create folder.");
    } finally {
      setSubmittingFolder(false);
    }
  };

  const treeGridStyle: CSSProperties = {
    "--tree-max-depth": maxDepth,
    gridTemplateColumns:
      "repeat(var(--tree-max-depth, 8), 14px) minmax(0, 1fr)",
  } as CSSProperties;

  const newDocHref = `/trees/${encodeURIComponent(tree.id)}?new=1${
    activeFolderPath ? `&folder=${encodeURIComponent(activeFolderPath)}` : ""
  }`;

  return (
    <section
      aria-label={tree.title}
      className="grid content-start gap-2.5 py-2"
    >
      <Link
        href="/trees"
        onClick={onNavigate}
        className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1 text-[12px] font-medium text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      >
        <ArrowLeft size={13} strokeWidth={2} />
        <span className="truncate">All trees</span>
      </Link>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1 border-b border-sidebar-border px-2 py-1.5">
        <Link
          href={`/trees/${encodeURIComponent(tree.id)}`}
          onClick={onNavigate}
          title={tree.title}
          className="truncate text-[13px] font-semibold text-foreground transition-colors hover:text-primary"
        >
          {tree.title}
        </Link>
        <button
          type="button"
          onClick={handleToggleSelectionMode}
          aria-pressed={showCheckboxes}
          aria-label={
            showCheckboxes ? "Exit selection mode" : "Select documents"
          }
          title={
            showCheckboxes
              ? "Hide selection checkboxes"
              : "Select documents for briefing"
          }
          className={cn(
            "grid size-6 place-items-center rounded-xs transition-colors",
            showCheckboxes
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-ink-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <ListChecks size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            setCreatingFolder((prev) => !prev);
            if (!creatingFolder && activeFolderPath && !newFolderPath) {
              setNewFolderPath(`${activeFolderPath}/`);
            }
          }}
          aria-label="New folder"
          title="New folder"
          className="grid size-6 place-items-center rounded-xs text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <FolderPlus size={13} strokeWidth={2} />
        </button>
        <Link
          href={newDocHref}
          onClick={onNavigate}
          aria-label="New document"
          title={
            activeFolderPath
              ? `New document in ${activeFolderPath}/`
              : "New document"
          }
          className="grid size-6 place-items-center rounded-xs text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <FilePlus size={13} strokeWidth={2} />
        </Link>
      </div>

      {creatingFolder ? (
        <div className="grid gap-1.5 rounded-md border border-sidebar-border bg-card p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
            <span className="text-[11px] font-medium text-ink-muted">
              New folder path
            </span>
            <button
              type="button"
              aria-label="Close new folder"
              onClick={() => setCreatingFolder(false)}
              className="grid size-5 place-items-center rounded-xs text-ink-muted hover:text-foreground"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
            <input
              type="text"
              value={newFolderPath}
              onChange={(event) => setNewFolderPath(event.target.value)}
              placeholder="architecture/storage/firestore"
              aria-label="Folder path"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleCreateFolder();
                } else if (event.key === "Escape") {
                  setCreatingFolder(false);
                }
              }}
              className="w-full rounded-xs border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="button"
              disabled={submittingFolder || newFolderPath.trim().length === 0}
              onClick={() => void handleCreateFolder()}
              className="rounded-xs bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      ) : null}

      {showFilter ? (
        <div className="grid px-1">
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Filter tree…"
            aria-label="Filter tree"
            className="w-full rounded-md border border-sidebar-border bg-background px-2.5 py-1 text-[12px] text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      ) : null}

      <div
        role="tree"
        aria-label={`${tree.title} files`}
        className="grid gap-0.5"
        style={treeGridStyle}
      >
        {visibleRows.map(({ node, depth, expanded }) => {
          const isFolder = node.kind === "folder";
          const isCurrent = activeNode?.id === node.id;
          const displayLabel = node.name.replace(/\.md$/i, "");
          const checkedState: boolean | "indeterminate" = isFolder
            ? getFolderSelectionState(node.id)
            : selectedSet.has(node.id);

          return (
            <div
              key={node.id}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isFolder ? expanded : undefined}
              aria-selected={checkedState === true}
              className="col-span-full grid grid-cols-subgrid items-center"
            >
              <div
                style={{ gridColumn: `${depth + 1} / -1` }}
                className={cn(
                  "group grid items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors",
                  showCheckboxes
                    ? "grid-cols-[16px_16px_16px_minmax(0,1fr)_auto]"
                    : "grid-cols-[16px_16px_minmax(0,1fr)_auto]",
                  depth > 0 && "border-l border-sidebar-border/70",
                  isCurrent
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-ink-muted hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                {showCheckboxes ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={
                      checkedState === "indeterminate" ? "mixed" : checkedState
                    }
                    aria-label={`Select ${displayLabel}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleSelectNode(node.id);
                    }}
                    className={cn(
                      "grid size-3.5 place-items-center rounded-[3px] border transition-colors",
                      checkedState === true || checkedState === "indeterminate"
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-sidebar-border bg-background hover:border-foreground/50",
                    )}
                  >
                    {checkedState === true ? (
                      <Check size={10} strokeWidth={2.5} />
                    ) : checkedState === "indeterminate" ? (
                      <Minus size={10} strokeWidth={2.5} />
                    ) : null}
                  </button>
                ) : null}

                {isFolder ? (
                  <button
                    type="button"
                    aria-label={
                      expanded
                        ? `Collapse ${displayLabel}`
                        : `Expand ${displayLabel}`
                    }
                    onClick={() => toggleFolder(node.id)}
                    className="grid size-4 place-items-center rounded-xs text-ink-muted hover:text-foreground"
                  >
                    {expanded ? (
                      <ChevronDown size={13} strokeWidth={2} />
                    ) : (
                      <ChevronRight size={13} strokeWidth={2} />
                    )}
                  </button>
                ) : (
                  <span aria-hidden="true" className="size-4" />
                )}

                {isFolder ? (
                  <span
                    aria-hidden="true"
                    className="grid size-4 place-items-center text-ink-muted"
                  >
                    {expanded ? (
                      <FolderOpen size={13} strokeWidth={1.9} />
                    ) : (
                      <Folder size={13} strokeWidth={1.9} />
                    )}
                  </span>
                ) : node.narrationStatus === "ready" ? (
                  <span
                    aria-label="Audio ready"
                    className="grid size-4 place-items-center text-primary"
                  >
                    <Volume2 size={13} strokeWidth={2} />
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className="grid size-4 place-items-center text-ink-faint"
                  >
                    <FileText size={12} strokeWidth={1.9} />
                  </span>
                )}

                {isFolder ? (
                  <button
                    type="button"
                    onClick={() => toggleFolder(node.id)}
                    title={node.path}
                    className="grid min-w-0 text-left font-medium text-foreground/90"
                  >
                    <span className="truncate">{displayLabel}</span>
                  </button>
                ) : (
                  <Link
                    href={buildTreeNodeHref(tree.id, node)}
                    onClick={onNavigate}
                    aria-current={isCurrent ? "page" : undefined}
                    title={node.path}
                    className="grid min-w-0 text-left"
                  >
                    <span className="truncate">{displayLabel}</span>
                  </Link>
                )}

                {isFolder ? (
                  <Link
                    href={`/trees/${encodeURIComponent(tree.id)}?new=1&folder=${encodeURIComponent(node.path)}`}
                    onClick={onNavigate}
                    aria-label={`New document in ${node.path}`}
                    title={`New document in ${node.path}/`}
                    className="grid size-5 place-items-center rounded-xs text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-sidebar-accent hover:text-foreground"
                  >
                    <Plus size={12} strokeWidth={2} />
                  </Link>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasSelection ? (
        <div
          role="region"
          aria-label="Selection actions"
          className="sticky bottom-0 grid gap-1.5 rounded-md border border-sidebar-border bg-sidebar p-2"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-0.5">
            <span className="truncate text-[11px] font-medium text-ink-muted">
              {tree.selectedNodeIds.length}{" "}
              {tree.selectedNodeIds.length === 1 ? "doc" : "docs"} selected
            </span>
            <button
              type="button"
              onClick={() => void clearSelection()}
              className="rounded-xs px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            >
              Clear
            </button>
          </div>
          <button
            type="button"
            onClick={handleOpenBriefing}
            className="grid grid-flow-col items-center justify-center gap-1.5 rounded-xs bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            <Volume2 size={13} strokeWidth={2} />
            <span>Create briefing</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
