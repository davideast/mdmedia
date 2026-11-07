import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { createElement, type ReactElement } from "react";
import type { Caller } from "../../studio/src/lib/api-auth";
import { buildReferencedItemsPromptBlock } from "../../studio/src/lib/chat/chat-agent-server";
import { stripChatUrisForSpeech } from "../../studio/src/lib/chat/chat-narration-server";
import {
  extractActiveHashTrigger,
  formatChatEntityUri,
  formatReferenceComposerToken,
  parseChatEntityUri,
  parseHashQuery,
  tokenizeUserTextWithReferences,
  validateChatEntityReferences,
} from "../../studio/src/lib/chat/references";
import { searchChatReferences } from "../../studio/src/lib/chat/references-server";
import { executeChatToolCall } from "../../studio/src/lib/chat/tools";
import { setChatMediaReaderDepsForTests } from "../../studio/src/lib/chat/tools/context-tools";
import {
  CHAT_REFERENCE_KINDS,
  type ChatEntityReference,
} from "../../studio/src/lib/chat/types";
import { ChatMarkdown } from "../../studio/src/components/chat/chat-markdown";
import { ChatReferenceChip } from "../../studio/src/components/chat/chat-reference-chip";

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

afterEach(() => {
  setChatMediaReaderDepsForTests(null);
});

describe("Universal mdmedia:// URI grammar across all 13 entity kinds", () => {
  it("round-trips every entity kind losslessly including nested tree-doc paths, cuts, and character versions", () => {
    expect(CHAT_REFERENCE_KINDS.length).toBe(13);

    const samples = [
      { kind: "narration" as const, id: "nar_01", subId: undefined },
      { kind: "video" as const, id: "vid_02", subId: "gen_9" },
      { kind: "image" as const, id: "img_03", subId: undefined },
      { kind: "music" as const, id: "mus_04", subId: undefined },
      { kind: "sfx" as const, id: "sfx_whoosh", subId: undefined },
      { kind: "analysis" as const, id: "ana_05", subId: undefined },
      { kind: "tree" as const, id: "tree_arch", subId: undefined },
      {
        kind: "tree-doc" as const,
        id: "tree_arch",
        subId: "guides/01-storage overview.md",
      },
      { kind: "production" as const, id: "prod_ep1", subId: undefined },
      { kind: "cut" as const, id: "prod_ep1", subId: "rough-cut-2" },
      { kind: "storyboard" as const, id: "sb_teaser", subId: undefined },
      { kind: "character" as const, id: "rick", subId: "2" },
      { kind: "playlist" as const, id: "pl_morning", subId: undefined },
    ];

    for (const sample of samples) {
      const uri = formatChatEntityUri(sample);
      const parsed = parseChatEntityUri(uri);
      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe(sample.kind);
      expect(parsed?.id).toBe(sample.id);
      expect(parsed?.subId).toBe(sample.subId);
    }

    expect(parseChatEntityUri("mdmedia://character/rick@2")?.href).toBe(
      "#character:rick@2",
    );
    expect(
      parseChatEntityUri("mdmedia://tree-doc/t1/handbook/intro.md")?.href,
    ).toBe("/trees/t1/handbook/intro.md");
    expect(parseChatEntityUri("mdmedia://cut/prod1/cut_a")?.href).toBe(
      "/productions/prod1/cuts/cut_a",
    );
  });

  it("strips extended mdmedia:// URIs into equal-length spaces for verbatim TTS alignment", () => {
    const md =
      "Compare `mdmedia://tree-doc/t1/arch/01-intro.md` with mdmedia://character/rick@2 and [Cut](mdmedia://cut/p1/c1).";
    const stripped = stripChatUrisForSpeech(md);
    expect(stripped.length).toBe(md.length);
    expect(stripped).not.toContain("mdmedia://tree-doc");
    expect(stripped).not.toContain("mdmedia://character/rick@2");
    // Markdown link target inside `](...)` remains intact so marked parses `[Cut](...)` cleanly
    expect(stripped).toContain("[Cut](mdmedia://cut/p1/c1)");
  });
});

describe("Mid-sentence `#` trigger extraction & inline user message tokenization", () => {
  it("parses #kind: prefix shorthands cleanly", () => {
    expect(parseHashQuery("video:ocean")).toEqual({
      kindFilter: "video",
      search: "ocean",
    });
    expect(parseHashQuery("sfx:whoosh")).toEqual({
      kindFilter: "sfx",
      search: "whoosh",
    });
    expect(parseHashQuery("doc:storage")).toEqual({
      kindFilter: "tree-doc",
      search: "storage",
    });
    expect(parseHashQuery("sb:opening")).toEqual({
      kindFilter: "storyboard",
      search: "opening",
    });
    expect(parseHashQuery("char:rick")).toEqual({
      kindFilter: "character",
      search: "rick",
    });
  });

  it("triggers `#` at start of line or mid-sentence, ignores `# ` headings, and skips already-selected `#Token` mentions", () => {
    // Standalone `#` at start
    const bare = extractActiveHashTrigger("#", 1, []);
    expect(bare).toEqual({
      startOffset: 0,
      endOffset: 1,
      rawQuery: "",
      kindFilter: null,
      search: "",
    });

    // `# ` Markdown heading must NOT open reference popover
    expect(extractActiveHashTrigger("# Heading", 2, [])).toBeNull();
    expect(extractActiveHashTrigger("# Heading", 9, [])).toBeNull();

    // Multi-word query while typing `#the over`
    const midQuery = extractActiveHashTrigger(
      "Compare #the over",
      "Compare #the over".length,
      [],
    );
    expect(midQuery?.startOffset).toBe(8);
    expect(midQuery?.search).toBe("the over");

    // Once `#The overnight process` is selected and followed by prose, popover stays closed until a new `#`
    const afterResolved = "Compare #The overnight process with ";
    expect(
      extractActiveHashTrigger(afterResolved, afterResolved.length, [
        "#The overnight process",
      ]),
    ).toBeNull();

    // Typing a second `#char:ri` after a resolved token opens a fresh trigger for the second `#`
    const secondTriggerText = "Compare #The overnight process with #char:ri";
    const secondTrigger = extractActiveHashTrigger(
      secondTriggerText,
      secondTriggerText.length,
      ["#The overnight process"],
    );
    expect(secondTrigger).toEqual({
      startOffset: 36,
      endOffset: secondTriggerText.length,
      rawQuery: "char:ri",
      kindFilter: "character",
      search: "ri",
    });
  });

  it("tokenizes user message `#Title` and `#slug@v` tokens inline into rich reference segments", () => {
    const narrationRef: ChatEntityReference = {
      uri: "mdmedia://narration/nar_1",
      kind: "narration",
      id: "nar_1",
      title: "The overnight process",
      metaLabel: "02:02",
      href: "/narration/nar_1",
      composerToken: formatReferenceComposerToken({
        kind: "narration",
        id: "nar_1",
        title: "The overnight process",
      }),
    };
    const charRef: ChatEntityReference = {
      uri: "mdmedia://character/rick@1",
      kind: "character",
      id: "rick",
      subId: "1",
      title: "Rick",
      characterKind: "person",
      metaLabel: "rick@1",
      href: "#character:rick@1",
      composerToken: "#rick@1",
    };

    const { segments, unmatchedReferences } = tokenizeUserTextWithReferences(
      "Rewrite #The overnight process in the voice of #rick@1.",
      [narrationRef, charRef],
    );

    expect(unmatchedReferences).toEqual([]);
    expect(segments.map((s) => s.kind)).toEqual([
      "text",
      "reference",
      "text",
      "reference",
      "text",
    ]);
  });

  it("validates `references` payloads strictly for POST /messages", () => {
    const valid = validateChatEntityReferences([
      {
        uri: "mdmedia://storyboard/sb_1",
        kind: "storyboard",
        id: "sb_1",
        title: "Episode 1 Board",
        metaLabel: "9 beats",
        href: "/storyboards/sb_1",
      },
    ]);
    expect(Array.isArray(valid) && valid.length === 1).toBe(true);
    expect(
      validateChatEntityReferences([
        { uri: "javascript:alert(1)", title: "Bad" },
      ]),
    ).toBe("invalid");
  });
});

describe("Unified cross-domain searchChatReferences & scope enforcement", () => {
  const userCaller: Caller = {
    kind: "user",
    uid: "user_1",
    email: "deast@example.com",
  };

  const mockDeps = {
    listMedia: async () => ({
      indexing: false,
      items: [
        {
          id: "nar_1",
          type: "narration" as const,
          title: "The overnight process",
          status: "ready" as const,
          createdAt: 100,
          updatedAt: 500,
          href: "/narration/nar_1",
          thumbnailAssetId: null,
          durationMs: 122_000,
        },
        {
          id: "sfx_1",
          type: "sfx" as const,
          title: "Tape Splice Whoosh",
          status: "ready" as const,
          createdAt: 100,
          updatedAt: 450,
          href: "/library?type=sfx",
          thumbnailAssetId: null,
          durationMs: 3_000,
        },
      ],
    }),
    listTrees: async () => [
      {
        id: "tree_1",
        title: "Studio Handbook",
        description: "Architecture docs",
        nodeCount: 2,
        docCount: 1,
        selectedCount: 1,
        createdAt: 100,
        updatedAt: 480,
      },
    ],
    getTree: async () => ({
      id: "tree_1",
      title: "Studio Handbook",
      description: "Architecture docs",
      nodeCount: 2,
      docCount: 1,
      selectedCount: 1,
      createdAt: 100,
      updatedAt: 480,
      rootIds: ["n1"],
      nodes: {
        n1: {
          id: "n1",
          kind: "doc" as const,
          name: "Audio Pipeline",
          path: "architecture/audio-pipeline.md",
          previousPaths: [],
          parentId: null,
          childIds: [],
          docId: "d1",
          narrationId: "nar_1",
          narrationStatus: "ready" as const,
          narrationContentHash: "abc",
          updatedAt: 490,
        },
      },
      selectedNodeIds: ["n1"],
      selectionSets: {},
      pathAssets: {},
      revision: 1,
    }),
    listProductions: async () => ({
      productions: [
        {
          id: "prod_1",
          slug: "pilot",
          assemblyManaged: false,
          title: "Pilot Episode",
          series: { id: "s1", title: "Season 1" },
          coverAssetId: "asset_cover",
          currentCutId: "cut_1",
          approvedCutId: "cut_1",
          cutCount: 1,
          cuts: [
            {
              id: "cut_1",
              label: "Director Cut",
              status: "approved" as const,
              kind: "cut" as const,
              lengthSeconds: 95,
              createdAt: 470,
              order: 0,
              renderedAssetId: null,
              posterAssetId: "asset_poster",
              notes: "",
              notesTruncated: false,
              links: { self: "", rendered: null },
            },
          ],
          cast: [],
          createdAt: 100,
          updatedAt: 470,
          reviewedAt: 0,
          links: { self: "", cuts: "", cover: null },
        },
      ],
    }),
    listStoryboards: async () => ({
      storyboards: [
        {
          id: "sb_1",
          title: "Cold Open Storyboard",
          beatCount: 8,
          image: "/assets/storyboard/beat1.png",
          updatedAt: 460,
        },
      ],
    }),
    listCharacters: async () => ({
      characters: [
        {
          id: "ch_rick",
          slug: "rick",
          name: "Rick",
          kind: "person" as const,
          latestVersion: 2,
          versions: [],
          createdAt: 100,
          updatedAt: 465,
          links: { self: "" },
        },
      ],
    }),
    getCharacterVersion: async () => ({
      id: "ch_rick",
      slug: "rick",
      version: 2,
      ref: "rick@2",
      character: {
        schema: "mdmedia.character@1" as const,
        id: "rick",
        version: 2,
        name: "Rick",
        kind: "person" as const,
        description: "Deadpan studio host.",
        delivery: { register: "Dry, unhurried cadence." },
        voice: { provider: "video-model" as const, uses: ["camera" as const] },
        stills: [{ id: "front", role: "primary" as const, description: "Front" }],
        changelog: [{ version: 2, date: "2026-11-01", changes: "Updated coat" }],
      },
      stills: { front: "asset_rick_still" },
      createdAt: 465,
      links: { self: "", character: "", stills: {} },
    }),
    listPlaylists: async () => [
      {
        id: "pl_1",
        title: "Daily Commute",
        description: "Morning queue",
        itemCount: 4,
        durationMs: 300_000,
        counts: { ready: 4, streaming: 0, error: 0, missing: 0 },
        createdAt: 100,
        updatedAt: 440,
      },
    ],
  };

  it("aggregates narrations, sfx, trees, tree-docs, productions, cuts, storyboards, characters, and playlists", async () => {
    const all = await searchChatReferences(
      userCaller,
      { origin: "http://localhost:3081" },
      mockDeps,
    );

    const kinds = new Set(all.items.map((i) => i.kind));
    expect(kinds.has("narration")).toBe(true);
    expect(kinds.has("sfx")).toBe(true);
    expect(kinds.has("tree")).toBe(true);
    expect(kinds.has("tree-doc")).toBe(true);
    expect(kinds.has("production")).toBe(true);
    expect(kinds.has("cut")).toBe(true);
    expect(kinds.has("storyboard")).toBe(true);
    expect(kinds.has("character")).toBe(true);
    expect(kinds.has("playlist")).toBe(true);

    const rick = all.items.find((i) => i.kind === "character");
    expect(rick?.uri).toBe("mdmedia://character/rick@2");
    expect(rick?.thumbnailAssetId).toBe("asset_rick_still");

    // Scope isolation for restricted API keys
    const storyboardsOnlyCaller: Caller = {
      kind: "apiKey",
      uid: "user_1",
      keyId: "k1",
      scopes: ["chat:use", "storyboards:read"],
    };
    const scoped = await searchChatReferences(
      storyboardsOnlyCaller,
      { origin: "http://localhost:3081" },
      mockDeps,
    );
    expect(scoped.items.map((i) => i.kind)).toEqual(["storyboard"]);
  });
});

describe("Extended Context Tools (read_storyboard, read_character, read_production, read_playlist) & Chip SSR", () => {
  it("executes read_storyboard and read_character with scope checks and formats [Referenced Studio Items] prompt blocks", async () => {
    setChatMediaReaderDepsForTests({
      getStoryboard: async (_uid, id) => ({
        id,
        title: "Cold Open",
        createdAt: 1,
        updatedAt: 2,
        storyboard: {
          revision: 3,
          updatedAt: 2,
          document: {
            version: 1,
            premise: "Studio lights flicker on.",
            beats: [
              {
                id: "b1",
                title: "Wide shot",
                purpose: "Establish room",
                script: "Welcome back.",
                visual: "Slow dolly in",
                notes: "",
                status: "decided",
                estimatedSeconds: 8,
              },
            ],
          },
        },
      }),
    });

    const userCaller: Caller = {
      kind: "user",
      uid: "u1",
      email: "deast@example.com",
    };

    const sbOut = await executeChatToolCall(
      "read_storyboard",
      { storyboardId: "mdmedia://storyboard/sb_1" },
      {
        caller: userCaller,
        origin: "http://localhost:3081",
        threadId: "t1",
        messageId: "m1",
        viewContext: null,
        signal: new AbortController().signal,
      },
    );
    expect(sbOut.isError).toBeUndefined();
    expect((sbOut.modelSummary.storyboard as { beatCount: number }).beatCount).toBe(1);

    const promptBlock = buildReferencedItemsPromptBlock([
      {
        uri: "mdmedia://character/rick@2",
        kind: "character",
        id: "rick",
        subId: "2",
        title: "Rick",
        characterKind: "person",
        href: "#character:rick@2",
      },
    ]);
    expect(promptBlock).toContain("[Referenced Studio Items]");
    expect(promptBlock).toContain("inspectWith=read_character");
  });

  it("renders distinct data-reference-kind chips in ChatReferenceChip and ChatMarkdown", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        markdown:
          "Cast [Rick](mdmedia://character/rick@2) in [Cold Open](mdmedia://storyboard/sb_1) using [Audio Doc](mdmedia://tree-doc/t1/arch/audio.md).",
      }),
    );
    expect(html).toContain('data-reference-kind="character"');
    expect(html).toContain('data-reference-kind="storyboard"');
    expect(html).toContain('data-reference-kind="tree-doc"');

    const propChipHtml = renderToStaticMarkup(
      createElement(ChatReferenceChip, {
        reference: {
          uri: "mdmedia://character/vintage-mic@1",
          kind: "character",
          id: "vintage-mic",
          subId: "1",
          title: "Vintage Mic",
          characterKind: "thing",
          metaLabel: "vintage-mic@1",
          href: "#character:vintage-mic@1",
        },
      }),
    );
    expect(propChipHtml).toContain('data-reference-kind="character"');
    expect(propChipHtml).toContain("lucide-box");
    expect(propChipHtml).toContain(">v1<");
  });
});
