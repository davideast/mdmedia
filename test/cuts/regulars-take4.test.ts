import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { readCutFile } from '../../src/cut/align.js';
import { gainAt, opacityAt, positionAt, resolveCut, resolveCutJson, segmentGainAt, zoomAt, type ResolvedSource, type Timeline } from '../../src/cut/index.js';
import { byId, near, videoTrackSeconds } from './support';

/**
 * Regulars, Take 4 "everybody knows your name, and too much else", cut by
 * reg4/edit.mjs in the CRT TV media folder, and its variant without "Standing
 * in the dark kitchen." (`edit.mjs --short`). The expected times are what that
 * script printed when it rendered takes/regulars-take4.mp4 and
 * takes/regulars-take4-short.mp4 (its `console.log(JSON.stringify(plan))`),
 * and its filter graph.
 */

const BASE_PATH = new URL('../../docs/cuts/regulars-take4.cut.json', import.meta.url).pathname;
const SHORT_PATH = new URL('../../docs/cuts/regulars-take4-short.cut.json', import.meta.url).pathname;
const cut: unknown = JSON.parse(readFileSync(BASE_PATH, 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;
const FPS = 24;

/** The segment starts reg4/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  table: 0, shop: 6.916667, wide: 9, r1: 11.25, w1: 12.125, a: 16.166667, w2: 18.75, r2: 20.875, b: 22.458333,
  r3: 24.416667, c: 26.458333, r4: 32.416667, e: 33.791667, w3: 35.583333, smile: 37.666667, x: 38.416667, y: 41.166667,
};
const END = 45.208333;
/** `edit.mjs --short`: the frosting shot ends after "Walt." and everything after it moves up 2.375 s. */
const PRINTED_SHORT: Record<string, number> = {
  ...PRINTED, r4: 30.041667, e: 31.416667, w3: 33.208333, smile: 35.291667, x: 36.041667, y: 38.791667,
};
const END_SHORT = 42.833333;

/** Source lengths in seconds (ffmpeg's container durations). */
const PROBED: Record<string, number> = {
  'reg4-r1-t2': 3.01, 'reg4-w1b-t1': 6.02, 'reg4-a-t1': 4.03, 'reg4-w2b-t3': 4.01, 'reg4-r2-t1': 3.01, 'reg4-b-t1': 4.01,
  'reg4-r3-t1': 3.01, 'reg4-c-t2': 8.0, 'reg4-r4-t2': 3.01, 'reg4-e-t3': 4.01, 'reg4-w3b-t3': 4.01, 'reg4-xb-t2': 4.01, 'reg4-yb-t1': 4.01,
};
const FILES: Record<string, number> = {
  'review/clips/ch-regulars-take2.mp4': 16.0, 'audio/reg4-theme-d.mp3': 66.48, 'audio/reg4-laugh1.mp3': 3.03, 'audio/reg4-laugh2.mp3': 4.05,
  'audio/reg4-laugh3.mp3': 5.04, 'audio/reg4-laugh4.mp3': 5.04, 'audio/reg4-door.mp3': 2.04,
};
const mediaLength = (src: ResolvedSource): number | undefined =>
  src.kind === 'take' ? PROBED[src.name] : src.kind === 'file' ? FILES[src.ref] : undefined;

function resolve(json: unknown = cut): Timeline {
  const result = resolveCutJson(json, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

/** Whole frames at 24 fps: every in, out and length in this cut is one. */
const isFrame = (t: number): boolean => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-3;

describe('Regulars, Take 4', () => {
  const timeline = resolve();

  it('puts every segment where reg4/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
    expect(timeline.output).toBe(`${ROOT}/takes/regulars-take4.mp4`);
    for (const seg of timeline.segments) {
      expect(isFrame(seg.start)).toBe(true);
      if (!seg.still) expect([isFrame(seg.in), isFrame(seg.out)]).toEqual([true, true]);
    }
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/regulars-take4.mp4`;
    if (!existsSync(file)) return; // The media isn't on this machine.
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / FPS + 1e-6);
  });

  it('cuts each shot from its take with the script’s crop and gain, and ramps every splice over 12 ms', () => {
    // [take, in, out, crop width (0 = none), volume, the take whose sound it plays (if not its own)]
    const shots: Record<string, [string, number, number, number, number, string?]> = {
      wide: ['ch-regulars-take2', 8, 10.25, 0, 1],
      r1: ['reg4-r1-t2', 0.416667, 1.291667, 948, 1],
      w1: ['reg4-w1b-t1', 1, 5.041667, 1088, 2.3],
      a: ['reg4-a-t1', 0.583333, 3.166667, 1152, 2.1],
      w2: ['reg4-w2b-t3', 0.791667, 2.916667, 1088, 2],
      r2: ['reg4-r2-t1', 0.5, 2.083333, 948, 1.6],
      b: ['reg4-b-t1', 0.5, 2.458333, 0, 2.4],
      r3: ['reg4-r3-t1', 0.458333, 2.5, 948, 2.2, 'reg4-xb-t2'],
      c: ['reg4-c-t2', 0.25, 6.208333, 0, 2.9],
      r4: ['reg4-r4-t2', 0.708333, 2.083333, 948, 2.2, 'reg4-xb-t2'],
      e: ['reg4-e-t3', 0.708333, 2.5, 0, 2],
      w3: ['reg4-w3b-t3', 0.5, 2.583333, 1088, 2.2],
      smile: ['reg4-a-t1', 3.25, 4, 1152, 2.2, 'reg4-xb-t2'],
      x: ['reg4-xb-t2', 1, 3.75, 1088, 2.2],
      y: ['reg4-yb-t1', 0.666667, 3.958333, 0, 1.3],
    };
    for (const [id, [take, a, b, cropW, vol, room]] of Object.entries(shots)) {
      const seg = byId(timeline.segments, id);
      if (id === 'wide') expect(seg.src).toMatchObject({ kind: 'file', ref: 'review/clips/ch-regulars-take2.mp4' });
      else expect(seg.src).toMatchObject({ kind: 'take', name: take });
      near(seg.in, a);
      near(seg.out, b);
      expect(seg.crop?.width ?? 0).toBe(cropW);
      expect(seg.mix).toEqual({ fadeIn: 0.012, fadeOut: 0.012 });
      expect(seg.audio!.volume).toBe(vol);
      // A replaced sound plays the exit take's near-silent room tone from 0.1 s, for the segment's length.
      if (room) {
        expect(seg.audio!.src).toMatchObject({ kind: 'take', name: room });
        near(seg.audio!.in, 0.1);
        near(seg.audio!.out, 0.1 + (b - a));
      }
      // A 12 ms ramp in and out at the splice, full gain (times the volume) between.
      near(segmentGainAt(seg, seg.start + 0.006), vol * 0.5, 1e-3);
      near(segmentGainAt(seg, (seg.start + seg.end) / 2), vol, 1e-6);
    }
    // The wide's own sound stops at 9.7 s, where the WALT! line takes over in the same file.
    near(byId(timeline.segments, 'wide').audio!.out, 9.7);
    // "Bye, Walt!" holds its last frame 18 frames.
    near(byId(timeline.segments, 'y').hold, 0.75);
    // Walt's reactions are a 35 % punch-in; his line shots and the exit a 15 % trim of the edges.
    expect(byId(timeline.segments, 'r1').crop).toEqual({ x: 46, y: 0, width: 948, height: 533 });
    expect(byId(timeline.segments, 'w1').crop).toEqual({ x: 96, y: 0, width: 1088, height: 612 });
  });

  it('builds the intro from our stills: five prints crossfading, the shopfront pushing in under the title', () => {
    const table = byId(timeline.segments, 'table');
    const shop = byId(timeline.segments, 'shop');
    expect([table.still, shop.still]).toEqual([true, true]);
    near(table.end, 6.916667);
    near(shop.end, 9);
    // scale=1+0.04*t/2.083333 about the middle
    expect(zoomAt(shop, shop.start).scale).toBe(1);
    near(zoomAt(shop, (shop.start + shop.end) / 2).scale, 1.02, 1e-6);
    const prints: Record<string, [number, number, number, number, number]> = {
      p1890: [0, 1.7, 210, 230, 65], p1920: [1.35, 3.05, 230, 210, 68], p1950: [2.7, 4.4, 210, 230, 69],
      p1970: [4.05, 5.75, 230, 210, 66], ptoday: [5.4, 7.1, 210, 230, 68],
    };
    for (const [id, [a, b, x0, x1, y]] of Object.entries(prints)) {
      const o = byId(timeline.overlays, id);
      near(o.start, a);
      near(o.end, b);
      expect(o.width).toBe(840);
      // x='x0+(x1-x0)*(t-start)/1.7'
      near(positionAt(o, (a + b) / 2).x, (x0 + x1) / 2);
      expect(positionAt(o, a).y).toBe(y);
      // Each crossfades with the next over 0.35 s.
      near(opacityAt(o, b - 0.175), 0.5, 1e-3);
    }
    const title = byId(timeline.overlays, 'title');
    near(title.start, 7.266667);
    // The title stops 0.02 s before the shop still does, so it isn't drawn on the bar's first frame.
    near(title.end, 8.98);
    expect(timeline.picture).toEqual({ fadeIn: 0.3, fadeOut: 0.6 });
  });

  it('times every line in the shot that carries it, starting just before its speech', () => {
    // Speech onsets measured in each take (reg4/speech.mjs), on the timeline.
    const onset: Record<string, number> = {
      walt: 9.83 - 8 + 9, name: PRINTED.w1 + (1.29 - 1), car: PRINTED.a + (1.09 - 0.583333), wait: PRINTED.w2 + (1.08 - 0.791667),
      colon: PRINTED.b + (0.77 - 0.5), frosting: PRINTED.c + (0.63 - 0.25), kitchen: PRINTED.c + (4.66 - 0.25),
      usual: PRINTED.e + (1.05 - 0.708333), out: PRINTED.w3 + (0.52 - 0.5), bye: PRINTED.y + (1.17 - 0.666667),
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(['lyric', 'walt', 'name', 'car', 'wait', 'colon', 'frosting', 'kitchen', 'usual', 'out', 'bye']);
    for (const [id, t] of Object.entries(onset)) {
      const line = byId(timeline.lines, id);
      expect(t - line.start).toBeGreaterThanOrEqual(0);
      expect(t - line.start).toBeLessThan(0.15);
    }
    // WALT! is Take 2's own shout, 9.7-10.6 s, run on under the first reaction.
    const walt = byId(timeline.lines, 'walt');
    expect(walt.audio).toMatchObject({ kind: 'file' });
    near(walt.start, 10.7);
    near(walt.end, 11.6);
    // The frosting sentence and the dark kitchen are one take, with the measured 1.09 s pause (3.57 to 4.66) between them.
    const frosting = byId(timeline.lines, 'frosting');
    const kitchen = byId(timeline.lines, 'kitchen');
    expect([frosting.audio, kitchen.audio]).toEqual([{ kind: 'segment', segment: 'c' }, { kind: 'segment', segment: 'c' }]);
    near(kitchen.end, byId(timeline.segments, 'c').end);
    // The sung lyric follows the intro theme's clock.
    const lyric = byId(timeline.lines, 'lyric');
    expect(lyric.sung).toBe(true);
    near(lyric.start, 5.7 - 3.95);
  });

  it('grows the laugh with each level, then drops it away for the freeze', () => {
    const laughs: Record<string, [number, number, number, number]> = {
      // [start, end and fade-out end, fade length, volume]
      laugh1: [16.086667, 17.266667, 0.9, 0.5],
      laugh2: [20.775, 22.758333, 0.8, 0.42],
      laugh3: [24.316667, 26.808333, 0.8, 0.56],
      laugh4: [32.316667, 33.616667, 0.8, 0.5],
    };
    expect(timeline.sfx.map((s) => s.id)).toEqual([...Object.keys(laughs), 'door']);
    for (const [id, [a, b, d, vol]] of Object.entries(laughs)) {
      const l = byId(timeline.sfx, id);
      near(l.start, a);
      near(l.end, b);
      expect(l.fadeOut).toBe(d);
      near(l.fadeOutEnd, b);
      // volume=v,afade=t=out:st=(end-start-d):d=d
      near(gainAt(l, a + 0.05), vol, 1e-6);
      near(gainAt(l, b - d / 2), vol / 2, 1e-3);
    }
    // No laugh after the freeze starts to fade: the frosting (Eddie, the exit and the goodbye) play without one.
    for (const l of timeline.sfx.filter((s) => s.id.startsWith('laugh'))) expect(l.end).toBeLessThanOrEqual(PRINTED.e);
    near(byId(timeline.sfx, 'door').start, PRINTED.x + 2.4);
  });

  it('brings the theme back as he backs out, its final band hit on "Bye, Walt!"', () => {
    const theme = byId(timeline.music, 'theme');
    expect([theme.in, theme.start]).toEqual([3.95, 0]);
    near(theme.end, 9.4);
    const outro = byId(timeline.music, 'outro');
    near(outro.start, PRINTED.x + 0.5);
    // in = 59.1 - (BYE - start): the script's atrim=56.35.
    near(outro.in, 56.35);
    near(outro.sync!.at, PRINTED.y + 0.5);
    near(outro.end, END);
    // The script's volume expression, relative to the clip's start.
    const keys: [number, number][] = [[PRINTED.x + 0.5, 0.12], [PRINTED.y, 0.45], [PRINTED.y + 0.4, 0.3], [PRINTED.y + 1.3, 0.3], [PRINTED.y + 1.7, 0.75]];
    const script = (t: number): number => {
      let v = keys[0][1];
      for (let j = 0; j < keys.length - 1; j++) {
        const [t0, v0] = keys[j], [t1, v1] = keys[j + 1];
        if (t >= t0 && t < t1) return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
        if (t >= t1) v = v1;
      }
      const fade = END - t < 0.8 ? (END - t) / 0.8 : 1;
      return v * fade;
    };
    for (let t = outro.start; t < END - 0.82; t += 0.05) near(gainAt(outro, t), script(t), 1e-3);
    expect(timeline.filters.mix).toEqual([{ kind: 'limiter', limit: 0.95 }]);
  });

  it('records where every take came from', () => {
    for (const seg of timeline.segments.filter((s) => s.src.kind === 'take')) {
      const ref = `take:${(seg.src as { name: string }).name}`;
      expect(timeline.sources[ref]).toMatchObject({ step: 'generate' });
    }
    expect(timeline.sources['take:reg4-xb-t2']).toMatchObject({ storyboard: 'reg4-xb' });
  });
});

const SHORT_CUT = await readCutFile(SHORT_PATH);

describe('Regulars, Take 4, without the dark kitchen', () => {
  const resolved = resolveCut(SHORT_CUT, { mediaLength });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  const short = resolved.value;
  const base = resolve();

  it('extends the base cut and puts every segment where `edit.mjs --short` started it', () => {
    expect(JSON.parse(readFileSync(SHORT_PATH, 'utf8'))).toMatchObject({ extends: 'regulars-take4', remove: ['kitchen'] });
    expect(short.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED_SHORT));
    for (const seg of short.segments) near(seg.start, PRINTED_SHORT[seg.id]);
    near(short.length, END_SHORT);
    expect(short.output).toBe(`${ROOT}/takes/regulars-take4-short.mp4`);
  });

  it('matches the rendered variant to within a frame', () => {
    const file = `${ROOT}/takes/regulars-take4-short.mp4`;
    if (!existsSync(file)) return;
    expect(Math.abs(videoTrackSeconds(file) - END_SHORT)).toBeLessThanOrEqual(1 / FPS + 1e-6);
  });

  it('only shortens the frosting shot: the same take ends 0.26 s after "Walt."', () => {
    const c = byId(short.segments, 'c');
    expect(c.src).toMatchObject({ kind: 'take', name: 'reg4-c-t2' });
    near(c.in, 0.25);
    near(c.out, 3.833333);
    expect(short.lines.map((l) => l.id)).not.toContain('kitchen');
    near(base.length - short.length, 2.375);
    // Everything after the frosting moves up by the same 2.375 s, laughs and theme included.
    near(byId(base.sfx, 'laugh4').start - byId(short.sfx, 'laugh4').start, 2.375);
    near(byId(base.music, 'outro').start - byId(short.music, 'outro').start, 2.375);
    near(byId(short.music, 'outro').in, 56.35);
    for (const id of ['table', 'shop', 'wide', 'r1', 'w1', 'a', 'w2', 'r2', 'b', 'r3']) {
      expect(byId(short.segments, id)).toEqual(byId(base.segments, id));
    }
  });
});
