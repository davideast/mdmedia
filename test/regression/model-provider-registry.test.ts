import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import * as ttsModule from '../../src/tts/index.js';

describe('TTS provider selection', () => {
  it('keeps the existing getTTSProvider client and model arguments', async () => {
    let selectedModel = '';
    const client = {
      interactions: {
        create: (payload: { model: string }) => {
          selectedModel = payload.model;
          return (async function* () {
            yield {
              event_type: 'step.delta',
              delta: { type: 'audio', data: Buffer.from(Uint8Array.of(0, 0)).toString('base64') },
            };
          })();
        },
      },
    };
    const provider = ttsModule.getTTSProvider(
      'gemini',
      client as unknown as GoogleGenAI,
      { model: 'custom-gemini-model' }
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider!.streamAudio('Hello.', 'Puck')) chunks.push(chunk);

    expect(selectedModel).toBe('custom-gemini-model');
    expect(chunks).toEqual([Uint8Array.of(0, 0)]);
  });

  it('preserves Gemini narration through the provider creation interface', async () => {
    const client = {
      interactions: {
        create: async () => (async function* () {
          yield {
            event_type: 'step.delta',
            delta: { type: 'audio', data: Buffer.from(Uint8Array.of(0, 0)).toString('base64') },
          };
        })(),
      },
    };
    const provider = ttsModule.createTTSProvider({
      provider: 'gemini',
      geminiClient: client as unknown as GoogleGenAI,
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.streamAudio('Hello.', 'Puck')) chunks.push(chunk);
    expect(chunks).toEqual([Uint8Array.of(0, 0)]);
  });
});
