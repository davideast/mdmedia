import type { ImageAction, ImageRequest, ImageThinkingLevel } from './media-types';

export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1' as const;
export const IMAGE_MODELS = [
  'gemini-nano-banana-2.1',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-2.5-flash-image',
] as const;
export const STANDARD_IMAGE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
export const EXTENDED_IMAGE_RATIOS = ['1:4', '4:1', '1:8', '8:1'] as const;
export const IMAGE_RATIOS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'] as const;
export const IMAGE_RESOLUTIONS = ['0.5K', '1K', '2K', '4K'] as const;
export const IMAGE_THINKING_LEVELS = ['minimal', 'medium', 'high'] as const;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export const IMAGE_ACTIONS = ['initial', 'refine', 'regenerate'] as const;
export const MAX_IMAGE_PROMPT = 32_000;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_REFERENCES = 14;

const EXTENDED_RATIO_MODELS = new Set<string>(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image']);
const RESOLUTION_1K_ONLY_MODELS = new Set<string>(['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image']);
const IMAGE_SEARCH_MODELS = new Set<string>(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image']);
const VIDEO_INPUT_MODELS = new Set<string>(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image']);
const MODEL_THINKING_LEVELS: Record<string, readonly ImageThinkingLevel[]> = {
  'gemini-nano-banana-2.1': ['minimal', 'medium', 'high'],
  'gemini-3.1-flash-image': ['minimal', 'high'],
  'gemini-3.1-flash-lite-image': ['minimal', 'high'],
};

export const DEFAULT_IMAGE_REQUEST: ImageRequest = {
  prompt: '',
  adaptation: { enabled: false, instructions: '' },
  output: { aspectRatio: '16:9', resolution: null },
  referenceAssetId: null,
};

export class MediaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const validMediaId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function collectReferenceAssetIds(request: Pick<ImageRequest, 'referenceAssetId' | 'referenceAssetIds'>): string[] {
  if (request.referenceAssetIds?.length) return [...request.referenceAssetIds];
  if (request.referenceAssetId) return [request.referenceAssetId];
  return [];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, 'invalid_body', 'Send a JSON object.');
  return value as Record<string, unknown>;
}

function fields(raw: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) throw new MediaError(400, 'unknown_fields', `Unknown fields: ${unknown.join(', ')}.`);
}

export function parseImageRequest(body: unknown, defaults = DEFAULT_IMAGE_REQUEST): ImageRequest {
  const raw = object(body);
  fields(raw, [
    'prompt',
    'model',
    'adaptation',
    'output',
    'referenceAssetId',
    'referenceAssetIds',
    'videoUri',
    'searchGrounding',
    'thinkingLevel',
    'action',
    'fromGenerationId',
  ]);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new MediaError(400, 'missing_prompt', 'Enter a prompt or paste your Markdown.');
  if (raw.prompt.length > MAX_IMAGE_PROMPT) throw new MediaError(400, 'prompt_too_long', `Image prompts are limited to ${MAX_IMAGE_PROMPT} characters.`);

  const rawModel = raw.model === undefined ? defaults.model : raw.model;
  if (rawModel !== undefined && rawModel !== null && !IMAGE_MODELS.includes(rawModel as (typeof IMAGE_MODELS)[number])) {
    throw new MediaError(400, 'invalid_model', `Model must be one of ${IMAGE_MODELS.join(', ')}.`);
  }
  const effectiveModel = typeof rawModel === 'string' ? rawModel : DEFAULT_IMAGE_MODEL;

  const adaptation = raw.adaptation === undefined ? defaults.adaptation : object(raw.adaptation);
  fields(adaptation, ['enabled', 'instructions']);
  const enabled = adaptation.enabled ?? defaults.adaptation.enabled;
  const instructions = adaptation.instructions ?? defaults.adaptation.instructions;
  if (typeof enabled !== 'boolean' || typeof instructions !== 'string' || instructions.length > 4000) {
    throw new MediaError(400, 'invalid_adaptation', 'Adaptation needs an enabled flag and instructions of at most 4,000 characters.');
  }

  const output = raw.output === undefined ? defaults.output : object(raw.output);
  fields(output, ['aspectRatio', 'resolution', 'mimeType']);
  const aspectRatio = output.aspectRatio ?? defaults.output.aspectRatio;
  const resolution = output.resolution === undefined ? defaults.output.resolution : output.resolution;
  const mimeType = output.mimeType === undefined ? defaults.output.mimeType : output.mimeType;

  if (!IMAGE_RATIOS.includes(aspectRatio as (typeof IMAGE_RATIOS)[number])) {
    throw new MediaError(400, 'invalid_aspect_ratio', 'Choose a supported image shape.');
  }
  if ((EXTENDED_IMAGE_RATIOS as readonly string[]).includes(aspectRatio as string) && !EXTENDED_RATIO_MODELS.has(effectiveModel)) {
    throw new MediaError(400, 'invalid_aspect_ratio', `Aspect ratio ${aspectRatio} is only supported on gemini-nano-banana-2.1 and gemini-3.1-flash-image.`);
  }
  if (resolution !== null && !IMAGE_RESOLUTIONS.includes(resolution as (typeof IMAGE_RESOLUTIONS)[number])) {
    throw new MediaError(400, 'invalid_resolution', 'Resolution must be 0.5K, 1K, 2K, 4K, or null for the model default.');
  }
  if (resolution === '0.5K' && effectiveModel !== 'gemini-3.1-flash-image') {
    throw new MediaError(400, 'invalid_resolution', 'Resolution 0.5K is only supported on gemini-3.1-flash-image.');
  }
  if ((resolution === '2K' || resolution === '4K') && RESOLUTION_1K_ONLY_MODELS.has(effectiveModel)) {
    throw new MediaError(400, 'invalid_resolution', `Model ${effectiveModel} only supports 1K resolution.`);
  }
  if (mimeType !== undefined && mimeType !== null && !IMAGE_MIME_TYPES.includes(mimeType as (typeof IMAGE_MIME_TYPES)[number])) {
    throw new MediaError(400, 'invalid_mime_type', 'Output mimeType must be image/png or image/jpeg.');
  }

  let referenceAssetId = raw.referenceAssetId === undefined ? defaults.referenceAssetId : raw.referenceAssetId;
  if (referenceAssetId !== null && (typeof referenceAssetId !== 'string' || !validMediaId(referenceAssetId))) {
    throw new MediaError(400, 'invalid_reference', 'Choose an uploaded reference image.');
  }

  let referenceAssetIds: string[] | undefined;
  const rawReferenceIds =
    raw.referenceAssetIds !== undefined
      ? raw.referenceAssetIds
      : raw.referenceAssetId !== undefined
        ? undefined
        : defaults.referenceAssetIds;
  if (rawReferenceIds !== undefined && rawReferenceIds !== null) {
    if (!Array.isArray(rawReferenceIds) || rawReferenceIds.some(id => typeof id !== 'string' || !validMediaId(id))) {
      throw new MediaError(400, 'invalid_reference', 'Choose valid uploaded reference images.');
    }
    const maxRefs = effectiveModel === 'gemini-2.5-flash-image' ? 3 : MAX_IMAGE_REFERENCES;
    const deduped = Array.from(new Set(rawReferenceIds as string[]));
    if (deduped.length > maxRefs) {
      throw new MediaError(400, 'too_many_references', `At most ${maxRefs} reference images are allowed for ${effectiveModel}.`);
    }
    referenceAssetIds = deduped;
    if (raw.referenceAssetIds !== undefined) {
      referenceAssetId = deduped[0] ?? null;
    }
  }

  const rawVideoUri = raw.videoUri === undefined ? defaults.videoUri : raw.videoUri;
  let videoUri: string | null | undefined;
  if (rawVideoUri !== undefined && rawVideoUri !== null && rawVideoUri !== '') {
    if (typeof rawVideoUri !== 'string' || rawVideoUri.length > 2048) {
      throw new MediaError(400, 'invalid_video_uri', 'Provide a valid HTTPS video URL.');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawVideoUri);
    } catch {
      throw new MediaError(400, 'invalid_video_uri', 'Provide a valid HTTPS video URL.');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new MediaError(400, 'invalid_video_uri', 'Video URL must use https.');
    }
    if (!VIDEO_INPUT_MODELS.has(effectiveModel)) {
      throw new MediaError(400, 'invalid_video_uri', `Video-to-image input is not supported on ${effectiveModel}.`);
    }
    videoUri = rawVideoUri;
  } else if (rawVideoUri === null) {
    videoUri = null;
  }

  const rawSearch = raw.searchGrounding === undefined ? defaults.searchGrounding : raw.searchGrounding;
  let searchGrounding: { web: boolean; imageSearch: boolean } | undefined;
  if (rawSearch !== undefined && rawSearch !== null) {
    const sg = object(rawSearch);
    fields(sg, ['web', 'imageSearch']);
    if (sg.web !== undefined && typeof sg.web !== 'boolean') {
      throw new MediaError(400, 'invalid_search_grounding', 'searchGrounding.web must be a boolean.');
    }
    if (sg.imageSearch !== undefined && typeof sg.imageSearch !== 'boolean') {
      throw new MediaError(400, 'invalid_search_grounding', 'searchGrounding.imageSearch must be a boolean.');
    }
    const web = sg.web ?? defaults.searchGrounding?.web ?? false;
    const imageSearch = sg.imageSearch ?? defaults.searchGrounding?.imageSearch ?? false;
    if (web || imageSearch) {
      if (effectiveModel === 'gemini-3.1-flash-lite-image' || effectiveModel === 'gemini-2.5-flash-image') {
        throw new MediaError(400, 'invalid_search_grounding', `Google Search grounding is not supported on ${effectiveModel}.`);
      }
      if (imageSearch && !IMAGE_SEARCH_MODELS.has(effectiveModel)) {
        throw new MediaError(400, 'invalid_search_grounding', 'Image search grounding is only supported on gemini-nano-banana-2.1 and gemini-3.1-flash-image.');
      }
    }
    searchGrounding = { web, imageSearch };
  }

  const rawThinking = raw.thinkingLevel === undefined ? defaults.thinkingLevel : raw.thinkingLevel;
  let thinkingLevel: ImageThinkingLevel | null | undefined;
  if (rawThinking !== undefined && rawThinking !== null && rawThinking !== '') {
    if (!IMAGE_THINKING_LEVELS.includes(rawThinking as ImageThinkingLevel)) {
      throw new MediaError(400, 'invalid_thinking_level', 'thinkingLevel must be minimal, medium, or high.');
    }
    const allowed = MODEL_THINKING_LEVELS[effectiveModel];
    if (!allowed || !allowed.includes(rawThinking as ImageThinkingLevel)) {
      throw new MediaError(
        400,
        'invalid_thinking_level',
        allowed
          ? `Model ${effectiveModel} only supports thinking levels: ${allowed.join(', ')}.`
          : `Configurable thinking level is not supported on ${effectiveModel}.`,
      );
    }
    thinkingLevel = rawThinking as ImageThinkingLevel;
  } else if (rawThinking === null) {
    thinkingLevel = null;
  }

  const rawAction = raw.action;
  let action: ImageAction | undefined;
  if (rawAction !== undefined) {
    if (!IMAGE_ACTIONS.includes(rawAction as ImageAction)) {
      throw new MediaError(400, 'invalid_action', 'Action must be initial, refine, or regenerate.');
    }
    action = rawAction as ImageAction;
  }

  const rawFromGen = raw.fromGenerationId;
  let fromGenerationId: string | null | undefined;
  if (rawFromGen !== undefined && rawFromGen !== null) {
    if (typeof rawFromGen !== 'string' || !validMediaId(rawFromGen)) {
      throw new MediaError(400, 'invalid_generation', 'fromGenerationId must be a valid generation ID.');
    }
    fromGenerationId = rawFromGen;
  } else if (rawFromGen === null) {
    fromGenerationId = null;
  }

  const parsedOutput: ImageRequest['output'] = {
    aspectRatio: aspectRatio as string,
    resolution: resolution as string | null,
    ...(mimeType !== undefined ? { mimeType: mimeType as 'image/png' | 'image/jpeg' | null } : {}),
  };

  return {
    prompt: raw.prompt,
    ...(typeof rawModel === 'string' ? { model: rawModel } : {}),
    adaptation: { enabled, instructions },
    output: parsedOutput,
    referenceAssetId: referenceAssetId as string | null,
    ...(referenceAssetIds !== undefined ? { referenceAssetIds } : {}),
    ...(videoUri !== undefined ? { videoUri } : {}),
    ...(searchGrounding !== undefined ? { searchGrounding } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(fromGenerationId !== undefined ? { fromGenerationId } : {}),
  };
}

export function readImageDefaults(value: unknown): ImageRequest {
  try {
    const parsed = parseImageRequest({ ...object(value), prompt: 'defaults' });
    delete parsed.referenceAssetIds;
    delete parsed.videoUri;
    delete parsed.action;
    delete parsed.fromGenerationId;
    return { ...parsed, prompt: '', referenceAssetId: null };
  } catch {
    return structuredClone(DEFAULT_IMAGE_REQUEST);
  }
}

export function readIdempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{10,128}$/.test(key)) {
    throw new MediaError(400, 'invalid_idempotency_key', 'Send an Idempotency-Key header containing 10–128 letters, numbers, underscores, or hyphens.');
  }
  return key;
}

