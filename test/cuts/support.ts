import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { applyWords, parseCut, resolveCut, type ResolvedSource, type Timeline, type WordsFile } from '../../src/cut/index';

/** Helpers shared by the ports of single-take productions (one generation, cut where its own picture cuts). */

export function near(actual: number, expected: number, within = 0.001): void {
  expect(Math.abs(actual - expected)).toBeLessThan(within);
}

export function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

/** A file's SHA-256, hex, or null when it isn't on this machine. */
export function sha256Of(file: string): string | null {
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The video track's length in seconds, read from the MP4's `mdhd` box (no ffprobe needed). */
export function videoTrackSeconds(file: string): number {
  const b = readFileSync(file);
  const containers = new Set(['moov', 'trak', 'mdia']);
  let result: number | undefined;
  const walk = (start: number, end: number, track: { mdhd?: [number, number]; video?: boolean }): void => {
    let p = start;
    while (p + 8 <= end) {
      let size = b.readUInt32BE(p);
      const type = b.toString('latin1', p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(p + 8));
        header = 16;
      } else if (size === 0) size = end - p;
      const body = p + header;
      if (type === 'trak') {
        const t: { mdhd?: [number, number]; video?: boolean } = {};
        walk(body, p + size, t);
        if (t.video && t.mdhd) result = t.mdhd[1] / t.mdhd[0];
      } else if (containers.has(type)) walk(body, p + size, track);
      else if (type === 'mdhd') {
        const v1 = b[body] === 1;
        track.mdhd = v1
          ? [b.readUInt32BE(body + 20), Number(b.readBigUInt64BE(body + 24))]
          : [b.readUInt32BE(body + 12), b.readUInt32BE(body + 16)];
      } else if (type === 'hdlr') track.video = b.toString('latin1', body + 8, body + 12) === 'vide';
      p += size;
    }
  };
  walk(0, b.length, {});
  if (result === undefined) throw new Error(`no video track in ${file}`);
  return result;
}

export interface Port {
  /** The cut file, as JSON. */
  json: unknown;
  /** Its media root. */
  root: string;
  /** Resolves it with its words file applied (checked against the take's contents when the take is here). */
  timeline: Timeline;
  /** Lines that got words from the words file. */
  applied: string[];
  /** Lines whose stored words no longer match. */
  stale: string[];
}

/** Reads `docs/cuts/<name>.cut.json` and its words file, and resolves them with these probed lengths (seconds by take name or root-relative path). */
export function loadPort(name: string, lengths: Record<string, number>): Port {
  const json: unknown = JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}.cut.json`, import.meta.url), 'utf8'));
  const words = JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}.words.json`, import.meta.url), 'utf8')) as WordsFile;
  const root = (json as { media: { root: string } }).media.root;
  const parsed = parseCut(json);
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
  const mediaLength = (src: ResolvedSource): number | undefined =>
    src.kind === 'take' ? lengths[src.name] : src.kind === 'file' ? lengths[src.ref] : undefined;
  const hashes = new Map<string, string | undefined>();
  const sha256 = (file: string): string | undefined => {
    if (!hashes.has(file)) hashes.set(file, sha256Of(file) ?? undefined);
    return hashes.get(file);
  };
  const merge = applyWords(parsed.value, words, { mediaLength, sha256 });
  const result = resolveCut(merge.cut, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return { json, root, timeline: result.value, applied: merge.applied, stale: merge.stale.map((s) => s.id) };
}

/**
 * Checks that the segments are one take, cut where its picture cuts and played
 * in step: each starts on its frame (frame / 24) and plays the take from that
 * same time, with the take's own sound over the same stretch.
 */
export function expectInStep(timeline: Timeline, take: string, cutFrames: Record<string, number>, fps = 24): void {
  expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(cutFrames));
  for (const seg of timeline.segments) {
    near(seg.start, cutFrames[seg.id] / fps);
    expect(seg.src).toMatchObject({ kind: 'take', name: take });
    near(seg.in, seg.start);
    expect(seg.hold).toBe(0);
    expect(seg.crop).toBeNull();
    expect([seg.fadeIn, seg.fadeOut]).toEqual([0, 0]);
    expect(seg.audio).toMatchObject({ src: { kind: 'take', name: take }, in: seg.in, out: seg.out, volume: 1, start: seg.start, end: seg.end });
  }
  for (let i = 1; i < timeline.segments.length; i++) expect(timeline.segments[i].start).toBe(timeline.segments[i - 1].end);
  expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
}

/** Where a line's speech is on the timeline: its first word's start and its last word's end. */
export function speechOf(timeline: Timeline, id: string): [number, number] {
  const words = byId(timeline.lines, id).words;
  if (words.length === 0) throw new Error(`${id} has no words`);
  return [words[0].start, words[words.length - 1].end];
}

/** The segment playing at time `t`. */
export function segmentAt(timeline: Timeline, t: number): string {
  const seg = timeline.segments.find((s) => t >= s.start && t < s.end);
  if (!seg) throw new Error(`no segment at ${t}`);
  return seg.id;
}
