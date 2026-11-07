import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { createElement, type ReactElement } from "react";
import {
  extractLeadingSlashCommand,
  filterSlashCommands,
} from "../../studio/src/lib/chat/slash-commands";
import {
  CHAT_EFFORT_LEVELS,
  CHAT_MODELS,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  formatActiveViewPillLabel,
  formatChatSelectorLabel,
  formatClockSeconds,
  isChatEffortLevel,
  isChatModelName,
  orderChatResultParts,
  type ChatResultPart,
} from "../../studio/src/lib/chat/types";
import { readSettings } from "../../studio/src/lib/settings";
import { ChatThoughtDisclosure } from "../../studio/src/components/chat/chat-thought-disclosure";
import {
  ChatMarkdown,
  parseChatMediaLink,
  tokenizeInlineChatSegments,
} from "../../studio/src/components/chat/chat-markdown";
import { visibleStreamingResultParts } from "../../studio/src/components/chat/chat-panel";

const studioReactDomServer = resolve(
  import.meta.dir,
  "../../studio/node_modules/react-dom/server.js",
);
if (!existsSync(studioReactDomServer)) {
  const req = createRequire(import.meta.url);
  const reactDomPkg = req("react-dom/package.json") as { version?: string };
  if (reactDomPkg.version && React.version !== reactDomPkg.version) {
    Object.defineProperty(React, "version", {
      value: reactDomPkg.version,
      configurable: true,
      writable: true,
    });
  }
}
const { renderToStaticMarkup } = (await import(
  existsSync(studioReactDomServer)
    ? "../../studio/node_modules/react-dom/server"
    : "react-dom/server"
)) as {
  renderToStaticMarkup: (element: ReactElement) => string;
};

describe("Slash commands filtering & extraction", () => {
  it("ranks prefix matches ahead of summary keyword matches", () => {
    const all = filterSlashCommands("");
    expect(all.length).toBe(10);

    const anMatches = filterSlashCommands("/an");
    expect(anMatches[0]?.command).toBe("analyze");

    const vidMatches = filterSlashCommands("video");
    expect(vidMatches[0]?.command).toBe("video");
    expect(vidMatches.some((entry) => entry.command === "analyze")).toBe(true);
  });

  it("extracts leading /command tokens and preserves remaining prompt text", () => {
    const parsed = extractLeadingSlashCommand("/analyze find every slide transition");
    expect(parsed.slashCommand?.command).toBe("analyze");
    expect(parsed.remainingText).toBe("find every slide transition");

    const bareCommand = extractLeadingSlashCommand("/new");
    expect(bareCommand.slashCommand?.command).toBe("new");
    expect(bareCommand.remainingText).toBe("");

    const unknown = extractLeadingSlashCommand("/nonexistent hello");
    expect(unknown.slashCommand).toBeNull();
    expect(unknown.remainingText).toBe("/nonexistent hello");

    const plainText = extractLeadingSlashCommand("Explain 01:24 in this clip");
    expect(plainText.slashCommand).toBeNull();
    expect(plainText.remainingText).toBe("Explain 01:24 in this clip");
  });
});

describe("formatClockSeconds & formatActiveViewPillLabel across Studio surfaces", () => {
  it("formats sub-hour and multi-hour timestamps cleanly", () => {
    expect(formatClockSeconds(null)).toBeNull();
    expect(formatClockSeconds(-3)).toBeNull();
    expect(formatClockSeconds(0)).toBe("00:00");
    expect(formatClockSeconds(84.7)).toBe("01:24");
    expect(formatClockSeconds(3723)).toBe("1:02:03");
  });

  it("produces quiet single-line labels across Studio surfaces and null on unfiltered catalog views", () => {
    expect(formatActiveViewPillLabel(null)).toBeNull();

    expect(
      formatActiveViewPillLabel({
        surface: "analysis",
        route: "/analysis/an_1",
        itemId: "an_1",
        title: "Keynote Q&A",
        playheadSeconds: 84,
      }),
    ).toBe("Analysis · Keynote Q&A · 01:24");

    expect(
      formatActiveViewPillLabel({
        surface: "tree-doc",
        route: "/trees/t1/launch-plan.md",
        treeId: "t1",
        docPath: "docs/launch-plan.md",
        activeHeading: "Intro",
      }),
    ).toBe("Doc · launch-plan.md · §Intro");

    expect(
      formatActiveViewPillLabel({
        surface: "tree-doc",
        route: "/trees/t1/launch-plan.md",
        treeId: "t1",
        docPath: "docs/launch-plan.md",
        activeHeading: "Intro",
        selectionExcerpt: "selected excerpt",
      }),
    ).toBe('Doc · launch-plan.md · "selected excerpt"');

    expect(
      formatActiveViewPillLabel({
        surface: "narration",
        route: "/narration/nar_1",
        itemId: "nar_1",
        title: "Weekly Brief",
        playheadSeconds: 42,
      }),
    ).toBe("Narration · Weekly Brief · 00:42");

    expect(
      formatActiveViewPillLabel({
        surface: "video",
        route: "/video/vid_1",
        itemId: "vid_1",
        title: "Opening Shot",
        playheadSeconds: 4,
      }),
    ).toBe("Video · Opening Shot · 00:04");

    expect(
      formatActiveViewPillLabel({
        surface: "composer",
        route: "/studio/analysis",
        draftKind: "analysis",
      }),
    ).toBe("Draft · Video Analysis");

    expect(
      formatActiveViewPillLabel({
        surface: "cut",
        route: "/productions/p1/cuts/c1",
        productionId: "p1",
        cutId: "c1",
        title: "Ep 3 Rough Cut",
        playheadSeconds: 138,
      }),
    ).toBe("Cut · Ep 3 Rough Cut · 02:18");

    expect(
      formatActiveViewPillLabel({
        surface: "storyboard",
        route: "/storyboards/sb1",
        storyboardId: "sb1",
        title: "Teaser",
        selectedShotIndex: 3,
      }),
    ).toBe("Storyboard · Teaser · Shot 4");

    expect(
      formatActiveViewPillLabel({
        surface: "library",
        route: "/library",
      }),
    ).toBeNull();

    expect(
      formatActiveViewPillLabel({
        surface: "library",
        route: "/library?type=video",
        activeFilter: "Videos",
      }),
    ).toBe("Library · Videos");
  });
});

describe("ChatThoughtDisclosure rendering states", () => {
  it("renders empty markup when there are no thoughts", () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(ChatThoughtDisclosure, {
        streaming: false,
        headline: null,
        steps: [],
      }),
    );
    expect(emptyHtml).toBe("");
  });

  it("renders a single live Thinking ticker line while streaming", () => {
    const liveHtml = renderToStaticMarkup(
      createElement(ChatThoughtDisclosure, {
        streaming: true,
        headline: "Inspecting timeline timestamps…",
        steps: ["Inspecting timeline timestamps…"],
        durationMs: null,
      }),
    );
    expect(liveHtml).toContain("Thinking — Inspecting timeline timestamps…");
    expect(liveHtml).not.toContain("<button");
  });

  it("collapses into a Thought for Xs button once completed", () => {
    const doneHtml = renderToStaticMarkup(
      createElement(ChatThoughtDisclosure, {
        streaming: false,
        headline: "Done",
        steps: ["Read transcript", "Summarized highlights"],
        durationMs: 3100,
      }),
    );
    expect(doneHtml).toContain("<button");
    expect(doneHtml).toContain('aria-expanded="false"');
    expect(doneHtml).toContain("Thought for 3s");
    expect(doneHtml).not.toContain("Summarized highlights");

    const fastDoneHtml = renderToStaticMarkup(
      createElement(ChatThoughtDisclosure, {
        streaming: false,
        headline: null,
        steps: ["Step A", "Step B"],
        durationMs: 420,
      }),
    );
    expect(fastDoneHtml).toContain("Thought · 2 steps");
  });
});

describe("ChatMarkdown & tokenizeInlineChatSegments", () => {
  it("tokenizes mdmedia:// URIs, internal Studio routes, and timestamps accurately", () => {
    expect(parseChatMediaLink("mdmedia://video/abc@gen_9")).toEqual({
      mediaType: "video",
      itemId: "abc",
      generationId: "gen_9",
      href: "/video/abc",
    });

    const segments = tokenizeInlineChatSegments(
      "Check mdmedia://video/abc, open /trees/t1/doc.md, and jump to 01:24.",
    );

    const mediaSeg = segments.find((s) => s.kind === "media");
    expect(mediaSeg).toEqual({
      kind: "media",
      raw: "mdmedia://video/abc",
      mediaType: "video",
      itemId: "abc",
      href: "/video/abc",
      label: "Video · abc",
    });

    const routeSeg = segments.find((s) => s.kind === "route");
    expect(routeSeg).toEqual({
      kind: "route",
      raw: "/trees/t1/doc.md",
      href: "/trees/t1/doc.md",
      label: "/trees/t1/doc.md",
    });

    const timeSeg = segments.find((s) => s.kind === "timestamp");
    expect(timeSeg).toEqual({
      kind: "timestamp",
      label: "01:24",
      seconds: 84,
    });
  });

  it("renders safe HTML with zero raw script execution and interactive pills for mdmedia, routes, and timestamps", () => {
    const markdown = [
      "### Key Highlights",
      "",
      'Watch mdmedia://video/abc and read /trees/t1/doc.md starting at 01:24.',
      "",
      '<script>window.__xss = true;</script>',
      "",
      "[Unsafe](javascript:alert(1))",
    ].join("\n");

    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        markdown,
      }),
    );

    // Escapes raw script tags instead of injecting executable <script> DOM elements
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;window.__xss = true;&lt;/script&gt;");
    expect(html).not.toContain("javascript:alert");

    // Interactive pills rendered with semantic data attributes
    expect(html).toContain('data-media-uri="mdmedia://video/abc"');
    expect(html).toContain('data-route-href="/video/abc"');
    expect(html).toContain('data-route-href="/trees/t1/doc.md"');
    expect(html).toContain('data-seek-seconds="84"');
    expect(html).toContain(">01:24<");
  });
});

describe("Chat model & reasoning effort catalog, formatting & settings persistence", () => {
  it("exposes the three supported chat models and five reasoning effort levels", () => {
    expect(CHAT_MODELS).toEqual([
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
    expect(CHAT_EFFORT_LEVELS).toEqual([
      "auto",
      "minimal",
      "low",
      "medium",
      "high",
    ]);

    expect(isChatModelName("gemini-4-argon")).toBe(true);
    expect(isChatModelName("gemini-3.8-flash")).toBe(true);
    expect(isChatModelName("gemini-3.5-flash-lite")).toBe(true);
    expect(isChatModelName("gemini-1.5-pro")).toBe(false);

    expect(isChatEffortLevel("high")).toBe(true);
    expect(isChatEffortLevel("minimal")).toBe(true);
    expect(isChatEffortLevel("turbo")).toBe(false);
  });

  it("formats compact composer selector labels cleanly across effort states", () => {
    expect(formatChatSelectorLabel("gemini-3.8-flash", "auto")).toBe(
      "gemini-3.8-flash",
    );
    expect(formatChatSelectorLabel("gemini-4-argon", "high")).toBe(
      "gemini-4-argon · High",
    );
    expect(formatChatSelectorLabel("gemini-3.5-flash-lite", "minimal")).toBe(
      "gemini-3.5-flash-lite · Minimal",
    );
  });

  it("normalizes chatModel and chatEffort in readSettings() with safe defaults", () => {
    const empty = readSettings(undefined);
    expect(empty.chatModel).toBe(DEFAULT_CHAT_MODEL);
    expect(empty.chatEffort).toBe(DEFAULT_CHAT_EFFORT);

    const valid = readSettings({
      chatModel: "gemini-4-argon",
      chatEffort: "high",
    });
    expect(valid.chatModel).toBe("gemini-4-argon");
    expect(valid.chatEffort).toBe("high");

    const invalid = readSettings({
      chatModel: "legacy-unknown-model",
      chatEffort: "extreme",
    });
    expect(invalid.chatModel).toBe("gemini-3.8-flash");
    expect(invalid.chatEffort).toBe("auto");
  });
});

describe("Deferred Media Embeds & Inline Word-Highlighted Narration", () => {
  it("orders ChatResultParts deterministically so media-embed cards always appear last", () => {
    const unordered: ChatResultPart[] = [
      {
        kind: "media-embed",
        mediaType: "narration",
        itemId: "nar_first",
        title: "First Narration",
      },
      {
        kind: "link-list",
        items: [{ label: "More", href: "/library", kind: "route" }],
      },
      {
        kind: "action-card",
        callId: "call_1",
        toolName: "generate_image",
        state: "staged",
        title: "Stage Image",
        meta: "16:9",
        cardActions: [],
      },
      {
        kind: "media-embed",
        mediaType: "video",
        itemId: "vid_second",
        title: "Second Video",
      },
    ];

    const ordered = orderChatResultParts(unordered);
    expect(ordered.map((p) => p.kind)).toEqual([
      "action-card",
      "link-list",
      "media-embed",
      "media-embed",
    ]);
    expect(
      ordered
        .filter((p) => p.kind === "media-embed")
        .map((p) => p.itemId),
    ).toEqual(["nar_first", "vid_second"]);
  });

  it("withholds media-embed and link-list parts while prose is still streaming", () => {
    const parts: ChatResultPart[] = [
      {
        kind: "media-embed",
        mediaType: "narration",
        itemId: "nar_1",
        title: "Briefing",
      },
      {
        kind: "action-card",
        callId: "call_stage_1",
        toolName: "generate_image",
        state: "staged",
        title: "Hero Still",
        meta: "16:9",
        cardActions: [],
      },
    ];

    // Before any text has arrived -> nothing shown ahead of prose
    expect(visibleStreamingResultParts(parts, "")).toEqual([]);

    // While text streams -> staged action-card may show below live text, media-embed stays deferred until turn.done
    const duringText = visibleStreamingResultParts(parts, "Here is the staged image:");
    expect(duringText.map((p) => p.kind)).toEqual(["action-card"]);
  });

  it("dims un-generated chunks, enables click-to-seek on generated words, and highlights the active spoken word inline", () => {
    const markdown = "First chunk ready now.\n\nSecond chunk still generating.";

    // 1. Initial starting state before first chunk arrives -> all words dimmed (`data-spoken="false"`)
    const dimHtml = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        markdown,
        narration: {
          active: true,
          chunks: [],
          words: [],
          audioLoaded: false,
          loadedDurationMs: 0,
          activeCharStart: null,
          activeCharEnd: null,
        },
      }),
    );
    expect(dimHtml).toContain('data-spoken="false"');
    expect(dimHtml).toContain("text-ink-faint");
    expect(dimHtml).not.toContain('data-word-selectable="true"');

    // 2. Chunk 0 loaded (0..800ms), Chunk 1 not yet synthesized -> Chunk 0 words clickable & highlighted, Chunk 1 still dim
    const chunk0Words = [
      { startMs: 0, endMs: 180, charStart: 0, charEnd: 5 },
      { startMs: 190, endMs: 380, charStart: 6, charEnd: 11 },
      { startMs: 390, endMs: 580, charStart: 12, charEnd: 17 },
      { startMs: 590, endMs: 800, charStart: 18, charEnd: 22 },
    ];
    const partialHtml = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        markdown,
        narration: {
          active: true,
          chunks: [
            {
              index: 0,
              startMs: 0,
              endMs: 800,
              docOffset: 0,
              text: "First chunk ready now.",
              words: chunk0Words,
            },
          ],
          words: chunk0Words,
          sourceMap: {
            version: 1,
            blocks: [
              { mdStart: 0, mdEnd: 22, transcriptStart: 0, transcriptEnd: 22 },
              { mdStart: 24, mdEnd: 54, transcriptStart: 24, transcriptEnd: 54 },
            ],
          },
          audioLoaded: true,
          loadedDurationMs: 800,
          activeCharStart: 12,
          activeCharEnd: 17,
        },
      }),
    );

    // Chunk 0 words are spoken & clickable (`data-word-selectable="true"`, `data-start-ms`)
    expect(partialHtml).toContain('data-word-selectable="true"');
    expect(partialHtml).toContain('data-start-ms="390"');
    // Word "ready" (charStart 12..17) is actively highlighted inline
    expect(partialHtml).toContain('data-word-active="true"');
    expect(partialHtml).toContain("reader-word-active");
    // Chunk 1 ("Second chunk still generating.") remains dimmed (`data-spoken="false"`, `text-ink-faint`)
    expect(partialHtml).toContain('data-spoken="false"');
    expect(partialHtml).toContain("text-ink-faint");
  });
});
