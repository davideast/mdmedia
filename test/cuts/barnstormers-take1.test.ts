import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { expectInStep, loadPort, near, sha256Of, videoTrackSeconds } from './support';

/**
 * Barnstormers, Take 1. No script made it: it is the provider's extend of
 * barnstormers-1-t1 by ch-barnstormers-2, barnstormers-full-t1, published as it
 * came. So the segment starts come from probing only (ffmpeg scene detection
 * and per-frame luma on the take). Nobody speaks; the transcriber hears only
 * music.
 */

/** The frame each segment starts on, from probing the take; the barn doors burst open on the extension's first frame, 192. */
const CUT_FRAMES = { sparks: 0, weld: 23, hammer: 55, catcher: 82, rivets: 111, blueprint: 138, team: 167, burst: 192, sedan: 264, highfive: 335 };
const END = 16;
const PUBLISHED = 'review/clips/ch-barnstormers.mp4';

const port = loadPort('barnstormers-take1', { 'barnstormers-full-t1': 16.0 });
const { timeline, root } = port;

describe('Barnstormers, Take 1', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on barnstormers-full-t1), in step, to its length', () => {
    expectInStep(timeline, 'barnstormers-full-t1', CUT_FRAMES);
    near(timeline.length, END);
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/barnstormers-full-t1.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('has no lines, sound effects or overlays: all its sound is the take\'s own, its music labelled', () => {
    expect([timeline.lines, timeline.sfx, timeline.overlays]).toEqual([[], [], []]);
    expect(port.applied).toEqual([]);
    const music = timeline.music.map((m) => [m.id, m.segment, m.start, m.end, m.in, m.out]);
    expect(music).toEqual([['music', 'sparks', 0, END, 0, END]]);
    expect(timeline.sources['take:barnstormers-full-t1']).toMatchObject({ step: 'extend', storyboard: 'ch-barnstormers-2' });
  });
});
