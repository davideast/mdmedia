import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocumentView } from "../../studio/src/components/shell/narration-provider";

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

  describe("parseDocumentView parser contract", () => {
    it("resolves ?doc=adapted to adapted", () => {
      expect(parseDocumentView("adapted")).toBe("adapted");
    });

    it("resolves ?doc=source to source", () => {
      expect(parseDocumentView("source")).toBe("source");
    });

    it("resolves ?doc=raw to raw", () => {
      expect(parseDocumentView("raw")).toBe("raw");
    });

    it("falls back to adapted when query param is omitted or invalid", () => {
      expect(parseDocumentView(null)).toBe("adapted");
      expect(parseDocumentView(undefined)).toBe("adapted");
      expect(parseDocumentView("")).toBe("adapted");
      expect(parseDocumentView("unknown")).toBe("adapted");
      expect(parseDocumentView("rendered")).toBe("adapted");
    });
  });

  describe("NarrationProvider URL State Synchronization", () => {
    it("initializes documentView state from window.location.search on first load using parseDocumentView", () => {
      expect(providerSource).toContain("URLSearchParams");
      expect(providerSource).toContain("parseDocumentView(urlDoc)");
    });

    it("synchronizes setDocumentView to the URL query param via replaceState", () => {
      expect(providerSource).toContain('url.searchParams.set("doc", view)');
      expect(providerSource).toContain('url.searchParams.delete("doc")');
      expect(providerSource).toContain("window.history.replaceState");
    });

    it("listens for popstate events to keep documentView in sync with browser navigation", () => {
      expect(providerSource).toContain('"popstate"');
      expect(providerSource).toContain('addEventListener("popstate"');
      expect(providerSource).toContain('removeEventListener("popstate"');
    });

    it("preserves URL query param when stream.id resolves to prevent clobbering active tab on reload", () => {
      const streamIdEffectBlock = providerSource.slice(
        providerSource.indexOf("lastStreamIdRef.current = stream.id;"),
        providerSource.indexOf("lastStreamIdRef.current = stream.id;") + 300,
      );
      expect(streamIdEffectBlock).toContain(".get(\"doc\")");
    });
  });

  describe("Narration Page Routing Integration & Zero Layout Shift", () => {
    it("synchronously computes activeDocumentView from searchParams to prevent layout shift on reload", () => {
      expect(narrationPageSource).toContain("useSearchParams");
      expect(narrationPageSource).toContain('searchParams.get("doc")');
      expect(narrationPageSource).toContain("const activeDocumentView = docParam ? parseDocumentView(docParam) : documentView;");
    });

    it("synchronizes context state with updateUrl: false to avoid history clobbering", () => {
      expect(narrationPageSource).toContain("setDocumentView(parseDocumentView(docParam), { updateUrl: false })");
      expect(narrationPageSource).toContain('setDocumentView("adapted", { updateUrl: false })');
    });

    it("renders document body based on activeDocumentView projection", () => {
      expect(narrationPageSource).toContain('activeDocumentView === "source" || activeDocumentView === "raw"');
    });
  });
});
