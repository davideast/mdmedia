import fs from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import {
  isFinished,
  mediaStatus,
  type ImageRequestBody,
  type ReferenceMediaType,
  type StudioClient,
  type StudioMediaBodies,
  type StudioMediaResource,
  type StudioMediaType,
  type VideoRequestBody,
} from '../remote/client.js';
import { connectedClient, guarded } from './studio-support.js';

const LABELS: Record<StudioMediaType, string> = { image: 'Image', video: 'Video', music: 'Music', sfx: 'Sound effect' };
const REFERENCE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_INSTRUCTIONS = 4000;

export const IMAGE_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

/** The prompt from `--prompt`, `--input <file>` (`-` for stdin), or piped stdin. */
export async function readPrompt(input: string | undefined, prompt: string | undefined): Promise<string> {
  if (prompt !== undefined && input !== undefined) throw new Error('Pass either --input or --prompt, not both.');
  if (prompt !== undefined) return prompt;
  if (input === '-' || (input === undefined && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (input === undefined) throw new Error('Pass --prompt "…", --input <file>, or pipe the prompt on stdin.');
  return fs.promises.readFile(input, 'utf8');
}

export function checkPrompt(prompt: string, max: number): string {
  if (!prompt.trim()) throw new Error('The prompt is empty.');
  if (prompt.length > max) throw new Error(`The prompt is ${prompt.length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}.`);
  return prompt;
}

/** One of `allowed` (ignoring case), or a one-line error naming the flag. */
export function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find((option) => option.toLowerCase() === value.trim().toLowerCase());
  if (!match) throw new Error(`${flag} must be one of ${allowed.join(', ')} (got "${value}").`);
  return match;
}

/** A number from `min` to `max`, or a one-line error naming the flag. */
export function numberIn(flag: string, value: string | undefined, min: number, max: number, integer = false): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const range = max === Infinity ? `at least ${min}` : `${min} to ${max}`;
  if (!value.trim() || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${flag} must be ${integer ? 'a whole number' : 'a number'} ${range} (got "${value}").`);
  }
  return parsed;
}

/** `--adapt`, `--no-adapt`, and `--instructions`; instructions alone turn adaptation on. */
export function adaptationFrom(args: { adapt?: boolean; instructions?: string }): ImageRequestBody['adaptation'] {
  if (args.instructions !== undefined && args.instructions.length > MAX_INSTRUCTIONS) {
    throw new Error(`--instructions is limited to ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters.`);
  }
  const enabled = args.adapt ?? (args.instructions !== undefined ? true : undefined);
  if (enabled === undefined) return undefined;
  return { enabled, ...(args.instructions === undefined ? {} : { instructions: args.instructions }) };
}

/** A PNG, JPEG, or WebP file of at most 10 MiB. */
export async function readReference(file: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const mimeType = REFERENCE_TYPES[path.extname(file).toLowerCase()];
  if (!mimeType) throw new Error('--reference must be a .png, .jpg, .jpeg, or .webp image.');
  const bytes = await fs.promises.readFile(file);
  if (bytes.length > MAX_REFERENCE_BYTES) throw new Error('--reference must be at most 10 MiB.');
  return { bytes, mimeType };
}

/** "ready (12s)", "failed: …", or the status it is still in. */
export function describeMedia(resource: StudioMediaResource): string {
  const status = mediaStatus(resource);
  if (status === 'error' || status === 'interrupted') return `${status === 'error' ? 'failed' : 'interrupted'}: ${resource.latestGeneration?.error?.message ?? 'unknown error'}`;
  if (status === 'ready') return resource.durationMs ? `ready (${Math.round(resource.durationMs / 1000)}s)` : 'ready';
  return status;
}

export interface MediaRunOptions {
  reference?: string;
  wait?: boolean;
  output?: string;
  timeout?: string;
  json?: boolean;
}

async function withReference<T extends StudioMediaType>(client: StudioClient, type: T, body: StudioMediaBodies[T], file: string | undefined): Promise<StudioMediaBodies[T]> {
  if (file === undefined) return body;
  if (type === 'sfx') throw new Error('Sound effects do not take a reference image.');
  const { bytes, mimeType } = await readReference(file);
  const asset = await client.uploadReference(type as ReferenceMediaType, bytes, mimeType);
  return { ...body, referenceAssetId: asset.id };
}

/**
 * The flow every media command shares: upload the reference, create the item,
 * then either print its link or wait for it, and save the result with `--output`.
 */
export async function runMediaCommand<T extends StudioMediaType>(client: StudioClient, type: T, body: StudioMediaBodies[T], options: MediaRunOptions): Promise<void> {
  const timeoutMs = (numberIn('--timeout', options.timeout, 1, Infinity) ?? 900) * 1000;
  const created = await client.createMedia(type, await withReference(client, type, body, options.reference));
  if (!options.wait && !options.output) {
    if (options.json) console.log(JSON.stringify(created, null, 2));
    else console.log(`${LABELS[type]} started: ${created.links.web}`);
    return;
  }
  if (!options.json) console.error(`Generating ${created.links.web} …`);
  let phase = '';
  const finished = await client.waitForMedia(type, created.id, {
    timeoutMs,
    onProgress: (resource) => {
      const next = resource.latestGeneration?.phase ?? '';
      if (!options.json && next && next !== phase && !isFinished(mediaStatus(resource))) console.error(`  ${next}`);
      phase = next;
    },
  });
  const status = mediaStatus(finished);
  let saved: string | undefined;
  if (options.output && status === 'ready') {
    const asset = finished.result?.assets[0];
    if (!asset) throw new Error('The studio finished without a file to save.');
    saved = path.resolve(options.output);
    await fs.promises.writeFile(saved, (await client.downloadAsset(asset.links.content)).bytes);
  }
  if (options.json) console.log(JSON.stringify({ ...finished, ...(saved ? { savedTo: saved } : {}) }, null, 2));
  else {
    console.log(`${finished.title || finished.id}: ${describeMedia(finished)} — ${finished.links.web}${saved ? `\nSaved ${saved}` : ''}`);
    if (!isFinished(status)) console.error(`Still ${status}. Check later with \`mdmedia studio status ${finished.id} --type ${type}\`.`);
  }
  if (status === 'error' || status === 'interrupted' || (options.output && !saved)) process.exitCode = 1;
}

const promptArgs = {
  prompt: { type: 'string', alias: 'p', description: 'The prompt (or Markdown)' },
  input: { type: 'string', alias: 'i', description: 'File containing the prompt (- for stdin)' },
} as const;

const adaptArgs = {
  adapt: { type: 'boolean', description: 'Adapt the prompt (e.g. Markdown notes) into a brief first (--no-adapt to send it as written)' },
  instructions: { type: 'string', description: 'Adaptation instructions (turns on --adapt)' },
} as const;

const referenceArg = {
  reference: { type: 'string', description: 'Reference image: PNG, JPEG, or WebP, up to 10 MiB' },
} as const;

const runArgs = {
  wait: { type: 'boolean', description: 'Wait until it is ready' },
  output: { type: 'string', alias: 'o', description: 'Save the finished file here (implies --wait)' },
  timeout: { type: 'string', description: 'Seconds to wait (default 900)' },
  json: { type: 'boolean', description: 'Print JSON' },
} as const;

export function imageBody(prompt: string, args: { aspect?: string; resolution?: string; adapt?: boolean; instructions?: string }): ImageRequestBody {
  const body: ImageRequestBody = { prompt: checkPrompt(prompt, 32_000) };
  const aspectRatio = oneOf('--aspect', args.aspect, IMAGE_ASPECTS);
  const resolution = oneOf('--resolution', args.resolution, ['1K', '2K', '4K'] as const);
  if (aspectRatio || resolution) body.output = { ...(aspectRatio ? { aspectRatio } : {}), ...(resolution ? { resolution } : {}) };
  const adaptation = adaptationFrom(args);
  if (adaptation) body.adaptation = adaptation;
  return body;
}

export const imageCommand = defineCommand({
  meta: { name: 'image', description: 'Create a private image in your studio' },
  args: {
    ...promptArgs,
    aspect: { type: 'string', description: `Shape: ${IMAGE_ASPECTS.join(', ')} (default: your studio default, 16:9 unless changed)` },
    resolution: { type: 'string', description: '1K, 2K, or 4K (default: your studio default, the model\'s unless changed)' },
    ...referenceArg,
    ...adaptArgs,
    ...runArgs,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const body = imageBody(await readPrompt(args.input, args.prompt), args);
      await runMediaCommand(connectedClient(), 'image', body, args);
    });
  },
});

export function videoBody(prompt: string, args: {
  aspect?: string; resolution?: string; duration?: string; reference?: string; firstFrame?: boolean; adapt?: boolean; instructions?: string;
}): VideoRequestBody {
  const body: VideoRequestBody = { prompt: checkPrompt(prompt, 32_000) };
  const aspectRatio = oneOf('--aspect', args.aspect, ['16:9', '9:16'] as const);
  const resolution = oneOf('--resolution', args.resolution, ['360p', '720p', '1080p', '4k'] as const);
  const durationSeconds = numberIn('--duration', args.duration, 3, 10, true);
  if (aspectRatio || resolution || durationSeconds !== undefined) {
    body.output = { ...(aspectRatio ? { aspectRatio } : {}), ...(resolution ? { resolution } : {}), ...(durationSeconds === undefined ? {} : { durationSeconds }) };
  }
  if (args.firstFrame && args.reference === undefined) throw new Error('--first-frame needs --reference <image>.');
  if (args.firstFrame !== undefined) body.referenceRole = args.firstFrame ? 'first_frame' : 'reference';
  const adaptation = adaptationFrom(args);
  if (adaptation) body.adaptation = adaptation;
  return body;
}

export const videoCommand = defineCommand({
  meta: { name: 'video', description: 'Create a private video clip in your studio' },
  args: {
    ...promptArgs,
    aspect: { type: 'string', description: '16:9 or 9:16 (default: your studio default, 16:9 unless changed)' },
    resolution: { type: 'string', description: '360p, 720p, 1080p, or 4k (default: your studio default, 720p unless changed)' },
    duration: { type: 'string', description: 'Clip length, 3 to 10 whole seconds (default: your studio default, 10 unless changed)' },
    ...referenceArg,
    firstFrame: { type: 'boolean', description: 'Use --reference as the first frame instead of a style/subject reference' },
    ...adaptArgs,
    ...runArgs,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const body = videoBody(await readPrompt(args.input, args.prompt), args);
      await runMediaCommand(connectedClient(), 'video', body, args);
    });
  },
});
