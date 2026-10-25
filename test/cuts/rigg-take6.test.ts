import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { readCutFile } from '../../src/cut/align.js';
import { applyWords, gainAt, resolveCut, resolveCutJson, type ResolvedSource, type Timeline, type WordsFile } from '../../src/cut/index.js';
import { byId, near, sha256Of, videoTrackSeconds } from './support';

/**
 * RIGG Take 6 (door stays shut): Take 5 with the owner's three notes fixed, written as changes to Take 5.
 * 1. The shove cuts in on the action at 1.125 s, past the take's own dissolve (0.83–1.08 s), not at 0.7.
 * 2. The crowbar insert is a new take, rigg6-pry-t3, in which the door stays shut.
 * 3. No look to camera: the stare shot is gone and the cut ends frozen on her, after her line.
 * The expected times are what `mdmedia cut render` rendered takes/rigg-take6.mp4 from.
 */

const PATH = new URL('../../docs/cuts/rigg-take6.cut.json', import.meta.url).pathname;
const CUT = await readCutFile(PATH);
const BASE: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/rigg-take5.cut.json', import.meta.url), 'utf8'));
const WORDS = JSON.parse(readFileSync(new URL('../../docs/cuts/rigg-take6.words.json', import.meta.url), 'utf8')) as WordsFile;
const ROOT = (BASE as { media: { root: string } }).media.root;

/** The segment starts of the render, in order. Everything from the shove on is 0.425 s earlier than in Take 5. */
const STARTS: Record<string, number> = {
  ext: 0, hero: 1.6, c0030: 4.58, shove: 5.38, l1: 7.255, lock: 10.505, l3: 11.805, lock2: 12.805, c0019: 13.705,
  hinge: 14.255, l5: 16.255, pry: 17.555, c0009: 18.905, l6: 19.405, c0003: 20.505, l7: 21.055, tape: 22.355,
  c0002: 23.405, turn: 24.005, her: 26.055,
};
const SHIFT = 0.425;
const END = 31.155;

/** Source lengths in seconds, from ffmpeg on the takes. */
const PROBED: Record<string, number> = {
  'rigg5-ext-t1': 4.01, 'rigg5-hero-t1': 4.01, 'rigg5-shove-t1': 4.01, 'rigg5-climax-t1': 16.0, 'rigg5-lock-t2': 4.03,
  'rigg5-hinge-t1': 4.01, 'rigg5-pry-t2': 4.01, 'rigg5-tape-t1': 4.01, 'rigg5-turn-t3': 5.01, 'rigg5-her-t2': 5.01,
  'rigg5-stare-t1': 4.01, 'rigg5-lines-t2': 10.01, 'rigg6-pry-t3': 4.03,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

function resolveTake6(): Timeline {
  const result = resolveCut(CUT, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}
function resolveTake5(): Timeline {
  const result = resolveCutJson(BASE, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

describe('RIGG Take 6', () => {
  const take6 = resolveTake6();
  const take5 = resolveTake5();

  it('extends Take 5 and puts every segment where the render started it', () => {
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toMatchObject({ extends: 'rigg-take5', remove: ['stare'] });
    expect(take6.segments.map((s) => s.id)).toEqual(Object.keys(STARTS));
    for (const seg of take6.segments) near(seg.start, STARTS[seg.id]);
    near(take6.length, END);
    expect(take6.output).toBe(`${ROOT}/takes/rigg-take6.mp4`);
    expect(take6.meta).toMatchObject({ title: 'RIGG', version: 'Take 6 (door stays shut)', length: END, fps: 24 });
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/rigg-take6.mp4`;
    if (!existsSync(file)) return; // The media isn't on this machine.
    // 31.155 s at 24 fps is 748 frames, 31.167 s.
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('keeps Take 5 unchanged before the shove, and 0.425 s earlier after it, except the crowbar and her', () => {
    for (const id of ['ext', 'hero', 'c0030']) expect(byId(take6.segments, id)).toEqual(byId(take5.segments, id));
    for (const seg of take6.segments.slice(4)) {
      if (seg.id === 'pry' || seg.id === 'her') continue;
      const old = byId(take5.segments, seg.id);
      expect([seg.src, seg.in, seg.out, seg.hold]).toEqual([old.src, old.in, old.out, old.hold]);
      near(seg.start, old.start - SHIFT);
    }
    expect(take6.overlays.map((o) => o.id)).toEqual(take5.overlays.map((o) => o.id));
    expect(byId(take6.overlays, 'title')).toEqual(byId(take5.overlays, 'title'));
  });

  it('cuts into the shove on the action, past the take\'s own dissolve', () => {
    const shove = byId(take6.segments, 'shove');
    expect(shove.src).toMatchObject({ kind: 'take', name: 'rigg5-shove-t1' });
    // rigg5-shove-t1 dissolves between two framings from 0.83 to 1.08 s; Take 5 cut in at 0.7.
    expect(byId(take5.segments, 'shove').in).toBe(0.7);
    expect([shove.in, shove.out, shove.hold, shove.fadeIn]).toEqual([1.125, 3.0, 0, 0]);
    expect(shove.in).toBeGreaterThan(1.08);
    near(shove.end - shove.start, 1.875);
    expect(take6.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('plays the new crowbar take, where the door stays shut, for as long as Take 5\'s', () => {
    const pry = byId(take6.segments, 'pry');
    expect(pry.src).toMatchObject({ kind: 'take', name: 'rigg6-pry-t3' });
    expect([pry.in, pry.out, pry.hold]).toEqual([2.3, 3.65, 0]);
    expect(pry.audio).toMatchObject({ src: { kind: 'take', name: 'rigg6-pry-t3' }, in: 2.3, volume: 1.25 });
    near(pry.end - pry.start, 1.35);
    expect(take6.sources['take:rigg6-pry-t3']).toMatchObject({
      step: 'generate', storyboard: 'rigg6-pry-c', firstFrame: { kind: 'file', path: `${ROOT}/rigg6/stills/pry-insert-a-720.png` },
    });
  });

  it('ends frozen on her after her line, with no stare shot and the sting where Take 5 put it before its freeze', () => {
    expect(take6.segments.map((s) => s.id)).not.toContain('stare');
    const her = byId(take6.segments, 'her');
    expect([her.in, her.out]).toEqual([0.6, 4.0]);
    near(her.hold, 1.7);
    near(her.end, END);
    expect(her.audio).toMatchObject({ src: { name: 'rigg5-her-t2' }, in: 0.6, out: 5, fadeOut: 0.3 });
    // Her line keeps its window in her take (0.6–3.6), so its words still fit.
    const pull = byId(take6.lines, 'pull');
    near(pull.start, her.start);
    near(pull.end, her.start + 3.0);
    // The sting starts 0.15 s before the freeze and runs 1.85 s to the end, as in Take 5.
    const sting = byId(take6.music, 'sting');
    near(sting.start, her.start + 3.4 - 0.15);
    near(sting.end - sting.start, byId(take5.music, 'sting').end - byId(take5.music, 'sting').start);
    // Silence from the cut to the door until the sting.
    for (let t = byId(take6.segments, 'turn').start; t < sting.start; t += 0.01) {
      expect(take6.music.every((m) => gainAt(m, t) === 0)).toBe(true);
    }
  });

  it('keeps every line from its own stretch of the same takes, with fresh words', () => {
    expect(take6.lines.map((l) => l.id)).toEqual(take5.lines.map((l) => l.id));
    for (const line of take6.lines) {
      const old = byId(take5.lines, line.id);
      expect([line.speaker, line.text]).toEqual([old.speaker, old.text]);
      const shift = line.start < STARTS.shove ? 0 : SHIFT;
      near(line.start, old.start - shift);
      if (line.id !== 'pull') near(line.end, old.end - shift);
    }
    const sha256 = (file: string): string | undefined => sha256Of(file) ?? undefined;
    const merge = applyWords(CUT, WORDS, { mediaLength, sha256 });
    expect(merge.stale).toEqual([]);
    expect(merge.applied.sort()).toEqual(take6.lines.map((l) => l.id).sort());
  });

  it('marks the setups and payoffs as performances, each from one generation', () => {
    expect(take6.performances.map((p) => [p.id, p.lines])).toEqual([
      ['tools', ['wrench', 'paperclip']],
      ['last_resort', ['onething', 'blow']],
      ['punchline', ['pull']],
    ]);
    for (const p of take6.performances) {
      expect(p.splits).toEqual([]);
      expect(p.generations).toHaveLength(1);
    }
  });
});
