import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, resolveCutJson, segmentGainAt, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * Regulars, Take 3 (ending fixed), ported from regulars3/edit.mjs. The
 * expected times are what a copy of that script printed with its ffmpeg call
 * stubbed out (its own `console.log(JSON.stringify({ at, END }))`, plus its
 * filter graph), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/regulars-take3.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts regulars3/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = { take2: 0, lines: 13.042, eddie: 16.4, sit: 18.6 };
const END = 21.518;

/**
 * Where each line's speech starts on the timeline, measured from the shots'
 * own sound (the speech onsets `cut words` found: WALT! at 9.83 and "What's"
 * at 10.82 in Take 2, "Same" at 0.622 and "Different" at 2.432 in the lines
 * take, which starts 0.042 in). The review note's transcript has them at 9.6,
 * 10.7, 13.6 and 15.4.
 */
const ONSET = { walt: 9.83, story: 10.82, same: 13.62, stool: 15.432 };

/** Source lengths in seconds, from ffmpeg on the media (so every `out` is checked against it). */
const PROBED: Record<string, number> = {
  'review/clips/ch-regulars-take2.mp4': 16.0,
  'reg3-walt-lines-t2': 5.01,
  'reg3-eddie-laugh-t1': 4.01,
  'reg3-walt-sit-t3': 3.01,
  'audio/reg3-laugh.mp3': 5.0, // decoded length; the container says 5.04
};
const mediaLength = (src: ResolvedSource): number | undefined =>
  src.kind === 'take' ? PROBED[src.name] : src.kind === 'file' ? PROBED[src.ref] : undefined;

function resolve(): Timeline {
  const result = resolveCutJson(cut, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(0.001);
}

/** The video track's length in seconds, read from the MP4's `mdhd` box (no ffprobe needed). */
function videoTrackSeconds(file: string): number {
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

describe('Regulars, Take 3', () => {
  const timeline = resolve();

  it('puts every segment where regulars3/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/regulars-take3.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 21.518 at 24 fps, which ffmpeg rounds up to a whole frame (517 frames, 21.542 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each shot from its source, uncropped, with 15 ms ramps at every audio splice', () => {
    const shots: Record<string, [Partial<ResolvedSource>, number, number]> = {
      take2: [{ kind: 'file', path: `${ROOT}/review/clips/ch-regulars-take2.mp4` }, 0, 13.042], // frames 0-312, before the walk shot drifts
      lines: [{ kind: 'take', name: 'reg3-walt-lines-t2' }, 0.042, 3.4], // its first frame is Take 2's last, so skipped
      eddie: [{ kind: 'take', name: 'reg3-eddie-laugh-t1' }, 0.3, 2.5],
      sit: [{ kind: 'take', name: 'reg3-walt-sit-t3' }, 0.042, 2.96], // SIT = 2.918
    };
    for (const seg of timeline.segments) {
      const [src, a, b] = shots[seg.id];
      expect(seg.src).toMatchObject(src);
      expect([seg.in, seg.out]).toEqual([a, b]);
      expect(seg.crop).toBeNull();
      expect(seg.hold).toBe(0);
      expect(seg.fadeIn).toBe(0);
      // Only the sit fades its picture: fade=t=out:st=2.418:d=0.5.
      expect(seg.fadeOut).toBe(seg.id === 'sit' ? 0.5 : 0);
      // Each plays its own sound over its own in/out (atrim a:b), the shot's sound ramped over 15 ms at both ends
      // (afade=t=in:d=0.015, afade=t=out:st=d-0.015:d=0.015).
      expect(seg.audio).toMatchObject({ src, in: a, out: b, fadeIn: 0, start: seg.start, end: seg.end });
      expect(seg.mix).toEqual({ fadeIn: 0.015, fadeOut: 0.015 });
      // volume=0.9 on Eddie's laugh only.
      expect(seg.audio!.volume).toBe(seg.id === 'eddie' ? 0.9 : 1);
    }
    // The 0.7 s fade of the whole joined sound ([fx]afade=t=out:st=20.818:d=0.7) lies inside the sit, so it is
    // the sit's own fade-out, under its 15 ms ramp.
    for (const id of ['take2', 'lines', 'eddie']) expect(byId(timeline.segments, id).audio!.fadeOut).toBe(0);
    const sit = byId(timeline.segments, 'sit');
    expect(sit.audio!.fadeOut).toBe(0.7);
    near(sit.end - sit.audio!.fadeOut, 20.818);
    // On every frame of the cut, the shots' sound gain is the script's: each ramp, times the joined fade.
    const script = (t: number): number => {
      const seg = timeline.segments.find((s) => t >= s.start && t < s.end);
      if (!seg) return 0;
      const d = seg.end - seg.start;
      const u = t - seg.start;
      let g = (seg.id === 'eddie' ? 0.9 : 1) * Math.min(1, u / 0.015) * Math.min(1, (d - u) / 0.015);
      if (t > END - 0.7) g *= (END - t) / 0.7;
      return g;
    };
    for (let k = 0; k < END * 24; k++) {
      const t = k / 24 + 0.004;
      const seg = timeline.segments.find((s) => t >= s.start && t < s.end);
      if (seg) expect(Math.abs(segmentGainAt(seg, t) - script(t))).toBeLessThan(1e-6);
    }
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(timeline.music).toEqual([]);
    expect(timeline.overlays).toEqual([]); // the Regulars title is in Take 2's intro picture
  });

  it("places every line in the shot that carries it, starting just before its speech", () => {
    const lines: Record<string, [string, string, string, number]> = {
      walt: ['The regulars', 'WALT!', 'take2', 10.7], // several regulars at once, until Eddie's line
      story: ['Eddie', "What's the story, Walt?", 'take2', PRINTED.lines], // to the cut, before Take 2's "Same"
      same: ['Walt', 'Same as yesterday, Eddie.', 'lines', 15.342], // until the next line
      stool: ['Walt', 'Different stool.', 'lines', PRINTED.eddie],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      const [speaker, text, segment, end] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      expect(line.audio).toEqual({ kind: 'segment', segment });
      const onset = ONSET[line.id as keyof typeof ONSET];
      expect(onset - line.start).toBeGreaterThan(0);
      expect(onset - line.start).toBeLessThan(0.15);
      near(line.end, end);
    }
    // The joke: "Different stool." lands after a beat, and the cut to Eddie's laugh comes after it, never under it.
    expect(byId(timeline.lines, 'stool').end).toBe(byId(timeline.segments, 'eddie').start);
  });

  it('lays the studio laugh from the cut to Eddie, fading with the picture', () => {
    expect(timeline.sfx.map((s) => s.id)).toEqual(['laugh']);
    const laugh = byId(timeline.sfx, 'laugh');
    expect(laugh.src).toMatchObject({ kind: 'file', path: `${ROOT}/audio/reg3-laugh.mp3` });
    // atrim=0:5.118 (to the end of the cut), adelay=16400; the file is 5.0 s, so it stops 0.118 s early.
    expect([laugh.in, laugh.out]).toEqual([0, 5]);
    expect([laugh.start, laugh.end]).toEqual([PRINTED.eddie, 21.4]);
    // volume=0.7,afade=t=out:st=4.218:d=0.9 in the laugh's own clock: a fade timed to the cut's end, past the file's.
    expect([laugh.fadeOut, laugh.fadeOutEnd]).toEqual([0.9, END]);
    expect(laugh.volume).toEqual([{ t: PRINTED.eddie, value: 0.7 }]);
    const script = (t: number): number => {
      const u = t - PRINTED.eddie;
      if (u < 0 || u >= 5) return 0;
      return 0.7 * (u < 4.218 ? 1 : Math.max(0, (5.118 - u) / 0.9));
    };
    for (let k = Math.floor(PRINTED.eddie * 100) - 5; k <= Math.ceil(END * 100) + 5; k++) {
      expect(Math.abs(gainAt(laugh, k / 100) - script(k / 100))).toBeLessThan(0.001);
    }
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([4, 4, 0, 1, 0]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
