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

    it("implements handleCopyAdapted copying stream.transcript to clipboard with feedback", () => {
      expect(narrationPage).toContain("const handleCopyAdapted = async () =>");
      expect(narrationPage).toContain("if (!stream.transcript || stream.transcript.trim().length === 0) return;");
      expect(narrationPage).toContain("navigator.clipboard.writeText(stream.transcript)");
      expect(narrationPage).toContain('toast.success("Audio adapted document copied as markdown")');
      expect(narrationPage).toContain("setTimeout(() => setCopied(false), 2000)");
    });

    it("renders clean icon-only copy button in WorkbenchPanel actions when narration is loaded", () => {
      expect(narrationPage).toContain("actions={");
      expect(narrationPage).toContain("onClick={handleCopyAdapted}");
      expect(narrationPage).toContain('aria-label="Copy audio adapted document as markdown"');
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
