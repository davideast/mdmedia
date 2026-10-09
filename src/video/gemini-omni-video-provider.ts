import type { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readMp4Duration } from './mp4-duration.js';
import { calculateBackoffMs, isRetryableError } from '../tts/backoff.js';
import type {
  GenerateVideoOptions,
  IVideoProvider,
  VideoGenerationResult,
} from './video-provider.interface.js';

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export class GeminiOmniVideoProvider implements IVideoProvider {
  private readonly client: GoogleGenAI;
  private readonly maxRetries: number;
  private readonly defaultModel: string;

  constructor(
    client: GoogleGenAI,
    maxRetries = 3,
    defaultModel = 'gemini-omni-flash-preview'
  ) {
    this.client = client;
    this.maxRetries = maxRetries;
    this.defaultModel = defaultModel;
  }

  async generateVideoClip(
    prompt: string,
    options: GenerateVideoOptions = {}
  ): Promise<VideoGenerationResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10 * 60 * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    if (options.durationSeconds !== undefined && (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 3 || options.durationSeconds > 10)) {
      throw new RangeError('Omni generates 3–10 seconds per turn. Extend the video for longer scenes.');
    }
    const model = options.model ?? this.defaultModel;
    let attempt = 0;

    // Prepare inputs
    const inputs: Array<{ type: string; data?: string; mime_type?: string; text?: string }> = [];

    // Attach first frame image if specified
    if (options.firstFrame) {
      const fileBytes = await readFile(options.firstFrame);
      inputs.push({
        type: 'image',
        data: Buffer.from(fileBytes).toString('base64'),
        mime_type: getMimeType(options.firstFrame),
      });
    }

    // Attach reference images if specified
    if (options.referenceImages) {
      for (const refPath of options.referenceImages) {
        const refBytes = await readFile(refPath);
        inputs.push({
          type: 'image',
          data: Buffer.from(refBytes).toString('base64'),
          mime_type: getMimeType(refPath),
        });
      }
    }

    inputs.push({
      type: 'text',
      text: prompt,
    });

    const responseFormat: Record<string, any> = {
      type: 'video',
    };
    if (options.aspectRatio) {
      responseFormat.aspect_ratio = options.aspectRatio;
    }
    if (options.delivery) {
      responseFormat.delivery = options.delivery;
    }
    if (options.durationSeconds !== undefined) responseFormat.duration = `${options.durationSeconds}s`;

    const payload: Record<string, any> = {
      model,
      store: true,
      input: inputs.length === 1 && inputs[0].text ? inputs[0].text : inputs,
      response_format: responseFormat,
    };

    if (options.task) {
      payload.generation_config = {
        video_config: {
          task: options.task,
        },
      };
    }

    if (options.previousInteractionId) {
      payload.previous_interaction_id = options.previousInteractionId;
    }

    while (true) {
      try {
        signal.throwIfAborted();
        const interaction = (await (this.client as any).interactions.create(payload, { signal })) as any;
        const interactionId = interaction.id || `omni_${Date.now()}`;
        const output = interaction.output_video ?? interaction.steps
          ?.filter((step: any) => step.type === 'model_output')
          .flatMap((step: any) => step.content ?? [])
          .find((content: any) => content.type === 'video');

        // 1. Check for URI delivery (Files API)
        if (output?.uri) {
          const uri = output.uri;
          const match = uri.match(/files\/([a-zA-Z0-9_\-]+)/);
          const fileId = match ? match[1] : uri.split('/').pop();
          const fileName = `files/${fileId}`;

          // Poll until active
          while (true) {
            signal.throwIfAborted();
            const fInfo = await this.client.files.get({ name: fileName, config: { abortSignal: signal } });
            const rawState: unknown = fInfo.state;
            const state = rawState && typeof rawState === 'object' && 'name' in rawState ? rawState.name : rawState;
            if (state === 'ACTIVE') {
              break;
            }
            if (state === 'FAILED') {
              throw new Error(`Video generation failed on server for file ${fileName}`);
            }
            await delay(3000, undefined, { signal });
          }

          const tempDownloadPath = path.join(
            os.tmpdir(),
            `mdmedia_omni_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
          );

          try {
            await (this.client as any).files.download({
              file: output,
              downloadPath: tempDownloadPath,
              config: { abortSignal: signal },
            });
            const downloadedBytes = await readFile(tempDownloadPath);
            return {
              interactionId,
              videoBytes: new Uint8Array(downloadedBytes),
              durationSeconds: readMp4Duration(downloadedBytes),
            };
          } finally {
            if (fs.existsSync(tempDownloadPath)) {
              await unlink(tempDownloadPath).catch(() => {});
            }
          }
        }

        // 2. Check for inline base64 output
        if (output?.data) {
          const videoBytes = new Uint8Array(
            Buffer.from(output.data, 'base64')
          );
          return {
            interactionId,
            videoBytes,
            durationSeconds: readMp4Duration(videoBytes),
          };
        }

        throw new Error('Gemini Omni did not return any video data or URI in response');
      } catch (err: any) {
        signal.throwIfAborted();
        if (attempt >= this.maxRetries || !isRetryableError(err)) {
          throw err;
        }
        const delayMs = calculateBackoffMs(attempt);
        console.warn(
          `[GeminiOmniVideoProvider] Retrying in ${delayMs}ms due to error: ${err.message || err}`
        );
        await delay(delayMs, undefined, { signal });
        attempt++;
      }
    }
  }
}
