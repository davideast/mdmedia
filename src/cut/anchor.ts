import type { TimeRef } from './types.js';

/** Item ids: letters, digits and underscores, not starting with a digit. */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Anchor names that aren't item ids. */
export const START_ANCHOR = '@start';
export const END_ANCHOR = '@end';

/** A parsed time: absolute seconds, or a point of an item plus an offset. */
export type ParsedTime =
  | { kind: 'absolute'; seconds: number }
  | { kind: 'anchor'; target: string; point: 'start' | 'end'; offset: number };

const ANCHOR_PATTERN =
  /^\s*(@start|@end|[A-Za-z_][A-Za-z0-9_]*)(?:\.(start|end))?\s*(?:([+-])\s*(\d+(?:\.\d*)?|\.\d+))?\s*$/;

/**
 * Parses a TimeRef. Returns null when a string isn't a valid anchor.
 *
 * `"stun"` → stun's start, `"stun.end-0.5"` → half a second before it ends,
 * `"@end-0.45"` → 0.45 s before the cut ends. `@start` and `@end` take no
 * `.start`/`.end`.
 */
export function parseTimeRef(ref: TimeRef): ParsedTime | null {
  if (typeof ref === 'number') {
    return Number.isFinite(ref) ? { kind: 'absolute', seconds: ref } : null;
  }
  const match = ANCHOR_PATTERN.exec(ref);
  if (!match) return null;
  const [, name, point, sign, amount] = match;
  if (name.startsWith('@') && point !== undefined) return null;
  const offset = amount === undefined ? 0 : Number(amount) * (sign === '-' ? -1 : 1);
  if (name === START_ANCHOR) return { kind: 'anchor', target: START_ANCHOR, point: 'start', offset };
  if (name === END_ANCHOR) return { kind: 'anchor', target: END_ANCHOR, point: 'end', offset };
  return { kind: 'anchor', target: name, point: point === 'end' ? 'end' : 'start', offset };
}
