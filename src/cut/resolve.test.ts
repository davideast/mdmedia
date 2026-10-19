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
  type CutErrorCode,
  type CutFile,
  type Timeline,
} from './index.js';

const ROOT = '/tmp/claude-1000/-home-david-repos-davideast-satisfy-md/366e8408-4b0c-4005-96b5-3535166ca34f/scratchpad/crt';

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}`, import.meta.url), 'utf8'));
}

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
    expect(byId(result.value.overlays, 'o').end).toBe(4.5);
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
