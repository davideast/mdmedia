import { expect, test } from "bun:test";
import {
  parseAssembly,
  assemblyDuration,
  assemblyFromStoryboard,
} from "../../src/assembly/index";
test("storyboard handoff preserves untimed scenes without inventing placements", () => {
  const assembly = assemblyFromStoryboard("sb1", 3, [
    {
      id: "intro",
      title: "Introduce",
      script: "Hello",
      visual: "Screen",
      notes: "Keep brief",
    },
  ]);
  expect(assembly.scenes[0]).toEqual({
    id: "intro",
    title: "Introduce",
    script: "Hello",
    visual: "Screen",
    notes: "Keep brief",
  });
  expect(assembly.placements).toEqual([]);
  expect(assembly.provenance).toEqual({
    storyboardId: "sb1",
    revision: 3,
    beats: { intro: "intro" },
  });
  expect(assemblyDuration(parseAssembly(assembly))).toBe(0);
});
test("overlaps are valid but invalid timings and dangling identities are rejected", () => {
  const base = assemblyFromStoryboard("sb1", 1, []);
  base.tracks = [
    { id: "picture", name: "Picture", type: "video" },
    { id: "voice", name: "Narration", type: "audio" },
  ];
  base.placements = [
    { id: "a", trackId: "picture", assetId: "media1", start: 0, in: 2, out: 6 },
    { id: "b", trackId: "voice", assetId: "media2", start: 1, in: 0, out: 5 },
  ];
  expect(assemblyDuration(parseAssembly(base))).toBe(6);
  for (const patch of [
    { start: -1 },
    { start: Infinity },
    { in: 3, out: 2 },
    { trackId: "missing" },
    { sceneId: "missing" },
    { id: "b" },
  ]) {
    expect(() =>
      parseAssembly({
        ...base,
        placements: [{ ...base.placements[0], ...patch }, base.placements[1]],
      }),
    ).toThrow();
  }
  expect(() =>
    parseAssembly({ ...base, output: { width: 1920, height: 1080, fps: 0 } }),
  ).toThrow();
  expect(() => parseAssembly({ ...base, unexpected: true })).toThrow();
});
test("review anchors preserve overlapping placement IDs without rendering the assembly", async () => {
  const { assemblyReviewTimeline } = await import("../../src/assembly/review");
  const { itemsAt } = await import("../../src/threads/anchor");
  const a = assemblyFromStoryboard("sb1", 1, []);
  a.tracks = [
    { id: "picture", name: "Screen", type: "video" },
    { id: "voice", name: "Voice", type: "audio" },
  ];
  a.placements = [
    { id: "screen", trackId: "picture", assetId: "a", start: 0, in: 0, out: 4 },
    {
      id: "narration",
      trackId: "voice",
      assetId: "b",
      start: 1,
      in: 0,
      out: 3,
    },
  ];
  expect(
    itemsAt(assemblyReviewTimeline(a, "Demo"), 2).map((x) => x.id),
  ).toEqual(["screen", "narration"]);
});
