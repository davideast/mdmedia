import type { ISoundEffectsProvider } from './sfx-provider.interface.js';
import { ElevenLabsSoundEffectsProvider } from './elevenlabs-sfx-provider.js';
import { elevenLabsApiKeyFromEnv } from '../elevenlabs/request-error.js';

export interface SoundEffectsProviderOptions {
  apiKey?: string;
  maxRetries?: number;
  model?: string;
  /** HTTP transport, useful for custom runtimes and tests. */
  request?: typeof fetch;
}

export type SoundEffectsFactory = (options?: SoundEffectsProviderOptions) => ISoundEffectsProvider;
export type SoundEffectsProviderEntry = ISoundEffectsProvider | SoundEffectsFactory;

export class SoundEffectsProviderRegistry {
  private providers = new Map<string, SoundEffectsProviderEntry>();

  register(name: string, provider: SoundEffectsProviderEntry): void {
    this.providers.set(name.toLowerCase(), provider);
  }

  get(name: string): SoundEffectsProviderEntry | undefined {
    return this.providers.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const sfxRegistry = new SoundEffectsProviderRegistry();

sfxRegistry.register('elevenlabs', (options: SoundEffectsProviderOptions = {}) =>
  new ElevenLabsSoundEffectsProvider(
    options.apiKey ?? elevenLabsApiKeyFromEnv() ?? '',
    options.maxRetries,
    options.model,
    options.request
  )
);

export function getSoundEffectsProvider(
  name: string,
  options?: SoundEffectsProviderOptions
): ISoundEffectsProvider | undefined {
  const entry = sfxRegistry.get(name);
  if (!entry) return undefined;
  if (typeof entry === 'function') {
    return entry(options);
  }
  return entry;
}

/** Create a sound effects provider, defaulting to ElevenLabs. */
export function createSoundEffectsProvider(
  name = 'elevenlabs',
  options?: SoundEffectsProviderOptions
): ISoundEffectsProvider {
  const provider = getSoundEffectsProvider(name, options);
  if (!provider) {
    throw new Error(
      `Unknown sound effects provider "${name}". Available providers: ${sfxRegistry.list().join(', ')}.`
    );
  }
  return provider;
}

export function registerSoundEffectsProvider(name: string, provider: SoundEffectsProviderEntry): void {
  sfxRegistry.register(name, provider);
}
