import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, opacityAt, positionAt, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * Big Hal's car lot, Take 5 (shot by shot), ported from hal5/edit.mjs. The
 * expected times are what a copy of that script printed with its ffmpeg call
 * stubbed out (its own `console.log(JSON.stringify({ at, word, END }))`, plus
 * the graphics list `L`), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/big-hal-take5.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts hal5/edit.mjs printed (its A to G), in its order. */
const PRINTED: Record<string, number> = {
  open: 0, inspect: 9.85, pat: 14, mcu: 15.43, door: 16.68, hood: 18.23, finish: 21.13,
};
/** The word times it printed, on the timeline. */
const WORD = {
  nmd: 5.65, apr: 6.92, n99: 8.73, and: 9.98, hand: 11.5, personally: 14.29, start: 15.87, doors: 17.09,
  thunk: 17.93, thisone: 18.55, withEnd: 20.68, wheels: 21.68, so: 22.88,
};
const END = 27.31;

/** Its graphics list: [png, start, end, blink period, x, y], as printed. */
const GFX: Array<[string, string, number, number, number, number | ((t: number) => number), number]> = [
  ['nmd', 'hal3-nmd', 5.65, 6.92, 0, 0, 0],
  ['apr', 'hal3-apr', 6.92, 8.73, 0, 0, 0],
  ['n99', 'hal3-99', 8.73, 9.93, 0.5, 0, 0],
  ['hand', 'hal4-hand', 11.5, 14, 0, 0, 0],
  ['starts', 'hal4-starts', 15.87, 16.68, 0, 0, 0],
  ['doors', 'hal4-doors', 17.09, 18.23, 0, 0, -250],
  ['included', 'hal3-wheels', 21.68, 22.88, 0, 0, 0],
  ['fine', 'hal4-fine', 21.68, 24.08, 0, (t) => 1085 - (t - 21.68) * 950, 0],
  ['close', 'hal3-close', 22.88, 27.31, 0, 0, 0],
  ['phone', 'hal3-phone', 23.18, 27.31, 0.6, 0, 0],
  ['route', 'hal3-route', 23.18, 27.31, 0, 0, 0],
];

/** Source lengths in seconds, from ffmpeg on the takes (so every `out` is checked against its media). */
const PROBED: Record<string, number> = {
  'big-hal-4ab-t2': 16.0,
  'hal5-inspect-t6': 5.03,
  'hal5-personally-t2': 4.01,
  'hal5-pat-t1': 4.03,
  'hal5-lines-t1': 5.01,
  'hal5-door-t1': 4.01,
  'hal5-thisone-t3': 6.02,
  'hal5-wheels-t1': 6.02,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

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

describe("Big Hal's car lot, Take 5", () => {
  const timeline = resolve();

  it('puts every segment where hal5/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/big-hal-take5.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 27.31 at 24 fps, which ffmpeg rounds up to a whole frame (656 frames, 27.333 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each shot from its take, uncropped, with 12 ms fades at every audio cut', () => {
    const shots: Record<string, [string, number, number]> = {
      open: ['big-hal-4ab-t2', 0, 9.85], // Take 4's own opening, before its first extend seam at 10.0
      inspect: ['hal5-inspect-t6', 0.3, 4.45],
      pat: ['hal5-pat-t1', 1.07, 2.5],
      mcu: ['hal5-lines-t1', 0.3, 1.55],
      door: ['hal5-door-t1', 1.75, 3.3],
      hood: ['hal5-thisone-t3', 0.55, 3.45],
      finish: ['hal5-wheels-t1', 0.52, 5.7],
    };
    for (const seg of timeline.segments) {
      const [name, a, b] = shots[seg.id];
      expect(seg.src).toMatchObject({ kind: 'take', name });
      expect([seg.in, seg.out]).toEqual([a, b]);
      expect(seg.crop).toBeNull();
      expect([seg.fadeIn, seg.fadeOut]).toEqual([0, 0]);
      expect(seg.hold).toBe(seg.id === 'finish' ? 1 : 0);
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name }, volume: 1, fadeIn: 0.012 });
    }
    // Every shot but the pat and the finish plays its own sound over its own in/out, faded 12 ms at both ends.
    for (const id of ['open', 'inspect', 'mcu', 'door', 'hood']) {
      const seg = byId(timeline.segments, id);
      expect(seg.audio).toMatchObject({ in: seg.in, out: seg.out, fadeOut: 0.012, start: seg.start, end: seg.end });
    }
    // The insert's thumps trail the palm's contact by two frames, so its sound runs 0.08 s early.
    const pat = byId(timeline.segments, 'pat');
    expect(pat.audio).toMatchObject({ in: 1.15, out: 2.58, fadeOut: 0.012 });
    near(pat.audio!.end, pat.end);
    // The finish's own sound runs 0.1 s into the freeze and fades out over 0.15 s (afade st=5.13 d=0.15).
    const finish = byId(timeline.segments, 'finish');
    expect(finish.audio).toMatchObject({ in: 0.52, out: 5.8, fadeOut: 0.15 });
    near(finish.audio!.end, PRINTED.finish + 5.28);
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(timeline.music).toEqual([]);
  });

  it('places every line where the script put it', () => {
    const lines: Record<string, [string, number, number]> = {
      howdy: ['Howdy folks! Big Hal here, at Big Hal\'s, the biggest lot in the tri-county area!', 0, WORD.nmd],
      nomoney: ['No money down!', WORD.nmd, WORD.apr],
      zero: ['Zero percent financing!', WORD.apr, WORD.n99],
      month: ['Ninety-nine a month!', WORD.n99, PRINTED.inspect],
      every: ['And every car on my lot is hand-inspected... by me!', WORD.and, PRINTED.pat],
      personally: ['PERSONALLY!', WORD.personally, 15.08], // heard to the end of its faded layer
      theystart: ['They start!', WORD.start, PRINTED.door],
      doorsclose: ['The doors close!', WORD.doors, PRINTED.hood],
      thisone: ['And this one? This one even comes with...', WORD.thisone, PRINTED.finish],
      wheels: ['Wheels!', WORD.wheels, WORD.so],
      comeon: ["So come on down to Big Hal's and save big!", WORD.so, END - 1], // to the freeze
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      const [text, start, end] = lines[line.id];
      expect([line.speaker, line.text]).toEqual(['Big Hal', text]);
      near(line.start, start);
      near(line.end, end);
    }
    const segments = Object.fromEntries(timeline.lines.map((l) => [l.id, l.audio.kind === 'segment' ? l.audio.segment : null]));
    expect(segments).toEqual({
      howdy: 'open', nomoney: 'open', zero: 'open', month: 'open', every: 'inspect', personally: 'pat',
      theystart: 'mcu', doorsclose: 'door', thisone: 'hood', wheels: 'finish', comeon: 'finish',
    });
  });

  it('voices PERSONALLY! from its own take over the pat, and rings the second thump on over the cut', () => {
    const pers = byId(timeline.sfx, 'pers_snd');
    expect(pers.src).toMatchObject({ kind: 'take', name: 'hal5-personally-t2' });
    // "PER" (0.84 in its take) lands 0.29 s into the insert, so the layer starts 0.55 in.
    expect([pers.in, pers.out]).toEqual([0.55, 1.63]);
    expect([pers.start, pers.end]).toEqual([PRINTED.pat, 15.08]);
    near(pers.start + (0.84 - pers.in), WORD.personally);
    // afade=t=out:st=0.93:d=0.15, under the segment's 12 ms fade in.
    expect(gainAt(pers, pers.start + 0.006)).toBeCloseTo(0.5, 6);
    expect(gainAt(pers, pers.start + 0.93)).toBeCloseTo(1, 6);
    expect(gainAt(pers, pers.start + 1.005)).toBeCloseTo(0.5, 6);

    // The pat take, picked up in step where the insert's sound left off.
    const ring = byId(timeline.sfx, 'ring');
    const pat = byId(timeline.segments, 'pat');
    expect(ring.src).toMatchObject({ kind: 'take', name: 'hal5-pat-t1' });
    near(ring.in, pat.audio!.out);
    expect([ring.start, ring.end, ring.fadeOut]).toEqual([PRINTED.mcu, 15.68, 0.15]);
    // "They start!" comes 1.58 s after PER-, past the second pat and the beat on his face.
    near(byId(timeline.lines, 'theystart').start - WORD.personally, 1.58);
  });

  it('lays "The doors close!" over the door so close! ends 0.08 s before the thunk', () => {
    const snd = byId(timeline.sfx, 'doors_snd');
    const door = byId(timeline.segments, 'door');
    expect(snd.src).toMatchObject({ kind: 'take', name: 'hal5-lines-t1' });
    expect([snd.in, snd.out, snd.fadeIn, snd.fadeOut]).toEqual([2.04, 3.59, 0.012, 0.012]);
    expect([snd.start, snd.end]).toEqual([door.start, door.end]);
    // In the lines take "The doors" starts at 2.45 and "close!" ends at 3.21; the thunk is 3.0 in the door take.
    near(snd.start + (2.45 - snd.in), WORD.doors);
    const closeEnd = snd.start + (3.21 - snd.in);
    const thunk = door.start + (3.0 - door.audio!.in);
    near(thunk, WORD.thunk);
    near(thunk - closeEnd, 0.08);
  });

  it('holds a real 1.0 s pause before Wheels!, then freezes for 1 s over room tone', () => {
    const hood = byId(timeline.segments, 'hood');
    const finish = byId(timeline.segments, 'finish');
    // "comes with..." ends at 3.0 in the thisone take; "Wheels!" starts at 1.07 in the wheels take. Both are real footage.
    const withEnd = hood.start + (3.0 - hood.in);
    near(withEnd, WORD.withEnd);
    near(byId(timeline.lines, 'wheels').start, finish.start + (1.07 - finish.in));
    near(byId(timeline.lines, 'wheels').start - withEnd, 1.0);
    expect(finish.hold).toBe(1);
    const room = byId(timeline.sfx, 'freeze_room');
    expect(room.src).toMatchObject({ kind: 'take', name: 'hal5-wheels-t1' });
    expect([room.in, room.out, room.fadeOut]).toEqual([0, 1, 0.15]);
    near(room.start, END - 1);
    near(room.end, END);
  });

  it('times every graphic to its word, as the script did', () => {
    expect(timeline.overlays.map((o) => o.id)).toEqual(GFX.map((g) => g[0]));
    for (const [id, png, start, end, blink, x, y] of GFX) {
      const o = byId(timeline.overlays, id);
      expect(o.src).toMatchObject({ kind: 'file', path: `${ROOT}/gfx/${png}.png` });
      near(o.start, start);
      near(o.end, end);
      expect([o.fadeIn, o.fadeOut]).toEqual([0, 0]);
      expect(o.blink).toEqual(blink ? { period: blink, on: Number((blink * 0.6).toFixed(3)) } : null);
      // enable='between(t,s,e)*lt(mod(t-s,blink),0.6·blink)', x and y as the script's overlay filter, on every frame.
      for (let k = Math.floor(start * 24) - 2; k <= Math.ceil(end * 24) + 2; k++) {
        const t = k / 24;
        const on = t >= start && t <= end && (!blink || (t - start) % blink < blink * 0.6);
        expect(opacityAt(o, t) > 0).toBe(on);
        if (!on) continue;
        const p = positionAt(o, t);
        expect(Math.abs(p.x - (typeof x === 'function' ? x(t) : x))).toBeLessThan(0.01);
        expect(p.y).toBe(y);
      }
    }
    // HAND-INSPECTED! is gone by the pat, IT STARTS! by the door, and the $99 card clears 0.05 s before "And".
    expect(byId(timeline.overlays, 'hand').end).toBe(PRINTED.pat);
    expect(byId(timeline.overlays, 'starts').end).toBe(PRINTED.door);
    near(byId(timeline.overlays, 'n99').end, WORD.and - 0.05);
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([7, 11, 0, 4, 11]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
