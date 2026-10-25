import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { bedPartGainAt, gainAt, opacityAt, positionAt, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * CGL Football, Take 1 (Keys to the Game), ported from football/edit.mjs. The
 * expected times are what a copy of that script printed with its ffmpeg call
 * stubbed out (its own `console.log(JSON.stringify({ lines, cuts, END }))`,
 * plus its filter graph), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/football-take1.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts football/edit.mjs printed (BUMP, CARD, GAME, CATCH_AT, TACKLE_AT, DOWN_AT, FINAL, BOOTH, FINAL_B, OUTRO), in its order. */
const PRINTED: Record<string, number> = {
  bump: 0, stad: 2.2, card: 6.15, pass: 21.3, catch: 23.9, tackle: 25.65, down: 30.6, finA: 32.78, booth: 36.45, finB: 37.9, outro: 40.73,
};
const END = 42.63;

/** Where the script put each line (its `at`), by the TTS file it plays. */
const AT: Record<string, [number, string]> = {
  c1: [2.5, 'fb-c1c'], c2: [5.35, 'fb-c2'], m1: [7.64, 'fb-m1'], m2: [11.3, 'fb-m2'], m3: [15.75, 'fb-m3'], m3b: [19.15, 'fb-m3b'],
  c3a: [21.45, 'fb-c3a'], c3f: [23.25, 'fb-c3f'], c3c: [24.35, 'fb-c3c'], c4: [26.1, 'fb-c4'], m4: [28.97, 'fb-m4'],
  c5: [33.68, 'fb-c5'], m5: [37.95, 'fb-m5'],
};

/** The script's speech length of each line file (silencedetect at -40 dB), which places the next line. */
const SP: Record<string, number> = {
  'fb-c1c': 2.57, 'fb-c2': 1.64, 'fb-m1': 3.06, 'fb-m2': 3.8, 'fb-m3': 2.4, 'fb-m3b': 1.75,
  'fb-c3a': 1.14, 'fb-c3f': 0.68, 'fb-c3c': 1.02, 'fb-c4': 2.17, 'fb-m4': 3.41, 'fb-c5': 2.62, 'fb-m5': 2.23,
};

/** Source lengths in seconds, from ffmpeg on the media (WAVs from their data chunks, mp3s decoded), so every `out` is checked. */
const PROBED: Record<string, number> = {
  'fb-stadium-t4': 6.02, 'fb-pass-t1': 5.01, 'fb-catch-t2': 4.01, 'fb-tackle-t2': 5.01, 'fb-down-t1': 4.01,
  'fb-final-t3': 4.01, 'fb-booth-t1': 4.01, 'fb-final-t4': 4.01,
  'audio/fb-theme.mp3': 61.283271, 'audio/fb-crowd.mp3': 20.0, 'audio/fb-roar.mp3': 4.0, 'audio/fb-gun.mp3': 3.0,
  'audio/tts/fb-c1c.wav': 2.925708, 'audio/tts/fb-c2.wav': 1.996917, 'audio/tts/fb-m1.wav': 3.343667, 'audio/tts/fb-m2.wav': 4.086708,
  'audio/tts/fb-m3.wav': 2.6935, 'audio/tts/fb-m3b.wav': 2.089792, 'audio/tts/fb-c3a.wav': 1.393208, 'audio/tts/fb-c3f.wav': 0.97525,
  'audio/tts/fb-c3c.wav': 1.253875, 'audio/tts/fb-c4.wav': 2.461333, 'audio/tts/fb-m4.wav': 3.715208, 'audio/tts/fb-c5.wav': 3.018583,
  'audio/tts/fb-m5.wav': 2.50775,
};
const mediaLength = (src: ResolvedSource): number | undefined =>
  src.kind === 'take' ? PROBED[src.name] : src.kind === 'file' ? PROBED[src.ref] : undefined;

function resolve(): Timeline {
  const result = resolveCutJson(cut, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(0.001);
}

/** The video track's length in seconds, read from the MP4's `mdhd` box (no ffprobe needed). */
function videoTrackSeconds(file: string): number {
  const b = readFileSync(file);
  const containers = new Set(['moov', 'trak', 'mdia']);
  let result: number | undefined;
  const walk = (start: number, end: number, track: { mdhd?: [number, number]; video?: boolean }): void => {
    let p = start;
    while (p + 8 <= end) {
      let size = b.readUInt32BE(p);
      const type = b.toString('latin1', p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(p + 8));
        header = 16;
      } else if (size === 0) size = end - p;
      const body = p + header;
      if (type === 'trak') {
        const t: { mdhd?: [number, number]; video?: boolean } = {};
        walk(body, p + size, t);
        if (t.video && t.mdhd) result = t.mdhd[1] / t.mdhd[0];
      } else if (containers.has(type)) walk(body, p + size, track);
      else if (type === 'mdhd') {
        const v1 = b[body] === 1;
        track.mdhd = v1
          ? [b.readUInt32BE(body + 20), Number(b.readBigUInt64BE(body + 24))]
          : [b.readUInt32BE(body + 12), b.readUInt32BE(body + 16)];
      } else if (type === 'hdlr') track.video = b.toString('latin1', body + 8, body + 12) === 'vide';
      p += size;
    }
  };
  walk(0, b.length, {});
  if (result === undefined) throw new Error(`no video track in ${file}`);
  return result;
}

/** `min(1, max(0, x))`, as the script's expressions write it. */
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** The script's duck(a, b): in over 0.15 s before a line, out over 0.25 s after its speech. */
const duck = (a: number, b: number, t: number): number => clamp01((t - (a - 0.15)) / 0.15) * clamp01((b + 0.25 - t) / 0.25);

describe('CGL Football, Take 1', () => {
  const timeline = resolve();
  const at = Object.fromEntries(Object.entries(AT).map(([id, [t]]) => [id, t]));

  it('puts every segment where football/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/football-take1.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 42.63 at 24 fps, which ffmpeg rounds up to a whole frame (1024 frames, 42.667 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each field shot from its take, uncropped, with only some keeping their own sound, low', () => {
    // seg(label, src, a, dur): trim=a:a+dur. place("s_*", ...): the same stretch of the shot's sound, at its start.
    const shots: Record<string, [string, number, number, number | null]> = {
      stad: ['fb-stadium-t4', 0.3, 4.25, null],
      pass: ['fb-pass-t1', 0.1, 2.7, 0.35],
      catch: ['fb-catch-t2', 0.05, 1.8, 0.35],
      tackle: ['fb-tackle-t2', 0, 4.95, 0.8], // the thud
      down: ['fb-down-t1', 0, 2.18, null],
      finA: ['fb-final-t3', 0, 3.67, 0.35],
      booth: ['fb-booth-t1', 2.3, 3.75, null], // the silent beat
      finB: ['fb-final-t4', 0.6, 3.43, null],
    };
    for (const [id, [name, from, to, volume]] of Object.entries(shots)) {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toMatchObject({ kind: 'take', name });
      expect([seg.in, seg.out, seg.hold, seg.fadeIn, seg.fadeOut]).toEqual([from, to, 0, 0, 0]);
      expect(seg.crop).toBeNull();
      expect(seg.zoom).toBeNull();
      if (volume === null) expect(seg.audio).toBeNull();
      else expect(seg.audio).toMatchObject({ src: { kind: 'take', name }, in: from, out: to, volume, start: seg.start, end: seg.end });
    }
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('holds our bumper and the keys card as silent stills', () => {
    const stills: Record<string, [string, number]> = { bump: ['g-bumper-bg', 2.2], card: ['g-keys-bg', 15.15], outro: ['g-bumper-bg', 1.9] };
    for (const [id, [name, length]] of Object.entries(stills)) {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toEqual({ kind: 'file', ref: `football/${name}.png`, path: `${ROOT}/football/${name}.png` });
      expect([seg.still, seg.in, seg.out]).toEqual([true, 0, 0]);
      near(seg.hold, length);
      near(seg.end - seg.start, length);
      expect(seg.audio).toBeNull();
    }
    // The card is cut on "keys", 0.8 s into Chet's question, and runs to 0.4 s after Moose's afterthought.
    near(byId(timeline.segments, 'card').start, at.c2 + 0.8);
    near(byId(timeline.segments, 'card').end, at.m3b + SP['fb-m3b'] + 0.4);
  });

  it('plays every line from its own TTS file where the script put it, at 1.3', () => {
    const lines: Record<string, [string, string]> = {
      c1: ['Chet', 'Good afternoon, everybody, and welcome to CGL Football.'],
      c2: ['Chet', 'Moose, what are your keys to the game?'],
      m1: ['Moose', 'Key number one: score more points than the other team.'],
      m2: ['Moose', "Key number two: don't let the other team score more points than you."],
      m3: ['Moose', "Key number three: don't tackle your own guys."],
      m3b: ['Moose', "I've seen it, Chet. It doesn't help."],
      c3a: ['Chet', 'Kowalski, back to throw...'],
      c3f: ['Chet', 'He fires...'],
      c3c: ['Chet', 'Caught, at the thirty!'],
      c4: ['Chet', 'Haugen, up the middle... and he is brought down.'],
      m4: ['Moose', "That's a big man. When a big man falls down, Chet, he's down."],
      c5: ['Chet', 'Moose, the Icebreakers win it. What was the difference today?'],
      m5: ['Moose', 'Chet... nobody tackled their own guys.'],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      const [speaker, text] = lines[line.id];
      const [start, file] = AT[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      const path = `audio/tts/${file}.wav`;
      // atrim=0:9 (the whole file), volume=1.3, adelay to its at.
      expect(line.audio).toMatchObject({ kind: 'file', src: { kind: 'file', path: `${ROOT}/${path}` }, in: 0, volume: 1.3, filters: [] });
      near(line.start, start);
      near(line.end, start + PROBED[path]);
    }
    // The comic timing, from speech end to the next line: Chet's 0.28 s, Moose's beats, the 1.0 s afterthought and the 1.65 s pause.
    near(at.c2 - (at.c1 + SP['fb-c1c']), 0.28);
    near(at.m1 - (at.c2 + SP['fb-c2']), 0.65);
    near(at.m3 - (at.m2 + SP['fb-m2']), 0.65);
    near(at.m3b - (at.m3 + SP['fb-m3']), 1.0);
    near(at.m5 - (at.c5 + SP['fb-c5']), 1.65);
    // Each key slides on with Moose's first word.
    for (const k of ['1', '2', '3']) near(byId(timeline.overlays, `k${k}`).start, at[`m${k}`]);
  });

  it('reproduces the theme bed and its sting from the script', () => {
    const BUMP = PRINTED.stad;
    const OUTRO = PRINTED.outro;
    // [bed]: atrim=0.33:(c2+0.33), volume='0.6*if(lt(t,2.2),1,max(0.22,1-(t-2.2)*2.6))', afade out from c2-1.2 over 1.2 s.
    const bed = (t: number): number => {
      if (t < 0 || t >= at.c2) return 0;
      const v = 0.6 * (t < BUMP ? 1 : Math.max(0.22, 1 - (t - BUMP) * 2.6));
      return v * (t > at.c2 - 1.2 ? (at.c2 - t) / 1.2 : 1);
    };
    // [sting]: atrim=0.33:(0.33+END-OUTRO), volume=0.6, afade out from END-OUTRO-0.7 over 0.7 s, adelay OUTRO.
    const sting = (t: number): number => (t < OUTRO || t >= END ? 0 : 0.6 * (t > END - 0.7 ? (END - t) / 0.7 : 1));

    expect(timeline.music.map((m) => m.id)).toEqual(['bed', 'sting']);
    const b = byId(timeline.music, 'bed');
    const s = byId(timeline.music, 'sting');
    expect(b.src).toMatchObject({ path: `${ROOT}/audio/fb-theme.mp3` });
    expect(s.src).toMatchObject({ path: `${ROOT}/audio/fb-theme.mp3` });
    expect([b.start, b.end, b.in, b.out]).toEqual([0, at.c2, 0.33, 5.68]);
    expect([s.start, s.end, s.in, s.out]).toEqual([OUTRO, END, 0.33, 2.23]);
    let worst = 0;
    for (let k = 0; k <= END * 200; k++) {
      const t = k / 200;
      worst = Math.max(worst, Math.abs(gainAt(b, t) - bed(t)), Math.abs(gainAt(s, t) - sting(t)));
    }
    expect(worst).toBeLessThan(0.001);
    // No theme from Chet's question until the closing bumper.
    for (let t = at.c2; t < OUTRO; t += 0.01) expect(timeline.music.every((m) => gainAt(m, t) === 0)).toBe(true);
  });

  it('lays the crowd bed as three crossfaded passes that dip under Moose as the script does', () => {
    const BUMP = PRINTED.stad;
    const BOOTH = PRINTED.booth;
    const OUTRO = PRINTED.outro;
    const sp = (k: string): number => SP[`fb-${k}`];
    // volume='0.13*(1-0.3*(ducks under m1..m4)-0.45*duck(m5)-0.3*between(t,BOOTH,m5))', on the timeline's clock.
    const ducks = (t: number): number => ['m1', 'm2', 'm3', 'm3b', 'm4'].reduce((sum, k) => sum + duck(at[k], at[k] + sp(k), t), 0);
    const volume = (t: number): number =>
      0.13 * (1 - 0.3 * ducks(t) - 0.45 * duck(at.m5, at.m5 + sp('m5'), t) - 0.3 * (t >= BOOTH && t <= at.m5 ? 1 : 0));
    // The bed: [crA][crB]acrossfade=d=2, then [crC] (linear "tri" curves), atrim=0:(END-BUMP+0.2), afade in over 0.5 s,
    // adelay BUMP-0.2, then the volume, then afade out from OUTRO+0.6 over 1.2 s.
    const T0 = BUMP - 0.2;
    const outer = (t: number): number => {
      const u = t - T0;
      if (u < 0 || u >= END - BUMP + 0.2) return 0;
      return Math.min(1, u / 0.5) * (t < OUTRO + 0.6 ? 1 : Math.max(0, (OUTRO + 1.8 - t) / 1.2));
    };
    const pass = (i: number, t: number): number => {
      const u = t - T0 - 18 * i; // each pass starts 18 s after the one before
      if (u < 0 || u >= 20) return 0;
      const fadeIn = i === 0 ? 1 : Math.min(1, u / 2);
      const fadeOut = i === 2 ? 1 : Math.min(1, (20 - u) / 2);
      return fadeIn * fadeOut;
    };
    const script = (i: number, t: number): number => volume(t) * outer(t) * pass(i, t);

    // One bed: three passes of the file, under one volume curve.
    const bed = byId(timeline.sfx, 'crowd');
    expect(bed.src).toEqual({ kind: 'bed', parts: 3 });
    near(bed.start, T0);
    near(bed.end, OUTRO + 1.8);
    expect([bed.fadeIn, bed.fadeOut]).toEqual([0.5, 1.2]);
    const passes = bed.parts ?? [];
    expect(passes).toHaveLength(3);
    passes.forEach((part, i) => {
      expect(part.src).toMatchObject({ path: `${ROOT}/audio/fb-crowd.mp3` });
      expect(part.in).toBe(0);
      near(part.start, T0 + 18 * i);
      expect([part.fadeIn, part.fadeOut]).toEqual([i === 0 ? 0 : 2, i === 2 ? 0 : 2]);
    });
    [22, 40, OUTRO + 1.8].forEach((end, i) => near(passes[i].end, end));
    near(passes[2].out, OUTRO + 1.8 - (T0 + 36));
    // The volume curve's keys all belong to the one bed.
    expect(bed.volume).toHaveLength(27);
    const gain = (i: number, t: number): number => gainAt(bed, t) * bedPartGainAt(passes[i], t);
    let worst = 0;
    for (let k = 0; k <= END * 200; k++) {
      const t = k / 200;
      // Skip the instants the bed steps: down into the booth, and back up a little as Moose's answer starts.
      if (Math.abs(t - BOOTH) < 0.0026 || Math.abs(t - at.m5) < 0.0026) continue;
      passes.forEach((_, i) => (worst = Math.max(worst, Math.abs(gain(i, t) - script(i, t)))));
    }
    expect(worst).toBeLessThan(0.001);
    // About 3 dB down under Moose (0.7), and further through his answer (0.55).
    const total = (t: number): number => passes.reduce((sum, _, i) => sum + gain(i, t), 0);
    expect(total(9)).toBeCloseTo(0.091, 6);
    expect(total(37)).toBeCloseTo(0.091, 6);
    expect(total(39)).toBeCloseTo(0.0715, 6);
  });

  it('puts the roar on the catch and the gun on the final cut', () => {
    // place("x_roar", ..., 0, 4, c3c+0.75, 0.2, afade out st=1.8 d=1.4) and place("x_gun", ..., 0, 3, FINAL, 0.2, afade out st=0.5 d=0.9):
    // each is silent after its fade, so its clip ends there.
    const fx: Record<string, [string, number, number, number]> = { roar: ['fb-roar', at.c3c + 0.75, 1.8, 1.4], gun: ['fb-gun', PRINTED.finA, 0.5, 0.9] };
    expect(timeline.sfx.map((s) => s.id)).toEqual(['crowd', 'roar', 'gun']);
    for (const [id, [file, start, st, d]] of Object.entries(fx)) {
      const clip = byId(timeline.sfx, id);
      expect(clip.src).toMatchObject({ path: `${ROOT}/audio/${file}.mp3` });
      near(clip.start, start);
      const script = (t: number): number => {
        const u = t - start;
        return u < 0 || u >= st + d ? 0 : 0.2 * (u < st ? 1 : (st + d - u) / d);
      };
      for (let u = -0.1; u < 4.1; u += 0.005) expect(Math.abs(gainAt(clip, start + u) - script(start + u))).toBeLessThan(0.001);
    }
  });

  it('sweeps the bumper layers in at the open and the close', () => {
    // over(src, between(t, t0+a, t0+2.2), x or y = from*max(0, 1-(t-(t0+a))/d)), for t0 = 0 and OUTRO.
    const layers: Record<string, [string, number, 'x' | 'y', number, number]> = {
      stripes: ['g-bumper-stripes', 0.05, 'x', -1280, 0.4],
      cgl: ['g-bumper-cgl', 0.35, 'y', -140, 0.2],
      football: ['g-bumper-football', 0.6, 'x', 1280, 0.25],
    };
    for (const [t0, suffix] of [[0, 'in'], [PRINTED.outro, 'out']] as const) {
      for (const [name, [file, a, axis, from, d]] of Object.entries(layers)) {
        const o = byId(timeline.overlays, `${name}_${suffix}`);
        expect(o.src).toMatchObject({ path: `${ROOT}/football/${file}.png` });
        near(o.start, t0 + a);
        // Enabled to t0+2.2: the bumper's end at the open; at the close that is past the cut, so they run to its end.
        near(o.end, Math.min(t0 + 2.2, END));
        expect([o.fadeIn, o.fadeOut]).toEqual([0, 0]);
        for (let u = 0; u < o.end - o.start - 1e-6; u += 0.01) {
          const t = o.start + u;
          const p = positionAt(o, t);
          const v = from * Math.max(0, 1 - u / d);
          expect(Math.abs(p[axis] - v)).toBeLessThan(0.001);
          expect(p[axis === 'x' ? 'y' : 'x']).toBe(0);
          expect(opacityAt(o, t)).toBe(1);
        }
      }
    }
  });

  it('fills in the keys card line by line, then shows the strip and the final box', () => {
    const GAME = PRINTED.pass;
    // over("kN", between(t, mN, GAME), x=-50*max(0,1-(t-mN)/0.15), fade in from mN over 0.15 s).
    for (const k of ['1', '2', '3']) {
      const o = byId(timeline.overlays, `k${k}`);
      const m = at[`m${k}`];
      expect(o.src).toMatchObject({ path: `${ROOT}/football/g-keys-${k}.png` });
      near(o.start, m);
      near(o.end, GAME);
      for (let u = 0; u <= GAME - m; u += 0.01) {
        const t = m + u;
        expect(Math.abs(positionAt(o, t).x - -50 * Math.max(0, 1 - u / 0.15))).toBeLessThan(0.001);
        expect(positionAt(o, t).y).toBe(0);
        expect(Math.abs(opacityAt(o, t) - Math.min(1, u / 0.15))).toBeLessThan(0.001);
      }
    }
    // over("strip", between(t, GAME+0.3, CATCH_AT), fade in over 0.2 s).
    const strip = byId(timeline.overlays, 'strip');
    expect(strip.src).toMatchObject({ path: `${ROOT}/football/g-strip.png` });
    near(strip.start, GAME + 0.3);
    near(strip.end, PRINTED.catch);
    expect([strip.fadeIn, strip.fadeOut]).toEqual([0.2, 0]);
    // over("fin", between(t, FINAL+0.45, BOOTH) + between(t, FINAL_B, OUTRO), fade in from FINAL+0.45 over 0.2 s):
    // it fades in once, is gone for the booth, and is back at full strength for the answer.
    const finA = byId(timeline.overlays, 'fin_a');
    const finB = byId(timeline.overlays, 'fin_b');
    for (const o of [finA, finB]) expect(o.src).toMatchObject({ path: `${ROOT}/football/g-final.png` });
    near(finA.start, PRINTED.finA + 0.45);
    near(finA.end, PRINTED.booth);
    near(finB.start, PRINTED.finB);
    near(finB.end, PRINTED.outro);
    expect([finA.fadeIn, finA.fadeOut, finB.fadeIn, finB.fadeOut]).toEqual([0.2, 0, 0, 0]);
    expect(opacityAt(finA, finA.start + 0.1)).toBeCloseTo(0.5, 6);
    expect(opacityAt(finB, finB.start)).toBe(1);
    // Draw order is the script's: the bumper layers, the keys, the strip, the box.
    expect(timeline.overlays.map((o) => o.id)).toEqual([
      'stripes_in', 'cgl_in', 'football_in', 'stripes_out', 'cgl_out', 'football_out', 'k1', 'k2', 'k3', 'strip', 'fin_a', 'fin_b',
    ]);
  });

  it('gives the whole picture the early-80s tape look, and limits the mix, as the script did', () => {
    // scale=600:338,scale=1280:720,chromashift=cbh=4:crh=-3,eq=saturation=0.84:contrast=0.94:gamma=1.05,
    // colorbalance=rs=0.03:bs=-0.03,noise=alls=12:allf=t over everything, overlays included; alimiter=limit=0.95 on the mix.
    expect(timeline.filters).toEqual({
      picture: [
        { kind: 'rescale', width: 600, height: 338 },
        { kind: 'chroma-shift', cb: { x: 4 }, cr: { x: -3 } },
        { kind: 'color', saturation: 0.84, contrast: 0.94, gamma: 1.05 },
        { kind: 'color-balance', shadows: { r: 0.03, b: -0.03 } },
        { kind: 'grain', strength: 12, moving: true },
      ],
      mix: [{ kind: 'limiter', limit: 0.95 }],
    });
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('times the closing bumper\'s layers past the cut\'s end, as at the open, and cuts them off there', () => {
    for (const id of ['stripes_out', 'cgl_out', 'football_out']) {
      const o = byId(timeline.overlays, id);
      near(o.end, END);
      near(o.fadeOutEnd, PRINTED.outro + 2.2);
    }
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([11, 13, 2, 3, 12]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
