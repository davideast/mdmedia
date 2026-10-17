import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { GeminiTTSProvider } from '../../src/tts/gemini-tts-provider.js';

describe('GeminiTTSProvider', () => {
  it('formats legacy 3.1 promptStyle as a bracketed stage direction', async () => {
    let capturedPayload: any = null;

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return (async function* () {
            const fakePcmBase64 = Buffer.from(new Uint8Array(48)).toString('base64');
            yield {
              event_type: 'step.delta',
              delta: { type: 'audio', data: fakePcmBase64 },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiTTSProvider(mockAi);
    const audioChunks: Uint8Array[] = [];

    for await (const chunk of provider.streamAudio(
      'Hello world',
      'Puck',
      'Adopt the persona of a 1940s noir detective.'
    )) {
      audioChunks.push(chunk);
    }

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.model).toBe('gemini-3.1-flash-tts-preview');
    expect(capturedPayload.system_instruction).toBeUndefined();
    expect(capturedPayload.input).toBe(
      '[Adopt the persona of a 1940s noir detective.]\n\nHello world'
    );
    expect(audioChunks.length).toBe(1);
    expect(audioChunks[0].byteLength).toBe(48);
  });

  it('preserves existing brackets on promptStyle without double-wrapping', async () => {
    let capturedPayload: any = null;

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return (async function* () {
            yield {
              event_type: 'step.delta',
              delta: {
                type: 'audio',
                data: Buffer.from(new Uint8Array(24)).toString('base64'),
              },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiTTSProvider(mockAi);
    for await (const _ of provider.streamAudio(
      'Hello world',
      'Puck',
      '[whispering softly]'
    )) {
      // consume
    }

    expect(capturedPayload.input).toBe('[whispering softly]\n\nHello world');
  });

  it('sends bare text when promptStyle is omitted or blank', async () => {
    let capturedPayload: any = null;

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return (async function* () {
            yield {
              event_type: 'step.delta',
              delta: {
                type: 'audio',
                data: Buffer.from(new Uint8Array(24)).toString('base64'),
              },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiTTSProvider(mockAi);
    for await (const _ of provider.streamAudio('Hello world', 'Puck', '   ')) {
      // consume
    }

    expect(capturedPayload.input).toBe('Hello world');
  });

  it('throws when model stream produces an error event', async () => {
    const mockAi = {
      interactions: {
        create: async () => {
          return (async function* () {
            yield {
              event_type: 'error',
              error: { message: 'Developer instruction is not enabled for this model' },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiTTSProvider(mockAi, 0); // 0 retries
    let error: Error | null = null;

    try {
      for await (const _ of provider.streamAudio('Hello', 'Puck')) {
        // consume
      }
    } catch (e: any) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('Developer instruction is not enabled for this model');
  });

  it('retries when an active stream drops with TypeError: terminated (cause: ECONNRESET) without duplicating buffered audio', async () => {
    let attempts = 0;

    const mockAi = {
      interactions: {
        create: async () => {
          attempts++;
          return (async function* () {
            const chunk1 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64');
            yield {
              event_type: 'step.delta',
              delta: { type: 'audio', data: chunk1 },
            };
            if (attempts === 1) {
              const cause = Object.assign(new Error('read ECONNRESET'), {
                errno: -54,
                code: 'ECONNRESET',
                syscall: 'read',
              });
              throw new TypeError('terminated', { cause });
            }
            const chunk2 = Buffer.from(new Uint8Array([5, 6, 7, 8])).toString('base64');
            yield {
              event_type: 'step.delta',
              delta: { type: 'audio', data: chunk2 },
            };
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiTTSProvider(mockAi, 2);
    const received: Uint8Array[] = [];

    for await (const pcm of provider.streamAudio('Hello world', 'Puck')) {
      received.push(pcm);
    }

    expect(attempts).toBe(2);
    expect(received.length).toBe(2);
    expect(Array.from(received[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(received[1])).toEqual([5, 6, 7, 8]);
  });
});
