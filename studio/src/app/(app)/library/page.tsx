"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Download,
  FileCheck,
  Library,
  Loader2,
  Play,
  Search,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
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
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { useAuth } from "@/lib/auth-context";
import { deleteNarration, watchMyNarrations } from "@/lib/narrations";
import { useOfflineStatus, type OfflineNarrationMetadata } from "@/lib/offline-manager";
import type { Narration } from "@/lib/types";

const READABLE_VISIBILITY: Record<Narration["visibility"], string> = {
  private: "Only you",
  shared: "Shared",
  public: "Public",
};

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function relativeTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function LibraryNarrationCard({
  narration,
  isCurrentTrack,
  isPlaying,
  onDelete,
}: {
  narration: Narration;
  isCurrentTrack: boolean;
  isPlaying: boolean;
  onDelete: (narration: Narration) => void;
}) {
  const router = useRouter();
  const isReady = narration.status === "ready";
  const offlineMetadata = useMemo<OfflineNarrationMetadata>(
    () => ({
      title: narration.title,
      sourceMarkdown: narration.sourceMarkdown,
      adapted: narration.adapted,
    }),
    [narration.title, narration.sourceMarkdown, narration.adapted],
  );
  const { isDownloaded, isDownloading, download, remove } = useOfflineStatus(
    narration.id,
    offlineMetadata,
  );

  const cleanExcerpt = useMemo(() => {
    return narration.transcript
      .replace(/^#+\s*/gm, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
  }, [narration.transcript]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/narration/${narration.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/narration/${narration.id}`);
        }
      }}
      className={cn(
        "group item-track-grid rounded-lg border p-3.5 transition-all cursor-pointer",
        isCurrentTrack
          ? "border-primary/40 bg-card shadow-2xs"
          : "border-border/80 bg-card/60 hover:border-border hover:bg-card",
      )}
    >
      {/* Track: Status indicator */}
      <div className="track-status">
        {isCurrentTrack && isPlaying ? (
          <Volume2 size={14} className="flex-none text-primary animate-pulse" />
        ) : narration.status === "streaming" ? (
          <Loader2 size={14} className="flex-none animate-spin text-primary" />
        ) : (
          <CheckCircle2 size={14} className="flex-none text-primary" />
        )}
      </div>

      {/* Track: Title text */}
      <div className="track-title">
        <span className="block truncate text-[0.92rem] font-medium text-foreground group-hover:text-primary transition-colors">
          {narration.title}
        </span>
      </div>

      {/* Track: Action controls */}
      <div className="track-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/narration/${narration.id}`);
          }}
          className="h-7 gap-1.5 px-2.5 text-xs font-medium"
        >
          <Play size={11} strokeWidth={2.5} className="fill-current" />
          <span>Open</span>
        </Button>
        {isDownloading ? (
          <span
            className="inline-flex size-7 items-center justify-center text-primary"
            title="Downloading for offline listening…"
          >
            <Loader2 size={13} className="animate-spin" />
          </span>
        ) : isDownloaded ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await remove();
                toast.info("Removed from offline storage");
              } catch {
                toast.error("Could not remove narration from offline storage.");
              }
            }}
            className="h-7 px-2 text-xs text-mint hover:bg-muted hover:text-foreground"
            title="Downloaded to device (click to remove)"
            aria-label="Remove download"
          >
            <FileCheck size={13} strokeWidth={2} />
            <span className="sr-only">Downloaded</span>
          </Button>
        ) : isReady ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await download();
                toast.success(
                  narration.title
                    ? `Downloaded "${narration.title}" for offline listening`
                    : "Downloaded for offline listening",
                );
              } catch {
                toast.error("Could not download narration for offline listening.");
              }
            }}
            className="h-7 px-2 text-xs text-ink-muted hover:bg-muted hover:text-foreground"
            title="Download for offline listening"
            aria-label="Download for offline"
          >
            <Download size={13} strokeWidth={2} />
            <span className="sr-only">Download for offline</span>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(narration);
          }}
          className="h-7 px-2 text-xs text-ink-muted hover:bg-destructive/10 hover:text-destructive"
          title={`Delete ${narration.title}`}
          aria-label={`Delete ${narration.title}`}
        >
          <Trash2 size={13} strokeWidth={2} />
          <span className="sr-only">Delete</span>
        </Button>
      </div>

      {/* Track: Excerpt text */}
      {cleanExcerpt ? (
        <div className="track-body">
          <p className="line-clamp-1 text-[0.8rem] text-ink-muted/80">
            {cleanExcerpt}
          </p>
        </div>
      ) : null}

      {/* Track: Metadata tags */}
      <div className="track-body">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.75rem] text-ink-muted">
          <span className="font-medium text-foreground">{narration.voice}</span>
          <span className="font-mono tabular-nums">{duration(narration.durationMs)}</span>
          <span>Ready {relativeTime(narration.createdAt || narration.updatedAt)}</span>
          <span>{READABLE_VISIBILITY[narration.visibility]}</span>
          {narration.adapted ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <Sparkles size={11} /> Adapted for ear
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage() {
  const { user } = useAuth();
  const { stream } = useNarration();
  const [items, setItems] = useState<Narration[]>([]);
  const [query, setQuery] = useState("");
  const [itemToDelete, setItemToDelete] = useState<Narration | null>(null);

  useEffect(() => {
    if (user === null) return;
    return watchMyNarrations(user.uid, setItems);
  }, [user]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.transcript.toLowerCase().includes(needle),
    );
  }, [items, query]);

  const totalParagraphs = useMemo(() => {
    return filtered.reduce((sum, item) => {
      const text = item.sourceMarkdown || item.transcript || "";
      const count = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
      return sum + (count || (text.trim().length > 0 ? 1 : 0));
    }, 0);
  }, [filtered]);

  const handleConfirmDelete = () => {
    if (!itemToDelete) return;
    const narrationId = itemToDelete.id;
    if (stream.id === narrationId) {
      stream.cancel();
    }
    setItemToDelete(null);
    toast.success("Narration deleted.");
    void deleteNarration(narrationId).catch((err) => {
      console.error("Failed to delete narration:", err);
      toast.error("Could not delete narration.");
    });
  };

  return (
    <WorkbenchPanel
      title="Library"
      icon={<Library size={13} strokeWidth={2} />}
      viewGrid
    >
      <div className="relative">
        <Search
          size={15}
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your narrations…"
          className="h-10 rounded-full pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        items.length === 0 ? (
          <div className="col-span-full grid place-items-center gap-3 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40 text-ink-muted">
              <Library size={24} strokeWidth={1.5} />
            </div>
            <div className="grid gap-1">
              <h2 className="text-[1.05rem] font-semibold text-foreground">
                Library is empty
              </h2>
              <p className="max-w-sm text-[0.85rem] text-ink-muted">
                Anything you narrate in the Studio will appear here with instant audio replay, transcripts, and sharing.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/studio">Go to Studio</Link>
            </Button>
          </div>
        ) : (
          <p className="t-lead text-center">
            No narration matches &ldquo;{query}&rdquo;.
          </p>
        )
      ) : (
        <section className="grid gap-3">
          <div className="flex items-center justify-between">
            <h2 className="t-label">
              Narrations ({filtered.length})
            </h2>
            <span className="t-meta text-ink-faint">
              {totalParagraphs} {totalParagraphs === 1 ? "paragraph" : "paragraphs"} total
            </span>
          </div>

          <div className="grid gap-2">
            {filtered.map((item) => (
              <LibraryNarrationCard
                key={item.id}
                narration={item}
                isCurrentTrack={stream.id === item.id}
                isPlaying={stream.playing}
                onDelete={setItemToDelete}
              />
            ))}
          </div>
        </section>
      )}

      <Dialog
        open={itemToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setItemToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete narration?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{itemToDelete?.title}&rdquo;? This will permanently remove its audio and transcript, and remove it from any playlists. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2.5">
            <Button
              variant="outline"
              onClick={() => setItemToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              <Trash2 size={13} strokeWidth={2} />
              <span>Delete</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkbenchPanel>
  );
}
