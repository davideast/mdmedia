import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { opacityAt, positionAt } from '../../src/cut/index';
import { byId, expectInStep, loadPort, near, segmentAt, sha256Of, speechOf, videoTrackSeconds } from './support';

/**
 * Roam Phone, Take 2 (commercial structure). No edit script made it: the
 * provider's extend returned roam-2a-t2 and its lawn-and-packshot tail as one
 * 16 s take, roam-2-full-t1, and compose.mjs laid our graphics over it. So the
 * segment starts come from probing only (ffmpeg scene detection and per-frame
 * luma on the take), and the graphics' timing from a copy of compose.mjs run
 * with its ffmpeg call stubbed out, with its call as the transcript of that
 * session recorded it:
 *
 *   compose.mjs takes/roam-2-full-t1.mp4 takes/roam-2-final.mp4 '[{"png":"gfx/roam-name.png","start":12.4,"end":16.1,"fade":0.25},
 *     {"png":"gfx/roam-tag.png","start":14.0,"end":16.1,"fade":0.25}]'
 *   → [1:v]format=rgba,fade=t=in:st=12.4:d=0.25:alpha=1[g0];[0:v][g0]overlay=x='0':y=0:shortest=1:enable='between(t,12.4,16.1)'[v0];
 *     [2:v]format=rgba,fade=t=in:st=14:d=0.25:alpha=1[g1];[v0][g1]overlay=x='0':y=0:shortest=1:enable='between(t,14,16.1)'[v1]
 */

/** The frame each segment starts on, from probing the take: the hang-up, the handset, the lawn (the extension's first frame), the packshot. */
const CUT_FRAMES = { kitchen: 0, hangup: 95, handset: 124, lawn: 192, pack: 299 };
const END = 16;
const PUBLISHED = 'review/clips/ad-roam-phone-take2.mp4';

const port = loadPort('roam-phone-take2', { 'roam-2-full-t1': 16.0 });
const { timeline, root } = port;

describe('Roam Phone, Take 2', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on roam-2-full-t1), in step, to its length', () => {
    expectInStep(timeline, 'roam-2-full-t1', CUT_FRAMES);
    near(timeline.length, END);
    expect(timeline.music).toEqual([]);
    expect(timeline.sfx).toEqual([]);
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/roam-2-final.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('lays ROAM PHONE and the tagline over the packshot as compose.mjs did, the name a frame early', () => {
    const gfx: Array<[string, string, number]> = [
      ['name', 'gfx/roam-name.png', 12.4],
      ['tagline', 'gfx/roam-tag.png', 14],
    ];
    expect(timeline.overlays.map((o) => o.id)).toEqual(gfx.map((g) => g[0]));
    for (const [id, png, start] of gfx) {
      const o = byId(timeline.overlays, id);
      expect(o.src).toMatchObject({ kind: 'file', path: `${root}/${png}` });
      expect(o.segment).toBeNull();
      near(o.start, start);
      near(o.end, END);
      expect([o.fadeIn, o.fadeOut]).toEqual([0.25, 0]);
      expect(o.blink).toBeNull();
      expect(positionAt(o, start + 0.5)).toEqual({ x: 0, y: 0 });
      expect(opacityAt(o, start - 0.01)).toBe(0);
      expect(opacityAt(o, start + 0.125)).toBeCloseTo(0.5, 6);
      expect(opacityAt(o, start + 0.3)).toBe(1);
    }
    // 12.4 s falls in the lawn shot's last frame (298, 12.417 s), where the name is 7 % in; diffing the clip against the take shows it there faintly.
    const name = byId(timeline.overlays, 'name');
    expect(name.start).toBeLessThan(byId(timeline.segments, 'pack').start);
    expect(opacityAt(name, 298 / 24)).toBeCloseTo((298 / 24 - 12.4) / 0.25, 6);
  });

  it('gives the announcer and the dad their words as heard, each spoken inside its line', () => {
    // [speaker, text, the segment the speech starts in, the transcript's start]. The review note's transcript:
    // Tired of being tied to the wall? (2.0 s) / Introducing Roam Phone, the cordless telephone. (5.1) / the dad chatting (9.9) /
    // Roam Phone. Talk anywhere. Almost. (13.0); "Almost." is 15.3 s in the transcriber's word times. The dad's words are the transcriber's.
    const lines: Record<string, [string, string, string, number]> = {
      tied: ['Announcer', 'Tired of being tied to the wall?', 'kitchen', 2.0],
      intro: ['Announcer', 'Introducing Roam Phone, the cordless telephone!', 'hangup', 5.1],
      chat: ['Dad', "No, I agree. That's why we need to do it.", 'lawn', 9.9],
      talk: ['Announcer', 'Roam Phone. Talk anywhere.', 'pack', 13.0],
      almost: ['Announcer', 'Almost.', 'pack', 15.3],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    expect(port.applied).toEqual(Object.keys(lines));
    expect(port.stale).toEqual([]);
    for (const line of timeline.lines) {
      const [speaker, text, segment, heard] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      expect(line.audio.kind).toBe('segment');
      const [from, to] = speechOf(timeline, line.id);
      expect(from).toBeGreaterThanOrEqual(line.start);
      expect(to).toBeLessThanOrEqual(line.end);
      expect(segmentAt(timeline, from)).toBe(segment);
      expect(Math.abs(from - heard)).toBeLessThan(0.6);
    }
    // "Introducing" starts on the hang-up and runs on over the handset, the same take in step.
    expect(byId(timeline.lines, 'intro').end).toBe(byId(timeline.segments, 'handset').end);
    near(byId(timeline.lines, 'almost').end, END);
  });
});
