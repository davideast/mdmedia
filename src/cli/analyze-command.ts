import fs from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import { GoogleGenAI } from '@google/genai';
import { loadConfigFile } from '../config/index.js';
import {
  DEFAULT_ANALYSIS_MODEL,
  GeminiVideoAnalysisProvider,
  MAX_ANALYSIS_VIDEOS,
  MEDIA_RESOLUTIONS,
  isYouTubeUrl,
  parseVideoTime,
  validateAnalysis,
  type AnalyzeVideoOptions,
  type VideoSource,
} from '../analysis/index.js';
import { numberIn, oneOf, readPrompt } from './studio-media-commands.js';

const PHASES = { uploading: 'Uploading video…', processing: 'Waiting for Gemini to process the video…', analyzing: 'Analyzing…' } as const;

export interface AnalyzeArgs {
  video?: string;
  processing?: string;
  start?: string;
  end?: string;
  fps?: string;
  mediaResolution?: string;
  system?: string;
  followUp?: string;
}

/** Videos from `--video`: comma-separated paths or YouTube links, at most ten. */
export function videoSources(value: string | undefined): VideoSource[] {
  if (value === undefined) return [];
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('--video must name at least one video file or YouTube link.');
  if (entries.length > MAX_ANALYSIS_VIDEOS) throw new Error(`--video accepts at most ${MAX_ANALYSIS_VIDEOS} videos (got ${entries.length}).`);
  return entries.map((entry) => {
    if (isYouTubeUrl(entry)) return { kind: 'youtube', url: entry };
    if (/^https?:\/\//i.test(entry)) throw new Error(`--video links must be YouTube; download other videos first (got "${entry}").`);
    return { kind: 'path', path: entry };
  });
}

/** A JSON Schema object from `--schema <file.json>`, checked before anything is paid for. */
export async function readResponseSchema(file: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (file === undefined) return undefined;
  if (!file.trim()) throw new Error('--schema needs a JSON Schema file.');
  let text: string;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch { throw new Error(`--schema: cannot read ${file}.`); }
  let schema: unknown;
  try { schema = JSON.parse(text); } catch { throw new Error(`--schema: ${file} is not valid JSON.`); }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`--schema: ${file} must hold a JSON Schema object.`);
  return schema as Record<string, unknown>;
}

/** The provider options from flags, checked before anything is uploaded or paid for. */
export function analyzeOptions(args: AnalyzeArgs, model: string): AnalyzeVideoOptions {
  const options: AnalyzeVideoOptions = { model };
  const processing = oneOf('--processing', args.processing, ['static', 'agentic'] as const);
  if (processing) options.processing = processing;
  const startSeconds = parseVideoTime('--start', args.start);
  const endSeconds = parseVideoTime('--end', args.end);
  const fps = numberIn('--fps', args.fps, 0, Infinity);
  if (startSeconds !== undefined) options.startSeconds = startSeconds;
  if (endSeconds !== undefined) options.endSeconds = endSeconds;
  if (fps !== undefined) options.fps = fps;
  const mediaResolution = oneOf('--media-resolution', args.mediaResolution, MEDIA_RESOLUTIONS);
  if (mediaResolution) options.mediaResolution = mediaResolution;
  if (args.system !== undefined) {
    if (!args.system.trim()) throw new Error('--system is empty.');
    options.systemInstruction = args.system;
  }
  if (args.followUp !== undefined) {
    if (!/^[A-Za-z0-9_\-/.]{1,256}$/.test(args.followUp.trim())) throw new Error('--follow-up must be an interaction id.');
    options.previousInteractionId = args.followUp.trim();
  }
  return options;
}

export const analyzeCommand = defineCommand({
  meta: {
    name: 'analyze',
    description: 'Ask Gemini about a video (local file or YouTube link) and print the answer as Markdown',
  },
  args: {
    video: { type: 'string', alias: 'v', description: `Video file(s) or YouTube link(s), comma-separated, up to ${MAX_ANALYSIS_VIDEOS}` },
    prompt: { type: 'string', alias: 'p', description: 'What to ask about the video' },
    input: { type: 'string', alias: 'i', description: 'File containing the prompt (- for stdin)' },
    model: { type: 'string', alias: 'm', description: `Gemini model (default: .mdmedia.json analysis.model, MDMEDIA_ANALYSIS_MODEL, or ${DEFAULT_ANALYSIS_MODEL})` },
    processing: { type: 'string', description: 'static (default) or agentic (long videos, targeted questions)' },
    start: { type: 'string', description: 'Static only: start at this time (90, 20m, MM:SS)' },
    end: { type: 'string', description: 'Static only: stop at this time (90, 20m, MM:SS)' },
    fps: { type: 'string', description: 'Static only: frames sampled per second (default 1)' },
    mediaResolution: { type: 'string', description: `Detail per frame: ${MEDIA_RESOLUTIONS.join(', ')}` },
    system: { type: 'string', description: 'System instruction' },
    followUp: { type: 'string', description: 'Interaction id of an earlier analysis to ask a follow-up about' },
    schema: { type: 'string', description: 'JSON Schema file; the answer is JSON matching it' },
    output: { type: 'string', alias: 'o', description: 'Also save the answer to this file' },
    json: { type: 'boolean', description: 'Print JSON: text, interactionId, model, usage' },
    apiKey: { type: 'string', alias: 'k', description: 'Gemini API key (default: GEMINI_API_KEY)' },
    maxRetries: { type: 'string', description: 'Max retries for reads (default 3)' },
    timeout: { type: 'string', description: 'Seconds to wait (default 1200)' },
  },
  async run({ args }) {
    try {
      await runAnalyze(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) console.log(JSON.stringify({ error: message }, null, 2));
      else console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  },
});

async function runAnalyze(args: AnalyzeArgs & {
  prompt?: string; input?: string; model?: string; schema?: string; output?: string; json?: boolean; apiKey?: string; maxRetries?: string; timeout?: string;
}): Promise<void> {
  const fileConfig = await loadConfigFile(process.cwd());
  const model = args.model?.trim() || fileConfig.analysis?.model || process.env.MDMEDIA_ANALYSIS_MODEL?.trim() || DEFAULT_ANALYSIS_MODEL;
  const sources = videoSources(args.video);
  const options = analyzeOptions(args, model);
  const timeoutSeconds = numberIn('--timeout', args.timeout, 1, Infinity) ?? 1200;
  const maxRetries = numberIn('--max-retries', args.maxRetries, 0, 10, true) ?? fileConfig.maxRetries ?? 3;
  const output = args.output === undefined ? undefined : checkMarkdownOutput(args.output);
  const prompt = await readPrompt(args.input, args.prompt);
  const responseSchema = await readResponseSchema(args.schema);
  if (responseSchema) options.responseSchema = responseSchema;
  validateAnalysis(prompt, sources, model, options);
  const apiKey = args.apiKey ?? fileConfig.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Set GEMINI_API_KEY or pass --api-key.');

  const provider = new GeminiVideoAnalysisProvider(new GoogleGenAI({ apiKey }), maxRetries, model);
  const result = await provider.analyzeVideo(prompt, sources, {
    ...options,
    timeoutMs: timeoutSeconds * 1000,
    onPhase: (phase) => { if (!args.json) console.error(PHASES[phase]); },
    ...(args.json ? {} : { onProgress: (step: string) => console.error(`  ${step}`) }),
    onWarning: (message) => console.error(`Warning: ${message}`),
    onInteraction: (id) => { if (!args.json) console.error(`Interaction ${id}`); },
  });

  if (output) await fs.promises.writeFile(output, `${result.text}\n`, 'utf8');
  if (args.json) console.log(JSON.stringify({ ...result, ...(output ? { savedTo: output } : {}) }, null, 2));
  else {
    console.log(result.text);
    if (output) console.error(`Saved ${output}`);
  }
}

function checkMarkdownOutput(file: string): string {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) throw new Error(`--output ${file} is a folder; name a file.`);
  try { fs.accessSync(path.dirname(resolved), fs.constants.W_OK); } catch {
    throw new Error(`--output: ${path.dirname(resolved)} does not exist or cannot be written.`);
  }
  return resolved;
}
