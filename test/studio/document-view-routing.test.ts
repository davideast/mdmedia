import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocumentView } from "../../studio/src/components/shell/narration-provider";

/** Pure helper matching the routing resolution contract */
export function resolveDocumentViewFromParam(param: string | null | undefined): DocumentView {
  if (param === "source" || param === "raw" || param === "adapted") {
    return param;
  }
  return "adapted";
}

describe("Document View Routing State Architecture (?doc=adapted|source|raw)", () => {
  const providerPath = resolve(
    import.meta.dir,
    "../../studio/src/components/shell/narration-provider.tsx",
  );
  const narrationPagePath = resolve(
    import.meta.dir,
    "../../studio/src/app/(app)/narration/[id]/page.tsx",
  );

  const providerSource = readFileSync(providerPath, "utf8");
  const narrationPageSource = readFileSync(narrationPagePath, "utf8");

  describe("resolveDocumentViewFromParam contract", () => {
    it("resolves ?doc=adapted to adapted", () => {
      expect(resolveDocumentViewFromParam("adapted")).toBe("adapted");
    });

    it("resolves ?doc=source to source", () => {
      expect(resolveDocumentViewFromParam("source")).toBe("source");
    });

    it("resolves ?doc=raw to raw", () => {
      expect(resolveDocumentViewFromParam("raw")).toBe("raw");
    });

    it("falls back to adapted when query param is omitted or invalid", () => {
      expect(resolveDocumentViewFromParam(null)).toBe("adapted");
      expect(resolveDocumentViewFromParam(undefined)).toBe("adapted");
      expect(resolveDocumentViewFromParam("")).toBe("adapted");
      expect(resolveDocumentViewFromParam("unknown")).toBe("adapted");
      expect(resolveDocumentViewFromParam("rendered")).toBe("adapted");
    });
  });

  describe("NarrationProvider URL State Synchronization", () => {
    it("initializes documentView state from window.location.search on first load", () => {
      expect(providerSource).toContain("URLSearchParams");
      expect(providerSource).toContain('.get("doc")');
    });

    it("synchronizes setDocumentView to the URL query param via replaceState", () => {
      expect(providerSource).toContain('url.searchParams.set("doc", view)');
      expect(providerSource).toContain("window.history.replaceState");
    });

    it("listens for popstate events to keep documentView in sync with browser navigation", () => {
      expect(providerSource).toContain('"popstate"');
      expect(providerSource).toContain('addEventListener("popstate"');
      expect(providerSource).toContain('removeEventListener("popstate"');
    });

    it("preserves URL query param when stream.id resolves to prevent clobbering active tab on reload", () => {
      // Must not unconditionally setDocumentView("adapted") without checking doc param
      const streamIdEffectBlock = providerSource.slice(
        providerSource.indexOf("lastStreamIdRef.current = stream.id;"),
        providerSource.indexOf("lastStreamIdRef.current = stream.id;") + 300,
      );
      expect(streamIdEffectBlock).toContain(".get(\"doc\")");
    });
  });

  describe("Narration Page Routing Integration", () => {
    it("subscribes to Next.js searchParams to sync ?doc navigation", () => {
      expect(narrationPageSource).toContain("useSearchParams");
      expect(narrationPageSource).toContain('.get("doc")');
    });
  });
});
