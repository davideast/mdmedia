import { describe, expect, it } from 'bun:test';
import { publicNarrationVoiceMetadata } from '../../studio/src/lib/narration-request';

describe('narration voice metadata', () => {
  it('never persists a personal ElevenLabs voice ID in shareable narration metadata', () => {
    expect(publicNarrationVoiceMetadata({
      voiceProvider: 'elevenlabs', voiceId: 'ABCDEFGHIJKLMNOPQRST',
    })).toEqual({ voiceProvider: 'elevenlabs' });
  });

  it('keeps the built-in Gemini voice name', () => {
    expect(publicNarrationVoiceMetadata({ voiceProvider: 'gemini', voiceId: 'Kore' }))
      .toEqual({ voiceProvider: 'gemini', voiceId: 'Kore' });
  });
});
