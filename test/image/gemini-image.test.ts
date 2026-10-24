import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_IMAGE_MODEL,
  adaptGeminiImagePrompt,
  generateGeminiImage,
  retrieveGeminiImage,
  validateGeminiImageInput,
} from '../../src/image';
import type { GoogleGenAI } from '@google/genai';

function legacyClient(generateContent: (request: any) => Promise<any>) {
  return { models: { generateContent } } as unknown as Pick<GoogleGenAI, 'models'>;
}

function interactionsClient(
  create: (request: any, options?: any) => Promise<any>,
  get?: (id: string) => Promise<any>,
) {
  return { interactions: { create, get } } as unknown as Pick<GoogleGenAI, 'interactions'>;
}

describe('Gemini image engine', () => {
  it('defaults to gemini-nano-banana-2.1 on the Interactions API with store: true and multi-image references', async () => {
    let sent: any;
    let seenId: string | undefined;
    const output = await generateGeminiImage(
      interactionsClient(async request => {
        sent = request;
        return {
          id: 'inter_123',
          output_image: { data: 'AQID', mime_type: 'image/jpeg' },
          output_text: 'Generated harbor',
        };
      }),
      {
        prompt: '# Draw a harbor',
        aspectRatio: '1:4',
        resolution: '2K',
        mimeType: 'image/jpeg',
        references: [
          { bytes: new Uint8Array([4, 5]), mimeType: 'image/png' },
          { bytes: new Uint8Array([6, 7]), mimeType: 'image/webp' },
        ],
        onInteraction: id => {
          seenId = id;
        },
      },
    );
    expect(sent).toEqual({
      model: DEFAULT_IMAGE_MODEL,
      store: true,
      input: [
        { type: 'text', text: '# Draw a harbor' },
        { type: 'image', data: 'BAU=', mime_type: 'image/png' },
        { type: 'image', data: 'Bgc=', mime_type: 'image/webp' },
      ],
      response_format: {
        type: 'image',
        aspect_ratio: '1:4',
        image_size: '2K',
        mime_type: 'image/jpeg',
      },
    });
    expect(seenId).toBe('inter_123');
    expect(output).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
      interactionId: 'inter_123',
      text: 'Generated harbor',
    });
  });

  it('omits aspect_ratio when aspectRatio is omitted so reference or multi-turn edits preserve dimensions', async () => {
    let sent: any;
    await generateGeminiImage(
      interactionsClient(async request => {
        sent = request;
        return { id: 'inter_edit', output_image: { data: 'AQID', mime_type: 'image/png' } };
      }),
      {
        prompt: 'Turn this into sunset',
        previousInteractionId: 'inter_prev',
      },
    );
    expect(sent.previous_interaction_id).toBe('inter_prev');
    expect(sent.response_format).toEqual({ type: 'image' });
  });

  it('passes searchGrounding, thinkingLevel, and video-to-image inputs and extracts thoughts and citations', async () => {
    let sent: any;
    const output = await generateGeminiImage(
      interactionsClient(async request => {
        sent = request;
        return {
          id: 'inter_grounded',
          steps: [
            {
              type: 'thought',
              summary: [
                { type: 'text', text: 'Checking composition' },
                { type: 'image', data: 'interim_ignored', mime_type: 'image/png' },
              ],
            },
            {
              type: 'google_search_result',
              search_suggestions: '<div>Search chip</div>',
            },
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: 'Here is the chart',
                  annotations: [{ type: 'url_citation', url: 'https://weather.example/sf', title: 'SF Weather' }],
                },
                { type: 'image', data: 'AQID', mime_type: 'image/png' },
              ],
            },
          ],
        };
      }),
      {
        prompt: 'Weather poster',
        model: 'gemini-3.1-flash-image',
        aspectRatio: '16:9',
        resolution: '0.5K',
        searchGrounding: { web: true, imageSearch: true },
        thinkingLevel: 'high',
        video: { uri: 'https://www.youtube.com/watch?v=UTdfxFyOQTI' },
      },
    );
    expect(sent.tools).toEqual([{ type: 'google_search', search_types: ['web_search', 'image_search'] }]);
    expect(sent.generation_config).toEqual({ thinking_level: 'high' });
    expect(sent.response_format).toEqual({ type: 'image', aspect_ratio: '16:9', image_size: '512' });
    expect(sent.input).toEqual([
      { type: 'text', text: 'Weather poster' },
      { type: 'video', uri: 'https://www.youtube.com/watch?v=UTdfxFyOQTI', mime_type: 'video/mp4' },
    ]);
    expect(output.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(output.thoughtSummary).toBe('Checking composition');
    expect(output.grounding).toEqual({
      citations: [{ url: 'https://weather.example/sf', title: 'SF Weather' }],
      searchSuggestionsHtml: '<div>Search chip</div>',
    });
  });

  it('retrieves a completed interaction by ID without starting a new paid request', async () => {
    const output = await retrieveGeminiImage(
      interactionsClient(
        async () => {
          throw new Error('should not create');
        },
        async id => ({
          id,
          output_image: { data: 'AQID', mime_type: 'image/png' },
        }),
      ),
      'inter_saved',
    );
    expect(output.interactionId).toBe('inter_saved');
    expect([...output.bytes]).toEqual([1, 2, 3]);
  });

  it('validates per-model capabilities before making any paid API call', async () => {
    let calls = 0;
    const sdk = interactionsClient(async () => {
      calls++;
      return { output_image: { data: 'AQID', mime_type: 'image/png' } };
    });
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3-pro-image', aspectRatio: '1:4' })).toThrow('aspect ratio');
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-nano-banana-2.1', resolution: '0.5K' })).toThrow('0.5K');
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3.1-flash-lite-image', resolution: '2K' })).toThrow('1K');
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3.1-flash-lite-image', searchGrounding: { web: true } })).toThrow(/search/i);
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3-pro-image', searchGrounding: { imageSearch: true } })).toThrow('Image search');
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3.1-flash-image', thinkingLevel: 'medium' })).toThrow('thinking');
    expect(() => validateGeminiImageInput({ prompt: 'x', model: 'gemini-3-pro-image', video: { uri: 'https://example.com/v.mp4' } })).toThrow('Video');
    expect(() =>
      validateGeminiImageInput({
        prompt: 'x',
        model: 'gemini-2.5-flash-image',
        references: Array.from({ length: 4 }, () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' })),
      }),
    ).toThrow('3 reference');
    await expect(generateGeminiImage(sdk, { prompt: ' ', model: 'gemini-nano-banana-2.1', aspectRatio: '1:1' })).rejects.toThrow('prompt');
    expect(calls).toBe(0);
  });

  it('remains backwards-compatible with legacy models.generateContent mocks', async () => {
    let sent: any;
    const output = await generateGeminiImage(
      legacyClient(async request => {
        sent = request;
        return { candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/webp', data: 'AQID' } }] } }] };
      }),
      {
        prompt: '# Draw a harbor',
        model: 'configured-image-model',
        aspectRatio: '9:16',
        resolution: '2K',
        reference: { bytes: new Uint8Array([4, 5]), mimeType: 'image/png' },
      },
    );
    expect(sent.contents[0].parts).toEqual([{ inlineData: { data: 'BAU=', mimeType: 'image/png' } }, { text: '# Draw a harbor' }]);
    expect(sent.config.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
    expect(output.mimeType).toBe('image/webp');
    expect([...output.bytes]).toEqual([1, 2, 3]);
  });

  it('prepares a visual brief with source and custom instructions separate from the system instruction', async () => {
    let sent: any;
    const prompt = await adaptGeminiImagePrompt(
      legacyClient(async request => {
        sent = request;
        return { text: ' A visual brief ' };
      }),
      '# Notes',
      'Use watercolor',
      'adaptation-model',
    );
    expect(prompt).toBe('A visual brief');
    expect(JSON.parse(sent.contents)).toEqual({ source: '# Notes', instructions: 'Use watercolor' });
    expect(sent.config.systemInstruction).toContain('one illustration');
    expect(sent.model).toBe('adaptation-model');
  });
});

