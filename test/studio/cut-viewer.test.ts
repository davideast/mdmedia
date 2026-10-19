import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { applyWords, parseCut, parseWordsFile, resolveCut, type Timeline } from '../../src/cut/index';
import {
  activeIndex,
  fitLabels,
  gainPath,
  gapLabel,
  labelRoom,
  lineGaps,
  packLanes,
  rulerSteps,
  secondsLabel,
  silentStretches,
  speakerLanes,
  spokenLines,
  stepTenth,
  tenths,
} from '../../studio/src/lib/cut-timeline';
import { loadCut, mediaFileInsideRoot, parseByteRange } from '../../studio/src/lib/cut-files-server';

const cutsDir = resolve(import.meta.dir, '../../docs/cuts');
const readJson = (file: string): unknown => JSON.parse(readFileSync(join(cutsDir, file), 'utf8'));
/** Take 9 with its word timings from the companion night-wagon-take9.words.json, as the viewer loads it. */
const take9 = (): Timeline => {
  const cut = parseCut(readJson('night-wagon-take9.cut.json'));
  const words = parseWordsFile(readJson('night-wagon-take9.words.json'));
  if (!cut.ok) throw new Error(cut.errors.map((error) => error.message).join('\n'));
  if (!words.ok) throw new Error(words.message);
  const merge = applyWords(cut.value, words.value);
  if (merge.stale.length > 0) throw new Error(`stale words: ${merge.stale.map((s) => `${s.id} (${s.reason})`).join(', ')}`);
  const resolved = resolveCut(merge.cut);
  if (!resolved.ok) throw new Error(resolved.errors.map((error) => error.message).join('\n'));
  return resolved.value;
};

describe('cut viewer times read in tenths of a second', () => {
  test('rounds half-tenths up and always shows one decimal', () => {
    expect(tenths(0)).toBe('0.0');
    expect(tenths(11)).toBe('11.0');
    expect(tenths(26.3)).toBe('26.3');
    expect(tenths(5.55)).toBe('5.6');
    expect(tenths(5.55 - 5.5)).toBe('0.1');
    expect(secondsLabel(3.4)).toBe('3.4 s');
  });

  test('arrow steps land on the 0.1 s grid the page shows, and shift steps a second', () => {
    expect(stepTenth(11.34, 1)).toBe(11.4);
    expect(stepTenth(11.34, -1)).toBe(11.3);
    expect(stepTenth(11.3, 1)).toBe(11.4);
    expect(stepTenth(11.3, -1)).toBe(11.2);
    expect(stepTenth(11.34, 1, 1)).toBe(12.3);
    expect(stepTenth(11.34, -1, 1)).toBe(10.4);
  });

  test('the ruler labels whole seconds when they have room, and coarser steps when they do not', () => {
    expect(rulerSteps(40)).toEqual({ major: 1, minor: 0.5 });
    expect(rulerSteps(27).major).toBe(2);
    expect(rulerSteps(10).major).toBe(5);
  });
});

describe('the Night Wagon Take 9 timeline', () => {
  const timeline = take9();

  test('gives each speaker a lane, in the order they first speak', () => {
    expect(speakerLanes(timeline.lines)).toEqual(['Rick', 'Buddy']);
  });

  test('labels every gap between consecutive lines; the pause before the punchline is the long one', () => {
    const gaps = lineGaps(timeline.lines);
    expect(gaps).toHaveLength(timeline.lines.length - 1);
    const longest = gaps.reduce((a, b) => (b.length > a.length ? b : a));
    expect([longest.from.id, longest.to.id]).toEqual(['turbo', 'wagon']);
    expect(secondsLabel(longest.length)).toBe('3.4 s');
    expect(gaps.filter((gap) => gap.length > 0.1)).toEqual([longest]);
  });

  test('timed to their words, the gaps are the real pauses in the argument', () => {
    const spoken = spokenLines(timeline.lines);
    // Every line now starts on its first word and ends on its last, inside its whole audio.
    spoken.forEach((line, i) => {
      const whole = timeline.lines[i];
      expect(line.words.length).toBeGreaterThan(0);
      expect(line.start).toBeGreaterThanOrEqual(whole.start - 1e-9);
      expect(line.end).toBeLessThanOrEqual(whole.end + 1e-9);
    });
    const gaps = lineGaps(spoken);
    const argument = gaps.filter((gap) => gap.to.id !== 'wagon');
    // The back-and-forth: real pauses of a tenth to about half a second, no longer the 0.0 of the cuts.
    for (const gap of argument) {
      expect(gap.length).toBeGreaterThan(0.1);
      expect(gap.length).toBeLessThan(0.7);
    }
    const punchline = gaps.find((gap) => gap.to.id === 'wagon')!;
    expect(punchline.length).toBeGreaterThan(3);
  });

  test('short gaps read in hundredths, long ones in tenths', () => {
    expect(gapLabel(0.16)).toBe('0.16 s');
    expect(gapLabel(0.225)).toBe('0.23 s');
    expect(gapLabel(0.3)).toBe('0.30 s');
    expect(gapLabel(3.5)).toBe('3.5 s');
  });

  test('a line without word timings keeps its own times', () => {
    const bare = { ...timeline.lines[0], words: [] };
    expect(spokenLines([bare])[0]).toBe(bare);
  });

  test("a line's label never runs into the next line in its lane", () => {
    for (const speaker of speakerLanes(timeline.lines)) {
      const lane = timeline.lines.filter((line) => line.speaker === speaker).sort((a, b) => a.start - b.start);
      const room = labelRoom(lane, timeline.length);
      lane.forEach((line, i) => {
        const end = line.start + room.get(line)!;
        expect(end).toBeCloseTo(lane[i + 1]?.start ?? timeline.length, 6);
        expect(room.get(line)!).toBeGreaterThanOrEqual(line.end - line.start - 1e-6);
      });
    }
  });

  test('the title and its glint overlap, so they take two overlay lanes', () => {
    const lanes = packLanes(timeline.overlays);
    expect(timeline.overlays.map((overlay) => lanes.get(overlay))).toEqual([0, 1]);
  });

  test('the music is silent from the halt until the sting', () => {
    const [silence] = silentStretches(timeline.music, timeline.length);
    expect(tenths(silence.start)).toBe('16.4');
    expect(tenths(silence.end)).toBe('22.2');
    expect(silentStretches(timeline.music, timeline.length)).toHaveLength(1);
  });

  test("the bed's drawn line starts at full volume and dips to 0.18 under the dialogue", () => {
    const { line, area } = gainPath(timeline.music[0]);
    expect(line.startsWith('M0 0 ')).toBe(true);
    expect(line).toContain('L4.2 0.82');
    expect(area.endsWith('Z')).toBe(true);
  });

  test('finds the shot and line under the playhead', () => {
    expect(timeline.segments[activeIndex(timeline.segments, 11)].id).toBe('r5');
    expect(timeline.lines[activeIndex(timeline.lines, 20)].id).toBe('wagon');
    expect(activeIndex(timeline.lines, 18)).toBe(-1);
  });
});

describe('labels that would touch', () => {
  test('keep the most important and drop the rest', () => {
    const shown = fitLabels([
      { x: 10, width: 20, priority: 0.05 },
      { x: 25, width: 20, priority: 3.4 },
      { x: 60, width: 20, priority: 0 },
    ]);
    expect(shown).toEqual([false, true, true]);
  });
});

describe('the media route serves byte ranges', () => {
  test('parses single ranges, open ranges and suffixes', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});

describe('the cut viewer only reads cuts and media it is meant to', () => {
  let root = '';
  const saved = { cuts: process.env.MDMEDIA_CUTS_DIR, media: process.env.MDMEDIA_CUT_MEDIA_ROOT };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cut-viewer-test-'));
    await writeFile(join(root, 'inside.mp4'), 'x');
    process.env.MDMEDIA_CUTS_DIR = cutsDir;
    process.env.MDMEDIA_CUT_MEDIA_ROOT = root;
  });
  afterAll(async () => {
    process.env.MDMEDIA_CUTS_DIR = saved.cuts;
    process.env.MDMEDIA_CUT_MEDIA_ROOT = saved.media;
    if (saved.cuts === undefined) delete process.env.MDMEDIA_CUTS_DIR;
    if (saved.media === undefined) delete process.env.MDMEDIA_CUT_MEDIA_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  test('resolves a cut by name against the media root', async () => {
    const cut = await loadCut('night-wagon-take9');
    expect(cut.ok).toBe(true);
    if (cut.ok) expect(cut.timeline.output).toBe(join(root, 'takes/night-wagon-take9.mp4'));
  });

  test('times its lines by the words file beside it, even against another media root', async () => {
    const cut = await loadCut('night-wagon-take9');
    if (!cut.ok) throw new Error(cut.message);
    expect(cut.words?.stale).toEqual([]);
    expect(cut.words?.applied).toEqual(cut.timeline.lines.map((line) => line.id));
    // This media root has no takes, so the words are checked by text and window only.
    expect(cut.words?.unchecked).toEqual(cut.words?.applied);
    expect(cut.timeline.lines.every((line) => line.words.length > 0)).toBe(true);
  });

  test('leaves out words that no longer match their line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cut-viewer-stale-'));
    try {
      const cut = readJson('night-wagon-take9.cut.json') as { lines: Array<{ id: string; text: string }> };
      cut.lines.find((line) => line.id === 'gap')!.text = "Rick, it's a fifty-foot gap.";
      await writeFile(join(dir, 'night-wagon-take9.cut.json'), JSON.stringify(cut));
      await writeFile(join(dir, 'night-wagon-take9.words.json'), readFileSync(join(cutsDir, 'night-wagon-take9.words.json')));
      process.env.MDMEDIA_CUTS_DIR = dir;
      const loaded = await loadCut('night-wagon-take9');
      if (!loaded.ok) throw new Error(loaded.message);
      expect(loaded.words?.stale).toEqual([{ id: 'gap', reason: 'its text changed' }]);
      expect(loaded.timeline.lines.find((line) => line.id === 'gap')?.words).toEqual([]);
      expect(loaded.timeline.lines.find((line) => line.id === 'boost')?.words.length).toBeGreaterThan(0);
    } finally {
      process.env.MDMEDIA_CUTS_DIR = cutsDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses names that are not plain cut names', async () => {
    for (const name of ['../package', 'night-wagon-take9/../x', 'Night_Wagon', '']) {
      expect((await loadCut(name)).ok).toBe(false);
    }
  });

  test('serves files inside the media root and nothing outside it', async () => {
    expect(await mediaFileInsideRoot(join(root, 'inside.mp4'))).not.toBeNull();
    expect(await mediaFileInsideRoot(join(root, '..', 'elsewhere.mp4'))).toBeNull();
    expect(await mediaFileInsideRoot('/etc/hostname')).toBeNull();
    expect(await mediaFileInsideRoot(root)).toBeNull();
  });
});
