import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { gainAt, opacityAt, positionAt } from '../../src/cut/index';
import { byId, expectInStep, loadPort, near, segmentAt, sha256Of, speechOf, videoTrackSeconds } from './support';

/**
 * Palm Court, Take 2 (with intro). No edit script made it: the provider's
 * extend returned the intro and its kitchen tail as one 18 s take,
 * palm-full-t1, and compose.mjs laid our title over it. So the segment starts
 * come from probing only (ffmpeg scene detection and per-frame luma on the
 * take: the kitchen starts on frame 192), and the title's timing from a copy
 * of compose.mjs run with its ffmpeg call stubbed out, with its call as the
 * transcript of that session recorded it:
 *
 *   compose.mjs takes/palm-full-t1.mp4 takes/palm-full-titled.mp4 '[{"png":"gfx/palm-title.png","start":6.2,"end":8.0,"fade":0.5}]'
 *   → [1:v]format=rgba,fade=t=in:st=6.2:d=0.5:alpha=1[g0];[0:v][g0]overlay=x='0':y=0:shortest=1:enable='between(t,6.2,8)'[v0]
 */

/** The frame each segment starts on, from probing the take. */
const CUT_FRAMES = { intro: 0, kitchen: 192 };
const END = 18;
const PUBLISHED = 'review/clips/ch-palm-court-take2.mp4';

const port = loadPort('palm-court-take2', { 'palm-full-t1': 18.0 });
const { timeline, root } = port;

describe('Palm Court, Take 2', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on palm-full-t1), in step, to its length', () => {
    expectInStep(timeline, 'palm-full-t1', CUT_FRAMES);
    near(timeline.length, END);
  });

  it('labels the theme and the laugh track in the take\'s own sound, adding none', () => {
    // The take's sound drops from about -24 dBFS to -34 at the cut to the kitchen (7.8–8.2 s), where the theme ends;
    // the laugh comes up from -29 to -22 dBFS at 15.5 s, after "Twice." (15.3), and dies away to the end.
    const theme = byId(timeline.music, 'theme');
    expect(theme).toMatchObject({ segment: 'intro', start: 0, end: 8, in: 0, out: 8, src: { kind: 'take', name: 'palm-full-t1' } });
    const laugh = byId(timeline.sfx, 'laugh');
    expect(laugh).toMatchObject({ segment: 'kitchen', start: 15.5, end: END, in: 15.5, out: END });
    expect(laugh.start).toBeGreaterThanOrEqual(speechOf(timeline, 'king')[1]);
    for (const t of [4, 16]) expect([gainAt(theme, t), gainAt(laugh, t)]).toEqual([0, 0]);
    expect([timeline.music.length, timeline.sfx.length]).toEqual([1, 1]);
  });

  it('records the take as the provider\'s extend of the intro', () => {
    expect(timeline.sources['take:palm-full-t1']).toMatchObject({
      step: 'extend', storyboard: 'ch-palm-court-kitchen', extendedFrom: { kind: 'take', name: 'palm-intro-t1' },
    });
    expect(timeline.sources['take:palm-intro-t1']).toMatchObject({ step: 'generate', storyboard: 'ch-palm-court-intro' });
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/palm-full-titled.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('lays the title over the intro as compose.mjs did: from 6.2 s, faded in over 0.5 s, through the frame at 8.0 s', () => {
    expect(timeline.overlays.map((o) => o.id)).toEqual(['title']);
    const title = byId(timeline.overlays, 'title');
    expect(title.src).toMatchObject({ kind: 'file', path: `${root}/gfx/palm-title.png` });
    expect(title.segment).toBeNull();
    near(title.start, 6.2);
    near(title.end, 8);
    expect([title.fadeIn, title.fadeOut]).toEqual([0.5, 0]);
    expect(title.blink).toBeNull();
    expect(positionAt(title, 7)).toEqual({ x: 0, y: 0 });
    // between(t,6.2,8) is inclusive: diffing the published clip against the take, the title is on frames 150 to 192,
    // so it is still up on the kitchen's first frame. Frame 149 (6.208 s) is under 2 % in.
    expect(opacityAt(title, 149 / 24)).toBeCloseTo((149 / 24 - 6.2) / 0.5, 6);
    expect(opacityAt(title, 6.45)).toBeCloseTo(0.5, 6);
    expect(opacityAt(title, 192 / 24)).toBe(1);
    expect(opacityAt(title, 193 / 24)).toBe(0);
  });

  it('gives each of the three lines its speaker, its words as heard, and its speech inside it, in the kitchen', () => {
    const lines: Record<string, [string, string, number]> = {
      // The review note's transcript: back home we had a turnip festival (7.5 s) / and nobody came (11.2) / I dated the turnip king (12.6) / twice (14.5).
      festival: ['The sweet one', 'Back home, we had a turnip festival...', 7.5],
      nobody: ['The sharp one', 'And nobody came.', 11.2],
      // "Same night." is lost under the laugh.
      king: ['The tiny mother', 'I dated the turnip king. Twice.', 12.6],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    expect(port.applied).toEqual(Object.keys(lines));
    expect(port.stale).toEqual([]);
    for (const line of timeline.lines) {
      const [speaker, text, heard] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      expect(line.audio).toEqual({ kind: 'segment', segment: 'kitchen' });
      const [from, to] = speechOf(timeline, line.id);
      expect(from).toBeGreaterThanOrEqual(line.start);
      expect(to).toBeLessThanOrEqual(line.end);
      expect(segmentAt(timeline, from)).toBe('kitchen');
      // The transcriber's starts are coarse (and "back" lands before the kitchen even begins); the aligner's are within a second of them.
      expect(Math.abs(from - heard)).toBeLessThan(1);
    }
    // Back to back, each line stopping where the next starts.
    near(byId(timeline.lines, 'festival').start, 8);
    near(byId(timeline.lines, 'festival').end, byId(timeline.lines, 'nobody').start);
    near(byId(timeline.lines, 'nobody').end, byId(timeline.lines, 'king').start);
  });
});
