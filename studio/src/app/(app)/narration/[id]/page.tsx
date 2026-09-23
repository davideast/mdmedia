"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { BookOpen, Check, Copy, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FollowButton } from "@/components/reader/follow-button";
import { Reader } from "@/components/reader/reader";
import { SourceDocumentView } from "@/components/reader/source-document-view";
import { useReaderFollow } from "@/components/reader/use-reader-follow";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { updateNarrationTitle } from "@/lib/narrations";

export default function NarrationPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { stream, documentView, setDocumentView, generationQueue } = useNarration();
  const activeQueueJob = generationQueue.jobs.find(
    (j) =>
      j.narrationId === id &&
      (j.status === "queued" || j.status === "starting" || j.status === "streaming"),
  );
  const failedQueueJob = generationQueue.jobs.find(
    (j) => j.narrationId === id && j.status === "error",
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isSubmittingRef = useRef(false);
  const isCancelledRef = useRef(false);

  // Only load from storage when this is not the narration already streaming
  // through the provider — replay must not interrupt a live synthesis.
  const isLive = stream.id === id;

  useEffect(() => {
    if (isLive) return;
    void stream.loadExisting(id);
    // `stream` is a stable object from the provider; re-running on every render
    // of it would restart the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLive]);

  useEffect(() => {
    if (editingTitle) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingTitle]);

  const spokenThrough = useMemo(() => {
    if (stream.status === "ready" || stream.status === "loading") {
      return stream.transcript.length;
    }
    let through = 0;
    for (const chunk of stream.chunks) {
      through = Math.max(through, chunk.docOffset + chunk.text.length);
    }
    return through;
  }, [stream.status, stream.transcript.length, stream.chunks]);

  const words = useMemo(
    () => stream.chunks.flatMap((chunk) => chunk.words),
    [stream.chunks],
  );

  const audioLoaded = stream.player !== null && stream.durationMs > 0;

  const handleSeekWord = (startMs: number) => {
    if (!stream.player || stream.durationMs <= 0) return;
    stream.player.seek(startMs);
  };

  const displayTitle =
    stream.title.length > 0
      ? stream.title
      : activeQueueJob?.title || "Narration";

  const startEditingTitle = () => {
    isSubmittingRef.current = false;
    isCancelledRef.current = false;
    setDraftTitle(displayTitle);
    setEditingTitle(true);
  };

  const cancelEditing = () => {
    isCancelledRef.current = true;
    setEditingTitle(false);
    setDraftTitle(displayTitle);
  };

  const commitTitle = async () => {
    if (isSubmittingRef.current || isCancelledRef.current) return;
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === stream.title) {
      setEditingTitle(false);
      return;
    }
    isSubmittingRef.current = true;
    setEditingTitle(false);
    const previousTitle = stream.title;
    stream.setTitle(trimmed);
    try {
      updateNarrationTitle(id, trimmed);
      toast.success("Title updated");
    } catch {
      stream.setTitle(previousTitle);
      toast.error("Could not update title.");
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const busy =
    stream.status === "starting" ||
    stream.status === "streaming" ||
    Boolean(activeQueueJob);
  const empty = stream.transcript.length === 0;

  const [copied, setCopied] = useState(false);

  const documentConfig = useMemo(() => {
    switch (documentView) {
      case "source":
        return {
          label: "Source",
          name: "source document",
          text: stream.sourceMarkdown || stream.transcript || "",
        };
      case "raw":
        return {
          label: "Raw",
          name: "raw document",
          text: stream.sourceMarkdown || stream.transcript || "",
        };
      case "adapted":
      default:
        return {
          label: "Adapted",
          name: "audio adapted document",
          text: stream.transcript || "",
        };
    }
  }, [documentView, stream.sourceMarkdown, stream.transcript]);

  useEffect(() => {
    setCopied(false);
  }, [documentView]);

  const handleCopy = async () => {
    const text = documentConfig.text;
    if (!text || text.trim().length === 0) {
      toast.error(`No ${documentConfig.name} available to copy.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(
        `${documentConfig.name.charAt(0).toUpperCase() + documentConfig.name.slice(1)} copied as markdown`,
      );
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy markdown to clipboard.");
    }
  };

  const { showFollowButton, scrollToCurrent } = useReaderFollow({
    containerRef: scrollContainerRef,
    activeCharStart: stream.activeWord?.charStart ?? null,
    activeCharEnd: stream.activeWord?.charEnd ?? null,
    isPlaying: stream.playing,
    disabled: documentView !== "adapted" || empty,
  });

  return (
    <WorkbenchPanel
      title={displayTitle}
      scrollRef={scrollContainerRef}
      floating={
        showFollowButton ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--player-dock-height,6.5rem)+0.75rem)] z-30 flex justify-center px-4">
            <FollowButton onClick={scrollToCurrent} />
          </div>
        ) : null
      }
      icon={
        documentView === "source" || documentView === "raw" ? (
          <FileText size={13} strokeWidth={2} className="flex-none" />
        ) : (
          <BookOpen size={13} strokeWidth={2} className="flex-none" />
        )
      }
      viewGrid
      gridVariant="reader"
      titleNode={
        editingTitle ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              }
            }}
            aria-label="Edit narration title"
            className="h-6 w-full max-w-md rounded-xs bg-background px-1.5 text-[12px] font-semibold text-foreground ring-1 ring-ring outline-hidden"
          />
        ) : (
          <span
            onDoubleClick={startEditingTitle}
            title="Double-click to rename"
            className="cursor-text truncate rounded-xs px-1 -mx-1 transition-colors hover:bg-muted"
          >
            {displayTitle}
          </span>
        )
      }
      actions={
        <div className="flex items-center gap-1">
          {busy ? <Loader2 size={13} className="animate-spin text-ink-muted" /> : null}
          {!empty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              title={
                copied
                  ? `Copied ${documentConfig.name}`
                  : `Copy ${documentConfig.name} as markdown`
              }
              aria-label={
                copied
                  ? `Copied ${documentConfig.name}`
                  : `Copy ${documentConfig.name} as markdown`
              }
              className="size-7 p-0 text-ink-muted hover:text-foreground"
            >
              {copied ? (
                <Check size={13} strokeWidth={2.5} className="text-primary" />
              ) : (
                <Copy size={13} strokeWidth={2} />
              )}
            </Button>
          ) : null}
        </div>
      }
    >
      {stream.status === "error" || failedQueueJob ? (
        <p className="text-[0.95rem] text-ink-muted">
          {failedQueueJob?.errorMessage ??
            stream.errorMessage ??
            "This narration could not be loaded."}
        </p>
      ) : empty ? (
        activeQueueJob ? (
          <div className="mx-auto flex max-w-md flex-col items-center justify-center pt-24 text-center">
            <div className="mb-4 inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Loader2 size={18} className="animate-spin" />
            </div>
            <h3 className="mb-1 text-[0.95rem] font-semibold text-foreground">
              Synthesizing audio
            </h3>
            <p className="mb-4 text-xs text-ink-muted">
              {activeQueueJob.totalChunks > 0
                ? `Synthesizing audio (${activeQueueJob.completedChunks} / ${activeQueueJob.totalChunks} chunks)`
                : activeQueueJob.status === "starting"
                  ? "Connecting to synthesis engine…"
                  : "Adapting text and preparing chunks…"}
            </p>
            <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
              {activeQueueJob.totalChunks > 0 ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        8,
                        Math.round(
                          (activeQueueJob.completedChunks / activeQueueJob.totalChunks) * 100,
                        ),
                      ),
                    )}%`,
                  }}
                />
              ) : (
                <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/70" />
              )}
            </div>
          </div>
        ) : (
          <div className="grid place-items-center pt-24">
            <Loader2 size={18} className="animate-spin text-ink-faint" />
            <span className="sr-only">Loading narration</span>
          </div>
        )
      ) : documentView === "source" || documentView === "raw" ? (
        <SourceDocumentView
          sourceMarkdown={stream.sourceMarkdown || ""}
          viewMode={documentView === "raw" ? "raw" : "source"}
        />
      ) : (
        <Reader
          transcript={stream.transcript}
          activeCharStart={stream.activeWord?.charStart ?? null}
          activeCharEnd={stream.activeWord?.charEnd ?? null}
          spokenThrough={spokenThrough}
          words={words}
          audioLoaded={audioLoaded}
          loadedDurationMs={stream.durationMs}
          onSeekWord={handleSeekWord}
        />
      )}
    </WorkbenchPanel>
  );
}
