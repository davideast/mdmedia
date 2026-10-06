import type { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    const model = options.model ?? this.defaultModel;
    let attempt = 0;

    // Prepare inputs
    const inputs: Array<{ type: string; data?: string; mime_type?: string; text?: string }> = [];

    // Attach first frame image if specified
    // A missing image would otherwise be skipped silently, and the clip generated without it.
    for (const imagePath of [options.firstFrame, ...(options.referenceImages ?? [])]) {
      if (imagePath && !fs.existsSync(imagePath)) {
        throw new Error(`Reference image not found: ${imagePath}`);
      }
    }

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

    const payload: Record<string, any> = {
      model,
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
        const interaction = (await (this.client as any).interactions.create(payload)) as any;
        const interactionId = interaction.id || `omni_${Date.now()}`;

        // 1. Check for URI delivery (Files API)
        if (interaction.output_video?.uri) {
          const uri = interaction.output_video.uri;
          const match = uri.match(/files\/([a-zA-Z0-9_\-]+)/);
          const fileId = match ? match[1] : uri.split('/').pop();
          const fileName = `files/${fileId}`;

          // Poll until active
          while (true) {
            const fInfo = await (this.client as any).files.get({ name: fileName });
            const state = fInfo.state?.name || fInfo.state;
            if (state === 'ACTIVE') {
              break;
            }
            if (state === 'FAILED') {
              throw new Error(`Video generation failed on server for file ${fileName}`);
            }
            await new Promise((res) => setTimeout(res, 3000));
          }

          const tempDownloadPath = path.join(
            os.tmpdir(),
            `mdmedia_omni_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
          );

          try {
            await (this.client as any).files.download({
              file: interaction.output_video,
              downloadPath: tempDownloadPath,
            });
            const downloadedBytes = await readFile(tempDownloadPath);
            return {
              interactionId,
              videoBytes: new Uint8Array(downloadedBytes),
            };
          } finally {
            if (fs.existsSync(tempDownloadPath)) {
              await unlink(tempDownloadPath).catch(() => {});
            }
          }
        }

        // 2. Check for inline base64 output
        if (interaction.output_video?.data) {
          const videoBytes = new Uint8Array(
            Buffer.from(interaction.output_video.data, 'base64')
          );
          return {
            interactionId,
            videoBytes,
          };
        }

        // 3. Check steps for REST-like response structure
        if (interaction.steps) {
          for (const step of interaction.steps) {
            if (step.type === 'model_output' && Array.isArray(step.content)) {
              for (const c of step.content) {
                if (c.type === 'video' && c.data) {
                  return {
                    interactionId,
                    videoBytes: new Uint8Array(Buffer.from(c.data, 'base64')),
                  };
                }
              }
            }
          }
        }

        throw new Error('Gemini Omni did not return any video data or URI in response');
      } catch (err: any) {
        if (attempt >= this.maxRetries || !isRetryableError(err)) {
          throw err;
        }
        const delayMs = calculateBackoffMs(attempt);
        console.warn(
          `[GeminiOmniVideoProvider] Retrying in ${delayMs}ms due to error: ${err.message || err}`
        );
        await new Promise((res) => setTimeout(res, delayMs));
        attempt++;
      }
    }
  }
}
