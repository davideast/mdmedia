import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { DocumentAudioPipeline } from '../../src/pipeline/document-audio-pipeline.js';
import { UniversalEventBus } from '../../src/pipeline/pipeline-event-bus.js';
import { GeminiTTSProvider } from '../../src/tts/gemini-tts-provider.js';
import type { DocumentChunk } from '../../src/types/chunk.js';
import { TTS_MODELS } from '../../studio/src/lib/types';

describe('delivery prompt across narration chunks', () => {
  for (const model of TTS_MODELS) {
    it(`${model} keeps Delivery in speech metadata across chunks`, async () => {
      const payloads: Array<{ input: unknown; model: string; response_format: unknown }> = [];
      const client = {
        interactions: {
          create: async (payload: { input: unknown; model: string; response_format: unknown }) => {
            payloads.push(payload);
            return (async function* () {
              yield {
                event_type: 'step.delta',
                delta: {
                  type: 'audio',
                  data: Buffer.alloc(48).toString('base64'),
                },
              };
            })();
          },
        },
      } as unknown as GoogleGenAI;
      const chunks: DocumentChunk[] = [
        { id: 'chunk-0', index: 0, text: 'First paragraph.', charCount: 16, wordCount: 2 },
        { id: 'chunk-1', index: 1, text: 'Second paragraph.', charCount: 17, wordCount: 2 },
      ];

      await new DocumentAudioPipeline(
        new GeminiTTSProvider(client, 0, model),
        new UniversalEventBus(),
      ).processDocument(chunks, 'Puck', 'Warm, unhurried narration.');

      expect(payloads.map((payload) => payload.model)).toEqual([model, model]);
      expect(payloads.map((payload) => payload.input)).toEqual(
        chunks.map((chunk) => [{
          type: 'user_input',
          content: [{
            type: 'text',
            text: chunk.text,
            annotations: [{
              type: 'speech_metadata',
              style: 'Warm, unhurried narration.',
            }],
          }],
        }]),
      );
      expect(payloads.map((payload) => payload.response_format)).toEqual([
        { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
        { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
      ]);
    });
  }
});
