"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ShellContext, type ShellContextValue } from "@/components/shell/shell-context";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

const DOCK_KEY = "mdmedia.nav.docked.v1";
const CONTEXT_DOCK_KEY = "mdmedia.context.docked.v1";
const NAV = "nav";
const MAIN = "main";
const CONTEXT = "context";

/** Pixel thresholds at which resizing a panel smaller automatically snaps it to its docked rail. */
const LEFT_DOCK_THRESHOLD_PX = 170;
const RIGHT_DOCK_THRESHOLD_PX = 220;

function useResponsiveBreakpoints() {
  const [breakpoints, setBreakpoints] = useState({
    isMobile: false,   // < 768px
    isTablet: false,   // 768px - 1023px
    isMedium: false,   // 1024px - 1279px
    isDesktop: true,   // >= 1280px
  });

  useEffect(() => {
    const update = () => {
      if (typeof window === "undefined") return;
      const w = window.innerWidth;
      setBreakpoints({
        isMobile: w < 768,
        isTablet: w >= 768 && w < 1024,
        isMedium: w >= 1024 && w < 1280,
        isDesktop: w >= 1280,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return breakpoints;
}

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
  const breakpoints = useResponsiveBreakpoints();
  const hasContext = pathname.startsWith("/studio") || pathname.startsWith("/narration/");
  const isNarrationRoute = pathname.startsWith("/narration/");
  const [docked, setDocked] = useState(true);
  const [contextDocked, setContextDocked] = useState(false);
  const [navSheetOpen, setNavSheetOpen] = useState(false);
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const groupRef = useGroupRef();
  const isResizingRef = useRef(false);

  // Close sheets upon route transition
  useEffect(() => {
    setNavSheetOpen(false);
    setContextSheetOpen(false);
  }, [pathname]);

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

  // When viewport resizes into medium desktop (< 1280px), enforce mutual exclusivity
  useEffect(() => {
    if (breakpoints.isMedium && !docked && !contextDocked) {
      setDocked(true);
      window.localStorage.setItem(DOCK_KEY, "1");
    }
  }, [breakpoints.isMedium, docked, contextDocked]);

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
      // On medium screens (< 1280px), enforce mutual exclusivity to preserve reading width
      if (!next && typeof window !== "undefined" && window.innerWidth < 1280) {
        setContextDocked(true);
        window.localStorage.setItem(CONTEXT_DOCK_KEY, "1");
      }
      return next;
    });
  }, []);

  const toggleContextDock = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      // On tablet and mobile, open ContextPanel in an overlay Sheet to preserve 100% reading width
      setContextSheetOpen((prev) => !prev);
      return;
    }

    setContextDocked((previous) => {
      const next = !previous;
      window.localStorage.setItem(CONTEXT_DOCK_KEY, next ? "1" : "0");
      // On medium screens (< 1280px), enforce mutual exclusivity
      if (!next && typeof window !== "undefined" && window.innerWidth < 1280) {
        setDocked(true);
        window.localStorage.setItem(DOCK_KEY, "1");
      }
      return next;
    });
  }, []);

  const openNav = useCallback(() => setNavSheetOpen(true), []);
  const closeNav = useCallback(() => setNavSheetOpen(false), []);
  const toggleNav = useCallback(() => {
    if (breakpoints.isMobile) {
      setNavSheetOpen((prev) => !prev);
    } else {
      toggleDock();
    }
  }, [breakpoints.isMobile, toggleDock]);

  const openContext = useCallback(() => setContextSheetOpen(true), []);
  const closeContext = useCallback(() => setContextSheetOpen(false), []);
  const toggleContext = useCallback(() => {
    if (breakpoints.isMobile || breakpoints.isTablet) {
      setContextSheetOpen((prev) => !prev);
    } else {
      toggleContextDock();
    }
  }, [breakpoints.isMobile, breakpoints.isTablet, toggleContextDock]);

  const shellContextValue: ShellContextValue = useMemo(
    () => ({
      navSheetOpen,
      openNav,
      closeNav,
      toggleNav,
      showNavToggle: breakpoints.isMobile,
      hasContext,
      contextSheetOpen,
      openContext,
      closeContext,
      toggleContext,
      showContextToggle: hasContext && (breakpoints.isMobile || breakpoints.isTablet),
      isMobile: breakpoints.isMobile,
      isTablet: breakpoints.isTablet,
      isMedium: breakpoints.isMedium,
      isDesktop: breakpoints.isDesktop,
    }),
    [
      navSheetOpen,
      openNav,
      closeNav,
      toggleNav,
      breakpoints,
      hasContext,
      contextSheetOpen,
      openContext,
      closeContext,
      toggleContext,
    ],
  );

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
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-3 sm:px-6 sm:pb-5">
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

  const showLeftResizable = !docked && !breakpoints.isMobile;
  const showRightResizable =
    hasContext && !contextDocked && !breakpoints.isTablet && !breakpoints.isMobile;

  return (
    <ShellContext.Provider value={shellContextValue}>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden">
        {docked && !breakpoints.isMobile ? (
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

        {hasContext && contextDocked && !breakpoints.isTablet && !breakpoints.isMobile ? (
          <div
            data-docked="true"
            className="h-full flex-none border-l border-sidebar-border transition-[width] duration-200 ease-linear"
            style={{ width: 56 }}
          >
            <ContextPanel docked={true} onToggleDock={toggleContextDock} />
          </div>
        ) : null}

        {/* Slide-over overlay sheet for NavRail on mobile */}
        <Sheet open={navSheetOpen} onOpenChange={setNavSheetOpen}>
          <SheetContent
            side="left"
            className="w-[280px] max-w-[85vw] p-0 border-r border-border bg-sidebar"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Main application navigation rail</SheetDescription>
            <NavRail
              docked={false}
              onToggleDock={() => setNavSheetOpen(false)}
              onNavigate={() => setNavSheetOpen(false)}
            />
          </SheetContent>
        </Sheet>

        {/* Slide-over overlay sheet for ContextPanel on tablet and mobile */}
        {hasContext ? (
          <Sheet open={contextSheetOpen} onOpenChange={setContextSheetOpen}>
            <SheetContent
              side="right"
              className="w-[340px] max-w-[85vw] p-0 border-l border-border bg-background"
              showCloseButton={false}
            >
              <SheetTitle className="sr-only">Details</SheetTitle>
              <SheetDescription className="sr-only">Narration and studio inspector panel</SheetDescription>
              <ContextPanel docked={false} onToggleDock={() => setContextSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
    </ShellContext.Provider>
  );
}
