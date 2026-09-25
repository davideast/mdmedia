import type { ITTSProvider } from './tts-provider.interface.js';
import { GeminiTTSProvider } from './gemini-tts-provider.js';

export type TTSFactory = (client?: any, options?: { maxRetries?: number; model?: string }) => ITTSProvider;
export type TTSProviderEntry = ITTSProvider | TTSFactory;

export class ProviderRegistry<T = TTSProviderEntry> {
  private providers = new Map<string, T>();

  register(name: string, provider: T): void {
    this.providers.set(name.toLowerCase(), provider);
  }

  get(name: string): T | undefined {
    return this.providers.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const ttsRegistry = new ProviderRegistry<TTSProviderEntry>();

// Register Gemini as the default TTS provider under 'gemini'
ttsRegistry.register('gemini', ((client: any, options?: { maxRetries?: number; model?: string }) =>
  new GeminiTTSProvider(client, options?.maxRetries ?? 3, options?.model)) as TTSFactory);

export function getTTSProvider(
  name: string,
  client?: any,
  options?: { maxRetries?: number; model?: string }
): ITTSProvider | undefined {
  const entry = ttsRegistry.get(name);
  if (!entry) return undefined;
  if (typeof entry === 'function') {
    return (entry as TTSFactory)(client, options);
  }
  return entry as ITTSProvider;
}

export function registerTTSProvider(name: string, provider: TTSProviderEntry): void {
  ttsRegistry.register(name, provider);
}
