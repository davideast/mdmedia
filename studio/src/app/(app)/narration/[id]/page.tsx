"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { BookOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Reader } from "@/components/reader/reader";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { updateNarrationTitle } from "@/lib/narrations";

export default function NarrationPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { stream } = useNarration();
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const displayTitle = stream.title.length > 0 ? stream.title : "Narration";

  const startEditingTitle = () => {
    setDraftTitle(displayTitle);
    setEditingTitle(true);
  };

  const commitTitle = async () => {
    const trimmed = draftTitle.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === stream.title) return;
    const previousTitle = stream.title;
    stream.setTitle(trimmed);
    try {
      await updateNarrationTitle(id, trimmed);
    } catch {
      stream.setTitle(previousTitle);
      toast.error("Could not update title.");
    }
  };

  const busy = stream.status === "starting" || stream.status === "streaming";
  const empty = stream.transcript.length === 0;

  return (
    <WorkbenchPanel
      title={displayTitle}
      icon={<BookOpen size={13} strokeWidth={2} className="flex-none" />}
      headerClassName="px-8"
      headerInnerClassName="mx-auto w-full max-w-[68ch]"
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
                setEditingTitle(false);
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
      actions={busy ? <Loader2 size={13} className="animate-spin text-ink-muted" /> : null}
      bodyClassName="px-8 pt-10 pb-40"
    >
      {stream.status === "error" ? (
        <p className="mx-auto w-full max-w-[68ch] text-[0.95rem] text-ink-muted">
          {stream.errorMessage ?? "This narration could not be loaded."}
        </p>
      ) : empty ? (
        <div className="grid place-items-center pt-24">
          <Loader2 size={18} className="animate-spin text-ink-faint" />
          <span className="sr-only">Loading narration</span>
        </div>
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
