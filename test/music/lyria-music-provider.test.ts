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
