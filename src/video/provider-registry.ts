import type { IVideoProvider } from './video-provider.interface.js';
import { GeminiOmniVideoProvider } from './gemini-omni-video-provider.js';

export type VideoFactory = (client?: any, options?: { maxRetries?: number; model?: string }) => IVideoProvider;
export type VideoProviderEntry = IVideoProvider | VideoFactory;

export class VideoProviderRegistry {
  private providers = new Map<string, VideoProviderEntry>();

  register(name: string, provider: VideoProviderEntry): void {
    this.providers.set(name.toLowerCase(), provider);
  }

  get(name: string): VideoProviderEntry | undefined {
    return this.providers.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const videoRegistry = new VideoProviderRegistry();

// Register Gemini Omni as the default video provider under 'gemini-omni'
videoRegistry.register('gemini-omni', ((client: any, options?: { maxRetries?: number; model?: string }) =>
  new GeminiOmniVideoProvider(client, options?.maxRetries ?? 3, options?.model)) as VideoFactory);

export function getVideoProvider(
  name: string,
  client?: any,
  options?: { maxRetries?: number; model?: string }
): IVideoProvider | undefined {
  const entry = videoRegistry.get(name);
  if (!entry) return undefined;
  if (typeof entry === 'function') {
    return (entry as VideoFactory)(client, options);
  }
  return entry as IVideoProvider;
}

export function registerVideoProvider(name: string, provider: VideoProviderEntry): void {
  videoRegistry.register(name, provider);
}
