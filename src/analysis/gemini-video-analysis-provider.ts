import type { GoogleGenAI } from '@google/genai';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { calculateBackoffMs, isRetryableError } from '../tts/backoff.js';
import type {
  AnalyzeVideoOptions,
  IVideoAnalysisProvider,
  MediaResolution,
  VideoAnalysisResult,
  VideoAnalysisUsage,
  VideoSource,
} from './video-analysis.interface.js';

/** Hears the soundtrack and supports agentic processing. */
export const DEFAULT_ANALYSIS_MODEL = 'gemini-3.8-flash';
/** Models the docs list for `processing: "agentic"`. Everything else is static only. */
export const AGENTIC_ANALYSIS_MODELS: readonly string[] = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
export const MEDIA_RESOLUTIONS: readonly MediaResolution[] = ['low', 'medium', 'high', 'ultra_high'];
/** Gemini 2.5 and later accept up to 10 videos in one request. */
export const MAX_ANALYSIS_VIDEOS = 10;
/** Requests at or under this size send video inline; anything larger goes through the Files API. */
export const MAX_INLINE_REQUEST_BYTES = 20 * 1024 * 1024;

export const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpg', '.mov': 'video/mov',
  '.avi': 'video/avi', '.flv': 'video/x-flv', '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp',
};
const SUPPORTED_MIME_TYPES = new Set(Object.values(VIDEO_MIME_TYPES).concat('video/quicktime'));
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
/** A progress line is one short line. */
export const MAX_PROGRESS_CHARS = 120;
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action']);

/** `gemini-4-argon` and the lite models see but do not hear (see cut/listen-gemini.ts). */
export function canHearAudio(model: string): boolean {
  return model !== 'gemini-4-argon' && !/lite/i.test(model);
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The MIME type for a local video file, or an error naming the supported formats. */
export function videoMimeType(file: string): string {
  const mimeType = VIDEO_MIME_TYPES[path.extname(file).toLowerCase()];
  if (!mimeType) throw new Error(`${file} is not a supported video. Use ${Object.keys(VIDEO_MIME_TYPES).join(', ')}.`);
  return mimeType;
}

type ResolvedSource =
  | { kind: 'local'; bytes: Uint8Array; mimeType: string; name: string }
  | { kind: 'youtube'; url: string };
type VideoPart = { type: 'video'; uri?: string; data?: string; mime_type?: string; resolution?: string; processing?: unknown };
type Step = { type?: string; summary?: Array<{ type?: string; text?: string }>; content?: Array<{ type?: string; text?: string }> };
type StreamEvent = { event_type?: string; index?: number; delta?: { type?: string; content?: { text?: string } } };
type Interaction = { id?: string; status?: string; output_text?: string; steps?: Step[]; usage?: Record<string, number | undefined>; error?: { message?: string }; response_format?: unknown };

/**
 * Asks Gemini about one or more videos through the Interactions API.
 * Small requests carry the video inline; larger ones upload through the Files API first.
 * Long work runs in the background and is polled, so a dropped connection never loses a paid result.
 */
export class GeminiVideoAnalysisProvider implements IVideoAnalysisProvider {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly maxRetries = 3,
    private readonly defaultModel = DEFAULT_ANALYSIS_MODEL,
    private readonly pollMs = 3000,
  ) {}

  async analyzeVideo(prompt: string, sources: VideoSource[], options: AnalyzeVideoOptions = {}): Promise<VideoAnalysisResult> {
    const model = options.model?.trim() || this.defaultModel;
    validateAnalysis(prompt, sources, model, options);
    if (sources.length && !canHearAudio(model)) options.onWarning?.(`${model} cannot hear audio; the analysis will use the picture only.`);
    return this.withDeadline(options, async (signal) => {
      const resolved = await Promise.all(sources.map(resolveSource));
      const localBytes = resolved.reduce((sum, source) => sum + (source.kind === 'local' ? source.bytes.length : 0), 0);
      // Base64 inflates by 4/3; leave room for the prompt and instructions.
      const upload = Math.ceil(localBytes / 3) * 4 + prompt.length + (options.systemInstruction?.length ?? 0) > MAX_INLINE_REQUEST_BYTES;
      if (upload && resolved.some((source) => source.kind === 'local')) options.onPhase?.('uploading');
      const parts: VideoPart[] = [];
      for (const source of resolved) parts.push(await this.videoPart(source, upload, options, signal));

      const background = options.background ?? true;
      const payload: Record<string, unknown> = {
        model,
        // The docs ask for the prompt after the video.
        input: [...parts, { type: 'text', text: prompt }],
        store: true,
        ...(background ? { background: true } : {}),
        ...(options.systemInstruction ? { system_instruction: options.systemInstruction } : {}),
        ...(options.responseSchema ? { response_format: { type: 'text', mime_type: 'application/json', schema: options.responseSchema } } : {}),
        ...(options.previousInteractionId ? { previous_interaction_id: options.previousInteractionId } : {}),
        // Progress is read from thought summaries, which are only sent when asked for.
        ...(options.onProgress ? { generation_config: { thinking_summaries: 'auto' } } : {}),
      };
      options.onPhase?.('analyzing');
      const created = await this.client.interactions.create(payload as never, { maxRetries: 0, fetchOptions: { signal } }) as Interaction;
      if (!created.id) throw new Error('Gemini did not return an interaction id.');
      await options.onInteraction?.(created.id);
      return this.finish(created, model, signal, { json: Boolean(options.responseSchema), onProgress: options.onProgress });
    });
  }

  /** Recovery only reads a saved receipt; it never starts a second paid request. */
  async retrieveAnalysis(interactionId: string, options: Pick<AnalyzeVideoOptions, 'signal' | 'timeoutMs' | 'onPhase' | 'onProgress'> = {}): Promise<VideoAnalysisResult> {
    if (!interactionId?.trim()) throw new Error('A stored interaction id is required.');
    return this.withDeadline(options, async (signal) => {
      options.onPhase?.('analyzing');
      const interaction = await this.read(interactionId, signal);
      return this.finish({ ...interaction, id: interactionId }, undefined, signal, { onProgress: options.onProgress });
    });
  }

  private async videoPart(source: ResolvedSource, upload: boolean, options: AnalyzeVideoOptions, signal: AbortSignal): Promise<VideoPart> {
    const part: VideoPart = { type: 'video' };
    if (source.kind === 'youtube') part.uri = source.url;
    else if (!upload) {
      part.data = Buffer.from(source.bytes).toString('base64');
      part.mime_type = source.mimeType;
    } else {
      const file = await this.uploadFile(source, options, signal);
      part.uri = file.uri;
      part.mime_type = file.mimeType;
    }
    if (options.mediaResolution) part.resolution = options.mediaResolution;
    const processing = processingConfig(options);
    if (processing !== undefined) part.processing = processing;
    return part;
  }

  private async uploadFile(source: Extract<ResolvedSource, { kind: 'local' }>, options: AnalyzeVideoOptions, signal: AbortSignal): Promise<{ uri: string; mimeType: string }> {
    signal.throwIfAborted();
    const blob = new Blob([source.bytes as BlobPart], { type: source.mimeType });
    let file = await this.client.files.upload({ file: blob, config: { mimeType: source.mimeType, displayName: source.name, abortSignal: signal } });
    if (!file.name) throw new Error('The Files API did not return a file name.');
    options.onPhase?.('processing');
    while (fileState(file) !== 'ACTIVE') {
      if (fileState(file) === 'FAILED') throw new Error(`Gemini could not process ${source.name}.`);
      await this.pause(this.pollMs, signal);
      const name = file.name!;
      file = await this.safeRead(() => this.client.files.get({ name, config: { abortSignal: signal } }), signal);
    }
    if (!file.uri) throw new Error('The Files API did not return a file URI.');
    return { uri: file.uri, mimeType: file.mimeType ?? source.mimeType };
  }

  private async finish(start: Interaction, model: string | undefined, signal: AbortSignal, expect: { json?: boolean; onProgress?: (step: string) => void }): Promise<VideoAnalysisResult> {
    let interaction = start;
    const running = (status: string | undefined) => status === 'in_progress' || status === 'queued';
    // Polling never shows steps until the end; a stream of the same interaction does. Polling stays the source of truth.
    const stopWatching = expect.onProgress && running(interaction.status) ? this.watch(start.id!, expect.onProgress, signal) : null;
    try {
      while (running(interaction.status)) {
        await this.pause(this.pollMs, signal);
        interaction = { ...(await this.read(start.id!, signal)), id: start.id };
      }
    } finally { stopWatching?.(); }
    if (interaction.status && TERMINAL_FAILURES.has(interaction.status)) {
      throw new Error(`Video analysis ${interaction.status.replace('_', ' ')}${interaction.error?.message ? `: ${interaction.error.message}` : '.'}`);
    }
    const text = interaction.output_text?.trim() || lastOutputText(interaction.steps);
    if (!text) throw new Error('Gemini finished without any analysis text.');
    // A schema'd answer is only useful if it parses; the request's own format is echoed back, so recovery checks it too.
    if (expect.json || isJsonFormat(interaction.response_format)) {
      try { JSON.parse(text); } catch { throw new Error('Gemini finished without valid JSON for the schema.'); }
    }
    return {
      interactionId: start.id!,
      model: model ?? (interaction as { model?: string }).model ?? this.defaultModel,
      text,
      usage: usageFrom(interaction.usage),
      trace: (interaction.steps ?? []).filter((step) => step.type === 'thought')
        .flatMap((step) => (step.summary ?? []).map((item) => item.text?.trim() ?? '')).filter(Boolean),
    };
  }

  /** Streams the running interaction and reports each new thought title once. Any stream failure only ends the progress. */
  private watch(id: string, onProgress: (step: string) => void, signal: AbortSignal): () => void {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    const seen = new Set<string>();
    const texts = new Map<number, string>();
    const report = (text: string | undefined) => {
      const line = text ? progressLine(text) : '';
      if (!line || seen.has(line)) return;
      seen.add(line);
      onProgress(line);
    };
    void (async () => {
      const stream = await this.client.interactions.get(id, { stream: true }, { maxRetries: 0, fetchOptions: { signal: controller.signal } });
      for await (const event of stream as unknown as AsyncIterable<StreamEvent>) {
        if (controller.signal.aborted) return;
        if (event.event_type === 'step.delta' && event.delta?.type === 'thought_summary') {
          const text = (texts.get(event.index ?? 0) ?? '') + (event.delta.content?.text ?? '');
          texts.set(event.index ?? 0, text);
          // A bold title is the step's name; report it as soon as it is complete.
          if (/^\s*\*\*[^*]+\*\*/.test(text)) report(text);
        } else if (event.event_type === 'step.stop') report(texts.get(event.index ?? 0));
      }
    })().catch(() => {}).finally(() => signal.removeEventListener('abort', stop));
    return stop;
  }

  private read(id: string, signal: AbortSignal): Promise<Interaction> {
    return this.safeRead(() => this.client.interactions.get(id, {}, { maxRetries: 0, fetchOptions: { signal } }) as Promise<Interaction>, signal);
  }

  private async safeRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await read(); } catch (error) {
        if (signal.aborted || attempt >= this.maxRetries || !isRetryableRead(error)) throw error;
        await this.pause(calculateBackoffMs(attempt), signal);
      }
    }
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async withDeadline<T>(options: Pick<AnalyzeVideoOptions, 'signal' | 'timeoutMs'>, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Video analysis timed out')), options.timeoutMs ?? 20 * 60_000);
    try { return await run(controller.signal); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
}

/** Everything that can be checked before any upload or paid call. */
export function validateAnalysis(prompt: string, sources: VideoSource[], model: string, options: AnalyzeVideoOptions): void {
  if (!prompt.trim()) throw new Error('The prompt is empty.');
  if (sources.length === 0 && !options.previousInteractionId) throw new Error('Give at least one video, or a previous interaction id to follow up on.');
  if (sources.length > MAX_ANALYSIS_VIDEOS) throw new Error(`At most ${MAX_ANALYSIS_VIDEOS} videos per request (got ${sources.length}).`);
  for (const source of sources) {
    if (source.kind === 'youtube' && !isYouTubeUrl(source.url)) throw new Error(`${source.url} is not a YouTube link.`);
    if (source.kind === 'path') videoMimeType(source.path);
    if (source.kind === 'bytes' && !SUPPORTED_MIME_TYPES.has(source.mimeType)) throw new Error(`${source.mimeType} is not a supported video type.`);
  }
  const clipped = options.startSeconds !== undefined || options.endSeconds !== undefined || options.fps !== undefined;
  if (options.processing === 'agentic') {
    if (!AGENTIC_ANALYSIS_MODELS.includes(model)) throw new Error(`Agentic processing needs one of ${AGENTIC_ANALYSIS_MODELS.join(', ')} (got ${model}).`);
    if (clipped) throw new Error('Start, end, and fps only apply to static processing.');
  }
  for (const [label, value] of [['start', options.startSeconds], ['end', options.endSeconds]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`The ${label} time must be zero or more seconds.`);
  }
  if (options.startSeconds !== undefined && options.endSeconds !== undefined && options.endSeconds <= options.startSeconds) {
    throw new Error('The end time must be after the start time.');
  }
  if (options.fps !== undefined && (!Number.isFinite(options.fps) || options.fps <= 0)) throw new Error('fps must be greater than 0.');
  if (options.responseSchema !== undefined && (!options.responseSchema || typeof options.responseSchema !== 'object' || Array.isArray(options.responseSchema))) {
    throw new Error('The response schema must be a JSON Schema object.');
  }
  if (options.mediaResolution && !MEDIA_RESOLUTIONS.includes(options.mediaResolution)) {
    throw new Error(`Media resolution must be one of ${MEDIA_RESOLUTIONS.join(', ')}.`);
  }
}

/** The `processing` value for a video part, or undefined to keep the model's default (static, 1 FPS). */
export function processingConfig(options: Pick<AnalyzeVideoOptions, 'processing' | 'startSeconds' | 'endSeconds' | 'fps'>): unknown {
  if (options.processing === 'agentic') return 'agentic';
  const config: Record<string, unknown> = {};
  if (options.startSeconds !== undefined) config.start_offset = `${options.startSeconds}s`;
  if (options.endSeconds !== undefined) config.end_offset = `${options.endSeconds}s`;
  if (options.fps !== undefined) config.fps = options.fps;
  if (Object.keys(config).length) return { type: 'static', ...config };
  return options.processing === 'static' ? 'static' : undefined;
}

async function resolveSource(source: VideoSource): Promise<ResolvedSource> {
  if (source.kind === 'youtube') return source;
  if (source.kind === 'bytes') return { kind: 'local', bytes: source.bytes, mimeType: source.mimeType, name: source.name ?? 'video' };
  let info;
  try { info = await stat(source.path); } catch { throw new Error(`Video not found: ${source.path}`); }
  if (!info.isFile()) throw new Error(`${source.path} is not a file.`);
  return { kind: 'local', bytes: new Uint8Array(await readFile(source.path)), mimeType: videoMimeType(source.path), name: path.basename(source.path) };
}

/** Reads are safe to repeat, so a dropped connection is retried as well as overload. */
function isRetryableRead(error: unknown): boolean {
  return isRetryableError(error) || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String((error as Error)?.message ?? error));
}

function fileState(file: { state?: unknown }): string | undefined {
  return typeof file.state === 'string' ? file.state : (file.state as { name?: string } | undefined)?.name;
}

function lastOutputText(steps: Step[] | undefined): string {
  const output = [...(steps ?? [])].reverse().find((step) => step.type === 'model_output');
  return (output?.content ?? []).filter((item) => item.type === 'text' && item.text).map((item) => item.text).join('').trim();
}

/** One short line for a thought summary: its bold title when it has one, else its first line. */
export function progressLine(summary: string): string {
  const text = summary.trim();
  const title = /^\*\*([^*]+)\*\*/.exec(text)?.[1];
  const line = (title ?? text.split('\n')[0]).replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_PROGRESS_CHARS ? `${line.slice(0, MAX_PROGRESS_CHARS - 1).trimEnd()}…` : line;
}

/** True for a `response_format` that asks for JSON, alone or in a list. */
function isJsonFormat(format: unknown): boolean {
  return (Array.isArray(format) ? format : [format]).some((entry) => (entry as { mime_type?: unknown } | null)?.mime_type === 'application/json');
}

function usageFrom(usage: Record<string, number | undefined> | undefined): VideoAnalysisUsage | undefined {
  if (!usage) return undefined;
  const result: VideoAnalysisUsage = {
    inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, thoughtTokens: usage.total_thought_tokens,
    toolUseTokens: usage.total_tool_use_tokens, totalTokens: usage.total_tokens,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}
