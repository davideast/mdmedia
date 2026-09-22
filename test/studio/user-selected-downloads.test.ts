import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isNarrationOffline,
  isNarrationDownloading,
  downloadNarration,
  removeOfflineNarration,
  subscribeOfflineChange,
} from "../../studio/src/lib/offline-manager";
import { getMediaStore } from "../../studio/src/lib/media-store";
import type { NarrationTimingsFile } from "../../studio/src/lib/wav";

describe("User-Selected Downloads (intrinsic-ui-craft)", () => {
  const useNarrationStreamPath = resolve(import.meta.dir, "../../studio/src/lib/use-narration-stream.ts");
  const libraryPagePath = resolve(import.meta.dir, "../../studio/src/app/(app)/library/page.tsx");
  const narrationSettingsPath = resolve(import.meta.dir, "../../studio/src/components/narration/narration-settings.tsx");
  const narrationsPath = resolve(import.meta.dir, "../../studio/src/lib/narrations.ts");

  describe("Automatic Cache Decoupling in useNarrationStream", () => {
    it("checks mediaStore for existing offline tracks when loading", () => {
      const streamCode = readFileSync(useNarrationStreamPath, "utf8");
      expect(streamCode).toContain("mediaStore.getTrack(narrationId)");
    });

    it("does NOT automatically save network-streamed tracks to mediaStore upon playback completion", () => {
      const streamCode = readFileSync(useNarrationStreamPath, "utf8");
      // Transient network playback must not write to OPFS silently
      expect(streamCode).not.toContain("if (isFinal) {\n            const saveTimings: NarrationTimingsFile");
      expect(streamCode).not.toMatch(/if\s*\(isFinal\)\s*\{\s*[^}]*mediaStore\.saveTrack/);
    });
  });

  describe("Explicit Offline Manager Service", () => {
    const testId = "user-selected-test-123";
    const sampleTimings: NarrationTimingsFile = {
      version: 1,
      title: "User Selected Narration",
      transcript: "This was downloaded by user request.",
      voice: "Kore",
      sampleRate: 24000,
      durationMs: 2500,
      chunks: [],
    };
    const sampleWavBytes = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);

    beforeEach(async () => {
      await getMediaStore().delete(testId);
    });

    it("reports false when narration has not been selected for download", async () => {
      const isOffline = await isNarrationOffline(testId);
      expect(isOffline).toBe(false);
      expect(isNarrationDownloading(testId)).toBe(false);
    });

    it("explicitly downloads, tracks downloading state, and stores narration", async () => {
      const originalFetch = globalThis.fetch;
      let resolveAudioFetch: (res: Response) => void;
      const audioPromise = new Promise<Response>((resolve) => {
        resolveAudioFetch = resolve;
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("/audio")) {
          return await audioPromise;
        }
        if (urlStr.includes("/timings")) {
          return new Response(JSON.stringify(sampleTimings), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      try {
        const events: Array<{ id: string; offline: boolean; downloading: boolean }> = [];
        const unsub = subscribeOfflineChange((id, offline, downloading) => {
          events.push({ id, offline, downloading });
        });

        const downloadTask1 = downloadNarration(testId, { title: "User Selected Narration" });
        const downloadTask2 = downloadNarration(testId, { title: "User Selected Narration" });

        // Deduplication: both should return the same in-flight promise
        expect(downloadTask1).toBe(downloadTask2);
        expect(isNarrationDownloading(testId)).toBe(true);

        // Resolve audio
        resolveAudioFetch!(new Response(sampleWavBytes, { status: 200, headers: { "Content-Type": "audio/wav" } }));
        await downloadTask1;

        expect(await isNarrationOffline(testId)).toBe(true);
        expect(isNarrationDownloading(testId)).toBe(false);

        const track = await getMediaStore().getTrack(testId);
        expect(track).not.toBeNull();
        expect(track?.timings.title).toBe("User Selected Narration");

        expect(events).toEqual([
          { id: testId, offline: false, downloading: true },
          { id: testId, offline: true, downloading: false },
        ]);

        unsub();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("removes downloaded narration and notifies subscribers when removeOfflineNarration is invoked", async () => {
      // Pre-save track
      await getMediaStore().saveTrack(testId, new Blob([sampleWavBytes]), sampleTimings);
      expect(await isNarrationOffline(testId)).toBe(true);

      let notified = false;
      const unsub = subscribeOfflineChange((id, offline, downloading) => {
        if (id === testId && !offline && !downloading) notified = true;
      });

      await removeOfflineNarration(testId);
      expect(await isNarrationOffline(testId)).toBe(false);
      expect(notified).toBe(true);

      unsub();
    });

    it("deleteNarration cleans up OPFS via removeOfflineNarration to notify subscribers", () => {
      const code = readFileSync(narrationsPath, "utf8");
      expect(code).toContain("removeOfflineNarration");
      expect(code).toContain("await removeOfflineNarration(id)");
    });
  });

  describe("UI Integration for User-Selected Downloads", () => {
    it("LibraryNarrationCard gates download control behind ready status and renders offline indicator", () => {
      const libraryCode = readFileSync(libraryPagePath, "utf8");
      expect(libraryCode).toContain("useOfflineStatus");
      expect(libraryCode).toContain("isReady");
      expect(libraryCode).toContain("Download for offline");
    });

    it("NarrationSettings renders dedicated Offline Storage section with download/remove actions and ready guard", () => {
      const settingsCode = readFileSync(narrationSettingsPath, "utf8");
      expect(settingsCode).toContain("useOfflineStatus");
      expect(settingsCode).toContain("Offline storage");
      expect(settingsCode).toContain("disabled={isDownloading || !isReady}");
      expect(settingsCode).toContain("Download for offline");
      expect(settingsCode).toContain("Remove download");
    });
  });
});
