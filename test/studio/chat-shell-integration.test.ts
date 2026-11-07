import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getActiveChatSurfaceHandlers,
  readSnapshotWithLivePlayhead,
  registerChatViewPublisher,
  resetChatContextBridgeForTests,
  seekActiveChatSurface,
  unregisterChatViewPublisher,
} from "../../studio/src/lib/chat-context-bridge";
import { formatActiveViewPillLabel } from "../../studio/src/lib/chat/types";

const studioSrc = resolve(import.meta.dir, "../../studio/src");
const read = (relPath: string) => readFileSync(resolve(studioSrc, relPath), "utf8");

describe("Studio Contextual Chat — Shell & Surface Bridge Integration", () => {
  beforeEach(() => {
    resetChatContextBridgeForTests();
  });

  describe("ChatContextBridge lifecycle, stack precedence, and live handlers", () => {
    it("registers and unregisters publishers with nested stack precedence", () => {
      const outerId = Symbol("outer-library");
      const innerId = Symbol("inner-analysis");

      expect(readSnapshotWithLivePlayhead()).toBeNull();

      registerChatViewPublisher(outerId, {
        surface: "library",
        route: "/library",
        activeFilter: "videos",
      });
      expect(readSnapshotWithLivePlayhead()).toEqual({
        surface: "library",
        route: "/library",
        activeFilter: "videos",
      });

      registerChatViewPublisher(innerId, {
        surface: "analysis",
        route: "/analysis/anl_42",
        itemId: "anl_42",
        title: "Keynote Breakdown",
        status: "ready",
      });
      expect(readSnapshotWithLivePlayhead()?.surface).toBe("analysis");

      // Unregistering inner publisher restores outer publisher on top of stack
      unregisterChatViewPublisher(innerId);
      expect(readSnapshotWithLivePlayhead()).toEqual({
        surface: "library",
        route: "/library",
        activeFilter: "videos",
      });

      // Passing null snapshot also removes publisher cleanly
      registerChatViewPublisher(outerId, null);
      expect(readSnapshotWithLivePlayhead()).toBeNull();
    });

    it("reads dynamic playhead via getPlayheadSeconds() without re-registering snapshots", () => {
      const pubId = Symbol("analysis-player");
      let currentVideoTime = 12.4;

      registerChatViewPublisher(
        pubId,
        {
          surface: "analysis",
          route: "/analysis/anl_99",
          itemId: "anl_99",
          title: "Launch Demo",
          status: "ready",
          sourceVideoId: "vid_1",
        },
        {
          getPlayheadSeconds: () => currentVideoTime,
        },
      );

      const firstRead = readSnapshotWithLivePlayhead();
      expect(firstRead).toEqual({
        surface: "analysis",
        route: "/analysis/anl_99",
        itemId: "anl_99",
        title: "Launch Demo",
        status: "ready",
        sourceVideoId: "vid_1",
        playheadSeconds: 12.4,
      });
      expect(formatActiveViewPillLabel(firstRead)).toBe("Analysis · Launch Demo · 00:12");

      // Advance playhead without touching registerChatViewPublisher
      currentVideoTime = 84.9;
      const secondRead = readSnapshotWithLivePlayhead();
      expect(secondRead?.surface).toBe("analysis");
      if (secondRead?.surface === "analysis") {
        expect(secondRead.playheadSeconds).toBe(84.9);
      }
      expect(formatActiveViewPillLabel(secondRead)).toBe("Analysis · Launch Demo · 01:24");
    });

    it("routes seekActiveChatSurface(84, true) and imperative handlers to the active publisher", () => {
      expect(seekActiveChatSurface(84, true)).toBe(false);

      const pubId = Symbol("video-surface");
      const calls: Array<{ seconds: number; play?: boolean }> = [];

      registerChatViewPublisher(
        pubId,
        {
          surface: "video",
          route: "/video/vid_77",
          itemId: "vid_77",
          title: "Ocean Aerial",
          status: "ready",
        },
        {
          seek: (seconds, play) => {
            calls.push({ seconds, play });
          },
        },
      );

      expect(seekActiveChatSurface(84, true)).toBe(true);
      expect(calls).toEqual([{ seconds: 84, play: true }]);

      unregisterChatViewPublisher(pubId);
      expect(seekActiveChatSurface(30, false)).toBe(false);
    });

    it("exposes tree-doc imperative handlers (scrollToHeading, insertMarkdown) for active documents", () => {
      const docPub = Symbol("tree-doc-surface");
      const scrolled: string[] = [];
      const inserted: string[] = [];

      registerChatViewPublisher(
        docPub,
        {
          surface: "tree-doc",
          route: "/trees/tr_1/architecture.md?node=n_1",
          treeId: "tr_1",
          docId: "doc_1",
          docPath: "architecture.md",
          docTitle: "Architecture",
          activeHeading: "Overview",
          selectionExcerpt: "Event-sourced projections",
        },
        {
          scrollToHeading: (h) => scrolled.push(h),
          insertMarkdown: (md) => inserted.push(md),
        },
      );

      const handlers = getActiveChatSurfaceHandlers();
      handlers.scrollToHeading?.("Storage Layer");
      handlers.insertMarkdown?.("![Diagram](mdmedia://image/img_1)");

      expect(scrolled).toEqual(["Storage Layer"]);
      expect(inserted).toEqual(["![Diagram](mdmedia://image/img_1)"]);
    });
  });

  describe("Shell architecture & zero-noise layout invariants", () => {
    it("mounts ChatProvider inside MediaActivityProvider wrapping AppShell in app-frame.tsx", () => {
      const appFrame = read("components/shell/app-frame.tsx");
      expect(appFrame).toContain('import { ChatProvider } from "@/components/chat/chat-provider"');
      const mediaIdx = appFrame.indexOf("<MediaActivityProvider>");
      const chatIdx = appFrame.indexOf("<ChatProvider>");
      const shellIdx = appFrame.indexOf("<AppShell");
      expect(mediaIdx).toBeGreaterThan(-1);
      expect(chatIdx).toBeGreaterThan(mediaIdx);
      expect(shellIdx).toBeGreaterThan(chatIdx);
    });

    it("computes showRightColumn = hasContext || chatOpen, expands media routes, and registers ChatShellAdapter in app-shell.tsx", () => {
      const appShell = read("components/shell/app-shell.tsx");
      expect(appShell).toContain("const showRightColumn = hasContext || chatOpen;");
      expect(appShell).toContain('pathname.startsWith("/studio/")');
      expect(appShell).toContain('pathname.startsWith("/analysis/")');
      expect(appShell).toContain('pathname.startsWith("/video/")');
      expect(appShell).toContain('pathname.startsWith("/image/")');
      expect(appShell).toContain('pathname.startsWith("/music/")');
      expect(appShell).toContain("registerShellAdapter");
      expect(appShell).toContain("expandRightPanel:");
      expect(appShell).toContain("collapseRightPanel:");
      expect(appShell).toContain("isRightPanelExpanded:");
      // Docked 56px rail only renders when hasContext is true (never on /library when chat closes)
      expect(appShell).toContain("hasContext && contextDocked && !breakpoints.isTablet && !breakpoints.isMobile");
    });

    it("renders ChatPanel in chat mode and preserves KeepSection + Open chat header action in context-panel.tsx", () => {
      const contextPanel = read("components/shell/context-panel.tsx");
      expect(contextPanel).toContain('import { ChatPanel } from "@/components/chat/chat-panel"');
      expect(contextPanel).toContain("<ChatPanel");
      expect(contextPanel).toContain("<KeepSection");
      expect(contextPanel).toContain("Open chat (⌘J)");
      expect(contextPanel).toContain('aria-label="Chat"');
    });

    it("exposes quiet Chat (⌘J) triggers in NavRail and TreeExplorer", () => {
      const navRail = read("components/shell/nav-rail.tsx");
      expect(navRail).toContain("useOptionalChat");
      expect(navRail).toContain("chat.toggleChat()");
      expect(navRail).toContain("Chat (⌘J)");
      expect(navRail).toContain("⌘J");

      const treeExplorer = read("components/tree/tree-explorer.tsx");
      expect(treeExplorer).toContain("useOptionalChat");
      expect(treeExplorer).toContain("chat.toggleChat()");
    });
  });

  describe("Surface ambient context publishers", () => {
    it("wires usePublishChatViewContext across analysis, tree-doc, video, image, music, narration, composer, and cut surfaces", () => {
      const analysisEditor = read("components/media/analysis-editor.tsx");
      expect(analysisEditor).toContain("usePublishChatViewContext");
      expect(analysisEditor).toContain("surface: 'analysis'");
      expect(analysisEditor).toContain("getPlayheadSeconds:");

      const treeDocReader = read("components/reader/tree-document-reader.tsx");
      expect(treeDocReader).toContain("usePublishChatViewContext");
      expect(treeDocReader).toContain('surface: "tree-doc"');
      expect(treeDocReader).toContain("STUDIO_MUTATION_EVENT");
      expect(treeDocReader).toContain("selectionchange");
      expect(treeDocReader).toContain("scrollToHeading:");
      expect(treeDocReader).toContain("insertMarkdown:");

      const videoEditor = read("components/media/video-editor.tsx");
      expect(videoEditor).toContain("usePublishChatViewContext");
      expect(videoEditor).toContain("surface: 'video'");

      const imageEditor = read("components/media/image-editor.tsx");
      expect(imageEditor).toContain("usePublishChatViewContext");
      expect(imageEditor).toContain("surface: 'image'");

      const musicEditor = read("components/media/music-editor.tsx");
      expect(musicEditor).toContain("usePublishChatViewContext");
      expect(musicEditor).toContain("surface: 'music'");

      const narrationPage = read("app/(app)/narration/[id]/page.tsx");
      expect(narrationPage).toContain("usePublishChatViewContext");
      expect(narrationPage).toContain('surface: "narration"');

      const studioPage = read("app/(app)/studio/page.tsx");
      expect(studioPage).toContain("usePublishChatViewContext");
      expect(studioPage).toContain('surface: "composer"');
      expect(studioPage).toContain("patchComposerDraft:");

      const cutViewer = read("components/cut/cut-viewer.tsx");
      expect(cutViewer).toContain("usePublishChatViewContext");
      expect(cutViewer).toContain("surface: 'cut'");
    });
  });
});
