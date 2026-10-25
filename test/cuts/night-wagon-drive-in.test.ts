import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { gainAt, opacityAt, positionAt, resolveCutJson, zoomAt, type Timeline } from '../../src/cut/index';

/**
 * Night Wagon Episode 2, "Drive-In", ported from nwdi/edit.mjs. The expected
 * times are what a copy of that script printed with its ffmpeg call stubbed
 * out (`console.log(JSON.stringify({ at, END }))`), so nothing was re-rendered.
 */

const cut: unknown = JSON.parse(readFileSync(new URL('../../docs/cuts/night-wagon-drive-in.cut.json', import.meta.url), 'utf8'));
const ROOT = (cut as { media: { root: string } }).media.root;

/** The segment starts nwdi/edit.mjs printed, in its order. */
const PRINTED: Record<string, number> = {
  open: 0, r1: 2.4, grille: 3.85, b1: 5.25, r2: 6.55, b2: 9.65, b3: 12.75, rows: 14.85, good: 16.45,
  sneak: 18.25, suit: 19.2, grab: 20.65, run: 22.4, lost: 24, handle: 26.2, wc: 26.9, fam: 29.45,
  watch: 31.2, rw: 32.15, tag: 34.25, out: 35.85,
};
const END = 38.65;

function resolve(): Timeline {
  const result = resolveCutJson(cut);
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

const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

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

describe('Night Wagon Episode 2, Drive-In', () => {
  const timeline = resolve();

  it('puts every segment where nwdi/edit.mjs started it, and adds up to its length', () => {
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(PRINTED));
    for (const seg of timeline.segments) near(seg.start, PRINTED[seg.id]);
    near(timeline.length, END);
  });

  it('matches the rendered take to within a frame', () => {
    const file = `${ROOT}/takes/night-wagon-drive-in-t1.mp4`;
    expect(timeline.output).toBe(file);
    if (!existsSync(file)) return; // The media isn't on this machine.
    // The script renders with -t 38.65 at 24 fps, which ffmpeg rounds up to a whole frame (928 frames).
    expect(Math.abs(videoTrackSeconds(file) - END)).toBeLessThanOrEqual(1 / 24 + 1e-6);
  });

  it('cuts each shot from its take, with its own or borrowed sound', () => {
    const grille = byId(timeline.segments, 'grille');
    expect(grille.src).toMatchObject({ kind: 'take', name: 'nwdi-grille-t1' });
    expect([grille.in, grille.out]).toEqual([0.6, 2.0]);
    // Rick's "We're undercover." carries on from rick-lines take 2, in step with r1.
    expect(grille.audio).toMatchObject({ src: { name: 'nwdi-rick-lines-t2' }, in: 2.0, volume: 1 });
    const r1 = byId(timeline.segments, 'r1');
    expect(r1.audio?.in).toBe(0.55);
    near(r1.audio!.in + (grille.start - r1.start), grille.audio!.in);

    // Buddy's dash shots over a quiet hum from nw7-dash-t1, picked up where the last one left off.
    const hums = ['b1', 'b2', 'b3'].map((id) => byId(timeline.segments, id).audio);
    expect(hums.map((a) => a?.in)).toEqual([0, 1.3, 4.4]);
    expect(hums.every((a) => a?.volume === 0.7 && a.src.kind === 'take' && a.src.name === 'nw7-dash-t1')).toBe(true);

    // The family, the watch and Rick at the watch mute their takes and play the movie through the window speaker.
    const movie = ['fam', 'watch', 'rw'].map((id) => byId(timeline.segments, id).audio);
    expect(movie.map((a) => [a?.in, a?.volume])).toEqual([[1.0, 0.7], [2.9, 0.25], [4.05, 0.2]]);
    expect(movie.every((a) => a?.src.kind === 'file' && a.src.path === `${ROOT}/audio/di-movie.mp3`)).toBe(true);

    const volumes = Object.fromEntries(timeline.segments.map((s) => [s.id, s.audio?.volume]));
    expect(volumes).toMatchObject({ open: 0.8, rows: 0.6, sneak: 0.6, suit: 0.6, grab: 0.8, run: 0.7, handle: 0.8, tag: 0.4, out: 0.4 });
    expect(byId(timeline.segments, 'out').fadeOut).toBe(0.7);
  });

  it('places every line where the script put it', () => {
    const lines: Record<string, [number, number]> = {
      kill: [2.4, 5.25], // r1, then on under the grille
      undercover: [5.3, 6.55], // di-b1 0.05 s into b1, cut at its end
      handoff: [6.55, 9.65],
      beige: [9.7, 12.75],
      known: [13.0, 14.85], // after a 0.25 s beat
      approve: [16.45, 18.25],
      hey: [22.52, 23.1237], // off-screen, 0.12 s into the run
      calling: [24, 26.2],
      hitit: [26.9, 29.45],
      overhere: [32.45, 33.9361], // from the watch, 0.3 s into Rick's face
    };
    expect(timeline.lines.map((l) => l.id)).toEqual(Object.keys(lines));
    for (const line of timeline.lines) {
      near(line.start, lines[line.id][0]);
      near(line.end, lines[line.id][1]);
    }
    expect(byId(timeline.lines, 'overhere')).toMatchObject({ speaker: 'Buddy', audio: { kind: 'file', volume: 1.5, src: { path: `${ROOT}/audio/tts/di-b4.wav` } } });
    expect(byId(timeline.lines, 'hey').audio).toMatchObject({ kind: 'file', volume: 0.8 });
  });

  it('reproduces both theme beds from the script', () => {
    const at = PRINTED;
    const DUCK = at.r1;
    const XF = at.rows;
    const JOB = at.sneak;
    const LOST = at.lost;
    const DEAD = at.fam;
    const scriptA = (t: number): number => {
      if (t >= XF + 0.6) return 0;
      const v = t < DUCK - 0.5 ? 1 : t < DUCK ? 1 - (t - (DUCK - 0.5)) * 1.64 : 0.18;
      return t > XF ? (v * (XF + 0.6 - t)) / 0.6 : v;
    };
    const slope = Number((0.4 / (LOST - JOB)).toFixed(4));
    const scriptB = (t: number): number => {
      if (t < XF || t >= DEAD) return 0;
      const u = t - XF;
      const v = u < JOB - XF ? 0.18 : u < LOST - XF ? 0.3 + (u - (JOB - XF)) * slope : 0.42;
      const fadeIn = u < 0.6 ? u / 0.6 : 1;
      const fadeOutStart = Number((DEAD - XF - 0.04).toFixed(3));
      const fadeOut = u > fadeOutStart ? (DEAD - XF - u) / 0.04 : 1;
      return v * fadeIn * fadeOut;
    };
    const bedA = byId(timeline.music, 'bedA');
    const bedB = byId(timeline.music, 'bedB');
    expect([bedA.start, bedA.end, bedA.in]).toEqual([0, 15.45, 0]);
    expect([bedB.start, bedB.end, bedB.in]).toEqual([14.85, 29.45, 6]);
    let worst = 0;
    for (let t = 0; t < END; t += 0.005) {
      // Skip the instants where the script steps, where "just before" and "at" differ by definition.
      if ([JOB, LOST].some((s) => Math.abs(t - s) < 0.0026)) continue;
      worst = Math.max(worst, Math.abs(gainAt(bedA, t) - scriptA(t)), Math.abs(gainAt(bedB, t) - scriptB(t)));
    }
    expect(worst).toBeLessThan(0.001);
    // Dead silence on the family: no music from the family's first frame until the sting.
    for (let t = DEAD; t < at.tag + 0.4; t += 0.01) expect(timeline.music.every((m) => gainAt(m, t) === 0)).toBe(true);
  });

  it('lands the stings and sound effects where the script put them', () => {
    const sting = byId(timeline.music, 'sting');
    expect([sting.start, sting.end, sting.fadeOut]).toEqual([34.65, END, 0.9]);
    const sfx: Record<string, [number, number, number]> = {
      grilleRoom: [3.85, 5.25, 0.5],
      powerdown: [4.75, 5.25, 0.9],
      rowsMovie: [14.85, 16.45, 0.25],
      crackle: [31.25, 32.15, 0.9],
      powerup: [34.6, 35.85, 0.8],
    };
    expect(timeline.sfx.map((s) => s.id)).toEqual(Object.keys(sfx));
    for (const s of timeline.sfx) {
      const [start, end, volume] = sfx[s.id];
      near(s.start, start);
      near(s.end, end);
      expect(s.volume).toEqual([{ t: s.start, value: volume }]);
    }
    expect(byId(timeline.sfx, 'grilleRoom').src).toMatchObject({ kind: 'take', name: 'nwdi-grille-t1' });
    expect(byId(timeline.sfx, 'grilleRoom').in).toBe(0.6);
  });

  it('sweeps the grille glow once, flickers and fades as the script did', () => {
    const glow = byId(timeline.overlays, 'grilleGlow');
    const G = PRINTED.grille;
    expect([glow.start, glow.end]).toEqual([G, G + 1.28]);
    // Drawn into the grille shot, timed in its clock: overlay=x='52-250*cos(2*PI*t/1.0)':y=65.
    expect(glow.segment).toBe('grille');
    expect(glow.motion).toEqual([{ t: G, x: 0, y: 65 }]);
    expect(glow.wave).toEqual({ x: { shape: 'cos', center: 52, amplitude: -250, period: 1, phase: 0, origin: G }, y: null });
    expect(glow.blink).toBeNull();
    const script = (t: number): number => 52 - 250 * Math.cos(2 * Math.PI * t);
    for (const t of [0, 0.25, 0.5, 0.75, 1, 1.25]) expect(positionAt(glow, G + t).x).toBeCloseTo(script(t), 9);
    // Sampled on the shot's frames, and densely between them.
    for (let t = 0; t < 1.28; t += 0.005) {
      const p = positionAt(glow, G + t);
      expect(Math.abs(p.x - script(t))).toBeLessThan(1e-6);
      expect(p.y).toBe(65);
      // enable = lt(t,1.28) * not(between(t,1.04,1.1)); the alpha fades out from 0.98 over 0.3 s.
      if (Math.abs(t - 1.04) < 1e-9 || Math.abs(t - 1.1) < 1e-9) continue; // the jumps themselves
      const shown = !(t >= 1.04 && t <= 1.1);
      const alpha = t < 0.98 ? 1 : 1 - (t - 0.98) / 0.3;
      expect(opacityAt(glow, G + t)).toBeCloseTo(shown ? alpha : 0, 6);
    }
    // The drop-out is a pair of jumps in its opacity keys, from 1.04 s to 1.10 s into the shot.
    expect(glow.opacity.map((k) => [round3(k.t - G), k.value])).toEqual([[1.04, 1], [1.04, 0], [1.1, 0], [1.1, 1]]);
    expect(opacityAt(glow, G + 1.039)).toBeGreaterThan(0);
    expect(opacityAt(glow, G + 1.041)).toBe(0);
    expect(opacityAt(glow, G + 1.099)).toBe(0);
    expect(opacityAt(glow, G + 1.101)).toBeGreaterThan(0);
  });

  it('flicks the tag glow on 0.4 s in, with the sting, drawn small into the shot before its push-in', () => {
    const T = PRINTED.tag;
    const glow = byId(timeline.overlays, 'tagGlow');
    expect([glow.start, glow.end]).toEqual([34.65, 35.85]);
    expect(byId(timeline.music, 'sting').start).toBe(glow.start);
    // [tglow]scale=1024:576, overlaid on the tag shot before the shot's scale-and-crop push-in.
    expect([glow.segment, glow.width, glow.height]).toEqual(['tag', 1024, 576]);
    expect(glow.wave.x).toEqual({ shape: 'sin', center: 360, amplitude: 6, period: 1, phase: 0.52, origin: T });
    // x = 360 + 6 sin(2π(t - 0.52) / 1.0), y = -45; enable = gte(t,0.4) * not(between(t,0.45,0.52)).
    const script = (t: number): number => 360 + 6 * Math.sin(2 * Math.PI * (t - 0.52));
    for (const t of [0.4, 0.52, 0.77, 1.02, 1.27, 1.6]) expect(positionAt(glow, T + t).x).toBeCloseTo(script(t), 9);
    for (let t = 0; t < 1.6; t += 0.005) {
      if ([0.4, 0.45, 0.52].some((edge) => Math.abs(t - edge) < 1e-9)) continue;
      const shown = t >= 0.4 && !(t >= 0.45 && t <= 0.52);
      expect(opacityAt(glow, T + t) > 0).toBe(shown);
      if (shown) {
        expect(opacityAt(glow, T + t)).toBe(1);
        const p = positionAt(glow, T + t);
        expect(Math.abs(p.x - script(t))).toBeLessThan(1e-6);
        expect(p.y).toBe(-45);
      }
    }
    expect(glow.opacity.map((k) => [round3(k.t - T), k.value])).toEqual([[0.45, 1], [0.45, 0], [0.52, 0], [0.52, 1]]);
  });

  it('pushes in on the family and on the tag as the script scaled and cropped them', () => {
    // fam: scale=w='1280*(1+0.035*t/1.75)', crop=1280:720 centred.
    const fam = byId(timeline.segments, 'fam');
    const F = PRINTED.fam;
    expect(fam.zoom?.focus).toEqual({ x: 640, y: 360 });
    for (const t of [0, 0.5, 0.875, 1.2, 1.75]) {
      const z = zoomAt(fam, F + t);
      expect(z.scale).toBeCloseTo(1 + (0.035 * t) / 1.75, 9);
      expect(z.focus).toEqual({ x: 640, y: 360 });
    }
    // tag: scale=w='1280*(1+0.2*max(0,t-0.4)/1.2)', crop x='872*(iw/1280-1)', y='243*(ih/720-1)'.
    const tag = byId(timeline.segments, 'tag');
    const T = PRINTED.tag;
    expect(tag.zoom?.focus).toEqual({ x: 872, y: 243 });
    for (const t of [0, 0.2, 0.4, 0.7, 1.0, 1.3, 1.6]) {
      const z = zoomAt(tag, T + t);
      const scale = 1 + (0.2 * Math.max(0, t - 0.4)) / 1.2;
      expect(z.scale).toBeCloseTo(scale, 9);
      // The script's crop window keeps (872, 243) where it was: x0 = 872 (s - 1), y0 = 243 (s - 1).
      const iw = 1280 * scale;
      const ih = 720 * scale;
      const focus = z.focus ?? { x: 0, y: 0 };
      expect(focus.x * z.scale - 872 * (iw / 1280 - 1)).toBeCloseTo(872, 6);
      expect(focus.y * z.scale - 243 * (ih / 720 - 1)).toBeCloseTo(243, 6);
    }
    // Nothing else zooms.
    expect(timeline.segments.filter((s) => s.zoom).map((s) => s.id)).toEqual(['fam', 'tag']);
    expect(zoomAt(byId(timeline.segments, 'rows'), PRINTED.rows + 1)).toEqual({ scale: 1, focus: null });
  });

  it("puts Buddy through the watch's speaker and an echo on the off-screen Hey", () => {
    // TINNY = highpass=f=500,lowpass=f=3200,acrusher=bits=10:mix=0.25,volume=1.5
    expect(byId(timeline.lines, 'overhere').audio).toMatchObject({
      kind: 'file',
      volume: 1.5,
      filters: [
        { kind: 'highpass', frequency: 500 },
        { kind: 'lowpass', frequency: 3200 },
        { kind: 'crush', bits: 10, mix: 0.25 },
      ],
    });
    // volume=0.8,aecho=0.8:0.6:60:0.3
    expect(byId(timeline.lines, 'hey').audio).toMatchObject({
      kind: 'file',
      volume: 0.8,
      filters: [{ kind: 'echo', inGain: 0.8, outGain: 0.6, delay: 0.06, decay: 0.3 }],
    });
    for (const line of timeline.lines) {
      if (line.audio.kind === 'file' && !['overhere', 'hey'].includes(line.id)) expect(line.audio.filters).toEqual([]);
    }
    expect([...timeline.music, ...timeline.sfx].every((clip) => clip.filters.length === 0)).toBe(true);
  });

  it('puts the title and glint over the outro and fades the picture out', () => {
    const title = byId(timeline.overlays, 'title');
    expect([title.start, title.end, title.fadeIn, title.fadeOut]).toEqual([36.1, END, 0.35, 0.45]);
    const glint = byId(timeline.overlays, 'glint');
    expect([glint.start, glint.end]).toEqual([36.7, 37.4]);
    // The script's x = -430 + (t - GL) * 1230.
    for (const dt of [0, 0.2, 0.35, 0.7]) expect(positionAt(glint, glint.start + dt).x).toBeCloseTo(-430 + dt * 1230, 6);
    expect(timeline.picture.fadeOut).toBe(0.5);
  });

  it('lists every item in one timeline, sorted by start', () => {
    expect([timeline.segments.length, timeline.lines.length, timeline.music.length, timeline.sfx.length, timeline.overlays.length]).toEqual([21, 10, 3, 5, 4]);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
