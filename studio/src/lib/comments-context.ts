/**
 * The one-call context bundle for an agent acting on a thread: the thread and
 * its whole conversation, the version it was made on with the anchored items
 * and their neighbours (lines with their words, the gaps, the cuts between
 * shots and the words either side), the decision log, the production's
 * versions, and the media by asset id.
 *
 * Ported from `scripts/thread-context.ts`, which read the working files in
 * the media root. Studio stores cuts with their sources as assets and keeps
 * none of those files, so what they held is listed in `missing`, with where
 * it lives now.
 */

import type { CutFile, ResolvedLine, ResolvedSegment, ResolvedSource, Timeline, WordsFile } from 'mdmedia/cut';
import {
  lineGaps,
  spokenLines,
  spokenSpan,
  type BundleClip,
  type BundleCut,
  type BundleGap,
  type BundleLine,
  type BundleSegment,
  type ContextBundle,
  type Gap,
  type Missing,
  type SnapshotWord,
} from 'mdmedia/threads';
import { getThread, listDecisions } from './comments-server';
import { getProduction, getProductionCut } from './productions-server';

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function sourceOf(src: ResolvedSource): string {
  switch (src.kind) {
    case 'asset':
      return `asset:${src.id}`;
    case 'color':
      return `color:${src.color}`;
    case 'take':
      return `take:${src.name}`;
    case 'file':
      return src.path;
    case 'synth':
      return `synth:${src.synth.kind}`;
    case 'bed':
      return `bed:${src.parts} parts`;
  }
}

class Collector {
  readonly missing: Missing[] = [];
  add(need: string, where: string, about?: string[]): void {
    const existing = this.missing.find((m) => m.need === need && m.where === where);
    if (existing) {
      if (about) existing.about = [...new Set([...(existing.about ?? []), ...about])].sort();
      return;
    }
    this.missing.push({ need, where, ...(about ? { about: [...about].sort() } : {}) });
  }
}

function bundleSegment(s: ResolvedSegment, thumbs: Record<string, string>): BundleSegment {
  return {
    id: s.id,
    label: s.label,
    start: s.start,
    end: s.end,
    source: sourceOf(s.src),
    in: s.in,
    out: s.out,
    hold: s.hold,
    audio: s.audio ? { source: sourceOf(s.audio.src), in: s.audio.in, out: s.audio.out } : null,
    thumbnailAssetId: thumbs[s.id] ?? null,
  };
}

function bundleLine(line: ResolvedLine, anchored: boolean, words: WordsFile | null, missing: Collector): BundleLine {
  const entry = words?.lines[line.id];
  const spoken = line.words.length > 0 ? spokenSpan(line) : null;
  if (!spoken) missing.add(`word timings for line "${line.id}"`, 'not in the words file, or stale', [line.id]);
  else if (entry && entry.loss !== null && entry.loss > 0.5) missing.add(`reliable word timings for "${line.text}"`, `the words file's alignment has loss ${entry.loss}`, [line.id]);
  return {
    id: line.id,
    anchored,
    speaker: line.speaker,
    text: line.text,
    start: line.start,
    end: line.end,
    spoken,
    segment: line.audio.kind === 'segment' ? line.audio.segment : null,
    assetId: line.audio.kind === 'file' && line.audio.src.kind === 'asset' ? line.audio.src.id : null,
    words: line.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    alignment: entry ? { source: entry.fingerprint.source, window: [entry.fingerprint.start, entry.fingerprint.end], loss: entry.loss } : null,
  };
}

const bundleGap = (g: Gap): BundleGap => ({ id: g.id, from: g.from, to: g.to, start: g.start, end: g.end, length: g.length });

function allWords(timeline: Timeline): SnapshotWord[] {
  return spokenLines(timeline)
    .flatMap(({ line }) => line.words.map((w) => ({ line: line.id, text: w.text, start: w.start, end: w.end })))
    .sort((a, b) => a.start - b.start);
}

function cutBetween(words: SnapshotWord[], from: ResolvedSegment, to: ResolvedSegment): BundleCut {
  const at = to.start;
  const before = [...words].reverse().find((w) => w.end <= at + 1e-6) ?? null;
  const after = words.find((w) => w.start >= at - 1e-6) ?? null;
  return {
    at,
    from: from.id,
    to: to.id,
    lastWordBefore: before ? { ...before, before: round(at - before.end) } : null,
    firstWordAfter: after ? { ...after, after: round(after.start - at) } : null,
  };
}

/** Builds the bundle for one thread from Studio's data. */
export async function threadContext(uid: string, productionId: string, threadId: string, origin: string): Promise<ContextBundle> {
  const missing = new Collector();
  const production = await getProduction(uid, productionId, origin);
  const { thread, messages, suggestions } = await getThread(uid, productionId, threadId, origin);
  const { id, productionId: pid, version, anchor, snapshot: shot, text, author, status, claim, createdAt, updatedAt } = thread;
  const stored = { id, productionId: pid, version, anchor, snapshot: shot, text, author, status, claim, createdAt, updatedAt };
  const cut = await getProductionCut(uid, productionId, thread.version.cutId, origin).catch(() => null);
  const timeline = cut?.timeline ?? null;
  const cutFile = cut?.cut as CutFile | null | undefined;
  const words = (cut?.words ?? null) as WordsFile | null;
  const meta: Partial<NonNullable<CutFile['meta']>> = timeline?.meta ?? cutFile?.meta ?? {};
  if (!cut) missing.add(`the version "${thread.version.cutId}"`, 'deleted from the production since the comment was made');
  else if (!timeline) missing.add('the version\'s timeline', cut.kind === 'rendered' ? 'it is a rendered video only, with no cut file' : `it no longer resolves: ${cut.errors.map((e) => e.message).join('; ')}`);
  for (const stale of cut?.wordsSummary?.stale ?? []) missing.add('fresh word timings', `stale in the words file: ${stale.id} (${stale.reason})`, [stale.id]);

  // --- The anchored items, as the cut is now ---------------------------------
  const gaps = timeline ? lineGaps(timeline) : [];
  const refs = thread.anchor.items;
  const segments = timeline?.segments ?? [];
  const anchoredSegments = refs.filter((r) => r.kind === 'segment').map((r) => segments.find((s) => s.id === r.id)).filter((s): s is ResolvedSegment => !!s);
  const anchoredLines = refs.filter((r) => r.kind === 'line').map((r) => timeline?.lines.find((l) => l.id === r.id)).filter((l): l is ResolvedLine => !!l);
  const anchoredGaps = refs.filter((r) => r.kind === 'gap').map((r) => gaps.find((g) => g.id === r.id)).filter((g): g is Gap => !!g);
  const clips: BundleClip[] = [];
  for (const r of refs) {
    if (r.kind === 'overlay') {
      const o = timeline?.overlays.find((x) => x.id === r.id);
      if (o) clips.push({ id: o.id, kind: 'overlay', label: o.label, start: o.start, end: o.end, source: sourceOf(o.src) });
    } else if (r.kind === 'music' || r.kind === 'sfx') {
      const c = (r.kind === 'music' ? timeline?.music : timeline?.sfx)?.find((x) => x.id === r.id);
      if (c) clips.push({ id: c.id, kind: r.kind, label: c.label, start: c.start, end: c.end, source: sourceOf(c.src), in: c.in, out: c.out });
    }
  }
  if (timeline) {
    for (const r of refs) {
      const known =
        (r.kind === 'segment' && anchoredSegments.some((s) => s.id === r.id)) ||
        (r.kind === 'line' && anchoredLines.some((l) => l.id === r.id)) ||
        (r.kind === 'gap' && anchoredGaps.some((g) => g.id === r.id)) ||
        clips.some((c) => c.id === r.id);
      if (!known) missing.add(`anchored ${r.kind} "${r.id}"`, `not in ${thread.version.cutId} as it is now`, [r.id]);
    }
  }

  // --- Neighbours ------------------------------------------------------------
  const thumbs = cut?.thumbs ?? {};
  const spoken = timeline ? spokenLines(timeline) : [];
  const everyWord = timeline ? allWords(timeline) : [];
  const neighbourSegments = anchoredSegments.map((s) => {
    const before = segments[s.index - 1] ?? null;
    const after = segments[s.index + 1] ?? null;
    const cuts: BundleCut[] = [];
    if (before) cuts.push(cutBetween(everyWord, before, s));
    if (after) cuts.push(cutBetween(everyWord, s, after));
    return { of: s.id, before: before ? bundleSegment(before, thumbs) : null, after: after ? bundleSegment(after, thumbs) : null, cuts };
  });
  const neighbourLines = anchoredLines.map((l) => {
    const i = spoken.findIndex((x) => x.line.id === l.id);
    const before = spoken[i - 1]?.line ?? null;
    const after = spoken[i + 1]?.line ?? null;
    const gapBefore = before ? gaps.find((g) => g.to === l.id) : undefined;
    const gapAfter = after ? gaps.find((g) => g.from === l.id) : undefined;
    return { of: l.id, before: before?.id ?? null, after: after?.id ?? null, gapBefore: gapBefore ? bundleGap(gapBefore) : null, gapAfter: gapAfter ? bundleGap(gapAfter) : null };
  });
  const anchoredIds = new Set(anchoredLines.map((l) => l.id));
  const lineIds = new Set([...anchoredIds, ...neighbourLines.flatMap((n) => [n.before, n.after]).filter((id): id is string => id !== null)]);
  const lines = spoken.filter(({ line }) => lineIds.has(line.id)).map(({ line }) => bundleLine(line, anchoredIds.has(line.id), words, missing));

  // --- Decisions -------------------------------------------------------------
  const log = await listDecisions(uid, productionId, origin);
  if (log.decisions.length === 0) missing.add('the decision log', 'none recorded for this production yet (`mdmedia comments decide`)');
  const keywords = [...anchoredLines.map((l) => l.id), ...anchoredSegments.map((s) => s.id)];
  const relevant = log.decisions
    .filter((d) => d.threadIds.includes(threadId) || d.cutIds.includes(thread.version.cutId) || keywords.some((k) => new RegExp(`\\b${k.replace(/[-_]/g, '[-_ ]?')}\\b`, 'i').test(`${d.text} ${d.quote ?? ''}`)))
    .map((d) => d.id);
  for (const s of suggestions) for (const id of [...s.keeps, ...s.overturns]) if (!relevant.includes(id) && log.decisions.some((d) => d.id === id)) relevant.push(id);

  // --- History and media -------------------------------------------------------
  const versions = production.cuts.map((c) => ({ id: c.id, label: c.label, status: c.status, kind: c.kind, renderAssetId: c.renderedAssetId, current: c.id === thread.version.cutId }));
  const here = production.cuts.find((c) => c.id === thread.version.cutId);
  const previews = [...new Set(suggestions.flatMap((s) => s.previews.map((p) => p.assetId)))];
  const render = cut?.renderedAssetId ?? null;
  const snapshot = thread.snapshot?.frameAssetId ?? null;
  const links: Record<string, string> = {};
  for (const id of [render, snapshot, ...previews, ...Object.values(thumbs)]) if (id) links[id] = `${origin}/api/v1/assets/${id}/content`;
  // The takes and sounds the anchored and neighbouring items play.
  const sources = [
    ...anchoredSegments.map((s) => bundleSegment(s, thumbs)),
    ...neighbourSegments.flatMap((n) => [n.before, n.after]),
  ].flatMap((s) => (s ? [s.source, s.audio?.source] : []));
  for (const source of [...sources, ...clips.map((c) => c.source), ...lines.map((l) => (l.assetId ? `asset:${l.assetId}` : null))]) {
    if (source?.startsWith('asset:')) links[source.slice(6)] = `${origin}/api/v1/assets/${source.slice(6)}/content`;
  }

  // --- What Studio's data doesn't say ------------------------------------------
  const sourceFile = cut?.source?.cut ?? null;
  missing.add(
    'how each take was generated (shot, storyboard, first-frame still, model, request id)',
    'not in Studio: a cut names its takes as uploaded assets, and the generation log, storyboards and stills stay in the media root (gens.log, review/storyboards)',
    anchoredSegments.map((s) => s.id),
  );
  missing.add('the other takes of each shot, and why they were circled or rejected', 'not in Studio: only in the production notes (SCRIPT.md tables) and the review page note');
  missing.add('which shot a segment belongs to', 'not recorded: the cut names an asset, and the take\'s name is only in the cut file it was pushed from' + (sourceFile ? ` (${sourceFile})` : ''));
  missing.add('first and last frames of the anchored shots', 'not stored: Studio keeps one first-frame thumbnail per segment (`thumbnailAssetId`); take others from the render');
  missing.add('whole-take transcripts with word times', 'not recorded: the words file aligns only each line\'s window in the cut');
  missing.add('what each generation cost (money and wall time)', 'not recorded anywhere');
  missing.add('a way to render a changed cut', 'nothing renders a cut yet (docs/cut-format.md); an applied change is rendered outside Studio and pushed as a new version');
  missing.add('a canonical description and reference stills for the speakers', 'not recorded: no characters in Studio yet');
  missing.add('the target running time for the piece', `not recorded anywhere; this version runs ${timeline?.length ?? cut?.lengthSeconds ?? '?'} s`);
  if (!snapshot) missing.add('a still of what the commenter saw', 'none was taken with this comment');
  if (cut && thread.version.cutUpdatedAt !== null && cut.updatedAt > thread.version.cutUpdatedAt) {
    missing.add('the cut as it was when the comment was made', 'replaced since; the anchor\'s items keep their times from then');
  }

  return {
    format: 'mdmedia.thread-context@2',
    thread: stored,
    messages,
    suggestions,
    writeTo: {
      messages: `${thread.links.self}/messages`,
      suggestions: `${thread.links.self}/suggestions`,
      claim: `${thread.links.self}/claim`,
      status: thread.links.self,
    },
    production: { id: production.id, title: production.title, slug: production.slug },
    version: {
      cutId: thread.version.cutId,
      label: here?.label ?? thread.version.cutId,
      unchanged: Boolean(cut && thread.version.cutUpdatedAt !== null && cut.updatedAt <= thread.version.cutUpdatedAt),
      title: typeof meta.title === 'string' ? meta.title : production.title,
      length: timeline?.length ?? cut?.lengthSeconds ?? 0,
      fps: typeof meta.fps === 'number' ? meta.fps : null,
      size: `${meta.width ?? '?'}x${meta.height ?? '?'}`,
      notes: cut?.notes || (typeof meta.notes === 'string' ? meta.notes : null),
      renderAssetId: render,
      sourceFile,
    },
    anchored: { segments: anchoredSegments.map((s) => bundleSegment(s, thumbs)), lines: anchoredLines.map((l) => l.id), gaps: anchoredGaps.map(bundleGap), clips },
    lines,
    neighbours: { segments: neighbourSegments, lines: neighbourLines },
    decisions: { decisions: log.decisions, constraints: log.constraints, relevant },
    history: { status: here?.status ?? 'unknown', note: cut?.notes ?? here?.notes ?? '', versions },
    media: { render, snapshot, previews, links },
    missing: missing.missing,
  };
}
