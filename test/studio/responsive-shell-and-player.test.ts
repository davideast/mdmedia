import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Responsive Shell & Audio Player Architecture (intrinsic-ui-craft)", () => {
  const globalsCssPath = resolve(import.meta.dir, "../../studio/src/app/globals.css");
  const appShellPath = resolve(import.meta.dir, "../../studio/src/components/shell/app-shell.tsx");
  const audioPlayerBarPath = resolve(import.meta.dir, "../../studio/src/components/reader/audio-player-bar.tsx");
  const narrationSettingsPath = resolve(import.meta.dir, "../../studio/src/components/narration/narration-settings.tsx");
  const workbenchPanelPath = resolve(import.meta.dir, "../../studio/src/components/shell/workbench-panel.tsx");
  const shellContextPath = resolve(import.meta.dir, "../../studio/src/components/shell/shell-context.tsx");
  const navRailPath = resolve(import.meta.dir, "../../studio/src/components/shell/nav-rail.tsx");

  const globalsCss = readFileSync(globalsCssPath, "utf8");
  const appShell = readFileSync(appShellPath, "utf8");
  const audioPlayerBar = readFileSync(audioPlayerBarPath, "utf8");
  const narrationSettings = readFileSync(narrationSettingsPath, "utf8");
  const workbenchPanel = readFileSync(workbenchPanelPath, "utf8");
  const shellContext = readFileSync(shellContextPath, "utf8");
  const navRail = readFileSync(navRailPath, "utf8");

  describe("globals.css container queries for audio player", () => {
    it("defines container-type inline-size on .audio-player-pill", () => {
      expect(globalsCss).toContain(".audio-player-pill");
      expect(globalsCss).toContain("container-type: inline-size");
      expect(globalsCss).toContain("container-name: player");
    });

    it("defines .player-desktop-row and .player-compact-row with @container query breakpoint", () => {
      expect(globalsCss).toContain(".player-desktop-row");
      expect(globalsCss).toContain(".player-compact-row");
      expect(globalsCss).toContain("@container player (max-width: 619px)");
    });
  });

  describe("AppShell responsive orchestration & drawer hygiene", () => {
    it("tracks responsive breakpoints (isMobile, isTablet, isMedium, isDesktop)", () => {
      expect(appShell).toContain("useResponsiveBreakpoints");
      expect(appShell).toContain("isMobile");
      expect(appShell).toContain("isTablet");
      expect(appShell).toContain("isMedium");
    });

    it("enforces mutual exclusivity between sidebars on medium screens (< 1280px)", () => {
      expect(appShell).toContain("window.innerWidth < 1280");
      expect(appShell).toContain("setContextDocked(true)");
      expect(appShell).toContain("setDocked(true)");
    });

    it("renders ContextPanel in an overlay Sheet for tablet and mobile instead of in-flow crushing", () => {
      expect(appShell).toContain("<Sheet open={contextSheetOpen} onOpenChange={setContextSheetOpen}>");
      expect(appShell).toContain("showRightResizable =");
      expect(appShell).toContain("!breakpoints.isTablet && !breakpoints.isMobile");
    });

    it("renders NavRail in an overlay Sheet for mobile navigation", () => {
      expect(appShell).toContain("<Sheet open={navSheetOpen} onOpenChange={setNavSheetOpen}>");
      expect(appShell).toContain('side="left"');
      expect(appShell).toContain("setNavSheetOpen(false)");
    });

    it("provides ShellContext to allow child panels to toggle drawers", () => {
      expect(appShell).toContain("<ShellContext.Provider value={shellContextValue}>");
      expect(shellContext).toContain("export const ShellContext = createContext");
      expect(shellContext).toContain("export function useOptionalShell");
    });

    it("automatically closes sheets upon route transition", () => {
      expect(appShell).toContain("setNavSheetOpen(false)");
      expect(appShell).toContain("setContextSheetOpen(false)");
    });

    it("uses responsive padding for the floating player pill container", () => {
      expect(appShell).toContain("px-3 pb-3 sm:px-6 sm:pb-5");
    });
  });

  describe("Responsive Drawer Toggles in WorkbenchPanel & NavRail", () => {
    it("renders navigation drawer toggle button (PanelLeft) on mobile in WorkbenchPanel", () => {
      expect(workbenchPanel).toContain("shell?.showNavToggle");
      expect(workbenchPanel).toContain("shell.toggleNav");
      expect(workbenchPanel).toContain("<PanelLeft");
      expect(workbenchPanel).toContain("md:hidden");
    });

    it("renders context drawer toggle button (PanelRight) on responsive viewports in WorkbenchPanel", () => {
      expect(workbenchPanel).toContain("shell?.showContextToggle");
      expect(workbenchPanel).toContain("shell.toggleContext");
      expect(workbenchPanel).toContain("<PanelRight");
      expect(workbenchPanel).toContain("lg:hidden");
    });

    it("supports onNavigate in NavRail so mobile navigation automatically closes drawer", () => {
      expect(navRail).toContain("onNavigate?: () => void");
      expect(navRail).toContain("onClick={onNavigate}");
    });
  });

  describe("AudioPlayerBar progressive disclosure", () => {
    it("renders .player-desktop-row and .player-compact-row", () => {
      expect(audioPlayerBar).toContain("player-desktop-row");
      expect(audioPlayerBar).toContain("player-compact-row");
    });

    it("features a two-tier compact layout with full-width scrubber track on narrow widths", () => {
      expect(audioPlayerBar).toContain("clock(positionMs)");
      expect(audioPlayerBar).toContain("clock(durationMs)");
      expect(audioPlayerBar).toContain("Slider");
    });
  });

  describe("NarrationSettings micro-layout responsiveness", () => {
    it("uses min-w-0 and truncate on Document View toggle buttons", () => {
      expect(narrationSettings).toContain('className="truncate">Audio adapted</span>');
      expect(narrationSettings).toContain('className="truncate">Source</span>');
    });

    it("uses a 2-column grid for highlight colors to prevent text truncation", () => {
      expect(narrationSettings).toContain("grid grid-cols-2 gap-1.5");
      expect(narrationSettings).not.toContain("grid grid-cols-3 gap-1.5");
    });

    it("uses min-w-0 on the playlist input to avoid clipping", () => {
      expect(narrationSettings).toContain('className="h-8 min-w-0 text-[0.8rem]"');
    });
  });
});
