import { END_ANCHOR, START_ANCHOR, parseTimeRef } from '../anchor.js';
import type { Timeline } from '../types.js';

/**
 * A time on a resolved timeline, written as on the command line: seconds
 * (`12.5`), frames (`f300`), or an anchor (`pat`, `pat.end+0.5`, `@end-2`).
 * Null when it isn't one, or names no item.
 */
export function timeOnTimeline(timeline: Timeline, ref: string): number | null {
  const text = ref.trim();
  if (/^-?\d+(\.\d*)?$|^-?\.\d+$/.test(text)) return Number(text);
  const parsed = parseTimeRef(text, timeline.meta.fps);
  if (!parsed) return null;
  if (parsed.kind === 'absolute') return parsed.seconds;
  if (parsed.target === START_ANCHOR) return parsed.offset;
  if (parsed.target === END_ANCHOR) return timeline.length + parsed.offset;
  const item = timeline.items.find((i) => i.id === parsed.target);
  if (!item) return null;
  return Math.round(((parsed.point === 'end' ? item.end : item.start) + parsed.offset) * 1e6) / 1e6;
}
