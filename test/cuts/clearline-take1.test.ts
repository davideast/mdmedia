import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { byId, expectInStep, loadPort, near, segmentAt, sha256Of, speechOf, videoTrackSeconds } from './support';

/**
 * ClearLine long distance, Take 1. No script made it: it is a single
 * generation, clearline-t1, published as it came. So the segment starts come
 * from probing only (ffmpeg scene detection and per-frame luma on the take),
 * and the lines' rough starts from transcribing the clip (faster-whisper
 * medium.en).
 */

/** The frame each segment starts on, from probing the take: the friend, the wince, the friend's laugh, the wordmark. */
const CUT_FRAMES = { pin: 0, cowboy: 70, wince: 110, laugh: 154, card: 166 };
const END = 8;
const PUBLISHED = 'review/clips/ad-clearline.mp4';

const port = loadPort('clearline-take1', { 'clearline-t1': 8.0 });
const { timeline, root } = port;

describe('ClearLine long distance, Take 1', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on clearline-t1), in step, to its length', () => {
    expectInStep(timeline, 'clearline-t1', CUT_FRAMES);
    near(timeline.length, END);
    expect([timeline.music, timeline.sfx, timeline.overlays]).toEqual([[], [], []]);
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/clearline-t1.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('puts the yell on the friend\'s shot and the announcer from the wince to the end, each spoken inside its line', () => {
    // [speaker, text, the shot it starts in, the transcriber's start]. The announcer says "everything", not the storyboard's "every little thing".
    const lines: Record<string, [string, string, string, number]> = {
      dishes: ['Woman (off-screen)', 'Gordon! The dishes!', 'cowboy', 2.9],
      tagline: ['Announcer', "ClearLine long distance. You'll hear everything.", 'wince', 5.1],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    expect(port.applied).toEqual(Object.keys(lines));
    expect(port.stale).toEqual([]);
    for (const line of timeline.lines) {
      const [speaker, text, segment, heard] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      expect(line.audio).toEqual({ kind: 'segment', segment });
      const [from, to] = speechOf(timeline, line.id);
      expect(from).toBeGreaterThanOrEqual(line.start);
      expect(to).toBeLessThanOrEqual(line.end);
      expect(segmentAt(timeline, from)).toBe(segment);
      expect(Math.abs(from - heard)).toBeLessThan(0.6);
    }
    near(byId(timeline.lines, 'dishes').start, byId(timeline.segments, 'cowboy').start);
    near(byId(timeline.lines, 'tagline').end, END);
  });
});
