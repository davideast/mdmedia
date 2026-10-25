import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readCutFile } from '../../src/cut/align.js';
import { gainAt, lineWindow, resolveCut, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index.js';

const CUT = JSON.parse(readFileSync(new URL('../../docs/cuts/bellamy-ranch-take6.cut.json', import.meta.url), 'utf8')) as {
  media: { root: string };
};
const ROOT: string = CUT.media.root;
const FFMPEG = `${ROOT}/tools/node_modules/ffmpeg-static/ffmpeg`;

/** Source lengths in seconds, from ffmpeg on the takes (so every `out` is checked against its media). */
const PROBED: Record<string, number> = {
  'bellamy-1-t1': 8.0,
  'bel5-s1-t1': 4.01,
  'bel5-s2-t1': 4.01,
  'bel5-s5-t1': 4.01,
  'bel5-s7-t1': 4.01,
  'bel6-turn-t2': 4.03,
  'bel6-gasp-t1': 4.03,
  'bel6-line-t1': 4.01,
  'bel6-rex-t1': 5.01,
  'bel6-stunned-t1': 4.01,
  'bel6-drop-t1': 4.01,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

function resolve(): Timeline {
  const result = resolveCutJson(CUT, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected)).toBeLessThan(0.001);

describe('Bellamy Ranch Take 6', () => {
  const timeline = resolve();

  it('puts every segment where bellamy6/edit.mjs computed it', () => {
    // `at` and END as a copy of edit.mjs printed them with ffmpeg stubbed out.
    const printed: Record<string, number> = {
      titles: 0, threat: 8, doors: 11.4, turn: 13.9, gasp: 14.45, hand: 15.15,
      floor: 15.7, vline: 17.2, rex: 19.05, smirk: 21.87, freeze: 22.3,
    };
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(printed));
    for (const seg of timeline.segments) near(seg.start, printed[seg.id]);
    near(timeline.length, 25.47);
    expect(timeline.output).toBe(`${ROOT}/takes/bellamy-take6.mp4`);
  });

  it('lays "Hello, Victoria." and "Rex?" from their takes where the script laid them', () => {
    // lay("hello", "s2", 3.0, 4.0, at.doors + 1.95) and lay("rex1", "line", 0.25, 1.0, at.floor + 0.95):
    // each line carries its own stretch of another take, so nothing is in sfx.
    expect(timeline.sfx).toEqual([]);
    const hello = byId(timeline.lines, 'hello');
    near(hello.start, 13.35);
    near(hello.end, 14.35);
    expect(hello.audio).toMatchObject({ kind: 'file', src: { kind: 'take', name: 'bel5-s2-t1' }, in: 3, out: 4, volume: 1, filters: [] });
    const rexq = byId(timeline.lines, 'rexq');
    near(rexq.start, 16.65);
    near(rexq.end, 17.4);
    expect(rexq.audio).toMatchObject({ kind: 'file', src: { kind: 'take', name: 'bel6-line-t1' }, in: 0.25, out: 1, volume: 1, filters: [] });
    // Their words are timed from their in-points: the audio window is in→out of the take.
    expect(lineWindow(timeline, hello, ROOT)).toMatchObject({ ok: true, window: { source: 'takes/bel5-s2-t1.mp4', start: 3, end: 4 } });
    expect(lineWindow(timeline, rexq, ROOT)).toMatchObject({ ok: true, window: { source: 'takes/bel6-line-t1.mp4', start: 0.25, end: 1 } });
    // And they land back on the timeline from there: a word at 3.2 s in the take is 0.2 s into the line.
    const raw = JSON.parse(JSON.stringify(CUT)) as { lines: Array<{ id: string; words?: unknown }> };
    for (const line of raw.lines) if (line.id === 'hello') line.words = [{ text: 'Hello,', start: 3.2, end: 3.5 }];
    const withWords = resolveCutJson(raw, { mediaLength });
    if (!withWords.ok) throw new Error(withWords.errors.map((e) => e.message).join('\n'));
    const words = byId(withWords.value.lines, 'hello').words;
    expect(words).toHaveLength(1);
    near(words[0].start, 13.55);
    near(words[0].end, 13.85);
  });

  it('places every line with its speaker and text', () => {
    const expected: Array<[string, string, string, number, number]> = [
      ['penny', 'Victoria', "You'll never see a penny of the Bellamy fortune.", 8, 11.4],
      ['hello', 'Rex', 'Hello, Victoria.', 13.35, 14.35],
      ['rexq', 'Victoria', 'Rex?', 16.65, 17.4],
      ['died', 'Victoria', 'You died in that plane crash!', 17.2, 19.05],
      ['economy', 'Rex', 'No. I just had to fly economy.', 19.05, 21.87],
    ];
    expect(timeline.lines.map((l) => l.id)).toEqual(expected.map((e) => e[0]));
    for (const [id, speaker, text, start, end] of expected) {
      const line = byId(timeline.lines, id);
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      near(line.start, start);
      near(line.end, end);
    }
  });

  it('starts the organ sting the instant his line ends and runs it over the freeze', () => {
    expect(timeline.music.map((m) => m.id)).toEqual(['sting']);
    const sting = byId(timeline.music, 'sting');
    const economy = byId(timeline.lines, 'economy');
    near(sting.start, 21.87);
    expect(sting.start).toBe(economy.end);
    near(sting.end, 25.47);
    expect(sting.src).toMatchObject({ kind: 'take', name: 'bel5-s7-t1' });
    expect([sting.in, sting.out, sting.fadeOut]).toEqual([0, 3.6, 0.8]);
    // afade=t=out:st=2.8:d=0.8: full until 2.8 s in, then down to nothing at 3.6 s.
    expect(gainAt(sting, 21.87 + 2.8)).toBeCloseTo(1, 6);
    expect(gainAt(sting, 21.87 + 3.2)).toBeCloseTo(0.5, 6);
  });

  it('plays room tone from the gasp take under the turn, the smirk and the freeze', () => {
    const turn = byId(timeline.segments, 'turn');
    expect(turn.audio).toMatchObject({ src: { name: 'bel6-gasp-t1' }, in: 1, out: 1.55, volume: 1 });
    const smirk = byId(timeline.segments, 'smirk');
    expect(smirk.audio).toMatchObject({ src: { name: 'bel6-gasp-t1' }, in: 1, out: 1.5, volume: 0.5 });
    const freeze = byId(timeline.segments, 'freeze');
    expect(freeze.audio).toMatchObject({ src: { name: 'bel6-gasp-t1' }, in: 1, out: 2.8, volume: 0.5 });
    near(freeze.audio?.end ?? 0, 24.1);
  });

  it('holds her stunned face to the end of the sting and fades it out', () => {
    const freeze = byId(timeline.segments, 'freeze');
    // hold: STING - 0.43 - 1.8; fade=t=out:st=2.67:d=0.5 in the segment's clock.
    near(freeze.hold, 1.37);
    expect(freeze.fadeOut).toBe(0.5);
    near(freeze.end - freeze.fadeOut - freeze.start, 2.67);
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(timeline.overlays).toEqual([]);
  });

  it('plays every other segment on its own sound, uncropped and unheld', () => {
    for (const seg of timeline.segments) {
      expect(seg.crop).toBeNull();
      if (seg.id !== 'freeze') expect(seg.hold).toBe(0);
      if (['turn', 'smirk', 'freeze'].includes(seg.id)) continue;
      expect(seg.audio).toMatchObject({ src: { path: seg.src.kind === 'take' ? seg.src.path : '' }, in: seg.in, volume: 1 });
    }
  });

  it.skipIf(!existsSync(FFMPEG) || !existsSync(`${ROOT}/takes/bellamy-take6.mp4`))('is as long as the rendered take, to within a frame', () => {
    expect(Math.abs(renderedSeconds(`${ROOT}/takes/bellamy-take6.mp4`, timeline.meta.fps) - timeline.length)).toBeLessThanOrEqual(1 / timeline.meta.fps);
  });
});

/** A rendered file's video length, by counting its frames with ffmpeg. */
function renderedSeconds(file: string, fps: number): number {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = [...run.stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1])).pop();
  expect(frames).toBeDefined();
  return (frames ?? 0) / fps;
}

// The alternate ending, `node bellamy6/edit.mjs rex`: written as changes to the default cut.
const REX_PATH = new URL('../../docs/cuts/bellamy-ranch-take6-rex.cut.json', import.meta.url).pathname;
const REX_CUT = await readCutFile(REX_PATH);

describe('Bellamy Ranch Take 6, freeze on Rex', () => {
  const resolved = resolveCut(REX_CUT, { mediaLength });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  const rex = resolved.value;
  const her = resolve();

  it('extends the default cut and puts every segment where `edit.mjs rex` computed it', () => {
    expect(JSON.parse(readFileSync(REX_PATH, 'utf8'))).toMatchObject({ extends: 'bellamy-ranch-take6', remove: ['smirk'] });
    // `at` and END as a copy of edit.mjs printed them for `rex`, with ffmpeg stubbed out.
    const printed: Record<string, number> = {
      titles: 0, threat: 8, doors: 11.4, turn: 13.9, gasp: 14.45, hand: 15.15,
      floor: 15.7, vline: 17.2, rex: 19.05, freeze: 21.87,
    };
    expect(rex.segments.map((s) => s.id)).toEqual(Object.keys(printed));
    for (const seg of rex.segments) near(seg.start, printed[seg.id]);
    near(rex.length, 25.47);
    expect(rex.output).toBe(`${ROOT}/takes/bellamy-take6-rex.mp4`);
    expect(rex.meta).toMatchObject({ title: 'Bellamy Ranch', version: 'Take 6 (shot by shot, freeze on Rex)', length: 25.47, fps: 24 });
  });

  it("freezes on his smirk: rex 3.32–4.2 held to the sting's end and faded", () => {
    const freeze = byId(rex.segments, 'freeze');
    expect(freeze.src).toMatchObject({ kind: 'take', name: 'bel6-rex-t1' });
    expect([freeze.in, freeze.out]).toEqual([3.32, 4.2]);
    // hold: STING - 0.88; fade=t=out:st=STING-0.5:d=0.5 in the segment's clock.
    near(freeze.hold, 2.72);
    expect(freeze.fadeOut).toBe(0.5);
    near(freeze.end - freeze.fadeOut - freeze.start, 3.1);
    // The quiet room tone, gasp 1.0 to 2.8 at half volume.
    expect(freeze.audio).toMatchObject({ src: { name: 'bel6-gasp-t1' }, in: 1, out: 2.8, volume: 0.5 });
    near(freeze.end, byId(rex.music, 'sting').end);
  });

  it('keeps everything else as the default cut has it', () => {
    const shared = her.segments.filter((s) => s.id !== 'smirk' && s.id !== 'freeze');
    expect(rex.segments.slice(0, shared.length)).toEqual(shared);
    expect(rex.lines).toEqual(her.lines);
    expect(rex.music).toEqual(her.music);
    expect([rex.sfx, rex.overlays]).toEqual([[], []]);
  });

  it.skipIf(!existsSync(FFMPEG) || !existsSync(`${ROOT}/takes/bellamy-take6-rex.mp4`))('is as long as the rendered take, to within a frame', () => {
    expect(Math.abs(renderedSeconds(`${ROOT}/takes/bellamy-take6-rex.mp4`, rex.meta.fps) - rex.length)).toBeLessThanOrEqual(1 / rex.meta.fps);
  });
});
