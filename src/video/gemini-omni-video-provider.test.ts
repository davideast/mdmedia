import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { writeFile } from 'node:fs/promises';
import { GeminiOmniVideoProvider } from './gemini-omni-video-provider.js';

describe('GeminiOmniVideoProvider - TDD Unit Tests', () => {
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
    });

    expect(result.interactionId).toBe('interaction_123');
    expect(new TextDecoder().decode(result.videoBytes)).toBe('mock-mp4-video-data');
    expect(capturedParams.model).toBe('gemini-omni-flash-preview');
    expect(capturedParams.response_format.aspect_ratio).toBe('16:9');
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

