"use client";

import { useEffect, useState, type JSX } from "react";
import {
  AudioLines,
  Clapperboard,
  FileText,
  Film,
  ImageIcon,
  LayoutGrid,
  Library,
  ListMusic,
  Music,
  Plus,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import {
  readSnapshotWithLivePlayhead,
  useActiveChatViewContext,
} from "@/lib/chat-context-bridge";
import { formatActiveViewPillLabel, type ActiveViewContext } from "@/lib/chat/types";
import { useChat } from "./chat-provider";

function SurfaceIcon({ surface }: { surface: ActiveViewContext["surface"] }): JSX.Element {
  const iconClass = "shrink-0 text-ink-muted";
  switch (surface) {
    case "analysis":
      return <ScanSearch size={13} className={iconClass} />;
    case "tree-doc":
      return <FileText size={13} className={iconClass} />;
    case "narration":
      return <AudioLines size={13} className={iconClass} />;
    case "video":
      return <Film size={13} className={iconClass} />;
    case "image":
      return <ImageIcon size={13} className={iconClass} />;
    case "music":
      return <Music size={13} className={iconClass} />;
    case "composer":
      return <Sparkles size={13} className={iconClass} />;
    case "cut":
      return <Clapperboard size={13} className={iconClass} />;
    case "storyboard":
      return <LayoutGrid size={13} className={iconClass} />;
    case "playlist":
      return <ListMusic size={13} className={iconClass} />;
    case "library":
    case "activity":
      return <Library size={13} className={iconClass} />;
  }
}

export function ChatAmbientPill(): JSX.Element | null {
  const chat = useChat();
  const baseContext = useActiveChatViewContext();
  const [sampledContext, setSampledContext] = useState<ActiveViewContext | null>(() =>
    readSnapshotWithLivePlayhead(),
  );

  useEffect(() => {
    setSampledContext(readSnapshotWithLivePlayhead() ?? baseContext);
    const interval = window.setInterval(() => {
      setSampledContext(readSnapshotWithLivePlayhead());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [baseContext]);

  const activeCtx = sampledContext ?? baseContext;
  const label = formatActiveViewPillLabel(activeCtx);

  if (!activeCtx || label === null) {
    return null;
  }

  if (chat.ambientMuted) {
    return (
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => chat.setAmbientMuted(false)}
          className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-ink-faint transition-colors hover:bg-[var(--surface-inset)] hover:text-ink-muted"
        >
          <Plus size={12} />
          <span>Attach current view</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-7 items-center justify-between gap-2 rounded-lg border border-border bg-[var(--surface-inset)] px-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <SurfaceIcon surface={activeCtx.surface} />
        <span className="t-meta truncate text-foreground">{label}</span>
      </div>
      <button
        type="button"
        aria-label="Detach current view context"
        onClick={() => chat.setAmbientMuted(true)}
        className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:bg-[var(--surface-subtle)] hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}
