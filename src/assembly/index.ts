/** Portable assembly structure. Rendering and editorial decisions belong to callers. */
export interface AssemblyScene {
  id: string;
  title: string;
  script: string;
  visual: string;
  notes: string;
}
export interface AssemblyTrack {
  id: string;
  name: string;
  type: "video" | "audio";
}
export interface AssemblyPlacement {
  id: string;
  trackId: string;
  assetId: string;
  start: number;
  in: number;
  out: number;
  sceneId?: string;
}
export interface Assembly {
  format: "mdmedia.assembly@1";
  output: { width: number; height: number; fps: number };
  scenes: AssemblyScene[];
  tracks: AssemblyTrack[];
  placements: AssemblyPlacement[];
  provenance?: {
    storyboardId: string;
    revision: number;
    beats: Record<string, string>;
  };
}
export interface AssemblyDraft {
  revision: number;
  hash: string;
  updatedAt: number;
  document: Assembly;
}
export function assemblyFromStoryboard(
  storyboardId: string,
  revision: number,
  beats: AssemblyScene[],
): Assembly {
  return {
    format: "mdmedia.assembly@1",
    output: { width: 1920, height: 1080, fps: 30 },
    scenes: beats.map(({ id, title, script, visual, notes }) => ({
      id,
      title,
      script,
      visual,
      notes,
    })),
    tracks: [],
    placements: [],
    provenance: {
      storyboardId,
      revision,
      beats: Object.fromEntries(beats.map((b) => [b.id, b.id])),
    },
  };
}
export function assemblyDuration(document: Assembly): number {
  return Math.max(0, ...document.placements.map((p) => p.start + p.out - p.in));
}
export class AssemblyError extends Error {
  readonly code = "invalid_assembly";
}
function fail(message: string): never {
  throw new AssemblyError(message);
}
function object(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((k) => !keys.includes(k)))
    fail(`${label} has unknown fields.`);
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 20000)
    fail(`${label} must be text of at most 20000 characters.`);
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail("Invalid stable ID.");
  return value;
}
function number(value: unknown, label: string, positive = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0)
  )
    fail(
      `${label} must be finite and ${positive ? "positive" : "non-negative"}.`,
    );
  return value;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 2000)
    fail(`${label} must be an array of at most 2000 items.`);
  return value;
}
export function parseAssembly(value: unknown): Assembly {
  const a = object(
    value,
    ["format", "output", "scenes", "tracks", "placements", "provenance"],
    "assembly",
  );
  if (a.format !== "mdmedia.assembly@1") fail("Expected mdmedia.assembly@1.");
  const o = object(a.output, ["width", "height", "fps"], "output");
  const output = {
    width: number(o.width, "width", true),
    height: number(o.height, "height", true),
    fps: number(o.fps, "fps", true),
  };
  if (
    !Number.isSafeInteger(output.width) ||
    !Number.isSafeInteger(output.height) ||
    output.width > 16384 ||
    output.height > 16384 ||
    output.fps > 240
  )
    fail("Invalid output dimensions or frame rate.");
  const scenes = list(a.scenes, "scenes").map((v) => {
    const s = object(v, ["id", "title", "script", "visual", "notes"], "scene");
    return {
      id: id(s.id),
      title: text(s.title, "title"),
      script: text(s.script, "script"),
      visual: text(s.visual, "visual"),
      notes: text(s.notes, "notes"),
    };
  });
  const tracks = list(a.tracks, "tracks").map((v) => {
    const t = object(v, ["id", "name", "type"], "track");
    if (t.type !== "video" && t.type !== "audio")
      fail("Track type must be video or audio.");
    return {
      id: id(t.id),
      name: text(t.name, "name"),
      type: t.type as "video" | "audio",
    };
  });
  const ids = new Set<string>();
  const unique = (value: string) => {
    if (ids.has(value)) fail(`Duplicate ID: ${value}`);
    ids.add(value);
  };
  scenes.forEach((s) => unique(s.id));
  tracks.forEach((t) => unique(t.id));
  const placements = list(a.placements, "placements").map((v) => {
    const p = object(
      v,
      ["id", "trackId", "assetId", "start", "in", "out", "sceneId"],
      "placement",
    );
    const result: AssemblyPlacement = {
      id: id(p.id),
      trackId: id(p.trackId),
      assetId: id(p.assetId),
      start: number(p.start, "start"),
      in: number(p.in, "in"),
      out: number(p.out, "out", true),
    };
    unique(result.id);
    if (
      result.out <= result.in ||
      !Number.isFinite(result.start + result.out - result.in)
    )
      fail("Invalid source range.");
    if (!tracks.some((t) => t.id === result.trackId)) fail("Unknown track.");
    if (p.sceneId !== undefined) {
      result.sceneId = id(p.sceneId);
      if (!scenes.some((s) => s.id === result.sceneId)) fail("Unknown scene.");
    }
    return result;
  });
  const result: Assembly = {
    format: "mdmedia.assembly@1",
    output,
    scenes,
    tracks,
    placements,
  };
  if (a.provenance !== undefined) {
    const p = object(
      a.provenance,
      ["storyboardId", "revision", "beats"],
      "provenance",
    );
    const revision = number(p.revision, "revision", true);
    if (!Number.isSafeInteger(revision)) fail("Invalid storyboard revision.");
    if (!p.beats || typeof p.beats !== "object" || Array.isArray(p.beats))
      fail("Invalid beat mapping.");
    const beats = Object.fromEntries(
      Object.entries(p.beats).map(([k, v]) => [id(k), id(v)]),
    );
    result.provenance = { storyboardId: id(p.storyboardId), revision, beats };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 700000)
    fail("Assembly exceeds 700 KB.");
  return result;
}

export { assemblyReviewTimeline } from "./review.js";
