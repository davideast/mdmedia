import { describe, expect, it } from 'bun:test';
import { adaptGeminiImagePrompt, generateGeminiImage } from '../../src/image';
import type { GoogleGenAI } from '@google/genai';
function client(generateContent: (request: any) => Promise<any>) { return { models: { generateContent } } as unknown as Pick<GoogleGenAI, 'models'>; }
describe('Gemini image engine', () => {
  it('sends one image and one prompt with explicit shape/resolution and preserves the returned MIME type', async () => {
    let sent: any;
    const output = await generateGeminiImage(client(async request => { sent = request; return { candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/webp', data: 'AQID' } }] } }] }; }), {
      prompt: '# Draw a harbor', model: 'configured-image-model', aspectRatio: '9:16', resolution: '2K', reference: { bytes: new Uint8Array([4, 5]), mimeType: 'image/png' },
    });
    expect(sent.contents[0].parts).toEqual([{ inlineData: { data: 'BAU=', mimeType: 'image/png' } }, { text: '# Draw a harbor' }]);
    expect(sent.config.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
    expect(output.mimeType).toBe('image/webp'); expect([...output.bytes]).toEqual([1, 2, 3]);
  });
  it('rejects empty input before a paid call and reports a text-only/blocked response', async () => {
    let calls = 0; const sdk = client(async () => { calls++; return { candidates: [] }; });
    await expect(generateGeminiImage(sdk, { prompt: ' ', model: 'model', aspectRatio: '1:1' })).rejects.toThrow('prompt');
    expect(calls).toBe(0);
    await expect(generateGeminiImage(sdk, { prompt: 'draw', model: 'model', aspectRatio: '1:1' })).rejects.toThrow('no image');
  });
  it('prepares a visual brief with source and custom instructions separate from the system instruction', async () => {
    let sent: any;
    const prompt = await adaptGeminiImagePrompt(client(async request => { sent = request; return { text: ' A visual brief ' }; }), '# Notes', 'Use watercolor', 'adaptation-model');
    expect(prompt).toBe('A visual brief'); expect(JSON.parse(sent.contents)).toEqual({ source: '# Notes', instructions: 'Use watercolor' });
    expect(sent.config.systemInstruction).toContain('one illustration'); expect(sent.model).toBe('adaptation-model');
  });
});
