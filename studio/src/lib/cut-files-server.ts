import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { applyWords, loadCutSource, parseWordsFile, resolveCut, type CutError, type ResolvedSegment, type Timeline, type WordsFile } from 'mdmedia/cut';

/**
 * Local cut files for the read-only cut viewer. Development only: the cut
 * files live in the repository and their media in a local folder, so nothing
 * here runs in a deployed Studio.
 *
 * - `MDMEDIA_CUTS_DIR`: where `<name>.cut.json` files (and their `<name>.words.json`) are read. Default `../docs/cuts`.
 * - `MDMEDIA_CUT_MEDIA_ROOT`: the media root every cut resolves against. Default
 *   `~/.local/share/mdmedia/productions/crt-tv`.
 * - `MDMEDIA_CUT_CACHE_DIR`: where shot thumbnails are cached.
 *
 * The media routes serve only files a cut names (its rendered output and its
 * shots' sources) and only when they are inside the media root.
 */

const execute = promisify(execFile);

/** Where the CRT TV production's media lives, as the Night Wagon cut files' `media.root` says. */
const DEFAULT_MEDIA_ROOT = path.join(homedir(), '.local', 'share', 'mdmedia', 'productions', 'crt-tv');

/** Cut names are file stems: lowercase words joined by hyphens, as in `night-wagon-take9`. */
export const CUT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function cutViewerEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function cutsDir(): string {
  return path.resolve(process.env.MDMEDIA_CUTS_DIR ?? path.join(process.cwd(), '..', 'docs', 'cuts'));
}

export function cutMediaRoot(): string {
  return path.resolve(process.env.MDMEDIA_CUT_MEDIA_ROOT ?? DEFAULT_MEDIA_ROOT);
}

function thumbnailCacheDir(): string {
  return path.resolve(process.env.MDMEDIA_CUT_CACHE_DIR ?? path.join(tmpdir(), 'mdmedia-cut-thumbs'));
}

/** How a cut's words file was used: which lines got words, and which stored words no longer match their line. */
export interface CutWordsSummary {
  applied: string[];
  stale: Array<{ id: string; reason: string }>;
  /** Lines whose audio couldn't be read, so its contents weren't compared. */
  unchecked: string[];
  /** Why the words file was ignored, when it couldn't be read. */
  error?: string;
}

export type LoadedCut =
  | { ok: true; name: string; timeline: Timeline; words: CutWordsSummary | null }
  | { ok: false; status: 404 | 422; message: string; errors?: CutError[] };

const globalHashes = globalThis as typeof globalThis & { __mdmediaCutHashes?: Map<string, string> };
const sourceHashes = (globalHashes.__mdmediaCutHashes ??= new Map());

/** SHA-256 of a media file inside the root, cached by its size and modification time. */
async function sourceSha256(file: string): Promise<string | undefined> {
  const source = await mediaFileInsideRoot(file);
  if (!source) return undefined;
  const key = `${source.path}\0${source.size}\0${source.mtimeMs}`;
  const cached = sourceHashes.get(key);
  if (cached) return cached;
  const hash = createHash('sha256').update(await readFile(source.path)).digest('hex');
  sourceHashes.set(key, hash);
  return hash;
}

/** `<name>.words.json`, or null when the cut has none. */
async function readWordsFile(name: string): Promise<WordsFile | null | { error: string }> {
  let text: string;
  try {
    text = await readFile(path.join(cutsDir(), `${name}.words.json`), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    return { error: 'The words file could not be read.' };
  }
  try {
    const parsed = parseWordsFile(JSON.parse(text));
    return parsed.ok ? parsed.value : { error: `The words file has errors: ${parsed.message}` };
  } catch {
    return { error: 'The words file is not valid JSON.' };
  }
}

/**
 * Reads `<name>.cut.json` and resolves it against the media root, with the
 * word timings from `<name>.words.json` beside it. Words that no longer match
 * their line (its text, its audio window or the audio file changed) are left
 * out, so the viewer never times a line by stale words.
 */
export async function loadCut(name: string): Promise<LoadedCut> {
  if (!cutViewerEnabled() || !CUT_NAME_PATTERN.test(name)) return { ok: false, status: 404, message: 'No such cut.' };
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path.join(cutsDir(), `${name}.cut.json`), 'utf8'));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { ok: false, status: 404, message: 'No such cut.' };
    return { ok: false, status: 422, message: 'The cut file is not valid JSON.' };
  }
  // A cut that extends another is merged onto its base, `<base>.cut.json` in the same folder.
  const readBase = async (base: string): Promise<unknown> => {
    if (!CUT_NAME_PATTERN.test(base)) throw new Error('not a cut name');
    try {
      return JSON.parse(await readFile(path.join(cutsDir(), `${base}.cut.json`), 'utf8'));
    } catch (error) {
      throw new Error((error as { code?: string }).code === 'ENOENT' ? 'no such cut' : 'not valid JSON');
    }
  };
  const parsed = await loadCutSource(json, readBase, { name });
  if (!parsed.ok) return { ok: false, status: 422, message: 'The cut file has errors.', errors: parsed.errors };
  const options = { root: cutMediaRoot(), cutDir: cutsDir() };

  let cut = parsed.value;
  let words: CutWordsSummary | null = null;
  const file = await readWordsFile(name);
  if (file && 'error' in file) {
    words = { applied: [], stale: [], unchecked: [], error: file.error };
  } else if (file) {
    const hashes = new Map<string, string>();
    for (const entry of Object.values(file.lines)) {
      const source = path.join(options.root, entry.fingerprint.source);
      if (hashes.has(source)) continue;
      const hash = await sourceSha256(source).catch(() => undefined);
      if (hash) hashes.set(source, hash);
    }
    const merge = applyWords(cut, file, { ...options, sha256: (source) => hashes.get(source) });
    cut = merge.cut;
    words = { applied: merge.applied, stale: merge.stale, unchecked: merge.unchecked };
  }

  const resolved = resolveCut(cut, options);
  if (!resolved.ok) return { ok: false, status: 422, message: 'The cut file has errors.', errors: resolved.errors };
  return { ok: true, name, timeline: resolved.value, words };
}

/** The real path of `file` if it exists inside the media root, else null. */
export async function mediaFileInsideRoot(file: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  try {
    const root = await realpath(cutMediaRoot());
    const real = await realpath(file);
    if (!real.startsWith(root + path.sep)) return null;
    const info = await stat(real);
    return info.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header against a file of `size` bytes.
 * Returns null when there is no usable header (serve the whole file) and
 * 'unsatisfiable' for a range outside the file.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

const THUMB_WIDTH = 240;
const THUMB_HEIGHT = 180;
/** Bump when the thumbnail recipe changes, so cached frames are rebuilt. */
const THUMB_VERSION = 1;

const globalThumbs = globalThis as typeof globalThis & { __mdmediaCutThumbs?: Map<string, Promise<Buffer>> };
const pendingThumbs = (globalThumbs.__mdmediaCutThumbs ??= new Map());

/**
 * A 4:3 JPEG of a shot's first frame (its in-point plus 0.1 s), framed the
 * way the cut frames it: the segment's crop, scaled to the cut's size, then
 * the middle 4:3 as the TV shows it. Cached on disk by source and recipe.
 */
export async function segmentThumbnail(timeline: Timeline, segment: ResolvedSegment): Promise<Buffer | null> {
  if (segment.src.kind !== 'take' && segment.src.kind !== 'file') return null;
  const source = await mediaFileInsideRoot(segment.src.path);
  if (!source || !ffmpeg) return null;

  const at = Math.max(0, segment.in + 0.1);
  const { width, height } = timeline.meta;
  const filters = [
    ...(segment.crop ? [`crop=${segment.crop.width}:${segment.crop.height}:${segment.crop.x}:${segment.crop.y}`] : []),
    `scale=${width}:${height}`,
    `crop=${Math.round((height * 4) / 3)}:${height}`,
    `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}`,
  ];
  const key = createHash('sha256')
    .update(JSON.stringify({ v: THUMB_VERSION, file: source.path, size: source.size, mtime: source.mtimeMs, at, filters }))
    .digest('hex')
    .slice(0, 32);
  const cacheDir = thumbnailCacheDir();
  const cached = path.join(cacheDir, `${key}.jpg`);

  const existing = pendingThumbs.get(key);
  if (existing) return existing;
  const work = (async () => {
    try {
      return await readFile(cached);
    } catch {
      await mkdir(cacheDir, { recursive: true });
      const partial = `${cached}.${process.pid}.${Date.now()}.tmp.jpg`;
      await execute(
        ffmpeg!,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', at.toFixed(3), '-i', source.path,
          '-frames:v', '1', '-vf', filters.join(','), '-q:v', '3', partial],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      await rename(partial, cached);
      return readFile(cached);
    }
  })();
  pendingThumbs.set(key, work);
  try {
    return await work;
  } finally {
    pendingThumbs.delete(key);
  }
}
