import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { writeFile } from 'node:fs/promises';
import { GeminiOmniVideoProvider } from './gemini-omni-video-provider.js';

describe('GeminiOmniVideoProvider - TDD Unit Tests', () => {
  it('fails before calling the model when an attached image is missing', async () => {
    let calls = 0;
    const client = { interactions: { create: async () => { calls++; } } } as unknown as GoogleGenAI;
    const provider = new GeminiOmniVideoProvider(client, 0);
    await expect(provider.generateVideoClip('Animate this', { firstFrame: '/private/tmp/mdmedia-missing-input.png' })).rejects.toThrow('Reference image not found: /private/tmp/mdmedia-missing-input.png');
    expect(calls).toBe(0);
  });

  it('bounds Files API polling without issuing another paid interaction', async () => {
    let calls = 0;
    const client = {
      interactions: { create: async () => { calls++; return { id: 'pending', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'files/pending-file' }] }] }; } },
      files: { get: async () => ({ state: 'PROCESSING' }) },
    } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(client, 3).generateVideoClip('Scene', { timeoutMs: 30 })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not submit an already-aborted request', async () => {
    let calls = 0;
    const client = { interactions: { create: async () => { calls++; } } } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(client).generateVideoClip('Scene', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('generates video clip from text prompt with inline video data', async () => {
    const mockWavBase64 = Buffer.from('mock-mp4-video-data').toString('base64');
    let capturedParams: any = null;

    const mockAi = {
      interactions: {
        create: async (params: any) => {
          capturedParams = params;
          return {
            id: 'interaction_123',
            output_video: {
              data: mockWavBase64,
            },
          };
        },
      },
      files: {
        get: async () => ({ state: { name: 'ACTIVE' } }),
        download: async (opts: any) => {
          if (opts.downloadPath) {
            await writeFile(opts.downloadPath, 'mock-mp4-video-data');
          }
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiOmniVideoProvider(mockAi, 1);
    const result = await provider.generateVideoClip('A marble rolling down a track', {
      aspectRatio: '16:9',
      task: 'text_to_video',
      delivery: 'inline',
      durationSeconds: 6,
    });

    expect(result.interactionId).toBe('interaction_123');
    expect(new TextDecoder().decode(result.videoBytes)).toBe('mock-mp4-video-data');
    expect(capturedParams.model).toBe('gemini-omni-flash-preview');
    expect(capturedParams.response_format.aspect_ratio).toBe('16:9');
    expect(capturedParams.response_format.duration).toBe('6s');
    expect(capturedParams.store).toBe(true);
  });

  it('polls Files API when URI delivery is returned for larger videos', async () => {
    let pollCount = 0;
    const mockAi = {
      interactions: {
        create: async () => ({
          id: 'interaction_uri_456',
          output_video: {
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/file_abc123',
          },
        }),
      },
      files: {
        get: async () => {
          pollCount++;
          if (pollCount < 2) {
            return { state: { name: 'PROCESSING' } };
          }
          return { state: { name: 'ACTIVE' } };
        },
        download: async (opts: any) => {
          if (opts.downloadPath) {
            await writeFile(opts.downloadPath, 'downloaded-uri-mp4-bytes');
          }
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiOmniVideoProvider(mockAi, 1);
    const result = await provider.generateVideoClip('A wide landscape sunset', {
      delivery: 'uri',
    });

    expect(result.interactionId).toBe('interaction_uri_456');
    expect(new TextDecoder().decode(result.videoBytes)).toBe('downloaded-uri-mp4-bytes');
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('retries on transient failure with exponential backoff', async () => {
    let attempts = 0;
    const mockAi = {
      interactions: {
        create: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('429 Resource exhausted');
          }
          return {
            id: 'interaction_retry_success',
            output_video: {
              data: Buffer.from('retry-video-data').toString('base64'),
            },
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiOmniVideoProvider(mockAi, 2);
    const result = await provider.generateVideoClip('Retry test scene');

    expect(attempts).toBe(2);
    expect(result.interactionId).toBe('interaction_retry_success');
  });

  it('refuses a reference image that does not exist, rather than generating without it', async () => {
    let called = false;
    const mockAi = {
      interactions: {
        create: async () => {
          called = true;
          return { id: 'x', output_video: { data: '' } };
        },
      },
    } as unknown as GoogleGenAI;
    const provider = new GeminiOmniVideoProvider(mockAi, 1);
    await expect(
      provider.generateVideoClip('A walk cycle', {
        aspectRatio: '16:9',
        task: 'reference_to_video',
        delivery: 'inline',
        referenceImages: ['/does/not/exist.jpg'],
      })
    ).rejects.toThrow('Reference image not found: /does/not/exist.jpg');
    expect(called).toBe(false);
  });
});
