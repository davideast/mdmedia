import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Modern CSS Grid & Named Alignment Track Architecture (intrinsic-ui-craft)", () => {
  const globalsCssPath = resolve(import.meta.dir, "../../studio/src/app/globals.css");
  const workbenchPanelPath = resolve(import.meta.dir, "../../studio/src/components/shell/workbench-panel.tsx");
  const libraryPagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/library/page.tsx");
  const queuePagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/queue/page.tsx");
  const narrationPagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/narration/[id]/page.tsx");
  const settingsPagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/settings/page.tsx");
  const playlistsPagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/playlists/page.tsx");

  const globalsCss = readFileSync(globalsCssPath, "utf8");
  const workbenchPanel = readFileSync(workbenchPanelPath, "utf8");
  const directory = readFileSync(resolve(import.meta.dir, "../../studio/src/components/media/media-directory.tsx"), "utf8");
  const libraryPage = directory + readFileSync(libraryPagePath, "utf8") + readFileSync(resolve(import.meta.dir, "../../studio/src/components/media/narration-library-entry.tsx"), "utf8");
  const queuePage = directory + readFileSync(queuePagePath, "utf8") + readFileSync(resolve(import.meta.dir, "../../studio/src/components/media/local-narration-activity.tsx"), "utf8");
  const narrationPage = readFileSync(narrationPagePath, "utf8");
  const settingsPage = readFileSync(settingsPagePath, "utf8");
  const playlistsPage = readFileSync(playlistsPagePath, "utf8");

  describe("globals.css named tracks & zero padding/margin invariant", () => {
    it("defines .view-grid with named column tracks [full-start], [wide-start], [content-start], [content-end], [wide-end], [full-end]", () => {
      expect(globalsCss).toContain("[full-start]");
      expect(globalsCss).toContain("wide-start");
      expect(globalsCss).toContain("content-start");
      expect(globalsCss).toContain("content-end");
      expect(globalsCss).toContain("wide-end");
      expect(globalsCss).toContain("[full-end]");
    });

    it("defines .view-grid with named row gutter tracks [gutter-top], [view-content], [gutter-bottom]", () => {
      expect(globalsCss).toContain("[gutter-top]");
      expect(globalsCss).toContain("[view-content]");
      expect(globalsCss).toContain("[gutter-bottom]");
    });

    it("enforces padding: 0 and margin: 0 on .view-grid and .view-grid-body", () => {
      // In CSS, view-grid and view-grid-body must have 0 padding and margin to prevent nudge layout
      expect(globalsCss).toMatch(/\.view-grid\s*\{[^}]*padding:\s*0/);
      expect(globalsCss).toMatch(/\.view-grid\s*\{[^}]*margin:\s*0/);
      expect(globalsCss).toMatch(/\.view-grid-body\s*\{[^}]*padding:\s*0/);
      expect(globalsCss).toMatch(/\.view-grid-body\s*\{[^}]*margin:\s*0/);
    });

    it("defines .item-track-grid with named tracks [status-start], [text-start], [action-start]", () => {
      expect(globalsCss).toContain("[status-start]");
      expect(globalsCss).toContain("status-end");
      expect(globalsCss).toContain("text-start");
      expect(globalsCss).toContain("text-end");
      expect(globalsCss).toContain("action-start");
      expect(globalsCss).toContain("[action-end]");
    });
  });

  describe("WorkbenchPanel layout discipline", () => {
    it("supports viewGrid and gridVariant props", () => {
      expect(workbenchPanel).toContain("viewGrid = false");
      expect(workbenchPanel).toContain('gridVariant = "content"');
    });

    it("aligns the panel header to the named column tracks when viewGrid is true", () => {
      expect(workbenchPanel).toContain("[content-start]");
      expect(workbenchPanel).toContain("col-start-[content-start] col-end-[content-end]");
    });

    it("renders .view-grid and .view-grid-body inside the scrollable container when viewGrid is true", () => {
      expect(workbenchPanel).toContain('className={cn("view-grid"');
      expect(workbenchPanel).toContain('className={cn(\n                "view-grid-body"');
    });
  });

  describe("View and item alignment across pages (zero nudging)", () => {
    it("LibraryPage uses viewGrid and does not use px-8 py-8 or mx-auto centering wrappers", () => {
      expect(libraryPage).toContain('viewGrid gridVariant="wide"');
      expect(libraryPage).not.toContain('bodyClassName="px-8 py-8"');
      expect(libraryPage).not.toContain("mx-auto grid w-full max-w-[68ch]");
    });

    it("Library uses paginated mixed media and does not reference undefined chunksCount", () => {
      expect(libraryPage).toContain("Media type");
      expect(libraryPage).toContain("page?.nextCursor");
      expect(libraryPage).not.toContain("chunksCount");
    });

    it("LibraryNarrationCard separates the title, details, tools, and primary action into aligned grid areas", () => {
      expect(libraryPage).toContain("library-track-card");
      expect(libraryPage).toContain("library-track-status");
      expect(libraryPage).toContain("library-track-title");
      expect(libraryPage).toContain("library-track-details");
      expect(libraryPage).toContain("library-track-tools");
      expect(libraryPage).toContain("library-track-primary");
      expect(libraryPage).not.toContain("pl-5.5");
      expect(libraryPage).not.toContain("pl-5");
    });

    it("QueuePage uses viewGrid and does not use px-8 py-8 or mx-auto centering wrappers", () => {
      expect(queuePage).toContain('kind === \'library\' ? \'Library\' : \'Activity\'');
      expect(queuePage).not.toContain('bodyClassName="px-8 py-8"');
      expect(queuePage).toContain('viewGrid gridVariant="wide"');
      expect(queuePage).not.toContain("mx-auto grid w-full max-w-[68ch]");
    });

    it("Queue job cards use item-track-grid and do NOT use pl-5 ad-hoc nudging", () => {
      expect(queuePage).toContain("item-track-grid");
      expect(queuePage).toContain("track-status");
      expect(queuePage).toContain("track-title");
      expect(queuePage).toContain("track-body");
      expect(queuePage).toContain("track-actions");
      expect(queuePage).not.toContain("pl-5");
      expect(queuePage).not.toContain("pl-5.5");
    });

    it("NarrationPage uses viewGrid with gridVariant='reader' without px-8 pt-10 pb-40 or mx-auto", () => {
      expect(narrationPage).toContain('viewGrid\n      gridVariant="reader"');
      expect(narrationPage).not.toContain('bodyClassName="px-8 pt-10 pb-40');
      expect(narrationPage).not.toContain('headerClassName="px-8"');
      expect(narrationPage).not.toContain("mx-auto w-full max-w-[68ch]");
    });

    it("SettingsPage and PlaylistsPage use viewGrid with gridVariant='wide' without outer padding wrappers", () => {
      expect(settingsPage).toMatch(/viewGrid\s+gridVariant="wide"/);
      expect(settingsPage).not.toContain("mx-auto grid w-full max-w-[52rem] gap-8 p-8");
      expect(playlistsPage).toMatch(/viewGrid\s+gridVariant="wide"/);
      expect(playlistsPage).not.toContain("grid gap-6 p-6 pb-28");
    });
  });
});
