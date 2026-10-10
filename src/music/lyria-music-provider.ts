import type { GoogleGenAI } from '@google/genai';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { GenerateMusicOptions, IMusicProvider, MusicGenerationResult } from './music-provider.interface.js';

type AudioOutput = { data?: string; uri?: string; mime_type?: string };
type Interaction = { id?: string; output_audio?: AudioOutput; output_text?: string; steps?: Array<{ type?: string; content?: Array<AudioOutput & { type?: string; text?: string }> }> };
const MAX_BYTES = 100 * 1024 * 1024;

/** Finite Lyria songs. A paid create is never automatically repeated. */
export class LyriaMusicProvider implements IMusicProvider {
  constructor(private readonly client: GoogleGenAI, private readonly maxRetries = 3, private readonly defaultModel = 'lyria-3.5') {}

  async generate(prompt: string, options: GenerateMusicOptions = {}): Promise<MusicGenerationResult> {
    return this.withDeadline(options, async signal => {
      const inputs: Array<{ type: 'image'; data: string; mime_type: string } | { type: 'text'; text: string }> = [];
      if ((options.referenceImages?.length ?? 0) + Number(Boolean(options.reference)) > 10) throw new Error('Lyria accepts at most ten reference images');
      for (const file of options.referenceImages ?? []) {
        const bytes = await readFile(file);
        const ext = path.extname(file).toLowerCase();
        inputs.push({ type: 'image', data: bytes.toString('base64'), mime_type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' });
      }
      if (options.reference) inputs.push({ type: 'image', data: Buffer.from(options.reference.bytes).toString('base64'), mime_type: options.reference.mimeType });
      inputs.push({ type: 'text', text: prompt });
      const model = options.model ?? this.defaultModel;
      if (model === 'lyria-3-clip-preview' && options.outputFormat === 'wav') throw new Error('The clip model returns MP3; convert the saved clip locally for WAV output');
      const payload = { model, store: true, input: inputs.length === 1 ? prompt : inputs,
        ...(options.outputFormat === 'wav' && model !== 'lyria-3-clip-preview' ? { response_format: { type: 'audio' as const } } : {}) };
      signal.throwIfAborted();
      // The SDK also retries by default, so disable its retries explicitly.
      const response = await this.client.interactions.create(payload, { maxRetries: 0, fetchOptions: { signal } }) as Interaction;
      if (!response.id) throw new Error('Lyria returned no interaction ID');
      await options.onInteraction?.(response.id);
      return this.output(response, options, signal);
    });
  }

  /** Safe recovery: retrieving a receipt never starts a new song. */
  async retrieve(interactionId: string, options: GenerateMusicOptions = {}): Promise<MusicGenerationResult> {
    if (!interactionId) throw new Error('A stored interaction ID is required');
    return this.withDeadline(options, async signal => {
      const response = await this.client.interactions.get(interactionId, {}, { maxRetries: this.maxRetries, fetchOptions: { signal } }) as Interaction;
      return this.output({ ...response, id: interactionId }, options, signal);
    });
  }

  private async output(response: Interaction, options: GenerateMusicOptions, signal: AbortSignal): Promise<MusicGenerationResult> {
    const content = response.steps?.filter(step => step.type === 'model_output').flatMap(step => step.content ?? []) ?? [];
    const blocks = content.filter(block => block.type === 'audio' && (block.data || block.uri));
    if (!response.output_audio && blocks.length > 1) throw new Error('Lyria returned multiple audio outputs without a complete song');
    const audio = response.output_audio ?? blocks[0];
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    let bytes: Uint8Array;
    if (audio?.data) {
      if (audio.data.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error('Music exceeds the output size limit');
      bytes = new Uint8Array(Buffer.from(audio.data, 'base64'));
    } else if (audio?.uri) {
      // Resolve only Google Files resource names through the authenticated SDK, never arbitrary URLs.
      const match = audio.uri.match(/^(?:https:\/\/generativelanguage\.googleapis\.com\/(?:v1beta|v1)\/)?files\/([A-Za-z0-9_-]+)(?:\?.*)?$/);
      if (!match) throw new Error('Lyria returned an unsupported audio URI');
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mdmedia-lyria-'));
      const downloadPath = path.join(directory, 'audio');
      try {
        await this.client.files.download({ file: { name: `files/${match[1]}` }, downloadPath, config: { abortSignal: signal } });
        if ((await stat(downloadPath)).size > maxBytes) throw new Error('Music exceeds the output size limit');
        bytes = new Uint8Array(await readFile(downloadPath));
      } finally { await rm(directory, { recursive: true, force: true }); }
    } else throw new Error('Lyria did not return any audio data in response');
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > maxBytes) throw new Error('Music is empty or exceeds the output size limit');
    const wav = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
    return { interactionId: response.id!, audioBytes: bytes,
      mimeType: wav.startsWith('RIFF') && wav.endsWith('WAVE') ? 'audio/wav' : audio?.mime_type ?? 'audio/mpeg',
      lyrics: response.output_text || content.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n') || undefined };
  }

  private async withDeadline<T>(options: GenerateMusicOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Music request timed out')), options.timeoutMs ?? 600_000);
    try { return await run(controller.signal); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
}
