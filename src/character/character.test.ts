import { describe, expect, it } from 'bun:test';
import {
  CHARACTER_FORMAT,
  describeVoice,
  formatCharacterRef,
  newCharacter,
  nextVersion,
  parseCharacter,
  parseCharacterRef,
  serializeCharacter,
  type Character,
} from './character.js';

const RICK: Character = {
  format: CHARACTER_FORMAT,
  id: 'rick',
  version: 1,
  name: 'Rick',
  kind: 'person',
  description: 'The hero of Night Wagon.',
  look: { description: 'a mid-30s man with a big dark mullet, in a black leather jacket', never: ['aviator sunglasses'] },
  media: { root: '~/media' },
  stills: [{ id: 'driving', file: 'characters/rick/driving.png', from: { take: 'nw7-rick-lines-t1', at: 1 }, note: 'at the wheel' }],
  voice: { provider: 'video-model', uses: ['on-camera'] },
  delivery: {
    register: 'grim and intense',
    never: ['never jokes'],
    reference: {
      levels: { loudness: { min: -26, max: -18 }, pitch: { min: 129, max: 407 }, pitchRange: { max: 21.7 }, rate: { min: 2, max: 7.5 }, source: 'Take 9' },
      typical: { loudness: -22.2, pitch: 211.9, pitchRange: 15.4, rate: 4.08 },
      margins: { loudness: 2.5, pitch: 3, pitchRange: 3, rate: 0.2 },
      lines: [{ cut: 'docs/cuts/night-wagon-take9.cut.json', line: 'getaway', text: "They're getting away, Buddy.", loudness: -22.2, pitch: 167, pitchRange: 7.1, rate: 4.08 }],
      method: 'dialogue-stem@1',
      measuredAt: '2026-10-20T08:00:00.000Z',
    },
  },
  changelog: [{ version: 1, date: '2026-10-20', changes: 'First version.' }],
};

describe('character files', () => {
  it('parse and write back unchanged, in a fixed order', () => {
    const parsed = parseCharacter(JSON.parse(serializeCharacter(RICK)));
    expect(parsed).toEqual({ ok: true, value: RICK });
    const { changelog, ...rest } = RICK;
    const shuffled = JSON.parse(JSON.stringify({ changelog, ...rest }));
    expect(serializeCharacter(shuffled)).toBe(serializeCharacter(RICK));
    expect(serializeCharacter(RICK).endsWith('}\n')).toBe(true);
  });

  it('report every problem at once', () => {
    const result = parseCharacter({ format: 'nope', id: 'Big Hal', version: 0, look: {}, voice: { provider: 'elevenlabs', uses: ['dance'] }, delivery: {}, changelog: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      'format: expected "mdmedia.character@1"',
      'id: expected lowercase words joined by hyphens, like "big-hal"',
      'version: expected a whole number, 1 or more',
      'name: expected non-empty text',
      'voice: an ElevenLabs voice needs its name or id',
      'voice.uses: expected a list of tts, swap, on-camera',
      'changelog: expected at least one entry, { version, date, changes }',
    ]));
  });

  it('need a still to say where it came from, under the media root', () => {
    const bad = { ...RICK, stills: [{ id: 'x', file: '../outside.png', from: { at: 1 } }] };
    const result = parseCharacter(bad);
    expect(result.ok ? [] : result.errors).toEqual([
      'stills[0].file: expected a path under the media root',
      'stills[0].from: expected { take, at } (a frame of a take) or { generated: { provider, prompt?, ref?, at? } }',
    ]);
    const generated = { ...RICK, stills: [{ id: 'key', file: 'football/k-booth-a.png', from: { generated: { provider: 'gemini image', prompt: 'football/prompts/k-booth.md' } } }] };
    expect(parseCharacter(generated).ok).toBe(true);
  });

  it('keep a changelog entry for the current version, oldest first', () => {
    const missing = parseCharacter({ ...RICK, version: 2 });
    expect(missing.ok ? [] : missing.errors).toEqual(['changelog: expected an entry for version 2']);
    const ahead = parseCharacter({ ...RICK, changelog: [...RICK.changelog, { version: 2, date: '2026-10-21', changes: 'x' }] });
    expect(ahead.ok ? [] : ahead.errors).toEqual(['changelog: has an entry for a version after 1']);
  });

  it('keep a video-model voice on camera only', () => {
    const result = parseCharacter({ ...RICK, voice: { provider: 'video-model', uses: ['tts'] } });
    expect(result.ok ? [] : result.errors).toEqual(['voice.uses: a video-model voice is only "on-camera"; text-to-speech and swaps need a provider voice']);
  });

  it('allow a character without measured levels', () => {
    expect(parseCharacter({ ...RICK, delivery: { ...RICK.delivery, reference: null } }).ok).toBe(true);
  });
});

describe('versions', () => {
  it('are named id@version', () => {
    expect(parseCharacterRef('big-hal@1')).toEqual({ id: 'big-hal', version: 1 });
    expect(parseCharacterRef(' rick@12 ')).toEqual({ id: 'rick', version: 12 });
    for (const bad of ['rick', 'rick@0', 'Rick@1', 'rick@1.5', '@1']) expect(parseCharacterRef(bad)).toBeNull();
    expect(formatCharacterRef(RICK)).toBe('rick@1');
  });

  it('move on with a changelog entry', () => {
    const next = nextVersion(RICK, 'A swap voice.', '2026-10-21');
    expect(next.version).toBe(2);
    expect(next.changelog.at(-1)).toEqual({ version: 2, date: '2026-10-21', changes: 'A swap voice.' });
    expect(parseCharacter(next).ok).toBe(true);
  });

  it('start at 1 and parse', () => {
    const fresh = newCharacter({ id: 'walt', name: 'Walt', root: '~/media', date: '2026-10-20' });
    expect(fresh.version).toBe(1);
    expect(parseCharacter(fresh).ok).toBe(true);
  });
});

describe('voices', () => {
  it('read in a few words', () => {
    expect(describeVoice(RICK.voice)).toBe("the video model's own voice (on camera)");
    expect(describeVoice({ provider: 'elevenlabs', name: 'Eric', uses: ['tts', 'swap'] })).toBe('ElevenLabs "Eric" (text-to-speech, voice swap)');
  });
});
