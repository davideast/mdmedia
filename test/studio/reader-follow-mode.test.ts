import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Reader Follow Mode & Floating Resume Architecture", () => {
  const followHookPath = resolve(
    import.meta.dir,
    "../../studio/src/components/reader/use-reader-follow.ts",
  );
  const followButtonPath = resolve(
    import.meta.dir,
    "../../studio/src/components/reader/follow-button.tsx",
  );
  const narrationPagePath = resolve(
    import.meta.dir,
    "../../studio/src/app/(app)/narration/[id]/page.tsx",
  );
  const workbenchPanelPath = resolve(
    import.meta.dir,
    "../../studio/src/components/shell/workbench-panel.tsx",
  );
  const globalsCssPath = resolve(
    import.meta.dir,
    "../../studio/src/app/globals.css",
  );
  const narrationSettingsPath = resolve(
    import.meta.dir,
    "../../studio/src/components/narration/narration-settings.tsx",
  );

  const followHook = readFileSync(followHookPath, "utf8");
  const followButton = readFileSync(followButtonPath, "utf8");
  const narrationPage = readFileSync(narrationPagePath, "utf8");
  const workbenchPanel = readFileSync(workbenchPanelPath, "utf8");
  const globalsCss = readFileSync(globalsCssPath, "utf8");
  const narrationSettings = readFileSync(narrationSettingsPath, "utf8");

  describe("useReaderFollow hook contract", () => {
    it("exports useReaderFollow with proper state and controls", () => {
      expect(followHook).toContain("export function useReaderFollow");
      expect(followHook).toContain("isFollowing");
      expect(followHook).toContain("showFollowButton");
      expect(followHook).toContain("scrollToCurrent");
    });

    it("activates follow mode automatically when playback starts", () => {
      expect(followHook).toContain("isPlaying && !wasPlayingRef.current");
      expect(followHook).toContain("setIsFollowing(true)");
    });

    it("detects manual user scrolls and disengages follow mode", () => {
      expect(followHook).toContain('container.addEventListener("wheel"');
      expect(followHook).toContain('container.addEventListener("touchmove"');
      expect(followHook).toContain('container.addEventListener("scroll"');
      expect(followHook).toContain("handleUserScroll");
      expect(followHook).toContain("setIsFollowing(false)");
    });

    it("guards programmatic smooth scrolling to prevent false disengagement", () => {
      expect(followHook).toContain("isProgrammaticScrollRef.current = true");
      expect(followHook).toContain("if (isProgrammaticScrollRef.current) return");
    });

    it("evaluates active word position against lower reading horizon", () => {
      expect(followHook).toContain('container.querySelector<HTMLElement>(\'[data-word-active="true"]\')');
      expect(followHook).toContain("wordRect.bottom > containerRect.bottom - BOTTOM_CLEARANCE_PX");
      expect(followHook).toContain("container.clientHeight * TARGET_VIEWPORT_FRACTION");
    });
  });

  describe("FollowButton component", () => {
    it("renders a high-contrast floating white pill", () => {
      expect(followButton).toContain("bg-white");
      expect(followButton).toContain("text-neutral-900");
      expect(followButton).toContain("rounded-full");
      expect(followButton).toContain("shadow-");
      expect(followButton).toContain("Follow");
    });

    it("supports accessible tooltip and aria-label", () => {
      expect(followButton).toContain('title="Scroll to current"');
      expect(followButton).toContain('aria-label="Scroll to current and resume follow mode"');
    });
  });

  describe("WorkbenchPanel integration", () => {
    it("accepts scrollRef and passes it to the scrollable container", () => {
      expect(workbenchPanel).toContain("scrollRef?: React.Ref<HTMLDivElement>");
      expect(workbenchPanel).toContain("ref={scrollRef}");
    });

    it("renders floating slot inside relative panel section", () => {
      expect(workbenchPanel).toContain("floating?: ReactNode");
      expect(workbenchPanel).toContain("{floating}");
      expect(workbenchPanel).toContain("relative");
    });
  });

  describe("NarrationPage reader integration", () => {
    it("wires useReaderFollow to the scrollContainerRef", () => {
      expect(narrationPage).toContain("useReaderFollow");
      expect(narrationPage).toContain("scrollContainerRef");
      expect(narrationPage).toContain("scrollRef={scrollContainerRef}");
    });

    it("renders FollowButton in floating slot positioned above audio player dock", () => {
      expect(narrationPage).toContain("<FollowButton onClick={scrollToCurrent} />");
      expect(narrationPage).toContain("bottom-[calc(var(--player-dock-height,6.5rem)+0.75rem)]");
    });
  });

  describe("Container queries for Details panel metadata", () => {
    it("defines .details-meta-container and .details-meta-grid in globals.css", () => {
      expect(globalsCss).toContain(".details-meta-container");
      expect(globalsCss).toContain("container-type: inline-size");
      expect(globalsCss).toContain("container-name: details-meta");
      expect(globalsCss).toContain(".details-meta-grid");
      expect(globalsCss).toContain("@container details-meta (max-width: 240px)");
    });

    it("wraps Voice and Made by in details-meta-container in NarrationSettings", () => {
      expect(narrationSettings).toContain('className="details-meta-container"');
      expect(narrationSettings).toContain("details-meta-grid");
      expect(narrationSettings).toContain("Made by");
      expect(narrationSettings).toContain("Voice");
    });
  });
});
