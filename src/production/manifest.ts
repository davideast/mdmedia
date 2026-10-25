import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCharacterRef, type CharacterRef } from '../character/character.js';

/**
 * A production manifest: one production (an episode or a commercial), its
 * series, its cover, and its cuts in order. `mdmedia production push` reads it.
 * See docs/studio-productions-api.md.
 *
 * - `cut` paths are relative to the repository the manifest is in (the nearest
 *   folder above it with a `.git`), e.g. `docs/cuts/night-wagon-take9.cut.json`.
 * - `rendered` and `cover` paths are relative to the media root, `media.root`
 *   (`~` is your home folder).
 */

export const PRODUCTION_FORMAT = 'mdmedia.production@1';

export type ManifestCutStatus = 'review' | 'approved' | 'final' | 'none';
const STATUSES: readonly ManifestCutStatus[] = ['review', 'approved', 'final', 'none'];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

interface ManifestCutBase {
  /** The cut's id in the production. Default: a cut file's stem, or the rendered file's. */
  id: string;
  label: string;
  status: ManifestCutStatus;
  /** The review note. */
  notes: string;
  /** Milliseconds since the epoch, or null to keep the studio's (or use now). */
  createdAt: number | null;
}

/** A cut with a cut file. `rendered` overrides the cut's own `output`. */
export interface ManifestCutFile extends ManifestCutBase {
  kind: 'cut';
  /** Absolute path of the `.cut.json`. */
  cut: string;
  /** The same path, relative to the repository, as recorded in the studio. */
  cutRef: string;
  /** Absolute path of its rendered video, when the manifest names one. */
  rendered: string | null;
}

/** A finished video only, from before cut files existed. */
export interface ManifestRendered extends ManifestCutBase {
  kind: 'rendered';
  /** Absolute path of the video. */
  rendered: string;
}

export type ManifestCut = ManifestCutFile | ManifestRendered;

/** One part in a production's cast: the speaker name its cuts use, and the character version that plays it. */
export interface CastEntry {
  /** The role: a cut line's `speaker` ("Big Hal", "Rick"). */
  role: string;
  character: CharacterRef;
}

export interface ProductionManifest {
  /** The manifest's own absolute path. */
  file: string;
  slug: string;
  title: string;
  series: { title: string; slug?: string } | null;
  /** The absolute media root. */
  root: string;
  /** The repository the cut paths are relative to. */
  repo: string;
  /** Absolute path of the cover image, or null. */
  cover: string | null;
  /** The cut to show first; default the last. */
  current: string | null;
  /** The approved cut; default the last cut whose status is approved or final. */
  approved: string | null;
  cuts: ManifestCut[];
  /** Who plays whom, by role; empty when the manifest names no cast. */
  cast: CastEntry[];
}

export class ManifestError extends Error {
  constructor(file: string, problems: string[]) {
    super(`${file}:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'ManifestError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export function expandHome(p: string, home = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** The nearest folder at or above `dir` that holds a `.git` (a folder, or a worktree's file), else `dir`. */
export function findRepoRoot(dir: string, exists: (p: string) => boolean = fs.existsSync): string {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (exists(path.join(at, '.git'))) return at;
    if (path.dirname(at) === at) return path.resolve(dir);
  }
}

const stem = (file: string) => path.basename(file).replace(/\.cut\.json$|\.[^.]+$/, '');

function time(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return undefined;
}

export interface ParseManifestOptions {
  /** Overrides the manifest's media root. */
  root?: string;
  /** Overrides where cut paths are resolved from. */
  repo?: string;
  home?: string;
}

/** Checks a manifest's JSON and resolves its paths. Every problem is reported at once. */
export function parseProductionManifest(json: unknown, file: string, options: ParseManifestOptions = {}): ProductionManifest {
  const problems: string[] = [];
  const fail = (message: string) => { problems.push(message); };
  if (!isObj(json)) throw new ManifestError(file, ['expected a JSON object']);
  if (json.format !== PRODUCTION_FORMAT) fail(`format: expected "${PRODUCTION_FORMAT}"`);
  const slug = typeof json.slug === 'string' && SLUG.test(json.slug) && json.slug.length <= 80 ? json.slug : '';
  if (!slug) fail('slug: expected lowercase words joined by hyphens, like "night-wagon-the-argument"');
  const title = typeof json.title === 'string' && json.title.trim() ? json.title.trim() : '';
  if (!title) fail('title: expected text');

  let series: ProductionManifest['series'] = null;
  if (typeof json.series === 'string' && json.series.trim()) series = { title: json.series.trim() };
  else if (isObj(json.series) && typeof json.series.title === 'string' && json.series.title.trim()) {
    series = { title: json.series.title.trim() };
    if (json.series.slug !== undefined) {
      if (typeof json.series.slug === 'string' && SLUG.test(json.series.slug)) series.slug = json.series.slug;
      else fail('series.slug: expected lowercase words joined by hyphens');
    }
  } else if (json.series !== undefined && json.series !== null) fail('series: expected a title, or { title, slug? }');

  const home = options.home ?? os.homedir();
  const configuredRoot = isObj(json.media) && typeof json.media.root === 'string' ? json.media.root : undefined;
  const rawRoot = options.root ?? configuredRoot;
  if (!rawRoot) fail('media.root: expected the media root, e.g. "~/.local/share/mdmedia/productions/crt-tv"');
  const root = path.resolve(path.dirname(file), expandHome(rawRoot ?? '.', home));
  const repo = options.repo ?? findRepoRoot(path.dirname(file));
  const inRoot = (p: string) => path.resolve(root, expandHome(p, home));

  const cover = typeof json.cover === 'string' && json.cover ? inRoot(json.cover) : null;
  if (json.cover !== undefined && json.cover !== null && cover === null) fail('cover: expected a path under the media root');

  const cuts: ManifestCut[] = [];
  if (!Array.isArray(json.cuts) || json.cuts.length === 0) fail('cuts: expected a list of cuts');
  (Array.isArray(json.cuts) ? json.cuts : []).forEach((raw, i) => {
    const where = `cuts[${i}]`;
    if (!isObj(raw)) { fail(`${where}: expected an object`); return; }
    const hasCut = typeof raw.cut === 'string' && raw.cut !== '';
    const hasRendered = typeof raw.rendered === 'string' && raw.rendered !== '';
    if (!hasCut && !hasRendered) { fail(`${where}: needs "cut" (a .cut.json) or "rendered" (a video)`); return; }
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : '';
    if (!label) fail(`${where}.label: expected text`);
    const status = raw.status === undefined ? 'none' : raw.status;
    if (!STATUSES.includes(status as ManifestCutStatus)) fail(`${where}.status: expected ${STATUSES.join(', ')}`);
    const notes = raw.notes === undefined ? '' : raw.notes;
    if (typeof notes !== 'string') fail(`${where}.notes: expected text`);
    const createdAt = time(raw.createdAt);
    if (createdAt === undefined) fail(`${where}.createdAt: expected an ISO date or milliseconds`);
    const source = hasCut ? (raw.cut as string) : (raw.rendered as string);
    const id = raw.id === undefined ? stem(source) : raw.id;
    if (typeof id !== 'string' || !CUT_ID.test(id)) fail(`${where}.id: expected letters, digits, "_" and "-"`);
    const base = { id: String(id), label, status: status as ManifestCutStatus, notes: typeof notes === 'string' ? notes : '', createdAt: createdAt ?? null };
    if (hasCut) {
      const cut = path.resolve(repo, raw.cut as string);
      if (!cut.endsWith('.cut.json')) fail(`${where}.cut: expected a .cut.json file`);
      cuts.push({ ...base, kind: 'cut', cut, cutRef: path.relative(repo, cut).split(path.sep).join('/'), rendered: hasRendered ? inRoot(raw.rendered as string) : null });
    } else {
      cuts.push({ ...base, kind: 'rendered', rendered: inRoot(raw.rendered as string) });
    }
  });
  const ids = cuts.map((cut) => cut.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) fail(`cuts: the id "${id}" is used twice`);

  const pointer = (key: 'current' | 'approved'): string | null => {
    const value = json[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !ids.includes(value)) { fail(`${key}: expected the id of one of the cuts`); return null; }
    return value;
  };
  const current = pointer('current');
  const approved = pointer('approved');
  if (approved) {
    const cut = cuts.find((c) => c.id === approved);
    if (cut && cut.status !== 'approved' && cut.status !== 'final') fail(`approved: "${approved}" has status "${cut.status}"; the approved cut must be approved or final`);
  }

  const cast: CastEntry[] = [];
  if (json.cast !== undefined && !Array.isArray(json.cast)) fail('cast: expected a list of { role, character: "id@version" }');
  (Array.isArray(json.cast) ? json.cast : []).forEach((raw, i) => {
    const where = `cast[${i}]`;
    if (!isObj(raw)) { fail(`${where}: expected { role, character }`); return; }
    const role = typeof raw.role === 'string' && raw.role.trim() && raw.role.trim().length <= 80 ? raw.role.trim() : '';
    if (!role) fail(`${where}.role: expected the speaker name the cuts use, like "Big Hal"`);
    const ref = typeof raw.character === 'string' ? parseCharacterRef(raw.character) : null;
    if (!ref) fail(`${where}.character: expected a character and its version, like "big-hal@1"`);
    if (role && ref) cast.push({ role, character: ref });
  });
  const roles = cast.map((entry) => entry.role);
  for (const role of new Set(roles.filter((r, i) => roles.indexOf(r) !== i))) fail(`cast: the role "${role}" is cast twice`);

  if (problems.length) throw new ManifestError(file, problems);
  return { file, slug, title, series, root, repo, cover, current, approved, cuts, cast };
}

/** Reads and checks a manifest file. */
export async function readProductionManifest(file: string, options: ParseManifestOptions = {}): Promise<ProductionManifest> {
  const absolute = path.resolve(file);
  let json: unknown;
  try {
    json = JSON.parse(await fs.promises.readFile(absolute, 'utf8'));
  } catch (error) {
    throw new ManifestError(absolute, [(error as { code?: string }).code === 'ENOENT' ? 'no such file' : 'not valid JSON']);
  }
  return parseProductionManifest(json, absolute, options);
}

/** The approved cut: the manifest's, else the last approved or final one. */
export function approvedCut(manifest: ProductionManifest): string | null {
  return manifest.approved ?? [...manifest.cuts].reverse().find((cut) => cut.status === 'approved' || cut.status === 'final')?.id ?? null;
}

/** The cut to show first: the manifest's, else the last. */
export function currentCut(manifest: ProductionManifest): string | null {
  return manifest.current ?? manifest.cuts.at(-1)?.id ?? null;
}
