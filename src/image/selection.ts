import type { ImageRequest, ImageSelection, ImageSettings, ImageProviderName } from './types.js';
import { imageMimeType, isOpaqueRgbPng } from './image-data.js';

/** The image request's config: aspect ratio, and the output size when one is asked for. */
export function imageGenerationConfig(
  aspectRatio: string,
  size?: string,
): { aspectRatio: string; imageSize?: '1K' | '2K' | '4K' } {
  if (size === undefined || size === '') return { aspectRatio };
  const imageSize = size.toUpperCase();
  if (imageSize !== '1K' && imageSize !== '2K' && imageSize !== '4K') {
    throw new Error(`--size must be 1K, 2K or 4K (got ${size})`);
  }
  return { aspectRatio, imageSize };
}

export const IMAGE_PROVIDER_DEFAULTS = {
  gemini: { model: 'gemini-3-pro-image', envKey: 'GEMINI_API_KEY' },
  openai: { model: 'gpt-image-2.5-flare', envKey: 'OPENAI_API_KEY' },
  retrodiffusion: { model: 'rd_fast', envKey: 'RETRODIFFUSION_API_KEY' },
  pixellab: { model: 'pixflux', envKey: 'PIXELLAB_API_KEY' },
} as const;

export function normalizeImageProvider(name: string): ImageProviderName {
  const normalized = name.trim().toLowerCase();
  if (!Object.hasOwn(IMAGE_PROVIDER_DEFAULTS, normalized)) {
    throw new Error(`Unknown image provider "${name}". Available: ${Object.keys(IMAGE_PROVIDER_DEFAULTS).join(', ')}.`);
  }
  return normalized as ImageProviderName;
}

export function resolveImageSelection({
  requested = {}, configured = {}, legacyApiKey, env = process.env,
}: {
  requested?: ImageSettings;
  configured?: ImageSettings;
  legacyApiKey?: string;
  env?: Record<string, string | undefined>;
} = {}): ImageSelection {
  const provider = normalizeImageProvider(requested.provider ?? configured.provider ?? env.MDMEDIA_IMAGE_PROVIDER ?? 'gemini');
  const sameProvider = provider === normalizeImageProvider(configured.provider ?? 'gemini');
  const config = sameProvider ? configured : {};
  const defaults = IMAGE_PROVIDER_DEFAULTS[provider];
  const selection: ImageSelection = {
    ...config, ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined)), provider,
    model: requested.model ?? config.model ?? defaults.model,
    apiKey: requested.apiKey ?? config.apiKey ?? (provider === 'gemini' ? legacyApiKey : undefined) ?? env[defaults.envKey],
  };
  if (provider !== 'gemini' && requested.size !== undefined && requested.aspectRatio === undefined) selection.aspectRatio = undefined;
  if (provider !== 'gemini' && requested.aspectRatio !== undefined && requested.size === undefined) selection.size = undefined;
  if (provider === 'gemini' && selection.aspectRatio === undefined) selection.aspectRatio = '16:9';
  if (selection.size === undefined && selection.aspectRatio === undefined) {
    if (provider === 'gemini' || provider === 'openai') selection.aspectRatio = '16:9';
    else selection.size = '128x128';
  }
  return selection;
}

export function parseImageSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error('Image size must be WIDTHxHEIGHT, for example 128x128.');
  const width = Number(match[1]), height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('Image dimensions must be positive integers.');
  }
  return { width, height };
}

const OPENAI_ASPECT_SIZES: Record<string, string> = {
  '1:1': '1024x1024', '16:9': '1536x864', '9:16': '864x1536',
  '3:2': '1536x1024', '2:3': '1024x1536', '4:3': '1536x1152', '3:4': '1152x1536',
};
const GEMINI_ASPECTS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
/** Curated still-image styles with documented size bounds; animation/tileset/3D styles use other contracts. */
export const RETRO_STILL_STYLES: Record<string, readonly string[]> = {
  rd_fast: ['default', 'simple', 'detailed', 'retro', 'portrait'],
  rd_plus: ['default', 'retro', 'cartoon', 'environment', 'isometric'],
  rd_pro: ['default', 'painterly', 'fantasy', 'scifi', 'isometric'],
};

/** Normalize only supported controls; reject invalid requests before a paid submission. */
export function validateImageRequest(provider: ImageProviderName, request: ImageRequest): ImageRequest {
  const normalized = { ...request };
  if (!request.prompt.trim()) throw new Error('An image prompt is required.');
  if (!request.model.trim()) throw new Error('Image model must not be empty.');
  if (!['png', 'jpeg', 'webp'].includes(request.format)) throw new Error('Image format must be png, jpeg or webp.');
  if (request.background !== undefined && !['auto', 'opaque', 'transparent'].includes(request.background)) throw new Error('Invalid image background.');
  if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 2147483647)) throw new Error('Image seed must be an integer between 0 and 2147483647.');
  if (request.reference && imageMimeType(request.reference.bytes) !== request.reference.mimeType) throw new Error('Reference MIME type does not match the image bytes.');
  if (provider !== 'gemini' && request.size && request.aspectRatio) throw new Error('Choose either --size or --aspectRatio, not both.');
  if (provider !== 'openai' && request.quality !== undefined) throw new Error('--quality is supported only by openai.');
  if (provider !== 'retrodiffusion' && request.style !== undefined) throw new Error('--style is supported only by retrodiffusion.');
  if ((provider === 'gemini' || provider === 'openai') && request.seed !== undefined) throw new Error(`--seed is not supported by ${provider}.`);
  if (provider === 'gemini') {
    normalized.size = imageGenerationConfig(request.aspectRatio ?? '16:9', request.size).imageSize;
    if (request.background !== undefined) throw new Error('--background is not supported by the Gemini image adapter.');
    if (request.aspectRatio && !GEMINI_ASPECTS.has(request.aspectRatio)) throw new Error('Unsupported Gemini image aspect ratio.');
  } else if (provider === 'openai') {
    if (!/^gpt-image-2\.5-(sunburst|flare)(-2026-09-08)?$/.test(request.model)) {
      throw new Error('OpenAI image model must be gpt-image-2.5-sunburst or gpt-image-2.5-flare (optionally -2026-09-08).');
    }
    if (request.prompt.length > 32000) throw new Error('OpenAI image prompts must not exceed 32000 characters.');
    if (request.quality !== undefined && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.quality)) throw new Error('Invalid GPT Image 2.5 quality.');
    if (request.aspectRatio) {
      normalized.size = OPENAI_ASPECT_SIZES[request.aspectRatio];
      if (!normalized.size) throw new Error('Unsupported OpenAI aspect ratio; use --size WIDTHxHEIGHT instead.');
      normalized.aspectRatio = undefined;
    }
    if (normalized.size && normalized.size !== 'auto') {
      const { width, height } = parseImageSize(normalized.size);
      const pixels = width * height;
      if (width % 16 || height % 16 || Math.max(width, height) > 3840 ||
          Math.max(width, height) / Math.min(width, height) > 3 || pixels < 655360 || pixels > 8294400) {
        throw new Error('GPT Image 2.5 size needs multiples of 16, edges <=3840, aspect <=3:1, and 655360–8294400 pixels.');
      }
    }
  } else {
    if (request.aspectRatio !== undefined) throw new Error(`${provider} requires native pixel dimensions with --size, not --aspectRatio.`);
    if (request.format !== 'png') throw new Error(`${provider} produces PNG; choose a .png output.`);
    const { width, height } = parseImageSize(request.size ?? '128x128');
    if (provider === 'retrodiffusion') {
      if (!['rd_fast', 'rd_plus', 'rd_pro'].includes(request.model)) throw new Error('Retro Diffusion model must be rd_fast, rd_plus or rd_pro.');
      const min = request.model === 'rd_pro' ? 12 : 64;
      const max = request.model === 'rd_pro' ? 256 : 384;
      if (width < min || height < min || width > max || height > max) throw new Error(`${request.model} dimensions must be ${min}–${max} pixels per side.`);
      if (request.style !== undefined && !request.style.startsWith(`${request.model}__`)) throw new Error('--style must be a full Retro style ID matching --model, for example rd_fast__default.');
      if (request.style !== undefined && !RETRO_STILL_STYLES[request.model].some((name) => request.style === `${request.model}__${name}`)) throw new Error('Unsupported Retro still-image style; animation, tileset and 3D styles require separate output contracts.');
      if (request.reference && request.reference.mimeType !== 'image/png') throw new Error('Retro initialization requires a PNG reference. Convert it to RGB PNG first.');
      if (request.reference && !isOpaqueRgbPng(request.reference.bytes)) throw new Error('Retro initialization requires RGB PNG without transparency.');
      if (request.reference && request.model === 'rd_pro') throw new Error('The current Retro initialization adapter supports rd_fast and rd_plus; rd_pro style references need a separate reference control.');
      normalized.style = request.style ?? `${request.model}__default`;
    } else {
      if (!['pixflux', 'pixen'].includes(request.model)) throw new Error('PixelLab model must be pixflux or pixen.');
      const area = width * height;
      if (request.model === 'pixflux') {
        if (width < 16 || height < 16 || width > 400 || height > 400 || area < 1024 || area > 160000) throw new Error('Pixflux dimensions need sides 16–400 and area 1024–160000 pixels.');
        if (request.background === 'transparent' && area > 40000) throw new Error('Pixflux only supports transparent output up to 200x200 area; choose pixen for larger transparent images.');
        if (request.reference && !['image/png', 'image/jpeg'].includes(request.reference.mimeType)) throw new Error('Pixflux initialization requires a PNG or JPEG reference.');
      } else {
        if (width < 16 || height < 16 || width > 768 || height > 768 || width % 4 || height % 4 || area > 262144 || (Math.min(width, height) < 32 && width !== height)) throw new Error('Pixen needs sides 16–768 in multiples of 4, area <=512x512, and square dimensions below 32 pixels.');
        if (request.reference) throw new Error('Pixen does not support --ref; choose pixflux for image initialization.');
      }
    }
  }
  if (request.reference) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(request.reference.mimeType)) throw new Error('Reference must be a PNG, JPEG or WebP image.');
    if (request.reference.bytes.byteLength === 0) throw new Error('Reference image is empty.');
    if (provider === 'openai' && request.reference.bytes.byteLength > 15 * 1024 * 1024) throw new Error('OpenAI reference is too large for the inline JSON edit request (maximum 15 MiB).');
  }
  if (request.background === 'transparent' && request.format === 'jpeg') throw new Error('Transparent images require PNG or WebP output.');
  return normalized;
}
