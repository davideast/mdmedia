import { describe, expect, it } from 'bun:test';
import { ALIGNERS, createAligner, cutMediaRootArg, formatLineReports } from '../../src/cli/cut-command.js';
import { resolveSmartCliArgv } from '../../src/cli/command.js';
import type { LineReport } from '../../src/cut/align.js';

const report = (overrides: Partial<LineReport>): LineReport => ({
  id: 'getaway', speaker: 'Rick', text: "They're getting away, Buddy.", status: 'aligned', loss: 0.716,
  words: 4, textWords: 4, speech: { start: 4.38, end: 5.36 }, window: null, warnings: [], ...overrides,
});

describe('mdmedia cut words', () => {
  it('is a subcommand the smart router leaves alone', () => {
    expect(resolveSmartCliArgv(['cut', 'words', 'x.cut.json'])).toEqual(['cut', 'words', 'x.cut.json']);
  });

  it('accepts only the aligners it has, ElevenLabs by default', () => {
    expect(ALIGNERS).toEqual(['elevenlabs']);
    expect(createAligner('elevenlabs', { ELEVEN_LABS_KEY: 'k' }).name).toBe('elevenlabs');
    expect(() => createAligner('whisper', { ELEVEN_LABS_KEY: 'k' })).toThrow('--aligner must be one of elevenlabs (got "whisper").');
  });

  it("takes the media root from --root, then MDMEDIA_CUT_MEDIA_ROOT, else leaves it to the cut's media.root", () => {
    expect(cutMediaRootArg('/a', { MDMEDIA_CUT_MEDIA_ROOT: '/b' })).toBe('/a');
    expect(cutMediaRootArg(undefined, { MDMEDIA_CUT_MEDIA_ROOT: '/b' })).toBe('/b');
    expect(cutMediaRootArg(undefined, {})).toBeUndefined();
  });

  it('prints a table of lines, then the warnings', () => {
    const text = formatLineReports([
      report({}),
      report({ id: 'turbo', loss: 1.029, status: 'fresh', speech: { start: 15.56, end: 16.36 }, warnings: ['its loss is high (1.029); check it by ear'] }),
      report({ id: 'gap', speaker: 'Buddy', status: 'stale', loss: null, speech: null, reason: "can't read /m/b4.wav" }),
    ]);
    expect(text.split('\n')).toEqual([
      'id       speaker  speech (s)   loss   status',
      'getaway  Rick     4.38–5.36    0.716  aligned',
      'turbo    Rick     15.56–16.36  1.029  fresh',
      'gap      Buddy    –            –      stale',
      '',
      'warning: turbo: its loss is high (1.029); check it by ear',
      "warning: gap: no words: can't read /m/b4.wav",
    ]);
  });
});
