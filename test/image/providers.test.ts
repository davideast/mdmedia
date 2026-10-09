import { describe, expect, test } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { OpenAIImageProvider, PixelLabImageProvider, RetroDiffusionImageProvider, GeminiImageProvider } from '../../src/image/index.js';
import { PNG, PNG_BASE64, json, fakeTransport } from './helpers.js';

describe('image provider documented wire contracts (fake transport only)', () => {
  test('OpenAI generates one requested-format image without legacy response_format', async () => {
    const provider = new OpenAIImageProvider('test-key', { request: fakeTransport((url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
      expect(JSON.parse(String(init.body))).toEqual({ model: 'gpt-image-2.5-flare', prompt: 'Red fox', n: 1, size: '1536x864', quality: 'xhigh', background: 'transparent', output_format: 'png' });
      return json({ data: [{ b64_json: PNG_BASE64 }], usage: { total_tokens: 321 } }, 200, { 'x-request-id': 'openai-request' });
    }) });
    expect(await provider.generate({ prompt: 'Red fox', model: 'gpt-image-2.5-flare', aspectRatio: '16:9', quality: 'xhigh', background: 'transparent', format: 'png' })).toMatchObject({ imageBytes: PNG, mimeType: 'image/png', requestId: 'openai-request', usage: { total_tokens: 321 } });
  });
  test('OpenAI references use the JSON edit contract without a Files upload', async () => {
    const provider = new OpenAIImageProvider('test', { request: fakeTransport((url, init) => {
      expect(url).toEndWith('/images/edits');
      expect(JSON.parse(String(init.body)).images).toEqual([{ image_url: `data:image/png;base64,${PNG_BASE64}` }]);
      return json({ data: [{ b64_json: PNG_BASE64 }] });
    }) });
    await provider.generate({ prompt: 'Change color only', model: 'gpt-image-2.5-sunburst', format: 'png', reference: { bytes: PNG, mimeType: 'image/png' } });
  });
  test('PixelLab uses strict Pixflux fields and decodes prefixed base64 with usage', async () => {
    const provider = new PixelLabImageProvider('pixel-test', { request: fakeTransport((url, init) => {
      expect(url).toBe('https://api.pixellab.ai/v2/create-image-pixflux');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer pixel-test');
      expect(JSON.parse(String(init.body))).toEqual({ description: 'Red fox', image_size: { width: 128, height: 64 }, no_background: true, seed: 42, init_image: { type: 'base64', base64: PNG_BASE64, format: 'png' } });
      return json({ image: { type: 'base64', base64: `data:image/png;base64,${PNG_BASE64}`, format: 'png' }, usage: { type: 'usd', usd: 0.01 } });
    }) });
    expect(await provider.generate({ prompt: 'Red fox', model: 'pixflux', size: '128x64', background: 'transparent', seed: 42, format: 'png', reference: { bytes: PNG, mimeType: 'image/png' } })).toMatchObject({ imageBytes: PNG, usage: { type: 'usd', usd: 0.01 } });
  });
  test('Pixen chooses its endpoint without implicit paid prompt enhancement', async () => {
    const provider = new PixelLabImageProvider('test', { request: fakeTransport((url, init) => {
      expect(url).toEndWith('/create-image-pixen');
      expect(JSON.parse(String(init.body))).toEqual({ description: 'Red fox', image_size: { width: 512, height: 512 }, no_background: false });
      return json({ image: { base64: PNG_BASE64 } });
    }) });
    await provider.generate({ prompt: 'Red fox', model: 'pixen', size: '512x512', format: 'png' });
  });
  test('Retro submits once, persists before admission, polls, and handles URL outputs without credentials', async () => {
    const events: string[] = [];
    let polls = 0;
    const provider = new RetroDiffusionImageProvider('retro-test', {
      onSubmitting: async ({ idempotencyKey }) => { expect(idempotencyKey.length).toBe(36); events.push('before'); },
      onSubmitted: async ({ taskId }) => { expect(taskId).toBe('job-1'); events.push('accepted'); },
      sleep: async () => {},
      request: fakeTransport((url, init) => {
        if (init.method === 'POST') {
          events.push('POST');
          expect(events).toEqual(['before', 'POST']);
          expect(new Headers(init.headers).get('x-rd-token')).toBe('retro-test');
          expect(new Headers(init.headers).get('idempotency-key')).toHaveLength(36);
          expect(JSON.parse(String(init.body))).toEqual({ prompt: 'Red fox', prompt_style: 'rd_fast__default', width: 128, height: 128, num_images: 1, remove_bg: false, seed: 0 });
          return json({ status: 'accepted', task_id: 'job-1', request_id: 'retro-request' }, 202);
        }
        if (url === 'https://assets.example.test/image.png') {
          expect(new Headers(init.headers).has('x-rd-token')).toBe(false);
          return new Response(PNG);
        }
        expect(url).toBe('https://api.retrodiffusion.ai/v2/inferences/tasks/job-1');
        expect(events).toEqual(['before', 'POST', 'accepted']);
        return ++polls === 1 ? json({ status: 'running' }) : json({ status: 'succeeded', result: { base64_images: [], output_urls: ['https://assets.example.test/image.png'], balance_cost: 3 } });
      }),
    });
    const result = await provider.generate({ prompt: 'Red fox', model: 'rd_fast', size: '128x128', format: 'png', seed: 0 });
    expect(Buffer.from(result.imageBytes)).toEqual(PNG);
    expect(result).toMatchObject({ requestId: 'retro-request', usage: { taskId: 'job-1', balanceCost: 3 } });
  });
  test('Retro public poll resumes without posting and decodes inline images', async () => {
    const provider = new RetroDiffusionImageProvider('test', { request: fakeTransport((_url, init) => {
      expect(init.method).toBeUndefined();
      return json({ status: 'succeeded', result: { base64_images: [PNG_BASE64] } });
    }) });
    expect((await provider.poll('saved-task', 'rd_fast')).imageBytes).toEqual(PNG);
  });
  for (const mode of ['failed', 'invalid-status', 'poll-http-error', 'timeout', 'no-image']) {
    test(`Retro ${mode} reports task ID and never resubmits`, async () => {
      let submissions = 0;
      const provider = new RetroDiffusionImageProvider('test', {
        timeoutMs: mode === 'timeout' ? 5 : 100,
        request: fakeTransport((_url, init) => {
          if (init.method === 'POST') { submissions++; return json({ task_id: 'saved-task' }, 202); }
          if (mode === 'failed') return json({ status: 'failed', error: { code: 'inference_failed' } });
          if (mode === 'poll-http-error') return json({ error: { code: 'rate_limited' } }, 429);
          if (mode === 'no-image') return json({ status: 'succeeded', result: {} });
          return json({ status: mode === 'timeout' ? 'running' : 'mystery' });
        }),
      });
      await expect(provider.generate({ prompt: 'Red fox', model: 'rd_fast', format: 'png' })).rejects.toThrow('task saved-task');
      expect(submissions).toBe(1);
    });
  }
  test('ambiguous POST failures never repeat or expose credentials', async () => {
    let requests = 0;
    const provider = new OpenAIImageProvider('private-key', { request: fakeTransport(() => { requests++; throw new Error('authorization private-key'); }) });
    try { await provider.generate({ prompt: 'Red fox', model: 'gpt-image-2.5-flare', format: 'png' }); throw new Error('expected failure'); }
    catch (error) { expect(String(error)).toContain('may already have been charged'); expect(String(error)).not.toContain('private-key'); }
    expect(requests).toBe(1);
  });
  test('HTTP errors preserve request IDs and malformed results fail', async () => {
    const provider = new PixelLabImageProvider('test', { request: fakeTransport(() => json({ error: { code: 'no_credits', request_id: 'support-123' } }, 402)) });
    await expect(provider.generate({ prompt: 'Red fox', model: 'pixflux', format: 'png' })).rejects.toThrow('HTTP 402: no_credits (request support-123)');
    const invalid = new OpenAIImageProvider('test', { request: fakeTransport(() => json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })) });
    await expect(invalid.generate({ prompt: 'Red fox', model: 'gpt-image-2.5-flare', format: 'png' })).rejects.toThrow('invalid image bytes');
  });
  test('Gemini remains injectable, supports conditioning and reports actual returned format', async () => {
    const client = { models: { generateContent: async (request: any) => {
      expect(request.model).toBe('gemini-3-pro-image');
      expect(request.contents[0].inlineData.data).toBe(PNG_BASE64);
      expect(request.config.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
      return { candidates: [{ content: { parts: [{ inlineData: { data: PNG_BASE64, mimeType: 'image/png' } }] } }] };
    } } } as unknown as GoogleGenAI;
    const provider = new GeminiImageProvider(client);
    expect((await provider.generate({ prompt: 'Red fox', model: 'gemini-3-pro-image', format: 'jpeg', size: '4k', reference: { bytes: PNG, mimeType: 'image/png' } })).mimeType).toBe('image/png');
  });
});
