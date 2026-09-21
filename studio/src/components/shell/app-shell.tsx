"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useGroupRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AudioPlayerBar } from "@/components/reader/audio-player-bar";
import { ContextPanel } from "@/components/shell/context-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { NavRail } from "@/components/shell/nav-rail";

const DOCK_KEY = "mdmedia.nav.docked.v1";
const CONTEXT_DOCK_KEY = "mdmedia.context.docked.v1";
const NAV = "nav";
const MAIN = "main";
const CONTEXT = "context";

/** Pixel thresholds at which resizing a panel smaller automatically snaps it to its docked rail. */
const LEFT_DOCK_THRESHOLD_PX = 170;
const RIGHT_DOCK_THRESHOLD_PX = 220;

/**
 * The workbench shell.
 *
 * Three columns on workbench routes (`/studio`, `/narration/*`): the dockable
 * nav rail, the main surface, and the dockable right context panel. Utility
 * routes (`/library`, `/playlists`, `/settings`, `/profile/*`) omit the right
 * column so the main surface uses the full remaining viewport width.
 *
 * Both the left and right panels can be resized when undocked and automatically
 * snap into their 56px docked rail once resized down past their threshold.
 */
export function AppShell({
  children,
}: {
  children: ReactNode;
  context?: ReactNode;
}) {
  const pathname = usePathname();
  const { stream, queue, nextTrack, previousTrack } = useNarration();
  const hasContext = pathname.startsWith("/studio") || pathname.startsWith("/narration/");
  const isNarrationRoute = pathname.startsWith("/narration/");
  const [docked, setDocked] = useState(true);
  const [contextDocked, setContextDocked] = useState(false);
  const groupRef = useGroupRef();
  const isResizingRef = useRef(false);

  const busy = stream.status === "starting" || stream.status === "streaming";
  const showPlayerBar =
    (isNarrationRoute && stream.transcript.length > 0) ||
    (stream.player !== null && stream.durationMs > 0);

  useEffect(() => {
    const stored = window.localStorage.getItem(DOCK_KEY);
    if (stored !== null) setDocked(stored === "1");
    const storedContext = window.localStorage.getItem(CONTEXT_DOCK_KEY);
    if (storedContext !== null) setContextDocked(storedContext === "1");
  }, []);

  useEffect(() => {
    const stopResizing = () => {
      isResizingRef.current = false;
    };
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("keyup", stopResizing);
    return () => {
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("keyup", stopResizing);
    };
  }, []);

  const setLeftDocked = useCallback((next: boolean) => {
    setDocked(next);
    window.localStorage.setItem(DOCK_KEY, next ? "1" : "0");
  }, []);

  const setRightDocked = useCallback((next: boolean) => {
    setContextDocked(next);
    window.localStorage.setItem(CONTEXT_DOCK_KEY, next ? "1" : "0");
  }, []);

  const toggleDock = useCallback(() => {
    setDocked((previous) => {
      const next = !previous;
      window.localStorage.setItem(DOCK_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleContextDock = useCallback(() => {
    setContextDocked((previous) => {
      const next = !previous;
      window.localStorage.setItem(CONTEXT_DOCK_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const markResizeStart = useCallback(() => {
    isResizingRef.current = true;
  }, []);

  const subtitle = [
    stream.voice,
    queue ? `${queue.playlistTitle} (${queue.index + 1}/${queue.tracks.length})` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const mainContent = (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {children}
      {showPlayerBar ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-6 pb-5">
          <AudioPlayerBar
            player={stream.player}
            positionMs={stream.positionMs}
            durationMs={stream.durationMs}
            playing={stream.playing}
            busy={busy}
            title={stream.title || undefined}
            href={stream.id ? `/narration/${stream.id}` : undefined}
            subtitle={subtitle || undefined}
            onPrevious={previousTrack}
            onNext={queue ? nextTrack : undefined}
            hasNext={queue !== null && queue.index + 1 < queue.tracks.length}
          />
        </div>
      ) : null}
    </div>
  );

  const showLeftResizable = !docked;
  const showRightResizable = hasContext && !contextDocked;

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden">
      {docked ? (
        <div
          data-docked="true"
          className="h-full flex-none border-r border-sidebar-border transition-[width] duration-200 ease-linear"
          style={{ width: 56 }}
        >
          <NavRail docked={true} onToggleDock={toggleDock} />
        </div>
      ) : null}

      {showLeftResizable || showRightResizable ? (
        <ResizablePanelGroup
          key={`layout-${showLeftResizable ? "L" : "l"}-${showRightResizable ? "R" : "r"}`}
          groupRef={groupRef}
          orientation="horizontal"
          className="min-w-0 flex-1"
        >
          {showLeftResizable ? (
            <>
              <ResizablePanel
                id={NAV}
                defaultSize="248px"
                minSize="120px"
                maxSize="340px"
                groupResizeBehavior="preserve-pixel-size"
                className="min-w-0"
                onResize={(panelSize) => {
                  if (
                    isResizingRef.current &&
                    panelSize.inPixels <= LEFT_DOCK_THRESHOLD_PX
                  ) {
                    isResizingRef.current = false;
                    setLeftDocked(true);
                  }
                }}
              >
                <NavRail docked={false} onToggleDock={toggleDock} />
              </ResizablePanel>

              <ResizableHandle
                onPointerDown={markResizeStart}
                onKeyDown={markResizeStart}
                className="w-[7px] bg-sidebar-border transition-colors duration-150 hover:bg-border-strong data-[state=drag]:bg-border-strong"
              >
                <div className="pointer-events-none h-9 w-[3px] rounded-full bg-border-strong" />
              </ResizableHandle>
            </>
          ) : null}

          <ResizablePanel id={MAIN} minSize="40%" className="min-w-0">
            {mainContent}
          </ResizablePanel>

          {showRightResizable ? (
            <>
              <ResizableHandle
                onPointerDown={markResizeStart}
                onKeyDown={markResizeStart}
                className="w-[7px] bg-border transition-colors duration-150 hover:bg-border-strong data-[state=drag]:bg-border-strong"
              >
                <div className="pointer-events-none h-9 w-[3px] rounded-full bg-border-strong" />
              </ResizableHandle>

              <ResizablePanel
                id={CONTEXT}
                defaultSize="28%"
                minSize="140px"
                maxSize="44%"
                className="min-w-0 border-l border-border"
                onResize={(panelSize) => {
                  if (
                    isResizingRef.current &&
                    panelSize.inPixels <= RIGHT_DOCK_THRESHOLD_PX
                  ) {
                    isResizingRef.current = false;
                    setRightDocked(true);
                  }
                }}
              >
                <ContextPanel docked={false} onToggleDock={toggleContextDock} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      ) : (
        mainContent
      )}

      {hasContext && contextDocked ? (
        <div
          data-docked="true"
          className="h-full flex-none border-l border-sidebar-border transition-[width] duration-200 ease-linear"
          style={{ width: 56 }}
        >
          <ContextPanel docked={true} onToggleDock={toggleContextDock} />
        </div>
      ) : null}
    </div>
  );
}
