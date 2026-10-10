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

  it('never repeats a potentially accepted paid request, including SDK retries', async () => {
    let attempts = 0;
    let retryOptions: any;
    const client = { interactions: { create: async (_payload: unknown, options: unknown) => {
      attempts++; retryOptions = options; throw new Error('429 Resource exhausted');
    } } } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(client, 3).generateVideoClip('Scene')).rejects.toThrow('429');
    expect(attempts).toBe(1);
    expect(retryOptions.maxRetries).toBe(0);
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


function movie(duration: number) {
  const bytes = Buffer.alloc(36); bytes.writeUInt32BE(36, 0); bytes.write('moov', 4);
  bytes.writeUInt32BE(28, 8); bytes.write('mvhd', 12);
  bytes.writeUInt32BE(1000, 28); bytes.writeUInt32BE(duration * 1000, 32); return bytes;
}
describe('Explicit Omni continuation and recovery', () => {
  it('requests a stored complete extension, checkpoints its receipt and measures the movie', async () => {
    let payload: any; let checkpoint = '';
    const client = { interactions: { create: async (body: unknown) => {
      payload = body; return { id: 'real-receipt', steps: [{ type: 'model_output', content: [{ type: 'video', data: movie(9).toString('base64') }] }] };
    } } } as unknown as GoogleGenAI;
    const result = await new GeminiOmniVideoProvider(client).continueVideoClip('The train passes a station', { interactionId: 'parent', durationSeconds: 6 }, {
      durationSeconds: 3, resolution: '720p', onInteraction: async id => { checkpoint = id; },
    });
    expect(checkpoint).toBe('real-receipt'); expect(result.durationSeconds).toBe(9);
    expect(payload.store).toBe(true); expect(payload.previous_interaction_id).toBe('parent');
    expect(payload.input).toContain('Return the complete previous video'); expect(payload.input).toContain('The train passes a station');
    expect(payload.response_format).toMatchObject({ type: 'video', duration: '3s', resolution: '720p' });
    expect(payload.generation_config).toBeUndefined();
  });
  it('keeps edit semantics separate from continuation', async () => {
    let payload: any;
    const client = { interactions: { create: async (body: unknown) => { payload = body; return { id: 'edit', output_video: { data: movie(3).toString('base64') } }; } } } as unknown as GoogleGenAI;
    await new GeminiOmniVideoProvider(client).generateVideoClip('Change the lighting', { task: 'edit', previousInteractionId: 'parent' });
    expect(payload.input).toBe('Change the lighting'); expect(payload.generation_config.video_config.task).toBe('edit');
  });
  it('retrieves an existing receipt without creating another interaction', async () => {
    let creates = 0; let gets = 0;
    const client = { interactions: { create: async () => { creates++; }, get: async (id: string) => { gets++; expect(id).toBe('saved'); return { output_video: { data: movie(6).toString('base64') } }; } } } as unknown as GoogleGenAI;
    const result = await new GeminiOmniVideoProvider(client).retrieveVideoClip('saved');
    expect(result.interactionId).toBe('saved'); expect(result.durationSeconds).toBe(6); expect(creates).toBe(0); expect(gets).toBe(1);
  });
  it('rejects a tail-only result and a missing provider receipt', async () => {
    const client = { interactions: { create: async () => ({ id: 'tail', output_video: { data: movie(3).toString('base64') } }) } } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(client).continueVideoClip('Next', { interactionId: 'parent', durationSeconds: 6 })).rejects.toThrow('complete longer video');
    const missing = { interactions: { create: async () => ({ output_video: { data: movie(3).toString('base64') } }) } } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(missing).generateVideoClip('Next')).rejects.toThrow('no interaction ID');
  });
  it('clamps near the sequence limit and refuses less than three seconds of room', async () => {
    let payload: any; let calls = 0;
    const client = { interactions: { create: async (body: unknown) => { payload = body; calls++; return { id: 'end', output_video: { data: movie(40).toString('base64') } }; } } } as unknown as GoogleGenAI;
    const provider = new GeminiOmniVideoProvider(client);
    await provider.continueVideoClip('Next', { interactionId: 'parent', durationSeconds: 36 });
    expect(payload.response_format.duration).toBe('4s');
    await expect(provider.continueVideoClip('Next', { interactionId: 'parent', durationSeconds: 38 })).rejects.toThrow('limit'); expect(calls).toBe(1);
  });
  it('honors cancellation and the output cap before delivering any bytes', async () => {
    let calls = 0;
    const client = { interactions: { create: async () => { calls++; return { id: 'bytes', output_video: { data: movie(3).toString('base64') } }; } } } as unknown as GoogleGenAI;
    const provider = new GeminiOmniVideoProvider(client); const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(provider.generateVideoClip('Next', { signal: controller.signal })).rejects.toThrow('cancelled'); expect(calls).toBe(0);
    await expect(provider.generateVideoClip('Next', { maxBytes: 8 })).rejects.toThrow('size limit');
  });
  it('normalizes a REST URI and saves the receipt before a download fails', async () => {
    const events: string[] = [];
    const client = { interactions: { create: async () => ({ id: 'receipt', steps: [{ content: [{ type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/real_file' }] }] }) }, files: {
      get: async () => ({ state: 'ACTIVE' }), download: async () => { events.push('download'); throw new Error('disk failed'); },
    } } as unknown as GoogleGenAI;
    await expect(new GeminiOmniVideoProvider(client, 0).generateVideoClip('Next', { onInteraction: async () => { events.push('checkpoint'); } })).rejects.toThrow('disk failed');
    expect(events).toEqual(['checkpoint', 'download']);
  });
});

it('disables retries in the real SDK transport, even on a retryable HTTP response', async () => {
  const { GoogleGenAI } = await import('@google/genai');
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests++; return new Response(JSON.stringify({ error: { code: 503, message: 'unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }); }, { preconnect: original.preconnect });
  try {
    const provider = new GeminiOmniVideoProvider(new GoogleGenAI({ apiKey: 'test-only' }), 3);
    await expect(provider.generateVideoClip('Test transport', { timeoutMs: 1000 })).rejects.toThrow();
    expect(requests).toBe(1);
  } finally { globalThis.fetch = original; }
});
