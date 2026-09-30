import { describe, expect, test } from 'bun:test';
import { scrubLegacyVoiceIds } from '../../studio/scripts/scrub-private-voice-ids.mjs';

describe('legacy personal voice ID migration', () => {
  test('dry run does not write, and apply deletes only legacy ElevenLabs IDs with preconditions', async () => {
    const updates: unknown[] = [];
    const docs = [
      { data: () => ({ voiceProvider: 'elevenlabs', voiceId: 'ABCDEFGHIJKLMNOPQRST' }),
        updateTime: 'first-version', ref: { update: async (...args: unknown[]) => { updates.push(args); } } },
      { data: () => ({ voiceProvider: 'elevenlabs' }), updateTime: 'second-version',
        ref: { update: async (...args: unknown[]) => { updates.push(args); } } },
      { data: () => ({ voiceProvider: 'gemini', voiceId: 'Kore' }), updateTime: 'third-version',
        ref: { update: async (...args: unknown[]) => { updates.push(args); } } },
    ];
    const db = { collection: () => ({ orderBy: () => ({ limit: () => ({
      get: async () => ({ docs, size: docs.length, empty: false }),
    }) }) }) };
    const deleted = Symbol('delete');

    expect(await scrubLegacyVoiceIds(db, deleted, false)).toEqual({ scanned: 3, matched: 1, changed: 0 });
    expect(updates).toEqual([]);
    expect(await scrubLegacyVoiceIds(db, deleted, true)).toEqual({ scanned: 3, matched: 1, changed: 1 });
    expect(updates).toEqual([[{ voiceId: deleted }, { lastUpdateTime: 'first-version' }]]);
  });
});
