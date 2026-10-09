import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageFormat, imageMimeType, pngDimensions } from './image-data.js';
import { createImageProvider, type ImageProviderOptions } from './provider-registry.js';
import { resolveImageSelection, validateImageRequest } from './selection.js';
import type { IImageProvider, ImageFormat, ImageRequest, ImageSettings } from './types.js';

export interface RunImageGenerationArgs extends ImageSettings {
  prompt?: string;
  input?: string;
  output: string;
  dryRun?: boolean;
  metadata?: string;
}

export interface ImageGenerationPlan {
  dryRun: boolean;
  provider: string;
  model: string;
  output: string;
  format: ImageFormat;
  prompt: string;
  referenceImage?: string;
  aspectRatio?: string;
  size?: string;
  quality?: string;
  background?: string;
  style?: string;
  seed?: number;
  metadata?: string;
  jobReceipt?: string;
}

async function loadReference(referencePath: string, provider: string) {
  let bytes: Uint8Array;
  if (path.extname(referencePath).toLowerCase() === '.avif' && provider === 'gemini') {
    if (process.platform !== 'darwin') throw new Error('AVIF reference conversion requires macOS (sips). Convert to PNG or JPEG first.');
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-image-ref-'));
    try {
      const converted = path.join(dir, 'reference.png');
      await promisify(execFile)('sips', ['-s', 'format', 'png', referencePath, '--out', converted]);
      bytes = await readFile(converted);
    } finally { await rm(dir, { recursive: true, force: true }); }
  } else bytes = await readFile(referencePath);
  return { bytes, mimeType: imageMimeType(bytes) };
}

function outputFormat(output: string): ImageFormat {
  const ext = path.extname(output).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  throw new Error('Image output must have a .png, .jpg, .jpeg or .webp extension.');
}

/** Performs all local validation before creating a client or sending a request. */
export async function runImageGeneration(args: RunImageGenerationArgs, dependencies: {
  configured?: ImageSettings;
  legacyApiKey?: string;
  env?: Record<string, string | undefined>;
  providerFactory?: (options: ImageProviderOptions) => IImageProvider;
} = {}): Promise<ImageGenerationPlan> {
  // CLI parsers include undefined options; omit them so file settings survive.
  const requested = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  const selection = resolveImageSelection({ requested, ...dependencies });
  const prompt = (args.prompt || (args.input ? await readFile(args.input, 'utf8') : '')).trim();
  if (!prompt) throw new Error('Either --prompt (-p) or --input (-i) must be provided.');
  const output = path.resolve(args.output);
  const format = outputFormat(output);
  const reference = selection.referenceImage ? await loadReference(selection.referenceImage, selection.provider) : undefined;
  const request: ImageRequest = validateImageRequest(selection.provider, {
    prompt, model: selection.model, format, reference,
    aspectRatio: selection.aspectRatio, size: selection.size, quality: selection.quality,
    background: selection.background, style: selection.style, seed: selection.seed,
  });
  const metadata = args.metadata ? path.resolve(args.metadata) : undefined;
  if (metadata && [output, ...['.png', '.jpg', '.jpeg', '.webp'].map((ext) => path.join(path.dirname(output), path.parse(output).name + ext))].includes(metadata)) {
    throw new Error('Metadata path must differ from the image output path.');
  }
  const jobReceipt = selection.provider === 'retrodiffusion' ? `${output}.job.json` : undefined;
  if (metadata && metadata === jobReceipt) throw new Error('Metadata path must differ from the job receipt path.');
  const plan: ImageGenerationPlan = {
    dryRun: args.dryRun ?? false, provider: selection.provider, model: selection.model,
    output, format, prompt, referenceImage: selection.referenceImage,
    aspectRatio: selection.aspectRatio, size: request.size,
    quality: request.quality, background: request.background, style: request.style,
    seed: request.seed, metadata, jobReceipt,
  };
  if (args.dryRun) return plan;

  const saveReceipt = async (receipt: object, initial = false) => {
    await mkdir(path.dirname(jobReceipt!), { recursive: true });
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    try {
      await writeFile(jobReceipt!, JSON.stringify({ provider: selection.provider, model: selection.model, requestHash, ...receipt }, null, 2) + '\n', { mode: 0o600, flag: initial ? 'wx' : 'w' });
    } catch (error) {
      if (initial && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A Retro job receipt already exists at ${jobReceipt}. Retrieve that job or archive its receipt before submitting another generation.`);
      throw error;
    }
  };
  const provider = (dependencies.providerFactory ?? createImageProvider)({
    provider: selection.provider, apiKey: selection.apiKey ?? '',
    onSubmitting: async (receipt) => saveReceipt({ ...receipt, status: 'submitting' }, true),
    onSubmitted: async (receipt) => saveReceipt({ ...receipt, status: 'accepted' }),
  });
  const result = await provider.generate(request);
  const actualFormat = imageFormat(result.imageBytes);
  const parsed = path.parse(output);
  const actualOutput = actualFormat === format ? output : path.join(parsed.dir, `${parsed.name}.${actualFormat === 'jpeg' ? 'jpg' : actualFormat}`);
  await mkdir(path.dirname(actualOutput), { recursive: true });
  await writeFile(actualOutput, result.imageBytes);
  if (metadata) {
    await mkdir(path.dirname(metadata), { recursive: true });
    await writeFile(metadata, JSON.stringify({
      version: 1, provider: result.provider, model: result.model,
      request: { size: request.size, aspectRatio: selection.aspectRatio, quality: request.quality, background: request.background, style: request.style, seed: request.seed },
      output: { path: actualOutput, mimeType: imageMimeType(result.imageBytes), dimensions: pngDimensions(result.imageBytes), byteLength: result.imageBytes.byteLength, sha256: createHash('sha256').update(result.imageBytes).digest('hex') },
      requestId: result.requestId, usage: result.usage,
    }, null, 2) + '\n');
  }
  return { ...plan, output: actualOutput, format: actualFormat };
}
