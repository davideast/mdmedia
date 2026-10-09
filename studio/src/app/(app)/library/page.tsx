"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
import { useRouteQuery, useWorkspaceField } from "@/components/shell/workspace-provider";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { deleteNarration, toNarration, watchMyNarrations } from "@/lib/narrations";
import { useOfflineStatus, type OfflineNarrationMetadata } from "@/lib/offline-manager";
import type { LibraryCursor, LibraryRecord } from "@/lib/library-page";
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

export default function LibraryPage() {
  const { user } = useAuth();
  const { stream, playTrack } = useNarration();
  const [items, setItems] = useState<Narration[]>([]);
  const [query] = useRouteQuery("q");
  const [cursor] = useRouteQuery("cursor");
  const [back, setBack] = useWorkspaceField("libraryPageHistory", "");
  const [nextCursor, setNextCursor] = useState<LibraryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPage = useRef(`${query}:${cursor}`);
  const setView = (q: string, next: string, previous: string[]) => {
    const url = new URL(window.location.href);
    setBack(JSON.stringify({ query: q, cursor: next, previous }));
    for (const [key, value] of [["q", q], ["cursor", next]]) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  let previous: string[] = [];
  try { const saved = JSON.parse(back || '{}'); const parsed = saved.query === query && saved.cursor === cursor ? saved.previous : []; if (Array.isArray(parsed)) previous = parsed.filter((value): value is string => typeof value === 'string'); } catch { /* Direct links need no back stack. */ }

  const [itemToDelete, setItemToDelete] = useState<Narration | null>(null);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setLoadError("");
      void (async () => {
        try {
          const token = await auth().currentUser?.getIdToken();
          if (!token) throw new Error("Please sign in to browse your library.");
          const params = new URLSearchParams({ q: query, cursor });
          const response = await fetch(`/api/library?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          if (!response.ok) throw new Error('Could not load your library. Try again.');
          const page = await response.json() as { items: LibraryRecord[]; nextCursor: LibraryCursor | null };
          if (controller.signal.aborted) return;
          setItems(page.items.map((item) => toNarration({ id: item.id, data: () => item.data })));
          setNextCursor(page.nextCursor);
          const key = `${query}:${cursor}`;
          if (lastPage.current !== key && scrollRef.current) scrollRef.current.scrollTop = 0;
          lastPage.current = key;
        } catch (error) {
          if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Could not load library.');
        } finally { if (!controller.signal.aborted) setLoading(false); }
      })();
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user, query, cursor, retry]);
  useEffect(() => {
    if (!user) return;
    let signature: string | null = null;
    return watchMyNarrations(user.uid, (items) => {
      const next = JSON.stringify(items.map((item) => [item.id, item.updatedAt, item.status, item.title]));
      if (signature !== null && signature !== next) setRetry((value) => value + 1);
      signature = next;
    });
  }, [user]);
  const filtered = items;

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
    setItems((items) => items.filter((item) => item.id !== narrationId));
    toast.success("Narration deleted.");
    void deleteNarration(narrationId).catch((err) => {
      console.error("Failed to delete narration:", err);
      toast.error("Could not delete narration.");
    });
  };

  return (
    <WorkbenchPanel
      workspacePage
      title="Library"
      scrollRef={scrollRef}
      icon={<Library size={13} strokeWidth={2} />}
      viewGrid
      gridVariant="wide"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={15}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
          />
          <Input
            value={query}
            onChange={(event) => setView(event.target.value.slice(0, 200), "", [])}
            aria-label="Search Library"
            placeholder="Search titles, transcripts, or IDs…"
            className="h-10 rounded-full pl-9"
          />
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/downloads">Downloads</Link>
        </Button>
      </div>

      {loading ? <p role="status" className="py-8 text-center text-sm text-ink-muted">Loading library…</p> : loadError ? <div role="alert" className="py-6 text-sm"><p>{loadError}</p><Button variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div> : filtered.length === 0 ? (
        !query && !cursor ? (
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
            {nextCursor ? "No matches in this batch. Continue searching older work below." : `No narrations match “${query}”${cursor ? " in the remaining library" : ""}.`}
          </p>
        )
      ) : (
        <section className="grid gap-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
            <h2 className="t-label">
              Narrations · {filtered.length} on this page
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
                onPlay={playTrack}
                onDelete={setItemToDelete}
              />
            ))}
          </div>
        </section>
      )}

      {!loading && !loadError && (cursor || nextCursor) ? <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" disabled={!cursor} onClick={() => setView(query, previous.at(-1) ?? "", previous.slice(0, -1))}>Previous</Button>
        <span className="text-xs text-ink-muted">Up to 50 narrations per page</span>
        <Button variant="outline" disabled={!nextCursor} onClick={() => setView(query, JSON.stringify(nextCursor), [...previous, cursor])}>{query ? 'Continue search' : 'Older narrations'}</Button>
      </div> : null}

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
