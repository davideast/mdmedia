import { parseFrames } from './anchor.js';
import type { CutFile, FrameCount } from './types.js';

/**
 * A cut type with every `Seconds` field (`in`, `out`, `hold`, `duration`, a
 * sync's `source`) as a plain number of seconds.
 */
export type InSeconds<T> = T extends FrameCount
  ? number
  : T extends readonly (infer U)[]
    ? InSeconds<U>[]
    : T extends object
      ? { [K in keyof T]: InSeconds<T[K]> }
      : T;

/** The fields that hold `Seconds` (and only ever numbers or frame counts) wherever they appear in a cut. */
const SECONDS_FIELDS = new Set(['in', 'out', 'hold', 'duration', 'source']);

function convert(value: unknown, fps: number, key: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, fps, undefined));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v, fps, k)]));
  }
  if (typeof value === 'string' && key !== undefined && SECONDS_FIELDS.has(key)) return parseFrames(value, fps) ?? value;
  return value;
}

/**
 * The cut with every frame count (`"f191"`) in a `Seconds` field turned into
 * seconds at `meta.fps`. Time strings (anchors) keep their frames; the
 * resolver reads them with the same fps.
 */
export function inSeconds(cut: CutFile): InSeconds<CutFile> {
  // Every Seconds field is one of SECONDS_FIELDS, and those fields hold nothing else, so this walk is the type's map.
  return convert(cut, cut.meta.fps, undefined) as InSeconds<CutFile>;
}
