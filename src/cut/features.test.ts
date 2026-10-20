import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alignCutWords } from './align.js';
import {
  CUT_FORMAT,
  SNAP_METHOD,
  bedPartGainAt,
  cutSourceRefs,
  extendCut,
  framesIn,
  gainAt,
  lineGainAt,
  lineWindow,
  opacityAt,
  overlayShownAt,
  parseCut,
  parseCutExtension,
  parseTimeRef,
  resolveCut,
  resolveCutJson,
  segmentGainAt,
  type Aligner,
  type AlignerAudio,
  type Alignment,
  type CutErrorCode,
  type CutFile,
  type LineWindow,
  type OnsetMeasurement,
  type ResolvedSource,
  type Timeline,
} from './index.js';

/** The format's second round of features, each against a small cut. */

type Json = Record<string, unknown>;

function cutJson(patch: Json = {}): Json {
  return {
    format: CUT_FORMAT,
    meta: { title: 'T', fps: 24, width: 1280, height: 720 },
    media: { root: '/media' },
    segments: [
      { id: 'a', src: 'take:a', in: 0, out: 2 },
      { id: 'b', src: 'take:b', in: 1, out: 3 },
    ],
    ...patch,
  };
}

function resolve(patch: Json = {}, mediaLength?: (src: ResolvedSource) => number | undefined): Timeline {
  const result = resolveCutJson(cutJson(patch), { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function codes(patch: Json): CutErrorCode[] {
  const result = resolveCutJson(cutJson(patch));
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
}

describe('a still image as a segment', () => {
  it('holds the picture for its duration, or to its end anchor, with no sound of its own', () => {
    const t = resolve({
      segments: [
        { id: 'card', src: 'gfx/card.png', still: true, duration: 0.8 },
        { id: 'shot', src: 'take:a', in: 0.5, out: 2.5 },
        { id: 'keys', src: 'gfx/keys.png', still: true, end: 'shot.end+1.25' },
      ],
    });
    const card = byId(t.segments, 'card');
    expect(card).toMatchObject({ still: true, start: 0, end: 0.8, in: 0, out: 0, hold: 0.8, audio: null, loop: null });
    expect(card.src).toEqual({ kind: 'file', ref: 'gfx/card.png', path: '/media/gfx/card.png' });
    expect(byId(t.segments, 'shot')).toMatchObject({ still: false, start: 0.8, end: 2.8 });
    expect(byId(t.segments, 'keys')).toMatchObject({ still: true, start: 2.8, end: 4.05, hold: 1.25 });
  });

  it('needs a length, and takes no in, out, hold or loop', () => {
    expect(codes({ segments: [{ id: 'c', src: 'c.png', still: true }] })).toEqual(['unknown-length']);
    expect(codes({ segments: [{ id: 'c', src: 'c.png', still: true, duration: 1, end: 'c+2' }] })).toContain('conflicting-fields');
    const parsed = parseCut(cutJson({ segments: [{ id: 'c', src: 'c.png', still: true, in: 0, out: 0, hold: 1 }] }));
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.code)).toEqual(['conflicting-fields']);
  });

  it('has no sound unless it is given a src or a synth', () => {
    expect(codes({ segments: [{ id: 'c', src: 'c.png', still: true, duration: 1, audio: { volume: 0.5 } }] })).toEqual(['bad-shape']);
    const t = resolve({ segments: [{ id: 'c', src: 'c.png', still: true, duration: 1, audio: { src: 'take:room', in: 2 } }] });
    expect(byId(t.segments, 'c').audio).toMatchObject({ src: { kind: 'take', name: 'room' }, in: 2, out: 3, start: 0, end: 1 });
  });
});

describe('a generated sound as a segment\'s audio', () => {
  // RIGG's countdown beep: sine=frequency=1950:duration=0.11 (ffmpeg's sine is 1/8 amplitude), then volume=0.35.
  const beep = { synth: { kind: 'tone', frequency: 1950, gain: 0.125 }, out: 0.11, volume: 0.35 };

  it('plays a tone from the segment\'s start, for its out, at its volume', () => {
    const t = resolve({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 2 }, { id: 'count', src: 'rigg5/device.png', still: true, duration: 0.8, audio: beep }] });
    const count = byId(t.segments, 'count');
    expect(count.audio).toEqual({ src: { kind: 'synth', synth: { kind: 'tone', frequency: 1950, gain: 0.125 } }, in: 0, out: 0.11, volume: 0.35, fadeIn: 0, fadeOut: 0, start: 2, end: 2.11 });
    expect(segmentGainAt(count, 2.05)).toBe(0.35);
    expect(segmentGainAt(count, 2.2)).toBe(0);
  });

  it('runs for the whole segment without an out, and takes a src or a synth, not both', () => {
    const t = resolve({ segments: [{ id: 'a', src: 'take:a', in: 1, out: 2, audio: { synth: { kind: 'tone', frequency: 440, gain: 0.1 } } }] });
    expect(byId(t.segments, 'a').audio).toMatchObject({ in: 0, out: 1, start: 0, end: 1 });
    expect(codes({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, audio: { src: 'take:x', synth: { kind: 'tone', frequency: 440, gain: 0.1 } } }] })).toEqual(['conflicting-fields']);
    expect(codes({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1, audio: { synth: { kind: 'tone', frequency: 440, gain: 2 } } }] })).toEqual(['bad-value']);
  });
});

describe('music placed by a sync point', () => {
  // RIGG Take 5: the tension cue from the 00:30 count (4.58 s), its big hit (7.45 s in the file) on the first montage cut (10.93 s).
  const segments = [
    { id: 'open', src: 'take:a', in: 0, out: 4.58 },
    { id: 'c0030', src: 'device.png', still: true, duration: 6.35 },
    { id: 'lock', src: 'take:b', in: 0, out: 2 },
  ];

  it('works out the in-point from the clip\'s at', () => {
    const t = resolve({ segments, music: [{ id: 'tension', src: 'audio/tension.mp3', at: 'c0030', until: 'lock.end', sync: { source: 7.45, at: 'lock' } }] });
    const tension = byId(t.music, 'tension');
    expect([tension.start, tension.in, tension.end]).toEqual([4.58, 1.1, 12.93]);
    expect(tension.sync).toEqual({ source: 7.45, at: 10.93 });
    // Moving the montage keeps the hit on its cut.
    const longer = resolve({ segments: [segments[0], { ...segments[1], duration: 7 }, segments[2]], music: [{ id: 'tension', src: 'audio/tension.mp3', at: 'c0030', until: 'lock.end', sync: { source: 7.45, at: 'lock' } }] });
    expect(byId(longer.music, 'tension').in).toBe(0.45);
  });

  it('works out where the clip starts from its in', () => {
    const t = resolve({ segments, music: [{ id: 'hit', src: 'audio/tension.mp3', in: 6, until: 'lock.end', sync: { source: 7.45, at: 'lock' } }] });
    expect([byId(t.music, 'hit').start, byId(t.music, 'hit').in]).toEqual([9.48, 6]);
  });

  it('can\'t start the file before its beginning, and needs an at or an in', () => {
    expect(codes({ segments, music: [{ id: 'm', src: 'm.mp3', at: 0, until: 'lock', sync: { source: 1, at: 'lock' } }] })).toEqual(['negative-in']);
    const parsed = parseCut(cutJson({ music: [{ id: 'm', src: 'm.mp3', duration: 2, sync: { source: 1, at: 'b' } }] }));
    expect(parsed.ok).toBe(false);
    const both = parseCut(cutJson({ music: [{ id: 'm', src: 'm.mp3', at: 0, in: 1, duration: 2, sync: { source: 1, at: 'b' } }] }));
    expect(both.ok ? [] : both.errors.map((e) => e.code)).toEqual(['conflicting-fields']);
  });
});

describe('a segment\'s sound layers, faded together', () => {
  // Big Hal Take 5's pat insert: its own sound, with PERSONALLY! from another take laid in, the mix faded 12 ms at both ends.
  const patch = {
    segments: [
      { id: 'a', src: 'take:a', in: 0, out: 2 },
      { id: 'pat', src: 'take:pat', in: 1.07, out: 2.5, audio: { in: 1.15 }, mix: { fadeIn: 0.012, fadeOut: 0.012 } },
      { id: 'b', src: 'take:b', in: 0, out: 1 },
    ],
    lines: [{ id: 'pers', speaker: 'Hal', text: 'PERSONALLY!', src: 'take:pers', in: 0.55, out: 1.63, at: 'pat', fadeOut: 0.15, layer: 'pat' }],
    sfx: [{ id: 'ring', src: 'take:pat', in: 2.58, out: 3.5, at: 'pat+1', layer: 'pat' }],
  };

  it('fades every layer with the segment\'s mix, and cuts it off at the segment\'s end', () => {
    const t = resolve(patch);
    const pat = byId(t.segments, 'pat');
    expect(pat.mix).toEqual({ fadeIn: 0.012, fadeOut: 0.012 });
    expect(pat.audio).toMatchObject({ fadeIn: 0, fadeOut: 0 });
    // The segment's own sound: 0.5 halfway into the 12 ms fade in, full in the middle, 0.5 6 ms before its end.
    expect(segmentGainAt(pat, 2.006)).toBeCloseTo(0.5, 6);
    expect(segmentGainAt(pat, 2.7)).toBe(1);
    expect(segmentGainAt(pat, 3.43 - 0.006)).toBeCloseTo(0.5, 6);
    const pers = byId(t.lines, 'pers');
    expect(pers.audio).toMatchObject({ kind: 'file', layer: { segment: 'pat', start: 2, end: 3.43, fadeIn: 0.012, fadeOut: 0.012 } });
    expect(lineGainAt(pers, 2.006)).toBeCloseTo(0.5, 6);
    // Its own fade out, 0.93 to 1.08 s into it.
    expect(lineGainAt(pers, 2 + 1.005)).toBeCloseTo(0.5, 6);
    // The ring runs past the pat's end, so it is cut off there, under the mix's fade out.
    const ring = byId(t.sfx, 'ring');
    expect([ring.start, ring.end]).toEqual([3, 3.43]);
    expect(gainAt(ring, 3.43 - 0.006)).toBeCloseTo(0.5, 6);
    expect(gainAt(ring, 3.2)).toBe(1);
  });

  it('must start inside its segment, which must exist', () => {
    expect(codes({ ...patch, sfx: [{ id: 'early', src: 'take:x', in: 0, out: 1, at: 'a', layer: 'pat' }] })).toEqual(['outside-segment']);
    expect(codes({ ...patch, sfx: [{ id: 'nowhere', src: 'take:x', in: 0, out: 1, at: 'a', layer: 'nope' }] })).toEqual(['unknown-segment']);
    expect(codes({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 0.02, mix: { fadeIn: 0.012, fadeOut: 0.012 } }] })).toEqual(['fade-too-long']);
  });
});

describe('a fade timed to an anchor', () => {
  it('reaches silence at its anchor even when the file runs out first', () => {
    // Regulars Take 3's laugh: 5.0 s of file from 1.5 s, faded out over the cut's last 0.9 s, which ends 0.118 s after the file.
    const t = resolve({
      segments: [{ id: 'a', src: 'take:a', in: 0, out: 6.618 }],
      sfx: [{ id: 'laugh', src: 'audio/laugh.mp3', at: 1.5, until: '@end', duration: 5, volume: 0.7, fadeOut: { duration: 0.9, end: '@end' } }],
    });
    const laugh = byId(t.sfx, 'laugh');
    expect([laugh.start, laugh.end, laugh.fadeOut, laugh.fadeOutEnd]).toEqual([1.5, 6.5, 0.9, 6.618]);
    expect(gainAt(laugh, 5.0)).toBe(0.7);
    expect(gainAt(laugh, 6.618 - 0.45)).toBeCloseTo(0.35, 6);
    expect(gainAt(laugh, 6.5 - 1e-9)).toBeCloseTo(0.7 * (0.118 / 0.9), 6);
  });

  it('fades in from an anchor, silent before it, and doesn\'t have to fit in the clip', () => {
    const t = resolve({ music: [{ id: 'm', src: 'm.mp3', at: 0, duration: 3, fadeIn: { duration: 1, start: 'b' } }] });
    const m = byId(t.music, 'm');
    expect([m.fadeIn, m.fadeInStart]).toEqual([1, 2]);
    expect(gainAt(m, 1)).toBe(0);
    expect(gainAt(m, 2.5)).toBeCloseTo(0.5, 6);
    expect(codes({ music: [{ id: 'm', src: 'm.mp3', at: 0, duration: 1, fadeOut: 2 }] })).toEqual(['fade-too-long']);
    expect(codes({ music: [{ id: 'm', src: 'm.mp3', at: 0, duration: 1, fadeOut: { duration: 2, end: 'nope' } }] })).toEqual(['unknown-anchor']);
  });

  it('lets volume keys lie past the clip, as a duck that outlasts it', () => {
    // Breeze Take 4: the announcer duck runs to 2.9 s after the line, past the music's end.
    const t = resolve({
      music: [{ id: 'j', src: 'j.mp3', at: 0, until: 'b', volume: [{ at: 1, value: 0.8 }, { at: 1, value: 0.16 }, { at: 'b+1', value: 0.16 }, { at: 'b+1', value: 0.8 }] }],
    });
    const j = byId(t.music, 'j');
    expect(j.volume.map((k) => k.t)).toEqual([1, 1, 3, 3]);
    expect(gainAt(j, 1.5)).toBe(0.16);
    expect(gainAt(j, 2)).toBe(0);
  });
});

describe('lines heard in a music clip', () => {
  // Breeze Take 4's sung lyrics: the jingle from 1.5 s into its file; "When the day goes wrong," is 4.66–8.4 s in the file.
  const patch = {
    segments: [{ id: 'a', src: 'take:a', in: 0, out: 20 }],
    music: [{ id: 'jingle', src: 'audio/jingle.mp3', in: 1.5, at: 0, until: 'a.end' }],
    lines: [{ id: 'wrong', speaker: 'Jingle', text: 'When the day goes wrong,', clip: 'jingle', in: 4.66, out: 8.4, sung: true,
      words: [{ text: 'When', start: 4.7, end: 5.0 }] }],
  };

  it('follow the clip\'s clock and add no sound', () => {
    const t = resolve(patch);
    const wrong = byId(t.lines, 'wrong');
    expect([wrong.start, wrong.end, wrong.sung]).toEqual([3.16, 6.9, true]);
    expect(wrong.audio).toEqual({ kind: 'clip', clip: 'jingle' });
    expect(wrong.words).toEqual([{ text: 'When', start: 3.2, end: 3.5 }]);
    expect(lineGainAt(wrong, 4)).toBe(0);
    // Moving the jingle moves the lyric with it.
    const moved = resolve({ ...patch, music: [{ id: 'jingle', src: 'audio/jingle.mp3', in: 1.5, at: 1, until: 'a.end' }] });
    expect(byId(moved.lines, 'wrong').start).toBe(4.16);
    // Its words are timed in the clip's file.
    expect(lineWindow(t, wrong, '/media')).toEqual({
      ok: true, window: { lineId: 'wrong', kind: 'clip', path: '/media/audio/jingle.mp3', source: 'audio/jingle.mp3', start: 4.66, end: 8.4, warnings: [] },
    });
  });

  it('span their clip by default, can\'t start outside it, and must name one', () => {
    const t = resolve({ ...patch, lines: [{ id: 'all', speaker: 'J', text: 'La.', clip: 'jingle' }] });
    expect([byId(t.lines, 'all').start, byId(t.lines, 'all').end]).toEqual([0, 20]);
    expect(codes({ ...patch, lines: [{ id: 'early', speaker: 'J', text: 'La.', clip: 'jingle', in: 1 }] })).toContain('outside-clip');
    expect(codes({ ...patch, lines: [{ id: 'x', speaker: 'J', text: 'La.', clip: 'a' }] })).toEqual(['unknown-clip']);
    const parsed = parseCut(cutJson({ ...patch, lines: [{ id: 'x', speaker: 'J', text: 'La.', clip: 'jingle', volume: 0.5 }] }));
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.code)).toEqual(['conflicting-fields']);
  });
});

describe('a bed of several clips with one volume curve', () => {
  // CGL Football's crowd: three passes of its 20 s file, crossfaded over 2 s, from 2.0 s, cut at 42.53 s.
  const crowd = {
    id: 'crowd', at: 2, until: 42.53, fadeIn: 0.5, fadeOut: 1.2,
    parts: [
      { src: 'audio/crowd.mp3', in: 0, out: 20 },
      { src: 'audio/crowd.mp3', in: 0, out: 20, crossfade: 2 },
      { src: 'audio/crowd.mp3', in: 0, out: 20, crossfade: 2 },
    ],
    volume: [{ at: 10, value: 0.13 }, { at: 11, value: 0.091 }],
  };

  it('lays each part where the last ends, less its crossfade, under one curve', () => {
    const t = resolve({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 44 }], sfx: [crowd] });
    const bed = byId(t.sfx, 'crowd');
    expect(bed.src).toEqual({ kind: 'bed', parts: 3 });
    expect([bed.start, bed.end, bed.in, bed.out]).toEqual([2, 42.53, 0, 40.53]);
    expect(bed.parts?.map((p) => [p.start, p.end, p.in, p.out, p.fadeIn, p.fadeOut])).toEqual([
      [2, 22, 0, 20, 0, 2],
      [20, 40, 0, 20, 2, 2],
      [38, 42.53, 0, 4.53, 2, 0],
    ]);
    // Halfway through the first crossfade, each pass is at half; together they make one bed.
    const [p1, p2] = bed.parts ?? [];
    expect(bedPartGainAt(p1, 21)).toBeCloseTo(0.5, 6);
    expect(bedPartGainAt(p2, 21)).toBeCloseTo(0.5, 6);
    expect(gainAt(bed, 10.5)).toBeCloseTo(0.1105, 6);
    expect(gainAt(bed, 30)).toBe(0.091);
  });

  it('runs as long as its parts without an until, probed or given', () => {
    const t = resolve({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 60 }], sfx: [{ id: 'bed', at: 0, parts: [{ src: 'c.mp3' }, { src: 'c.mp3', crossfade: 2 }] }] }, (src) => (src.kind === 'file' ? 20 : undefined));
    expect(byId(t.sfx, 'bed').end).toBe(38);
    expect(codes({ sfx: [{ id: 'bed', at: 0, parts: [{ src: 'c.mp3' }] }] })).toEqual(['unknown-length']);
    expect(codes({ sfx: [{ id: 'bed', at: 0, parts: [{ src: 'c.mp3', duration: 1 }, { src: 'c.mp3', duration: 1, crossfade: 2 }] }] })).toEqual(['fade-too-long']);
  });
});

describe('the whole picture\'s look and the whole mix\'s processing', () => {
  // CGL Football's early-80s tape look and limiter.
  const look = [
    { kind: 'rescale', width: 600, height: 338 },
    { kind: 'chroma-shift', cb: { x: 4 }, cr: { x: -3 } },
    { kind: 'color', saturation: 0.84, contrast: 0.94, gamma: 1.05 },
    { kind: 'color-balance', shadows: { r: 0.03, b: -0.03 } },
    { kind: 'grain', strength: 12, moving: true },
  ];

  it('are typed settings, applied in order', () => {
    const t = resolve({ picture: { filters: look }, mix: { filters: [{ kind: 'limiter', limit: 0.95 }] } });
    expect(t.filters).toEqual({ picture: look as never, mix: [{ kind: 'limiter', limit: 0.95 }] });
    expect(t.picture).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(resolve().filters).toEqual({ picture: [], mix: [] });
  });

  it('check their values', () => {
    const bad = (patch: Json): CutErrorCode[] => {
      const parsed = parseCut(cutJson(patch));
      return parsed.ok ? [] : parsed.errors.map((e) => e.code);
    };
    expect(bad({ picture: { filters: [{ kind: 'blur' }] } })).toEqual(['bad-shape']);
    expect(bad({ picture: { filters: [{ kind: 'grain', strength: 200 }] } })).toEqual(['bad-value']);
    expect(bad({ mix: { filters: [{ kind: 'limiter', limit: 1.5 }] } })).toEqual(['bad-value']);
    // A limiter is for the whole mix, not one clip.
    expect(bad({ music: [{ id: 'm', src: 'm.mp3', at: 0, duration: 1, filters: [{ kind: 'limiter', limit: 0.9 }] }] })).toEqual(['bad-shape']);
  });
});

describe('overlays timed past the cut\'s end', () => {
  it('are cut off at the end, their fade out kept where it was', () => {
    // CGL Football's closing bumper layers are enabled until 2.2 s after the outro starts; the outro is 1.9 s.
    const t = resolve({ overlays: [{ id: 'o', src: 'o.png', at: 'b', until: 'b+2.2', fadeOut: 0.4 }] });
    const o = byId(t.overlays, 'o');
    expect([o.start, o.end, o.fadeOutEnd]).toEqual([2, 4, 4.2]);
    expect(opacityAt(o, 3.95)).toBeCloseTo(0.625, 6);
    expect(codes({ overlays: [{ id: 'late', src: 'o.png', at: 'b.end', duration: 1 }] })).toEqual(['after-end']);
  });
});

describe('sound inside a take, labelled', () => {
  const patch = {
    segments: [
      { id: 'intro', src: 'take:full', in: 0, out: 8 },
      { id: 'kitchen', src: 'take:full', in: 8, out: 18, audio: { volume: 0.9 } },
    ],
    music: [{ id: 'theme', label: 'The theme', segment: 'intro' }],
    sfx: [{ id: 'laugh', label: 'Studio laugh', segment: 'kitchen', at: 'kitchen+7.6', until: '@end' }],
  };

  it('marks a stretch of a segment\'s own sound and adds none', () => {
    const t = resolve(patch);
    const theme = byId(t.music, 'theme');
    expect(theme).toMatchObject({ segment: 'intro', start: 0, end: 8, in: 0, out: 8, src: { kind: 'take', name: 'full' }, parts: null, layer: null });
    expect(gainAt(theme, 4)).toBe(0);
    const laugh = byId(t.sfx, 'laugh');
    expect(laugh).toMatchObject({ segment: 'kitchen', start: 15.6, end: 18, in: 15.6, out: 18, volume: [{ t: 15.6, value: 0.9 }] });
  });

  it('carries no sound of its own, and lies in a segment with sound', () => {
    const parsed = parseCut(cutJson({ ...patch, music: [{ id: 'theme', segment: 'intro', volume: 0.5 }] }));
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.code)).toEqual(['conflicting-fields']);
    expect(codes({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 2, audio: false }], music: [{ id: 'm', segment: 'a' }] })).toEqual(['bad-shape']);
    expect(codes({ ...patch, sfx: [{ id: 'x', segment: 'intro', at: 'kitchen' , until: '@end' }] })).toEqual([]);
    expect(codes({ ...patch, sfx: [{ id: 'x', segment: 'intro', at: 'kitchen+1', until: '@end' }] })).toEqual(['outside-segment']);
  });

  it('can carry a line, timed in the segment\'s audio', () => {
    // Clap-Lite's jingle is sung in the take's own sound.
    const t = resolve({ ...patch, lines: [{ id: 'sung', speaker: 'Jingle', text: 'La la.', clip: 'laugh', sung: true }] });
    const sung = byId(t.lines, 'sung');
    expect([sung.start, sung.end]).toEqual([15.6, 18]);
    expect(lineWindow(t, sung, '/media')).toMatchObject({ ok: true, window: { kind: 'segment', path: '/media/takes/full.mp4', start: 15.6, end: 18 } });
  });
});

describe('frame units', () => {
  it('read "f191" at the cut\'s fps, as a time, an offset or a length', () => {
    expect(parseTimeRef('f191', 24)).toEqual({ kind: 'absolute', seconds: 7.958333 });
    expect(parseTimeRef('stun+f12', 24)).toEqual({ kind: 'anchor', target: 'stun', point: 'start', offset: 0.5 });
    expect(parseTimeRef('f191')).toBeNull();
    expect(parseTimeRef('f19.5', 24)).toBeNull();
    const t = resolve({
      segments: [{ id: 'a', src: 'take:a', in: 'f0', out: 'f191' }, { id: 'b', src: 'take:a', in: 'f191', out: 'f384' }],
      overlays: [{ id: 'o', src: 'o.png', at: 'f12', until: 'b+f24' }, { id: 'p', src: 'p.png', at: 'a', duration: 'f6' }],
    });
    expect(byId(t.segments, 'a')).toMatchObject({ in: 0, out: 7.958333, end: 7.958333 });
    expect(byId(t.segments, 'b')).toMatchObject({ start: 7.958333, in: 7.958333, out: 16 });
    expect([byId(t.overlays, 'o').start, byId(t.overlays, 'o').end]).toEqual([0.5, 8.958333]);
    expect(byId(t.overlays, 'p').end).toBe(0.25);
  });

  it('keep ids from looking like frames', () => {
    expect(codes({ segments: [{ id: 'f12', src: 'take:a', in: 0, out: 1 }] })).toEqual(['bad-id']);
    const parsed = parseCut(cutJson({ segments: [{ id: 'a', src: 'take:a', in: 'f1.5', out: 1 }] }));
    expect(parsed.ok).toBe(false);
  });
});

describe('overlay until includes its last frame', () => {
  it('draws an overlay on the frame at its end, and the helpers agree', () => {
    // Big Hal Take 5's HAND-INSPECTED! runs until the pat starts (14.0 s, frame 336), so ffmpeg's between(t,11.5,14) shows it on frame 336.
    const t = resolve({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 20 }], overlays: [{ id: 'hand', src: 'h.png', at: 11.5, until: 14 }] });
    const hand = byId(t.overlays, 'hand');
    expect(overlayShownAt(hand, 14)).toBe(true);
    expect(opacityAt(hand, 14)).toBe(1);
    expect(overlayShownAt(hand, 14 + 1 / 24)).toBe(false);
    expect(framesIn(hand.start, hand.end, 24)).toEqual({ first: 276, last: 336 });
    expect(framesIn(0.01, 0.02, 24)).toBeNull();
  });
});

describe('provenance on sources', () => {
  const sources = {
    'take:full': { step: 'extend', extendedFrom: 'take:intro', storyboard: 'ch-kitchen', firstFrame: 'stills/k.png' },
    'take:a': { step: 'generate', storyboard: 'ch-a' },
  };

  it('is passed through with its sources resolved', () => {
    const t = resolve({ sources });
    expect(t.sources['take:full']).toEqual({
      step: 'extend',
      extendedFrom: { kind: 'take', ref: 'take:intro', name: 'intro', path: '/media/takes/intro.mp4' },
      swappedFrom: null,
      voice: null,
      storyboard: 'ch-kitchen',
      firstFrame: { kind: 'file', ref: 'stills/k.png', path: '/media/stills/k.png' },
      notes: null,
    });
    expect(t.sources['take:a']).toMatchObject({ step: 'generate', extendedFrom: null, firstFrame: null });
    const parsed = parseCut(cutJson({ sources: { 'take:a': { step: 'dream' } } }));
    expect(parsed.ok).toBe(false);
  });

  it('merges by source in a variant, and lists with the cut\'s sources only when asked', () => {
    const base = parseCut(cutJson({ sources }));
    const ext = parseCutExtension({ format: CUT_FORMAT, extends: 'base', sources: { 'take:a': { step: 'generate', storyboard: 'ch-a2' } } });
    if (!base.ok || !ext.ok) throw new Error('parse');
    const merged = extendCut(base.value, ext.value);
    if (!merged.ok) throw new Error('merge');
    expect(merged.value.sources?.['take:a']).toEqual({ step: 'generate', storyboard: 'ch-a2' });
    expect(merged.value.sources?.['take:full']).toEqual(sources['take:full'] as never);
    expect(cutSourceRefs(merged.value)).toEqual(['take:a', 'take:b']);
    expect(cutSourceRefs(merged.value, { provenance: true })).toEqual(['take:a', 'take:b', 'take:intro', 'stills/k.png']);
  });
});

describe('the sources a cut plays', () => {
  it('include every part of a bed and no sound heard in a segment', () => {
    const parsed = parseCut(cutJson({
      sfx: [{ id: 'bed', at: 0, parts: [{ src: 'c1.mp3', duration: 3 }, { src: 'c2.mp3', duration: 3 }] }],
      music: [{ id: 'm', segment: 'a' }],
      lines: [{ id: 'l', speaker: 'S', text: 'Hi.', src: 'l.wav', at: 0, duration: 1 }],
    }));
    if (!parsed.ok) throw new Error('parse');
    expect(cutSourceRefs(parsed.value)).toEqual(['take:a', 'take:b', 'l.wav', 'c1.mp3', 'c2.mp3']);
  });
});

describe('cut words on sung lines', () => {
  class EvenAligner implements Aligner {
    readonly name = 'even';
    async align(_audio: AlignerAudio, text: string): Promise<Alignment> {
      return { words: text.split(/\s+/).map((t, i) => ({ text: t, start: 0.3 + i * 0.4, end: 0.6 + i * 0.4 })), loss: 1.4 };
    }
  }
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cut-sung-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips the onset snap and the high-loss warning, and marks the words approximate', async () => {
    const cutPath = path.join(dir, 'sung.cut.json');
    const c = cutJson({
      media: { root: 'media' },
      music: [{ id: 'jingle', src: 'audio/jingle.mp3', in: 1.5, at: 0, until: 'b.end' }],
      lines: [
        { id: 'wrong', speaker: 'Jingle', text: 'When the day goes wrong,', clip: 'jingle', in: 2, out: 3.5, sung: true },
        { id: 'said', speaker: 'Rick', text: 'Then we jump it.', segment: 'a' },
      ],
    });
    await writeFile(cutPath, JSON.stringify(c));
    let measured = 0;
    const measureOnset = (): OnsetMeasurement => {
      measured++;
      return { onset: null, floor: -90, threshold: -50, peak: -20 };
    };
    const extract = async (w: LineWindow): Promise<AlignerAudio> => ({ bytes: new TextEncoder().encode(w.source), sampleRate: 16000 });
    const run = () => alignCutWords({ cutPath, aligner: new EvenAligner(), extract, hash: async () => 'h', measureOnset });
    const result = await run();
    const wrong = byId(result.lines.map((l) => ({ ...l })), 'wrong');
    expect(wrong).toMatchObject({ status: 'aligned', approximate: true, loss: 1.4, window: { kind: 'clip', source: 'audio/jingle.mp3', start: 2, end: 3.5 } });
    expect(wrong.warnings).toEqual([]);
    expect(wrong.snap).toBeUndefined();
    // Only the spoken line was measured, and it alone is warned about its loss.
    expect(measured).toBe(1);
    expect(byId(result.lines, 'said').warnings).toEqual(['its loss is high (1.4); check it by ear']);
    const file = JSON.parse(await readFile(path.join(dir, 'sung.words.json'), 'utf8'));
    expect(file.lines.wrong).toMatchObject({ approximate: true, fingerprint: { source: 'audio/jingle.mp3', start: 2, end: 3.5, sha256: 'h' } });
    expect(file.lines.wrong.fingerprint.snap).toBeUndefined();
    expect(file.lines.said.fingerprint.snap).toBe(SNAP_METHOD);
    expect(file.lines.said.approximate).toBeUndefined();
    // On the timeline the sung words follow the jingle: 2.3 s in the file is 0.8 s in.
    expect(byId(result.timeline.lines, 'wrong').words[0]).toEqual({ text: 'When', start: 0.8, end: 1.1 });
    // A second run keeps both.
    expect((await run()).lines.map((l) => l.status)).toEqual(['fresh', 'fresh']);
  });
});

describe('still parses every earlier cut file', () => {
  it('reads a cut made before this round unchanged', () => {
    const c: CutFile = {
      format: CUT_FORMAT, meta: { title: 'T', fps: 24, width: 640, height: 360 }, media: { root: '/m' },
      segments: [{ id: 'a', src: 'take:a', in: 0, out: 1 }],
    };
    const t = resolveCut(c);
    expect(t.ok && t.value.segments[0]).toMatchObject({ still: false, mix: { fadeIn: 0, fadeOut: 0 } });
  });
});
