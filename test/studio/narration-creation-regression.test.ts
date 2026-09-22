import { describe, expect, it } from 'bun:test';
import { generateNarrationId } from '../../studio/src/lib/narrations.js';
import { parseNarrationRequest } from '../../studio/src/lib/narration-server.js';
import { GeminiTTSProvider } from '../../src/tts/gemini-tts-provider.js';
import type { GoogleGenAI } from '@google/genai';

describe('Narration Creation Regression Tests', () => {
  describe('generateNarrationId (Root Cause 2: Pyric doc() auto-id stub fallback)', () => {
    it('generates a 20-character alphanumeric string', () => {
      const id = generateNarrationId();
      expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(id.length).toBe(20);
    });

    it('generates unique IDs across 1,000 iterations', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(generateNarrationId());
      }
      expect(ids.size).toBe(1000);
    });

    it('never produces the literal reserved collection name "narrations"', () => {
      for (let i = 0; i < 1000; i++) {
        expect(generateNarrationId()).not.toBe('narrations');
      }
    });
  });

  describe('parseNarrationRequest reserved ID guarding', () => {
    const baseRequest = {
      markdown: '## Heading\n\nSome body text.',
      voice: 'Puck',
      promptStyle: 'Energetic',
      rewriteForNarration: false,
      visibility: 'private',
    };

    it('rejects "narrations" as custom ID and falls back to undefined so newNarrationId is used', () => {
      const parsed = parseNarrationRequest({ ...baseRequest, id: 'narrations' });
      expect(parsed).not.toBeNull();
      expect(parsed?.id).toBeUndefined();
    });

    it('rejects other reserved route names like "new", "settings", "queue"', () => {
      expect(parseNarrationRequest({ ...baseRequest, id: 'new' })?.id).toBeUndefined();
      expect(parseNarrationRequest({ ...baseRequest, id: 'settings' })?.id).toBeUndefined();
      expect(parseNarrationRequest({ ...baseRequest, id: 'queue' })?.id).toBeUndefined();
      expect(parseNarrationRequest({ ...baseRequest, id: 'playlists' })?.id).toBeUndefined();
      expect(parseNarrationRequest({ ...baseRequest, id: 'library' })?.id).toBeUndefined();
    });

    it('accepts valid 20-character auto-generated IDs', () => {
      const autoId = 'rt4y7eLFnyG4tSV94E8C';
      const parsed = parseNarrationRequest({ ...baseRequest, id: autoId });
      expect(parsed).not.toBeNull();
      expect(parsed?.id).toBe(autoId);
    });
  });

  describe('GeminiTTSProvider promptStyle stage direction formatting (Root Cause 1: system_instruction rejection)', () => {
    it('formats promptStyle as stage directions in input without setting system_instruction', async () => {
      let capturedPayload: any = null;
      const fakeClient = {
        interactions: {
          create: async (payload: any) => {
            capturedPayload = payload;
            return (async function* () {
              yield { event_type: 'step.delta', delta: { type: 'audio', data: 'AAAA' } };
            })();
          },
        },
      } as unknown as GoogleGenAI;

      const provider = new GeminiTTSProvider(fakeClient);
      const stream = provider.streamAudio(
        'Listen close to how rate limiting works.',
        'Puck',
        'Warm, unhurried narration.',
      );

      for await (const _pcm of stream) {
        // Drain stream
      }

      expect(capturedPayload).not.toBeNull();
      // Must NOT set system_instruction (which Gemini interactions.create rejects)
      expect(capturedPayload.system_instruction).toBeUndefined();
      // Must format promptStyle as bracketed stage direction in input
      expect(capturedPayload.input).toBe('[Warm, unhurried narration.]\n\nListen close to how rate limiting works.');
    });
  });
});
