import type { IMusicProvider } from './music-provider.interface.js';
import { LyriaMusicProvider } from './lyria-music-provider.js';

export type MusicFactory = (client?: any, options?: { maxRetries?: number; model?: string }) => IMusicProvider;
export type MusicProviderEntry = IMusicProvider | MusicFactory;

export class MusicProviderRegistry {
  private providers = new Map<string, MusicProviderEntry>();

  register(name: string, provider: MusicProviderEntry): void {
    this.providers.set(name.toLowerCase(), provider);
  }

  get(name: string): MusicProviderEntry | undefined {
    return this.providers.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const musicRegistry = new MusicProviderRegistry();

// Register Lyria as the default music provider under 'lyria'
musicRegistry.register('lyria', ((client: any, options?: { maxRetries?: number; model?: string }) =>
  new LyriaMusicProvider(client, options?.maxRetries ?? 3, options?.model)) as MusicFactory);

export function getMusicProvider(
  name: string,
  client?: any,
  options?: { maxRetries?: number; model?: string }
): IMusicProvider | undefined {
  const entry = musicRegistry.get(name);
  if (!entry) return undefined;
  if (typeof entry === 'function') {
    return (entry as MusicFactory)(client, options);
  }
  return entry as IMusicProvider;
}

export function registerMusicProvider(name: string, provider: MusicProviderEntry): void {
  musicRegistry.register(name, provider);
}
