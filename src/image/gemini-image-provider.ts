import type { GoogleGenAI } from '@google/genai';
import { decodeImage, imageMimeType } from './image-data.js';
import { imageGenerationConfig, validateImageRequest } from './selection.js';
import type { IImageProvider, ImageRequest, ImageResult } from './types.js';

export class GeminiImageProvider implements IImageProvider {
  constructor(private readonly client: GoogleGenAI) {}

  async generate(input: ImageRequest): Promise<ImageResult> {
    const request = validateImageRequest('gemini', input);
    const response = await this.client.models.generateContent({
      model: request.model,
      contents: request.reference ? [
        { inlineData: { data: Buffer.from(request.reference.bytes).toString('base64'), mimeType: request.reference.mimeType } },
        { text: request.prompt },
      ] : request.prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: imageGenerationConfig(request.aspectRatio ?? '16:9', request.size),
        abortSignal: AbortSignal.timeout(300000),
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });
    const image = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.mimeType?.startsWith('image/'))?.inlineData;
    if (!image?.data) throw new Error('Gemini returned no image data.');
    const imageBytes = decodeImage(image.data);
    return { imageBytes, mimeType: imageMimeType(imageBytes), provider: 'gemini', model: request.model, usage: response.usageMetadata };
  }
}
