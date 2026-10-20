import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, opacityAt, positionAt, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index';
import { byId, near, videoTrackSeconds } from './support';

/**
 * Big Hal's car lot, Take 7 (the sell): the owner's new script, one generation per sentence (decision
 * d13-the-sell). The expected times are what crt-tv/hal7/edit.mjs printed when it rendered
 * takes/big-hal-take7.mp4: its `at`, `word` and END.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/big-hal-take7.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts hal7/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  open: 0, extras: 5.4, simple: 9.2, price: 14.43, inspect: 18.26, guar: 21.55, count1: 23.175, count2: 25.25, count3: 27.05, wc: 28.6,
};
/** Word times it printed, on the timeline. */
const WORD = {
  no: 15.61, ninety: 17.15, contact: 21.39, thump: 21.39, doors: 24.02, seats: 25.74, wheel: 27.58,
  one: 24.35, two: 25.75, three: 27.55, wheels: 31.28, so: 32.2,
};
const END = 36.27;

/** Source lengths in seconds, from ffmpeg on the takes. */
const PROBED: Record<string, number> = {
  'big-hal-4ab-t2': 16.0,
  'hal7-extras-t3': 6.02,
  'hal7-simple-t2': 6.02,
  'hal7-price-t3': 6.02,
  'hal7-inspect2-t2': 6.02,
  'hal7-guarantee4-t3': 8.04,
  'hal7-count-t1': 8.0,
  'hal6-wheels-close-t1': 8.0,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

function resolve(): Timeline {
  const result = resolveCutJson(cut, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

describe("Big Hal's car lot, Take 7", () => {
  const timeline = resolve();

  it('puts every segment where hal7/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
    expect(timeline.meta).toMatchObject({ title: "Big Hal's car lot", version: 'Take 7 (the sell)', length: END, fps: 24 });
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/big-hal-take7.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // Rendered with -t 36.27 at 24 fps, which ffmpeg rounds up to a whole frame.
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('plays one generation per sentence, in the script order', () => {
    const takes: Record<string, string> = {
      open: 'big-hal-4ab-t2', extras: 'hal7-extras-t3', simple: 'hal7-simple-t2', price: 'hal7-price-t3', inspect: 'hal7-inspect2-t2',
      guar: 'hal7-guarantee4-t3', wc: 'hal6-wheels-close-t1',
    };
    for (const [id, name] of Object.entries(takes)) {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toMatchObject({ kind: 'take', name });
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name } });
    }
    expect(timeline.lines.map((l) => l.text)).toEqual([
      'Howdy folks, Big Hal here at Big Hal\'s, the biggest lot in the tri-county area!',
      'Now, those fancy dealerships\'ll charge you for all kinds of extras.',
      'Not Big Hal. I keep it simple, and I pass the savings on to you.',
      'That\'s how I can do no money down, and ninety-nine a month!',
      'And I personally hand-inspect every car.',
      'At Big Hal\'s, you\'re guaranteed to get four doors! Four seats! A steering wheel!',
      'And this one? This one even comes with wheels!',
      "So come on down to Big Hal's and save big!",
    ]);
    // Line 1 is Take 5's opening, cut before "No money down" (5.65 in that take).
    const open = byId(timeline.segments, 'open');
    expect([open.in, open.out]).toEqual([0, 5.4]);
  });

  it('hears line 6 as one take, whole and in step, under the counting insert', () => {
    const guar = byId(timeline.segments, 'guar');
    let audioAt = guar.audio!.out;
    for (const id of ['count1', 'count2', 'count3']) {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toMatchObject({ kind: 'take', name: 'hal7-count-t1' });
      // The insert's picture runs on in step: each piece starts where the last one ended, 1.00 s behind the voice.
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name: 'hal7-guarantee4-t3' } });
      near(seg.audio!.in, audioAt);
      near(seg.audio!.in - seg.in, 1.0);
      audioAt = seg.audio!.in + (seg.end - seg.start);
    }
    expect(byId(timeline.lines, 'guarantee').audio).toMatchObject({ kind: 'segment', segment: 'guar' });
    near(byId(timeline.lines, 'guarantee').end, PRINTED.wc);
    // Each finger lands within 0.35 s of its item: one inside "four doors", two and three on "four seats" and "a steering wheel".
    for (const [finger, item] of [[WORD.one, WORD.doors], [WORD.two, WORD.seats], [WORD.three, WORD.wheel]]) {
      expect(Math.abs(finger - item)).toBeLessThan(0.35);
    }
    // "four seats" and "a steering wheel" are lifted to the level of "four doors" (+2.4 and +3.9 dB).
    const g1 = byId(timeline.segments, 'count1').audio!.volume;
    expect(20 * Math.log10(byId(timeline.segments, 'count2').audio!.volume / g1)).toBeCloseTo(2.4, 1);
    expect(20 * Math.log10(byId(timeline.segments, 'count3').audio!.volume / g1)).toBeCloseTo(3.9, 1);
  });

  it('lands the thump on the palm\'s contact, from the same take', () => {
    const thump = byId(timeline.sfx, 'thump');
    expect(thump.src).toMatchObject({ kind: 'take', name: 'hal7-inspect2-t2' });
    // The thump starts at 4.24 in its take; laid 0.07 s early it lands on the contact frame (4.17).
    near(thump.start + (4.24 - thump.in), WORD.thump);
    near(WORD.thump, WORD.contact);
    // The segment's own sound stops in the silence before it, so it is heard once.
    expect(byId(timeline.segments, 'inspect').audio!.out).toBe(thump.in);
  });

  it('plays lines 7-8 exactly as Take 6 did', () => {
    const wc = byId(timeline.segments, 'wc');
    expect([wc.in, wc.out, wc.hold]).toEqual([0, 6.67, 1]);
    expect(wc.audio).toMatchObject({ in: 0, out: 3.6, fadeIn: 0 });
    expect(wc.mix).toEqual({ fadeIn: 0.012, fadeOut: 0.012 });
    expect(Math.abs(wc.audio!.volume - 10 ** (2.5 / 20))).toBeLessThan(1e-4);
    const comeon = byId(timeline.lines, 'comeon');
    expect(comeon.audio).toMatchObject({ kind: 'file', src: { kind: 'take', name: 'hal6-wheels-close-t1' }, in: 3.6, out: 6.67, layer: { segment: 'wc' } });
    near(comeon.start, WORD.so);
    const room = byId(timeline.sfx, 'freeze_room');
    expect([room.in, room.out]).toEqual([6.9, 7.9]);
    near(room.end, END);
    expect(gainAt(room, END - 0.5)).toBeCloseTo(1, 6);
  });

  it('lands every graphic on its words', () => {
    const gfx: Array<[string, string, number, number]> = [
      ['nmd', 'hal3-nmd', WORD.no, WORD.ninety], ['n99', 'hal3-99', WORD.ninety, PRINTED.inspect],
      ['doors', 'hal7-doors', WORD.doors, PRINTED.wc], ['seats', 'hal7-seats', WORD.seats, PRINTED.wc], ['wheel', 'hal7-wheel', WORD.wheel, PRINTED.wc],
      ['included', 'hal3-wheels', WORD.wheels, WORD.so], ['fine', 'hal4-fine', WORD.wheels, WORD.wheels + 2.4],
      ['close', 'hal3-close', WORD.so, END], ['phone', 'hal3-phone', WORD.so + 0.3, END], ['route', 'hal3-route', WORD.so + 0.3, END],
    ];
    expect(timeline.overlays.map((o) => o.id)).toEqual(gfx.map((g) => g[0]));
    for (const [id, png, start, end] of gfx) {
      const o = byId(timeline.overlays, id);
      expect(o.src).toMatchObject({ kind: 'file', path: `${ROOT}/gfx/${png}.png` });
      near(o.start, start);
      near(o.end, end);
    }
    // No new graphic before line 4.
    for (const o of timeline.overlays) expect(o.start).toBeGreaterThanOrEqual(PRINTED.price);
    // $99 blinks as in Take 5; the fine print crawls as x = 1085 - (t - wheels)·950.
    expect(byId(timeline.overlays, 'n99').blink).toEqual({ period: 0.5, on: 0.3 });
    const fine = byId(timeline.overlays, 'fine');
    for (const t of [WORD.wheels, WORD.wheels + 1, WORD.wheels + 2.4]) {
      expect(opacityAt(fine, t) > 0).toBe(true);
      expect(Math.abs(positionAt(fine, t).x - (1085 - (t - WORD.wheels) * 950))).toBeLessThan(0.01);
    }
  });
});
