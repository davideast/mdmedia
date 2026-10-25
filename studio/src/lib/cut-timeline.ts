import { gainAt, type ResolvedAudio, type ResolvedLine } from 'mdmedia/cut';

/**
 * Pure layout for the cut viewer's timeline: how times read, which lane each
 * item takes, how much room its label has, and which labels can show without
 * touching. Everything is in seconds; the component turns seconds into pixels.
 */

/** Seconds to tenths, e.g. `11.0`. Half-tenths round up, as the eye expects. */
export function tenths(seconds: number): string {
  return (Math.round(seconds * 10 + 1e-6) / 10).toFixed(1);
}

/** A length or gap, e.g. `0.3 s`. */
export function secondsLabel(seconds: number): string {
  return `${tenths(seconds)} s`;
}

/**
 * A pause between lines, e.g. `0.23 s`. Comic timing lives in hundredths under a second
 * (0.16 and 0.23 would both read `0.2 s`), so short gaps keep two places; longer ones read in tenths.
 */
export function gapLabel(seconds: number): string {
  return Math.abs(seconds) < 1 ? `${(Math.round(seconds * 100 + 1e-6) / 100).toFixed(2)} s` : secondsLabel(seconds);
}

/**
 * Steps `size` seconds from `t` along the 0.1 s grid, so stepping lands on the
 * times the page shows: 11.34 steps to 11.4 and back to 11.3.
 */
export function stepTenth(t: number, direction: 1 | -1, size = 0.1): number {
  const base = direction > 0 ? Math.floor(t * 10 + 1e-6) : Math.ceil(t * 10 - 1e-6);
  return (base + direction * Math.round(size * 10)) / 10;
}

interface Span {
  start: number;
  end: number;
}

/** The index of the item playing at `t` (start inclusive, end exclusive), or -1. */
export function activeIndex(items: readonly Span[], t: number): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (t >= items[i].start && t < items[i].end) return i;
  }
  return -1;
}

/** Speakers in the order they first speak; each gets a lane. */
export function speakerLanes(lines: readonly ResolvedLine[]): string[] {
  const order: string[] = [];
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    if (!order.includes(line.speaker)) order.push(line.speaker);
  }
  return order;
}

/**
 * Seconds of lane each item's label may use: from its start to the next item
 * in the same lane (or the end of the timeline). Labels never cross into the
 * next item, so text can't overlap.
 */
export function labelRoom<T extends Span>(items: readonly T[], length: number): Map<T, number> {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const room = new Map<T, number>();
  sorted.forEach((item, i) => room.set(item, Math.max(0, (sorted[i + 1]?.start ?? length) - item.start)));
  return room;
}

/** Greedy interval packing: the first lane whose last item ended by this item's start. */
export function packLanes<T extends Span>(items: readonly T[]): Map<T, number> {
  const ends: number[] = [];
  const lanes = new Map<T, number>();
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    let lane = ends.findIndex((end) => end <= item.start + 1e-6);
    if (lane === -1) lane = ends.push(0) - 1;
    ends[lane] = item.end;
    lanes.set(item, lane);
  }
  return lanes;
}

/**
 * Each line timed to its speech: from its first word's start to its last word's end, when word
 * timings are known. A line's own start and end are its whole audio (a TTS file's lead-in and tail,
 * or the whole on-camera shot), so without this the gaps between lines measure cuts, not pauses.
 * Lines without words keep their own times.
 */
export function spokenLines(lines: readonly ResolvedLine[]): ResolvedLine[] {
  return lines.map((line) => {
    if (line.words.length === 0) return line;
    const start = Math.min(...line.words.map((word) => word.start));
    const end = Math.max(...line.words.map((word) => word.end));
    return end > start ? { ...line, start, end } : line;
  });
}

export interface LineGap {
  /** The line before the gap and the line after it. */
  from: ResolvedLine;
  to: ResolvedLine;
  start: number;
  end: number;
  /** Negative when the lines overlap. */
  length: number;
}

/** The pause between each pair of consecutive lines, in speaking order. */
export function lineGaps(lines: readonly ResolvedLine[]): LineGap[] {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  return sorted.slice(1).map((to, i) => {
    const from = sorted[i];
    return { from, to, start: from.end, end: to.start, length: Math.round((to.start - from.end) * 1e6) / 1e6 };
  });
}

export interface PlacedLabel {
  /** Centre, in pixels. */
  x: number;
  width: number;
  /** Higher keeps its place when two labels would touch. */
  priority: number;
}

/** Which labels can show without touching: the most important first, then any that still fit. */
export function fitLabels(labels: readonly PlacedLabel[], spacing = 4): boolean[] {
  const shown = labels.map(() => false);
  const taken: Array<[number, number]> = [];
  const order = labels.map((_, i) => i).sort((a, b) => labels[b].priority - labels[a].priority || labels[a].x - labels[b].x);
  for (const i of order) {
    const left = labels[i].x - labels[i].width / 2 - spacing / 2;
    const right = labels[i].x + labels[i].width / 2 + spacing / 2;
    if (taken.every(([l, r]) => right <= l || left >= r)) {
      taken.push([left, right]);
      shown[i] = true;
    }
  }
  return shown;
}

/** Ruler ticks: a labelled step that leaves at least `minGap` pixels between labels, and a minor step under it. */
export function rulerSteps(pxPerSecond: number, minGap = 30): { major: number; minor: number } {
  const major = [1, 2, 5, 10, 15, 30, 60].find((step) => step * pxPerSecond >= minGap) ?? 60;
  const minor = major === 1 ? (pxPerSecond >= 120 ? 0.1 : 0.5) : major / 2;
  return { major, minor };
}

/**
 * The clip's gain as an SVG path in seconds (x) by gain (y, 0 at the top is
 * full volume when `height` is 1). Samples densely and at every key, so ramps
 * and fades keep their corners.
 */
export function gainPath(clip: ResolvedAudio, step = 0.02): { line: string; area: string } {
  const times = new Set<number>();
  for (let t = clip.start; t < clip.end; t += step) times.add(Math.round(t * 1e4) / 1e4);
  for (const key of clip.volume) if (key.t > clip.start && key.t < clip.end) times.add(key.t);
  if (clip.fadeIn > 0) times.add(clip.start + clip.fadeIn);
  if (clip.fadeOut > 0) times.add(clip.end - clip.fadeOut);
  const end = clip.end - 1e-6;
  times.add(end);
  const points = [...times].sort((a, b) => a - b).map((t) => [t, 1 - Math.min(1, Math.max(0, gainAt(clip, t)))] as const);
  const fmt = (n: number) => String(Math.round(n * 1e4) / 1e4);
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`).join(' ');
  const area = `M${fmt(clip.start)} 1 ${points.map(([x, y]) => `L${fmt(x)} ${fmt(y)}`).join(' ')} L${fmt(end)} 1 Z`;
  return { line, area };
}

/** Stretches of the timeline with no music playing, at least `min` seconds long. */
export function silentStretches(music: readonly ResolvedAudio[], length: number, min = 0.5): Span[] {
  const sorted = [...music].sort((a, b) => a.start - b.start);
  const stretches: Span[] = [];
  let cursor = 0;
  for (const clip of sorted) {
    if (clip.start - cursor >= min) stretches.push({ start: cursor, end: clip.start });
    cursor = Math.max(cursor, clip.end);
  }
  if (length - cursor >= min) stretches.push({ start: cursor, end: length });
  return stretches;
}
