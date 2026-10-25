import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mp4Seconds, wavSeconds } from '../../production/probe.js';
import { findFfmpeg, readCutFile } from '../align.js';
import { mediaRoot, resolveCut } from '../resolve.js';
import type { CutError, ResolvedSource, Timeline } from '../types.js';
import { planRender, renderArgs, type RenderOptions, type RenderPlan } from './plan.js';

/**
 * Running a render plan: probing the media it plays, then ffmpeg. The
 * planning itself is pure (`plan.ts`); everything that touches files or
 * processes is here.
 */

/** What a media file holds, from ffmpeg's own report on it. */
export interface MediaInfo {
  hasAudio: boolean;
  hasVideo: boolean;
  /** Seconds, when it can be read exactly (MP4/MOV from its header, WAV from its data size). */
  length?: number;
}

/** Runs a process to its end, collecting its output. */
function run(
  bin: string,
  args: string[],
  options: { onStdout?: (chunk: string) => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number | null; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let timedOut = false;
    // A stuck ffmpeg can ignore SIGTERM, so a timeout kills it outright.
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => options.onStdout?.(chunk));
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

/** Reads which streams a file has (ffmpeg's `-i` report) and, for MP4 and WAV, its exact length. */
export async function probeMedia(file: string, ffmpeg: string): Promise<MediaInfo> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file]);
  if (/No such file or directory/.test(stderr)) throw new Error(`No media file at ${file}`);
  const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr);
  const hasVideo = /Stream #\d+:\d+[^\n]*: Video:/.test(stderr);
  const ext = path.extname(file).toLowerCase();
  let length: number | undefined;
  try {
    if (ext === '.mp4' || ext === '.mov' || ext === '.m4a') length = await mp4Seconds(file);
    else if (ext === '.wav') length = await wavSeconds(file);
  } catch {
    length = undefined;
  }
  return { hasAudio, hasVideo, length };
}

/** Probes each file once, a few at a time. */
export async function probeAll(files: string[], ffmpeg: string): Promise<Map<string, MediaInfo>> {
  const unique = [...new Set(files)];
  const found = new Map<string, MediaInfo>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const file = unique[next++];
      found.set(file, await probeMedia(file, ffmpeg));
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, unique.length) }, worker));
  return found;
}

/** Progress while ffmpeg runs: seconds written so far, of the plan's duration. */
export interface RenderProgress {
  seconds: number;
  duration: number;
}

export interface RunRenderOptions {
  ffmpeg?: string;
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
}

/** Runs ffmpeg on a plan, writing its output (and the output's folder). Rejects with ffmpeg's error output on failure. */
export async function runRender(plan: RenderPlan, options: RunRenderOptions = {}): Promise<void> {
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  await mkdir(path.dirname(plan.output.path), { recursive: true });
  let pending = '';
  const { code, stderr } = await run(ffmpeg, renderArgs(plan, { progress: options.onProgress !== undefined }), {
    signal: options.signal,
    onStdout: (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) options.onProgress?.({ seconds: Number(match[1]) / 1e6, duration: plan.output.duration });
      }
    },
  });
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-20).join('\n');
    throw new Error(`ffmpeg failed (exit ${code}) rendering ${plan.output.path}:\n${tail}`);
  }
}

/** Runs ffmpeg with these arguments to its end; rejects with the tail of its error output on failure, or when it runs past `timeoutMs`. */
export async function runFfmpeg(args: string[], options: { ffmpeg?: string; signal?: AbortSignal; what?: string; timeoutMs?: number } = {}): Promise<void> {
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  const { code, stderr, timedOut } = await run(ffmpeg, args, { signal: options.signal, timeoutMs: options.timeoutMs });
  if (timedOut) throw new Error(`ffmpeg didn't finish${options.what ? ` ${options.what}` : ''} within ${Math.round((options.timeoutMs ?? 0) / 1000)} s, so it was stopped`);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-20).join('\n');
    throw new Error(`ffmpeg failed (exit ${code})${options.what ? ` ${options.what}` : ''}:\n${tail}`);
  }
}

function cutErrors(file: string, errors: CutError[]): Error {
  return new Error(`${file} has errors:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
}

export interface LoadedRender {
  timeline: Timeline;
  /** The cut's media root. */
  root: string;
  /** Probed media, by path. */
  media: Map<string, MediaInfo>;
}

/** Every file a cut reads, from its sources as written. */
export function filesOf(timeline: Timeline): string[] {
  const files: string[] = [];
  const add = (src: ResolvedSource | null | undefined): void => {
    if (src && (src.kind === 'take' || src.kind === 'file')) files.push(src.path);
  };
  for (const s of timeline.segments) {
    add(s.src);
    add(s.audio?.src);
  }
  for (const l of timeline.lines) if (l.audio.kind === 'file') add(l.audio.src);
  for (const c of [...timeline.music, ...timeline.sfx]) {
    add(c.src);
    for (const p of c.parts ?? []) add(p.src);
  }
  for (const o of timeline.overlays) add(o.src);
  return files;
}

/**
 * Reads a cut file (merging any base it extends), probes the media it plays
 * and resolves it with their lengths. A file that is missing is an error here,
 * before ffmpeg starts.
 */
export async function loadCutForRender(cutPath: string, options: { root?: string; ffmpeg?: string } = {}): Promise<LoadedRender> {
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  const cut = await readCutFile(cutPath);
  const cutDir = path.dirname(path.resolve(cutPath));
  // First without lengths, to learn which files it reads; then with them.
  const first = resolveCut(cut, { root: options.root, cutDir });
  if (!first.ok) throw cutErrors(cutPath, first.errors);
  const media = await probeAll(filesOf(first.value), ffmpeg);
  const missing = [...media.entries()].filter(([, m]) => !m.hasAudio && !m.hasVideo).map(([f]) => f);
  if (missing.length > 0) throw new Error(`These files can't be read as media:\n${missing.map((f) => `  ${f}`).join('\n')}`);
  const mediaLength = (src: ResolvedSource): number | undefined =>
    src.kind === 'take' || src.kind === 'file' ? media.get(src.path)?.length : undefined;
  const resolved = resolveCut(cut, { root: options.root, cutDir, mediaLength });
  if (!resolved.ok) throw cutErrors(cutPath, resolved.errors);
  return { timeline: resolved.value, root: mediaRoot(cut, { root: options.root, cutDir }), media };
}

/** Plans a loaded cut's render with its probed media: a take with no sound track plays as silence. */
export function planLoadedRender(loaded: LoadedRender, options: RenderOptions): ReturnType<typeof planRender> {
  return planRender(loaded.timeline, {
    ...options,
    hasAudio: (src) => (src.kind === 'take' || src.kind === 'file' ? (loaded.media.get(src.path)?.hasAudio ?? true) : true),
  });
}
