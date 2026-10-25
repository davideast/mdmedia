import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { readCutFile } from '../../src/cut/align.js';
import { opacityAt, positionAt, resolveCut, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index.js';

/**
 * Big Hal's car lot, Take 6 (wheels in one breath): Take 5 with the punchline and the close as one take
 * (thread t2-wheels, suggestion s4, accepted as preview r2-t2-wheels-15). Written as changes to Take 5.
 * The expected times are what the round-2 preview renderer (a port of hal5/edit.mjs, mode "split")
 * printed when it rendered takes/big-hal-take6.mp4: its `at` and `word`, and END.
 */

const PATH = new URL('../../docs/cuts/big-hal-take6.cut.json', import.meta.url).pathname;
const CUT = await readCutFile(PATH);
const BASE: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/big-hal-take5.cut.json', import.meta.url), 'utf8'));
const ROOT = (BASE as { media: { root: string } }).media.root;

/** The segment starts the renderer printed (its A to F), in its order. */
const PRINTED: Record<string, number> = { open: 0, inspect: 9.85, pat: 14, mcu: 15.43, door: 16.68, wc: 18.23 };
/** Its word times on the timeline: "wheels" (2.68 in the take) and "So" (3.6). */
const WORD = { wheels: 20.91, so: 21.83 };
const END = 25.9;

const PROBED: Record<string, number> = {
  'big-hal-4ab-t2': 16.0,
  'hal5-inspect-t6': 5.03,
  'hal5-personally-t2': 4.01,
  'hal5-pat-t1': 4.03,
  'hal5-lines-t1': 5.01,
  'hal5-door-t1': 4.01,
  'hal5-thisone-t3': 6.02,
  'hal5-wheels-t1': 6.02,
  'hal6-wheels-close-t1': 8.0,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

function resolveTake6(): Timeline {
  const result = resolveCut(CUT, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}
function resolveTake5(): Timeline {
  const result = resolveCutJson(BASE, { mediaLength });
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

/** The video track's length in seconds, read from the MP4's `mdhd` box (as in the Take 5 test). */
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

describe("Big Hal's car lot, Take 6", () => {
  const take6 = resolveTake6();
  const take5 = resolveTake5();

  it('extends Take 5 and puts every segment where the render started it', () => {
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toMatchObject({ extends: 'big-hal-take5', remove: ['hood', 'finish', 'wheels'] });
    expect(take6.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of take6.segments) near(seg.start, PRINTED[seg.id]);
    near(take6.length, END);
    expect(take6.output).toBe(`${ROOT}/takes/big-hal-take6.mp4`);
    expect(take6.meta).toMatchObject({ title: "Big Hal's car lot", version: 'Take 6 (wheels in one breath)', length: END, fps: 24 });
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/big-hal-take6.mp4`;
    if (!existsSync(file)) return; // The media isn't on this machine.
    // Rendered with -t 25.9 at 24 fps, which ffmpeg rounds up to a whole frame (622 frames, 25.917 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('keeps Take 5 unchanged up to the cut into the new shot', () => {
    const shared = ['open', 'inspect', 'pat', 'mcu', 'door'];
    expect(take6.segments.slice(0, 5)).toEqual(take5.segments.filter((s) => shared.includes(s.id)));
    const before = ['howdy', 'nomoney', 'zero', 'month', 'every', 'personally', 'theystart', 'doorsclose'];
    expect(take6.lines.slice(0, before.length)).toEqual(take5.lines.filter((l) => before.includes(l.id)));
    expect(byId(take6.sfx, 'ring')).toEqual(byId(take5.sfx, 'ring'));
  });

  it('plays the punchline and the close as one take, with the sound up to "So" lifted 2.5 dB', () => {
    const wc = byId(take6.segments, 'wc');
    expect(wc.src).toMatchObject({ kind: 'take', name: 'hal6-wheels-close-t1' });
    expect([wc.in, wc.out, wc.hold]).toEqual([0, 6.67, 1]);
    near(wc.end, END);
    // The segment's own sound runs from the take's start to "So" at +2.5 dB...
    expect(wc.audio).toMatchObject({ src: { kind: 'take', name: 'hal6-wheels-close-t1' }, in: 0, out: 3.6, fadeIn: 0 });
    // The shot's whole sound, the close and the room tone laid into it included, is faded 12 ms at both ends.
    expect(wc.mix).toEqual({ fadeIn: 0.012, fadeOut: 0.012 });
    expect(Math.abs(wc.audio!.volume - 10 ** (2.5 / 20))).toBeLessThan(1e-4);
    near(wc.audio!.end, WORD.so);
    // ...and the close carries straight on from the same take, in step, at unity: one continuous performance.
    const comeon = byId(take6.lines, 'comeon');
    expect(comeon.audio).toMatchObject({ kind: 'file', src: { kind: 'take', name: 'hal6-wheels-close-t1' }, in: 3.6, out: 6.67, layer: { segment: 'wc' } });
    near(comeon.start, wc.audio!.end);
    near(comeon.start - wc.start, 3.6);
    near(comeon.end, END - 1);
  });

  it('places the lines on the new take', () => {
    const lines: Record<string, [string, number, number]> = {
      thisone: ['And this one? This one even comes with wheels!', 18.51, WORD.so],
      comeon: ["So come on down to Big Hal's and save big!", WORD.so, END - 1],
    };
    for (const [id, [text, start, end]] of Object.entries(lines)) {
      const line = byId(take6.lines, id);
      expect([line.speaker, line.text]).toEqual(['Big Hal', text]);
      near(line.start, start);
      near(line.end, end);
    }
    expect(byId(take6.lines, 'thisone').audio).toMatchObject({ kind: 'segment', segment: 'wc' });
    expect(take6.lines.map((l) => l.id)).not.toContain('wheels');
  });

  it('holds the freeze over room tone from the quiet tail of the same take', () => {
    const room = byId(take6.sfx, 'freeze_room');
    expect(room.src).toMatchObject({ kind: 'take', name: 'hal6-wheels-close-t1' });
    expect([room.in, room.out, room.fadeIn, room.fadeOut, room.layer?.segment]).toEqual([6.9, 7.9, 0.1, 0.15, 'wc']);
    near(room.start, END - 1);
    near(room.end, END);
  });

  it('lands every graphic on its word in the new take', () => {
    const gfx: Array<[string, number, number]> = [
      ['nmd', 5.65, 6.92], ['apr', 6.92, 8.73], ['n99', 8.73, 9.93], ['hand', 11.5, 14], ['starts', 15.87, 16.68],
      ['doors', 17.09, PRINTED.wc], ['included', WORD.wheels, WORD.so], ['fine', WORD.wheels, WORD.wheels + 2.4],
      ['close', WORD.so, END], ['phone', WORD.so + 0.3, END], ['route', WORD.so + 0.3, END],
    ];
    expect(take6.overlays.map((o) => o.id)).toEqual(gfx.map((g) => g[0]));
    for (const [id, start, end] of gfx) {
      const o = byId(take6.overlays, id);
      near(o.start, start);
      near(o.end, end);
    }
    // The fine print crawls as the script's x = 1085 - (t - wheels)·950, and DOORS CLOSE! stays raised.
    const fine = byId(take6.overlays, 'fine');
    for (const t of [WORD.wheels, WORD.wheels + 1, WORD.wheels + 2.4]) {
      expect(opacityAt(fine, t) > 0).toBe(true);
      expect(Math.abs(positionAt(fine, t).x - (1085 - (t - WORD.wheels) * 950))).toBeLessThan(0.01);
    }
    expect(positionAt(byId(take6.overlays, 'doors'), 17.5).y).toBe(-250);
  });
});
