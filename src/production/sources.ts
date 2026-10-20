import path from 'node:path';
import type { AudioClip, CutFile, ResolvedSource, Segment, Timeline, WordsFile } from '../cut/index.js';

/**
 * The media a cut uses, and the cut rewritten to name it by uploaded asset:
 * every file or take becomes `asset:<id>`. Pure: nothing here reads a file.
 */

/** What a production file is, as a cut uses it. */
export type ProductionMediaType = 'video' | 'image' | 'voice' | 'music' | 'sfx';

/** Where in the cut a source is used. */
export type SourceRole = 'segment' | 'segment-audio' | 'line' | 'music' | 'sfx' | 'overlay' | 'provenance';

export interface CutMediaFile {
  /** The `src` as the cut writes it, e.g. `take:nw6-highway-t1`. */
  ref: string;
  /** Its absolute path. */
  path: string;
  /** Where it is first used. */
  role: SourceRole;
}

const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac']);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

/** The content type for a media file, by extension, or null when it isn't one a production takes. */
export function mimeTypeOf(file: string): string | null {
  return MIME[path.extname(file).toLowerCase()] ?? null;
}

export const isStill = (file: string) => IMAGE.has(path.extname(file).toLowerCase());

/** What a file is in a production: pictures by their extension, sound by where the cut uses it. */
export function mediaTypeOf(file: string, role: SourceRole): ProductionMediaType {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO.has(ext)) return 'video';
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return role === 'line' ? 'voice' : role === 'music' ? 'music' : 'sfx';
  return 'video';
}

const fileOf = (src: ResolvedSource): string | null => (src.kind === 'take' || src.kind === 'file' ? src.path : null);

/**
 * Every file a resolved cut plays, once each, in timeline order: its shots,
 * their sound, its lines, music (every part of a bed), effects and overlays.
 * Then the stills its sources were started from (their provenance's first
 * frames), which it doesn't play but which travel with it. Clips heard in a
 * segment's own sound add nothing.
 */
export function cutMediaFiles(timeline: Timeline): CutMediaFile[] {
  const files: CutMediaFile[] = [];
  const seen = new Set<string>();
  const add = (src: ResolvedSource | null | undefined, role: SourceRole) => {
    if (!src || src.kind === 'synth' || src.kind === 'bed') return;
    const file = fileOf(src);
    if (!file || seen.has(src.ref)) return;
    seen.add(src.ref);
    files.push({ ref: src.ref, path: file, role });
  };
  for (const segment of timeline.segments) {
    add(segment.src, 'segment');
    if (segment.audio) add(segment.audio.src, 'segment-audio');
  }
  for (const line of timeline.lines) if (line.audio.kind === 'file') add(line.audio.src, 'line');
  for (const [role, clips] of [['music', timeline.music], ['sfx', timeline.sfx]] as const) {
    for (const clip of clips) {
      if (clip.segment !== null) continue;
      add(clip.src, role);
      for (const part of clip.parts ?? []) add(part.src, role);
    }
  }
  for (const overlay of timeline.overlays) add(overlay.src, 'overlay');
  for (const entry of Object.values(timeline.sources)) add(entry.firstFrame, 'provenance');
  return files;
}

export class UnmappedSourceError extends Error {
  constructor(readonly refs: string[]) {
    super(`No uploaded asset for ${refs.map((ref) => `"${ref}"`).join(', ')}.`);
    this.name = 'UnmappedSourceError';
  }
}

/**
 * The cut with every file and take source replaced by `asset:<id>` from
 * `assets` (by the `src` as written). Colors and synths stay. The `output`
 * path is dropped, since the rendered video travels as its own asset, and the
 * media root no longer applies.
 */
export function rewriteCutSources(cut: CutFile, assets: ReadonlyMap<string, string>): CutFile {
  const missing = new Set<string>();
  const swap = (ref: string): string => {
    if (ref.startsWith('color:') || ref.startsWith('asset:')) return ref;
    const id = assets.get(ref);
    if (!id) {
      missing.add(ref);
      return ref;
    }
    return `asset:${id}`;
  };
  /** A provenance ref: swapped when it was uploaded, else kept as the name it is. */
  const label = (ref: string): string => {
    const id = assets.get(ref);
    return id ? `asset:${id}` : ref;
  };
  const segment = (s: Segment): Segment => ({
    ...s,
    src: swap(s.src),
    ...(s.audio && s.audio.src !== undefined ? { audio: { ...s.audio, src: swap(s.audio.src) } } : {}),
  });
  const clip = (c: AudioClip): AudioClip => ({
    ...c,
    ...(c.src === undefined ? {} : { src: swap(c.src) }),
    ...(c.parts === undefined ? {} : { parts: c.parts.map((part) => ({ ...part, src: swap(part.src) })) }),
  });
  const out: CutFile = {
    ...cut,
    media: { root: '.' },
    segments: cut.segments.map(segment),
  };
  delete out.output;
  if (cut.lines) out.lines = cut.lines.map((line) => (line.src === undefined ? line : { ...line, src: swap(line.src) }));
  if (cut.music) out.music = cut.music.map(clip);
  if (cut.sfx) out.sfx = cut.sfx.map(clip);
  if (cut.overlays) out.overlays = cut.overlays.map((overlay) => ({ ...overlay, src: swap(overlay.src) }));
  if (cut.sources) {
    out.sources = Object.fromEntries(
      Object.entries(cut.sources).map(([ref, entry]) => [
        label(ref),
        {
          ...entry,
          ...(entry.extendedFrom === undefined ? {} : { extendedFrom: label(entry.extendedFrom) }),
          ...(entry.swappedFrom === undefined ? {} : { swappedFrom: label(entry.swappedFrom) }),
          ...(entry.firstFrame === undefined ? {} : { firstFrame: label(entry.firstFrame) }),
        },
      ]),
    );
  }
  if (missing.size) throw new UnmappedSourceError([...missing]);
  return out;
}

/**
 * The words file with each line's `fingerprint.source` (a path under `root`)
 * replaced by the `asset:<id>` uploaded from that file, so its words still
 * match the rewritten cut. Entries for files that weren't uploaded are kept
 * as they are; they no longer match any line, so they're simply stale.
 */
export function rewriteWordsSources(words: WordsFile, root: string, assetsByPath: ReadonlyMap<string, string>): WordsFile {
  const lines: WordsFile['lines'] = {};
  for (const [id, entry] of Object.entries(words.lines)) {
    const asset = assetsByPath.get(path.resolve(root, entry.fingerprint.source));
    lines[id] = asset ? { ...entry, fingerprint: { ...entry.fingerprint, source: `asset:${asset}` } } : entry;
  }
  return { ...words, lines };
}
