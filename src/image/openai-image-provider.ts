import { decodeImage, imageMimeType } from './image-data.js';
import { ImageHttpClient, type ImageHttpOptions } from './http.js';
import { validateImageRequest } from './selection.js';
import type { IImageProvider, ImageRequest, ImageResult } from './types.js';

export class OpenAIImageProvider implements IImageProvider {
  private readonly http: ImageHttpClient;
  constructor(private readonly apiKey: string, options: ImageHttpOptions = {}) {
    if (!apiKey.trim()) throw new Error('OPENAI_API_KEY is required for image generation.');
    this.http = new ImageHttpClient(options);
  }

  async generate(input: ImageRequest): Promise<ImageResult> {
    const request = validateImageRequest('openai', input);
    const { body, requestId } = await this.http.json(
      `https://api.openai.com/v1/images/${request.reference ? 'edits' : 'generations'}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model, prompt: request.prompt, n: 1,
          size: request.size ?? 'auto', output_format: request.format,
          quality: request.quality ?? 'auto', background: request.background ?? 'auto',
          ...(request.reference ? { images: [{ image_url: `data:${request.reference.mimeType};base64,${Buffer.from(request.reference.bytes).toString('base64')}` }] } : {}),
        }),
      }
    );
    if (!body.data?.[0]?.b64_json) throw new Error('OpenAI returned no image data.');
    const imageBytes = decodeImage(body.data[0].b64_json);
    return { imageBytes, mimeType: imageMimeType(imageBytes), provider: 'openai', model: request.model, requestId, usage: body.usage };
  }
}
