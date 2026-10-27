"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "cn";
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  deriveExportSlug,
  downloadDocumentDocx,
  downloadHermeticDocumentZip,
} from "@/lib/hermetic-export-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ComposerSettings } from "@/components/studio/composer-settings";
import { PresetField } from "@/components/studio/preset-field";
import { VoicePicker } from "@/components/studio/voice-picker";
import { NarrationSettings } from "@/components/narration/narration-settings";
import { useNarration } from "@/components/shell/narration-provider";
import { InspectorSlot } from "@/components/shell/inspector-slot";
import { storyboardRoute } from "@/lib/storyboard";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import type { HeaderActions } from "@/components/shell/header-action";
import { KeepSection } from "@/components/shell/keep-section";
import { useTreeContext } from "@/components/tree/tree-provider";
import type { MediaType } from "@/lib/media-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { watchNarration } from "@/lib/narrations";
import { useAuth } from "@/lib/auth-context";
import { addPreset } from "@/lib/presets";
import {
  DEFAULT_SETTINGS,
  DELIVERY_PRESETS,
  HIGHLIGHT_COLORS,
  type HighlightColorId,
  type Narration,
} from "@/lib/types";

function NarrationContextPanel({
  id,
  actions,
}: {
  id: string;
  actions?: HeaderActions;
}) {
  const { user } = useAuth();
  const [narration, setNarration] = useState<Narration | null>(null);

  useEffect(() => {
    return watchNarration(id, setNarration);
  }, [id]);

  return (
    <NarrationSettings
      narration={narration}
      narrationId={id}
      canEdit={narration !== null && user !== null && narration.ownerUid === user.uid}
      actions={actions}
    />
  );
}

const MEDIA_ROUTE = /^\/(image|video|music)\/([^/?#]+)/;

/** Pages without their own inspector still get Keep: pinning, and retention for media. */
function WorkPanel({ pathname, actions }: { pathname: string; actions?: HeaderActions }) {
  const match = MEDIA_ROUTE.exec(pathname);
  const media = match ? { type: match[1] as MediaType, id: decodeURIComponent(match[2]!) } : undefined;
  return (
    <WorkbenchPanel title="Details" icon={<Info size={13} strokeWidth={2} />} actions={actions} bodyClassName="gap-6 p-4">
      <KeepSection media={media} />
    </WorkbenchPanel>
  );
}

function TreeContextPanel({ actions }: { actions?: HeaderActions }) {
  const router = useRouter();
  const {
    tree,
    activeNode,
    activeDocument,
    applyPresetSelection,
    saveSelectionPreset,
    deleteSelectionPreset,
    applyOps,
  } = useTreeContext();
  const { highlightColor, setHighlightColor, draft, setDraft } = useNarration();
  const { profile, updateSettings } = useAuth();
  const settings = profile?.settings ?? DEFAULT_SETTINGS;
  const deliveryPresets = [...DELIVERY_PRESETS, ...settings.deliveryPresets];
  const [presetTitle, setPresetTitle] = useState("");
  const [deleteDocDialogOpen, setDeleteDocDialogOpen] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);

  const presets = tree ? Object.values(tree.selectionSets) : [];
  const narrationId =
    activeDocument?.narrationId ?? activeNode?.narrationId ?? null;
  const exportSlug = activeDocument
    ? deriveExportSlug({
        docPath: activeDocument.path || activeNode?.path,
        title: activeDocument.title || activeNode?.name,
      })
    : null;

  const handleExportHermeticZip = async () => {
    if (!activeDocument || exportingZip) return;
    setExportingZip(true);
    try {
      const pkg = await downloadHermeticDocumentZip({
        title: activeDocument.title || activeNode?.name || "document",
        markdown: activeDocument.markdown,
        docPath: activeDocument.path || activeNode?.path,
        pathAssets: tree?.pathAssets,
      });
      const count = pkg.mediaAssets.length;
      toast.success(
        count > 0
          ? `Downloaded "${pkg.zipFilename}" (${count} ${count === 1 ? "image/media file" : "image/media files"})`
          : `Downloaded "${pkg.zipFilename}"`,
      );
    } catch (error) {
      toast.error(
        (error as Error).message || "Could not export .zip archive.",
      );
    } finally {
      setExportingZip(false);
    }
  };

  const handleExportDocx = async () => {
    if (!activeDocument || exportingDocx) return;
    setExportingDocx(true);
    try {
      const pkg = await downloadDocumentDocx({
        title: activeDocument.title || activeNode?.name || "document",
        markdown: activeDocument.markdown,
        docPath: activeDocument.path || activeNode?.path,
        pathAssets: tree?.pathAssets,
      });
      const count = pkg.mediaAssets.length;
      toast.success(
        count > 0
          ? `Downloaded "${pkg.docxFilename}" (${count} embedded ${count === 1 ? "image" : "images"})`
          : `Downloaded "${pkg.docxFilename}"`,
      );
    } catch (error) {
      toast.error(
        (error as Error).message || "Could not export .docx document.",
      );
    } finally {
      setExportingDocx(false);
    }
  };

  const handleSavePreset = async () => {
    const title = presetTitle.trim();
    if (!title) return;
    try {
      await saveSelectionPreset(title);
      setPresetTitle("");
      toast.success(`Saved selection preset "${title}"`);
    } catch (error) {
      toast.error(
        (error as Error).message || "Could not save selection preset.",
      );
    }
  };

  const handleDeleteActiveDocument = async () => {
    if (!tree || !activeNode) return;
    setDeleteDocDialogOpen(false);
    try {
      await applyOps([
        { op: "remove", targets: [activeNode.id], recursive: true },
      ]);
      toast.success(`Deleted "${activeNode.name}"`);
      router.push(`/trees/${encodeURIComponent(tree.id)}`);
    } catch (error) {
      toast.error((error as Error).message || "Could not delete document.");
    }
  };

  return (
    <WorkbenchPanel
      title="Details"
      icon={<Info size={13} strokeWidth={2} />}
      actions={actions}
      bodyClassName="gap-6 p-4"
    >
      <KeepSection />

      <div className="grid gap-2">
        <Label htmlFor="tree-voice" className="t-label">
          Reader
        </Label>
        <VoicePicker
          id="tree-voice"
          value={draft.voice}
          onChange={(voice) => setDraft({ voice })}
        />
      </div>

      {draft.voice.provider === "gemini" ? (
        <PresetField
          id="tree-style"
          label="Delivery"
          presets={deliveryPresets}
          text={draft.promptStyle}
          choice={draft.deliveryPreset}
          onChange={({ text, choice }) =>
            setDraft({ promptStyle: text, deliveryPreset: choice })
          }
          onSave={(preset) =>
            void updateSettings({
              deliveryPresets: addPreset(settings.deliveryPresets, preset),
            })
          }
          placeholder="Warm, unhurried narration."
        />
      ) : null}

      <div className="grid gap-2">
        <Label className="t-label">Highlight color</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {HIGHLIGHT_COLORS.map((preset) => {
            const selected = highlightColor === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setHighlightColor(preset.id as HighlightColorId)}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[0.75rem] transition-all",
                  selected
                    ? "border-foreground bg-accent font-medium text-foreground"
                    : "border-border bg-card text-ink-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                <span
                  style={{ backgroundColor: preset.bg, color: preset.text }}
                  className="inline-flex h-4 w-5 flex-none items-center justify-center rounded-[3px] font-mono text-[10px] font-semibold"
                >
                  Aa
                </span>
                <span className="truncate font-medium">
                  {preset.label.split(" ")[0]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {tree && (tree.selectedNodeIds.length > 0 || presets.length > 0) ? (
        <div className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="t-label">Selection presets</Label>
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
              {tree.selectedNodeIds.length} selected
            </span>
          </div>

          {presets.length > 0 ? (
            <ul className="grid max-h-44 gap-1 overflow-y-auto rounded-md border border-border bg-card p-1">
              {presets.map((preset) => {
                const isExactMatch =
                  preset.nodeIds.length === tree.selectedNodeIds.length &&
                  preset.nodeIds.every((id) =>
                    tree.selectedNodeIds.includes(id),
                  );
                return (
                  <li
                    key={preset.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1"
                  >
                    <button
                      type="button"
                      onClick={() => void applyPresetSelection(preset.id)}
                      aria-pressed={isExactMatch}
                      className={cn(
                        "flex min-w-0 items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[0.8rem] transition-colors",
                        isExactMatch
                          ? "bg-accent font-medium text-foreground"
                          : "text-ink-muted hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex size-4 flex-none items-center justify-center rounded-[3px] border transition-colors",
                            isExactMatch
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong bg-background",
                          )}
                        >
                          {isExactMatch ? (
                            <Check size={11} strokeWidth={2.5} />
                          ) : null}
                        </span>
                        <span className="block min-w-0 truncate">
                          {preset.title}
                        </span>
                      </span>
                      <span className="flex-none font-mono text-[11px] tabular-nums text-ink-faint">
                        {preset.nodeIds.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete preset ${preset.title}`}
                      onClick={() => void deleteSelectionPreset(preset.id)}
                      className="grid size-6 place-items-center rounded-xs text-ink-faint transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Trash2 size={12} strokeWidth={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-[0.78rem] text-ink-muted">
              Check files in the tree explorer to save a reusable selection
              preset.
            </p>
          )}

          {tree.selectedNodeIds.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                value={presetTitle}
                placeholder="New preset…"
                aria-label="Preset name"
                className="h-8 min-w-0 text-[0.8rem]"
                onChange={(event) => setPresetTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSavePreset();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                disabled={presetTitle.trim().length === 0}
                onClick={() => void handleSavePreset()}
                aria-label="Save selection preset"
              >
                <Plus size={15} strokeWidth={2} />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {tree ? (
        <div className="details-meta-container">
          <dl className="grid gap-3">
            {activeNode ? (
              <div className="grid min-w-0 gap-0.5">
                <dt className="t-label">Path</dt>
                <dd
                  className="truncate font-mono text-[0.8rem] text-foreground"
                  title={activeNode.path}
                >
                  {activeNode.path}
                </dd>
              </div>
            ) : null}
            <div className="grid min-w-0 gap-0.5">
              <dt className="t-label">Tree</dt>
              <dd className="truncate text-[0.85rem]" title={tree.title}>
                {tree.title}{" "}
                <span className="text-ink-muted">
                  · {tree.docCount}{" "}
                  {tree.docCount === 1 ? "document" : "documents"}
                </span>
              </dd>
            </div>
            {narrationId ? (
              <div className="grid min-w-0 gap-0.5">
                <dt className="t-label">Narration</dt>
                <dd className="text-[0.82rem]">
                  <Link
                    href={`/narration/${encodeURIComponent(narrationId)}`}
                    className="inline-flex items-center gap-1.5 text-primary hover:underline"
                  >
                    <span>Open in Library</span>
                    <ExternalLink size={12} strokeWidth={2} />
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {activeDocument && exportSlug ? (
        <div className="grid gap-2">
          <Label className="t-label">Export</Label>
          <p className="text-[0.78rem] leading-normal text-ink-muted">
            Export with embedded images as a{" "}
            <code className="font-mono text-[11px]">.docx</code> for Google Docs
            or a <code className="font-mono text-[11px]">.zip</code> of Markdown
            and image files.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exportingDocx}
            onClick={() => void handleExportDocx()}
            title={`Download ${exportSlug}.docx`}
            className="h-8 w-full min-w-0 justify-center gap-2 text-[0.8rem]"
          >
            {exportingDocx ? (
              <>
                <Loader2 size={13} className="flex-none animate-spin text-primary" />
                <span className="truncate">Packaging {exportSlug}.docx…</span>
              </>
            ) : (
              <>
                <FileText size={13} strokeWidth={2} className="flex-none" />
                <span className="truncate">Download {exportSlug}.docx</span>
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exportingZip}
            onClick={() => void handleExportHermeticZip()}
            title={`Download ${exportSlug}.zip`}
            className="h-8 w-full min-w-0 justify-center gap-2 text-[0.8rem]"
          >
            {exportingZip ? (
              <>
                <Loader2 size={13} className="flex-none animate-spin text-primary" />
                <span className="truncate">Packaging {exportSlug}.zip…</span>
              </>
            ) : (
              <>
                <Download size={13} strokeWidth={2} className="flex-none" />
                <span className="truncate">Download {exportSlug}.zip</span>
              </>
            )}
          </Button>
        </div>
      ) : null}

      {tree && activeNode ? (
        <div className="grid gap-2 border-t border-border py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDeleteDocDialogOpen(true)}
            className="w-full justify-center text-destructive hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 size={13} strokeWidth={2} />
            <span>Delete document</span>
          </Button>
        </div>
      ) : null}

      <Dialog open={deleteDocDialogOpen} onOpenChange={setDeleteDocDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;
              {activeDocument?.title || activeNode?.name || "this document"}
              &rdquo; ({activeNode?.path}) from {tree?.title}? Generated
              narrations in your Library will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2.5">
            <Button
              variant="outline"
              onClick={() => setDeleteDocDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteActiveDocument()}
            >
              <Trash2 size={13} strokeWidth={2} />
              <span>Delete document</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkbenchPanel>
  );
}

/**
 * The right column.
 *
 * Mirrors the left rail's docking behavior: when docked, it collapses to a
 * 56px icon rail with an expand toggle in the 44px header and the section icon
 * below; when expanded, it renders the full inspector with a collapse toggle
 * in the header.
 */
export function ContextPanel({
  docked = false,
  onToggleDock,
}: {
  docked?: boolean;
  onToggleDock?: () => void;
}) {
  const pathname = usePathname();
  const isStudio = pathname.startsWith("/studio");
  const isNarration = pathname.startsWith("/narration/");
  const isTree = pathname.startsWith("/trees/");
  const isStoryboard = storyboardRoute(pathname) !== null;
  const sectionLabel = isStoryboard ? "Story details" : isStudio ? "Voice" : isTree ? "Details" : "Sharing";
  const SectionIcon = isStudio ? SlidersHorizontal : Info;

  if (docked) {
    return (
      <aside
        aria-label="Inspector"
        data-docked="true"
        className="grid h-full min-h-0 grid-rows-[auto_1fr] bg-sidebar"
      >
        <div className="flex h-11 items-center justify-center border-b border-sidebar-border px-2">
          <Tooltip>
            <TooltipTrigger
              onClick={onToggleDock}
              aria-label="Expand panel"
              aria-expanded={false}
              className="inline-flex size-8 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <PanelRightOpen size={16} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent side="left">Expand {sectionLabel.toLowerCase()}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-col items-center gap-1 px-2 py-2">
          <Tooltip>
            <TooltipTrigger
              onClick={onToggleDock}
              aria-label={sectionLabel}
              className="flex h-[30px] w-full items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground transition-colors hover:opacity-90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <SectionIcon size={16} strokeWidth={2} className="flex-none" />
            </TooltipTrigger>
            <TooltipContent side="left">{sectionLabel}</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    );
  }

  const collapseAction: HeaderActions | undefined =
    onToggleDock === undefined
      ? undefined
      : [{ icon: PanelRightClose, label: `Collapse ${sectionLabel.toLowerCase()}`, onClick: onToggleDock, expanded: true }];

  if (isStoryboard) return <WorkbenchPanel title="Story details" icon={<Info size={13} />} actions={collapseAction} bodyClassName="p-4"><InspectorSlot /></WorkbenchPanel>;

  if (isStudio) return <ComposerSettings actions={collapseAction} />;

  if (isNarration) {
    const id = pathname.split("/")[2];
    if (id !== undefined && id.length > 0) {
      return <NarrationContextPanel key={id} id={id} actions={collapseAction} />;
    }
  }

  if (isTree) {
    return <TreeContextPanel actions={collapseAction} />;
  }

  return <WorkPanel pathname={pathname} actions={collapseAction} />;
}
