import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SNAP_METHOD, measureAlignerAudio, snapFirstWord, type OnsetMeasurement } from './onset.js';
import { loadCutSource } from './extend.js';
import { mediaRoot, resolveCut } from './resolve.js';
import type { CutError, CutFile, Timeline } from './types.js';
import {
  AlignerUnavailableError,
  WORDS_FORMAT,
  applyWords,
  checkEntry,
  countWords,
  fingerprintOf,
  lineWindow,
  parseWordsFile,
  serializeWordsFile,
  toSourceClock,
  type Aligner,
  type AlignerAudio,
  type FirstWordSnap,
  type LineWindow,
  type LineWordsEntry,
  type WordsFile,
  type WordsMerge,
} from './words.js';

/**
 * The file-system side of word timings: reading and writing a cut's words
 * file, cutting each line's audio window out with ffmpeg, and running an
 * `Aligner` over the lines that need it. Used by `mdmedia cut words`.
 */

const execute = promisify(execFile);

/** Mono, 16 kHz: all an aligner needs, and small to upload. */
export const ALIGN_SAMPLE_RATE = 16_000;

/**
 * A line whose overall loss is above this is worth checking by ear. From the
 * Night Wagon cuts: Buddy's clean TTS lines align at about 0.56–0.62 and Rick's
 * on-camera lines at about 0.73, while the shouted "TURBO… BOOST!" comes back
 * at about 1.03.
 */
export const HIGH_LOSS = 0.9;

/** `<name>.words.json` next to `<name>.cut.json`. */
export function wordsFilePath(cutPath: string): string {
  const base = cutPath.endsWith('.cut.json') ? cutPath.slice(0, -'.cut.json'.length) : cutPath.replace(/\.json$/, '');
  return `${base}.words.json`;
}

/** The ffmpeg to run: FFMPEG_PATH, else the bundled ffmpeg-static when installed, else `ffmpeg` on the PATH. */
export async function findFfmpeg(env: Record<string, string | undefined> = process.env): Promise<string> {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  try {
    const bundled: { default: string | null } = await import('ffmpeg-static');
    if (bundled.default) return bundled.default;
  } catch {
    // Not installed; use the one on the PATH.
  }
  return 'ffmpeg';
}

/** Cuts `start`–`end` (source seconds) out of a media file as a mono 16 kHz 16-bit WAV. */
export async function extractWindow(file: string, start: number, end: number, ffmpeg?: string): Promise<AlignerAudio> {
  const bin = ffmpeg ?? (await findFfmpeg());
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-align-'));
  const out = path.join(dir, 'window.wav');
  try {
    // -ss after -i decodes from the start, so the window begins on the exact sample.
    await execute(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-ss', start.toFixed(6), '-t', (end - start).toFixed(6),
        '-vn', '-ac', '1', '-ar', String(ALIGN_SAMPLE_RATE), '-c:a', 'pcm_s16le', out],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return { bytes: new Uint8Array(await readFile(out)), sampleRate: ALIGN_SAMPLE_RATE };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** SHA-256 of a file's bytes, hex. */
export async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** A cut's words file, or null when it has none. */
export async function readWordsFile(file: string): Promise<WordsFile | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  const parsed = parseWordsFile(json);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.message}`);
  return parsed.value;
}

function cutErrors(file: string, errors: CutError[]): Error {
  return new Error(`${file} has errors:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new Error(`No cut file at ${file}.`);
    throw new Error(`${file} is not valid JSON.`);
  }
}

/**
 * Reads and parses a cut file. A cut that `extends` another is merged onto
 * its base, `<name>.cut.json` in the same folder, so the result is always a
 * full cut.
 */
export async function readCutFile(cutPath: string): Promise<CutFile> {
  const dir = path.dirname(path.resolve(cutPath));
  const name = path.basename(cutPath).replace(/\.cut\.json$|\.json$/, '');
  const parsed = await loadCutSource(await readJson(cutPath), (base) => readJson(path.join(dir, `${base}.cut.json`)), { name });
  if (!parsed.ok) throw cutErrors(cutPath, parsed.errors);
  return parsed.value;
}

/** Hashes each file once per run. */
function hashCache(hash: (file: string) => Promise<string>): { get: (file: string) => Promise<string>; known: (file: string) => string | undefined } {
  const done = new Map<string, string>();
  return {
    get: async (file) => {
      const cached = done.get(file);
      if (cached !== undefined) return cached;
      const value = await hash(file);
      done.set(file, value);
      return value;
    },
    known: (file) => done.get(file),
  };
}

export interface LoadedCutWithWords {
  cut: CutFile;
  timeline: Timeline;
  merge: WordsMerge;
  wordsPath: string;
  /** False when the cut has no words file. */
  hasWordsFile: boolean;
}

/** Reads a cut and its words file, applies the fresh words, and resolves it. */
export async function loadCutWithWords(cutPath: string, options: { root?: string } = {}): Promise<LoadedCutWithWords> {
  const cut = await readCutFile(cutPath);
  const cutDir = path.dirname(path.resolve(cutPath));
  const wordsPath = wordsFilePath(cutPath);
  const words = await readWordsFile(wordsPath);
  const hashes = hashCache(sha256File);
  if (words) {
    for (const entry of Object.values(words.lines)) {
      const file = path.join(mediaRoot(cut, { root: options.root, cutDir }), entry.fingerprint.source);
      await hashes.get(file).catch(() => undefined);
    }
  }
  const merge = words
    ? applyWords(cut, words, { root: options.root, cutDir, sha256: hashes.known })
    : { cut, applied: [], stale: [], unchecked: [] };
  const resolved = resolveCut(merge.cut, { root: options.root, cutDir });
  if (!resolved.ok) throw cutErrors(cutPath, resolved.errors);
  return { cut, timeline: resolved.value, merge, wordsPath, hasWordsFile: words !== null };
}

export type LineStatus = 'fresh' | 'aligned' | 'stale';

export interface LineReport {
  id: string;
  speaker: string;
  text: string;
  /** `fresh`: its stored words still match. `aligned`: aligned this run. `stale`: it has no usable words; see `reason`. */
  status: LineStatus;
  reason?: string;
  loss: number | null;
  /** Aligned words, and the words in the line's text. */
  words: number;
  textWords: number;
  /** From the first word's start to the last word's end, on the timeline. */
  speech: { start: number; end: number } | null;
  /** How its first word was snapped to the speech onset, in the source's clock, when it was measured. */
  snap?: FirstWordSnap;
  window: LineWindow | null;
  warnings: string[];
}

export interface AlignCutOptions {
  cutPath: string;
  aligner: Aligner;
  /** Overrides the cut's `media.root`. */
  root?: string;
  /** Realign every line, even fresh ones. */
  force?: boolean;
  /** Cuts a window out of its source. Default: ffmpeg, mono 16 kHz WAV. */
  extract?: (window: LineWindow) => Promise<AlignerAudio>;
  /** Hashes a source file. Default: SHA-256 of its bytes. */
  hash?: (file: string) => Promise<string>;
  /** Measures where speech starts in a window's audio. Default: `measureAlignerAudio` (speech-band onset of a PCM WAV). */
  measureOnset?: (audio: AlignerAudio) => OnsetMeasurement;
  /** Called as each line is done. */
  onLine?: (report: LineReport) => void;
}

export interface AlignCutResult {
  wordsPath: string;
  /** False when the words file already said exactly this. */
  written: boolean;
  timeline: Timeline;
  lines: LineReport[];
}

/**
 * Gives every line of a cut word timings from `aligner`, keeping lines whose
 * stored words still match (unless `force`), and writes the cut's words file.
 * An aligner that can align nothing stops the run; the lines already aligned
 * are saved first.
 */
export async function alignCutWords(options: AlignCutOptions): Promise<AlignCutResult> {
  const { cutPath, aligner, root, force = false } = options;
  const cut = await readCutFile(cutPath);
  const cutDir = path.dirname(path.resolve(cutPath));
  const resolved = resolveCut(cut, { root, cutDir });
  if (!resolved.ok) throw cutErrors(cutPath, resolved.errors);
  const timeline = resolved.value;
  const base = mediaRoot(cut, { root, cutDir });
  const wordsPath = wordsFilePath(cutPath);
  const existing = await readWordsFile(wordsPath);
  const hashes = hashCache(options.hash ?? sha256File);
  const extract = options.extract ?? ((w: LineWindow) => extractWindow(w.path, w.start, w.end));
  const measureOnset = options.measureOnset ?? measureAlignerAudio;
  const order = timeline.lines.map((l) => l.id);
  const next: WordsFile = { format: WORDS_FORMAT, lines: {} };

  /** Writes the words file when its contents changed; true when it did. */
  const save = async (): Promise<boolean> => {
    const text = serializeWordsFile(next, order);
    const before = await readFile(wordsPath, 'utf8').catch(() => null);
    if (before === text) return false;
    await writeFile(wordsPath, text);
    return true;
  };

  const reports: LineReport[] = [];
  for (const [i, line] of timeline.lines.entries()) {
    const report: LineReport = {
      id: line.id, speaker: line.speaker, text: line.text, status: 'stale', loss: null,
      words: 0, textWords: countWords(line.text), speech: null, window: null, warnings: [],
    };
    reports.push(report);
    const windowResult = lineWindow(timeline, line, base);
    if (!windowResult.ok) {
      report.reason = windowResult.reason;
      options.onLine?.(report);
      continue;
    }
    const window = windowResult.window;
    report.window = window;
    report.warnings.push(...window.warnings);

    let sha256: string;
    try {
      sha256 = await hashes.get(window.path);
    } catch {
      report.reason = `can't read ${window.path}`;
      options.onLine?.(report);
      continue;
    }

    const old = existing?.lines[line.id];
    let entry: LineWordsEntry | undefined;
    if (old && !force && checkEntry(old, { text: line.text, window, sha256, aligner: aligner.name, snap: SNAP_METHOD }).fresh) {
      entry = old;
      report.status = 'fresh';
    } else {
      try {
        const audio = await extract(window);
        const alignment = await aligner.align(audio, line.text);
        let words = toSourceClock(alignment, window);
        // The aligner starts first words late; move each line's first word back to the speech onset measured in the same audio.
        let snap: FirstWordSnap | null = null;
        let method: string | undefined;
        try {
          ({ words, snap } = snapFirstWord(words, measureOnset(audio), window.start));
          method = SNAP_METHOD;
        } catch (error) {
          report.warnings.push(`couldn't measure where its speech starts, so its first word is as aligned (${error instanceof Error ? error.message : String(error)})`);
        }
        entry = {
          text: line.text,
          aligner: aligner.name,
          fingerprint: fingerprintOf(window, sha256, method),
          loss: alignment.loss === undefined ? null : Math.round(alignment.loss * 1e3) / 1e3,
          ...(snap ? { snap } : {}),
          words,
        };
        report.status = 'aligned';
      } catch (error) {
        if (error instanceof AlignerUnavailableError) {
          // Keep what this run aligned, and the stored entries it didn't reach (they're checked when used).
          for (const id of order.slice(i)) {
            const kept = existing?.lines[id];
            if (kept) next.lines[id] = kept;
          }
          await save();
          throw error;
        }
        report.reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (entry) {
      next.lines[line.id] = entry;
      report.loss = entry.loss;
      report.words = entry.words.length;
      if (entry.snap) report.snap = entry.snap;
      if (entry.loss !== null && entry.loss > HIGH_LOSS) report.warnings.push(`its loss is high (${entry.loss}); check it by ear`);
      if (report.words !== report.textWords) {
        report.warnings.push(`it came back with ${report.words} words, but its text has ${report.textWords}`);
      }
    }
    options.onLine?.(report);
  }
  const written = await save();

  // The speech on the timeline, from the words as the viewer will see them.
  const merge = applyWords(cut, next, { root, cutDir, sha256: hashes.known });
  const merged = resolveCut(merge.cut, { root, cutDir });
  if (merged.ok) {
    for (const report of reports) {
      const words = merged.value.lines.find((l) => l.id === report.id)?.words ?? [];
      if (report.status !== 'stale' && words.length > 0) {
        report.speech = { start: Math.min(...words.map((w) => w.start)), end: Math.max(...words.map((w) => w.end)) };
      }
    }
  }
  return { wordsPath, written, timeline: merged.ok ? merged.value : timeline, lines: reports };
}
