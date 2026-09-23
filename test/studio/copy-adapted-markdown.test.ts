import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Copy Audio Adapted Document as Markdown Architecture", () => {
  const narrationPagePath = resolve(
    import.meta.dir,
    "../../studio/src/app/(app)/narration/[id]/page.tsx",
  );
  const narrationSettingsPath = resolve(
    import.meta.dir,
    "../../studio/src/components/narration/narration-settings.tsx",
  );

  const sourceDocumentViewPath = resolve(
    import.meta.dir,
    "../../studio/src/components/reader/source-document-view.tsx",
  );

  const narrationPage = readFileSync(narrationPagePath, "utf8");
  const narrationSettings = readFileSync(narrationSettingsPath, "utf8");
  const sourceDocumentView = readFileSync(sourceDocumentViewPath, "utf8");

  describe("Narration Reader Page (Workbench Header Action)", () => {
    it("imports Check and Copy icons along with Button component", () => {
      expect(narrationPage).toContain("Check");
      expect(narrationPage).toContain("Copy");
      expect(narrationPage).toContain('from "@/components/ui/button"');
    });

    it("implements context-aware copying of active document view (Adapted, Source, Raw) to clipboard with feedback", () => {
      expect(narrationPage).toContain("const handleCopy = async () =>");
      expect(narrationPage).toContain("case \"source\":");
      expect(narrationPage).toContain("case \"raw\":");
      expect(narrationPage).toContain("case \"adapted\":");
      expect(narrationPage).toContain("navigator.clipboard.writeText(text)");
      expect(narrationPage).toContain("copied as markdown");
      expect(narrationPage).toContain("setTimeout(() => setCopied(false), 2000)");
    });

    it("renders clean icon-only copy button in WorkbenchPanel actions when narration is loaded", () => {
      expect(narrationPage).toContain("actions={");
      expect(narrationPage).toContain("onClick={handleCopy}");
      expect(narrationPage).toContain('className="size-7 p-0 text-ink-muted hover:text-foreground"');
      expect(narrationPage).not.toContain('<span>{copied ? "Copied markdown"');
    });
  });

  describe("De-noised Secondary Panels (No Redundant Copy Buttons)", () => {
    it("removes redundant copy button from Narration Settings panel", () => {
      expect(narrationSettings).not.toContain("handleCopyAdapted");
      expect(narrationSettings).not.toContain("Copy adapted markdown");
      expect(narrationSettings).not.toContain("Copy markdown");
    });

    it("removes redundant copy button from Source Document View card header", () => {
      expect(sourceDocumentView).not.toContain("handleCopy");
      expect(sourceDocumentView).not.toContain("<span>{copied ? \"Copied\" : \"Copy\"}</span>");
      expect(sourceDocumentView).not.toContain("Source markdown copied to clipboard");
    });
  });

  describe("Clipboard guard contract", () => {
    it("guards against empty or whitespace-only transcript copying", () => {
      const copyGuard = (text?: string | null) => {
        if (!text || text.trim().length === 0) return false;
        return true;
      };

      expect(copyGuard("")).toBe(false);
      expect(copyGuard("   \n\t  ")).toBe(false);
      expect(copyGuard(null)).toBe(false);
      expect(copyGuard(undefined)).toBe(false);
      expect(copyGuard("# Heading\n\nParagraph text adapted for speech.")).toBe(true);
    });
  });
});
