import { describe, expect, it } from 'bun:test';
import type { LineMeasure } from '../cut/check.js';
import { DEFAULT_MARGINS, describeLevels, measuredLine, referenceFromLines } from './levels.js';

const lines = [
  { cut: 'docs/cuts/a.cut.json', line: 'one', text: 'One.', loudness: -24, pitch: 200, pitchRange: 8, rate: 3 },
  { cut: 'docs/cuts/a.cut.json', line: 'two', text: 'Two.', loudness: -22, pitch: 220, pitchRange: 10, rate: 2.5 },
  { cut: 'docs/cuts/a.cut.json', line: 'three', text: 'Three.', loudness: -23, pitch: 210, pitchRange: 12, rate: null },
];

describe('reference levels', () => {
  it('span the approved lines, widened by the margins', () => {
    const ref = referenceFromLines(lines, { source: 'approved lines', method: 'dialogue-stem@1', measuredAt: '2026-10-20T00:00:00.000Z' });
    expect(ref.margins).toEqual(DEFAULT_MARGINS);
    expect(ref.levels).toEqual({
      source: 'approved lines',
      loudness: { min: -26.5, max: -19.5 },
      // 3 semitones either side of 200–220 Hz.
      pitch: { min: 168.2, max: 261.6 },
      pitchRange: { max: 15 },
      rate: { min: 2, max: 3.6 },
    });
    expect(ref.typical).toEqual({ loudness: -23, pitch: 210, pitchRange: 10, rate: 2.75 });
    expect(ref.lines).toEqual(lines);
  });

  it('take other margins, and leave out what no line measured', () => {
    const ref = referenceFromLines([{ ...lines[0], pitch: null, pitchRange: null }], { margins: { loudness: 1 }, source: 's', method: 'm', measuredAt: '2026-10-20T00:00:00.000Z' });
    expect(ref.levels).toEqual({ source: 's', loudness: { min: -25, max: -23 }, rate: { min: 2.4, max: 3.6 } });
    expect(ref.typical.pitch).toBeNull();
  });

  it('need at least one line', () => {
    expect(() => referenceFromLines([], { source: 's', method: 'm', measuredAt: 'x' })).toThrow('at least one approved line');
  });

  it('read in words', () => {
    expect(describeLevels({ loudness: { min: -26.5, max: -19.5 }, pitch: { min: 168.2, max: 261.6 }, pitchRange: { max: 15 }, rate: { min: 2, max: 3.6 } }))
      .toBe('-26.5 to -19.5 LUFS, 168 to 262 Hz, pitch range up to 15.0 st, 2.00 to 3.60 words/s');
  });

  it('record a measured line with its cut', () => {
    const m = { id: 'howdy', text: 'Howdy folks.', loudness: -24.5, pitch: { median: 249.7, low: 1, high: 2, range: 9.9, voiced: 0.7 }, rate: { words: 3.1, syllables: 4 } } as unknown as LineMeasure;
    expect(measuredLine('docs/cuts/big-hal-take6.cut.json', m)).toEqual({ cut: 'docs/cuts/big-hal-take6.cut.json', line: 'howdy', text: 'Howdy folks.', loudness: -24.5, pitch: 249.7, pitchRange: 9.9, rate: 3.1 });
  });
});
