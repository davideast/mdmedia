import { defineCommand } from 'citty';
import { loadConfigFile } from '../config/config-loader.js';
import { runImageGeneration } from '../image/workflow.js';
import type { ImageBackground, ImageQuality } from '../image/types.js';

export const imageCommand = defineCommand({
  meta: { name: 'image', description: 'Generate still images with Gemini, GPT Image 2.5, Retro Diffusion or PixelLab' },
  args: {
    prompt: { type: 'string', alias: 'p', description: 'Text prompt for image generation' },
    input: { type: 'string', alias: 'i', description: 'Prompt/markdown file (used when --prompt is absent)' },
    output: { type: 'string', alias: 'o', description: 'Output image path (.png, .jpg or .webp); actual format determines saved suffix', required: true },
    provider: { type: 'string', description: 'gemini (default), openai, retrodiffusion or pixellab' },
    model: { type: 'string', alias: 'm', description: 'Provider-specific model ID (file config or provider default)' },
    ref: { type: 'string', alias: 'r', description: 'Single local reference: conditioning (Gemini), edit (OpenAI), initialization (Retro/Pixflux)' },
    aspectRatio: { type: 'string', alias: ['a', 'aspect'], description: 'Gemini/OpenAI aspect ratio (default 16:9); exclusive with --size for OpenAI' },
    size: { type: 'string', description: 'Gemini: 1K/2K/4K; OpenAI: WIDTHxHEIGHT or auto; pixel providers: native WIDTHxHEIGHT (default 128x128)' },
    quality: { type: 'string', description: 'OpenAI only: auto, low, medium, high, xhigh or max' },
    background: { type: 'string', description: 'OpenAI/pixel providers: auto, opaque or transparent' },
    style: { type: 'string', description: 'Retro style ID matching model, for example rd_fast__default' },
    seed: { type: 'string', description: 'Pixel provider random seed (nonnegative integer)' },
    apiKey: { type: 'string', alias: 'k', description: 'API key for the selected image provider' },
    dryRun: { type: 'boolean', alias: 'dry-run', description: 'Validate and print JSON plan without credentials, network or output writes', default: false },
    metadata: { type: 'string', description: 'Optional JSON provenance sidecar path' },
  },
  async run({ args }) {
    const config = await loadConfigFile();
    const result = await runImageGeneration({
      prompt: args.prompt, input: args.input, output: args.output,
      provider: args.provider, model: args.model, referenceImage: args.ref,
      aspectRatio: args.aspectRatio, size: args.size, quality: args.quality as ImageQuality | undefined,
      background: args.background as ImageBackground | undefined, style: args.style,
      seed: args.seed === undefined ? undefined : Number(args.seed), apiKey: args.apiKey,
      dryRun: args.dryRun, metadata: args.metadata,
    }, { configured: config.image, legacyApiKey: config.apiKey });
    if (result.dryRun) console.log(JSON.stringify(result, null, 2));
    else console.log(`[Success] Image saved to: ${result.output}${result.metadata ? `\n[Metadata] ${result.metadata}` : ''}`);
  },
});
