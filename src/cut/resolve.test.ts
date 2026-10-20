import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CUT_FORMAT,
  gainAt,
  opacityAt,
  parseCut,
  parseTimeRef,
  positionAt,
  resolveCut,
  resolveCutJson,
  waveAt,
  zoomAt,
  type CutErrorCode,
  type CutFile,
  type Timeline,
} from './index.js';


function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}`, import.meta.url), 'utf8'));
}

/** The media root the Night Wagon cuts name. Paths are checked against it; no media is read. */
const ROOT = (loadJson('night-wagon-take9.cut.json') as { media: { root: string } }).media.root;

function resolveExample(name: string): Timeline {
  const result = resolveCutJson(loadJson(name));
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

describe('Night Wagon Take 9', () => {
  const timeline = resolveExample('night-wagon-take9.cut.json');

  it('puts every segment where nw9/edit.mjs printed it', () => {
    const printed: Record<string, number> = {
      hw: 0, pov: 3.2, r1: 4.2, b2: 5.5, r3: 7.05, b4: 7.9, r5: 9.8, b6: 11.05,
      r7: 12, b8: 13.05, yell: 15.2, press: 15.9, halt: 16.4, stun: 19.4, out: 22.7,
    };
    expect(timeline.segments.map((s) => s.id)).toEqual(Object.keys(printed));
    for (const seg of timeline.segments) expect(Math.abs(seg.start - printed[seg.id])).toBeLessThan(0.001);
    expect(Math.abs(timeline.length - 26.3)).toBeLessThan(0.001);
    expect(Math.abs(byId(timeline.music, 'sting').start - 22.2)).toBeLessThan(0.001);
  });

  it('reproduces the theme bed expression from the script', () => {
    const OPEN = 4.2;
    const R5 = 9.8;
    const HALT = 16.4;
    const slope = Number((0.17 / (HALT - R5)).toFixed(4));
    const script = (t: number): number => {
      if (t >= HALT) return 0;
      const v = t < OPEN - 0.5 ? 1 : t < OPEN ? 1 - (t - (OPEN - 0.5)) * 1.64 : t < R5 ? 0.18 : 0.18 + (t - R5) * slope;
      const fadeStart = Number((HALT - 0.12).toFixed(2));
      return t > fadeStart ? (v * (HALT - t)) / 0.12 : v;
    };
    const bed = byId(timeline.music, 'bed');
    let worst = 0;
    for (let t = 0; t < 17; t += 0.005) worst = Math.max(worst, Math.abs(gainAt(bed, t) - script(t)));
    expect(worst).toBeLessThan(0.001);
    expect(bed.end).toBe(16.4);
  });

  it('places the sting, title, glint and fades', () => {
    const sting = byId(timeline.music, 'sting');
    expect([sting.start, sting.end, sting.fadeOut]).toEqual([22.2, 26.3, 0.9]);
    const title = byId(timeline.overlays, 'title');
    expect([title.start, title.end]).toEqual([22.95, 26.3]);
    expect(opacityAt(title, 26.3 - 0.45)).toBeCloseTo(1, 6);
    expect(opacityAt(title, 26.3 - 0.225)).toBeCloseTo(0.5, 6);
    const glint = byId(timeline.overlays, 'glint');
    expect([glint.start, glint.end]).toEqual([23.55, 24.25]);
    // The script's x = -430 + (t - GL) * 1230.
    for (const dt of [0, 0.2, 0.35, 0.7]) expect(positionAt(glint, glint.start + dt).x).toBeCloseTo(-430 + dt * 1230, 6);
    expect(timeline.picture.fadeOut).toBe(0.5);
    expect(byId(timeline.segments, 'out').fadeOut).toBe(0.7);
  });

  it('gives Buddy a TTS line 0.05 s in, cut at his shot, over hum from another take', () => {
    const bridge = byId(timeline.lines, 'bridge');
    expect([bridge.start, bridge.end]).toEqual([5.55, 7.05]);
    expect(bridge.audio).toMatchObject({ kind: 'file', src: { path: `${ROOT}/audio/tts/b2.wav` } });
    const hums = ['b2', 'b4', 'b6', 'b8'].map((id) => byId(timeline.segments, id).audio);
    expect(hums.map((a) => a?.in)).toEqual([0, 1.55, 3.45, 4.4]);
    expect(hums.every((a) => a?.volume === 0.7 && a.src.kind === 'take' && a.src.name === 'nw7-dash-t1')).toBe(true);
    const wagon = byId(timeline.lines, 'wagon');
    expect([wagon.start, wagon.end]).toEqual([19.8, 21.7505]);
  });

  it('plays the yell under the button press', () => {
    const press = byId(timeline.segments, 'press');
    expect(press.src).toMatchObject({ kind: 'take', name: 'nw6-button-t1', path: `${ROOT}/takes/nw6-button-t1.mp4` });
    expect(press.audio).toMatchObject({ src: { name: 'nw7-rick-yell-t1' }, in: 2.45, out: 2.95, start: 15.9, end: 16.4 });
    const turbo = byId(timeline.lines, 'turbo');
    expect([turbo.start, turbo.end]).toEqual([15.2, 16.4]);
    expect(turbo.audio).toEqual({ kind: 'segment', segment: 'yell' });
  });

  it('lists every item in one flat timeline, sorted by start', () => {
    expect(timeline.items).toHaveLength(15 + 10 + 2 + 2);
    const starts = timeline.items.map((i) => i.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(timeline.at.wagon).toBe(19.8);
    expect(timeline.output).toBe(`${ROOT}/takes/night-wagon-take9.mp4`);
  });

  it('moves the media with a root override', () => {
    const parsed = parseCut(loadJson('night-wagon-take9.cut.json'));
    if (!parsed.ok) throw new Error('parse failed');
    const moved = resolveCut({ ...parsed.value, media: { ...parsed.value.media, root: 'media/crt' } }, { cutDir: '/work/prod' });
    if (!moved.ok) throw new Error('resolve failed');
    expect(moved.value.segments[0].src).toMatchObject({ path: '/work/prod/media/crt/takes/nw6-highway-t1.mp4' });
    const override = resolveCut(parsed.value, { root: '/srv/crt' });
    if (!override.ok) throw new Error('resolve failed');
    expect(override.value.overlays[0].src).toMatchObject({ path: '/srv/crt/nw6/title.png' });
  });
});

describe('Night Wagon Take 10', () => {
  const timeline = resolveExample('night-wagon-take10.cut.json');

  it('matches the times nw10/edit.mjs computes', () => {
    const expected: Record<string, number> = { halt: 16.4, stun: 19.4, btn: 22.35, haz: 25.05, out: 27.5 };
    for (const [id, t] of Object.entries(expected)) expect(Math.abs(timeline.at[id] - t)).toBeLessThan(0.001);
    expect(Math.abs(timeline.length - 31.1)).toBeLessThan(0.001);
    expect(Math.abs(byId(timeline.music, 'sting').start - 27.0)).toBeLessThan(0.001);
  });

  it('holds the button until the line ends, and loops the edge shot forward and back', () => {
    const btn = byId(timeline.segments, 'btn');
    expect(btn.hold).toBeCloseTo(1.1, 6);
    expect(btn.audio).toMatchObject({ in: 1.4, out: 3.0, volume: 0.3 });
    const haz = byId(timeline.segments, 'haz');
    expect(haz.loop).toBe('pingpong');
    expect(haz.end - haz.start).toBeCloseTo(2.45, 6);
    expect(haz.audio?.end).toBeCloseTo(26.05, 6);
  });

  it('blinks the hazards in step with the tick', () => {
    const hazard = byId(timeline.overlays, 'hazard');
    expect(opacityAt(hazard, 25.05 + 0.1)).toBe(1);
    expect(opacityAt(hazard, 25.05 + 0.5)).toBe(0);
    expect(opacityAt(hazard, 25.05 + 0.75)).toBe(1);
    const tick = byId(timeline.sfx, 'tick');
    expect([tick.start, tick.end]).toEqual([25.05, 27.5]);
    expect(tick.src.kind).toBe('synth');
  });
});

describe('anchors', () => {
  it('parses times and anchors', () => {
    expect(parseTimeRef(3.2)).toEqual({ kind: 'absolute', seconds: 3.2 });
    expect(parseTimeRef('stun')).toEqual({ kind: 'anchor', target: 'stun', point: 'start', offset: 0 });
    expect(parseTimeRef('stun+0.4')).toEqual({ kind: 'anchor', target: 'stun', point: 'start', offset: 0.4 });
    expect(parseTimeRef('out - .5')).toEqual({ kind: 'anchor', target: 'out', point: 'start', offset: -0.5 });
    expect(parseTimeRef('b2.end')).toEqual({ kind: 'anchor', target: 'b2', point: 'end', offset: 0 });
    expect(parseTimeRef('@end-0.45')).toEqual({ kind: 'anchor', target: '@end', point: 'end', offset: -0.45 });
    expect(parseTimeRef('@start')).toEqual({ kind: 'anchor', target: '@start', point: 'start', offset: 0 });
    for (const bad of ['', '3.2', 'stun+', 'stun.middle', '@end.start', 'a+b', 'rick-close', 'x+1+2']) {
      expect(parseTimeRef(bad)).toBeNull();
    }
  });
});

function cut(patch: Partial<CutFile> = {}): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'Test', fps: 24, width: 1280, height: 720 },
    media: { root: '/media' },
    segments: [
      { id: 'a', src: 'take:a-t1', in: 0, out: 2 },
      { id: 'b', src: 'take:b-t1', in: 1, out: 2 },
    ],
    ...patch,
  };
}

function codes(c: CutFile): CutErrorCode[] {
  const result = resolveCut(c);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('resolution rules', () => {
  it('runs segments one after another and anchors to starts or ends', () => {
    const result = resolveCut(
      cut({
        lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'l.wav', at: 'b.end-0.5', duration: 2 }],
        overlays: [{ id: 'o', src: 'o.png', at: 'a+0.25', until: 'l.end' }],
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.at).toMatchObject({ a: 0, b: 2, l: 2.5, o: 0.25 });
    // l ends at 4.5, past the cut's end at 3, so the overlay is cut off there.
    expect(byId(result.value.overlays, 'o')).toMatchObject({ end: 3, fadeOutEnd: 4.5 });
    expect(result.value.length).toBe(3);
  });

  it('places a segment with at, leaving a gap', () => {
    const result = resolveCut(cut({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 2 }, { id: 'b', src: 'take:b', in: 0, out: 1, at: 'a.end+1' }] }));
    if (!result.ok) throw new Error('failed');
    expect([result.value.at.b, result.value.length]).toEqual([3, 4]);
  });

  it('reports an unknown anchor', () => {
    const result = resolveCut(cut({ overlays: [{ id: 'o', src: 'o.png', at: 'nope+1', duration: 1 }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ code: 'unknown-anchor', id: 'o', field: 'at' });
  });

  it('reports a bad anchor', () => {
    expect(codes(cut({ overlays: [{ id: 'o', src: 'o.png', at: 'a + one', duration: 1 }] }))).toEqual(['bad-anchor']);
  });

  it('reports a cycle once, with its path', () => {
    const result = resolveCut(
      cut({
        overlays: [
          { id: 'x', src: 'x.png', at: 'y', duration: 1 },
          { id: 'y', src: 'y.png', at: 'x.end', duration: 1 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toEqual(['cycle']);
    expect(result.errors[0].cycle).toEqual(['x.start', 'y.start', 'x.end', 'x.start']);
  });

  it('finds a cycle through a segment end anchored to a line', () => {
    const c = cut({
      segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, end: 'l.end' }],
      lines: [{ id: 'l', speaker: 'S', text: 'Hi.', segment: 'a' }],
    });
    expect(codes(c)).toEqual(['cycle']);
  });

  it('reports out before in', () => {
    expect(codes(cut({ segments: [{ id: 'a', src: 'take:a', in: 2, out: 1 }] }))).toContain('out-before-in');
  });

  it('reports a negative length', () => {
    expect(codes(cut({ overlays: [{ id: 'o', src: 'o.png', at: 'b', until: 'a' }] }))).toEqual(['negative-length']);
    expect(codes(cut({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, end: '@start' }] }))).toContain('negative-length');
  });

  it('reports a hold that would be negative', () => {
    expect(codes(cut({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 2, end: 1 }] }))).toEqual(['negative-hold']);
  });

  it('reports overlapping segments', () => {
    expect(codes(cut({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 2 }, { id: 'b', src: 'take:b', in: 0, out: 1, at: 1 }] }))).toEqual(['overlap']);
  });

  it('reports other mistakes', () => {
    expect(codes(cut({ overlays: [{ id: 'a', src: 'o.png', at: 0, duration: 1 }] }))).toEqual(['duplicate-id']);
    expect(codes(cut({ overlays: [{ id: 'bad-id', src: 'o.png', at: 0, duration: 1 }] }))).toEqual(['bad-id']);
    expect(codes(cut({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, loop: 'pingpong' }] }))).toEqual(['loop-needs-length']);
    expect(codes(cut({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', segment: 'zzz' }] }))).toEqual(['unknown-segment']);
    expect(codes(cut({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'l.wav', at: 0 }] }))).toEqual(['unknown-length']);
    expect(codes(cut({ meta: { title: 'T', fps: 24, width: 1, height: 1, length: 5 } }))).toEqual(['length-mismatch']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'o.png', at: 'a-1', duration: 1 }] }))).toEqual(['before-start']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'o.png', at: 0, duration: 1, fadeIn: 0.6, fadeOut: 0.6 }] }))).toEqual(['fade-too-long']);
    expect(
      codes(cut({ music: [{ id: 'm', src: 'm.mp3', at: 0, until: '@end', volume: [{ at: 'b', value: 1 }, { at: 'a', value: 0 }] }] })),
    ).toEqual(['keyframes-unordered']);
    expect(codes(cut({ segments: [] }))).toEqual(['no-segments']);
  });

  it('uses a probe for media lengths and checks out points against it', () => {
    const c = cut({ music: [{ id: 'm', src: 'm.mp3', at: 'b' }] });
    const probe = (): number => 1.5;
    const result = resolveCut(c, { mediaLength: probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(new Set(result.errors.map((e) => e.code))).toEqual(new Set(['out-past-media']));
    const ok = resolveCut(c, { mediaLength: (s) => (s.kind === 'file' ? 1.5 : 10) });
    if (!ok.ok) throw new Error(JSON.stringify(ok.errors));
    expect(byId(ok.value.music, 'm').end).toBe(3.5);
  });

  it('maps word timings onto the timeline', () => {
    const result = resolveCut(
      cut({
        lines: [
          { id: 'tts', speaker: 'S', text: 'One two.', src: 'l.wav', at: 'b+0.05', duration: 1, words: [{ text: 'One', start: 0.1, end: 0.4 }, { text: 'two.', start: 0.5, end: 0.9 }] },
          { id: 'cam', speaker: 'R', text: 'Go.', segment: 'b', words: [{ text: 'Go.', start: 1.2, end: 1.5 }, { text: 'cut', start: 2.5, end: 2.7 }] },
        ],
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(byId(result.value.lines, 'tts').words).toEqual([{ text: 'One', start: 2.15, end: 2.45 }, { text: 'two.', start: 2.55, end: 2.95 }]);
    // Segment b starts at 2 and plays its take from 1, so take time 1.2 is 2.2; 2.5 is past the segment.
    expect(byId(result.value.lines, 'cam').words).toEqual([{ text: 'Go.', start: 2.2, end: 2.5 }]);
  });
});

describe('parseCut', () => {
  it('reports wrong shapes with their paths', () => {
    const result = parseCut({ format: 'nope', meta: { title: 1 }, media: {}, segments: [{ id: 'a', in: 'x' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['format', 'meta.title', 'meta.fps', 'media.root', 'segments[0].src', 'segments[0].in', 'segments[0].out']));
  });

  it('needs exactly one of src or segment on a line', () => {
    const json = { ...cut(), lines: [{ id: 'l', speaker: 'S', text: 'Hi.', at: 0 }] };
    const result = parseCut(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('conflicting-fields');
  });
});

function resolved(c: CutFile, options?: Parameters<typeof resolveCut>[1]): Timeline {
  const result = resolveCut(c, options);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

/** The parse errors for one item patched into the small test cut, as [code, field] pairs. */
function parseErrors(patch: Record<string, unknown>): Array<[string, string | undefined]> {
  const result = parseCut({ ...cut(), ...patch });
  return result.ok ? [] : result.errors.map((e) => [e.code, e.field]);
}

describe('zoom on a segment', () => {
  it('scales about the middle by default, between keys in the segment\'s clock', () => {
    // Segment b runs 2–3. Keys: 1 at its start, 1.1 at its end.
    const c = cut();
    c.segments[1] = { ...c.segments[1], zoom: { keys: [{ at: 0, scale: 1 }, { at: 'b.end', scale: 1.1 }] } };
    const b = byId(resolved(c).segments, 'b');
    expect(b.zoom).toEqual({ focus: { x: 640, y: 360 }, keys: [{ t: 2, value: 1 }, { t: 3, value: 1.1 }] });
    expect(zoomAt(b, 2.5).scale).toBeCloseTo(1.05, 9);
    expect(zoomAt(b, 1)).toEqual({ scale: 1, focus: { x: 640, y: 360 } });
    expect(zoomAt(b, 9).scale).toBeCloseTo(1.1, 9);
    expect(zoomAt(byId(resolved(c).segments, 'a'), 1)).toEqual({ scale: 1, focus: null });
  });

  it('keeps a focus given in pixels or as fractions of the picture', () => {
    const c = cut();
    c.segments[0] = { ...c.segments[0], zoom: { focus: { x: 872, y: 243 }, keys: [{ at: 0.4, scale: 1 }, { at: 2, scale: 1.2 }] } };
    c.segments[1] = { ...c.segments[1], zoom: { focus: { x: 0.25, y: 0.75, unit: 'fraction' }, keys: [{ at: 0, scale: 1.5 }] } };
    const t = resolved(c);
    expect(byId(t.segments, 'a').zoom?.focus).toEqual({ x: 872, y: 243 });
    expect(zoomAt(byId(t.segments, 'a'), 0.2).scale).toBe(1);
    expect(byId(t.segments, 'b').zoom?.focus).toEqual({ x: 320, y: 540 });
  });

  it('rejects keys outside the segment, out of order, below 1, or a focus off the picture', () => {
    const zoomed = (zoom: unknown): CutFile => {
      const c = cut();
      c.segments[1] = { ...c.segments[1], zoom: zoom as NonNullable<CutFile['segments'][number]['zoom']> };
      return c;
    };
    expect(codes(zoomed({ keys: [{ at: 0, scale: 1 }, { at: 1.5, scale: 1.2 }] }))).toEqual(['outside-segment']);
    expect(codes(zoomed({ keys: [{ at: 'a', scale: 1 }] }))).toEqual(['outside-segment']);
    expect(codes(zoomed({ keys: [{ at: 0.8, scale: 1 }, { at: 0.2, scale: 1.2 }] }))).toEqual(['keyframes-unordered']);
    expect(codes(zoomed({ focus: { x: 2000, y: 0 }, keys: [{ at: 0, scale: 1 }] }))).toEqual(['bad-value']);
    const json = { ...cut(), segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, zoom: { keys: [{ at: 0, scale: 0.5 }] } }] };
    expect(parseErrors(json)).toEqual([['bad-value', 'segments[0].zoom.keys[0].scale']]);
    expect(parseErrors({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, zoom: { keys: [] } }] })).toEqual([['bad-shape', 'segments[0].zoom.keys']]);
    expect(parseErrors({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, zoom: { focus: { x: 2, y: 0.5, unit: 'fraction' }, keys: [{ at: 0, scale: 1 }] } }] }))
      .toEqual([['bad-value', 'segments[0].zoom.focus.x']]);
  });
});

describe('overlays in a segment', () => {
  it('span their segment by default and take times in its clock', () => {
    const t = resolved(
      cut({
        overlays: [
          { id: 'whole', src: 'g.png', segment: 'b' },
          { id: 'part', src: 'g.png', segment: 'b', at: 0.4, until: 0.9, width: 1024, height: 576, motion: [{ at: 0.4, x: 10 }, { at: 0.9, x: 20 }] },
          { id: 'tail', src: 'g.png', segment: 'b', at: 'b+0.5', duration: 0.25 },
          { id: 'over', src: 'g.png', at: 0, until: '@end' },
        ],
      }),
    );
    expect(byId(t.overlays, 'whole')).toMatchObject({ start: 2, end: 3, segment: 'b', width: null, height: null });
    const part = byId(t.overlays, 'part');
    expect(part).toMatchObject({ start: 2.4, end: 2.9, segment: 'b', width: 1024, height: 576 });
    expect(part.motion).toEqual([{ t: 2.4, x: 10, y: 0 }, { t: 2.9, x: 20, y: 0 }]);
    expect(byId(t.overlays, 'tail')).toMatchObject({ start: 2.5, end: 2.75 });
    expect(byId(t.overlays, 'over').segment).toBeNull();
  });

  it('must lie inside its segment, which must exist', () => {
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', segment: 'b', at: 0.5, duration: 1 }] }))).toEqual(['outside-segment']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', segment: 'b', at: 'a' }] }))).toEqual(['outside-segment']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', segment: 'zzz' }] }))).toEqual(['unknown-segment']);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', duration: 1 }] })).toEqual([['bad-shape', 'overlays[0].at']]);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, width: 0 }] })).toEqual([['bad-value', 'overlays[0].width']]);
  });
});

describe('waves', () => {
  it("sweep Night Wagon Take 7's scanner as x = 300 sin(2πt / 1.5)", () => {
    // nw7/edit.mjs: overlay=x='300*sin(2*PI*t/1.5)' over the 1.5 s hook on black.
    const t = resolved(cut({ overlays: [{ id: 'scan', src: 's.png', segment: 'a', wave: { x: { center: 0, amplitude: 300, period: 1.5 } } }] }));
    const scan = byId(t.overlays, 'scan');
    for (let s = 0; s <= 2; s += 0.01) expect(positionAt(scan, s).x).toBeCloseTo(300 * Math.sin((2 * Math.PI * s) / 1.5), 9);
    expect(positionAt(scan, 0.375)).toEqual({ x: 300, y: 0 });
  });

  it("count from the overlay's start over the finished picture, and take a phase and cos", () => {
    const t = resolved(
      cut({
        overlays: [
          { id: 'g', src: 'g.png', at: 1, duration: 1, y: 65, wave: { x: { shape: 'cos', center: 52, amplitude: -250, period: 1 } } },
          { id: 'h', src: 'g.png', segment: 'b', at: 0.4, wave: { x: { center: 360, amplitude: 6, period: 1, phase: 0.52 }, y: { center: -45, amplitude: 0, period: 1 } } },
        ],
      }),
    );
    const g = byId(t.overlays, 'g');
    expect(g.wave.x).toEqual({ shape: 'cos', center: 52, amplitude: -250, period: 1, phase: 0, origin: 1 });
    expect(positionAt(g, 1)).toEqual({ x: -198, y: 65 });
    expect(positionAt(g, 1.5).x).toBeCloseTo(302, 9);
    // In a segment, its clock is the segment's: 2 + 0.52 is the wave's zero crossing.
    const h = byId(t.overlays, 'h');
    expect(h.wave.x?.origin).toBe(2);
    expect(positionAt(h, 2.52).x).toBeCloseTo(360, 9);
    expect(positionAt(h, 2.77).x).toBeCloseTo(366, 9);
    expect(positionAt(h, 2.6).y).toBe(-45);
    expect(waveAt({ shape: 'sin', center: 1, amplitude: 2, period: 4, phase: 0, origin: 10 }, 11)).toBeCloseTo(3, 9);
  });

  it('own their axis: no x or motion x beside a wave on x', () => {
    const wave = { x: { center: 0, amplitude: 1, period: 1 } };
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, x: 5, wave }] }))).toEqual(['conflicting-fields']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, motion: [{ at: 0, x: 1 }], wave }] }))).toEqual(['conflicting-fields']);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, y: 3, motion: [{ at: 0, y: 1 }], wave }] }))).toEqual([]);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, wave: { x: { center: 0, amplitude: 1, period: 0 } } }] }))
      .toEqual([['bad-value', 'overlays[0].wave.x.period']]);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, wave: { x: { center: 0, amplitude: 1, period: 1, shape: 'square' } } }] }))
      .toEqual([['bad-shape', 'overlays[0].wave.x.shape']]);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, wave: { z: {} } }] })).toEqual([['bad-shape', 'overlays[0].wave.z']]);
  });
});

describe('opacity keys', () => {
  it('drop an overlay out with two pairs of jumps, and multiply its fades', () => {
    const t = resolved(
      cut({
        overlays: [
          {
            id: 'o', src: 'g.png', segment: 'a', fadeOut: 0.5,
            opacity: [{ at: 1.04, value: 1 }, { at: 1.04, value: 0 }, { at: 1.1, value: 0 }, { at: 1.1, value: 1 }],
          },
          { id: 'ramp', src: 'g.png', at: 0, duration: 2, opacity: [{ at: 0, value: 0 }, { at: 1, value: 0.5 }] },
          { id: 'half', src: 'g.png', at: 0, duration: 2, opacity: 0.5 },
        ],
      }),
    );
    const o = byId(t.overlays, 'o');
    expect(o.opacity).toEqual([{ t: 1.04, value: 1 }, { t: 1.04, value: 0 }, { t: 1.1, value: 0 }, { t: 1.1, value: 1 }]);
    expect(opacityAt(o, 1.0)).toBe(1);
    expect(opacityAt(o, 1.04)).toBe(0);
    expect(opacityAt(o, 1.07)).toBe(0);
    expect(opacityAt(o, 1.1)).toBe(1);
    expect(opacityAt(o, 1.75)).toBeCloseTo(0.5, 9);
    expect(opacityAt(byId(t.overlays, 'ramp'), 0.5)).toBeCloseTo(0.25, 9);
    expect(opacityAt(byId(t.overlays, 'ramp'), 1.5)).toBe(0.5);
    expect(byId(t.overlays, 'half').opacity).toEqual([{ t: 0, value: 0.5 }]);
    expect(opacityAt(byId(t.overlays, 'half'), 1)).toBe(0.5);
  });

  it('stay between 0 and 1, in order', () => {
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, opacity: 2 }] })).toEqual([['bad-value', 'overlays[0].opacity']]);
    expect(parseErrors({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, opacity: [{ at: 0, value: -1 }] }] }))
      .toEqual([['bad-value', 'overlays[0].opacity[0].value']]);
    expect(codes(cut({ overlays: [{ id: 'o', src: 'g.png', at: 0, duration: 1, opacity: [{ at: 0.5, value: 1 }, { at: 0.2, value: 0 }] }] })))
      .toEqual(['keyframes-unordered']);
  });
});

describe('a line with its own stretch of another take', () => {
  it('plays from its in to its out, and maps its words from the take', () => {
    const t = resolved(
      cut({
        lines: [
          {
            id: 'hello', speaker: 'Rex', text: 'Hello, Victoria.', src: 'take:doors', in: 3, out: 4, at: 'a+1.95',
            words: [{ text: 'Hello,', start: 3.1, end: 3.5 }, { text: 'Victoria.', start: 3.6, end: 4.1 }],
          },
        ],
      }),
    );
    const hello = byId(t.lines, 'hello');
    expect([hello.start, hello.end]).toEqual([1.95, 2.95]);
    expect(hello.audio).toEqual({ kind: 'file', src: { kind: 'take', ref: 'take:doors', name: 'doors', path: '/media/takes/doors.mp4' }, in: 3, out: 4, volume: 1, filters: [],
      fadeIn: 0, fadeOut: 0, fadeInStart: 1.95, fadeOutEnd: 2.95, layer: null });
    // 3.1 s in the take is 0.1 s into the line; the last word is clipped at the line's end.
    expect(hello.words).toEqual([{ text: 'Hello,', start: 2.05, end: 2.45 }, { text: 'Victoria.', start: 2.55, end: 2.95 }]);
  });

  it('runs to the end of its source without an out, and is cut off by until', () => {
    const line = { id: 'l', speaker: 'S', text: 'Hi.', src: 'take:doors', in: 1, at: 0 };
    expect(byId(resolved(cut({ lines: [line] }), { mediaLength: () => 4 }).lines, 'l')).toMatchObject({ start: 0, end: 3, audio: { in: 1, out: 4 } });
    expect(byId(resolved(cut({ lines: [{ ...line, duration: 2.5 }] })).lines, 'l')).toMatchObject({ end: 1.5, audio: { out: 2.5 } });
    expect(byId(resolved(cut({ lines: [{ ...line, out: 3, until: 'a+0.5' }] })).lines, 'l')).toMatchObject({ end: 0.5, audio: { in: 1, out: 1.5 } });
  });

  it('reports an out before its in, or past the media, and keeps in and out off segment lines', () => {
    expect(codes(cut({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'take:x', in: 2, out: 1, at: 0 }] }))).toContain('out-before-in');
    const past = resolveCut(cut({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'take:x', in: 1, out: 6, at: 0 }] }), { mediaLength: () => 4 });
    expect(past.ok ? [] : past.errors.map((e) => e.code)).toContain('out-past-media');
    expect(parseErrors({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', segment: 'a', in: 1 }] })).toEqual([['conflicting-fields', 'lines[0].in']]);
    expect(parseErrors({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'l.wav', at: 0, in: -1 }] })).toEqual([['bad-value', 'lines[0].in']]);
  });
});

describe('audio filters', () => {
  it('resolve on lines and clips in order, with their defaults', () => {
    const t = resolved(
      cut({
        lines: [
          {
            id: 'watch', speaker: 'B', text: 'Rick.', src: 'b4.wav', at: 0, duration: 1, volume: 1.5,
            filters: [{ kind: 'highpass', frequency: 500 }, { kind: 'lowpass', frequency: 3200 }, { kind: 'crush', bits: 10, mix: 0.25 }],
          },
        ],
        sfx: [{ id: 'hey', src: 'hey.wav', at: 0, duration: 0.6, filters: [{ kind: 'echo', inGain: 0.8, outGain: 0.6, delay: 0.06, decay: 0.3 }, { kind: 'crush', bits: 8 }] }],
        music: [{ id: 'm', src: 'm.mp3', at: 0, duration: 1 }],
      }),
    );
    expect(byId(t.lines, 'watch').audio).toMatchObject({
      volume: 1.5,
      filters: [{ kind: 'highpass', frequency: 500 }, { kind: 'lowpass', frequency: 3200 }, { kind: 'crush', bits: 10, mix: 0.25 }],
    });
    expect(byId(t.sfx, 'hey').filters).toEqual([{ kind: 'echo', inGain: 0.8, outGain: 0.6, delay: 0.06, decay: 0.3 }, { kind: 'crush', bits: 8, mix: 1 }]);
    expect(byId(t.music, 'm').filters).toEqual([]);
  });

  it('report unknown kinds and values out of range', () => {
    const line = (filters: unknown[]): Record<string, unknown> => ({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'l.wav', at: 0, duration: 1, filters }] });
    expect(parseErrors(line([{ kind: 'reverb' }]))).toEqual([['bad-shape', 'lines[0].filters[0].kind']]);
    expect(parseErrors(line([{ kind: 'highpass', frequency: 0 }]))).toEqual([['bad-value', 'lines[0].filters[0].frequency']]);
    expect(parseErrors(line([{ kind: 'crush', bits: 80 }]))).toEqual([['bad-value', 'lines[0].filters[0].bits']]);
    expect(parseErrors(line([{ kind: 'echo', inGain: 0.8, outGain: 0.6, delay: 60, decay: 3 }]))).toEqual([['bad-value', 'lines[0].filters[0].decay']]);
    expect(parseErrors(line([{ kind: 'echo', inGain: 0.8, outGain: 0.6, decay: 0.3 }]))).toEqual([['bad-shape', 'lines[0].filters[0].delay']]);
    expect(parseErrors({ lines: [{ id: 'l', speaker: 'S', text: 'Hi.', segment: 'a', filters: [] }] })).toEqual([['conflicting-fields', 'lines[0].filters']]);
  });
});
