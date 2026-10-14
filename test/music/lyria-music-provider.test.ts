import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { LyriaMusicProvider } from '../../src/music/lyria-music-provider.js';

describe('LyriaMusicProvider', () => {
  it('sends correct payload with default model and extracts audio from output_audio', async () => {
    let capturedPayload: any = null;
    const fakeAudioBase64 = Buffer.from(new Uint8Array(128)).toString('base64');

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            id: 'interaction_123',
            output_audio: { data: fakeAudioBase64, mime_type: 'audio/mpeg' },
            output_text: '[Verse 1]\nHello world',
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new LyriaMusicProvider(mockAi);
    const result = await provider.generate('A calm piano melody.');

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.model).toBe('lyria-3.5');
    expect(capturedPayload.input).toBe('A calm piano melody.');
    expect(result.interactionId).toBe('interaction_123');
    expect(result.audioBytes.byteLength).toBe(128);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.lyrics).toBe('[Verse 1]\nHello world');
  });

  it('falls back to steps-based parsing when output_audio is absent', async () => {
    const fakeAudioBase64 = Buffer.from(new Uint8Array(64)).toString('base64');

    const mockAi = {
      interactions: {
        create: async () => ({
          id: 'interaction_456',
          steps: [
            {
              type: 'model_output',
              content: [
                { type: 'text', text: 'Generated lyrics here' },
                { type: 'audio', data: fakeAudioBase64 },
              ],
            },
          ],
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new LyriaMusicProvider(mockAi);
    const result = await provider.generate('An upbeat rock song.');

    expect(result.audioBytes.byteLength).toBe(64);
    expect(result.lyrics).toBe('Generated lyrics here');
  });

  it('requests WAV format when outputFormat is wav', async () => {
    let capturedPayload: any = null;
    const fakeAudioBase64 = Buffer.from(new Uint8Array(32)).toString('base64');

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            id: 'wav_test',
            output_audio: { data: fakeAudioBase64, mime_type: 'audio/wav' },
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new LyriaMusicProvider(mockAi);
    await provider.generate('Test', { outputFormat: 'wav' });

    expect(capturedPayload.response_format).toEqual({ type: 'audio' });
  });

  it('throws when Lyria returns no audio data', async () => {
    const mockAi = {
      interactions: {
        create: async () => ({ id: 'empty', steps: [] }),
      },
    } as unknown as GoogleGenAI;

    const provider = new LyriaMusicProvider(mockAi, 0);
    let error: Error | null = null;

    try {
      await provider.generate('Test prompt');
    } catch (e: any) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('Lyria did not return any audio data');
  });

  it('uses clip model when specified in options', async () => {
    let capturedPayload: any = null;
    const fakeAudioBase64 = Buffer.from(new Uint8Array(32)).toString('base64');

    const mockAi = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            id: 'clip_test',
            output_audio: { data: fakeAudioBase64 },
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new LyriaMusicProvider(mockAi);
    await provider.generate('Quick clip', { model: 'lyria-3-clip-preview' });

    expect(capturedPayload.model).toBe('lyria-3-clip-preview');
  });
});

describe('finite music transport safety', () => {
  it('disables paid retries in the wrapper and SDK, including unknown outcomes', async () => {
    let calls = 0;
    const client = { interactions: { create: async (_body: unknown, options: any) => {
      calls++; expect(options.maxRetries).toBe(0); throw Object.assign(new Error('Timeout after acceptance'), { status: 503 });
    } } } as unknown as GoogleGenAI;
    await expect(new LyriaMusicProvider(client, 3).generate('Piano')).rejects.toThrow('Timeout');
    expect(calls).toBe(1);
  });
  it('checkpoints a real receipt before output decoding and recovers through GET alone', async () => {
    const order: string[] = [];
    const client = { interactions: {
      create: async () => ({ id: 'real-id', steps: [] }),
      get: async (id: string) => { expect(id).toBe('real-id'); order.push('get'); return { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: Buffer.from('RIFF1234WAVE1234').toString('base64') }] }] }; },
    } } as unknown as GoogleGenAI;
    const provider = new LyriaMusicProvider(client, 0);
    await expect(provider.generate('Piano', { onInteraction: id => { order.push(id); } })).rejects.toThrow('did not return');
    const result = await provider.retrieve('real-id');
    expect(order).toEqual(['real-id', 'get']); expect(result.mimeType).toBe('audio/wav');
  });
  it('rejects absent receipts, missing references and excessive references before creating', async () => {
    let calls = 0;
    const client = { interactions: { create: async () => { calls++; return { output_audio: { data: 'AAAA' } }; } } } as unknown as GoogleGenAI;
    const provider = new LyriaMusicProvider(client, 0);
    await expect(provider.generate('Piano', { referenceImages: ['/does/not/exist.png'] })).rejects.toThrow();
    await expect(provider.generate('Piano', { referenceImages: Array(11).fill('/a.png') })).rejects.toThrow('ten');
    expect(calls).toBe(0);
    await expect(provider.generate('Piano')).rejects.toThrow('no interaction ID'); expect(calls).toBe(1);
  });
  it('honors cancellation, byte limits, and rejects arbitrary download hosts', async () => {
    let calls = 0;
    const client = { interactions: { create: async () => { calls++; return { id: 'uri', output_audio: { uri: 'https://evil.test/files/leak' } }; } } } as unknown as GoogleGenAI;
    const provider = new LyriaMusicProvider(client, 0);
    const controller = new AbortController(); controller.abort();
    await expect(provider.generate('Piano', { signal: controller.signal })).rejects.toThrow(); expect(calls).toBe(0);
    await expect(provider.generate('Piano')).rejects.toThrow('unsupported audio URI');
    const large = { interactions: { create: async () => ({ id: 'large', output_audio: { data: Buffer.alloc(10).toString('base64') } }) } } as unknown as GoogleGenAI;
    await expect(new LyriaMusicProvider(large, 0).generate('Piano', { maxBytes: 3 })).rejects.toThrow('size limit');
  });
});
it('refuses unsupported clip WAV before creating instead of returning MP3 bytes as WAV', async () => {
  let calls = 0;
  const client = { interactions: { create: async () => { calls++; } } } as unknown as GoogleGenAI;
  await expect(new LyriaMusicProvider(client, 0).generate('Piano', { model: 'lyria-3-clip-preview', outputFormat: 'wav' })).rejects.toThrow('convert');
  expect(calls).toBe(0);
});
