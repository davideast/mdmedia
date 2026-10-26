import assert from "node:assert/strict";
import { createElement } from "react";
import { createRequire } from "node:module";
const requireStudio = createRequire(
  new URL(
    "../../../studio/src/components/productions/assembly-view.tsx",
    import.meta.url,
  ),
);
// Root-only test installs may resolve the prerelease React dependency against a
// stable react-dom. Match the existing Studio SSR fixture compatibility shim.
const react = requireStudio("react");
const domVersion = requireStudio("react-dom/package.json").version;
if (react.version !== domVersion)
  Object.defineProperty(react, "version", {
    value: domVersion,
    configurable: true,
  });
const { renderToStaticMarkup } = requireStudio("react-dom/server");
import { AssemblyOutline } from "../../../studio/src/components/productions/assembly-view";
const document = {
  format: "mdmedia.assembly@1" as const,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [
    {
      id: "intro",
      title: "Show the problem",
      script: "Hello",
      visual: "Screen capture",
      notes: "",
    },
  ],
  tracks: [
    { id: "v", name: "Screen", type: "video" as const },
    { id: "a", name: "Narration", type: "audio" as const },
  ],
  placements: [
    { id: "screen", trackId: "v", assetId: "one", start: 0, in: 0, out: 4 },
    { id: "voice", trackId: "a", assetId: "two", start: 1, in: 0, out: 3 },
  ],
};
const html = renderToStaticMarkup(
  createElement(AssemblyOutline, { document, onSelect: () => {} }),
);
assert(html.includes("Show the problem"));
assert(!html.includes("Assembly tracks"));
assert(!html.includes("<video"));
assert(!html.includes("rounded-"));
console.log("PASS: untimed scenes, named tracks, placements, no draft player");

const { CutViewer } = await import("../../../studio/src/components/cut/cut-viewer");
const { TooltipProvider } = await import("../../../studio/src/components/ui/tooltip");
const { assemblyReviewTimeline } = await import("../../../src/assembly/review");
const viewer = renderToStaticMarkup(createElement(TooltipProvider, {}, createElement(CutViewer, {
  timeline: assemblyReviewTimeline(document, "Review"), assembly: document, title: "Review", video: "/fixture.mp4", thumbnail: () => null,
})));
for (const label of ["Timeline", "Timeline zoom", "Playhead time in seconds", "Enter fullscreen preview", "Screen", "Narration"]) assert(viewer.includes(label), label);
assert(!viewer.includes('aria-label="Scenes"'));
assert(!viewer.includes('controls=""'));
console.log("PASS: assembly uses the existing editor transport, preview and timeline without a scene list or native transport");
