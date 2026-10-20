import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { byId, expectInStep, loadPort, near, segmentAt, sha256Of, speechOf, videoTrackSeconds } from './support';

/**
 * Starship Meridian, Take 2 of the extension. No script made it: it is the
 * provider's extend of meridian-1-t1 by ch-meridian-2, run twice, and the
 * second result, meridian-full-t2, is the published clip as it came. So the
 * segment starts come from probing only (ffmpeg scene detection and per-frame
 * luma on the take, down to its own cut to black on frame 371), and the
 * lines' rough starts from transcribing the clip (faster-whisper medium.en).
 */

/** The frame each segment starts on, from probing the take: the bridge, the captain's close shot, the Vorrek (the extension's first frame), the captain again, red alert, black. */
const CUT_FRAMES = { ship: 0, rise: 47, hailing: 84, sneer: 191, quiet: 262, red: 310, black: 371 };
const END = 16;
const PUBLISHED = 'review/clips/ch-meridian.mp4';

const port = loadPort('meridian-take2', { 'meridian-full-t2': 16.0 });
const { timeline, root } = port;

describe('Starship Meridian, Take 2 of the extension', () => {
  it('cuts the one take where its picture cuts (segment starts from probing only: scene detection on meridian-full-t2), in step, to its length', () => {
    expectInStep(timeline, 'meridian-full-t2', CUT_FRAMES);
    near(timeline.length, END);
    expect([timeline.music, timeline.overlays]).toEqual([[], []]);
  });

  it('labels the klaxon in the take\'s own sound, from the red alert through the cut to black', () => {
    // The take's sound comes up from about -35 to -20 dBFS at 12.9–13.0 s, as the bridge floods red, and runs on to the end.
    const klaxon = byId(timeline.sfx, 'klaxon');
    expect(klaxon).toMatchObject({ segment: 'red', end: END, src: { kind: 'take', name: 'meridian-full-t2' } });
    near(klaxon.start, CUT_FRAMES.red / 24);
    near(klaxon.in, klaxon.start);
    expect(timeline.sfx).toHaveLength(1);
    expect(timeline.sources['take:meridian-full-t2']).toMatchObject({ step: 'extend', extendedFrom: { name: 'meridian-1-t1' }, storyboard: 'ch-meridian-2' });
  });

  it('is the published clip, byte for byte, and as long to within a frame', () => {
    expect(timeline.output).toBe(`${root}/takes/meridian-full-t2.mp4`);
    const published = `${root}/${PUBLISHED}`;
    if (!existsSync(published)) return; // The media isn't on this machine.
    expect(sha256Of(timeline.output!)).toBe(sha256Of(published));
    expect(Math.abs(videoTrackSeconds(published) - timeline.length)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('gives the captain and the Vorrek their lines, each spoken inside its line and its own shot', () => {
    // [speaker, text, the shot it is spoken in, the transcriber's start].
    const lines: Record<string, [string, string, string, number]> = {
      hail: ['Captain Halloran', 'This is Captain Halloran of the starship Meridian. You have crossed into protected space.', 'hailing', 3.18],
      borders: ['Vorrek commander', 'Your borders mean nothing to the Vorrek.', 'sneer', 8.4],
      shields: ['Captain Halloran', 'Shields up. Red alert.', 'quiet', 11.4],
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
    // "Red alert." finishes just as the bridge floods red; the line runs 0.3 s into it.
    near(byId(timeline.lines, 'shields').end, byId(timeline.segments, 'red').start + 0.3);
    // The black is the take's own, nobody speaks over it.
    expect(timeline.lines.every((l) => l.end <= byId(timeline.segments, 'black').start)).toBe(true);
  });
});
