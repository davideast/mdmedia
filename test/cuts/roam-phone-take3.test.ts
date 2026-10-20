import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, overlayShownAt, positionAt, resolveCutJson, type Timeline } from '../../src/cut/index';
import { byId, near, videoTrackSeconds } from './support';

/**
 * Roam Phone, Take 3 "Talk anywhere*", written by roam3/cut.mjs in the CRT TV
 * media folder from measured speech times and rendered by `mdmedia cut render`
 * (to takes/roam-phone-take3.mp4), so these are the cut's own times: segment
 * starts, the announcer's lines and the gaps around them, the splash and the
 * fizz, the punchline, and our two cards.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/roam-phone-take3.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;
const FPS = 24;

/** The segment starts roam3/cut.mjs printed, in order. */
const STARTS: Record<string, number> = {
  open: 0, wife: 3.85, frank: 6.47, shrug: 10.45, lift: 13.2, door: 14.5, patio: 15.8, bell: 18.3, smile: 19.89,
  mow: 21.55, still: 23.55, laugh: 26.07, roof: 27.67, why: 29.52, any: 31.85, edge: 34.6, wobble: 39.28,
  splash: 40.73, punch: 42.63, disc: 47.13, tag: 52.38,
};
const END = 56.98;

/** Speech onsets and ends in each announcer file (measured at -35 dB in the speech band). */
const TTS: Record<string, [number, number]> = {
  n1: [0.24, 4.47], n2: [0.31, 1.92], n3: [0.3, 2.45], n4: [0.3, 1.58], n5: [0.27, 2.01], n6: [0.25, 2.1], n7: [0.31, 4.91], n8: [0.29, 3.07],
};

function resolve(): Timeline {
  const result = resolveCutJson(cut);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

describe('Roam Phone, Take 3', () => {
  const timeline = resolve();
  const speech = (id: string): [number, number] => {
    const l = byId(timeline.lines, id);
    return [l.start + TTS[id][0], l.start + TTS[id][1]];
  };
  /** Where a take's own speech (in its clock) lands on the timeline. */
  const onTimeline = (seg: string, t: number): number => {
    const s = byId(timeline.segments, seg);
    return s.start + t - s.in;
  };

  it('puts every segment where roam3/cut.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(STARTS));
    for (const seg of timeline.segments) near(seg.start, STARTS[seg.id]);
    near(timeline.length, END);
    expect(timeline.output).toBe(`${ROOT}/takes/roam-phone-take3.mp4`);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/roam-phone-take3.mp4`;
    if (!existsSync(file)) return; // The media isn't on this machine.
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / FPS + 1e-6);
  });

  it('plays every phone shot from a Roam 3 take started from an approved still', () => {
    for (const seg of timeline.segments.filter((s) => s.src.kind === 'take')) {
      const name = (seg.src as { name: string }).name;
      expect(name.startsWith('roam3-')).toBe(true);
      expect(timeline.sources[`take:${name}`]).toMatchObject({ step: 'generate' });
      expect(timeline.sources[`take:${name}`].firstFrame).toMatchObject({ kind: 'file' });
      expect((timeline.sources[`take:${name}`].firstFrame as { ref: string }).ref).toMatch(/^roam3\/stills\/.+-720\.png$/);
    }
    // Her wall phone, the only cord, is always the same locked framing: every shot of her end starts from it.
    for (const id of ['bell', 'still', 'why', 'splash']) {
      const name = (byId(timeline.segments, id).src as { name: string }).name;
      expect(timeline.sources[`take:${name}`].firstFrame).toMatchObject({ ref: 'roam3/stills/w-ear2-720.png' });
    }
  });

  it('leaves 0.27 s between the end of one speaker and the start of the next', () => {
    near(onTimeline('wife', 1.35) - speech('n1')[1], 0.27);
    near(speech('n2')[0] - onTimeline('wife', 1.94), 0.27);
    near(onTimeline('frank', 1.07) - speech('n2')[1], 0.27);
    near(speech('n3')[0] - onTimeline('frank', 3.04), 0.27);
    near(onTimeline('shrug', 1.85) - speech('n3')[1], 0.27);
    near(onTimeline('bell', 0.86) - onTimeline('patio', 3.02), 0.27);
    near(speech('n4')[0] - onTimeline('bell', 2.22), 0.27);
    near(onTimeline('still', 0.89) - onTimeline('mow', 3.15), 0.27);
    near(speech('n5')[0] - onTimeline('still', 1.83), 0.27);
    near(speech('n6')[0] - onTimeline('why', 2.87), 0.27);
    near(onTimeline('any', 1.57) - speech('n6')[1], 0.27);
    // Her "...Why are you on the roof?" keeps its pause: 0.45 s after his line.
    near(onTimeline('why', 1.59) - onTimeline('roof', 2.63), 0.45);
    // His laugh comes 0.15 s after the announcer's "Even over the mower!".
    near(onTimeline('laugh', 4.4) - speech('n5')[1], 0.15);
  });

  it('cuts away on the wobble, with the splash heard only on her end, then the fizz', () => {
    const splash = byId(timeline.segments, 'splash');
    const sploosh = byId(timeline.sfx, 'sploosh');
    near(sploosh.start, splash.start + 0.08);
    // No splash shot: the splash plays over her, never over him.
    expect(sploosh.start).toBeGreaterThanOrEqual(byId(timeline.segments, 'wobble').end);
    const fizz1 = byId(timeline.sfx, 'fizz1');
    near(fizz1.start, splash.start + 0.85);
    near(fizz1.end, STARTS.punch);
    const fizz2 = byId(timeline.sfx, 'fizz2');
    near(fizz2.start, STARTS.punch);
    // Only fizz between "...Honey?" and "...Anywhere?", fading out just before it.
    near(fizz2.end, onTimeline('punch', 4.34) - 0.1);
    expect(gainAt(fizz2, (onTimeline('punch', 1.6) + onTimeline('punch', 4.34)) / 2)).toBeGreaterThan(0.1);
    expect(gainAt(fizz2, onTimeline('punch', 4.34))).toBe(0);
  });

  it('times the on-camera lines in the shots that carry them', () => {
    expect(timeline.lines.filter((l) => l.speaker !== 'Narrator').map((l) => l.id)).toEqual([
      'anywhere1', 'really', 'findout', 'hear', 'bellline', 'mowing', 'stillclear', 'onroof', 'whyroof', 'anywhere2', 'incredible', 'honey', 'anywhere3',
    ]);
    const honey = byId(timeline.lines, 'honey');
    const anywhere = byId(timeline.lines, 'anywhere3');
    expect([honey.audio, anywhere.audio]).toEqual([{ kind: 'segment', segment: 'punch' }, { kind: 'segment', segment: 'punch' }]);
    // The pause in the punchline is the take's own: 2.74 s from "...Honey?" to "...Anywhere?".
    near(onTimeline('punch', 4.34) - onTimeline('punch', 1.6), 2.74);
  });

  it('builds the disclaimer and tag cards from our own graphics', () => {
    const disc = byId(timeline.segments, 'disc');
    const tag = byId(timeline.segments, 'tag');
    expect([disc.still, tag.still]).toEqual([true, true]);
    // The fine print races up 2700 px in 5.25 s.
    const print = byId(timeline.overlays, 'print');
    near(positionAt(print, disc.start).y, 600);
    near(positionAt(print, disc.end).y, -2100);
    // The fast legal read starts 0.35 s into the card and ends before it does.
    near(speech('n7')[0], disc.start + 0.35);
    expect(speech('n7')[1]).toBeLessThan(disc.end);
    // "*almost anywhere" is slapped on as the tagline ends, and stays to the end.
    const almost = byId(timeline.overlays, 'almost');
    near(almost.start, speech('n8')[1] - 0.05);
    expect(overlayShownAt(almost, END - 0.01)).toBe(true);
    expect(overlayShownAt(byId(timeline.overlays, 'foot'), tag.start + 1)).toBe(true);
    expect(timeline.filters.mix).toEqual([{ kind: 'limiter', limit: 0.95 }]);
  });
});
