import { defineCommand } from 'citty';
import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';
import { loadConfigFile, resolveConfig } from '../config/index.js';
import { runAudioSynthesis, runNarrationAdaptation, runVideoGeneration } from './runner.js';
import type { GeminiTTSProvider } from '../tts/gemini-tts-provider.js';
import type { GeminiNarrationAdapter } from '../narration/gemini-narration-adapter.js';

export const audioCommand = defineCommand({
  meta: {
    name: 'audio',
    description: 'Convert markdown documents into spoken audio narration via Gemini Flash 3.1 TTS',
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
    voice: {
      type: 'string',
      alias: 'v',
      description: 'Gemini TTS voice name (e.g. Kore, Puck, Zephyr)',
    },
    style: {
      type: 'string',
      alias: 's',
      description: 'Director notes / style prompt for speech delivery',
    },
    maxChars: {
      type: 'string',
      alias: 'c',
      description: 'Maximum characters per document chunk',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Gemini TTS model name',
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
      alias: 'a',
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

export const watchCommand = defineCommand({
  meta: {
    name: 'watch',
    description: 'Watch Antigravity conversations and automatically narrate new agent responses aloud',
  },
  args: {
    voice: {
      type: 'string',
      alias: 'v',
      description: 'Gemini TTS voice name (e.g. Puck, Kore, Fenrir)',
      default: 'Puck',
    },
    style: {
      type: 'string',
      alias: 's',
      description: 'Delivery style prompt',
      default: 'Clear, concise engineering assistant narration.',
    },
  },
  async run({ args }) {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(__dirname, 'agy-watch.js');
    spawn(process.execPath, [scriptPath, args.voice, args.style], {
      stdio: 'inherit',
      env: process.env,
    });
  },
});

export const pluginCommand = defineCommand({
  meta: {
    name: 'plugin',
    description: 'Install or manage the mdmedia Antigravity UI Plugin (~/.gemini/config/plugins/mdmedia_narrator)',
  },
  args: {
    action: {
      type: 'positional',
      description: 'Action to perform (install)',
      default: 'install',
    },
  },
  async run() {
    const { installAntigravityPlugin } = await import('./plugin-installer.js');
    const targetDir = installAntigravityPlugin();
    console.log(`✅ Installed mdmedia_narrator UI plugin to: ${targetDir}`);
    console.log(`   Enable "mdmedia_narrator" in Antigravity UI Plugins to use in IDE & CLI.`);
  },
});

export const studioCommand = defineCommand({
  meta: {
    name: 'studio',
    description: 'Launch the interactive fullscreen OpenTUI Audio Studio terminal dashboard',
  },
  async run() {
    const { startStudioTui } = await import('../tui/app.js');
    const { loadConfigFile } = await import('../config/config-loader.js');
    const { GoogleGenAI } = await import('@google/genai');
    const { GeminiTTSProvider } = await import('../tts/gemini-tts-provider.js');
    const { GeminiNarrationAdapter } = await import('../narration/gemini-narration-adapter.js');
    const { StudioStore } = await import('../studio/studio-store.js');
    const { getGeminiApiKey } = await import('../studio/antigravity-watcher.js');

    const fileConfig = await loadConfigFile(process.cwd());
    const apiKey = getGeminiApiKey();
    let provider: GeminiTTSProvider | undefined;
    let narrationAdapter: GeminiNarrationAdapter | undefined;

    if (apiKey) {
      const client = new GoogleGenAI({ apiKey });
      provider = new GeminiTTSProvider(client);
      if (fileConfig?.narration?.enabled) {
        narrationAdapter = new GeminiNarrationAdapter(client, {
          model: fileConfig.narration.model,
        });
      }
    }

    const store = new StudioStore({
      ttsProvider: provider,
      narrationAdapter,
      enableLiveAudio: true,
      defaultVoice: fileConfig?.audio?.voice,
    });

    await startStudioTui(store);
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
      alias: 'a',
      description: 'Aspect ratio (e.g., 16:9, 1:1, 4:3, 3:2)',
      default: '16:9',
    },
    apiKey: {
      type: 'string',
      alias: 'k',
      description: 'Gemini API Key',
    },
  },
  async run({ args }) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { GoogleGenAI } = await import('@google/genai');
    const { getGeminiApiKey } = await import('../studio/antigravity-watcher.js');

    let promptText = args.prompt || '';
    if (!promptText && args.input) {
      promptText = fs.readFileSync(args.input, 'utf8').trim();
    }
    if (!promptText) {
      throw new Error('Either --prompt (-p) or --input (-i) must be provided.');
    }

    const apiKey = args.apiKey || getGeminiApiKey();
    if (!apiKey) {
      throw new Error('No GEMINI_API_KEY found in environment or ~/.gemini/.env');
    }

    const contents: any[] = [];
    if (args.ref && fs.existsSync(args.ref)) {
      let refPath = args.ref;
      let ext = path.extname(refPath).toLowerCase();
      if (ext === '.avif') {
        const tmpPng = `/tmp/mdmedia_ref_${Date.now()}.png`;
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
    }
    contents.push({ text: promptText });

    const ai = new GoogleGenAI({ apiKey });
    console.log(`🎨 Generating image (${args.model}, ${args.aspectRatio}${args.ref ? `, ref=${path.basename(args.ref)}` : ''})...`);
    const res = await ai.models.generateContent({
      model: args.model,
      contents: contents.length === 1 ? contents[0].text : contents,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: args.aspectRatio },
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

export const mainCommand = defineCommand({
  meta: {
    name: 'mdmedia',
    version: '0.1.0',
    description: 'Transform markdown documents into rich audio, video, and image media via Gemini Flash 3.1 & Gemini Omni Flash',
  },
  subCommands: {
    audio: audioCommand,
    video: videoCommand,
    image: imageCommand,
    adapt: adaptCommand,
    watch: watchCommand,
    studio: studioCommand,
    plugin: pluginCommand,
  },
});


