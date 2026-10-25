import { describe, expect, it } from 'bun:test';
import { LISTENERS, createListener, formatCheckReport } from '../../src/cli/cut-check-command.js';
import { cutCommand } from '../../src/cli/cut-command.js';
import { resolveSmartCliArgv } from '../../src/cli/command.js';
import { CHECK_FORMAT, MEASURE_METHOD, MEASURE_SOURCE, type CheckFile, type LineMeasure } from '../../src/cut/check.js';

function line(id: string, patch: Partial<LineMeasure> = {}): LineMeasure {
  return {
    id, speaker: 'Big Hal', text: id, speech: { start: 1, end: 2 }, timedBy: 'words', words: 3, syllables: 4, loudness: -24.5,
    pitch: { median: 241.3, low: 180, high: 300, range: 8.8, voiced: 0.7 }, rate: { words: 3, syllables: 4 }, wordLevels: [], flags: [], ...patch,
  };
}

const FILE: CheckFile = {
  format: CHECK_FORMAT,
  measured: {
    method: MEASURE_METHOD,
    source: MEASURE_SOURCE,
    range: { from: 0, to: 10 },
    lines: [line('every'), line('personally', { speech: { start: 14.28, end: 14.98 }, loudness: -23.6 }), line('extra', { timedBy: 'line', rate: null, pitch: null, loudness: null })],
    performances: [{
      id: 'inspection',
      lines: ['every', 'personally'],
      thresholds: { loudness: 2.5, pitch: 10, rate: 0.4, pause: 0.6, roomTone: 5, word: 6 },
      boundaries: [{
        from: 'every', to: 'personally', between: [], pause: 0.44,
        before: { words: 'by me!', start: 13.3, end: 13.84, loudness: -26.6, pitch: 190 },
        after: { words: 'PERSONALLY!', start: 14.28, end: 14.98, loudness: -23.6, pitch: 241 },
        loudness: 3, pitch: 4.1, rate: 0.47,
        flags: [{ code: 'loudness-jump', message: '"by me!" → "PERSONALLY!": loudness jumps up 3 LU (over 2.5)' }],
      }],
      cuts: [{ at: 14, from: 'inspect', to: 'pat', before: -50.1, after: -44.4, change: 5.7, wide: false, flags: [{ code: 'room-tone-jump', message: 'room tone rises 5.7 dB' }] }],
      splits: [],
      flags: [
        { code: 'splitting-rule', message: 'splitting rule (separate-generations): two generations' },
        { code: 'loudness-jump', message: '"by me!" → "PERSONALLY!": loudness jumps up 3 LU (over 2.5)' },
      ],
    }],
    fingerprints: { lines: {}, performances: {} },
  },
  listening: {
    inspection: {
      filterOnly: true, listener: 'gemini:gemini-3.8-flash', model: 'gemini-3.8-flash', clip: { from: 9.48, to: 15.48 }, canHearAudio: true,
      fingerprint: { from: 9.48, to: 15.48, sources: {}, digest: 'x' }, heardAt: '2026-10-19T00:00:00.000Z',
      answers: [
        { id: 'inspection.continuous.every.personally', kind: 'continuous', ask: '…', expect: 'yes', verdict: 'one continuous delivery', confidence: 0.95, heard: '', why: '', reading: 'yes', agrees: true, lines: ['every', 'personally'] },
        { id: 'inspection.shouted.personally', kind: 'shouted', ask: '…', expect: 'no', verdict: 'yes', confidence: 0.95, heard: 'PERSONALLY!', why: 'a forceful shout', reading: 'yes', agrees: false, lines: ['personally'] },
      ],
    },
  },
};

describe('mdmedia cut check', () => {
  it('is a subcommand of cut, with storyboard, that the smart router leaves alone', () => {
    expect(resolveSmartCliArgv(['cut', 'check', 'x.cut.json', '--listen'])).toEqual(['cut', 'check', 'x.cut.json', '--listen']);
    const sub = (cutCommand as { subCommands?: Record<string, unknown> }).subCommands ?? {};
    expect(Object.keys(sub)).toEqual(['words', 'render', 'check', 'storyboard']);
  });

  it('listens with Gemini by default, and needs its key', () => {
    expect(LISTENERS).toEqual(['gemini']);
    expect(createListener('gemini', { GEMINI_API_KEY: 'k' }).name).toBe('gemini:gemini-3.8-flash');
    expect(() => createListener('gemini', {})).toThrow('GEMINI_API_KEY');
    expect(() => createListener('ears', { GEMINI_API_KEY: 'k' })).toThrow('--listener must be one of gemini (got "ears").');
  });

  it('prints the lines, the boundaries and cuts, the flags, then the listening check marked filter only', () => {
    const text = formatCheckReport({ file: FILE, listening: { inspection: { status: 'fresh' } }, staleWords: [], hasWordsFile: true });
    expect(text.split('\n')).toEqual([
      `Measured, from ${MEASURE_SOURCE} (dialogue-stem@1).`,
      '',
      'line        speaker  speech (s)   LUFS   pitch Hz  range st  words/s',
      'every       Big Hal  1.00–2.00    -24.5  241       8.8       3.00',
      'personally  Big Hal  14.28–14.98  -23.6  241       8.8       3.00',
      'extra       Big Hal  1.00–2.00*   –      –         –         –',
      '* no word timings: the whole line was measured',
      '',
      'performance  boundary or cut             pause s  Δ LU  Δ pitch st  Δ rate  room tone dB          flags',
      'inspection   every → personally          0.44     +3.0  +4.1        +47 %                         1',
      '             cut inspect → pat at 14.00                                     -50.1 → -44.4 (+5.7)  1',
      '',
      'flag: inspection: splitting rule (separate-generations): two generations',
      'flag: inspection: "by me!" → "PERSONALLY!": loudness jumps up 3 LU (over 2.5)',
      '',
      'Listening check (filter only: it catches obvious failures, it is not the judge), by gemini:gemini-3.8-flash.',
      '',
      'performance        question                     expect  verdict                  conf.  result',
      'inspection (kept)  continuous every personally  yes     one continuous delivery  0.95   ok',
      '                   shouted personally           no      yes                      0.95   FAILS',
      '',
      'note: inspection shouted.personally: heard "PERSONALLY!"; a forceful shout',
    ]);
  });

  it('says when nothing was heard yet, or a result was dropped as stale, and warns about missing words', () => {
    const file = { ...FILE, listening: {} };
    const text = formatCheckReport({ file, listening: { inspection: { status: 'stale', reason: 'take:hal5-pat-t1 changed' } }, staleWords: [{ id: 'every', reason: 'its text changed' }], hasWordsFile: true });
    expect(text).toContain('inspection   (dropped: take:hal5-pat-t1 changed)');
    expect(text).toContain('warning: every: its stored words are stale (its text changed), so it was measured whole');
    const none = formatCheckReport({ file, listening: { inspection: { status: 'none' } }, staleWords: [], hasWordsFile: false });
    expect(none).toContain('inspection   (not heard; run with --listen)');
    expect(none).toContain('warning: the cut has no words file');
  });
});
