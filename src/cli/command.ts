import { defineCommand } from 'citty';
import { studioCommand } from './studio-command.js';
import { cutCommand } from './cut-command.js';
import { productionCommand } from './production-command.js';
import { commentsCommand } from './comments-command.js';
import { characterCommand } from './character-command.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';
import { loadConfigFile, resolveConfig } from '../config/index.js';
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  THINKING_LEVELS,
  adaptGeminiImagePrompt,
  generateGeminiImage,
  type GeminiImageClient,
  type ImageAspectRatio,
  type ImageOutput,
  type ImageReference,
  type ImageResolution,
  type ImageThinkingLevel,
} from '../image/index.js';
import {
  runAudioSynthesis,
  runNarrationAdaptation,
  runVideoGeneration,
  runMusicGeneration,
  runSoundEffectGeneration,
} from './runner.js';
import { resolveTTSSelection } from '../tts/provider-registry.js';
import { ElevenLabsVoiceCatalog } from '../tts/elevenlabs-voices.js';

const _require = createRequire(import.meta.url);
const { version: pkgVersion } = _require('../../package.json');

export const audioCommand = defineCommand({
  meta: {
    name: 'audio',
    description: 'Convert markdown documents into spoken audio narration via Gemini or ElevenLabs',
  },
  args: {
    input: {
      type: 'string',
      alias: 'i',
      description: 'Path to input markdown (.md) file',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Path for output audio (.wav) file',
      default: 'output.wav',
    },
    provider: {
      type: 'string',
      description: 'TTS provider (gemini or elevenlabs)',
    },
    voice: {
      type: 'string',
      alias: 'v',
      description: 'Gemini voice name or ElevenLabs voice name/ID',
    },
    style: {
      type: 'string',
      alias: 's',
      description: 'Gemini delivery note (not supported with ElevenLabs)',
    },
    maxChars: {
      type: 'string',
      alias: 'c',
      description: 'Maximum characters per document chunk',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model name for the selected TTS provider',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'API key for the selected TTS provider',
    },
    maxRetries: {
      type: 'string',
      description: 'Max retry attempts for API calls',
    },
    play: {
      type: 'boolean',
      alias: 'p',
      description: 'Play audio in real-time through speakers as chunks stream',
      default: false,
    },
    narration: {
      type: 'boolean',
      alias: 'n',
      description: 'Rewrite document into audio-narration-optimized script before TTS',
      default: false,
    },
    narrationModel: {
      type: 'string',
      description: 'Gemini model for narration rewriting (defaults to gemini-3.5-flash-lite)',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose audio streaming delta logs',
      default: false,
    },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const resolved = resolveConfig(
      {
        mode: 'audio',
        audioProvider: args.provider,
        voice: args.voice as VoiceName | undefined,
        style: args.style,
        audioModel: args.model,
        maxChars: args.maxChars ? Number(args.maxChars) : undefined,
        apiKey: args.apiKey,
        maxRetries: args.maxRetries ? Number(args.maxRetries) : undefined,
        play: args.play,
        narration: args.narration,
        narrationModel: args.narrationModel,
      },
      fileConfig
    );

    await runAudioSynthesis({
      input: args.input,
      output: args.output,
      provider: resolved.audio.provider,
      voice: resolved.audio.voice,
      style: resolved.audio.style,
      maxChars: resolved.maxChars,
      model: resolved.audio.model,
      apiKey: resolved.apiKey,
      maxRetries: resolved.maxRetries,
      play: resolved.audio.play,
      verbose: args.verbose,
      narration: resolved.narration.enabled,
      narrationModel: resolved.narration.model,
    });
  },
});

export const voicesCommand = defineCommand({
  meta: {
    name: 'voices',
    description: 'List ElevenLabs voice names and IDs available to your API key',
  },
  args: {
    search: {
      type: 'string',
      alias: 's',
      description: 'Filter ElevenLabs voices by name or description',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'ElevenLabs API key (defaults to ELEVENLABS_API_KEY)',
    },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const selection = resolveTTSSelection({
      requested: { provider: 'elevenlabs', apiKey: args.apiKey },
      configured: fileConfig.audio,
      env: process.env,
    });
    const voices = await new ElevenLabsVoiceCatalog(selection.apiKey ?? '').list(args.search);
    if (voices.length === 0) {
      console.log('No ElevenLabs voices found.');
      return;
    }
    for (const voice of voices) console.log(`${voice.name}\t${voice.id}`);
  },
});

export const videoCommand = defineCommand({
  meta: {
    name: 'video',
    description: 'Generate video clips from markdown storyboards via Gemini Omni Flash',
  },
  args: {
    input: {
      type: 'string',
      alias: 'i',
      description: 'Path to input markdown (.md) storyboard file',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Path for output video (.mp4) file',
      default: 'output.mp4',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Gemini Omni Flash model name',
    },
    aspectRatio: {
      type: 'string',
      alias: ['a', 'aspect'],
      description: 'Video aspect ratio ("16:9" or "9:16")',
    },
    task: {
      type: 'string',
      alias: 't',
      description: 'Video task ("text_to_video", "image_to_video", "reference_to_video", "edit", "extend")',
    },
    delivery: {
      type: 'string',
      description: 'Delivery mode ("uri" for large files or "inline")',
    },
    ref: {
      type: 'string',
      alias: 'r',
      description: 'Comma-separated reference image paths',
    },
    firstFrame: {
      type: 'string',
      description: 'Path to starting image frame',
    },
    interactionId: {
      type: 'string',
      description: 'Previous interaction ID for stateful iterative video editing',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
    maxRetries: {
      type: 'string',
      description: 'Max retry attempts for API calls',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: false,
    },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const referenceImages = args.ref
      ? args.ref.split(',').map((s) => s.trim())
      : undefined;

    const resolved = resolveConfig(
      {
        mode: 'video',
        videoModel: args.model,
        aspectRatio: args.aspectRatio as AspectRatio | undefined,
        task: args.task as VideoTask | undefined,
        delivery: args.delivery as DeliveryMode | undefined,
        referenceImages,
        firstFrame: args.firstFrame,
        previousInteractionId: args.interactionId,
        apiKey: args.apiKey,
        maxRetries: args.maxRetries ? Number(args.maxRetries) : undefined,
      },
      fileConfig
    );

    await runVideoGeneration({
      input: args.input,
      output: args.output,
      model: resolved.video.model,
      aspectRatio: resolved.video.aspectRatio,
      task: resolved.video.task,
      delivery: resolved.video.delivery,
      referenceImages: resolved.video.referenceImages,
      firstFrame: resolved.video.firstFrame,
      previousInteractionId: resolved.video.previousInteractionId,
      apiKey: resolved.apiKey,
      maxRetries: resolved.maxRetries,
      verbose: args.verbose,
    });
  },
});

export const adaptCommand = defineCommand({
  meta: {
    name: 'adapt',
    description: 'Transform markdown documents into audio-narration-optimized scripts via Gemini Flash Lite',
  },
  args: {
    input: {
      type: 'string',
      alias: 'i',
      description: 'Path to input markdown (.md) file',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Optional path for output narration script (.md) file (defaults to stdout)',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Gemini model name (defaults to gemini-3.5-flash-lite or config)',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logs',
      default: false,
    },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const resolved = resolveConfig(
      {
        narrationModel: args.model,
        apiKey: args.apiKey,
      },
      fileConfig
    );

    await runNarrationAdaptation({
      input: args.input,
      output: args.output,
      model: resolved.narration.model,
      apiKey: resolved.apiKey,
      verbose: args.verbose,
    });
  },
});

/** The image request's config: aspect ratio, and the output size when one is asked for. */
export function imageGenerationConfig(
  aspectRatio?: string | null,
  size?: string,
  options?: { hasReference?: boolean; hasInteractionId?: boolean },
): { aspectRatio: ImageAspectRatio | null; imageSize?: ImageResolution } {
  const trimmedAspect = typeof aspectRatio === 'string' ? aspectRatio.trim() : aspectRatio;
  const resolvedAspect: ImageAspectRatio | null =
    trimmedAspect === null
      ? null
      : trimmedAspect
        ? (() => {
            if (!(IMAGE_ASPECT_RATIOS as readonly string[]).includes(trimmedAspect)) {
              throw new Error(
                `--aspect must be one of ${IMAGE_ASPECT_RATIOS.join(', ')} (got ${aspectRatio})`,
              );
            }
            return trimmedAspect as ImageAspectRatio;
          })()
        : options?.hasReference || options?.hasInteractionId
          ? null
          : '16:9';

  if (size === undefined || size.trim() === '') return { aspectRatio: resolvedAspect };
  const imageSize = size.trim().toUpperCase();
  if (!(IMAGE_RESOLUTIONS as readonly string[]).includes(imageSize)) {
    throw new Error(`--size must be 0.5K, 1K, 2K or 4K (got ${size})`);
  }
  return { aspectRatio: resolvedAspect, imageSize: imageSize as ImageResolution };
}

export function inferImageOutputMimeType(outputPath: string): 'image/png' | 'image/jpeg' {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}

function detectActualImageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpeg';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

function convertImageFile(sourcePath: string, targetPath: string, targetFormat: 'png' | 'jpeg' | 'webp'): void {
  if (process.platform === 'darwin') {
    execFileSync('sips', ['-s', 'format', targetFormat, sourcePath, '--out', targetPath]);
    return;
  }
  for (const cmd of ['magick', 'convert']) {
    try {
      execFileSync(cmd, [sourcePath, targetPath], { stdio: 'ignore' });
      if (fs.existsSync(targetPath)) return;
    } catch {}
  }
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sourcePath, targetPath], { stdio: 'ignore' });
    if (fs.existsSync(targetPath)) return;
  } catch {}
  throw new Error(
    `Image format conversion to ${targetFormat.toUpperCase()} requires sips (macOS), ImageMagick (magick/convert), or ffmpeg.`,
  );
}

export function readReferenceImage(filePath: string): ImageReference {
  const trimmed = filePath.trim();
  if (!fs.existsSync(trimmed)) {
    throw new Error(`Reference image not found: ${trimmed}`);
  }
  let refPath = trimmed;
  let ext = path.extname(refPath).toLowerCase();
  let tmpPng: string | undefined;
  if (ext === '.avif') {
    tmpPng = path.join(os.tmpdir(), `mdmedia_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
    convertImageFile(refPath, tmpPng, 'png');
    refPath = tmpPng;
    ext = '.png';
  }
  const mimeType =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const refBytes = fs.readFileSync(refPath);
  if (tmpPng) {
    try {
      fs.unlinkSync(tmpPng);
    } catch {}
  }
  return {
    bytes: new Uint8Array(refBytes),
    mimeType,
  };
}

export interface RunImageCommandArgs {
  prompt?: string;
  input?: string;
  ref?: string;
  output: string;
  model?: string;
  aspectRatio?: string;
  size?: string;
  interactionId?: string;
  search?: boolean;
  imageSearch?: boolean;
  thinking?: string;
  video?: string;
  adapt?: boolean;
  instructions?: string;
  apiKey?: string;
}

export async function runImageGeneration(
  args: RunImageCommandArgs,
  deps?: {
    cwd?: string;
    client?: GeminiImageClient & Partial<Pick<GoogleGenAI, 'models'>>;
    env?: Record<string, string | undefined>;
  },
): Promise<ImageOutput> {
  const cwd = deps?.cwd ?? process.cwd();
  let promptText = args.prompt || '';
  if (!promptText && args.input) {
    promptText = fs.readFileSync(path.resolve(cwd, args.input), 'utf8').trim();
  }
  if (!promptText) {
    throw new Error('Either --prompt (-p) or --input (-i) must be provided.');
  }

  const fileConfig = await loadConfigFile(cwd);
  const thinkingRaw = args.thinking ?? fileConfig.image?.thinkingLevel;
  let thinkingLevel: ImageThinkingLevel | undefined;
  if (thinkingRaw !== undefined && thinkingRaw.trim() !== '') {
    const normalized = thinkingRaw.trim().toLowerCase();
    if (!(THINKING_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error(
        `--thinking must be one of ${THINKING_LEVELS.join(', ')} (got "${thinkingRaw}")`,
      );
    }
    thinkingLevel = normalized as ImageThinkingLevel;
  }

  const resolved = resolveConfig(
    {
      mode: 'image',
      imageModel: args.model,
      imageAspectRatio: args.aspectRatio,
      imageResolution: args.size,
      imageThinkingLevel: thinkingLevel,
      imageAdapt: args.adapt,
      imageInstructions: args.instructions,
      imageSearch: args.search,
      imageImageSearch: args.imageSearch,
      apiKey: args.apiKey,
    },
    fileConfig,
    deps?.env ?? process.env,
  );

  const refPaths = args.ref
    ? args.ref
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (refPaths.length > 14) {
    throw new Error(`At most 14 reference images are supported (got ${refPaths.length}).`);
  }
  const references = refPaths.map((filePath) => readReferenceImage(filePath));

  const interactionId = args.interactionId?.trim() || undefined;
  const imageConfig = imageGenerationConfig(
    resolved.image.aspectRatio,
    resolved.image.resolution,
    {
      hasReference: references.length > 0,
      hasInteractionId: Boolean(interactionId),
    },
  );

  const apiKey = resolved.apiKey;
  if (!apiKey && !deps?.client) {
    throw new Error('GEMINI_API_KEY environment variable is required.');
  }

  const client =
    deps?.client ??
    await (async () => {
      const { GoogleGenAI } = await import('@google/genai');
      return new GoogleGenAI({ apiKey: apiKey! });
    })();

  const instructions = resolved.image.instructions;
  const shouldAdapt =
    args.adapt !== undefined
      ? args.adapt || args.instructions !== undefined
      : Boolean(
          args.instructions !== undefined ||
            resolved.image.adapt ||
            resolved.image.instructions,
        );
  if (shouldAdapt) {
    if (!client.models) {
      throw new Error('Gemini client must provide models.generateContent for prompt adaptation.');
    }
    promptText = await adaptGeminiImagePrompt(
      client as Pick<GoogleGenAI, 'models'>,
      promptText,
      instructions ?? '',
    );
  }

  const mimeType = inferImageOutputMimeType(args.output);
  const webSearch = Boolean(resolved.image.search);
  const imgSearch = Boolean(resolved.image.imageSearch);
  const videoUri = args.video?.trim() || undefined;

  const image = await generateGeminiImage(client, {
    prompt: promptText,
    model: resolved.image.model,
    aspectRatio: imageConfig.aspectRatio,
    ...(imageConfig.imageSize ? { resolution: imageConfig.imageSize } : {}),
    mimeType,
    ...(references.length === 1 ? { reference: references[0] } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(videoUri ? { video: { uri: videoUri } } : {}),
    ...(interactionId ? { previousInteractionId: interactionId } : {}),
    ...(webSearch || imgSearch
      ? {
          searchGrounding: {
            ...(webSearch ? { web: true } : {}),
            ...(imgSearch ? { imageSearch: true } : {}),
          },
        }
      : {}),
    ...(resolved.image.thinkingLevel ? { thinkingLevel: resolved.image.thinkingLevel } : {}),
  });

  const outPath = path.resolve(cwd, args.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const actualFormat = detectActualImageFormat(image.bytes);
  const outExt = path.extname(outPath).toLowerCase();
  const desiredFormat: 'png' | 'jpeg' | 'webp' | null =
    outExt === '.png' ? 'png' : outExt === '.webp' ? 'webp' : outExt === '.jpg' || outExt === '.jpeg' ? 'jpeg' : null;
  if (actualFormat && desiredFormat && actualFormat !== desiredFormat) {
    const tmpSource = path.join(
      os.tmpdir(),
      `mdmedia_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${actualFormat === 'jpeg' ? 'jpg' : actualFormat}`,
    );
    try {
      fs.writeFileSync(tmpSource, Buffer.from(image.bytes));
      convertImageFile(tmpSource, outPath, desiredFormat);
    } finally {
      try {
        fs.unlinkSync(tmpSource);
      } catch {}
    }
  } else {
    fs.writeFileSync(outPath, Buffer.from(image.bytes));
  }
  console.log(`Saved image to ${outPath}`);
  if (image.interactionId) {
    console.log(`Interaction ID: ${image.interactionId}`);
  }
  return image;
}

export const imageCommand = defineCommand({
  meta: {
    name: 'image',
    description: 'Generate high-fidelity art & UI images from prompts via Gemini Nano Banana',
  },
  args: {
    prompt: {
      type: 'string',
      alias: 'p',
      description: 'Text prompt for image generation',
    },
    input: {
      type: 'string',
      alias: 'i',
      description: 'Optional path to input prompt/markdown file',
    },
    ref: {
      type: 'string',
      alias: 'r',
      description: 'Optional comma-separated reference image paths (up to 14 files)',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output image file path (.jpg or .png)',
      required: true,
    },
    model: {
      type: 'string',
      alias: 'm',
      description: `Gemini image model name (defaults to ${DEFAULT_IMAGE_MODEL})`,
    },
    aspectRatio: {
      type: 'string',
      alias: ['a', 'aspect'],
      description: `Aspect ratio (${IMAGE_ASPECT_RATIOS.join(', ')})`,
    },
    size: {
      type: 'string',
      alias: ['s', 'image-size', 'imageSize', 'resolution'],
      description: 'Output resolution: 0.5K, 1K, 2K or 4K (defaults to the model choice, 1K)',
    },
    interactionId: {
      type: 'string',
      description: 'Previous interaction ID for multi-turn image editing',
    },
    search: {
      type: 'boolean',
      description: 'Ground image generation with Google Web Search',
    },
    imageSearch: {
      type: 'boolean',
      description: 'Ground image generation with Google Image Search',
    },
    thinking: {
      type: 'string',
      description: 'Thinking level: minimal, medium, or high',
    },
    video: {
      type: 'string',
      description: 'HTTPS or YouTube video URL for video-to-image generation',
    },
    adapt: {
      type: 'boolean',
      description: 'Adapt Markdown notes into a visual brief before generating',
    },
    instructions: {
      type: 'string',
      description: 'Visual adaptation instructions (implies --adapt)',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
  },
  async run({ args }) {
    await runImageGeneration(args);
  },
});

export const musicCommand = defineCommand({
  meta: {
    name: 'music',
    description: 'Generate music and songs from text prompts via Lyria 3.5',
  },
  args: {
    prompt: {
      type: 'string',
      alias: 'p',
      description: 'Text prompt describing the music to generate',
    },
    input: {
      type: 'string',
      alias: 'i',
      description: 'Path to input markdown (.md) file with song prompt/lyrics',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Path for output audio file (.mp3 or .wav)',
      default: 'output.mp3',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Lyria model name (lyria-3.5 or lyria-3-clip-preview)',
    },
    clip: {
      type: 'boolean',
      description: 'Use Lyria 3 Clip model for a 30-second preview clip',
      default: false,
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format (mp3 or wav)',
    },
    ref: {
      type: 'string',
      alias: 'r',
      description: 'Comma-separated reference image paths for image-inspired music',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
    maxRetries: {
      type: 'string',
      description: 'Max retry attempts for API calls',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: false,
    },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const referenceImages = args.ref
      ? args.ref.split(',').map((s) => s.trim())
      : undefined;

    const effectiveModel = args.clip ? 'lyria-3-clip-preview' : args.model;

    const resolved = resolveConfig(
      {
        mode: 'music',
        musicModel: effectiveModel,
        outputFormat: args.format as 'mp3' | 'wav' | undefined,
        musicReferenceImages: referenceImages,
        apiKey: args.apiKey,
        maxRetries: args.maxRetries ? Number(args.maxRetries) : undefined,
      },
      fileConfig
    );

    await runMusicGeneration({
      prompt: args.prompt,
      input: args.input,
      output: args.output,
      model: resolved.music.model,
      outputFormat: resolved.music.outputFormat,
      referenceImages: resolved.music.referenceImages,
      apiKey: resolved.apiKey,
      maxRetries: resolved.maxRetries,
      verbose: args.verbose,
    });
  },
});

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number (got "${value}").`);
  }
  return parsed;
}

export const sfxCommand = defineCommand({
  meta: {
    name: 'sfx',
    description: 'Generate sound effects from text prompts via ElevenLabs',
  },
  args: {
    prompt: {
      type: 'string',
      alias: 'p',
      description: 'Text prompt describing the sound effect',
    },
    input: {
      type: 'string',
      alias: 'i',
      description: 'Path to a text or markdown file containing the prompt',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Path for output audio file (.mp3 or .wav)',
      default: 'sfx.mp3',
    },
    duration: {
      type: 'string',
      alias: 'd',
      description: 'Length in seconds, 0.5 to 30 (defaults to model choice)',
    },
    influence: {
      type: 'string',
      description: 'How closely to follow the prompt, 0 to 1 (default 0.3)',
    },
    loop: {
      type: 'boolean',
      description: 'Generate a seamlessly looping sound effect',
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format (mp3 or wav; defaults to the output file extension)',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'ElevenLabs sound effects model (defaults to eleven_text_to_sound_v2)',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'ElevenLabs API key (defaults to ELEVENLABS_API_KEY)',
    },
    maxRetries: {
      type: 'string',
      description: 'Max retry attempts for API calls',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: false,
    },
  },
  async run({ args }) {
    if (args.format !== undefined && args.format !== 'mp3' && args.format !== 'wav') {
      throw new Error(`--format must be "mp3" or "wav" (got "${args.format}").`);
    }
    const fileConfig = await loadConfigFile(process.cwd());
    const resolved = resolveConfig(
      {
        mode: 'sfx',
        sfxModel: args.model,
        sfxOutputFormat: args.format as 'mp3' | 'wav' | undefined,
        durationSeconds: parseOptionalNumber(args.duration, '--duration'),
        promptInfluence: parseOptionalNumber(args.influence, '--influence'),
        loop: args.loop,
        apiKey: args.apiKey,
        maxRetries: parseOptionalNumber(args.maxRetries, '--max-retries'),
      },
      fileConfig
    );

    await runSoundEffectGeneration({
      prompt: args.prompt,
      input: args.input,
      output: args.output,
      provider: resolved.sfx.provider,
      model: resolved.sfx.model,
      outputFormat: args.format as 'mp3' | 'wav' | undefined,
      defaultOutputFormat: resolved.sfx.outputFormat,
      durationSeconds: resolved.sfx.durationSeconds,
      promptInfluence: resolved.sfx.promptInfluence,
      loop: resolved.sfx.loop,
      apiKey: resolved.apiKey,
      maxRetries: resolved.maxRetries,
      verbose: args.verbose,
    });
  },
});

const SUBCOMMANDS = {
  audio: audioCommand,
  voices: voicesCommand,
  video: videoCommand,
  image: imageCommand,
  music: musicCommand,
  sfx: sfxCommand,
  adapt: adaptCommand,
  studio: studioCommand,
  cut: cutCommand,
  production: productionCommand,
  comments: commentsCommand,
  character: characterCommand,
} as const;

/**
 * Routes top-level `-i <input> -o <output>` CLI invocations to the matching subcommand
 * based on the output file extension when no explicit subcommand name is given.
 */
export function resolveSmartCliArgv(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) return rawArgs;
  const firstArg = rawArgs[0];
  if (firstArg in SUBCOMMANDS) return rawArgs;

  let hasInputOrOutput = false;
  let outputPath: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === '-i' || token === '--input') {
      hasInputOrOutput = true;
      i++;
    } else if (token.startsWith('--input=')) {
      hasInputOrOutput = true;
    } else if (token === '-o' || token === '--output') {
      hasInputOrOutput = true;
      outputPath = rawArgs[i + 1];
      i++;
    } else if (token.startsWith('--output=')) {
      hasInputOrOutput = true;
      outputPath = token.slice('--output='.length);
    }
  }

  if (!hasInputOrOutput) return rawArgs;

  const ext = outputPath ? path.extname(outputPath).toLowerCase() : '.wav';
  if (ext === '.mp4' || ext === '.mov' || ext === '.webm') {
    return ['video', ...rawArgs];
  }
  if (ext === '.mp3') {
    return ['music', ...rawArgs];
  }
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
    return ['image', ...rawArgs];
  }
  return ['audio', ...rawArgs];
}

export const mainCommand = defineCommand({
  meta: {
    name: 'mdmedia',
    version: pkgVersion,
    description: 'Transform markdown into audio with Gemini or ElevenLabs, video with Gemini, music with Lyria, and sound effects with ElevenLabs',
  },
  subCommands: SUBCOMMANDS,
});
