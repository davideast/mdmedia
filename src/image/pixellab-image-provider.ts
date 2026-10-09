import { decodeImage, imageMimeType } from './image-data.js';
import { ImageHttpClient, type ImageHttpOptions } from './http.js';
import { parseImageSize, validateImageRequest } from './selection.js';
import type { IImageProvider, ImageRequest, ImageResult } from './types.js';

export class PixelLabImageProvider implements IImageProvider {
  private readonly http: ImageHttpClient;
  constructor(private readonly apiKey: string, options: ImageHttpOptions = {}) {
    if (!apiKey.trim()) throw new Error('PIXELLAB_API_KEY is required for image generation.');
    this.http = new ImageHttpClient(options);
  }

  async generate(input: ImageRequest): Promise<ImageResult> {
    const request = validateImageRequest('pixellab', input);
    const { body, requestId } = await this.http.json(
      `https://api.pixellab.ai/v2/create-image-${request.model}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: request.prompt, image_size: parseImageSize(request.size ?? '128x128'),
          no_background: request.background === 'transparent',
          seed: request.seed,
          ...(request.reference ? { init_image: {
            type: 'base64', base64: Buffer.from(request.reference.bytes).toString('base64'),
            format: request.reference.mimeType === 'image/png' ? 'png' : 'jpeg',
          } } : {}),
        }),
      }
    );
    if (!body.image?.base64) throw new Error('PixelLab returned no image data.');
    const imageBytes = decodeImage(body.image.base64);
    return { imageBytes, mimeType: imageMimeType(imageBytes), provider: 'pixellab', model: request.model, requestId, usage: body.usage };
  }
}
