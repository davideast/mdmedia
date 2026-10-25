import fs from 'node:fs';
import path from 'node:path';
import { loadCutWithWords, readWordsFile, wordsFilePath } from '../cut/align.js';
import type { CutFile, Timeline, WordsFile } from '../cut/index.js';
import { formatCharacterRef } from '../character/character.js';
import { loadCast, type CastMember } from '../character/cast.js';
import { charactersDir, stillPath } from '../character/files.js';
import type { CharacterVersionBody, CharacterVersionResource, CutStatus, ProductionAsset, ProductionCutBody, ProductionMediaUpload, ProductionPatch, ProductionSummary, ProductionUpsert } from '../remote/client.js';
import { approvedCut, currentCut, type ManifestCut, type ProductionManifest } from './manifest.js';
import { durationMsOf, imageTypeOf, sha256OfFile } from './probe.js';
import { cutMediaFiles, mediaTypeOf, mimeTypeOf, rewriteCutSources, rewriteWordsSources, type ProductionMediaType } from './sources.js';
import type { PosterMaker, ThumbMaker } from './thumbs.js';

/**
 * Pushes one production to a connected studio, idempotently:
 *
 * 1. Reads every cut (merging `extends`) and lists the files it plays, its
 *    rendered video, its segment thumbnails, a poster from its rendered
 *    video, and the cover.
 * 2. Hashes each file and asks the studio which it already has; uploads only
 *    the others. A file shared by several cuts or productions uploads once.
 * 3. Creates or updates the production by its slug, then replaces each cut:
 *    its sources rewritten to `asset:` refs, its words file beside it. Cuts
 *    the studio has that the manifest no longer lists are removed.
 * 4. Points a new production at its approved and current cuts.
 *
 * A manifest with a `cast` also pushes each character version it names (its
 * reference stills uploaded like any other image), before the production
 * links to them. A version is stored once; pushing it again is a no-op.
 *
 * Reviews made in Studio win over the manifest: a cut takes the manifest's
 * status only when the push creates it, and a production that already had
 * cuts keeps its approved and current cut. `resetStatus` makes all of them
 * match the manifest again.
 */

/** The studio calls a push makes; `StudioClient` has them all. */
export interface ProductionPushClient {
  upsertProduction(body: ProductionUpsert): Promise<ProductionSummary>;
  updateProduction(id: string, patch: ProductionPatch): Promise<ProductionSummary>;
  findProductionMedia(hashes: readonly string[]): Promise<Map<string, ProductionAsset>>;
  uploadProductionMedia(upload: ProductionMediaUpload): Promise<ProductionAsset>;
  putProductionCut(id: string, cutId: string, body: ProductionCutBody): Promise<unknown>;
  deleteProductionCut(id: string, cutId: string): Promise<void>;
  /** Needed only when the manifest has a cast. */
  putCharacterVersion?(slug: string, version: number, body: CharacterVersionBody): Promise<CharacterVersionResource>;
}

export interface PushOptions {
  /** Makes a segment's thumbnail and returns its path, or null for none. */
  thumbs: ThumbMaker | null;
  /** Makes a poster for a cut's rendered video and returns its path; none when null. */
  posters?: PosterMaker | null;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Hashes a file; default a streaming SHA-256. */
  hash?: (file: string) => Promise<string>;
  /** Opens a file as an upload body; default `fs.openAsBlob`. */
  open?: (file: string) => Promise<Blob>;
  /** A file's size; default `fs.stat`. */
  size?: (file: string) => Promise<number>;
  /** A media file's length in ms; default read from MP4 and WAV headers. */
  duration?: (file: string, mimeType: string) => Promise<number | undefined>;
  /** Reads a cut with its words; default the cut loader, which merges `extends`. */
  loadCut?: (cutPath: string, root: string) => Promise<LoadedCut>;
  /**
   * Sets every cut's status, and the approved and current cut, from the
   * manifest, overriding what was set in Studio. Default false: existing cuts
   * keep their status, and an existing production its approved and current cut.
   */
  resetStatus?: boolean;
  /** Loads the manifest's cast; default the character files in `docs/characters` beside its repository. */
  loadCast?: (manifest: ProductionManifest) => Promise<CastMember[]>;
}

export interface LoadedCut {
  /** The merged cut, as written (local sources). */
  cut: CutFile;
  /** Resolved against the media root, words applied. */
  timeline: Timeline;
  /** Its words file, or null. */
  words: WordsFile | null;
  /** Lines whose stored words no longer match. */
  stale: Array<{ id: string; reason: string }>;
}

export interface PushedFile {
  path: string;
  sha256: string;
  bytes: number;
  assetId: string;
  uploaded: boolean;
}

export interface PushReport {
  productionId: string;
  slug: string;
  title: string;
  cuts: { cut: number; rendered: number; removed: string[] };
  /** Files sent this time. */
  uploaded: PushedFile[];
  /** Files the studio already had. */
  reused: PushedFile[];
  /** Words that no longer match their line, by cut, so they're left out. */
  staleWords: Array<{ cut: string; line: string; reason: string }>;
  /** Cuts the studio already had with a status other than the manifest's, which they keep. */
  keptStatus: Array<{ cut: string; status: CutStatus; manifest: CutStatus }>;
  /** Approved or current cuts the studio already had, other than the manifest's, which it keeps. */
  keptPointers: Array<{ pointer: 'approved' | 'current'; studio: string | null; manifest: string | null }>;
  /** The character versions its cast names, pushed or already there: `rick@1`. */
  characters: string[];
}

interface PlannedFile {
  path: string;
  mediaType: ProductionMediaType;
  mimeType: string;
}

async function defaultLoadCut(cutPath: string, root: string): Promise<LoadedCut> {
  const loaded = await loadCutWithWords(cutPath, { root });
  const words = loaded.hasWordsFile ? await readWordsFile(wordsFilePath(cutPath)) : null;
  return { cut: loaded.cut, timeline: loaded.timeline, words, stale: loaded.merge.stale };
}

const relative = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel.startsWith('..') ? file : rel.split(path.sep).join('/');
};

export async function pushProduction(client: ProductionPushClient, manifest: ProductionManifest, options: PushOptions): Promise<PushReport> {
  const log = options.log ?? (() => {});
  const hash = options.hash ?? sha256OfFile;
  const open = options.open ?? ((file: string) => fs.openAsBlob(file));
  const size = options.size ?? (async (file: string) => (await fs.promises.stat(file)).size);
  const duration = options.duration ?? durationMsOf;
  const loadCut = options.loadCut ?? defaultLoadCut;

  // 1. Every file the production needs, once each.
  const planned = new Map<string, PlannedFile>();
  const plan = (file: string, mediaType: ProductionMediaType) => {
    if (planned.has(file)) return;
    const mimeType = mimeTypeOf(file);
    if (!mimeType) throw new Error(`${file}: not a media file a production takes (by its extension).`);
    planned.set(file, { path: file, mediaType, mimeType });
  };
  if (manifest.cover) plan(manifest.cover, 'image');

  // The cast's characters, and their reference stills.
  const cast = manifest.cast.length === 0
    ? []
    : await (options.loadCast ?? ((m: ProductionManifest) => loadCast(m.cast, charactersDir({ from: path.dirname(m.file) }))))(manifest);
  if (cast.length > 0 && !client.putCharacterVersion) throw new Error('This studio client cannot store characters; update mdmedia.');
  for (const member of cast) for (const still of member.character.stills) plan(stillPath(member.character, still.file), 'image');

  const loaded = new Map<string, { cut: LoadedCut; rendered: string | null; thumbs: Map<string, string> }>();
  const posters = new Map<string, string>();
  const poster = async (cutId: string, video: string | null) => {
    if (!video || !options.posters) return;
    const file = await options.posters(video);
    if (!file) return;
    posters.set(cutId, file);
    plan(file, 'image');
  };
  for (const entry of manifest.cuts) {
    if (entry.kind === 'rendered') {
      plan(entry.rendered, 'video');
      await poster(entry.id, entry.rendered);
      continue;
    }
    const cut = await loadCut(entry.cut, manifest.root);
    for (const file of cutMediaFiles(cut.timeline)) plan(file.path, mediaTypeOf(file.path, file.role));
    const rendered = entry.rendered ?? cut.timeline.output;
    if (rendered) plan(rendered, 'video');
    await poster(entry.id, rendered ?? null);
    const thumbs = new Map<string, string>();
    if (options.thumbs) {
      for (const segment of cut.timeline.segments) {
        const thumb = await options.thumbs(cut.timeline, segment);
        if (!thumb) continue;
        thumbs.set(segment.id, thumb);
        plan(thumb, 'image');
      }
    }
    loaded.set(entry.id, { cut, rendered, thumbs });
  }

  // 2. Hash, ask, upload what's missing.
  const files = [...planned.values()];
  log(`${manifest.title}: hashing ${files.length} files`);
  const hashes = new Map<string, string>();
  for (const file of files) {
    try {
      hashes.set(file.path, await hash(file.path));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') throw new Error(`Missing media file: ${file.path}`);
      throw error;
    }
  }
  const found = await client.findProductionMedia([...new Set(hashes.values())]);
  const byHash = new Map(found);
  const report: PushReport = {
    productionId: '', slug: manifest.slug, title: manifest.title, cuts: { cut: 0, rendered: 0, removed: [] }, uploaded: [], reused: [], staleWords: [],
    keptStatus: [], keptPointers: [], characters: [],
  };
  const assetOf = new Map<string, string>();
  for (const file of files) {
    const sha256 = hashes.get(file.path)!;
    const bytes = await size(file.path);
    let asset = byHash.get(sha256);
    const uploaded = !asset;
    if (!asset) {
      log(`  uploading ${relative(manifest.root, file.path)} (${(bytes / 1048576).toFixed(1)} MB)`);
      const durationMs = file.mediaType === 'image' ? undefined : await duration(file.path, file.mimeType);
      // A generated still can be JPEG bytes under a .png name; the studio checks the bytes, so an image is typed by them.
      const mimeType = file.mediaType === 'image' ? ((await imageTypeOf(file.path)) ?? file.mimeType) : file.mimeType;
      asset = await client.uploadProductionMedia({
        sha256, mediaType: file.mediaType, mimeType, byteLength: bytes, body: await open(file.path),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      byHash.set(sha256, asset);
    }
    assetOf.set(file.path, asset.id);
    // A file is counted once per push: as uploaded the first time its bytes are sent, else as reused.
    const counted = [...report.uploaded, ...report.reused].some((f) => f.sha256 === sha256);
    if (!counted) (uploaded ? report.uploaded : report.reused).push({ path: file.path, sha256, bytes, assetId: asset.id, uploaded });
  }

  // 3. The cast's character versions, then the production, then each cut.
  const pushed = new Set<string>();
  for (const member of cast) {
    const c = member.character;
    const ref = formatCharacterRef(c);
    if (pushed.has(ref)) continue;
    log(`  character ${ref}`);
    const stills = Object.fromEntries(c.stills.map((s) => [s.id, assetOf.get(stillPath(c, s.file))!]));
    await client.putCharacterVersion!(c.id, c.version, { character: c, stills });
    pushed.add(ref);
  }
  report.characters = [...pushed];
  const production = await client.upsertProduction({
    slug: manifest.slug,
    title: manifest.title,
    series: manifest.series,
    coverAssetId: manifest.cover ? assetOf.get(manifest.cover)! : null,
    ...(manifest.cast.length > 0 ? { cast: manifest.cast.map((entry) => ({ role: entry.role, character: formatCharacterRef(entry.character) })) } : {}),
  });
  report.productionId = production.id;
  // What the studio had before this push: a status set there (in review) stays unless resetting.
  const had = new Map(production.cuts.map((cut) => [cut.id, cut.status]));
  const reset = options.resetStatus === true;
  for (const [order, entry] of manifest.cuts.entries()) {
    const posterFile = posters.get(entry.id);
    const existing = had.get(entry.id);
    const status = reset || existing === undefined ? entry.status : existing;
    if (status !== entry.status) report.keptStatus.push({ cut: entry.id, status, manifest: entry.status });
    const body = { ...cutBody(entry, order, status, manifest, loaded.get(entry.id), assetOf, report), ...(posterFile ? { posterAssetId: assetOf.get(posterFile)! } : {}) };
    await client.putProductionCut(production.id, entry.id, body);
    if (entry.kind === 'cut') report.cuts.cut++;
    else report.cuts.rendered++;
  }
  const wanted = new Set(manifest.cuts.map((cut) => cut.id));
  for (const old of production.cuts.filter((cut) => !wanted.has(cut.id))) {
    await client.deleteProductionCut(production.id, old.id);
    report.cuts.removed.push(old.id);
  }

  // 4. Which cut is approved, and which to show first: for a new production (one with no cuts before), or when resetting.
  const approvedCutId = approvedCut(manifest);
  const currentCutId = currentCut(manifest);
  if (reset || had.size === 0) {
    await client.updateProduction(production.id, { approvedCutId, currentCutId });
  } else {
    if (production.approvedCutId !== approvedCutId) report.keptPointers.push({ pointer: 'approved', studio: production.approvedCutId, manifest: approvedCutId });
    if (production.currentCutId !== currentCutId) report.keptPointers.push({ pointer: 'current', studio: production.currentCutId, manifest: currentCutId });
  }
  return report;
}

function cutBody(
  entry: ManifestCut,
  order: number,
  status: CutStatus,
  manifest: ProductionManifest,
  loaded: { cut: LoadedCut; rendered: string | null; thumbs: Map<string, string> } | undefined,
  assetOf: Map<string, string>,
  report: PushReport,
): ProductionCutBody {
  const common = {
    label: entry.label,
    status,
    notes: entry.notes,
    order,
    ...(entry.createdAt === null ? {} : { createdAt: entry.createdAt }),
  };
  if (entry.kind === 'rendered') {
    return { ...common, kind: 'rendered', renderedAssetId: assetOf.get(entry.rendered)!, source: { rendered: relative(manifest.root, entry.rendered) } };
  }
  const { cut, rendered, thumbs } = loaded!;
  const byRef = new Map(cutMediaFiles(cut.timeline).map((file) => [file.ref, assetOf.get(file.path)!]));
  for (const stale of cut.stale) report.staleWords.push({ cut: entry.id, line: stale.id, reason: stale.reason });
  return {
    ...common,
    kind: 'cut',
    cut: rewriteCutSources(cut.cut, byRef),
    words: cut.words ? rewriteWordsSources(cut.words, manifest.root, assetOf) : null,
    renderedAssetId: rendered ? assetOf.get(rendered)! : null,
    thumbs: Object.fromEntries([...thumbs].map(([segment, file]) => [segment, assetOf.get(file)!])),
    source: { cut: entry.cutRef, ...(rendered ? { rendered: relative(manifest.root, rendered) } : {}) },
  };
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const total = (files: PushedFile[]) => files.reduce((sum, file) => sum + file.bytes, 0);

/** One line per production, e.g. `Night Wagon: The Argument — 10 cuts (2 cut files, 8 rendered); uploaded 31 files (82.4 MB), reused 4 (16.7 MB)`. */
export function describePush(report: PushReport): string {
  const cuts = report.cuts.cut + report.cuts.rendered;
  const kinds = [report.cuts.cut && `${report.cuts.cut} cut file${report.cuts.cut === 1 ? '' : 's'}`, report.cuts.rendered && `${report.cuts.rendered} rendered`].filter(Boolean).join(', ');
  const removed = report.cuts.removed.length ? `; removed ${report.cuts.removed.join(', ')}` : '';
  const stale = report.staleWords.length ? `; ${report.staleWords.length} lines' words are stale` : '';
  const kept = [
    ...report.keptStatus.map((k) => `${k.cut} ${k.status}`),
    ...report.keptPointers.map((k) => `${k.pointer} ${k.studio ?? 'none'}`),
  ];
  const studio = kept.length ? `; kept from Studio: ${kept.join(', ')}` : '';
  const castLine = report.characters.length ? `; cast ${report.characters.join(', ')}` : '';
  return `${report.title} — ${cuts} cut${cuts === 1 ? '' : 's'} (${kinds})${castLine}; uploaded ${report.uploaded.length} files (${mb(total(report.uploaded))}), reused ${report.reused.length} (${mb(total(report.reused))})${removed}${stale}${studio}`;
}

/** Totals over several pushes. A file two productions share counts once, as uploaded if either sent it. */
export function describeTotals(reports: PushReport[]): string {
  const uploaded = new Map<string, PushedFile>();
  const reused = new Map<string, PushedFile>();
  for (const report of reports) {
    for (const file of report.uploaded) uploaded.set(file.sha256, file);
    for (const file of report.reused) reused.set(file.sha256, file);
  }
  for (const sha of uploaded.keys()) reused.delete(sha);
  const cuts = reports.reduce((sum, report) => sum + report.cuts.cut + report.cuts.rendered, 0);
  return `${reports.length} productions, ${cuts} cuts; uploaded ${uploaded.size} files (${mb(total([...uploaded.values()]))}), reused ${reused.size} (${mb(total([...reused.values()]))})`;
}
