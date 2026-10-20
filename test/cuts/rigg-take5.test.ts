import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { loadPort, speechOf } from './support';
import { gainAt, lineGainAt, opacityAt, positionAt, resolveCutJson, segmentGainAt, zoomAt, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * RIGG Take 5, ported from rigg5/edit.mjs. The expected times are what a copy
 * of that script printed with its ffmpeg call stubbed out
 * (`console.log(JSON.stringify({ at, STING, END }))`), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/rigg-take5.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts rigg5/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  ext: 0, hero: 1.6, c0030: 4.58, shove: 5.38, l1: 7.68, lock: 10.93, l3: 12.23, lock2: 13.23, c0019: 14.13,
  hinge: 14.68, l5: 16.68, pry: 17.98, c0009: 19.33, l6: 19.83, c0003: 20.93, l7: 21.48, tape: 22.78,
  c0002: 23.83, turn: 24.43, her: 26.48, stare: 29.48,
};
const STING = 31.63;
const END = 33.48;
const COUNTS = ['c0030', 'c0019', 'c0009', 'c0003', 'c0002'];

/** Source lengths in seconds, from ffmpeg on the takes (so every `out` is checked against its media). */
const PROBED: Record<string, number> = {
  'rigg5-ext-t1': 4.01, 'rigg5-hero-t1': 4.01, 'rigg5-shove-t1': 4.01, 'rigg5-climax-t1': 16.0, 'rigg5-lock-t2': 4.03,
  'rigg5-hinge-t1': 4.01, 'rigg5-pry-t2': 4.01, 'rigg5-tape-t1': 4.01, 'rigg5-turn-t3': 5.01, 'rigg5-her-t2': 5.01,
  'rigg5-stare-t1': 4.01,
};
const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? PROBED[src.name] : undefined);

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

describe('RIGG Take 5', () => {
  const timeline = resolve();

  it('puts every segment where rigg5/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/rigg-take5.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 33.48 at 24 fps, which ffmpeg rounds up to a whole frame (804 frames, 33.5 s).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each shot from its take at its own volume', () => {
    const shots: Record<string, [string, number, number, number]> = {
      ext: ['rigg5-ext-t1', 0.3, 1.9, 0.5],
      hero: ['rigg5-hero-t1', 1.0, 3.98, 0.25],
      shove: ['rigg5-shove-t1', 0.7, 3.0, 1],
      l1: ['rigg5-climax-t1', 0, 3.25, 1],
      lock: ['rigg5-lock-t2', 0.7, 2.0, 0.6],
      l3: ['rigg5-climax-t1', 4.55, 5.55, 1],
      lock2: ['rigg5-lock-t2', 2.3, 3.2, 0.7],
      hinge: ['rigg5-hinge-t1', 1.2, 3.2, 0.8],
      l5: ['rigg5-climax-t1', 8.45, 9.75, 1],
      pry: ['rigg5-pry-t2', 2.5, 3.85, 0.9],
      l6: ['rigg5-climax-t1', 11.25, 12.35, 1],
      l7: ['rigg5-climax-t1', 12.7, 14.0, 1],
      tape: ['rigg5-tape-t1', 1.55, 2.6, 0.9],
      turn: ['rigg5-turn-t3', 2.0, 4.05, 1],
      her: ['rigg5-her-t2', 0.6, 3.6, 1],
    };
    for (const [id, [name, from, to, volume]] of Object.entries(shots)) {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toMatchObject({ kind: 'take', name });
      expect([seg.in, seg.out, seg.hold]).toEqual([from, to, 0]);
      expect(seg.audio).toMatchObject({ src: { kind: 'take', name }, in: from, volume });
      expect(seg.crop).toBeNull();
    }
    // Every on-camera Rigg line is the one continuous take.
    expect(['l1', 'l3', 'l5', 'l6', 'l7'].every((id) => byId(timeline.segments, id).src.kind === 'take')).toBe(true);
  });

  it('holds the device still under each count, pushing in 5%, with its beep as its own sound', () => {
    const lengths = [0.8, 0.55, 0.5, 0.55, 0.6];
    COUNTS.forEach((id, i) => {
      const seg = byId(timeline.segments, id);
      expect(seg.src).toEqual({ kind: 'file', ref: 'rigg5/device.png', path: `${ROOT}/rigg5/device.png` });
      expect([seg.still, seg.in, seg.out]).toEqual([true, 0, 0]);
      near(seg.end - seg.start, lengths[i]);
      near(seg.hold, lengths[i]);
      // sine=frequency=1950:duration=0.11 (ffmpeg's sine is 1/8 amplitude), then volume=0.35, apad to the shot: the shot's own sound.
      expect(seg.audio).toEqual({
        src: { kind: 'synth', synth: { kind: 'tone', frequency: 1950, gain: 0.125 } }, in: 0, out: 0.11, volume: 0.35,
        fadeIn: 0, fadeOut: 0, start: seg.start, end: Number((seg.start + 0.11).toFixed(6)),
      });
      expect(segmentGainAt(seg, seg.start + 0.05)).toBe(0.35);
      expect(segmentGainAt(seg, seg.start + 0.2)).toBe(0);
      // scale=w='1280*(1+0.05*t/dur)':eval=frame,crop=1280:720: about the middle, t from the shot's start.
      for (const u of [0, 0.25, 0.5, 1]) {
        const z = zoomAt(seg, seg.start + u * lengths[i]);
        expect(z.scale).toBeCloseTo(1 + 0.05 * u, 6);
        expect(z.focus).toEqual({ x: 640, y: 360 });
      }
    });
    expect(timeline.sfx).toEqual([]);
  });

  it('freezes Rigg\'s look for 1.7 s over the stare take\'s own sound from 0', () => {
    const stare = byId(timeline.segments, 'stare');
    expect([stare.in, stare.out]).toEqual([1.6, 3.9]);
    near(stare.hold, 1.7);
    near(stare.end, END);
    // seg("stare", ..., "stare", 0.0, 0.25): atrim=0:4 at 0.25.
    expect(stare.audio).toMatchObject({ src: { name: 'rigg5-stare-t1' }, in: 0, out: 4, volume: 0.25 });
    near(stare.audio?.end ?? 0, END);
    expect(timeline.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('places every line where the script put it', () => {
    const lines: Record<string, [string, string, number, number]> = {
      deadbolt: ['Rigg', 'Deadbolt. Steel frame. Thirty seconds.', 7.68, 10.93],
      wrench: ['Rigg', 'Need a tension wrench.', 10.98, 11.98], // adelay=10980, 1.0 s, over the lock
      paperclip: ['Rigg', "Paperclip'll do.", 12.23, 13.23],
      pins: ['Rigg', 'Hinge pins. Painted shut.', 14.7, 16.65], // adelay=14700, 1.95 s, over the hinge
      lever: ['Rigg', 'If I lever the frame...', 16.68, 17.98],
      onething: ['Rigg', 'Only one thing left.', 19.83, 20.93],
      blow: ['Rigg', "I'll have to blow the hinges.", 21.48, 22.78],
      pull: ['Partner', "Rigg. It's a pull.", 26.48, 29.48],
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      const [speaker, text, start, end] = lines[line.id];
      expect([line.speaker, line.text]).toEqual([speaker, text]);
      near(line.start, start);
      near(line.end, end);
    }
  });

  it('lays the two lines from Rigg\'s take over the inserts, each carrying its own stretch of it, with the script\'s fades', () => {
    const vo: Record<string, [number, number, number]> = { wrench: [3.6, 4.6, 10.98], pins: [6.0, 7.95, 14.7] };
    for (const [id, [from, to, start]] of Object.entries(vo)) {
      const line = byId(timeline.lines, id);
      if (line.audio.kind !== 'file') throw new Error(`${id} carries no sound`);
      expect(line.audio.src).toMatchObject({ kind: 'take', name: 'rigg5-climax-t1' });
      expect([line.audio.in, line.audio.out, line.audio.fadeIn, line.audio.fadeOut, line.audio.layer]).toEqual([from, to, 0.04, 0.06, null]);
      near(line.start, start);
      near(line.end, start + to - from);
      // afade=t=in:d=0.04, afade=t=out:st=(b-a-0.06):d=0.06.
      expect(lineGainAt(line, start + 0.02)).toBeCloseTo(0.5, 6);
      expect(lineGainAt(line, start + 0.5)).toBe(1);
      expect(lineGainAt(line, start + (to - from) - 0.03)).toBeCloseTo(0.5, 6);
    }
    // Rigg's take plays only on camera and in these two lines: no sound effects carry his voice.
    expect(timeline.sfx).toEqual([]);
  });

  it('times the two laid-in lines in Rigg\'s take, inside where they are heard', () => {
    // Before, as segment lines on the inserts, they were timed in the lock's and hinge's own sound, at losses of 2.59 and 3.37.
    const port = loadPort('rigg-take5', PROBED);
    expect(port.stale).toEqual([]);
    const words = JSON.parse(readFileSync(new URL('../../docs/cuts/rigg-take5.words.json', import.meta.url), 'utf8'));
    expect(words.lines.wrench.fingerprint).toMatchObject({ source: 'takes/rigg5-climax-t1.mp4', start: 3.6, end: 4.6 });
    expect(words.lines.pins.fingerprint).toMatchObject({ source: 'takes/rigg5-climax-t1.mp4', start: 6, end: 7.95 });
    for (const id of ['wrench', 'pins']) {
      expect(words.lines[id].loss).toBeLessThan(0.9);
      expect(words.lines[id].words).toHaveLength(4);
      const line = byId(port.timeline.lines, id);
      const [from, to] = speechOf(port.timeline, id);
      expect(from).toBeGreaterThanOrEqual(line.start);
      expect(to).toBeLessThanOrEqual(line.end);
    }
  });

  it('runs the whole mix through the script\'s limiter (alimiter=limit=0.95)', () => {
    expect(timeline.filters).toEqual({ picture: [], mix: [{ kind: 'limiter', limit: 0.95 }] });
  });

  it('records where each take came from', () => {
    expect(timeline.sources['take:rigg5-climax-t1']).toMatchObject({
      step: 'extend', storyboard: 'rigg5-climax', extendedFrom: { kind: 'take', name: 'rigg5-lines-t2' },
    });
    expect(timeline.sources['take:rigg5-lines-t2']?.firstFrame).toMatchObject({ kind: 'file', path: `${ROOT}/rigg5/mcu.png` });
  });

  it('reproduces the theme, the tension cue and the sting from the script', () => {
    const at = PRINTED;
    const C0 = at.c0030;
    const MON = at.lock;
    const CUT = at.turn;
    const slope = Number((0.25 / (CUT - MON)).toFixed(4));
    // [th]: atrim=1.2:(1.2 + C0 + 0.4), volume=0.4, afade out from C0 - 0.1 over 0.5 s.
    const theme = (t: number): number => (t >= C0 + 0.4 ? 0 : 0.4 * (t > C0 - 0.1 ? (C0 + 0.4 - t) / 0.5 : 1));
    // [tn]: from C0, 0.18 until the montage, then 0.22 rising by `slope`; a 0.04 s fade out to the cut.
    const tension = (t: number): number => {
      if (t < C0 || t >= CUT) return 0;
      const u = t - C0;
      const v = u < MON - C0 ? 0.18 : 0.22 + (u - (MON - C0)) * slope;
      return u > CUT - C0 - 0.04 ? (v * (CUT - C0 - u)) / 0.04 : v;
    };
    // [st]: from STING to the end, 0.45, faded out over the last 0.9 s.
    const sting = (t: number): number => (t < STING || t >= END ? 0 : 0.45 * (t > END - 0.9 ? (END - t) / 0.9 : 1));

    const th = byId(timeline.music, 'theme');
    const tn = byId(timeline.music, 'tension');
    const st = byId(timeline.music, 'sting');
    expect(timeline.music.map((m) => m.id)).toEqual(['theme', 'tension', 'sting']);
    expect([th.start, th.end, th.in, th.out]).toEqual([0, 4.98, 1.2, 6.18]);
    expect([tn.start, tn.end, tn.in, tn.out]).toEqual([4.58, 24.43, 1.1, 20.95]);
    // TOFF = 7.45 - (MON - C0): the cue's first big hit, 7.45 s into the file, lands on the first montage cut.
    expect(tn.sync).toEqual({ source: 7.45, at: MON });
    near(tn.start + (7.45 - tn.in), MON);
    expect([st.start, st.end, st.in, st.out]).toEqual([STING, END, 1.2, 3.05]);
    expect(th.src).toMatchObject({ path: `${ROOT}/audio/rigg5-theme.mp3` });
    expect(st.src).toMatchObject({ path: `${ROOT}/audio/rigg5-theme.mp3` });
    expect(tn.src).toMatchObject({ path: `${ROOT}/audio/rigg5-tension.mp3` });

    let worst = 0;
    for (let t = 0; t < END; t += 0.005) {
      // Skip the instant the cue steps up at the montage, where "just before" and "at" differ by definition.
      if (Math.abs(t - MON) < 0.0026) continue;
      worst = Math.max(worst, Math.abs(gainAt(th, t) - theme(t)), Math.abs(gainAt(tn, t) - tension(t)), Math.abs(gainAt(st, t) - sting(t)));
    }
    expect(worst).toBeLessThan(0.001);
    // Silence through the door and her line: no music from the turn until the sting.
    for (let t = CUT; t < STING; t += 0.01) expect(timeline.music.every((m) => gainAt(m, t) === 0)).toBe(true);
  });

  it('puts the title and glint over Rigg\'s look', () => {
    const title = byId(timeline.overlays, 'title');
    // enable=between(t,1.85,4.54), alpha fade in from 1.85 and out from 4.24, 0.3 s each.
    expect([title.start, title.end, title.fadeIn, title.fadeOut]).toEqual([1.85, 4.54, 0.3, 0.3]);
    expect(title.src).toMatchObject({ path: `${ROOT}/rigg5/title.png` });
    expect(opacityAt(title, 1.85 + 0.15)).toBeCloseTo(0.5, 6);
    expect(opacityAt(title, 4.24 + 0.15)).toBeCloseTo(0.5, 6);
    const glint = byId(timeline.overlays, 'glint');
    expect([glint.start, glint.end]).toEqual([2.45, 3.05]);
    // The script's x = -330 + (t - G) * 1100, y = 0.
    for (const dt of [0, 0.15, 0.3, 0.6]) {
      const p = positionAt(glint, glint.start + dt);
      expect(p.x).toBeCloseTo(-330 + dt * 1100, 6);
      expect(p.y).toBe(0);
    }
  });

  it('draws our digits into each countdown shot, so they push in with it', () => {
    for (const id of COUNTS) {
      const digits = byId(timeline.overlays, `d${id.slice(1)}`);
      const seg = byId(timeline.segments, id);
      expect([digits.start, digits.end, digits.segment]).toEqual([seg.start, seg.end, id]);
      expect(digits.src).toMatchObject({ path: `${ROOT}/rigg5/d${id.slice(1)}.png` });
      expect(digits.motion).toEqual([{ t: seg.start, x: 0, y: 0 }]);
    }
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([21, 8, 3, 0, 7]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
