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
import { useMediaSession } from "@/lib/use-media-session";
import { useConnectivity } from "@/lib/connectivity";
import { useOfflinePlayback } from "@/components/shell/offline-playback-provider";

const DOCK_KEY = "mdmedia.nav.docked.v2";
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
  const offline = useConnectivity() === 'offline';
  const onlineScreenDisabled = offline && pathname !== '/downloads';
  const { stream, queue, nextTrack, previousTrack } = useNarration();
  const offlinePlayback = useOfflinePlayback();
  // One active transport owns both the player bar and the system media controls.
  const usingDownloads = !stream.playing && offlinePlayback.track !== null;
  useEffect(() => {
    if (stream.playing) offlinePlayback.stop();
  }, [stream.playing, offlinePlayback.stop]);
  useMediaSession(usingDownloads ? {
    player: offlinePlayback.player,
    title: offlinePlayback.track!.title,
    artist: offlinePlayback.track!.voice || 'mdmedia',
    album: offlinePlayback.playlistTitle || 'Downloads',
    playing: offlinePlayback.playing,
    positionMs: offlinePlayback.positionMs,
    durationMs: offlinePlayback.durationMs,
    previous: offlinePlayback.previous,
    next: offlinePlayback.index + 1 < offlinePlayback.queueLength ? offlinePlayback.next : undefined,
  } : {
    player: stream.player,
    title: stream.title || 'Narration',
    artist: stream.voice || 'mdmedia',
    album: queue?.playlistTitle || 'mdmedia studio',
    playing: stream.playing,
    positionMs: stream.positionMs,
    durationMs: stream.durationMs,
    previous: !offline && queue ? previousTrack : undefined,
    next: !offline && queue && queue.index + 1 < queue.tracks.length ? nextTrack : undefined,
  });
  const breakpoints = useResponsiveBreakpoints();
  const hasContext = pathname.startsWith("/studio") || pathname.startsWith("/narration/");
  const isNarrationRoute = pathname.startsWith("/narration/");
  const [docked, setDocked] = useState(false);
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
  const showPlayerBar = offlinePlayback.track !== null ||
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
      setContextDocked(true);
      window.localStorage.setItem(CONTEXT_DOCK_KEY, "1");
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
      hasPlayerBar: showPlayerBar,
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
      showPlayerBar,
    ],
  );

  const markResizeStart = useCallback(() => {
    isResizingRef.current = true;
  }, []);

  const subtitleItems = [
    stream.voice,
    queue ? `${queue.playlistTitle} (${queue.index + 1}/${queue.tracks.length})` : null,
  ].filter(Boolean) as string[];

  const subtitle =
    subtitleItems.length > 0 ? (
      <span className="inline-flex items-center gap-2">
        {subtitleItems.map((item, idx) => (
          <span key={idx}>{item}</span>
        ))}
      </span>
    ) : undefined;

  const mainContent = (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={
        {
          "--shell-player-offset": showPlayerBar
            ? "var(--player-dock-height, 6.5rem)"
            : "0rem",
        } as React.CSSProperties
      }
    >
      {onlineScreenDisabled ? (
        <div role="status" className="flex flex-none items-center justify-between gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
          <span>Studio is offline. Online controls are disabled; your work stays here.</span>
          <a href="/downloads" className="flex-none font-medium text-primary underline underline-offset-2">Open Downloads</a>
        </div>
      ) : null}
      <div id="workspace-page" aria-label="Workspace" className={onlineScreenDisabled ? 'min-h-0 flex-1 opacity-60' : 'min-h-0 flex-1'} inert={onlineScreenDisabled} aria-disabled={onlineScreenDisabled}>
        {children}
      </div>
      {showPlayerBar ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-3 sm:px-6 sm:pb-5">
          {usingDownloads ? (
            <AudioPlayerBar
              player={offlinePlayback.player}
              positionMs={offlinePlayback.positionMs}
              durationMs={offlinePlayback.durationMs}
              playing={offlinePlayback.playing}
              busy={false}
              title={offlinePlayback.track!.title}
              subtitle={offlinePlayback.playlistTitle || 'Downloads'}
              href="/downloads"
              onPrevious={offlinePlayback.previous}
              onNext={offlinePlayback.queueLength > 1 ? offlinePlayback.next : undefined}
              hasNext={offlinePlayback.index + 1 < offlinePlayback.queueLength}
            />
          ) : (
          <AudioPlayerBar
            player={stream.player}
            positionMs={stream.positionMs}
            durationMs={stream.durationMs}
            playing={stream.playing}
            busy={busy}
            title={stream.title || undefined}
            href={!offline && stream.id ? `/narration/${stream.id}` : undefined}
            subtitle={subtitle || undefined}
            onPrevious={offline ? undefined : previousTrack}
            onNext={!offline && queue ? nextTrack : undefined}
            hasNext={!offline && queue !== null && queue.index + 1 < queue.tracks.length}
          />
          )}
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
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
                  <div className="h-full min-h-0" inert={onlineScreenDisabled} aria-disabled={onlineScreenDisabled}>
                    <ContextPanel docked={false} onToggleDock={toggleContextDock} />
                  </div>
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
          <div className="h-full" inert={onlineScreenDisabled} aria-disabled={onlineScreenDisabled}>
            <ContextPanel docked={true} onToggleDock={toggleContextDock} />
          </div>
          </div>
        ) : null}
        </div>
        </div>

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
              <div className="h-full" inert={onlineScreenDisabled} aria-disabled={onlineScreenDisabled}>
                <ContextPanel docked={false} onToggleDock={() => setContextSheetOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
    </ShellContext.Provider>
  );
}
