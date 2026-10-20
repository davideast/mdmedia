import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findFfmpeg, readCutFile, readWordsFile, sha256File, wordsFilePath } from './align.js';
import {
  CHECK_FORMAT,
  checkAnswers,
  clipRange,
  fingerprintChange,
  fingerprintMaterial,
  listeningFacts,
  listeningQuestions,
  measureCut,
  parseCheckFile,
  serializeCheckFile,
  thresholdsFor,
  type CheckFile,
  type CheckFingerprint,
  type ListeningResult,
  type MeasuredCheck,
  type ReferenceFor,
} from './check.js';
import { ListenerUnavailableError, type Listener } from './listen.js';
import { decodeWav } from './onset.js';
import { planRender, renderArgs, soundArgs } from './render/plan.js';
import { filesOf, probeAll, runFfmpeg, type MediaInfo } from './render/run.js';
import { mediaRoot, resolveCut } from './resolve.js';
import type { CutError, CutFile, ResolvedSource, SourceRef, Timeline } from './types.js';
import { applyWords, type WordsMerge } from './words.js';

/**
 * The file-system side of `mdmedia cut check`: reading the cut with its
 * fresh words and probed media, rendering its dialogue (and, for the
 * listening check, a clip of each performance), hashing its sources, and
 * writing `<name>.check.json` next to its words file.
 */

/** `<name>.check.json` next to `<name>.cut.json` and its words file. */
export function checkFilePath(cutPath: string): string {
  return wordsFilePath(cutPath).replace(/\.words\.json$/, '.check.json');
}

/** A cut's check file, or null when it has none. */
export async function readCheckFile(file: string): Promise<CheckFile | null> {
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
  const parsed = parseCheckFile(json);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.message}`);
  return parsed.value;
}

function cutErrors(file: string, errors: CutError[]): Error {
  return new Error(`${file} has errors:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
}

export interface LoadedCheckCut {
  cut: CutFile;
  timeline: Timeline;
  root: string;
  merge: WordsMerge;
  media: Map<string, MediaInfo>;
  /** SHA-256 of each source file the cut plays, by absolute path. */
  hashes: Map<string, string>;
  hasWordsFile: boolean;
}

/**
 * Reads a cut and its words file, probes and hashes every file it plays,
 * puts its fresh words on it and resolves it with the probed lengths (so an
 * extended take's seam is known).
 */
export async function loadCutForCheck(cutPath: string, options: { root?: string; ffmpeg?: string } = {}): Promise<LoadedCheckCut> {
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  const cut = await readCutFile(cutPath);
  const cutDir = path.dirname(path.resolve(cutPath));
  const root = mediaRoot(cut, { root: options.root, cutDir });
  const first = resolveCut(cut, { root: options.root, cutDir });
  if (!first.ok) throw cutErrors(cutPath, first.errors);
  // Extended takes' originals aren't played, but their lengths place the seams.
  const extendedFrom = Object.values(first.value.sources)
    .map((p) => p.extendedFrom)
    .filter((s): s is ResolvedSource & { path: string } => s !== null && (s.kind === 'take' || s.kind === 'file'))
    .map((s) => s.path);
  const played = filesOf(first.value);
  const media = await probeAll([...played, ...extendedFrom], ffmpeg).catch(async () => probeAll(played, ffmpeg));
  const missing = [...new Set(played)].filter((f) => {
    const m = media.get(f);
    return !m || (!m.hasAudio && !m.hasVideo);
  });
  if (missing.length > 0) throw new Error(`These files can't be read as media:\n${missing.map((f) => `  ${f}`).join('\n')}`);
  const hashes = new Map<string, string>();
  for (const file of new Set(played)) hashes.set(file, await sha256File(file));
  const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' || src.kind === 'file' ? media.get(src.path)?.length : undefined);

  const words = await readWordsFile(wordsFilePath(cutPath));
  const merge = words
    ? applyWords(cut, words, { root: options.root, cutDir, sha256: (file) => hashes.get(file) })
    : { cut, applied: [], stale: [], unchecked: [] };
  const resolved = resolveCut(merge.cut, { root: options.root, cutDir, mediaLength });
  if (!resolved.ok) throw cutErrors(cutPath, resolved.errors);
  return { cut, timeline: resolved.value, root, merge, media, hashes, hasWordsFile: words !== null };
}

/** The cut with only its dialogue: no music, sound effects (including those laid into segments) or overlays, and no picture look. */
export function dialogueStem(timeline: Timeline): Timeline {
  return {
    ...timeline,
    music: [],
    sfx: [],
    overlays: [],
    items: timeline.items.filter((i) => i.kind === 'segment' || i.kind === 'line'),
    filters: { picture: [], mix: timeline.filters.mix },
    picture: { fadeIn: 0, fadeOut: 0 },
  };
}

function hasAudioIn(loaded: LoadedCheckCut): (src: ResolvedSource) => boolean {
  return (src) => (src.kind === 'take' || src.kind === 'file' ? (loaded.media.get(src.path)?.hasAudio ?? true) : true);
}

/** How long a check's render may take: a preview renders far faster than real time, so this only stops a stuck ffmpeg. */
function renderTimeout(seconds: number): number {
  return Math.max(120_000, seconds * 10_000);
}

/** Renders the cut's dialogue, sound only, and decodes it. */
export async function renderDialogue(loaded: LoadedCheckCut, options: { ffmpeg?: string; from?: number; to?: number } = {}): Promise<{ samples: Float32Array; sampleRate: number; start: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-check-'));
  const out = path.join(dir, 'dialogue.wav');
  try {
    const planned = planRender(dialogueStem(loaded.timeline), { output: out, from: options.from, to: options.to, preview: true, hasAudio: hasAudioIn(loaded) });
    if (!planned.ok) throw new Error(planned.errors.join('\n'));
    await runFfmpeg(soundArgs(planned.plan, out), { ffmpeg: options.ffmpeg, what: "rendering the cut's dialogue", timeoutMs: renderTimeout(planned.plan.output.duration) });
    const audio = decodeWav(new Uint8Array(await readFile(out)));
    return { ...audio, start: planned.plan.range.from };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Renders a stretch of the whole cut, picture and sound, as a small preview MP4, and returns its bytes. */
export async function renderClip(loaded: LoadedCheckCut, range: { from: number; to: number }, options: { ffmpeg?: string } = {}): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-listen-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    const planned = planRender(loaded.timeline, { output: out, from: range.from, to: range.to, preview: true, hasAudio: hasAudioIn(loaded) });
    if (!planned.ok) throw new Error(planned.errors.join('\n'));
    await runFfmpeg(renderArgs(planned.plan), { ffmpeg: options.ffmpeg, what: `rendering ${range.from}–${range.to} s to listen to`, timeoutMs: renderTimeout(planned.plan.output.duration) });
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A fingerprint of a stretch of the cut: its material's digest and the hashes of the files heard there. */
export function fingerprintOfSpan(loaded: Pick<LoadedCheckCut, 'timeline' | 'hashes'>, from: number, to: number, options: { mix?: boolean; extra?: unknown } = {}): CheckFingerprint {
  const { material, refs } = fingerprintMaterial(loaded.timeline, from, to, options);
  const paths = new Map<SourceRef, string>();
  for (const item of loaded.timeline.items) {
    const srcs: unknown[] = item.kind === 'segment' ? [item.src, item.audio?.src] : item.kind === 'line' ? [item.audio.kind === 'file' ? item.audio.src : null] : item.kind === 'overlay' ? [] : [item.src, ...(item.parts ?? []).map((p) => p.src)];
    for (const s of srcs) {
      if (s && typeof s === 'object' && 'ref' in s && 'path' in s) paths.set((s as { ref: string }).ref, (s as { path: string }).path);
    }
  }
  const sources: Record<SourceRef, string> = {};
  for (const ref of refs) {
    const file = paths.get(ref);
    const hash = file === undefined ? undefined : loaded.hashes.get(file);
    if (hash !== undefined) sources[ref] = hash;
  }
  return { from: Math.round(from * 1e3) / 1e3, to: Math.round(to * 1e3) / 1e3, sources, digest: sha256(material) };
}

/** Room-tone windows reach this far past a performance's speech, so its fingerprint covers them. */
const PERFORMANCE_MARGIN = 0.6;

function measuredFingerprints(loaded: LoadedCheckCut, measured: MeasuredCheck): CheckFile['measured']['fingerprints'] {
  const lines: Record<string, CheckFingerprint> = {};
  for (const m of measured.lines) lines[m.id] = fingerprintOfSpan(loaded, m.speech.start, m.speech.end);
  const performances: Record<string, CheckFingerprint> = {};
  for (const perf of loaded.timeline.performances) {
    const own = measured.lines.filter((m) => perf.lines.includes(m.id));
    if (own.length === 0) continue;
    const from = Math.max(0, Math.min(...own.map((m) => m.speech.start)) - PERFORMANCE_MARGIN);
    const to = Math.min(loaded.timeline.length, Math.max(...own.map((m) => m.speech.end)) + PERFORMANCE_MARGIN);
    performances[perf.id] = fingerprintOfSpan(loaded, from, to, { extra: { performance: perf, thresholds: thresholdsFor(loaded.timeline, perf) } });
  }
  return { lines, performances };
}

export interface CutCheckOptions {
  cutPath: string;
  /** Overrides the cut's `media.root`. */
  root?: string;
  /** Run the listening check on every performance whose result is missing or stale. */
  listen?: boolean;
  /** Required with `listen`. */
  listener?: Listener;
  /** With `listen`, listen again even to performances whose results are fresh. */
  force?: boolean;
  /** Each speaker's reference levels (the cast's delivery profiles, at the next step). */
  reference?: ReferenceFor;
  ffmpeg?: string;
  /** Progress, one short line at a time. */
  onStep?: (message: string) => void;
}

export type ListeningStatus = 'heard' | 'fresh' | 'stale' | 'none';

export interface CutCheckResult {
  checkPath: string;
  /** False when the file already said exactly this. */
  written: boolean;
  file: CheckFile;
  timeline: Timeline;
  /** Lines with no fresh words, so measured over their whole span. */
  staleWords: Array<{ id: string; reason: string }>;
  hasWordsFile: boolean;
  /** Each performance's listening result: heard this run, kept (fresh), dropped (stale, with why) or none. */
  listening: Record<string, { status: ListeningStatus; reason?: string }>;
}

/**
 * Measures a cut's performances in its rendered dialogue and, with `listen`,
 * runs the listening check on each performance's clip, then writes
 * `<name>.check.json`. Stored listening results are kept while their
 * fingerprint matches, and dropped when it doesn't.
 */
export async function checkCut(options: CutCheckOptions): Promise<CutCheckResult> {
  const step = options.onStep ?? (() => undefined);
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  if (options.listen && !options.listener) throw new Error('The listening check needs a listener.');
  const loaded = await loadCutForCheck(options.cutPath, { root: options.root, ffmpeg });
  const { timeline } = loaded;
  const checkPath = checkFilePath(options.cutPath);
  const existing = await readCheckFile(checkPath);

  step(`rendering the dialogue of ${path.basename(options.cutPath)} (${timeline.length.toFixed(2)} s)`);
  const pcm = await renderDialogue(loaded, { ffmpeg });
  step('measuring loudness, pitch and pace');
  const measured = measureCut(timeline, { audio: { samples: pcm.samples, sampleRate: pcm.sampleRate }, start: pcm.start }, { reference: options.reference });
  const file: CheckFile = {
    format: CHECK_FORMAT,
    measured: { ...measured, fingerprints: measuredFingerprints(loaded, measured) },
    listening: {},
  };

  /** Writes the file when its contents changed; true when it did. Results not reached yet keep their stored entries, so a stopped run loses nothing. */
  const save = async (pending: readonly string[] = []): Promise<boolean> => {
    const kept = Object.fromEntries(pending.flatMap((id) => (existing?.listening[id] ? [[id, existing.listening[id]]] : [])));
    const text = serializeCheckFile({ ...file, listening: { ...kept, ...file.listening } });
    const before = await readFile(checkPath, 'utf8').catch(() => null);
    if (before === text) return false;
    await writeFile(checkPath, text);
    return true;
  };

  const listening: CutCheckResult['listening'] = {};
  const order = timeline.performances.map((p) => p.id);
  let wroteAny = false;
  for (const [index, perf] of timeline.performances.entries()) {
    const range = clipRange(timeline, perf);
    const questions = listeningQuestions(timeline, perf, range.from);
    const facts = listeningFacts(timeline, range);
    const listenerName = options.listener?.name ?? existing?.listening[perf.id]?.listener ?? '';
    const fingerprint = fingerprintOfSpan(loaded, range.from, range.to, { mix: true, extra: { questions, facts, listener: listenerName } });
    const stored = existing?.listening[perf.id];
    const change = stored ? (stored.listener !== listenerName && options.listen ? `it was heard by ${stored.listener}` : fingerprintChange(stored.fingerprint, fingerprint)) : null;
    if (stored && change === null && !(options.listen && options.force)) {
      file.listening[perf.id] = stored;
      listening[perf.id] = { status: 'fresh' };
      continue;
    }
    if (!options.listen || !options.listener) {
      listening[perf.id] = stored ? { status: 'stale', reason: change ?? 'stale' } : { status: 'none' };
      continue;
    }
    step(`listening to ${perf.id} (${range.from.toFixed(2)}–${range.to.toFixed(2)} s) with ${options.listener.name}`);
    const bytes = await renderClip(loaded, range, { ffmpeg });
    let heard;
    try {
      heard = await options.listener.listen({ clip: { bytes, mimeType: 'video/mp4', seconds: range.to - range.from }, facts, questions: questions.map((q) => ({ id: q.id, ask: q.ask })) });
    } catch (error) {
      if (error instanceof ListenerUnavailableError) {
        await save(order.slice(index));
        throw error;
      }
      listening[perf.id] = { status: stored ? 'stale' : 'none', reason: `the listener failed: ${error instanceof Error ? error.message : String(error)}` };
      continue;
    }
    const result: ListeningResult = {
      filterOnly: true,
      listener: options.listener.name,
      model: heard.model,
      clip: range,
      canHearAudio: heard.canHearAudio,
      answers: checkAnswers(questions, heard.answers),
      fingerprint,
      heardAt: new Date().toISOString(),
    };
    file.listening[perf.id] = result;
    listening[perf.id] = { status: 'heard' };
    // Listening is slow: keep each result as it comes.
    wroteAny = (await save(order.slice(index + 1))) || wroteAny;
  }

  const written = (await save()) || wroteAny;
  return { checkPath, written, file, timeline, staleWords: loaded.merge.stale, hasWordsFile: loaded.hasWordsFile, listening };
}
