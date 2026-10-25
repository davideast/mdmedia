import { ID_PATTERN } from './anchor.js';
import type {
  CutError,
  Performance,
  PerformanceGeneration,
  PerformanceSplit,
  ResolvedAudio,
  ResolvedLine,
  ResolvedPerformance,
  ResolvedSegment,
  ResolvedSource,
  SourceProvenance,
  SourceRef,
} from './types.js';

/**
 * Performances: the lines that must sound like one continuous delivery. The
 * resolver checks their references and reports, on each performance, where
 * it breaks the splitting rule: a sentence, and a setup with its payoff, come
 * from one generation. Nothing here reads files; an extended take's seam is
 * found from the length of the take it continued, when the resolver is given
 * lengths.
 */

const EPS = 1e-6;

/** Where a line's sound comes from, in that source's own clock. */
export interface LineSound {
  /** The source ref as written (`take:…`, a path, or `asset:…`), or null for a line with no sound file (a synth, a bed). */
  ref: SourceRef | null;
  /** The source seconds its speech spans: its words when it has them, else the whole line. */
  start: number;
  end: number;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function refOf(src: ResolvedSource): SourceRef | null {
  return 'ref' in src ? src.ref : null;
}

/** A line's sound source, and the stretch of it that its speech spans. */
export function lineSound(line: ResolvedLine, segments: readonly ResolvedSegment[], clips: readonly ResolvedAudio[]): LineSound {
  let ref: SourceRef | null = null;
  let toSource: (t: number) => number = (t) => t;
  const audio = line.audio;
  if (audio.kind === 'file') {
    ref = refOf(audio.src);
    toSource = (t) => audio.in + (t - line.start);
  } else {
    const segmentId = audio.kind === 'segment' ? audio.segment : (clips.find((c) => c.id === audio.clip)?.segment ?? null);
    const segment = segmentId === null ? undefined : segments.find((s) => s.id === segmentId);
    if (segment) {
      const own = segment.audio;
      if (own) {
        ref = refOf(own.src);
        toSource = (t) => own.in + (t - segment.start);
      }
    } else if (audio.kind === 'clip') {
      const clip = clips.find((c) => c.id === audio.clip);
      if (clip) {
        ref = refOf(clip.src);
        toSource = (t) => clip.in + (t - clip.start);
      }
    }
  }
  const words = line.words;
  const from = words.length > 0 ? Math.min(...words.map((w) => w.start)) : line.start;
  const to = words.length > 0 ? Math.max(...words.map((w) => w.end)) : line.end;
  return { ref, start: round(toSource(from)), end: round(toSource(to)) };
}

export interface PerformanceContext {
  performances: readonly Performance[];
  /** Every other item's id, so a performance can't reuse one. */
  itemIds: ReadonlySet<string>;
  lines: readonly ResolvedLine[];
  segments: readonly ResolvedSegment[];
  clips: readonly ResolvedAudio[];
  sources: Readonly<Record<SourceRef, SourceProvenance>>;
  source: (ref: SourceRef) => ResolvedSource;
  mediaLength?: (source: ResolvedSource) => number | undefined;
  fail: (error: CutError) => undefined;
}

interface Generation {
  key: string;
  part: PerformanceGeneration['part'];
  extendedFrom: SourceRef | null;
  seam: number | null;
}

/**
 * Which generation a stretch of a source is: the source itself, or, for an
 * extended take (which is the take it continued, then the new tail), the
 * original generation before the seam and the new one after it. A stretch
 * across the seam is `across`.
 */
function generationOf(ref: SourceRef, start: number, end: number, ctx: PerformanceContext, depth = 0): Generation | { across: number } {
  const provenance = ctx.sources[ref];
  // A voice swap keeps its take's timing and acting: the same generation, at the same times.
  if (provenance?.swappedFrom && depth <= 8) return generationOf(provenance.swappedFrom, start, end, ctx, depth + 1);
  const from = provenance?.extendedFrom;
  if (!from || depth > 8) return { key: ref, part: 'whole', extendedFrom: null, seam: null };
  const seam = ctx.mediaLength?.(ctx.source(from));
  if (seam === undefined) return { key: ref, part: 'unknown', extendedFrom: from, seam: null };
  if (end <= seam + EPS) {
    const inner = generationOf(from, start, end, ctx, depth + 1);
    if ('across' in inner) return inner;
    return { key: inner.key, part: 'original', extendedFrom: from, seam };
  }
  if (start >= seam - EPS) return { key: `${ref}@${round(seam)}`, part: 'extension', extendedFrom: from, seam };
  return { across: seam };
}

function quoted(text: string, max = 48): string {
  const t = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return `"${t}"`;
}

/** Checks every performance's references and works out its generations and splitting-rule problems. */
export function resolvePerformances(ctx: PerformanceContext): ResolvedPerformance[] {
  const { fail } = ctx;
  const lineById = new Map(ctx.lines.map((l) => [l.id, l]));
  const order = new Map(ctx.lines.map((l, i) => [l.id, i]));
  const owner = new Map<string, string>();
  const seen = new Set<string>();
  const out: ResolvedPerformance[] = [];

  for (const p of ctx.performances) {
    if (!ID_PATTERN.test(p.id)) {
      fail({ code: 'bad-id', id: p.id, message: `"${p.id}" isn't a valid id: use letters, digits and underscores` });
      continue;
    }
    if (seen.has(p.id) || ctx.itemIds.has(p.id)) {
      fail({ code: 'duplicate-id', id: p.id, message: `The id "${p.id}" is used more than once` });
      continue;
    }
    seen.add(p.id);

    const lines: ResolvedLine[] = [];
    let ok = true;
    for (const [i, id] of p.lines.entries()) {
      const line = lineById.get(id);
      if (!line) {
        fail({ code: 'unknown-line', id: p.id, field: `lines[${i}]`, message: `${p.id}: no line is called "${id}"` });
        ok = false;
        continue;
      }
      const other = owner.get(id);
      if (other !== undefined) {
        const message = other === p.id ? `${p.id} lists the line "${id}" twice` : `The line "${id}" is in two performances, ${other} and ${p.id}`;
        fail({ code: 'shared-line', id: p.id, field: `lines[${i}]`, message });
        ok = false;
        continue;
      }
      owner.set(id, p.id);
      lines.push(line);
    }
    if (!ok) continue;
    const ranks = lines.map((l) => order.get(l.id) ?? 0);
    const inOrder = ranks.every((r, i) => i === 0 || r > ranks[i - 1]);
    const byStart = lines.every((l, i) => i === 0 || l.start >= lines[i - 1].start - EPS);
    if (!inOrder || !byStart) {
      fail({ code: 'bad-value', id: p.id, field: 'lines', message: `${p.id}: list its lines in the order they are spoken (${lines.map((l) => l.id).join(', ')})` });
      continue;
    }

    // Generations, and where the splitting rule breaks.
    const splits: PerformanceSplit[] = [];
    const generations: PerformanceGeneration[] = [];
    for (const line of lines) {
      const sound = lineSound(line, ctx.segments, ctx.clips);
      if (sound.ref === null) continue;
      const g = generationOf(sound.ref, sound.start, sound.end, ctx);
      if ('across' in g) {
        splits.push({
          code: 'across-extend',
          lines: [line.id],
          message: `${quoted(line.text)} runs across the seam of the extended take ${sound.ref} (${round(g.across)} s): its end is a separate generation`,
        });
        continue;
      }
      if (g.part === 'unknown') {
        splits.push({
          code: 'unknown-seam',
          lines: [line.id],
          message: `${quoted(line.text)} is in ${sound.ref}, extended from ${g.extendedFrom}, whose length isn't known, so where its seam falls can't be checked`,
        });
      }
      const found = generations.find((x) => x.key === g.key);
      if (found) found.lines.push(line.id);
      else generations.push({ key: g.key, source: sound.ref, part: g.part, extendedFrom: g.extendedFrom, seam: g.seam, lines: [line.id] });
    }
    if (generations.length > 1) {
      const parts = generations.map((g) => `${g.lines.join(', ')} from ${g.part === 'extension' ? `the extension of ${g.source}` : g.source}`);
      splits.push({
        code: 'separate-generations',
        lines: lines.map((l) => l.id),
        message: `its lines come from ${generations.length} generations (${parts.join('; ')}); a sentence, and a setup with its payoff, should be one`,
      });
    }
    const speakers = [...new Set(lines.map((l) => l.speaker))];
    if (speakers.length > 1) {
      splits.push({ code: 'mixed-speakers', lines: lines.map((l) => l.id), message: `its lines are said by ${speakers.join(' and ')}; a performance is one speaker's delivery` });
    }

    out.push({
      kind: 'performance',
      id: p.id,
      label: p.label ?? p.intent ?? p.id,
      lines: lines.map((l) => l.id),
      intent: p.intent ?? null,
      delivery: p.delivery ?? null,
      speakers,
      start: Math.min(...lines.map((l) => l.start)),
      end: Math.max(...lines.map((l) => l.end)),
      thresholds: { ...p.thresholds },
      generations,
      splits,
    });
  }
  return out;
}
