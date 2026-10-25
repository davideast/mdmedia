import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { opacityAt, positionAt } from '../../src/cut/index';
import { byId, expectInStep, loadPort, near, segmentAt, sha256Of, speechOf, videoTrackSeconds } from './support';

/**
 * Clap-Lite, Take 2 (commercial structure). No edit script made it: the
 * provider's extend returned clap-2a-t2 and its demos-and-packshot tail as one
 * 16 s take, clap-2-full-t1, and compose.mjs laid our graphics over it. So the
 * segment starts come from probing only (ffmpeg scene detection and per-frame
 * luma on the take), and the graphics' timing from a copy of compose.mjs run
 * with its ffmpeg call stubbed out, with its call as the transcript of that
 * session recorded it:
 *
 *   compose.mjs takes/clap-2-full-t1.mp4 takes/clap-2-final.mp4 '[{"png":"gfx/clap-name.png","start":12.0,"end":16.1,"fade":0.2},
 *     {"png":"gfx/clap-price.png","start":13.0,"end":16.1},{"png":"gfx/clap-phone.png","start":13.6,"end":16.1,"blink":0.7}]'
 *   → [1:v]format=rgba,fade=t=in:st=12:d=0.2:alpha=1[g0];[0:v][g0]overlay=x='0':y=0:shortest=1:enable='between(t,12,16.1)'[v0];
 *     [2:v]format=rgba[g1];[v0][g1]overlay=x='0':y=0:shortest=1:enable='between(t,13,16.1)'[v1];
 *     [3:v]format=rgba[g2];[v1][g2]overlay=x='0':y=0:shortest=1:enable='between(t,13.6,16.1)*lt(mod(t-13.6,0.7),0.420)'[v2]
 */

/** The frame each segment starts on, from probing the take: Grandma's closer shot, the demos (the extension's first frame), the boy, the packshot. */
const CUT_FRAMES = { dark: 0, lamp: 105, tv: 191, boy: 240, pack: 288 };
const END = 16;
const PUBLISHED = 'review/clips/ad-clap-lite-take2.mp4';

const port = loadPort('clap-lite-take2', { 'clap-2-full-t1': 16.0 });
const { timeline, root } = port;

describe('Clap-Lite, Take 2', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on clap-2-full-t1), in step, to its length', () => {
    expectInStep(timeline, 'clap-2-full-t1', CUT_FRAMES);
    near(timeline.length, END);
    expect(timeline.sfx).toEqual([]);
  });

  it('labels the sung jingle in the take\'s own sound', () => {
    const jingle = byId(timeline.music, 'clap_jingle');
    expect(jingle).toMatchObject({ segment: 'boy', src: { kind: 'take', name: 'clap-2-full-t1' } });
    near(jingle.start, byId(timeline.segments, 'boy').start + 1.5);
    near(jingle.end, byId(timeline.lines, 'order').start);
    near(jingle.in, jingle.start);
    expect(timeline.music).toHaveLength(1);
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/clap-2-final.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('lays CLAP-LITE, the price and the blinking phone number over the packshot as compose.mjs did', () => {
    // [id, png, start, fadeIn]; each ran to 16.1 s, past the end, so it ends with the cut.
    const gfx: Array<[string, string, number, number]> = [
      ['name', 'gfx/clap-name.png', 12, 0.2],
      ['price', 'gfx/clap-price.png', 13, 0],
      ['phone', 'gfx/clap-phone.png', 13.6, 0],
    ];
    expect(timeline.overlays.map((o) => o.id)).toEqual(gfx.map((g) => g[0]));
    for (const [id, png, start, fadeIn] of gfx) {
      const o = byId(timeline.overlays, id);
      expect(o.src).toMatchObject({ kind: 'file', path: `${root}/${png}` });
      expect(o.segment).toBeNull();
      near(o.start, start);
      near(o.end, END);
      expect([o.fadeIn, o.fadeOut]).toEqual([fadeIn, 0]);
      expect(positionAt(o, start + 0.1)).toEqual({ x: 0, y: 0 });
      expect(opacityAt(o, start - 0.01)).toBe(0);
    }
    near(byId(timeline.overlays, 'name').start, byId(timeline.segments, 'pack').start);
    // The name fades in from the packshot's first frame (diffing the clip against the take, it shows from frame 289).
    expect(opacityAt(byId(timeline.overlays, 'name'), 12)).toBe(0);
    expect(opacityAt(byId(timeline.overlays, 'name'), 289 / 24)).toBeCloseTo((289 / 24 - 12) / 0.2, 6);
    expect(opacityAt(byId(timeline.overlays, 'name'), 12.3)).toBe(1);
    expect(opacityAt(byId(timeline.overlays, 'price'), 13)).toBe(1);
    // lt(mod(t-13.6,0.7),0.420): on for the first 0.42 s of every 0.7 s.
    const phone = byId(timeline.overlays, 'phone');
    expect(phone.blink).toEqual({ period: 0.7, on: 0.42 });
    const script = (t: number): number => (t >= 13.6 && t <= 16.1 && (t - 13.6) % 0.7 < 0.42 ? 1 : 0);
    for (let f = 312; f < 384; f++) {
      const t = f / 24;
      if (Math.abs(((t - 13.6) % 0.7) - 0.42) < 1e-6) continue;
      expect(opacityAt(phone, t)).toBe(script(t));
    }
  });

  it('gives the announcer and the sung jingle their words as heard, each spoken inside its line', () => {
    // [speaker, text, the segment the speech starts in, the transcript's start]. The review note's transcript:
    // Tired of stumbling in the dark? (2.0 s) / Introducing Clap-Lite. (4.7) / Clap-Lite. Lights that listen. Order yours today. (11.8);
    // "Order" is 15.1 s in the transcriber's word times.
    const lines: Record<string, [string, string, string, number]> = {
      tired: ['Announcer', 'Tired of stumbling in the dark?', 'dark', 2.0],
      intro: ['Announcer', 'Introducing Clap-Lite!', 'lamp', 4.7],
      jingle: ['Jingle', 'Clap-Lite! Lights that listen!', 'pack', 11.8],
      order: ['Announcer', 'Order yours today!', 'pack', 15.1],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    expect(port.applied).toEqual(Object.keys(lines));
    expect(port.stale).toEqual([]);
    for (const line of timeline.lines) {
      const [speaker, text, segment, heard] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      expect(line.audio.kind).toBe(line.id === 'jingle' ? 'clip' : 'segment');
      expect(line.sung).toBe(line.id === 'jingle');
      const [from, to] = speechOf(timeline, line.id);
      expect(from).toBeGreaterThanOrEqual(line.start);
      expect(to).toBeLessThanOrEqual(line.end);
      expect(segmentAt(timeline, from)).toBe(segment);
      expect(Math.abs(from - heard)).toBeLessThan(0.6);
    }
    // The jingle is sung over the boy's shot into the packshot, in the same take in step.
    expect(byId(timeline.lines, 'jingle').audio).toEqual({ kind: 'clip', clip: 'clap_jingle' });
    expect(byId(timeline.lines, 'jingle').end).toBeGreaterThan(byId(timeline.segments, 'pack').start);
    near(byId(timeline.lines, 'order').end, END);
    // Sung, so its words are approximate and its first word isn't snapped.
    const words = JSON.parse(readFileSync(new URL('../../docs/cuts/clap-lite-take2.words.json', import.meta.url), 'utf8'));
    expect(words.lines.jingle).toMatchObject({ approximate: true, fingerprint: { source: 'takes/clap-2-full-t1.mp4' } });
    expect(words.lines.jingle.fingerprint.snap).toBeUndefined();
  });
});
