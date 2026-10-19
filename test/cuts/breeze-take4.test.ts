import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, opacityAt, positionAt, resolveCutJson, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * Breeze mints, Take 4 "The Blowout", ported from br4/edit.mjs. The expected
 * times are what a copy of that script printed with its ffmpeg call stubbed
 * out (its own `console.log(JSON.stringify({ at, BANG, VO, MUSIC_OUT, STING, END }))`,
 * plus its graphics list `layers` and its filter graph), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/breeze-take4.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts br4/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  hook: 0, blow: 2.11, flat: 4.71, her: 5.51, roll: 7.06, him: 9.41, blanket: 11.26, hood: 12.86, wide: 14.51,
  truck: 17.36, look: 19.46, sit: 21.11, palm: 23.31, give: 24.26, tag: 25.76, pack: 28.15,
};
const BANG = 3.16;
const VO = 14.71;
const MUSIC_OUT = 17.36;
const STING = 26.71;
const END = 30.65;

/** Source lengths in seconds, from ffmpeg on the takes and files (so every `out` is checked against its media). */
const PROBED: Record<string, number> = {
  'br4-hook-t1': 4.01, 'br4-blowout-t1': 5.01, 'br4-flat-t1': 3.01, 'br4-her-t2': 4.03, 'br4-roll-t3': 4.01,
  'br4-him-t2': 4.01, 'br4-blanket-t1': 4.01, 'br4-hood-t2': 4.01, 'br4-wide-t1': 4.01, 'br4-truck-t1': 5.01,
  'br4-trucker-t1': 4.03, 'br4-sit-t4': 5.01, 'br4-palm-t2': 3.01, 'br4-give-t1': 4.01, 'br4-tag-t1': 4.01, 'br3-s7-t1': 4.01,
};
const FILES: Record<string, number> = {
  'audio/breeze-jingle.mp3': 29.41, 'audio/tts/br-vo.wav': 2.74, 'audio/br4-bang.mp3': 1.48, 'audio/br4-hiss.mp3': 2.0,
  'audio/br4-crickets.mp3': 12.0, 'audio/br4-truck.mp3': 4.0,
};
const mediaLength = (src: ResolvedSource): number | undefined =>
  src.kind === 'take' ? PROBED[src.name] : src.kind === 'file' ? FILES[src.ref] : undefined;

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

describe('Breeze mints, Take 4', () => {
  const timeline = resolve();

  it('puts every segment where br4/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/breeze-take4.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 30.65 at 24 fps, which ffmpeg rounds up to a whole frame (736 frames, 30.667 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each shot from its take at its own natural-sound volume, uncropped and unheld', () => {
    // The script's cuts table: [segment, source, in, out, natural-sound volume].
    const shots: Record<string, [string, number, number, number]> = {
      hook: ['br4-hook-t1', 1.84, 3.95, 0.3],
      blow: ['br4-blowout-t1', 0, 2.6, 0.45],
      flat: ['br4-flat-t1', 0.5, 1.3, 0.3],
      her: ['br4-her-t2', 0.6, 2.15, 0.3],
      roll: ['br4-roll-t3', 1.0, 3.35, 0.3],
      him: ['br4-him-t2', 2.0, 3.85, 0.3],
      blanket: ['br4-blanket-t1', 1.2, 2.8, 0.35],
      hood: ['br4-hood-t2', 1.4, 3.05, 0.3],
      wide: ['br4-wide-t1', 0.2, 3.05, 0.25],
      truck: ['br4-truck-t1', 2.1, 4.2, 0.9],
      look: ['br4-trucker-t1', 0.3, 1.95, 0.8],
      sit: ['br4-sit-t4', 2.15, 4.35, 0.8],
      palm: ['br4-palm-t2', 1.0, 1.95, 0.8],
      give: ['br4-give-t1', 1.15, 2.65, 0.8],
      tag: ['br4-tag-t1', 1.6, 3.99, 0.7],
      pack: ['br3-s7-t1', 0, 2.5, 0],
    };
    for (const seg of timeline.segments) {
      const [name, from, to, volume] = shots[seg.id];
      expect(seg.src).toMatchObject({ kind: 'take', name });
      expect([seg.in, seg.out, seg.hold]).toEqual([from, to, 0]);
      expect(seg.crop).toBeNull();
      expect([seg.fadeIn, seg.fadeOut]).toEqual([0, 0]);
      if (volume === 0) {
        // The packshot's own sound is mixed at volume=0.0: silent.
        expect(seg.audio).toBeNull();
        continue;
      }
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name }, in: from, out: to, volume, start: seg.start, end: seg.end });
    }
    // The fade over the finished picture: fade=t=out:st=30.30:d=0.35.
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0.35 });
  });

  it('ducks the jingle exactly as the script\'s volume expression does, and drops it out on the truck', () => {
    const jingle = byId(timeline.music, 'jingle');
    expect(jingle.src).toMatchObject({ kind: 'file', path: `${ROOT}/audio/breeze-jingle.mp3` });
    // atrim=1.5:18.86 from the cut's start.
    expect([jingle.start, jingle.end, jingle.in, jingle.out, jingle.fadeOut]).toEqual([0, MUSIC_OUT, 1.5, 18.86, 0.12]);
    near(jingle.end, PRINTED.truck);
    // volume='if(between(t,3.13,3.66),0.35,if(between(t,14.11,17.61),0.16,0.8))', then afade=t=out:st=17.24:d=0.12.
    const between = (t: number, a: number, b: number): boolean => t >= a && t <= b;
    const script = (t: number): number => {
      if (t < 0 || t >= MUSIC_OUT) return 0;
      const v = between(t, BANG - 0.03, BANG + 0.5) ? 0.35 : between(t, VO - 0.6, VO + 2.9) ? 0.16 : 0.8;
      return v * (t > MUSIC_OUT - 0.12 ? (MUSIC_OUT - t) / 0.12 : 1);
    };
    const jumps = [BANG - 0.03, BANG + 0.5, VO - 0.6];
    let worst = 0;
    for (let t = 0; t < END; t += 0.005) {
      // Skip the instants the gain steps, where "just before" and "at" differ by definition.
      if (jumps.some((j) => Math.abs(t - j) < 0.0026)) continue;
      worst = Math.max(worst, Math.abs(gainAt(jingle, t) - script(t)));
    }
    expect(worst).toBeLessThan(0.001);
    // Silence from the truck until the sting: crickets only.
    for (let t = MUSIC_OUT; t < STING; t += 0.01) expect(timeline.music.every((m) => gainAt(m, t) === 0)).toBe(true);
  });

  it('brings the sung sting in as the trucker\'s head lands, faded out with the picture', () => {
    const sting = byId(timeline.music, 'sting');
    expect(timeline.music.map((m) => m.id)).toEqual(['jingle', 'sting']);
    expect(sting.src).toMatchObject({ kind: 'file', path: `${ROOT}/audio/breeze-jingle.mp3` });
    // STING = tag + (2.7 - 1.6) - 0.15; atrim=21.55:25.49, adelay=26710.
    near(sting.start, PRINTED.tag + (2.7 - 1.6) - 0.15);
    expect([sting.start, sting.end, sting.in, sting.out]).toEqual([STING, END, 21.55, 25.49]);
    // volume=0.85, afade=t=in:d=0.05, afade=t=out:st=3.44:d=0.5.
    const script = (t: number): number => {
      if (t < STING || t >= END) return 0;
      const u = t - STING;
      return 0.85 * (u < 0.05 ? u / 0.05 : 1) * (u > 3.44 ? (3.94 - u) / 0.5 : 1);
    };
    let worst = 0;
    for (let t = STING - 0.5; t < END + 0.1; t += 0.005) worst = Math.max(worst, Math.abs(gainAt(sting, t) - script(t)));
    expect(worst).toBeLessThan(0.001);
  });

  it('lays the bang, hiss, tow truck and crickets where the script delayed them', () => {
    const fx: Record<string, [string, number, number, number]> = {
      bang: ['audio/br4-bang.mp3', BANG, 1.48, 1.3], // adelay=3160
      hiss: ['audio/br4-hiss.mp3', PRINTED.flat + 0.05, 2.0, 0.5], // adelay=4760
      truckfx: ['audio/br4-truck.mp3', PRINTED.truck + 0.1, 4.0, 0.5], // adelay=17460
      crickets: ['audio/br4-crickets.mp3', MUSIC_OUT, STING - MUSIC_OUT + 0.3, 0.55], // atrim=0:9.65, adelay=17360
    };
    expect(timeline.sfx.map((s) => s.id)).toEqual(Object.keys(fx));
    for (const [id, [path, start, length, volume]] of Object.entries(fx)) {
      const clip = byId(timeline.sfx, id);
      expect(clip.src).toMatchObject({ kind: 'file', path: `${ROOT}/${path}` });
      near(clip.start, start);
      near(clip.end, start + length);
      expect(clip.in).toBe(0);
      if (id !== 'crickets') expect([clip.fadeIn, clip.fadeOut]).toEqual([0, 0]);
      expect(gainAt(clip, start + length / 2)).toBeCloseTo(volume, 6);
    }
    near(byId(timeline.sfx, 'bang').start, byId(timeline.segments, 'blow').start + 1.05);
    // Crickets: volume=0.55, afade=t=in:d=0.4, afade=t=out:st=9.35:d=0.3, so they end 0.3 s into the sting.
    const crickets = byId(timeline.sfx, 'crickets');
    near(crickets.end, STING + 0.3);
    expect([crickets.fadeIn, crickets.fadeOut]).toEqual([0.4, 0.3]);
    expect(gainAt(crickets, MUSIC_OUT + 0.2)).toBeCloseTo(0.55 / 2, 6);
    expect(gainAt(crickets, STING + 0.15)).toBeCloseTo(0.55 / 2, 6);
  });

  it('places the announcer, and the sung lines in step with the jingle', () => {
    const lines: Record<string, [string, string, number, number]> = {
      wrong: ['Jingle', 'When the day goes wrong,', 3.16, 6.9],
      cool1: ['Jingle', 'keep it cool, turn it round,', 6.9, 9.0],
      cool2: ['Jingle', 'keep it cool, turn it round,', 9.0, 11.3],
      wholeday: ['Jingle', 'turn your whole day around.', 11.3, VO],
      vo: ['Announcer', 'Breeze. The fresh mint that turns your day around.', VO, VO + 2.74], // adelay=14710, the whole file
      feel: ['Jingle', 'Feel the Breeze!', STING, END],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      const [speaker, text, start, end] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      near(line.start, start);
      near(line.end, end);
    }
    // The announcer is the only voice with its own sound: br-vo.wav at volume=1.3 over the wide.
    const vo = byId(timeline.lines, 'vo');
    expect(vo.audio).toMatchObject({ kind: 'file', src: { path: `${ROOT}/audio/tts/br-vo.wav` }, in: 0, volume: 1.3 });
    near(vo.start, byId(timeline.segments, 'wide').start + 0.2);
    // The sung lines are heard in the jingle and the sting, so they add no sound, and each is read from the music's own clock.
    const jingle = byId(timeline.music, 'jingle');
    const sting = byId(timeline.music, 'sting');
    for (const id of ['wrong', 'cool1', 'cool2', 'wholeday', 'feel']) {
      const line = byId(timeline.lines, id);
      const music = id === 'feel' ? sting : jingle;
      expect(line.audio).toMatchObject({ kind: 'file', src: { path: `${ROOT}/audio/breeze-jingle.mp3` }, volume: 0 });
      if (line.audio.kind !== 'file') throw new Error(`${id} has no file`);
      near(line.audio.in - line.start, music.in - music.start);
      expect(line.start).toBeGreaterThanOrEqual(music.start);
      expect(line.end).toBeLessThanOrEqual(music.end);
    }
  });

  it('shows NEW! and BREEZE on the roll until the second hand, and the logo and line on the packshot', () => {
    // The script's layers: [png, start, end], each faded in over 0.12 s and out over the last 0.1 s.
    const gfx: Array<[string, string, string, number, number]> = [
      ['neww', 'br4/new.png', 'roll', PRINTED.roll + 0.35, PRINTED.roll + 1.35],
      ['label', 'br4/label.png', 'roll', PRINTED.roll + 0.45, PRINTED.roll + 1.35],
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
      expect(o.blink).toBeNull();
      // overlay=0:0 with enable='between(t,s,e)': full-frame PNGs that never move.
      expect(positionAt(o, start + 0.5)).toEqual({ x: 0, y: 0 });
      expect(opacityAt(o, start - 0.01)).toBe(0);
      expect(opacityAt(o, start + 0.06)).toBeCloseTo(0.5, 6);
      expect(opacityAt(o, start + 0.3)).toBeCloseTo(1, 6);
      expect(opacityAt(o, end - 0.05)).toBeCloseTo(0.5, 6);
    }
    // The script printed them as 7.41, 7.51, 28.30 and 29.05 (its fade starts).
    expect(gfx.map((g) => Number(g[3].toFixed(2)))).toEqual([7.41, 7.51, 28.3, 29.05]);
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([16, 6, 2, 4, 4]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
