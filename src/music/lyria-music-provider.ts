import type { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { calculateBackoffMs, isRetryableError } from '../tts/backoff.js';
import type {
  GenerateMusicOptions,
  IMusicProvider,
  MusicGenerationResult,
} from './music-provider.interface.js';

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export class LyriaMusicProvider implements IMusicProvider {
  private readonly client: GoogleGenAI;
  private readonly maxRetries: number;
  private readonly defaultModel: string;

  constructor(
    client: GoogleGenAI,
    maxRetries = 3,
    defaultModel = 'lyria-3.5'
  ) {
    this.client = client;
    this.maxRetries = maxRetries;
    this.defaultModel = defaultModel;
  }

  async generate(
    prompt: string,
    options: GenerateMusicOptions = {}
  ): Promise<MusicGenerationResult> {
    const model = options.model ?? this.defaultModel;
    let attempt = 0;

    // Build multimodal inputs if reference images are provided
    const inputs: Array<{ type: string; data?: string; mime_type?: string; text?: string }> = [];

    if (options.referenceImages) {
      for (const imgPath of options.referenceImages) {
        if (fs.existsSync(imgPath)) {
          const imgBytes = await readFile(imgPath);
          inputs.push({
            type: 'image',
            data: Buffer.from(imgBytes).toString('base64'),
            mime_type: getMimeType(imgPath),
          });
        }
      }
    }

    inputs.push({ type: 'text', text: prompt });

    const payload: Record<string, any> = {
      model,
      input: inputs.length === 1 && inputs[0].text ? inputs[0].text : inputs,
    };

    // Request WAV format explicitly only when user asks for it
    if (options.outputFormat === 'wav') {
      payload.response_format = { type: 'audio' };
    }

    while (true) {
      try {
        const interaction = (await (this.client as any).interactions.create(payload)) as any;
        const interactionId = interaction.id || `lyria_${Date.now()}`;

        // 1. Convenience property: output_audio
        if (interaction.output_audio?.data) {
          const audioBytes = new Uint8Array(
            Buffer.from(interaction.output_audio.data, 'base64')
          );
          return {
            interactionId,
            audioBytes,
            mimeType: interaction.output_audio.mime_type || 'audio/mpeg',
            lyrics: interaction.output_text || undefined,
          };
        }

        // 2. Walk steps for interleaved response structure
        if (interaction.steps) {
          let audioBytes: Uint8Array | undefined;
          const lyrics: string[] = [];

          for (const step of interaction.steps) {
            if (step.type === 'model_output' && Array.isArray(step.content)) {
              for (const c of step.content) {
                if (c.type === 'audio' && c.data) {
                  audioBytes = new Uint8Array(Buffer.from(c.data, 'base64'));
                } else if (c.type === 'text' && c.text) {
                  lyrics.push(c.text);
                }
              }
            }
          }

          if (audioBytes) {
            return {
              interactionId,
              audioBytes,
              mimeType: 'audio/mpeg',
              lyrics: lyrics.length > 0 ? lyrics.join('\n') : undefined,
            };
          }
        }

        throw new Error('Lyria did not return any audio data in response');
      } catch (err: any) {
        if (attempt >= this.maxRetries || !isRetryableError(err)) {
          throw err;
        }
        const delayMs = calculateBackoffMs(attempt);
        console.warn(
          `[LyriaMusicProvider] Retrying in ${delayMs}ms due to error: ${err.message || err}`
        );
        await new Promise((res) => setTimeout(res, delayMs));
        attempt++;
      }
    }
  }
}
