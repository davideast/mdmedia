import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, opacityAt, positionAt, resolveCutJson, zoomAt, type ResolvedSource, type Timeline } from '../../src/cut/index';
import { byId, near, videoTrackSeconds } from './support';

/**
 * Breeze mints, Take 5 "the mint turns everyone around", cut by br5/edit.mjs in
 * the CRT TV media folder. The expected times are what that script printed
 * when it rendered takes/breeze-take5.mp4 (its `console.log(JSON.stringify(plan))`),
 * and its filter graph: segment starts, the bang, the announcer, the jingle's
 * sync and its one-bar repeat, the sting, and the graphics.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/breeze-take5.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;
const FPS = 24;

/** The segment starts br5/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  hook: 0, blow: 1.291667, slump: 2.916667, arms: 3.833333, roll: 5.125, grin: 7, out: 8.5, trunk: 9.791667,
  pull: 10.75, spread: 12.083333, offer: 13.291667, melt: 15, lean: 16.833333, wide: 18.125,
  truck: 20.833333, climb: 22.75, hold: 25.208333, take: 26.375, soften: 28.083333, sit: 29.875,
  rest: 31.666667, eye: 33.291667, pack: 34.583333,
};
const END = 37;
const BANG = 1.83;
const VO = 18.325;
const JO = 2.516667;
const MUSIC_OUT = 20.833333;
const SPLICE = 18.715333;
const SPLICE_SRC = 21.232;
const B_IN = 19.086;
const B_OUT = 21.204;
const STING = 32.325;
/** The jingle's bar, measured by br5/grid.py (111.8 bpm), and the bar line the repeat starts from. */
const BAR = 2.146;

/** Source lengths in seconds (ffmpeg's container durations, and decoded lengths for the sound effects). */
const PROBED: Record<string, number> = {
  'br4-hook-t1': 4.01, 'br5-bang-t2': 4.01, 'br5-tyre-t1': 4.01, 'br5-arms-t1': 4.01, 'br4-roll-t3': 4.01, 'br4-him-t2': 4.01,
  'br5-out-t2': 4.01, 'br5-trunk-t2': 4.01, 'br5-pull-t1': 4.01, 'br4-blanket-t1': 4.01, 'br5-offer-t2': 4.01,
  'br5-melt2-t2': 4.03, 'br5-lean-t1': 4.01, 'br4-wide-t1': 4.01, 'br5-truck-t3': 5.01, 'br5-climb-t3': 5.01,
  'br5-hold2-t3': 4.01, 'br5-take-t2': 4.01, 'br5-soften-t5': 4.03, 'br5-sit-t1': 5.01, 'br5-rest-t1': 4.01,
  'br5-eye2-t1': 4.01, 'br3-s7-t1': 4.01,
};
const FILES: Record<string, number> = {
  'audio/breeze-jingle.mp3': 29.41, 'audio/tts/br-vo.wav': 2.74, 'audio/br4-bang.mp3': 1.48, 'audio/br4-hiss.mp3': 2.0,
  'audio/br4-crickets.mp3': 12.0, 'audio/br5-engine.mp3': 3.0, 'audio/br5-door.mp3': 2.48,
};
const mediaLength = (src: ResolvedSource): number | undefined =>
  src.kind === 'take' ? PROBED[src.name] : src.kind === 'file' ? FILES[src.ref] : undefined;

function resolve(json: unknown = cut): Timeline {
  const result = resolveCutJson(json, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

describe('Breeze mints, Take 5', () => {
  const timeline = resolve();

  it('puts every segment where br5/edit.mjs started it, on whole frames, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) {
      near(seg.start, PRINTED[seg.id]);
      // Every cut is on a frame of the render.
      near(seg.start * FPS, Math.round(seg.start * FPS));
    }
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/breeze-take5.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // 888 frames at 24 fps.
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / FPS + 1e-6);
  });

  it('cuts each shot from its take, in whole frames, at its own natural-sound volume', () => {
    // The script's cuts table, snapped to frames: [take, in frame, out frame, natural-sound volume].
    const shots: Record<string, [string, number, number, number]> = {
      hook: ['br4-hook-t1', 60, 91, 0.3], blow: ['br5-bang-t2', 13, 52, 0.3], slump: ['br5-tyre-t1', 44, 66, 0.3],
      arms: ['br5-arms-t1', 24, 55, 0.3], roll: ['br4-roll-t3', 31, 76, 0.3], grin: ['br4-him-t2', 55, 91, 0.3],
      out: ['br5-out-t2', 46, 77, 0.3], trunk: ['br5-trunk-t2', 41, 64, 0.3], pull: ['br5-pull-t1', 60, 92, 0.3],
      spread: ['br4-blanket-t1', 29, 58, 0.3], offer: ['br5-offer-t2', 37, 78, 0.3], melt: ['br5-melt2-t2', 44, 88, 0.3],
      lean: ['br5-lean-t1', 24, 55, 0.3], wide: ['br4-wide-t1', 5, 70, 0.25],
      truck: ['br5-truck-t3', 48, 94, 0.6], climb: ['br5-climb-t3', 32, 91, 0.8], hold: ['br5-hold2-t3', 49, 77, 0.6],
      take: ['br5-take-t2', 38, 79, 0.6], soften: ['br5-soften-t5', 42, 85, 0.6], sit: ['br5-sit-t1', 37, 80, 0.6],
      rest: ['br5-rest-t1', 43, 82, 0.6], eye: ['br5-eye2-t1', 22, 53, 0.6], pack: ['br3-s7-t1', 0, 58, 0],
    };
    for (const seg of timeline.segments) {
      const [name, from, to, volume] = shots[seg.id];
      expect(seg.src).toMatchObject({ kind: 'take', name });
      near(seg.in, from / FPS, 1e-5);
      near(seg.out, to / FPS, 1e-5);
      expect(seg.hold).toBe(0);
      expect(seg.crop).toBeNull();
      if (volume === 0) {
        expect(seg.audio).toBeNull();
        continue;
      }
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name }, volume });
    }
    expect(timeline.picture).toMatchObject({ fadeIn: 0, fadeOut: 0.35 });
  });

  it('pushes in on her face in the last shot, as the script\'s zoompan did', () => {
    const eye = byId(timeline.segments, 'eye');
    // zoompan z = 1 + 0.3 * frame / 31 (the shot is 31 frames), about (360, 250): the cut file keys 1.3 at the shot's end.
    for (let k = 0; k < 31; k++) {
      const z = zoomAt(eye, eye.start + k / FPS);
      expect(z.scale).toBeCloseTo(1 + (0.3 * k) / 31, 4);
      expect(z.focus).toEqual({ x: 360, y: 250 });
    }
  });

  it('lands "When the day goes wrong" as she folds her arms, and ducks the jingle as the script did', () => {
    const jingle = byId(timeline.music, 'jingle');
    expect(jingle.src).toMatchObject({ kind: 'file', path: `${ROOT}/audio/breeze-jingle.mp3` });
    // The sync point: 6.5 s into the file plays 0.15 s into the arms shot, so the jingle starts JO into the file.
    near(jingle.in, JO);
    near(jingle.start, 0);
    near(6.5 - jingle.in, PRINTED.arms + 0.15);
    // atrim=JO:SPLICE_SRC+0.01, afade=t=out:st=SPLICE:d=0.01.
    near(jingle.end, SPLICE + 0.01);
    expect(jingle.fadeOut).toBe(0.01);
    const duck = (t: number): number =>
      t >= BANG - 0.03 && t <= BANG + 0.5 ? 0.35 : t >= VO - 0.6 && t <= VO + 2.9 ? 0.16 : 0.8;
    const jumps = [BANG - 0.03, BANG + 0.5, VO - 0.6];
    const script = (t: number): number => {
      if (t < 0 || t >= SPLICE + 0.01) return 0;
      return duck(t) * (t > SPLICE ? (SPLICE + 0.01 - t) / 0.01 : 1);
    };
    let worst = 0;
    for (let t = 0; t < SPLICE + 0.02; t += 0.005) {
      if (jumps.some((j) => Math.abs(t - j) < 0.0026)) continue;
      worst = Math.max(worst, Math.abs(gainAt(jingle, t) - script(t)));
    }
    expect(worst).toBeLessThan(0.001);
  });

  it('repeats one bar of the jingle at a bar line under the announcer, and drops the music out on the truck', () => {
    const second = byId(timeline.music, 'jingle2');
    expect(second.src).toMatchObject({ kind: 'file', path: `${ROOT}/audio/breeze-jingle.mp3` });
    // The splice is a bar line (6.21 + 7 bars), inside the announcer duck, and the repeat starts one bar earlier.
    near(SPLICE_SRC, 6.21 + 7 * BAR);
    near(SPLICE, SPLICE_SRC - JO);
    near(second.in, B_IN);
    near(second.in, SPLICE_SRC - BAR);
    expect(SPLICE).toBeGreaterThan(VO - 0.6);
    // adelay=SPLICE, afade in 0.01; trimmed to B_OUT, faded out over 0.12 s to the truck. It stops before the sung "Feel" (21.55).
    near(second.start, SPLICE);
    near(second.end, MUSIC_OUT);
    near(second.in + (second.end - second.start), B_OUT);
    expect(B_OUT).toBeLessThan(21.4);
    expect([second.fadeIn, second.fadeOut]).toEqual([0.01, 0.12]);
    // Under the duck it is at 0.16, crossfading with the first pass over 10 ms.
    expect(gainAt(second, SPLICE + 1)).toBeCloseTo(0.16, 6);
    expect(gainAt(second, SPLICE + 0.005) + gainAt(byId(timeline.music, 'jingle'), SPLICE + 0.005)).toBeCloseTo(0.16, 6);
    // Silence from the truck until the sting: crickets only.
    for (let t = MUSIC_OUT + 0.001; t < STING; t += 0.01) expect(timeline.music.every((m) => gainAt(m, t) === 0)).toBe(true);
  });

  it('brings the sung sting in as the trucker\'s head lands, faded out with the picture', () => {
    const sting = byId(timeline.music, 'sting');
    // STING = rest + (2.6 - rest.in) - 0.15, the head landing at 2.6 s into the rest take.
    near(sting.start, PRINTED.rest + (2.6 - 43 / FPS) - 0.15);
    near(sting.start, STING);
    near(sting.end, END);
    near(sting.in, 21.55);
    const script = (t: number): number => {
      if (t < STING || t >= END) return 0;
      const u = t - STING;
      const len = END - STING;
      return 0.85 * (u < 0.05 ? u / 0.05 : 1) * (u > len - 0.5 ? (len - u) / 0.5 : 1);
    };
    let worst = 0;
    for (let t = STING - 0.5; t < END + 0.1; t += 0.005) worst = Math.max(worst, Math.abs(gainAt(sting, t) - script(t)));
    expect(worst).toBeLessThan(0.001);
    // The packshot comes in on "Breeze!" (23.67 s into the file).
    expect(PRINTED.pack).toBeGreaterThan(STING + (23.67 - 21.55) - 0.1);
    expect(PRINTED.pack).toBeLessThan(STING + (23.67 - 21.55) + 0.5);
  });

  it('lays the bang, hiss, truck engine and door, his sigh and the crickets where the script delayed them', () => {
    const fx: Record<string, [string, number, number, number]> = {
      bang: ['audio/br4-bang.mp3', BANG, 1.48, 1.3],
      hiss: ['audio/br4-hiss.mp3', PRINTED.slump + 0.05, 2.0, 0.5],
      engine: ['audio/br5-engine.mp3', PRINTED.truck + 0.05, 3.0, 0.7],
      door: ['audio/br5-door.mp3', PRINTED.climb + 0.05, 2.48, 0.6],
      sigh: ['takes/br5-climb-t3.mp4', PRINTED.hold, 4.6 - 91 / FPS, 0.8],
      crickets: ['audio/br4-crickets.mp3', MUSIC_OUT + 0.4, STING + 0.3 - (MUSIC_OUT + 0.4), 0.55],
    };
    expect(timeline.sfx.map((s) => s.id)).toEqual(Object.keys(fx));
    for (const [id, [path, start, length, volume]] of Object.entries(fx)) {
      const clip = byId(timeline.sfx, id);
      if (id === 'sigh') expect(clip.src).toMatchObject({ kind: 'take', name: 'br5-climb-t3' });
      else expect(clip.src).toMatchObject({ kind: 'file', path: `${ROOT}/${path}` });
      near(clip.start, start);
      near(clip.end, start + length);
      expect(gainAt(clip, start + length / 2)).toBeCloseTo(volume, 6);
    }
    // The bang is the jolt in the take: 1.08 s into it.
    near(byId(timeline.sfx, 'bang').start, PRINTED.blow + (1.08 - 13 / FPS));
    // The sigh is the climb take's own sound from where the shot is cut (3.79 s), run on under the next shot.
    near(byId(timeline.sfx, 'sigh').in, 91 / FPS);
    // afade out over the engine's last 0.4 s; the sigh's last 0.2 s; crickets in over 0.6 s and out over 0.3 s, ending 0.3 s into the sting.
    const engine = byId(timeline.sfx, 'engine');
    expect(gainAt(engine, engine.end - 0.2)).toBeCloseTo(0.35, 6);
    const crickets = byId(timeline.sfx, 'crickets');
    expect([crickets.fadeIn, crickets.fadeOut]).toEqual([0.6, 0.3]);
    near(crickets.end, STING + 0.3);
    expect(gainAt(crickets, crickets.start + 0.3)).toBeCloseTo(0.55 / 2, 6);
  });

  it('places the announcer over the wide, and the sung lines in the music\'s clock', () => {
    const vo = byId(timeline.lines, 'vo');
    expect(vo.audio).toMatchObject({ kind: 'file', src: { path: `${ROOT}/audio/tts/br-vo.wav` }, in: 0, volume: 1.3 });
    near(vo.start, VO);
    near(vo.end, VO + 2.74);
    const jingle = byId(timeline.music, 'jingle');
    const sting = byId(timeline.music, 'sting');
    const sungIn: Record<string, number> = { wrong: 4.66, cool1: 8.4, cool2: 10.5, wholeday: 12.8, feel: 21.55 };
    for (const [id, from] of Object.entries(sungIn)) {
      const line = byId(timeline.lines, id);
      const music = id === 'feel' ? sting : jingle;
      expect(line.audio).toEqual({ kind: 'clip', clip: music.id });
      expect(line.sung).toBe(true);
      near(line.start - music.start, from - music.in);
    }
    // "When" is sung 6.5 s into the file: 0.15 s into the arms shot.
    near(byId(timeline.lines, 'wrong').start + (6.5 - 4.66), PRINTED.arms + 0.15);
    // Every lyric is sung before the repeat, so none is heard twice.
    expect(byId(timeline.lines, 'wholeday').end).toBeLessThan(SPLICE);
  });

  it('has word timings for every line, the sung ones approximate', () => {
    const words = JSON.parse(readFileSync(new URL('../../docs/cuts/breeze-take5.words.json', import.meta.url), 'utf8'));
    for (const id of ['wrong', 'cool1', 'cool2', 'wholeday', 'feel']) {
      expect(words.lines[id]).toMatchObject({ approximate: true, fingerprint: { source: 'audio/breeze-jingle.mp3' } });
      expect(words.lines[id].words.length).toBeGreaterThan(2);
    }
    expect(words.lines.vo.fingerprint.snap).toBe('speech-onset@1');
    expect(words.lines.vo.words.map((w: { text: string }) => w.text).join(' ')).toBe('Breeze. The fresh mint that turns your day around.');
  });

  it('shows NEW! and BREEZE on the roll over the same source frames as Take 4, and the logo and line on the packshot', () => {
    // Take 4 showed them from 1.35 and 1.45 s into the roll take until 2.35 s; this cut keeps those source times.
    const gfx: Array<[string, string, string, number, number]> = [
      ['neww', 'br4/new.png', 'roll', PRINTED.roll + (1.35 - 31 / FPS), PRINTED.roll + (2.35 - 31 / FPS)],
      ['label', 'br4/label.png', 'roll', PRINTED.roll + (1.45 - 31 / FPS), PRINTED.roll + (2.35 - 31 / FPS)],
      ['logo', 'br3/logo.png', 'pack', PRINTED.pack + 0.15, END],
      ['tagline', 'br3/tag.png', 'pack', PRINTED.pack + 0.9, END],
    ];
    expect(timeline.overlays.map((o) => o.id)).toEqual(gfx.map((g) => g[0]));
    for (const [id, png, segment, start, end] of gfx) {
      const o = byId(timeline.overlays, id);
      expect(o.src).toMatchObject({ kind: 'file', path: `${ROOT}/${png}` });
      expect(o.segment).toBe(segment);
      near(o.start, start);
      near(o.end, end);
      expect([o.fadeIn, o.fadeOut]).toEqual([0.12, 0.1]);
      expect(positionAt(o, start + 0.5)).toEqual({ x: 0, y: 0 });
      expect(opacityAt(o, start - 0.01)).toBe(0);
      expect(opacityAt(o, start + 0.3)).toBeCloseTo(1, 6);
    }
  });

  it('records where every take came from', () => {
    const sources = (cut as { sources: Record<string, { storyboard?: string }> }).sources;
    for (const seg of timeline.segments) {
      const name = (seg.src as { name: string }).name;
      expect(sources[`take:${name}`]?.storyboard).toBe(name.replace(/-t\d+$/, ''));
    }
  });
});
