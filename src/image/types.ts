export type ImageProviderName = 'gemini' | 'openai' | 'retrodiffusion' | 'pixellab';
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageBackground = 'auto' | 'opaque' | 'transparent';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ImageSettings {
  provider?: string;
  model?: string;
  apiKey?: string;
  aspectRatio?: string;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  style?: string;
  seed?: number;
  referenceImage?: string;
}

export interface ImageSelection extends ImageSettings {
  provider: ImageProviderName;
  model: string;
}

export interface ImageReference {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageRequest {
  prompt: string;
  model: string;
  aspectRatio?: string;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  style?: string;
  seed?: number;
  format: ImageFormat;
  reference?: ImageReference;
}

export interface ImageResult {
  imageBytes: Uint8Array;
  mimeType: string;
  provider: ImageProviderName;
  model: string;
  requestId?: string;
  usage?: unknown;
}

export interface IImageProvider {
  generate(request: ImageRequest): Promise<ImageResult>;
}
