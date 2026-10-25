"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  FilePlus,
  FolderTree,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useWorkspaceField } from "@/components/shell/workspace-provider";
import { createBrowserTreeClient } from "@/lib/tree-client";
import type { TreeSummary } from "@/lib/tree-types";

export default function TreesPage() {
  const router = useRouter();
  const client = useMemo(() => createBrowserTreeClient(), []);
  const [trees, setTrees] = useState<TreeSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newTitle, setNewTitle] = useWorkspaceField("newTreeTitle", "");
  const [newDescription, setNewDescription] = useWorkspaceField(
    "newTreeDescription",
    "",
  );
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useWorkspaceField<string | null>(
    "editingTreeId",
    null,
  );
  const [editTitle, setEditTitle] = useWorkspaceField("editTreeTitle", "");
  const [editDescription, setEditDescription] = useWorkspaceField(
    "editTreeDescription",
    "",
  );

  useEffect(() => {
    let active = true;
    void client
      .listTrees()
      .then((items) => {
        if (active) setTrees(items);
      })
      .catch(() => {
        // Keep current list on transient fetch errors
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const handleCreateTree = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const description = newDescription.trim();
      const created = await client.createTree({
        title,
        ...(description ? { description } : {}),
      });
      setNewTitle("");
      setNewDescription("");
      toast.success(`Created "${created.title}"`);
      router.push(`/trees/${encodeURIComponent(created.id)}`);
    } catch (error) {
      toast.error((error as Error).message || "Could not create tree.");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (tree: TreeSummary) => {
    setEditingId(tree.id);
    setEditTitle(tree.title);
    setEditDescription(tree.description);
  };

  const handleSaveEdit = async (treeId: string) => {
    const title = editTitle.trim();
    if (!title) return;
    try {
      const updated = await client.updateTreeMeta(treeId, {
        title,
        description: editDescription.trim(),
      });
      setTrees((prev) =>
        prev.map((item) =>
          item.id === treeId
            ? {
                ...item,
                title: updated.title,
                description: updated.description,
                revision: updated.revision,
                updatedAt: updated.updatedAt,
              }
            : item,
        ),
      );
      setEditingId(null);
      toast.success("Tree updated");
    } catch (error) {
      toast.error((error as Error).message || "Could not save changes.");
    }
  };

  const handleDeleteTree = async (tree: TreeSummary) => {
    try {
      await client.deleteTree(tree.id);
      setTrees((prev) => prev.filter((item) => item.id !== tree.id));
      if (editingId === tree.id) setEditingId(null);
      toast.success(`Deleted "${tree.title}"`);
    } catch (error) {
      toast.error((error as Error).message || "Could not delete tree.");
    }
  };

  return (
    <WorkbenchPanel
      workspacePage
      title="Trees"
      icon={<FolderTree size={13} strokeWidth={2} />}
      viewGrid
      gridVariant="wide"
    >
      <div className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4">
        <div className="t-label">New tree</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="Tree title"
            aria-label="Tree title"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreateTree();
              }
            }}
          />
          <Input
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            placeholder="Optional description"
            aria-label="Optional description"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreateTree();
              }
            }}
          />
          <Button
            type="button"
            disabled={creating || newTitle.trim().length === 0}
            onClick={() => void handleCreateTree()}
          >
            <Plus size={14} strokeWidth={2} />
            Create tree
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 content-start gap-4">
        {loaded && trees.length === 0 ? (
          <p className="t-lead py-6">
            No trees yet. Create one above or import a directory with{" "}
            <code className="font-mono text-xs">
              mdmedia studio tree create --from-dir
            </code>
            .
          </p>
        ) : (
          trees.map((tree) => {
            const isEditing = editingId === tree.id;

            return (
              <section
                key={tree.id}
                className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 transition-colors sm:p-5"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3.5">
                    <Link
                      href={`/trees/${encodeURIComponent(tree.id)}`}
                      aria-label={`Open ${tree.title}`}
                      className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <FolderTree size={16} strokeWidth={2.1} />
                    </Link>

                    <div className="grid min-w-0 gap-1">
                      {isEditing ? (
                        <div className="grid max-w-xl gap-2">
                          <Input
                            value={editTitle}
                            onChange={(event) =>
                              setEditTitle(event.target.value)
                            }
                            placeholder="Tree title"
                            aria-label="Edit tree title"
                          />
                          <Input
                            value={editDescription}
                            onChange={(event) =>
                              setEditDescription(event.target.value)
                            }
                            placeholder="Description"
                            aria-label="Edit tree description"
                          />
                          <div className="grid grid-cols-[auto_auto] justify-start gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={editTitle.trim().length === 0}
                              onClick={() => void handleSaveEdit(tree.id)}
                            >
                              <Check size={13} strokeWidth={2} />
                              Save
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5">
                            <h2 className="t-card-title min-w-0 [overflow-wrap:anywhere]">
                              <Link
                                href={`/trees/${encodeURIComponent(tree.id)}`}
                                className="hover:text-primary"
                              >
                                {tree.title}
                              </Link>
                            </h2>
                            <span className="t-mono tabular-nums text-ink-faint">
                              {tree.docCount}{" "}
                              {tree.docCount === 1 ? "document" : "documents"}
                              {" · "}
                              {tree.nodeCount}{" "}
                              {tree.nodeCount === 1 ? "node" : "nodes"}
                              {tree.selectedCount > 0
                                ? ` · ${tree.selectedCount} selected`
                                : ""}
                            </span>
                          </div>
                          {tree.description ? (
                            <p className="t-card-desc [overflow-wrap:anywhere]">
                              {tree.description}
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>

                  {!isEditing ? (
                    <div className="grid grid-flow-col items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() =>
                          router.push(
                            `/trees/${encodeURIComponent(tree.id)}?new=1`,
                          )
                        }
                        aria-label={`Add document to ${tree.title}`}
                        title="Add document"
                        className="size-9 sm:size-6"
                      >
                        <FilePlus size={13} strokeWidth={2} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => startEdit(tree)}
                        aria-label={`Edit ${tree.title}`}
                        title="Edit tree"
                        className="size-9 sm:size-6"
                      >
                        <Pencil size={13} strokeWidth={2} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void handleDeleteTree(tree)}
                        aria-label={`Delete ${tree.title}`}
                        title="Delete tree"
                        className="size-9 sm:size-6"
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })
        )}
      </div>
    </WorkbenchPanel>
  );
}
