import type { ResolvedLine, Timeline } from '../cut/types.js';
import type { ItemKind, ItemRef } from './types.js';

/**
 * Where a playhead lands on a resolved cut, as a review thread's anchor
 * records it. Lines are timed by their speech (first word to last word), as
 * the cut viewer times them, so a pause between lines is a gap and not part
 * of either line.
 */

export interface Span {
  start: number;
  end: number;
}

/** A line's speech: its first word's start to its last word's end, or its own span when it has no words. */
export function spokenSpan(line: ResolvedLine): Span {
  if (line.words.length === 0) return { start: line.start, end: line.end };
  const start = Math.min(...line.words.map((w) => w.start));
  const end = Math.max(...line.words.map((w) => w.end));
  return end > start ? { start, end } : { start: line.start, end: line.end };
}

export interface Gap extends Span {
  id: string;
  from: string;
  to: string;
  /** Negative when the lines overlap. */
  length: number;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A gap's id: `<from>-<to>`, as the cut viewer keys it. */
export function gapId(from: string, to: string): string {
  return `${from}-${to}`;
}

/** Lines in speaking order, with their spoken spans. */
export function spokenLines(timeline: Timeline): Array<{ line: ResolvedLine; span: Span }> {
  return timeline.lines
    .map((line) => ({ line, span: spokenSpan(line) }))
    .sort((a, b) => a.span.start - b.span.start || a.line.id.localeCompare(b.line.id));
}

/** The pause between each pair of consecutive lines, in speaking order. */
export function lineGaps(timeline: Timeline): Gap[] {
  const lines = spokenLines(timeline);
  return lines.slice(1).map(({ line: to, span }, i) => {
    const from = lines[i];
    return { id: gapId(from.line.id, to.id), from: from.line.id, to: to.id, start: from.span.end, end: span.start, length: round(span.start - from.span.end) };
  });
}

const within = (span: Span, t: number): boolean => t >= span.start && t < span.end;

/** Items playing at `t` (start inclusive, end exclusive), lines by their speech, in timeline order. */
export function itemsAt(timeline: Timeline, t: number): ItemRef[] {
  const refs: ItemRef[] = [];
  for (const s of timeline.segments) if (within(s, t)) refs.push({ kind: 'segment', id: s.id });
  for (const { line, span } of spokenLines(timeline)) if (within(span, t)) refs.push({ kind: 'line', id: line.id });
  for (const o of timeline.overlays) if (within(o, t)) refs.push({ kind: 'overlay', id: o.id });
  for (const m of timeline.music) if (within(m, t)) refs.push({ kind: 'music', id: m.id });
  for (const x of timeline.sfx) if (within(x, t)) refs.push({ kind: 'sfx', id: x.id });
  return refs;
}

/** Where `t` falls among the lines: inside one, or in the gap between two (or before the first, or after the last). */
export type LinePlace =
  | { in: 'line'; line: string; before: string | null; gapBefore: Gap | null }
  | { in: 'gap'; gap: Gap }
  | { in: 'none'; before: string | null; after: string | null };

export function linePlace(timeline: Timeline, t: number): LinePlace {
  const lines = spokenLines(timeline);
  const gaps = lineGaps(timeline);
  const i = lines.findIndex(({ span }) => within(span, t));
  if (i >= 0) return { in: 'line', line: lines[i].line.id, before: lines[i - 1]?.line.id ?? null, gapBefore: gaps[i - 1] ?? null };
  const gap = gaps.find((g) => g.length > 0 && t >= g.start && t < g.end);
  if (gap) return { in: 'gap', gap };
  const after = lines.find(({ span }) => span.start >= t);
  const before = [...lines].reverse().find(({ span }) => span.end <= t);
  return { in: 'none', before: before?.line.id ?? null, after: after?.line.id ?? null };
}

const KIND_ORDER: readonly ItemKind[] = ['segment', 'line', 'gap', 'overlay', 'music', 'sfx'];

/**
 * The anchor's items for a playhead at `t`: everything playing there, plus the
 * lines around it. In a gap, the two lines either side and the gap. In a line,
 * that line, the line before it and the gap between them, since a note on a
 * line is usually about how it lands after the one before.
 */
export function anchorItems(timeline: Timeline, t: number): ItemRef[] {
  const refs = itemsAt(timeline, t);
  const place = linePlace(timeline, t);
  if (place.in === 'gap') {
    refs.push({ kind: 'line', id: place.gap.from }, { kind: 'line', id: place.gap.to }, { kind: 'gap', id: place.gap.id });
  } else if (place.in === 'line' && place.before && place.gapBefore) {
    refs.push({ kind: 'line', id: place.before }, { kind: 'gap', id: place.gapBefore.id });
  }
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const start = (r: ItemRef): number => itemSpan(timeline, r)?.start ?? 0;
  return unique.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || start(a) - start(b));
}

/** An item's span on the timeline (a line's speech, a gap's pause), or null when the cut has no such item. */
export function itemSpan(timeline: Timeline, ref: ItemRef): Span | null {
  switch (ref.kind) {
    case 'segment':
      return timeline.segments.find((s) => s.id === ref.id) ?? null;
    case 'line': {
      const line = timeline.lines.find((l) => l.id === ref.id);
      return line ? spokenSpan(line) : null;
    }
    case 'gap':
      return lineGaps(timeline).find((g) => g.id === ref.id) ?? null;
    case 'overlay':
      return timeline.overlays.find((o) => o.id === ref.id) ?? null;
    case 'music':
      return timeline.music.find((m) => m.id === ref.id) ?? null;
    case 'sfx':
      return timeline.sfx.find((x) => x.id === ref.id) ?? null;
  }
}
