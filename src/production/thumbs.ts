import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { opacityAt, positionAt, zoomAt, type ResolvedOverlay, type ResolvedSegment, type Timeline } from '../cut/index.js';
import { mp4Seconds } from './probe.js';
import { isStill } from './sources.js';

const execute = promisify(execFile);

/** The size of a segment thumbnail: the TV's 4:3, small. Studio's cut viewer uses the same frame. */
export const THUMB_WIDTH = 240;
export const THUMB_HEIGHT = 180;
/** Bump when the recipe changes, so cached thumbnails are rebuilt. */
const THUMB_VERSION = 1;
/** The same for still segments, which are drawn with their overlays since version 2. */
const STILL_THUMB_VERSION = 2;

export function thumbCacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.MDMEDIA_THUMB_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mdmedia', 'production-thumbs');
}

/** Crops a segment's picture as the cut does and scales it to the output size. */
function frameFilters(timeline: Timeline, segment: ResolvedSegment): string[] {
  const { width, height } = timeline.meta;
  return [...(segment.crop ? [`crop=${segment.crop.width}:${segment.crop.height}:${segment.crop.x}:${segment.crop.y}`] : []), `scale=${width}:${height}`];
}

/** The middle 4:3 of the output picture, as the TV shows it, at thumbnail size. */
function tvFilters(timeline: Timeline): string[] {
  const { height } = timeline.meta;
  return [`crop=${Math.round((height * 4) / 3)}:${height}`, `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}`];
}

/** The ffmpeg filters that frame a segment as the cut does, then take the middle 4:3 as the TV shows it. */
export function thumbFilters(timeline: Timeline, segment: ResolvedSegment): string[] {
  return [...frameFilters(timeline, segment), ...tvFilters(timeline)];
}

/** How a still segment's thumbnail is made: the time it shows, its overlay inputs, and its ffmpeg filter graph. */
export interface ThumbPlan {
  /** Timeline seconds the thumbnail shows. */
  at: number;
  /** Overlay images, as inputs 1, 2, …, after the segment's own picture (input 0). */
  inputs: string[];
  /** A `-filter_complex` graph ending in `[thumb]`. */
  graph: string;
}

const num = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * A still segment's thumbnail, as the cut shows it on its last frame: the
 * image framed as the cut frames it, the overlays drawn into it, its zoom,
 * then the overlays over the finished picture that are up then, each at its
 * place and opacity. A still is often a bare background (a plain-faced
 * device, a bumper's colour) whose picture is in its overlays, so without
 * them its thumbnail looks blank.
 */
export function stillThumbPlan(timeline: Timeline, segment: ResolvedSegment): ThumbPlan {
  const fps = timeline.meta.fps;
  const at = Math.max(segment.start, Math.round((segment.end - 1 / fps) * 1e6) / 1e6);
  const inputs: string[] = [];
  const steps: string[] = [`[0:v]${frameFilters(timeline, segment).join(',')},setsar=1,format=rgba[p0]`];
  let last = 'p0';
  const draw = (overlay: ResolvedOverlay): void => {
    if (overlay.src.kind !== 'file' && overlay.src.kind !== 'take') return;
    const alpha = opacityAt(overlay, at);
    if (alpha <= 0) return;
    inputs.push(overlay.src.path);
    const n = inputs.length;
    const size = overlay.width !== null || overlay.height !== null ? [`scale=${overlay.width ?? -1}:${overlay.height ?? -1}`] : [];
    const fade = alpha < 1 ? [`colorchannelmixer=aa=${num(alpha)}`] : [];
    const { x, y } = positionAt(overlay, at);
    steps.push(`[${n}:v]${['format=rgba', ...size, ...fade].join(',')}[g${n}]`, `[${last}][g${n}]overlay=x=${num(x)}:y=${num(y)}[p${n}]`);
    last = `p${n}`;
  };
  for (const overlay of timeline.overlays) if (overlay.segment === segment.id) draw(overlay);
  const zoom = zoomAt(segment, at);
  if (zoom.focus && zoom.scale > 1) {
    const { width, height } = timeline.meta;
    const s = zoom.scale;
    steps.push(`[${last}]scale=${num(width * s)}:${num(height * s)},crop=${width}:${height}:${num(zoom.focus.x * (s - 1))}:${num(zoom.focus.y * (s - 1))}[z]`);
    last = 'z';
  }
  for (const overlay of timeline.overlays) if (overlay.segment === null) draw(overlay);
  steps.push(`[${last}]${tvFilters(timeline).join(',')},format=yuvj420p[thumb]`);
  return { at, inputs, graph: steps.join(';') };
}

export type ThumbMaker = (timeline: Timeline, segment: ResolvedSegment) => Promise<string | null>;

/**
 * Makes segment thumbnails with ffmpeg: the shot's first frame (its in-point
 * plus 0.1 s), framed as the cut frames it, as a small JPEG; a still segment
 * as the cut shows it on its last frame, overlays included (see
 * `stillThumbPlan`). Each is cached on disk by its sources and recipe; the
 * path is returned. A segment with no picture file (a color) has none.
 */
export function ffmpegThumbs(ffmpeg: string, cacheDir = thumbCacheDir()): ThumbMaker {
  return async (timeline, segment) => {
    if (segment.src.kind !== 'take' && segment.src.kind !== 'file') return null;
    const source = segment.src.path;
    const stat = await fs.promises.stat(source);
    const still = segment.still || isStill(source);
    const plan = still ? stillThumbPlan(timeline, segment) : null;
    const at = plan ? plan.at : Math.max(0, segment.in + 0.1);
    const filters = thumbFilters(timeline, segment);
    const inputs = await Promise.all(
      (plan?.inputs ?? []).map(async (file) => {
        const s = await fs.promises.stat(file);
        return { file, size: s.size, mtime: s.mtimeMs };
      }),
    );
    const recipe = plan ? { v: STILL_THUMB_VERSION, graph: plan.graph, inputs } : { v: THUMB_VERSION, filters };
    const key = createHash('sha256')
      .update(JSON.stringify({ ...recipe, file: source, size: stat.size, mtime: stat.mtimeMs, at }))
      .digest('hex')
      .slice(0, 32);
    const out = path.join(cacheDir, `${key}.jpg`);
    if (fs.existsSync(out)) return out;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const partial = `${out}.${process.pid}.tmp.jpg`;
    const picture = plan
      ? ['-i', source, ...plan.inputs.flatMap((file) => ['-i', file]), '-filter_complex', plan.graph, '-map', '[thumb]']
      : ['-ss', at.toFixed(3), '-i', source, '-vf', filters.join(',')];
    await execute(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...picture, '-frames:v', '1', '-q:v', '4', partial],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    await fs.promises.rename(partial, out);
    return out;
  };
}

/** The size of a cut's poster: the review page's, 4:3. */
export const POSTER_WIDTH = 480;
export const POSTER_HEIGHT = 360;
/** Where in the video its poster is taken, as a share of its length: past the titles, into the scene. */
export const POSTER_AT = 0.3;
const POSTER_VERSION = 1;

/** Makes a poster for a rendered video and returns its path, or null for none. */
export type PosterMaker = (video: string) => Promise<string | null>;

/**
 * Makes a cut's poster with ffmpeg the way the review page makes its own:
 * the frame 30% of the way in, the middle 4:3, 480 × 360 JPEG. Cached on
 * disk by the video and the recipe.
 */
export function ffmpegPosters(ffmpeg: string, cacheDir = thumbCacheDir()): PosterMaker {
  return async (video) => {
    const stat = await fs.promises.stat(video);
    const seconds = /\.(mp4|mov|m4v)$/i.test(video) ? await mp4Seconds(video).catch(() => undefined) : undefined;
    const at = Math.max(0, (seconds ?? 8) * POSTER_AT);
    const filters = [`crop=ih*4/3:ih`, `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}`];
    const key = createHash('sha256')
      .update(JSON.stringify({ v: POSTER_VERSION, poster: true, file: video, size: stat.size, mtime: stat.mtimeMs, at, filters }))
      .digest('hex')
      .slice(0, 32);
    const out = path.join(cacheDir, `poster-${key}.jpg`);
    if (fs.existsSync(out)) return out;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const partial = `${out}.${process.pid}.tmp.jpg`;
    await execute(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '4', partial],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    await fs.promises.rename(partial, out);
    return out;
  };
}
