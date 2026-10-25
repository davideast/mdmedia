#!/usr/bin/env bun
/**
 * Builds the context bundle for one review thread: everything an agent needs
 * to act on it, in one file.
 *
 *   bun scripts/thread-context.ts <media root>/sim/productions/big-hal/threads/t1-personally.json
 *
 * Writes `<id>.context.json` beside the thread. It reads the thread, its cut
 * and words (`docs/cuts`, merged as Studio's loader merges them), the
 * production's decision log (`../decisions/decisions.json`), the production
 * manifest (`docs/productions/<production>.production.json`), and the
 * production's working files in the media root: `gens.log`, the storyboards in
 * `review/storyboards`, the edit script the cut was ported from and the
 * `SCRIPT.md` beside it, `review/manifest.json` and `review/shows.json`, and
 * the takes. Whatever it needs and can't find in stored data goes in the
 * bundle's `missing` list with where it lives now.
 *
 * The output depends only on those files: running it again writes the same bytes.
 * The media root is `MDMEDIA_CUT_MEDIA_ROOT`, else `~/.local/share/mdmedia/productions/crt-tv`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimeRef } from '../src/cut/anchor.js';
import { findFfmpeg, HIGH_LOSS, loadCutWithWords, readWordsFile, sha256File } from '../src/cut/align.js';
import type { CutFile, ResolvedLine, ResolvedSegment, ResolvedSource, Timeline } from '../src/cut/types.js';
import type { WordsFile } from '../src/cut/words.js';
import { lineGaps, spokenLines, spokenSpan, type Gap } from '../src/threads/anchor.js';
import type {
  BundleClip,
  BundleCut,
  BundleGap,
  BundleLine,
  BundleSegment,
  ContextBundle,
  DecisionLog,
  ItemRef,
  Message,
  Missing,
  SnapshotWord,
  Suggestion,
  TakeProvenance,
  Thread,
} from '../src/threads/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.resolve(process.env.MDMEDIA_CUT_MEDIA_ROOT ?? path.join(homedir(), '.local', 'share', 'mdmedia', 'productions', 'crt-tv'));

// ---------------------------------------------------------------------------
// Small helpers

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await readText(file);
  return text === null ? null : (JSON.parse(text) as T);
}

async function mtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** A path under the media root, written relative to it when it is inside. */
const rel = (file: string): string => (file.startsWith(MEDIA_ROOT + path.sep) ? path.relative(MEDIA_ROOT, file) : file);

function takeName(src: ResolvedSource): string | null {
  return src.kind === 'take' ? src.name : null;
}

function srcLabel(src: ResolvedSource): string {
  switch (src.kind) {
    case 'take':
      return `take:${src.name}`;
    case 'file':
      return rel(src.path);
    case 'color':
      return `color:${src.color}`;
    case 'asset':
      return `asset:${src.id}`;
    case 'synth':
      return `synth:${src.synth.kind}`;
  }
}

/** Seconds of a video, read from ffmpeg's banner. */
function probeDuration(ffmpeg: string, file: string): number | null {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(run.stderr ?? '');
  return m ? round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
}

/**
 * JSON with small objects and arrays on one line, so a bundle reads top to
 * bottom without a line per word.
 */
function pretty(value: unknown, indent = ''): string {
  const flat = JSON.stringify(value);
  if (flat === undefined) return 'null';
  if (flat.length <= 110 || value === null || typeof value !== 'object') return flat;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => next + pretty(v, next)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${pretty(v, next)}`).join(',\n')}\n${indent}}`;
}

// ---------------------------------------------------------------------------
// The generation log: `gens.log` lines such as
//   2026-10-18T23:57:33-07:00 shot hal5-pat (4 s) -> hal5-pat-t1 hal5/stills/hood-insert.png
//   2026-10-18T17:21:51-07:00 extend big-hal-4a-t2 + ad-big-hal-4b (6 s) -> big-hal-4ab-t1
//   2026-10-18T15:02:21-07:00 gen ad-big-hal -> big-hal-t1

interface GenEntry {
  at: string;
  step: 'shot' | 'extend' | 'gen';
  board: string;
  seconds: number | null;
  take: string;
  firstFrame: string | null;
  extends: string | null;
}

function parseGens(text: string): { entries: GenEntry[]; interactions: number } {
  const entries: GenEntry[] = [];
  let interactions = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s+interaction /.test(line)) interactions++;
    let m = /^(\S+) shot (\S+) \((\d+(?:\.\d+)?) s\) -> (\S+)(?: (\S+))?$/.exec(line);
    if (m) {
      entries.push({ at: m[1], step: 'shot', board: m[2], seconds: Number(m[3]), take: m[4], firstFrame: m[5] ?? null, extends: null });
      continue;
    }
    m = /^(\S+) extend (\S+) \+ (\S+) \((\d+(?:\.\d+)?) s\) -> (\S+)$/.exec(line);
    if (m) {
      entries.push({ at: m[1], step: 'extend', board: m[3], seconds: Number(m[4]), take: m[5], firstFrame: null, extends: m[2] });
      continue;
    }
    m = /^(\S+) gen (\S+) -> (\S+)$/.exec(line);
    if (m) entries.push({ at: m[1], step: 'gen', board: m[2], seconds: null, take: m[3], firstFrame: null, extends: null });
  }
  return { entries, interactions };
}

// ---------------------------------------------------------------------------
// The hand-written edit script a cut was ported from (`Ported from hal5/edit.mjs.` in its notes)

interface EditScript {
  path: string;
  /** Source key (`pat`) to take name (`hal5-pat-t1`). */
  keys: Map<string, string>;
  /** Source key to its measured-words line, comment and all. */
  measured: Map<string, string>;
  lines: string[];
}

function parseEditScript(file: string, text: string): EditScript {
  const lines = text.split('\n');
  const block = (name: string): string[] => {
    const start = lines.findIndex((l) => l.startsWith(`const ${name} = {`));
    if (start < 0) return [];
    const end = lines.findIndex((l, i) => i > start && /^\};/.test(l));
    return lines.slice(start, end < 0 ? start + 1 : end + 1);
  };
  const keys = new Map<string, string>();
  for (const m of block('src').join('\n').matchAll(/(\w+): T\("([^"]+)"\)/g)) keys.set(m[1], m[2]);
  const measured = new Map<string, string>();
  for (const l of block('W')) {
    const m = /^\s*(\w+): \{/.exec(l);
    if (m) measured.set(m[1], l.trim());
  }
  return { path: file, keys, measured, lines };
}

/** The comments above each edit step that uses `key`'s take. */
function editNotesFor(script: EditScript, key: string): string[] {
  const notes: string[] = [];
  script.lines.forEach((l, i) => {
    if (!/\bseg\(/.test(l) || !l.includes(`"${key}"`) || l.trim().startsWith('function')) return;
    // Comments from the line after the previous step (or the previous blank line) down to this one, trailing ones included.
    const comments: string[] = [];
    for (let j = i; j >= 0; j--) {
      const line = script.lines[j];
      if (j < i && (/\bseg\(/.test(line) || line.trim() === '')) break;
      const m = /^\s*\/\/\s?(.*)$/.exec(line) ?? /\S.*?\s\/\/\s?(.*)$/.exec(line);
      if (m) comments.unshift(m[1]);
    }
    const note = comments.join(' ');
    if (note && !notes.includes(note)) notes.push(note);
  });
  return notes;
}

// ---------------------------------------------------------------------------
// Production notes (`SCRIPT.md` beside the edit script): table rows that name a take or a shot

function scriptRows(text: string, needles: string[]): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[\s|-]+\|$/.test(l) && !/^\| #/.test(l))
    .filter((l) => needles.some((n) => l.includes(n)))
    .map((l) => l.replace(/\s+/g, ' ').trim());
}

/** Letters and digits only, lower case, single spaces: for finding a line's words in prose. */
const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------------------

interface Context {
  thread: Thread;
  threadPath: string;
  productionDir: string;
  cutPath: string;
  cut: CutFile;
  timeline: Timeline;
  words: WordsFile | null;
  ffmpeg: string | null;
  missing: Missing[];
}

function addMissing(ctx: Context, need: string, where: string, about?: string[]): void {
  const key = `${need}\0${where}`;
  const existing = ctx.missing.find((m) => `${m.need}\0${m.where}` === key);
  if (existing) {
    if (about) existing.about = [...new Set([...(existing.about ?? []), ...about])].sort();
    return;
  }
  ctx.missing.push({ need, where, ...(about ? { about: [...about].sort() } : {}) });
}

function bundleSegment(s: ResolvedSegment): BundleSegment {
  return {
    id: s.id,
    label: s.label,
    start: s.start,
    end: s.end,
    take: takeName(s.src),
    in: s.in,
    out: s.out,
    hold: s.hold,
    audio: s.audio ? { take: takeName(s.audio.src), in: s.audio.in, out: s.audio.out } : null,
  };
}

/** The item a line's voice is heard from. A segment line voiced by a sound effect names it in its `at` or `until`. */
function voiceOf(ctx: Context, line: ResolvedLine): BundleLine['voice'] {
  const audio = line.audio;
  if (audio.kind === 'file') return { kind: 'line', id: line.id, take: takeName(audio.src) };
  const raw = ctx.cut.lines?.find((l) => l.id === line.id);
  const span = spokenSpan(line);
  for (const ref of [raw?.at, raw?.until]) {
    if (typeof ref !== 'string') continue;
    const parsed = parseTimeRef(ref);
    if (parsed?.kind !== 'anchor') continue;
    const name = parsed.target;
    const sfx = ctx.timeline.sfx.find((x) => x.id === name);
    if (sfx && sfx.start <= span.start + 1e-6 && sfx.end >= span.end - 0.1) return { kind: 'sfx', id: sfx.id, take: takeName(sfx.src) };
  }
  const segment = ctx.timeline.segments.find((s) => s.id === audio.segment);
  return { kind: 'segment', id: audio.segment, take: segment?.audio ? takeName(segment.audio.src) : null };
}

function bundleLine(ctx: Context, line: ResolvedLine, anchored: boolean): BundleLine {
  const entry = ctx.words?.lines[line.id];
  const voice = voiceOf(ctx, line);
  const spoken = line.words.length > 0 ? spokenSpan(line) : null;
  if (!spoken) addMissing(ctx, `word timings for line "${line.id}"`, 'not in the words file, or stale', [line.id]);
  if (entry && voice.take && path.basename(entry.fingerprint.source, '.mp4') !== voice.take) {
    addMissing(
      ctx,
      `word timings for "${line.text}" from the audio it is heard in (${voice.take}, via ${voice.kind} ${voice.id})`,
      `the words file aligned it against ${entry.fingerprint.source} (its segment's own sound, loss ${entry.loss}), so its word times are a guess; the real times are only in ${ctx.cut.meta.notes?.match(/Ported from (\S+?\.mjs)/)?.[1] ?? 'the edit script'}'s hand-measured constants`,
      [line.id],
    );
  } else if (entry && entry.loss !== null && entry.loss > HIGH_LOSS) {
    addMissing(ctx, `reliable word timings for "${line.text}"`, `the words file's alignment has loss ${entry.loss} (over ${HIGH_LOSS})`, [line.id]);
  }
  return {
    id: line.id,
    anchored,
    speaker: line.speaker,
    text: line.text,
    start: line.start,
    end: line.end,
    spoken,
    segment: line.audio.kind === 'segment' ? line.audio.segment : null,
    voice,
    words: line.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    alignment: entry ? { source: entry.fingerprint.source, window: [entry.fingerprint.start, entry.fingerprint.end], loss: entry.loss } : null,
  };
}

const bundleGap = (g: Gap): BundleGap => ({ id: g.id, from: g.from, to: g.to, start: g.start, end: g.end, length: g.length });

function bundleClip(ctx: Context, ref: ItemRef): BundleClip | null {
  if (ref.kind === 'overlay') {
    const o = ctx.timeline.overlays.find((x) => x.id === ref.id);
    return o ? { id: o.id, kind: 'overlay', label: o.label, start: o.start, end: o.end, src: srcLabel(o.src) } : null;
  }
  if (ref.kind === 'music' || ref.kind === 'sfx') {
    const list = ref.kind === 'music' ? ctx.timeline.music : ctx.timeline.sfx;
    const c = list.find((x) => x.id === ref.id);
    return c ? { id: c.id, kind: ref.kind, label: c.label, start: c.start, end: c.end, src: srcLabel(c.src), in: c.in, out: c.out } : null;
  }
  return null;
}

/** Every spoken word on the timeline, in order. */
function allWords(timeline: Timeline): SnapshotWord[] {
  return spokenLines(timeline)
    .flatMap(({ line }) => line.words.map((w) => ({ line: line.id, text: w.text, start: w.start, end: w.end })))
    .sort((a, b) => a.start - b.start);
}

function cutBetween(timeline: Timeline, from: ResolvedSegment, to: ResolvedSegment): BundleCut {
  const words = allWords(timeline);
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

// ---------------------------------------------------------------------------

async function build(threadPath: string): Promise<ContextBundle> {
  const thread = (await readJson<Thread>(threadPath)) ?? (() => { throw new Error(`No thread at ${threadPath}`); })();
  const productionDir = path.dirname(path.dirname(threadPath));
  const cutPath = path.join(REPO, 'docs', 'cuts', `${thread.version.cutId}.cut.json`);
  const loaded = await loadCutWithWords(cutPath, { root: MEDIA_ROOT });
  const words = await readWordsFile(path.join(REPO, 'docs', 'cuts', `${thread.version.cutId}.words.json`));
  const ffmpeg = await findFfmpeg().catch(() => null);
  const ctx: Context = { thread, threadPath, productionDir, cutPath, cut: loaded.cut, timeline: loaded.timeline, words, ffmpeg, missing: [] };
  const { timeline, cut } = ctx;
  const meta = timeline.meta;

  if (loaded.merge.stale.length > 0) {
    addMissing(ctx, 'fresh word timings', `stale in the words file: ${loaded.merge.stale.map((s) => `${s.id} (${s.reason})`).join('; ')}`);
  }
  const unchanged = (await sha256File(cutPath)) === thread.version.cutSha256;

  // --- The anchored items ----------------------------------------------------
  const gaps = lineGaps(timeline);
  const refs = thread.anchor.items;
  const anchoredSegments = refs.filter((r) => r.kind === 'segment').map((r) => timeline.segments.find((s) => s.id === r.id)).filter((s): s is ResolvedSegment => !!s);
  const anchoredLines = refs.filter((r) => r.kind === 'line').map((r) => timeline.lines.find((l) => l.id === r.id)).filter((l): l is ResolvedLine => !!l);
  const anchoredGaps = refs.filter((r) => r.kind === 'gap').map((r) => gaps.find((g) => g.id === r.id)).filter((g): g is Gap => !!g);
  const clips = refs.map((r) => bundleClip(ctx, r)).filter((c): c is BundleClip => c !== null);
  for (const r of refs) {
    const known =
      (r.kind === 'segment' && anchoredSegments.some((s) => s.id === r.id)) ||
      (r.kind === 'line' && anchoredLines.some((l) => l.id === r.id)) ||
      (r.kind === 'gap' && anchoredGaps.some((g) => g.id === r.id)) ||
      clips.some((c) => c.id === r.id);
    if (!known) addMissing(ctx, `anchored ${r.kind} "${r.id}"`, `not in ${thread.version.cutId} as it is now`, [r.id]);
  }

  // --- Neighbours ------------------------------------------------------------
  const spoken = spokenLines(timeline);
  const neighbourSegments = anchoredSegments.map((s) => {
    const before = timeline.segments[s.index - 1] ?? null;
    const after = timeline.segments[s.index + 1] ?? null;
    const cuts: BundleCut[] = [];
    if (before) cuts.push(cutBetween(timeline, before, s));
    if (after) cuts.push(cutBetween(timeline, s, after));
    return { of: s.id, before: before ? bundleSegment(before) : null, after: after ? bundleSegment(after) : null, cuts };
  });
  const neighbourLines = anchoredLines.map((l) => {
    const i = spoken.findIndex((x) => x.line.id === l.id);
    const before = spoken[i - 1]?.line ?? null;
    const after = spoken[i + 1]?.line ?? null;
    const gapBefore = before ? gaps.find((g) => g.to === l.id) : undefined;
    const gapAfter = after ? gaps.find((g) => g.from === l.id) : undefined;
    return {
      of: l.id,
      before: before?.id ?? null,
      after: after?.id ?? null,
      gapBefore: gapBefore ? bundleGap(gapBefore) : null,
      gapAfter: gapAfter ? bundleGap(gapAfter) : null,
    };
  });
  const anchoredLineIds = new Set(anchoredLines.map((l) => l.id));
  const lineIds = new Set([...anchoredLineIds, ...neighbourLines.flatMap((n) => [n.before, n.after]).filter((id): id is string => id !== null)]);
  const lines = spoken.filter(({ line }) => lineIds.has(line.id)).map(({ line }) => bundleLine(ctx, line, anchoredLineIds.has(line.id)));

  // --- Provenance ------------------------------------------------------------
  const usedBy = new Map<string, Set<string>>();
  const use = (take: string | null, by: string): void => {
    if (!take) return;
    if (!usedBy.has(take)) usedBy.set(take, new Set());
    usedBy.get(take)?.add(by);
  };
  const provenanceSegments = [...anchoredSegments, ...neighbourSegments.flatMap((n) => [n.before, n.after])]
    .filter((s): s is BundleSegment | ResolvedSegment => s !== null)
    .map((s) => timeline.segments.find((x) => x.id === s.id))
    .filter((s): s is ResolvedSegment => !!s);
  for (const s of provenanceSegments) {
    use(takeName(s.src), `segment:${s.id}`);
    if (s.audio) use(takeName(s.audio.src), `segment:${s.id} (sound)`);
  }
  for (const c of clips) if (c.src.startsWith('take:')) use(c.src.slice(5), `${c.kind}:${c.id}`);
  for (const l of anchoredLines) {
    const v = voiceOf(ctx, l);
    if (v.kind !== 'segment') use(v.take, `line:${l.id} (voice, via ${v.kind}:${v.id})`);
  }

  const gensText = (await readText(path.join(MEDIA_ROOT, 'gens.log'))) ?? '';
  if (!gensText) addMissing(ctx, 'the generation log', 'no gens.log in the media root');
  const gens = parseGens(gensText);
  const genOf = (take: string): GenEntry | null => [...gens.entries].reverse().find((e) => e.take === take) ?? null;

  const editScriptName = meta.notes?.match(/Ported from (\S+?\.mjs)/)?.[1] ?? null;
  const editText = editScriptName ? await readText(path.join(MEDIA_ROOT, editScriptName)) : null;
  const edit = editScriptName && editText ? parseEditScript(editScriptName, editText) : null;
  if (!edit) addMissing(ctx, 'the edit this cut was ported from', editScriptName ? `${editScriptName} is not in the media root` : 'the cut does not say');
  const workDir = edit ? path.dirname(edit.path) : null;
  const scriptNotesPath = workDir ? path.join(workDir, 'SCRIPT.md') : null;
  const scriptText = scriptNotesPath ? await readText(path.join(MEDIA_ROOT, scriptNotesPath)) : null;
  if (!scriptText) addMissing(ctx, 'the production notes for this version', scriptNotesPath ? `no ${scriptNotesPath}` : 'not recorded anywhere');

  const storyboardPath = (board: string): string => path.join('review', 'storyboards', `${board}.md`);
  const storyboardMatches = async (board: string, loggedAt: string): Promise<boolean> => {
    const m = await mtime(path.join(MEDIA_ROOT, storyboardPath(board)));
    return m !== null && m <= Date.parse(loggedAt);
  };
  const staleBoard = (board: string): string =>
    `${storyboardPath(board)} was edited after these takes were generated, and storyboards are overwritten in place: the text that made them is not recorded anywhere (gens.log names the file, not its contents)`;
  const contactSheet = (take: string): string | null => {
    if (!workDir) return null;
    const p = path.join(workDir, 'review', `${take}-01.png`);
    return existsSync(path.join(MEDIA_ROOT, p)) ? p : null;
  };

  const stills: Record<string, string> = {};
  const takes: Record<string, string> = {};
  const provenance: TakeProvenance[] = [];
  for (const take of [...usedBy.keys()].sort()) {
    const file = path.join(MEDIA_ROOT, 'takes', `${take}.mp4`);
    const exists = existsSync(file);
    takes[take] = file;
    const gen = genOf(take);
    if (!gen) addMissing(ctx, `how ${take} was generated`, 'not in gens.log', [take]);
    let estimatedSeconds: number | null = null;
    if (gen && exists) {
      const m = await mtime(file);
      const secs = m === null ? null : Math.round((m - Date.parse(gen.at)) / 1000);
      estimatedSeconds = secs !== null && secs > 0 && secs < 3600 ? secs : null;
    }
    let storyboard: TakeProvenance['storyboard'] = null;
    if (gen) {
      const text = await readText(path.join(MEDIA_ROOT, storyboardPath(gen.board)));
      if (text === null) addMissing(ctx, `the storyboard that made ${take}`, `gens.log names ${gen.board}, but ${storyboardPath(gen.board)} is gone`, [take]);
      else {
        const matchesTake = await storyboardMatches(gen.board, gen.at);
        storyboard = { path: storyboardPath(gen.board), matchesTake, text: text.trim() };
        if (!matchesTake) addMissing(ctx, `the storyboard text that made earlier takes of ${gen.board}`, staleBoard(gen.board), [take]);
      }
      if (gen.firstFrame) {
        stills[gen.firstFrame] = path.join(MEDIA_ROOT, gen.firstFrame);
        const made = gens.entries.length > 0 && gensText.includes(`image ${gen.firstFrame}`);
        if (!made) {
          const prose = scriptText?.includes(path.basename(gen.firstFrame));
          addMissing(
            ctx,
            'how the first-frame stills were made (source take, time, crop)',
            prose && scriptNotesPath
              ? `only in ${scriptNotesPath} prose ("Every new shot starts from a still of Take 4, using the clean source take big-hal-4ab-t2 (no graphics) at 0.1 s, either whole or cropped"); the crop is not recorded anywhere`
              : 'not recorded anywhere',
            [gen.firstFrame],
          );
        }
      }
    }
    const key = edit ? [...edit.keys.entries()].find(([, t]) => t === take)?.[0] : undefined;
    const others = gen
      ? gens.entries.filter((e) => e.board === gen.board && e.take !== take).sort((a, b) => a.take.localeCompare(b.take))
      : [];
    const otherTakes = await Promise.all(
      others.map(async (e) => ({
        take: e.take,
        exists: existsSync(path.join(MEDIA_ROOT, 'takes', `${e.take}.mp4`)),
        loggedAt: e.at,
        seconds: e.seconds,
        firstFrame: e.firstFrame,
        storyboardMatches: await storyboardMatches(e.board, e.at),
        contactSheet: contactSheet(e.take),
      })),
    );
    for (const o of otherTakes) {
      if (o.exists) takes[o.take] = path.join(MEDIA_ROOT, 'takes', `${o.take}.mp4`);
      if (!o.storyboardMatches && gen) addMissing(ctx, `the storyboard text that made earlier takes of ${gen.board}`, staleBoard(gen.board), [o.take]);
    }
    const rows = scriptText && gen ? scriptRows(scriptText, [take, `\`${gen.board}\``]) : [];
    provenance.push({
      take,
      usedBy: [...(usedBy.get(take) ?? [])].sort(),
      path: file,
      exists,
      duration: exists && ffmpeg ? probeDuration(ffmpeg, file) : null,
      shot: gen?.board ?? null,
      generation: gen
        ? { step: gen.step, seconds: gen.seconds, firstFrame: gen.firstFrame, extends: gen.extends, loggedAt: gen.at, estimatedSeconds }
        : null,
      storyboard,
      editNotes: edit && key ? editNotesFor(edit, key) : [],
      measured: edit && key ? (edit.measured.get(key) ?? null) : null,
      scriptNotes: rows,
      contactSheet: contactSheet(take),
      otherTakes,
    });
  }

  // --- Earlier versions' storyboards with the same lines ---------------------
  const showTakes = gens.entries.filter((e) => meta.show && e.take.startsWith(`${meta.show}-`));
  const thisCutsBoards = new Set(provenance.map((p) => p.shot));
  const earlier: ContextBundle['earlier'] = [];
  for (const l of anchoredLines) {
    const needle = plain(l.text);
    let found: { e: GenEntry; text: string } | null = null;
    for (const e of showTakes) {
      if (thisCutsBoards.has(e.board)) continue;
      const text = await readText(path.join(MEDIA_ROOT, storyboardPath(e.board)));
      if (text && plain(text).includes(needle) && (!found || e.at >= found.e.at)) found = { e, text };
    }
    if (!found) continue;
    const hit = found;
    const existing = earlier.find((x) => x.storyboard === storyboardPath(hit.e.board));
    if (existing) {
      if (!existing.lines.includes(l.id)) existing.lines.push(l.id);
      continue;
    }
    const step = hit.e.step === 'extend' ? `extend of ${hit.e.extends} by ${hit.e.seconds} s` : `${hit.e.step} (${hit.e.seconds ?? '?'} s)`;
    const inThisCut = timeline.segments.filter((s) => takeName(s.src) === hit.e.take).map((s) => `segment:${s.id} plays ${s.in} to ${s.out} of it`);
    earlier.push({ take: hit.e.take, storyboard: storyboardPath(hit.e.board), step, lines: [l.id], inThisCut, text: hit.text.trim() });
  }
  if (earlier.length > 0) {
    addMissing(ctx, 'which production version each earlier take belongs to', 'not recorded anywhere; found here by take name prefix, storyboard text and gens.log time', earlier.map((e) => e.take));
  }

  // --- Decisions -------------------------------------------------------------
  const decisionsPath = path.join(productionDir, 'decisions', 'decisions.json');
  const log = (await readJson<DecisionLog>(decisionsPath)) ?? { production: thread.production, decisions: [], constraints: [] };
  if (log.decisions.length === 0) addMissing(ctx, 'the decision log', `no ${decisionsPath}`);
  const keywords = [...anchoredLines.map((l) => l.id), ...anchoredSegments.map((s) => s.id), ...provenance.map((p) => p.take)];
  const relevant = log.decisions
    .filter((d) => keywords.some((k) => new RegExp(`\\b${k.replace(/[-_]/g, '[-_ ]?')}\\b`, 'i').test(`${d.decision} ${d.quote ?? ''}`)))
    .map((d) => d.id);
  const versionNumber = /^Take \d+/.exec(meta.version ?? '')?.[0];
  if (versionNumber && !log.decisions.some((d) => d.source === 'owner' && new RegExp(`^${versionNumber}(\\b(?! ->)|$)`).test(d.take))) {
    addMissing(ctx, `the owner's own verdict on ${versionNumber} before these threads`, `not recorded anywhere; the decision log's ${versionNumber} entries are briefs and agent reports, and Studio's status is still "review"`);
  }

  // --- History and the version's other names ----------------------------------
  interface ReviewClip { show?: string; take?: string; note?: string; file?: string }
  interface ProductionManifest { cuts?: Array<{ id: string; label: string; status?: string; notes?: string; cut?: string; rendered?: string }> }
  const reviewManifest = (await readJson<{ clips: ReviewClip[] }>(path.join(MEDIA_ROOT, 'review', 'manifest.json')))?.clips ?? [];
  const reviewEntry = reviewManifest.find((c) => c.show === meta.show && c.take === meta.version) ?? null;
  const shows = (await readJson<{ shows: Array<{ key: string; summary?: string; status?: string }> }>(path.join(MEDIA_ROOT, 'review', 'shows.json')))?.shows ?? [];
  const show = shows.find((s) => s.key === meta.show) ?? null;
  const manifestPath = path.join(REPO, 'docs', 'productions', `${thread.production}.production.json`);
  const productionManifest = await readJson<ProductionManifest>(manifestPath);
  const relCut = path.relative(REPO, cutPath);
  const studioCut = productionManifest?.cuts?.find((c) => c.cut === relCut) ?? null;
  const aliases: Record<string, string> = {};
  if (studioCut) aliases.studio = `productions/${thread.production}/cuts/${studioCut.id}`;
  if (reviewEntry?.file) aliases.reviewPage = `review/${reviewEntry.file}`;
  if (studioCut || reviewEntry) {
    addMissing(
      ctx,
      'one id for this version',
      `the thread says ${thread.version.cutId} (the cut file), Studio's production manifest says ${studioCut?.id ?? '?'}, the review page has no id and is matched by show and take label ("${meta.version}") to ${reviewEntry?.file ?? '?'}`,
    );
  }
  if (!reviewEntry) addMissing(ctx, 'the review page note for this version', 'no review/manifest.json entry matches the cut\'s show and version');
  const versions = (productionManifest?.cuts ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status ?? 'none',
    kind: (c.cut ? 'cut' : 'rendered') as 'cut' | 'rendered',
    render: c.rendered ?? (c.cut ? rel(timeline.output ?? '') : null),
  }));
  const previous = versions[versions.findIndex((v) => v.id === studioCut?.id) - 1];
  if (previous?.kind === 'rendered') {
    addMissing(
      ctx,
      `word and shot timings for the previous version (${previous.label}), to compare the same lines`,
      `it is a rendered-only cut with no cut or words file; its line times are only in ${scriptNotesPath ?? 'the production notes'} prose and its manifest note`,
    );
  }

  // --- Media: the snapshot, and first and last frames of the shots around it -
  const frames: ContextBundle['media']['frames'] = [];
  const frameDir = path.join(productionDir, 'snapshots', thread.id);
  const crop = thread.snapshot.crop;
  const framed = [...new Map(provenanceSegments.map((s) => [s.id, s])).values()].sort((a, b) => a.start - b.start);
  if (ffmpeg) {
    await mkdir(frameDir, { recursive: true });
    for (const s of framed) {
      if (s.src.kind !== 'take' && s.src.kind !== 'file') continue;
      const fps = meta.fps ?? 24;
      for (const [at, srcTime] of [['in', s.in], ['out', Math.max(s.in, s.out - 1 / fps)]] as const) {
        const out = path.join(frameDir, `${s.id}-${at}.png`);
        const filters = [
          ...(s.crop ? [`crop=${s.crop.width}:${s.crop.height}:${s.crop.x}:${s.crop.y}`] : []),
          `scale=${meta.width ?? 1280}:${meta.height ?? 720}`,
          `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
        ];
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', srcTime.toFixed(3), '-i', s.src.path, '-frames:v', '1', '-vf', filters.join(','), '-map_metadata', '-1', '-bitexact', out]);
        frames.push({ segment: s.id, at, time: at === 'in' ? s.start : round(s.start + (srcTime - s.in)), path: out });
      }
    }
  }

  // --- What the stored data doesn't say ---------------------------------------
  const anyTake = provenance.find((p) => p.generation?.step === 'shot');
  if (anyTake) {
    const shotScript = await readText(path.join(MEDIA_ROOT, 'shot.mjs'));
    const model = shotScript?.match(/"(gemini-[\w.-]+)"/)?.[1];
    const aspect = shotScript?.match(/aspectRatio: "([\d:]+)"/)?.[1];
    addMissing(
      ctx,
      'each take\'s generation settings (model, aspect, provider request)',
      model ? `not per take: gens.log records storyboard, length and still only; the model (${model}) and aspect (${aspect ?? '?'}) are only in shot.mjs code` : 'not recorded anywhere',
      provenance.map((p) => p.take),
    );
  }
  if (gens.interactions > 0) {
    addMissing(ctx, 'the provider request id for each take', 'gens.log logs interaction ids after each parallel batch, in finishing order, not tied to a take', provenance.map((p) => p.take));
  }
  if (workDir) {
    const logs = (await readdir(path.join(MEDIA_ROOT, workDir)).catch(() => [] as string[])).filter((f) => /^log-.*\.txt$/.test(f)).sort();
    const failed: string[] = [];
    for (const f of logs) if ((await readText(path.join(MEDIA_ROOT, workDir, f)))?.includes('Permission denied')) failed.push(f);
    if (logs.length > 0 && failed.length === logs.length) {
      addMissing(ctx, 'per-take generation output', `${workDir}/log-*.txt only hold a failed first run ("shot.sh: Permission denied"); later runs' output was not kept`);
    }
    const stt = await readText(path.join(MEDIA_ROOT, workDir, 'stt-t1.txt'));
    addMissing(
      ctx,
      'whole-take transcripts with word times (what each take says outside the cut\'s in and out)',
      `not recorded: the words file aligns only each line's window in the cut${stt !== null && stt.trim() === '' ? `, ${workDir}/stt-t1.txt is empty` : ''}, and ${edit?.path ?? 'the edit script'} keeps a few hand-measured word times per take`,
      provenance.map((p) => p.take),
    );
  }
  if (provenance.some((p) => p.scriptNotes.length > 0)) {
    addMissing(ctx, 'which takes of each shot were circled or rejected, and why', `only in ${scriptNotesPath} prose tables and the review page note; there are no take records`, provenance.map((p) => p.take));
  }
  addMissing(ctx, 'which shot a segment belongs to', 'not recorded: the cut names a take, and the shot (storyboard) is found by matching the take name in gens.log');
  addMissing(
    ctx,
    'what each generation cost (money and wall time)',
    'not recorded anywhere; gens.log has start times only, so provenance gives a rough estimatedSeconds from each take file\'s modification time',
  );
  if (edit) {
    addMissing(
      ctx,
      'a way to render a changed cut',
      `nothing renders a cut yet (docs/cut-format.md); ${timeline.output ? rel(timeline.output) : 'the render'} was made by ${edit.path}, and this cut is a port of it, so an applied change must edit both or wait for a renderer`,
    );
  }
  if (!existsSync(path.join(MEDIA_ROOT, 'cast'))) {
    const speakers = [...new Set(anchoredLines.map((l) => l.speaker))].join(', ');
    addMissing(ctx, `a canonical description and reference stills for ${speakers}`, 'not recorded: each storyboard re-types the character; the only references are the first-frame stills');
  }
  addMissing(ctx, 'the target running time for the piece', 'not recorded anywhere (Take 3\'s review note mentions "the 16 to 18 asked"; this version runs ' + `${timeline.length} s)`);
  addMissing(ctx, 'which view the owner watched (the TV\'s 4:3 or the full 16:9)', `not recorded: no UI yet; the snapshot assumes ${thread.snapshot.view}`);

  const writeTo = {
    messages: path.join(productionDir, 'threads', thread.id, 'messages'),
    suggestions: path.join(productionDir, 'threads', thread.id, 'suggestions'),
  };
  const readDir = async <T>(dir: string): Promise<T[]> => {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
    return (await Promise.all(files.map((f) => readJson<T>(path.join(dir, f))))).filter((x): x is Awaited<T> & T => x !== null);
  };

  return {
    format: 'mdmedia.thread-context@1',
    thread,
    messages: await readDir<Message>(writeTo.messages),
    suggestions: await readDir<Suggestion>(writeTo.suggestions),
    writeTo,
    version: {
      cutId: thread.version.cutId,
      aliases,
      cutFile: cutPath,
      unchanged,
      title: meta.title ?? '',
      label: meta.version ?? '',
      length: timeline.length,
      fps: meta.fps ?? null,
      size: `${meta.width ?? '?'}x${meta.height ?? '?'}`,
      notes: meta.notes ?? null,
      render: { path: timeline.output ?? '', madeBy: edit?.path ?? null },
    },
    anchored: {
      segments: anchoredSegments.map(bundleSegment),
      lines: anchoredLines.map((l) => l.id),
      gaps: anchoredGaps.map(bundleGap),
      clips,
    },
    lines,
    neighbours: { segments: neighbourSegments, lines: neighbourLines },
    provenance,
    earlier,
    decisions: { ...log, relevant },
    history: {
      status: studioCut?.status ?? show?.status ?? 'unknown',
      note: reviewEntry?.note ?? studioCut?.notes ?? '',
      showSummary: show?.summary ?? null,
      versions,
    },
    media: {
      root: MEDIA_ROOT,
      ffmpeg,
      snapshot: path.join(productionDir, thread.snapshot.frame),
      render: timeline.output ?? '',
      takes: Object.fromEntries(Object.entries(takes).sort(([a], [b]) => a.localeCompare(b))),
      stills: Object.fromEntries(Object.entries(stills).sort(([a], [b]) => a.localeCompare(b))),
      frames,
    },
    missing: ctx.missing,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: bun scripts/thread-context.ts <thread.json> [more…]');
    process.exit(2);
  }
  for (const arg of args) {
    const threadPath = path.resolve(arg);
    const bundle = await build(threadPath);
    const out = path.join(path.dirname(threadPath), `${bundle.thread.id}.context.json`);
    const text = `${pretty(bundle)}\n`;
    await writeFile(out, text);
    console.log(`${bundle.thread.id}: ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB, ${bundle.missing.length} missing -> ${out}`);
  }
}

await main();
