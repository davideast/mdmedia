import { GoogleGenAI } from '@google/genai';
import { GeminiImageProvider } from './gemini-image-provider.js';
import { OpenAIImageProvider } from './openai-image-provider.js';
import { PixelLabImageProvider } from './pixellab-image-provider.js';
import { RetroDiffusionImageProvider, type RetroDiffusionOptions } from './retro-diffusion-image-provider.js';
import { IMAGE_PROVIDER_DEFAULTS, normalizeImageProvider } from './selection.js';
import type { IImageProvider, ImageProviderName } from './types.js';

export interface ImageProviderOptions extends RetroDiffusionOptions {
  provider?: ImageProviderName;
  apiKey?: string;
  geminiClient?: GoogleGenAI;
}

export function createImageProvider(options: ImageProviderOptions = {}): IImageProvider {
  const provider = normalizeImageProvider(options.provider ?? 'gemini');
  const apiKey = options.apiKey ?? process.env[IMAGE_PROVIDER_DEFAULTS[provider].envKey] ?? '';
  if (provider === 'gemini') {
    if (!options.geminiClient && !apiKey.trim()) throw new Error('GEMINI_API_KEY is required for image generation.');
    return new GeminiImageProvider(options.geminiClient ?? new GoogleGenAI({ apiKey }));
  }
  if (provider === 'openai') return new OpenAIImageProvider(apiKey, options);
  if (provider === 'pixellab') return new PixelLabImageProvider(apiKey, options);
  return new RetroDiffusionImageProvider(apiKey, options);
}
