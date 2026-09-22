"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Code2, Download, FileCheck, FileText, Info, ListMusic, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useAuth } from "@/lib/auth-context";
import { deleteNarration, updateVisibility } from "@/lib/narrations";
import { useOfflineStatus, type OfflineNarrationMetadata } from "@/lib/offline-manager";
import {
  createPlaylist,
  toggleNarrationInPlaylist,
  watchMyPlaylists,
} from "@/lib/playlists";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  MAX_SHARED_WITH,
  type HighlightColorId,
  type Narration,
  type Playlist,
  type Visibility,
} from "@/lib/types";

const OPTIONS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "private", label: "Only me" },
  { value: "shared", label: "People I choose" },
  { value: "public", label: "Anyone with the link" },
];

/** Sharing, playlists, highlight color, and details for one narration. */
export function NarrationSettings({
  narration,
  narrationId,
  canEdit,
  actions,
}: {
  narration: Narration | null;
  narrationId?: string;
  canEdit: boolean;
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { stream, highlightColor, setHighlightColor, documentView, setDocumentView } =
    useNarration();
  const [pending, startTransition] = useTransition();
  const [invitee, setInvitee] = useState("");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!user) {
      setPlaylists([]);
      return;
    }
    const unsubP = watchMyPlaylists(user.uid, setPlaylists);
    return () => {
      unsubP();
    };
  }, [user]);

  const effectiveId = narration?.id ?? narrationId ?? stream.id;
  const effectiveVoice = narration?.voice ?? stream.voice;
  const effectiveTitle = narration?.title ?? stream.title;
  const effectiveSourceMarkdown = narration?.sourceMarkdown ?? stream.sourceMarkdown ?? undefined;
  const effectiveAdapted = narration?.adapted ?? stream.adapted;
  const isReady =
    narration?.status === "ready" ||
    (stream.id === effectiveId && stream.status === "ready");

  const offlineMetadata = useMemo<OfflineNarrationMetadata>(
    () => ({
      title: effectiveTitle,
      sourceMarkdown: effectiveSourceMarkdown,
      adapted: effectiveAdapted,
    }),
    [effectiveTitle, effectiveSourceMarkdown, effectiveAdapted],
  );

  const { isDownloaded, isDownloading, download, remove } = useOfflineStatus(
    effectiveId,
    offlineMetadata,
  );

  const commit = (visibility: Visibility, sharedWith: string[]) => {
    if (!narration) return;
    startTransition(async () => {
      try {
        await updateVisibility(narration.id, visibility, sharedWith);
      } catch {
        toast.error("That change did not save. Try again.");
      }
    });
  };

  const addInvitee = () => {
    if (!narration) return;
    const value = invitee.trim().toLowerCase();
    if (value.length === 0) return;
    if (narration.sharedWith.includes(value)) {
      setInvitee("");
      return;
    }
    if (narration.sharedWith.length >= MAX_SHARED_WITH) {
      toast.error(`You can share with up to ${MAX_SHARED_WITH} people.`);
      return;
    }
    commit("shared", [...narration.sharedWith, value]);
    setInvitee("");
  };

  const handleTogglePlaylist = (playlist: Playlist) => {
    if (!effectiveId) return;
    startTransition(async () => {
      try {
        const added = await toggleNarrationInPlaylist(playlist, effectiveId);
        toast.success(added ? `Added to "${playlist.title}"` : `Removed from "${playlist.title}"`);
      } catch {
        toast.error("Could not update playlist.");
      }
    });
  };

  const handleCreatePlaylist = () => {
    if (!user || !effectiveId) return;
    const title = newPlaylistTitle.trim();
    if (title.length === 0) return;
    startTransition(async () => {
      try {
        await createPlaylist(user.uid, title, "", [effectiveId]);
        setNewPlaylistTitle("");
        toast.success(`Created "${title}" and added narration`);
      } catch {
        toast.error("Could not create playlist.");
      }
    });
  };

  const handleDeleteNarration = async () => {
    const idToDelete = narration?.id ?? narrationId ?? stream.id;
    if (!idToDelete) return;
    setIsDeleting(true);
    try {
      if (stream.id === idToDelete) {
        stream.cancel();
      }
      await deleteNarration(idToDelete);
      toast.success("Narration deleted.");
      setDeleteDialogOpen(false);
      router.push("/library");
    } catch {
      toast.error("Could not delete narration.");
      setIsDeleting(false);
    }
  };

  const isAdapted = (narration?.adapted ?? stream.adapted) === true;

  return (
    <WorkbenchPanel
      title="Details"
      icon={<Info size={13} strokeWidth={2} />}
      actions={
        <>
          {pending ? <Loader2 size={13} className="animate-spin text-ink-muted" /> : null}
          {actions}
        </>
      }
      bodyClassName="gap-6 p-4"
    >
      {isAdapted ? (
        <div className="grid gap-2">
          <Label className="t-label">Document view</Label>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/50 p-1">
            <button
              type="button"
              aria-pressed={documentView === "adapted"}
              onClick={() => setDocumentView("adapted")}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[0.78rem] font-medium transition-all",
                documentView === "adapted"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-ink-muted hover:text-foreground",
              )}
            >
              <Sparkles
                size={13}
                strokeWidth={2}
                className={cn(
                  "flex-none",
                  documentView === "adapted" ? "text-primary" : "text-ink-faint",
                )}
              />
              <span className="truncate">Adapted</span>
            </button>
            <button
              type="button"
              aria-pressed={documentView === "source"}
              onClick={() => setDocumentView("source")}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[0.78rem] font-medium transition-all",
                documentView === "source"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-ink-muted hover:text-foreground",
              )}
            >
              <FileText
                size={13}
                strokeWidth={2}
                className={cn(
                  "flex-none",
                  documentView === "source" ? "text-primary" : "text-ink-faint",
                )}
              />
              <span className="truncate">Source</span>
            </button>
            <button
              type="button"
              aria-pressed={documentView === "raw"}
              onClick={() => setDocumentView("raw")}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[0.78rem] font-medium transition-all",
                documentView === "raw"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-ink-muted hover:text-foreground",
              )}
            >
              <Code2
                size={13}
                strokeWidth={2}
                className={cn(
                  "flex-none",
                  documentView === "raw" ? "text-primary" : "text-ink-faint",
                )}
              />
              <span className="truncate">Raw</span>
            </button>
          </div>
        </div>
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
                <span className="truncate font-medium">{preset.label.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {user && effectiveId ? (
        <div className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="t-label">Playlists</Label>
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
              {playlists.filter((p) => p.narrationIds.includes(effectiveId)).length} selected
            </span>
          </div>

          {playlists.length > 0 ? (
            <ul className="grid max-h-44 gap-1 overflow-y-auto rounded-md border border-border bg-card p-1">
              {playlists.map((playlist) => {
                const included = playlist.narrationIds.includes(effectiveId);
                return (
                  <li key={playlist.id}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => handleTogglePlaylist(playlist)}
                      aria-pressed={included}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[0.8rem] transition-colors",
                        included
                          ? "bg-accent font-medium text-foreground"
                          : "text-ink-muted hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex size-4 flex-none items-center justify-center rounded-[3px] border transition-colors",
                            included
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong bg-background",
                          )}
                        >
                          {included ? <Check size={11} strokeWidth={2.5} /> : null}
                        </span>
                        <span className="truncate">{playlist.title}</span>
                      </span>
                      <span className="flex-none font-mono text-[11px] tabular-nums text-ink-faint">
                        {playlist.narrationIds.length}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-[0.78rem] text-ink-muted">
              No playlists yet. Create one below to add this narration.
            </p>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Input
              value={newPlaylistTitle}
              placeholder="New playlist…"
              className="h-8 min-w-0 text-[0.8rem]"
              onChange={(event) => setNewPlaylistTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreatePlaylist();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              disabled={pending || newPlaylistTitle.trim().length === 0}
              onClick={handleCreatePlaylist}
              aria-label="Create playlist with this narration"
            >
              <Plus size={15} strokeWidth={2} />
            </Button>
          </div>
        </div>
      ) : null}

      {effectiveId ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="t-label">Offline storage</Label>
            {isDownloaded ? (
              <span
                title="Downloaded to device"
                aria-label="Downloaded to device"
                className="inline-flex items-center text-mint"
              >
                <FileCheck size={14} strokeWidth={2} />
              </span>
            ) : isDownloading ? (
              <span
                title="Downloading audio…"
                aria-label="Downloading audio…"
                className="inline-flex items-center text-primary"
              >
                <Loader2 size={13} className="animate-spin" />
              </span>
            ) : null}
          </div>
          <p className="text-[0.78rem] text-ink-muted leading-normal">
            {isDownloaded
              ? "Audio and timings are saved to this device for offline playback."
              : isDownloading
              ? "Fetching audio and word timings to save on this device."
              : isReady
              ? "Download this narration to listen without an internet connection."
              : "Download will become available once narration generation completes."}
          </p>
          {isDownloaded ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await remove();
                  toast.info("Removed from offline storage");
                } catch {
                  toast.error("Could not remove narration from offline storage.");
                }
              }}
              className="h-8 w-full justify-center gap-2 text-[0.8rem] text-destructive hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 size={13} strokeWidth={2} />
              <span>Remove download</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isDownloading || !isReady}
              onClick={async () => {
                try {
                  await download();
                  toast.success(
                    effectiveTitle
                      ? `Downloaded "${effectiveTitle}" for offline listening`
                      : "Downloaded for offline listening",
                  );
                } catch {
                  toast.error("Could not download narration for offline listening.");
                }
              }}
              className="h-8 w-full justify-center gap-2 text-[0.8rem]"
            >
              {isDownloading ? (
                <>
                  <Loader2 size={13} className="animate-spin text-primary" />
                  <span>Downloading audio…</span>
                </>
              ) : (
                <>
                  <Download size={13} strokeWidth={2} />
                  <span>Download for offline</span>
                </>
              )}
            </Button>
          )}
        </div>
      ) : null}

      {narration !== null ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="who" className="t-label">
              Who can listen
            </Label>
            <Select
              value={narration.visibility}
              disabled={!canEdit || pending}
              onValueChange={(value) => commit(value as Visibility, narration.sharedWith)}
            >
              <SelectTrigger id="who" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {narration.visibility === "shared" && canEdit ? (
            <div className="grid gap-3">
              <Label htmlFor="invite" className="t-label">
                People
              </Label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input
                  id="invite"
                  value={invitee}
                  placeholder="Email address"
                  onChange={(event) => setInvitee(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addInvitee();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={addInvitee}
                  aria-label="Add person"
                >
                  <Plus size={15} strokeWidth={2} />
                </Button>
              </div>

              <ul className="grid max-h-48 gap-1 overflow-y-auto">
                {narration.sharedWith.map((person) => (
                  <li
                    key={person}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <span className="truncate text-[0.8rem]">{person}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${person}`}
                      onClick={() =>
                        commit(
                          "shared",
                          narration.sharedWith.filter((entry) => entry !== person),
                        )
                      }
                      className="text-ink-faint transition-colors hover:text-foreground"
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="details-meta-container">
            <dl className={narration.authorName ? "details-meta-grid" : "grid gap-3"}>
              <div className="grid min-w-0 gap-0.5">
                <dt className="t-label">Voice</dt>
                <dd className="truncate text-[0.85rem]" title={narration.voice}>
                  {narration.voice}
                </dd>
              </div>
              {narration.authorName ? (
                <div className="grid min-w-0 gap-0.5">
                  <dt className="t-label">Made by</dt>
                  <dd className="truncate text-[0.85rem]" title={narration.authorName}>
                    {narration.authorName}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          {narration.visibility === "public" ? (
            <p className="item-label-lockup t-meta">
              <Check size={14} strokeWidth={2} className="text-foreground" />
              <span>Anyone with the link can listen.</span>
            </p>
          ) : null}
        </>
      ) : (
        <>
          {effectiveVoice ? (
            <dl className="grid gap-3">
              <div className="grid gap-0.5">
                <dt className="t-label">Voice</dt>
                <dd className="text-[0.85rem]">{effectiveVoice}</dd>
              </div>
            </dl>
          ) : null}
          <p className="t-meta">Sharing options appear once the narration finishes saving.</p>
        </>
      )}

      {canEdit && effectiveId ? (
        <div className="pt-2 border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
            className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
          >
            <Trash2 size={13} strokeWidth={2} />
            <span>Delete narration</span>
          </Button>
        </div>
      ) : null}

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteDialogOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete narration?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{narration?.title || stream.title || "this narration"}&rdquo;? This will permanently remove its audio and transcript, and remove it from any playlists. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2.5">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteNarration}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} strokeWidth={2} />
              )}
              <span>Delete</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkbenchPanel>
  );
}
