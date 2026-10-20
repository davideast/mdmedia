import { describe, expect, it } from 'bun:test';
import {
  CUT_FORMAT,
  WORDS_FORMAT,
  applyWords,
  lineWindow,
  parseCut,
  resolveCut,
  type CutFile,
  type Timeline,
  type WordsFile,
} from './index.js';

/**
 * `asset:<id>` sources: media stored somewhere else (a Studio media asset).
 * The resolver passes them through as opaque sources; word timings keyed by
 * the same ref still apply, and are checked against the asset's hash.
 */

function cut(overrides: Partial<CutFile> = {}): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'T', fps: 24, width: 640, height: 360 },
    media: { root: '/media' },
    segments: [
      { id: 'open', src: 'asset:road01', in: 0, out: 2 },
      { id: 'yell', src: 'asset:yell01', in: 1.75, out: 2.45 },
      { id: 'press', src: 'asset:button01', in: 0.85, out: 1.35, audio: { src: 'asset:yell01', in: 2.45 } },
    ],
    lines: [
      { id: 'tts', speaker: 'Buddy', text: 'The bridge is out.', src: 'asset:tts01', at: 0.5, duration: 1.2 },
      { id: 'turbo', speaker: 'Rick', text: 'TURBO... BOOST!', segment: 'yell', until: 'press.end' },
    ],
    overlays: [{ id: 'logo', src: 'asset:logo01', at: 0, until: 1 }],
    ...overrides,
  };
}

function timelineOf(c: CutFile): Timeline {
  const resolved = resolveCut(c);
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  return resolved.value;
}

describe('asset sources', () => {
  it('parse in every place a source goes', () => {
    const parsed = parseCut(JSON.parse(JSON.stringify(cut())));
    expect(parsed.ok).toBe(true);
  });

  it('need an asset id after the prefix', () => {
    for (const src of ['asset:', 'asset:a b', 'asset:../x']) {
      const parsed = parseCut({ ...cut(), segments: [{ id: 'open', src, in: 0, out: 1 }] });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors[0]).toMatchObject({ code: 'bad-value', field: 'segments[0].src' });
    }
  });

  it('resolve as opaque sources, with no path under the root', () => {
    const timeline = timelineOf(cut());
    expect(timeline.segments[0].src).toEqual({ kind: 'asset', ref: 'asset:road01', id: 'road01' });
    expect(timeline.segments[2].audio?.src).toEqual({ kind: 'asset', ref: 'asset:yell01', id: 'yell01' });
    expect(timeline.overlays[0].src).toMatchObject({ kind: 'asset', id: 'logo01' });
    expect(timeline.lines[0].audio).toMatchObject({ kind: 'file', src: { kind: 'asset', id: 'tts01' } });
  });

  it('are probed for their length like files', () => {
    const resolved = resolveCut(cut(), { mediaLength: (src) => (src.kind === 'asset' && src.id === 'road01' ? 1.5 : undefined) });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.errors[0]).toMatchObject({ code: 'out-past-media', id: 'open' });
  });

  it('give line windows keyed by the asset ref', () => {
    const timeline = timelineOf(cut());
    const tts = lineWindow(timeline, timeline.lines[0], '/media');
    expect(tts).toMatchObject({ ok: true, window: { path: 'asset:tts01', source: 'asset:tts01', start: 0, end: 1.2 } });
    // The yell runs on into the press, which plays the same asset in step.
    const turbo = lineWindow(timeline, timeline.lines[1], '/media');
    expect(turbo).toMatchObject({ ok: true, window: { source: 'asset:yell01', start: 1.75, end: 2.95, warnings: [] } });
  });

  it('take word timings whose fingerprints name the asset, checked by its hash', () => {
    const words: WordsFile = {
      format: WORDS_FORMAT,
      lines: {
        tts: {
          text: 'The bridge is out.', aligner: 'elevenlabs', loss: null,
          fingerprint: { source: 'asset:tts01', start: 0, end: 1.2, sha256: 'aa' },
          words: [{ text: 'The', start: 0.1, end: 0.2 }],
        },
      },
    };
    const fresh = applyWords(cut(), words, { sha256: (ref) => (ref === 'asset:tts01' ? 'aa' : undefined) });
    expect(fresh.applied).toEqual(['tts']);
    expect(fresh.unchecked).toEqual([]);
    expect(timelineOf(fresh.cut).lines[0].words).toEqual([{ text: 'The', start: 0.6, end: 0.7 }]);
    const changed = applyWords(cut(), words, { sha256: () => 'bb' });
    expect(changed.stale).toEqual([{ id: 'tts', reason: 'asset:tts01 changed' }]);
  });
});
