import type { TimeRef } from './types.js';

/**
 * Item ids: letters, digits and underscores, not starting with a digit. An id
 * can't look like a frame count (`f191`), which a time string would read as frames.
 */
export const ID_PATTERN = /^(?!f\d+$)[A-Za-z_][A-Za-z0-9_]*$/;

/** A frame count at the cut's fps: `f` and a whole number, as in `"f191"`. */
export const FRAMES_PATTERN = /^f(\d+)$/;

/** Anchor names that aren't item ids. */
export const START_ANCHOR = '@start';
export const END_ANCHOR = '@end';

/** A parsed time: absolute seconds, or a point of an item plus an offset. */
export type ParsedTime =
  | { kind: 'absolute'; seconds: number }
  | { kind: 'anchor'; target: string; point: 'start' | 'end'; offset: number };

const AMOUNT = String.raw`(\d+(?:\.\d*)?|\.\d+|f\d+)`;
const ANCHOR_PATTERN = new RegExp(
  String.raw`^\s*(@start|@end|[A-Za-z_][A-Za-z0-9_]*)(?:\.(start|end))?\s*(?:([+-])\s*${AMOUNT})?\s*$`,
);

/** Seconds in `frames` frames at `fps`, rounded to the microsecond. */
export function framesToSeconds(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1e6) / 1e6;
}

/**
 * A frame count string (`"f191"`) in seconds at `fps`, or null when it isn't
 * one or there is no frame rate to read it with.
 */
export function parseFrames(value: string, fps: number | undefined): number | null {
  const match = FRAMES_PATTERN.exec(value.trim());
  if (!match || fps === undefined || !(fps > 0)) return null;
  return framesToSeconds(Number(match[1]), fps);
}

/**
 * Parses a TimeRef. Returns null when a string isn't a valid anchor.
 *
 * `"stun"` → stun's start, `"stun.end-0.5"` → half a second before it ends,
 * `"@end-0.45"` → 0.45 s before the cut ends. `@start` and `@end` take no
 * `.start`/`.end`. With `fps`, frames work too: `"f191"` is frame 191 and
 * `"stun+f12"` is 12 frames after stun starts.
 */
export function parseTimeRef(ref: TimeRef, fps?: number): ParsedTime | null {
  if (typeof ref === 'number') {
    return Number.isFinite(ref) ? { kind: 'absolute', seconds: ref } : null;
  }
  if (FRAMES_PATTERN.test(ref.trim())) {
    const seconds = parseFrames(ref, fps);
    return seconds === null ? null : { kind: 'absolute', seconds };
  }
  const match = ANCHOR_PATTERN.exec(ref);
  if (!match) return null;
  const [, name, point, sign, amount] = match;
  if (name.startsWith('@') && point !== undefined) return null;
  let size = 0;
  if (amount !== undefined) {
    const frames = amount.startsWith('f') ? parseFrames(amount, fps) : Number(amount);
    if (frames === null) return null;
    size = frames;
  }
  const offset = size * (sign === '-' ? -1 : 1);
  if (name === START_ANCHOR) return { kind: 'anchor', target: START_ANCHOR, point: 'start', offset };
  if (name === END_ANCHOR) return { kind: 'anchor', target: END_ANCHOR, point: 'end', offset };
  return { kind: 'anchor', target: name, point: point === 'end' ? 'end' : 'start', offset };
}
