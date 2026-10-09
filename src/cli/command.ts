import { defineCommand } from 'citty';
import { studioCommand } from './studio-command.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';
import { loadConfigFile, resolveConfig } from '../config/index.js';
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
      description: 'Video task ("text_to_video", "image_to_video", "reference_to_video", "edit")',
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

export const imageCommand = defineCommand({
  meta: {
    name: 'image',
    description: 'Generate high-fidelity art & UI images from prompts via Gemini 3.1 Flash Image',
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
      description: 'Optional reference image path for exact artistic style/tone matching',
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
      description: 'Gemini image model name (Nano Banana Pro 2)',
      default: 'gemini-3-pro-image',
    },
    aspectRatio: {
      type: 'string',
      alias: ['a', 'aspect'],
      description: 'Aspect ratio (e.g., 16:9, 1:1, 4:3, 3:2)',
      default: '16:9',
    },
    size: {
      type: 'string',
      description: 'Output resolution: 1K, 2K or 4K (defaults to the model choice, 1K)',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
  },
  async run({ args }) {
    const fs = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { GoogleGenAI } = await import('@google/genai');

    let promptText = args.prompt || '';
    if (!promptText && args.input) {
      promptText = fs.readFileSync(args.input, 'utf8').trim();
    }
    if (!promptText) {
      throw new Error('Either --prompt (-p) or --input (-i) must be provided.');
    }

    const fileConfig = await loadConfigFile(process.cwd());
    const resolved = resolveConfig({ apiKey: args.apiKey }, fileConfig);
    const apiKey = resolved.apiKey;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required.');
    }

    const imageConfig = imageGenerationConfig(args.aspectRatio, args.size);

    const contents: any[] = [];
    if (args.ref && !fs.existsSync(args.ref)) {
      throw new Error(`Reference image not found: ${args.ref}`);
    }
    if (args.ref) {
      let refPath = args.ref;
      let ext = path.extname(refPath).toLowerCase();
      let tmpPng: string | undefined;
      if (ext === '.avif') {
        const os = await import('node:os');
        if (process.platform !== 'darwin') {
          throw new Error('AVIF reference image conversion requires macOS (sips). Convert the image to PNG or JPEG first.');
        }
        tmpPng = path.join(os.tmpdir(), `mdmedia_ref_${Date.now()}.png`);
        execFileSync('sips', ['-s', 'format', 'png', refPath, '--out', tmpPng]);
        refPath = tmpPng;
        ext = '.png';
      }
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const refBytes = fs.readFileSync(refPath);
      contents.push({
        inlineData: {
          data: refBytes.toString('base64'),
          mimeType,
        },
      });
      if (tmpPng) {
        try { fs.unlinkSync(tmpPng); } catch {}
      }
    }
    contents.push({ text: promptText });

    const ai = new GoogleGenAI({ apiKey });
    console.log(`🎨 Generating image (${args.model}, ${args.aspectRatio}${args.size ? `, ${args.size}` : ''}${args.ref ? `, ref=${path.basename(args.ref)}` : ''})...`);
    const res = await ai.models.generateContent({
      model: args.model,
      contents: contents.length === 1 ? contents[0].text : contents,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig,
      },
    });

    const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part?.inlineData?.data) {
      throw new Error('No image data returned from Gemini model.');
    }

    const outPath = path.resolve(process.cwd(), args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(part.inlineData.data, 'base64'));
    console.log(`✅ Saved generated image to: ${outPath}`);
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
