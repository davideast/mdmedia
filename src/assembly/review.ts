import type {
  Timeline,
  ResolvedSegment,
  ResolvedAudio,
  ResolvedSource,
} from "../cut/types.js";
import { assemblyDuration, type Assembly } from "./index.js";
/** Compatibility projection for review anchors only. Never pass it to a cut renderer. */
export function assemblyReviewTimeline(
  assembly: Assembly,
  title: string,
): Timeline {
  const segments: ResolvedSegment[] = [];
  const sfx: ResolvedAudio[] = [];
  for (const [index, p] of assembly.placements.entries()) {
    const track = assembly.tracks.find((t) => t.id === p.trackId)!;
    const src: ResolvedSource = {
      kind: "asset",
      id: p.assetId,
      ref: `asset:${p.assetId}`,
    };
    const common = {
      id: p.id,
      label: `${track.name}: ${p.id}`,
      start: p.start,
      end: p.start + p.out - p.in,
      src,
      in: p.in,
      out: p.out,
    };
    if (track.type === "video")
      segments.push({
        ...common,
        kind: "segment",
        index,
        still: false,
        hold: 0,
        loop: null,
        crop: null,
        fadeIn: 0,
        fadeOut: 0,
        audio: null,
        mix: { fadeIn: 0, fadeOut: 0 },
        zoom: null,
      });
    else
      sfx.push({
        ...common,
        kind: "sfx",
        fadeIn: 0,
        fadeOut: 0,
        fadeInStart: common.start,
        fadeOutEnd: common.end,
        volume: [{ t: common.start, value: 1 }],
        filters: [],
        parts: null,
        segment: null,
        sync: null,
        layer: null,
      });
  }
  return {
    meta: { title, ...assembly.output },
    length: assemblyDuration(assembly),
    output: null,
    segments,
    sfx,
    items: [...segments, ...sfx].sort((a, b) => a.start - b.start),
    lines: [],
    music: [],
    overlays: [],
    picture: { fadeIn: 0, fadeOut: 0 },
    filters: { picture: [], mix: [] },
    sources: {},
    at: Object.fromEntries(assembly.placements.map((p) => [p.id, p.start])),
    performances: [],
    check: { thresholds: {} },
  };
}
