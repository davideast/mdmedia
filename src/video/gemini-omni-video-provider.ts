import type { GoogleGenAI } from '@google/genai';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculateBackoffMs, isRetryableError } from '../tts/backoff.js';
import { readMp4Duration } from './mp4-duration.js';
import type { ContinueVideoOptions, GenerateVideoOptions, IVideoProvider, VideoContinuationSource, VideoGenerationResult } from './video-provider.interface.js';

type VideoOutput = { uri?: string; data?: string };
type Interaction = { id?: string; output_video?: VideoOutput; steps?: Array<{ type?: string; content?: Array<VideoOutput & { type?: string }> }> };
const MAX_BYTES = 200 * 1024 * 1024;

/** Omni extends one short clip. The caller trims its context and assembles the sequence locally. */
export class GeminiOmniVideoProvider implements IVideoProvider {
  constructor(private readonly client: GoogleGenAI, private readonly maxRetries = 3, private readonly defaultModel = 'gemini-omni-flash-preview') {}

  async generateVideoClip(prompt: string, options: GenerateVideoOptions = {}): Promise<VideoGenerationResult> {
    return this.generate(prompt, options);
  }

  private async generate(prompt: string, options: GenerateVideoOptions, sourceVideo?: Uint8Array): Promise<VideoGenerationResult> {
    return this.withDeadline(options, async signal => {
      if (options.durationSeconds !== undefined && (!Number.isInteger(options.durationSeconds) || options.durationSeconds < 3 || options.durationSeconds > 10)) throw new Error('Video duration must be an integer from 3 to 10 seconds');
      const inputs: Array<{ type: 'image'; data: string; mime_type: string } | { type: 'text'; text: string }> = [];
      for (const imagePath of [options.firstFrame, ...(options.referenceImages ?? [])]) {
        if (!imagePath) continue;
        let bytes: Buffer;
        try { bytes = await readFile(imagePath); } catch { throw new Error(`Reference image not found: ${imagePath}`); }
        const ext = path.extname(imagePath).toLowerCase();
        inputs.push({ type: 'image', data: bytes.toString('base64'), mime_type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' });
      }
      if (options.reference) inputs.push({ type: 'image', data: Buffer.from(options.reference.bytes).toString('base64'), mime_type: options.reference.mimeType });
      inputs.push({ type: 'text', text: prompt });
      const payload = {
        model: options.model ?? this.defaultModel, store: true,
        // Explicit model history keeps native generated-video context without accumulating older clips.
        input: sourceVideo ? [
          { type: 'model_output' as const, content: [{ type: 'video' as const, mime_type: 'video/mp4', data: Buffer.from(sourceVideo).toString('base64') }] },
          { type: 'user_input' as const, content: inputs },
        ] : inputs.length === 1 ? prompt : inputs,
        response_format: { type: 'video' as const, ...(options.aspectRatio && options.task !== 'extend' ? { aspect_ratio: options.aspectRatio } : {}),
          delivery: options.delivery ?? 'uri', ...(options.durationSeconds ? { duration: `${options.durationSeconds}s` } : {}),
          ...(options.resolution ? { resolution: options.resolution } : {}) },
        ...(!sourceVideo && options.task ? { generation_config: { video_config: { task: options.task } } } : {}),
        ...(!sourceVideo && options.previousInteractionId ? { previous_interaction_id: options.previousInteractionId } : {}),
      };
      signal.throwIfAborted();
      // A timed-out create may already have been accepted. Neither SDK nor wrapper may repeat it.
      const interaction = await this.client.interactions.create(payload, { maxRetries: 0, fetchOptions: { signal } }) as Interaction;
      if (!interaction.id) throw new Error('Gemini Omni returned no interaction ID');
      await options.onInteraction?.(interaction.id);
      return this.output(interaction, options, signal);
    });
  }

  async continueVideoClip(prompt: string, source: VideoContinuationSource, options: ContinueVideoOptions = {}): Promise<VideoGenerationResult> {
    const measured = readMp4Duration(source.videoBytes);
    if (!measured || measured < 2.75 || measured > 10.25 || !Number.isFinite(source.durationSeconds) || Math.abs(measured - source.durationSeconds) > 0.25) throw new Error('Continuation requires only the latest clip, measured at 3–10 seconds');
    if (source.videoBytes.length > (options.maxBytes ?? MAX_BYTES)) throw new Error('Source clip exceeds the size limit');
    if (options.reference?.role === 'first_frame') throw new Error('A continuation accepts a reference image, not a new first frame');
    const durationSeconds = options.durationSeconds ?? 10;
    const result = await this.generate(
      `Extend this video by ${durationSeconds} seconds.\n\n${prompt}`,
      { ...options, durationSeconds }, source.videoBytes
    );
    this.validateContinuation(result, measured, durationSeconds);
    return result;
  }

  /** Recovery only retrieves a saved receipt; it never starts a second paid request. */
  async retrieveVideoClip(interactionId: string, options: GenerateVideoOptions = {}): Promise<VideoGenerationResult> {
    if (!interactionId) throw new Error('A stored interaction ID is required');
    return this.withDeadline(options, async signal => {
      const interaction = await this.safeRead(() => this.client.interactions.get(interactionId, {}, { maxRetries: 0, fetchOptions: { signal } }), signal) as Interaction;
      return this.output({ ...interaction, id: interactionId }, options, signal);
    });
  }

  private validateContinuation(result: VideoGenerationResult, parentDuration: number, addedDuration: number) {
    if (!result.durationSeconds || result.durationSeconds <= parentDuration + 0.25 || Math.abs(result.durationSeconds - parentDuration - addedDuration) > 0.5) throw new Error('Omni did not return the requested continuation duration');
  }

  private async output(interaction: Interaction, options: GenerateVideoOptions, signal: AbortSignal): Promise<VideoGenerationResult> {
    const output = interaction.output_video ?? interaction.steps?.flatMap(step => step.content ?? []).find(content => content.type === 'video' && (content.data || content.uri));
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    let bytes: Uint8Array;
    if (output?.data) {
      if (output.data.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error('Video exceeds the output size limit');
      bytes = new Uint8Array(Buffer.from(output.data, 'base64'));
    } else if (output?.uri) {
      const match = output.uri.match(/(?:^|\/)files\/([A-Za-z0-9_-]+)/);
      if (!match) throw new Error('Omni returned an unsupported video URI');
      const name = `files/${match[1]}`;
      while (true) {
        signal.throwIfAborted();
        const info = await this.safeRead(() => this.client.files.get({ name, config: { abortSignal: signal } }), signal);
        const state = typeof info.state === 'string' ? info.state : (info.state as { name?: string } | undefined)?.name;
        if (state === 'ACTIVE') break;
        if (state === 'FAILED') throw new Error('Video generation failed on server');
        await this.pause(1000, signal);
      }
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mdmedia-omni-'));
      const downloadPath = path.join(directory, 'video.mp4');
      try {
        await this.safeRead(() => this.client.files.download({ file: { name }, downloadPath, config: { abortSignal: signal } }), signal);
        if ((await stat(downloadPath)).size > maxBytes) throw new Error('Video exceeds the output size limit');
        bytes = new Uint8Array(await readFile(downloadPath));
      } finally { await rm(directory, { recursive: true, force: true }); }
    } else throw new Error('Gemini Omni did not return any video data or URI in response');
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > maxBytes) throw new Error('Video is empty or exceeds the output size limit');
    return { interactionId: interaction.id!, videoBytes: bytes, durationSeconds: readMp4Duration(bytes) };
  }

  private async safeRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await read(); } catch (error) {
        if (signal.aborted || attempt >= this.maxRetries || !isRetryableError(error)) throw error;
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
  private async withDeadline<T>(options: GenerateVideoOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Video request timed out')), options.timeoutMs ?? (options.resolution === '4k' ? 900_000 : 600_000));
    try { return await run(controller.signal); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
}
