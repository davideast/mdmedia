import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HEADING_INSTRUCTIONS } from "../../studio/src/lib/types";
import { HEADING_GENERATION_NARRATION_PROMPT } from "../../src/narration/system-instructions";
import { parseNarrationRequest } from "../../studio/src/lib/narration-server";

describe("Composer Custom Instructions for Audio Adaptation", () => {
  const composerSettingsPath = resolve(
    import.meta.dir,
    "../../studio/src/components/studio/composer-settings.tsx",
  );
  const narrationServerPath = resolve(
    import.meta.dir,
    "../../studio/src/lib/narration-server.ts",
  );
  const studioPagePath = resolve(
    import.meta.dir,
    "../../studio/src/app/(app)/studio/page.tsx",
  );

  const composerSettings = readFileSync(composerSettingsPath, "utf8");
  const narrationServer = readFileSync(narrationServerPath, "utf8");
  const studioPage = readFileSync(studioPagePath, "utf8");

  describe("Default Heading Instructions Constant", () => {
    it("DEFAULT_HEADING_INSTRUCTIONS matches HEADING_GENERATION_NARRATION_PROMPT content", () => {
      expect(DEFAULT_HEADING_INSTRUCTIONS).toContain("Document Headings & Section Structure:");
      expect(DEFAULT_HEADING_INSTRUCTIONS).toContain("Organize the narrated script using clear, concise Markdown headings");
      expect(DEFAULT_HEADING_INSTRUCTIONS).toContain("synthesize descriptive # and ## section headings");
      expect(HEADING_GENERATION_NARRATION_PROMPT).toContain("Document Headings & Section Structure:");
    });
  });

  describe("Composer Settings Panel (Right Panel UI)", () => {
    it("renders Custom instructions textarea with DEFAULT_HEADING_INSTRUCTIONS placeholder when rewriteForNarration is true", () => {
      expect(composerSettings).toContain("draft.rewriteForNarration ?");
      expect(composerSettings).toContain("Custom instructions");
      expect(composerSettings).toContain('id="rewrite-instructions"');
      expect(composerSettings).toContain("placeholder={DEFAULT_HEADING_INSTRUCTIONS}");
      expect(composerSettings).toContain("draft.rewriteInstructions");
      expect(composerSettings).toContain("setDraft({ rewriteInstructions: event.target.value })");
    });

    it("wires rewriteInstructions into studio submission payload", () => {
      expect(studioPage).toContain("rewriteInstructions: draft.rewriteInstructions?.trim() || undefined");
    });
  });

  describe("Server Request Validation & Prompt Composition", () => {
    it("parses valid rewriteInstructions from POST body", () => {
      const parsed = parseNarrationRequest({
        markdown: "# Test Heading\n\nSome body content for synthesis.",
        voice: "Puck",
        promptStyle: "Warm, unhurried narration.",
        rewriteForNarration: true,
        rewriteInstructions: "Focus on concise executive summary. Avoid technical jargon.",
        visibility: "private",
      });

      expect(parsed).not.toBeNull();
      expect(parsed?.rewriteInstructions).toBe(
        "Focus on concise executive summary. Avoid technical jargon.",
      );
    });

    it("normalizes empty or whitespace-only rewriteInstructions to undefined", () => {
      const parsed = parseNarrationRequest({
        markdown: "# Test Heading\n\nSome body content for synthesis.",
        voice: "Puck",
        promptStyle: "Warm, unhurried narration.",
        rewriteForNarration: true,
        rewriteInstructions: "   \n\t  ",
        visibility: "private",
      });

      expect(parsed).not.toBeNull();
      expect(parsed?.rewriteInstructions).toBeUndefined();
    });

    it("uses custom instructions when provided, falling back to HEADING_GENERATION_NARRATION_PROMPT when omitted", () => {
      expect(narrationServer).toContain("const adaptationInstructions =");
      expect(narrationServer).toContain("request.rewriteInstructions?.trim() || HEADING_GENERATION_NARRATION_PROMPT");
    });
  });
});
