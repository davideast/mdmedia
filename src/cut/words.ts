import { mediaRoot, relativeToRoot, resolveCut, type ResolveOptions } from './resolve.js';
import type { CutFile, Line, ResolvedLine, ResolvedSource, Timeline, Word } from './types.js';

/**
 * Word timings for a cut's lines, kept in a companion file next to the cut
 * (`<name>.words.json` beside `<name>.cut.json`) so the hand-written cut file
 * stays as written. `mdmedia cut words` makes it; `applyWords` puts its words
 * on a parsed cut before it is resolved, and never uses words that no longer
 * match the line. Nothing here touches the file system.
 */

/** The value of a words file's `format` field. */
export const WORDS_FORMAT = 'mdmedia.cut-words@1';

// ---------------------------------------------------------------------------
// Aligners

/** Audio for an aligner: a whole mono WAV file and its sample rate. */
export interface AlignerAudio {
  bytes: Uint8Array;
  sampleRate: number;
}

/** A word in the aligned audio's clock, with the aligner's per-word loss when it gives one. */
export interface AlignedWord extends Word {
  loss?: number;
}

export interface Alignment {
  words: AlignedWord[];
  /** The aligner's overall loss for the line: lower is a closer fit. */
  loss?: number;
}

/**
 * Finds when each word of a known transcript is spoken in a stretch of audio.
 * The words-file tooling depends only on this, never on a particular service.
 */
export interface Aligner {
  /** Recorded in the words file; a line aligned by another aligner is redone. */
  readonly name: string;
  align(audio: AlignerAudio, text: string): Promise<Alignment>;
}

/** Thrown by an aligner that can align nothing at all (no key, no permission), so a run stops instead of failing every line. */
export class AlignerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AlignerUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Each line's audio window

/** The stretch of one audio source a line is heard in, in that source's own clock. */
export interface LineWindow {
  lineId: string;
  /** `file`: the line's own sound; `segment`: a segment's audio; `clip`: a music or sfx clip's file. */
  kind: 'file' | 'segment' | 'clip';
  /** The source's absolute path, or its `asset:<id>` ref for a stored asset. */
  path: string;
  /** The source's path relative to the media root (or its `asset:<id>` ref), as the words file records it. */
  source: string;
  /** Source seconds. */
  start: number;
  end: number;
  /** Things worth a look, e.g. a line that runs on into sound from another source. */
  warnings: string[];
}

export type LineWindowResult = { ok: true; window: LineWindow } | { ok: false; reason: string };

const EPS = 1e-6;

/** Where a source's sound is read from: a file's absolute path, an asset's `asset:<id>` ref, or nothing for colors and synths. */
function soundOf(src: ResolvedSource): string | undefined {
  if (src.kind === 'file' || src.kind === 'take') return src.path;
  if (src.kind === 'asset') return src.ref;
  return undefined;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function round3(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

/**
 * Where a resolved line's sound comes from, in the source's own clock.
 *
 * - A line with its own sound is its source from the line's `in` (0 for a TTS
 *   file) for the line's resolved length, so a line cut off by `until` or its
 *   `out` stops there.
 * - A segment line is the segment's audio source from its audio in-point (plus
 *   however late the line starts in the segment), for the line's resolved
 *   length. A line that runs past its segment with `until` keeps going in the
 *   same source; when the next segments don't continue that source in step,
 *   the window says so in `warnings`.
 * - A line heard in a clip is the clip's file in the clip's clock, for the
 *   line's length; in a clip that is a segment's own sound, it is that
 *   segment's audio, as for a segment line.
 */
export function lineWindow(timeline: Timeline, line: ResolvedLine, root: string): LineWindowResult {
  const length = round6(line.end - line.start);
  if (length <= EPS) return { ok: false, reason: 'it has no length on the timeline' };

  if (line.audio.kind === 'file') {
    const path = soundOf(line.audio.src);
    if (path === undefined) return { ok: false, reason: 'its audio is not a file' };
    const start = line.audio.in;
    return {
      ok: true,
      window: { lineId: line.id, kind: 'file', path, source: relativeToRoot(root, path), start, end: round6(start + length), warnings: [] },
    };
  }

  if (line.audio.kind === 'clip') {
    const clipId = line.audio.clip;
    const clip = [...timeline.music, ...timeline.sfx].find((c) => c.id === clipId);
    if (!clip) return { ok: false, reason: `no clip is called "${clipId}"` };
    if (clip.segment !== null) return segmentWindow(timeline, line, clip.segment, root, length);
    if (clip.src.kind === 'bed') return { ok: false, reason: `its clip "${clipId}" is a bed of several parts` };
    const path = soundOf(clip.src);
    if (path === undefined) return { ok: false, reason: `its clip "${clipId}" has no sound file` };
    const start = round6(clip.in + (line.start - clip.start));
    return {
      ok: true,
      window: { lineId: line.id, kind: 'clip', path, source: relativeToRoot(root, path), start, end: round6(start + length), warnings: [] },
    };
  }
  return segmentWindow(timeline, line, line.audio.segment, root, length);
}

/** A line heard in a segment's own audio, from where the line starts in it. */
function segmentWindow(timeline: Timeline, line: ResolvedLine, segmentId: string, root: string, length: number): LineWindowResult {
  const segment = timeline.segments.find((s) => s.id === segmentId);
  if (!segment) return { ok: false, reason: `no segment is called "${segmentId}"` };
  const audio = segment.audio;
  const path = audio ? soundOf(audio.src) : undefined;
  if (!audio || path === undefined) {
    return { ok: false, reason: `its segment "${segmentId}" has no sound` };
  }
  const toSource = (t: number): number => audio.in + (t - segment.start);
  const start = round6(toSource(line.start));
  const end = round6(start + length);
  if (start < -EPS) return { ok: false, reason: `it starts before its segment's audio (${start} s in the source)` };

  const warnings: string[] = [];
  if (line.end > audio.end + EPS) {
    // Past its own segment's sound, every stretch of the line should be the same source, in step.
    const following = timeline.segments.filter((s) => s.index > segment.index && s.start < line.end - EPS);
    let covered = audio.end;
    for (const next of following) {
      if (next.start > covered + 1e-3) break;
      const a = next.audio;
      const inStep = a && soundOf(a.src) === path && Math.abs(a.in - toSource(next.start)) < 1e-3;
      if (!inStep) {
        warnings.push(`it runs past "${segmentId}" into "${next.id}", whose sound isn't the same take in step; the words are timed to the take alone`);
        covered = line.end;
        break;
      }
      covered = a.end;
    }
    if (covered < line.end - 1e-3) {
      warnings.push(`its sound stops at ${round3(covered)} s, before the line ends at ${round3(line.end)} s`);
    }
  }
  return { ok: true, window: { lineId: line.id, kind: 'segment', path, source: relativeToRoot(root, path), start, end, warnings } };
}

/** Every line's window, by line id, in the cut's line order. */
export function lineWindows(timeline: Timeline, root: string): Map<string, LineWindowResult> {
  return new Map(timeline.lines.map((line) => [line.id, lineWindow(timeline, line, root)]));
}

/** A token says something when it has a letter or a number: not blank, not just "..." or "—". */
function isSpoken(token: string): boolean {
  return /[\p{L}\p{N}]/u.test(token);
}

/**
 * Moves words aligned within a window back into the source's own clock,
 * dropping blank and punctuation-only entries (an aligner can return "..."
 * as a zero-length word).
 */
export function toSourceClock(alignment: Alignment, window: Pick<LineWindow, 'start'>): AlignedWord[] {
  return alignment.words
    .filter((w) => isSpoken(w.text))
    .map((w) => {
      const word: AlignedWord = { text: w.text.trim(), start: round3(window.start + w.start), end: round3(window.start + w.end) };
      if (w.loss !== undefined) word.loss = round3(w.loss);
      return word;
    });
}

/** The words a line's text has: runs of non-space that contain a letter or digit. "TURBO... BOOST!" has two. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(isSpoken).length;
}

// ---------------------------------------------------------------------------
// The words file

/** What was aligned: the source (relative to the media root), the window in its clock, and its contents' hash. */
export interface WordsFingerprint {
  source: string;
  start: number;
  end: number;
  /** SHA-256 of the source file's bytes, hex. */
  sha256: string;
  /** The method that snapped the first word to the speech onset (`SNAP_METHOD`), when one did. */
  snap?: string;
}

/**
 * How a line's first word was snapped to where its speech starts, in the
 * source's own clock: the aligner's start, the start kept, the onset measured
 * (null when none was found), and the window's background level in dBFS.
 * `start` equals `aligned` when the onset didn't qualify.
 */
export interface FirstWordSnap {
  aligned: number;
  start: number;
  onset: number | null;
  floor: number;
}

export interface LineWordsEntry {
  /** The line's text when it was aligned. */
  text: string;
  /** The aligner's name. */
  aligner: string;
  fingerprint: WordsFingerprint;
  /** The aligner's overall loss, or null when it gives none. */
  loss: number | null;
  /**
   * The words are approximate: the line is sung, so its first word wasn't
   * snapped and its loss says little. Absent for spoken lines.
   */
  approximate?: true;
  /** How the first word was snapped to the speech onset, when it was measured. */
  snap?: FirstWordSnap;
  /** In the source's own clock, as `Line.words`. The first word's start is the snapped one. */
  words: AlignedWord[];
}

export interface WordsFile {
  format: typeof WORDS_FORMAT;
  /** By line id. */
  lines: Record<string, LineWordsEntry>;
}

export type WordsFileResult = { ok: true; value: WordsFile } | { ok: false; message: string };

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readEntry(value: unknown, id: string): LineWordsEntry | string {
  if (!isObj(value)) return `lines.${id}: expected an object`;
  const { text, aligner, fingerprint, loss, snap, words, approximate } = value;
  if (approximate !== undefined && approximate !== true) return `lines.${id}.approximate: expected true, or nothing`;
  if (typeof text !== 'string') return `lines.${id}.text: expected a string`;
  if (typeof aligner !== 'string') return `lines.${id}.aligner: expected a string`;
  if (!isObj(fingerprint)) return `lines.${id}.fingerprint: expected an object`;
  const { source, start, end, sha256, snap: method } = fingerprint;
  if (typeof source !== 'string' || !isNum(start) || !isNum(end) || typeof sha256 !== 'string' || (method !== undefined && typeof method !== 'string')) {
    return `lines.${id}.fingerprint: expected source, start, end, sha256 and an optional snap`;
  }
  if (loss !== null && !isNum(loss)) return `lines.${id}.loss: expected a number or null`;
  let snapped: FirstWordSnap | undefined;
  if (snap !== undefined) {
    const bad = `lines.${id}.snap: expected { aligned, start, onset, floor }`;
    if (!isObj(snap)) return bad;
    const { aligned, start: kept, onset, floor } = snap;
    if (!isNum(aligned) || !isNum(kept) || (onset !== null && !isNum(onset)) || !isNum(floor)) return bad;
    snapped = { aligned, start: kept, onset: isNum(onset) ? onset : null, floor };
  }
  if (!Array.isArray(words)) return `lines.${id}.words: expected an array`;
  const read: AlignedWord[] = [];
  for (const [i, w] of words.entries()) {
    if (!isObj(w) || typeof w.text !== 'string' || !isNum(w.start) || !isNum(w.end) || (w.loss !== undefined && !isNum(w.loss))) {
      return `lines.${id}.words[${i}]: expected { text, start, end, loss? }`;
    }
    const word: AlignedWord = { text: w.text, start: w.start, end: w.end };
    if (isNum(w.loss)) word.loss = w.loss;
    read.push(word);
  }
  const entry: LineWordsEntry = { text, aligner, fingerprint: { source, start, end, sha256 }, loss: isNum(loss) ? loss : null, words: read };
  if (typeof method === 'string') entry.fingerprint.snap = method;
  if (approximate === true) entry.approximate = true;
  if (snapped) entry.snap = snapped;
  return entry;
}

/** Checks parsed JSON has a words file's shape. */
export function parseWordsFile(json: unknown): WordsFileResult {
  if (!isObj(json)) return { ok: false, message: 'expected an object' };
  if (json.format !== WORDS_FORMAT) return { ok: false, message: `format: expected "${WORDS_FORMAT}"` };
  if (!isObj(json.lines)) return { ok: false, message: 'lines: expected an object' };
  const lines: Record<string, LineWordsEntry> = {};
  for (const [id, value] of Object.entries(json.lines)) {
    const entry = readEntry(value, id);
    if (typeof entry === 'string') return { ok: false, message: entry };
    lines[id] = entry;
  }
  return { ok: true, value: { format: WORDS_FORMAT, lines } };
}

/**
 * The words file as pretty JSON, the same bytes for the same content: lines in
 * `order` (then any others by id), fields in a fixed order, one word per line.
 */
export function serializeWordsFile(file: WordsFile, order: readonly string[] = []): string {
  const ids = [...order.filter((id) => id in file.lines), ...Object.keys(file.lines).filter((id) => !order.includes(id)).sort()];
  const word = (w: AlignedWord): string =>
    `{ "text": ${JSON.stringify(w.text)}, "start": ${w.start}, "end": ${w.end}${w.loss === undefined ? '' : `, "loss": ${w.loss}`} }`;
  const entries = ids.map((id) => {
    const e = file.lines[id];
    const f = e.fingerprint;
    const words = e.words.length === 0 ? '[]' : `[\n${e.words.map((w) => `        ${word(w)}`).join(',\n')}\n      ]`;
    return [
      `    ${JSON.stringify(id)}: {`,
      `      "text": ${JSON.stringify(e.text)},`,
      `      "aligner": ${JSON.stringify(e.aligner)},`,
      `      "fingerprint": { "source": ${JSON.stringify(f.source)}, "start": ${f.start}, "end": ${f.end}, "sha256": ${JSON.stringify(f.sha256)}${f.snap === undefined ? '' : `, "snap": ${JSON.stringify(f.snap)}`} },`,
      `      "loss": ${e.loss === null ? 'null' : e.loss},`,
      ...(e.approximate ? ['      "approximate": true,'] : []),
      ...(e.snap ? [`      "snap": { "aligned": ${e.snap.aligned}, "start": ${e.snap.start}, "onset": ${e.snap.onset === null ? 'null' : e.snap.onset}, "floor": ${e.snap.floor} },`] : []),
      `      "words": ${words}`,
      '    }',
    ].join('\n');
  });
  const lines = entries.length === 0 ? '{}' : `{\n${entries.join(',\n')}\n  }`;
  return `{\n  "format": ${JSON.stringify(WORDS_FORMAT)},\n  "lines": ${lines}\n}\n`;
}

// ---------------------------------------------------------------------------
// Staleness and merging

export type EntryCheck = { fresh: true } | { fresh: false; reason: string };

/**
 * Whether a line's stored words still belong to it: same text, same source,
 * same window and, when `sha256` is given, the same file contents. With an
 * `aligner` name, a line aligned by a different aligner is not fresh either,
 * and with a `snap` method, nor is one whose first word was snapped by another
 * method or not at all. A `snap` of null means the line is sung: its words
 * must be unsnapped and marked approximate.
 */
export function checkEntry(
  entry: LineWordsEntry,
  current: { text: string; window: LineWindow; sha256?: string; aligner?: string; snap?: string | null },
): EntryCheck {
  const f = entry.fingerprint;
  if (entry.text !== current.text) return { fresh: false, reason: 'its text changed' };
  if (f.source !== current.window.source) return { fresh: false, reason: `its audio is now ${current.window.source}, not ${f.source}` };
  if (Math.abs(f.start - current.window.start) > EPS || Math.abs(f.end - current.window.end) > EPS) {
    return { fresh: false, reason: `its window moved from ${f.start}–${f.end} s to ${current.window.start}–${current.window.end} s` };
  }
  if (current.sha256 !== undefined && f.sha256 !== current.sha256) return { fresh: false, reason: `${f.source} changed` };
  if (current.aligner !== undefined && entry.aligner !== current.aligner) return { fresh: false, reason: `it was aligned by ${entry.aligner}` };
  if (current.snap === null) {
    if (f.snap !== undefined || entry.approximate !== true) return { fresh: false, reason: 'it is sung, so its words are approximate and its first word unsnapped' };
  } else if (current.snap !== undefined && f.snap !== current.snap) {
    return { fresh: false, reason: f.snap === undefined ? "its first word wasn't snapped to the speech onset" : `its first word was snapped by ${f.snap}` };
  }
  return { fresh: true };
}

/** The fingerprint for a window, its source's hash and, when the first word was snapped, the snapping method. */
export function fingerprintOf(window: LineWindow, sha256: string, snap?: string): WordsFingerprint {
  const fingerprint: WordsFingerprint = { source: window.source, start: window.start, end: window.end, sha256 };
  if (snap !== undefined) fingerprint.snap = snap;
  return fingerprint;
}

export interface ApplyWordsOptions extends ResolveOptions {
  /**
   * The SHA-256 (hex) of a source file by absolute path (or by `asset:<id>`
   * ref for a stored asset), or undefined when it can't be read. Without it, or for an unreadable file, words are checked
   * by text, source and window only and the line is listed as `unchecked`.
   */
  sha256?: (path: string) => string | undefined;
}

export interface WordsMerge {
  /** The cut with each fresh line's words in place, ready for `resolveCut`. */
  cut: CutFile;
  /** Lines that got words from the file. */
  applied: string[];
  /** Lines whose stored words no longer match; they get no words. */
  stale: Array<{ id: string; reason: string }>;
  /** Applied lines whose audio file couldn't be read, so its contents weren't compared. */
  unchecked: string[];
}

/**
 * Puts a words file's words on a parsed cut, before it is resolved. A line
 * whose text, window or audio no longer matches its entry gets no words at
 * all and is reported as stale; a line with no entry keeps what it has.
 * When the cut doesn't resolve, it is returned unchanged for `resolveCut` to
 * report its errors.
 */
export function applyWords(cut: CutFile, file: WordsFile, options: ApplyWordsOptions = {}): WordsMerge {
  const merge: WordsMerge = { cut, applied: [], stale: [], unchecked: [] };
  const resolved = resolveCut(cut, options);
  if (!resolved.ok || !cut.lines) return merge;
  const windows = lineWindows(resolved.value, mediaRoot(cut, options));

  const lines = cut.lines.map((line): Line => {
    const entry = file.lines[line.id];
    if (!entry) return line;
    const window = windows.get(line.id);
    let check: EntryCheck;
    let checked = false;
    if (!window?.ok) {
      check = { fresh: false, reason: window ? window.reason : 'it is not on the timeline' };
    } else {
      const sha256 = options.sha256?.(window.window.path);
      checked = sha256 !== undefined;
      check = checkEntry(entry, { text: line.text, window: window.window, sha256 });
    }
    if (!check.fresh) {
      merge.stale.push({ id: line.id, reason: check.reason });
      const bare = { ...line };
      delete bare.words;
      return bare;
    }
    merge.applied.push(line.id);
    if (!checked) merge.unchecked.push(line.id);
    return { ...line, words: entry.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) };
  });
  merge.cut = { ...cut, lines };
  return merge;
}
