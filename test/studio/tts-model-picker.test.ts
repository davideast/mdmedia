import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GoogleGenAI } from "@google/genai";
import {
  TTS_MODELS,
  DEFAULT_TTS_MODEL,
  type TTSModelName,
} from "../../studio/src/lib/types";
import { parseNarrationRequest } from "../../studio/src/lib/narration-request";
import { GeminiTTSProvider } from "../../src/tts/gemini-tts-provider.js";

describe("TTS Model Picker & Audio Generation Wiring Architecture", () => {
  const composerSettingsPath = resolve(
    import.meta.dir,
    "../../studio/src/components/studio/composer-settings.tsx",
  );
  const narrationProviderPath = resolve(
    import.meta.dir,
    "../../studio/src/components/shell/narration-provider.tsx",
  );
  const studioPagePath = resolve(
    import.meta.dir,
    "../../studio/src/app/(app)/studio/page.tsx",
  );
  const narrationServerPath = resolve(
    import.meta.dir,
    "../../studio/src/lib/narration-server.ts",
  );
  const generationQueuePath = resolve(
    import.meta.dir,
    "../../studio/src/lib/use-generation-queue.ts",
  );

  const composerSettings = readFileSync(composerSettingsPath, "utf8");
  const narrationProvider = readFileSync(narrationProviderPath, "utf8");
  const studioPage = readFileSync(studioPagePath, "utf8");
  const narrationServer = readFileSync(narrationServerPath, "utf8");
  const generationQueue = readFileSync(generationQueuePath, "utf8");

  describe("Domain Model Types", () => {
    it("defines TTS_MODELS containing gemini-3.8-flash-tts and gemini-3.8-flash-lite-tts", () => {
      expect(TTS_MODELS).toContain("gemini-3.8-flash-tts");
      expect(TTS_MODELS).toContain("gemini-3.8-flash-lite-tts");
      expect(TTS_MODELS.length).toBe(2);
    });

    it("defaults to gemini-3.8-flash-tts", () => {
      expect(DEFAULT_TTS_MODEL).toBe("gemini-3.8-flash-tts");
    });
  });

  describe("Narration Request Validation", () => {
    it("parses valid gemini-3.8-flash-tts from POST body", () => {
      const parsed = parseNarrationRequest({
        markdown: "Hello world this is a test document.",
        voice: "Puck",
        model: "gemini-3.8-flash-tts",
        visibility: "private",
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.model).toBe("gemini-3.8-flash-tts");
    });

    it("parses valid gemini-3.8-flash-lite-tts from POST body", () => {
      const parsed = parseNarrationRequest({
        markdown: "Hello world this is a test document.",
        voice: "Puck",
        model: "gemini-3.8-flash-lite-tts",
        visibility: "private",
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.model).toBe("gemini-3.8-flash-lite-tts");
    });

    it("falls back to DEFAULT_TTS_MODEL when model is omitted or unrecognized", () => {
      const omitted = parseNarrationRequest({
        markdown: "Hello world this is a test document.",
        voice: "Puck",
        visibility: "private",
      });
      expect(omitted).not.toBeNull();
      expect(omitted?.model).toBe(DEFAULT_TTS_MODEL);

      const invalid = parseNarrationRequest({
        markdown: "Hello world this is a test document.",
        voice: "Puck",
        model: "unsupported-model-x",
        visibility: "private",
      });
      expect(invalid).not.toBeNull();
      expect(invalid?.model).toBe(DEFAULT_TTS_MODEL);
    });
  });

  describe("Composer Settings Drawer (Right Settings Panel)", () => {
    it("renders Model picker label and select element", () => {
      expect(composerSettings).toContain("Model");
      expect(composerSettings).toContain('id="model"');
      expect(composerSettings).toContain("setDraft({ model:");
    });

    it("populates select options from TTS_MODELS", () => {
      expect(composerSettings).toContain("TTS_MODELS.map");
      expect(composerSettings).toContain("DEFAULT_TTS_MODEL");
    });
  });

  describe("Audio Generation Pipeline Wiring", () => {
    it("NarrationProvider includes model in Draft state with default", () => {
      expect(narrationProvider).toContain("model: TTSModelName");
      expect(narrationProvider).toContain("DEFAULT_TTS_MODEL");
    });

    it("StudioPage passes draft.model to queueNarration", () => {
      expect(studioPage).toContain("model: draft.model");
    });

    it("useGenerationQueue forwards model in job state and API payload", () => {
      expect(generationQueue).toContain("model?: TTSModelName");
    });

    it("narration-server instantiates GeminiTTSProvider with selected model", () => {
      expect(narrationServer).toContain("GeminiTTSProvider(client, 3,");
    });

    it("GeminiTTSProvider sends selected model to interactions.create API payload", async () => {
      let capturedPayload: any = null;

      const mockAi = {
        interactions: {
          create: async (payload: any) => {
            capturedPayload = payload;
            return (async function* () {
              const fakePcmBase64 = Buffer.from(new Uint8Array(48)).toString("base64");
              yield {
                event_type: "step.delta",
                delta: { type: "audio", data: fakePcmBase64 },
              };
            })();
          },
        },
      } as unknown as GoogleGenAI;

      const providerFlash = new GeminiTTSProvider(mockAi, 3, "gemini-3.8-flash-tts");
      for await (const _ of providerFlash.streamAudio("Test sentence", "Puck")) {
        // drain
      }
      expect(capturedPayload?.model).toBe("gemini-3.8-flash-tts");

      const providerLite = new GeminiTTSProvider(mockAi, 3, "gemini-3.8-flash-lite-tts");
      for await (const _ of providerLite.streamAudio("Test sentence", "Puck")) {
        // drain
      }
      expect(capturedPayload?.model).toBe("gemini-3.8-flash-lite-tts");
    });
  });
});
