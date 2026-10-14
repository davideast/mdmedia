"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Download,
  FileCheck,
  Loader2,
  Play,
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
  DialogTitle,
} from "@/components/ui/dialog";
import { useNarration } from "@/components/shell/narration-provider";
import { deleteNarration, watchNarration } from "@/lib/narrations";
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
  onPlay,
  onDelete,
}: {
  narration: Narration;
  isCurrentTrack: boolean;
  isPlaying: boolean;
  onPlay: (narration: Narration) => void;
  onDelete: (narration: Narration) => void;
}) {
  const isReady = narration.status === "ready";
  const offlineMetadata = useMemo<OfflineNarrationMetadata>(
    () => ({
      title: narration.title,
      sourceMarkdown: narration.sourceMarkdown,
      adapted: narration.adapted,
      voice: narration.voice,
    }),
    [narration.title, narration.sourceMarkdown, narration.adapted, narration.voice],
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
      className={cn(
        "group library-track-card relative rounded-lg border p-3.5 transition-all",
        isCurrentTrack
          ? "border-primary/40 bg-card shadow-2xs"
          : "border-border/80 bg-card/60 hover:border-border hover:bg-card",
      )}
    >
      <div className="library-track-status" aria-hidden="true">
        {isCurrentTrack && isPlaying ? (
          <Volume2 size={14} className="flex-none text-primary animate-pulse" />
        ) : narration.status === "streaming" ? (
          <Loader2 size={14} className="flex-none animate-spin text-primary" />
        ) : (
          <CheckCircle2 size={14} className="flex-none text-primary" />
        )}
      </div>

      <Link
        href={`/narration/${narration.id}`}
        className="library-track-title block min-w-0 text-[0.92rem] font-medium text-foreground transition-colors group-hover:text-primary"
      >
        {narration.title}
      </Link>

      {cleanExcerpt ? (
        <p className="library-track-excerpt line-clamp-1 text-[0.8rem] text-ink-muted/80">
          {cleanExcerpt}
        </p>
      ) : null}

      <div className="library-track-details">
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

        <div className="library-track-tools">
          {isDownloading ? (
            <span
              className="inline-flex size-11 items-center justify-center text-primary"
              title="Downloading for offline listening…"
            >
              <Loader2 size={16} className="animate-spin" />
            </span>
          ) : isDownloaded ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={async () => {
                try {
                  const remains = await remove();
                  toast.info(remains ? "Still saved in a downloaded playlist" : "Removed from offline storage");
                } catch {
                  toast.error("Could not remove narration from offline storage.");
                }
              }}
              className="size-11 text-mint hover:bg-muted hover:text-foreground"
              title="Downloaded to device (click to remove)"
              aria-label="Remove download"
            >
              <FileCheck size={16} strokeWidth={2} />
              <span className="sr-only">Downloaded</span>
            </Button>
          ) : isReady ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={async () => {
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
              className="size-11 text-ink-muted hover:bg-muted hover:text-foreground"
              title="Download for offline listening"
              aria-label="Download for offline"
            >
              <Download size={16} strokeWidth={2} />
              <span className="sr-only">Download for offline</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onDelete(narration)}
            className="size-11 text-ink-muted hover:bg-destructive/10 hover:text-destructive"
            title={`Delete ${narration.title}`}
            aria-label={`Delete ${narration.title}`}
          >
            <Trash2 size={16} strokeWidth={2} />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      </div>

      <div className="library-track-primary">
        <Button
          type="button"
          size="sm"
          onClick={() => onPlay(narration)}
          disabled={!isReady}
          className="h-11 min-w-24 gap-2 px-3 text-sm"
          aria-label={`Play ${narration.title}`}
        >
          <Play size={16} strokeWidth={2.5} className="fill-current" />
          <span>Play</span>
        </Button>
      </div>
    </div>
  );
}

export function NarrationLibraryEntry({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { stream, playTrack } = useNarration();
  const [narration, setNarration] = useState<Narration | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => watchNarration(id, setNarration), [id]);
  const handleConfirmDelete = () => {
    if (stream.id === id) stream.cancel();
    setConfirmDelete(false);
    void deleteNarration(id).then(onDeleted).catch(() => toast.error('Could not delete narration.'));
  };
  if (!narration) return <p className="rounded-lg border border-border p-4 text-sm text-ink-muted">Loading narration…</p>;
  return <><LibraryNarrationCard narration={narration} isCurrentTrack={stream.id === id} isPlaying={stream.playing} onPlay={playTrack} onDelete={() => setConfirmDelete(true)} />
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}><DialogContent><DialogTitle>Delete narration?</DialogTitle><DialogDescription>This removes the narration and its audio.</DialogDescription><DialogFooter><Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="destructive" onClick={handleConfirmDelete}>Delete</Button></DialogFooter></DialogContent></Dialog></>;
}
