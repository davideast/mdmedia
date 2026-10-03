import { GoogleGenAI } from '@google/genai';
import type { AudioConfig } from '../config/file-config.js';
import type { VoiceName } from '../types/voice.js';
import type { ITTSProvider } from './tts-provider.interface.js';
import { DEFAULT_GEMINI_TTS_MODEL, GeminiTTSProvider } from './gemini-tts-provider.js';
import { DEFAULT_ELEVENLABS_TTS_MODEL, ElevenLabsTTSProvider } from './elevenlabs-tts-provider.js';
import { normalizeTTSProviderName } from './provider-name.js';
import { elevenLabsApiKeyFromEnv } from '../elevenlabs/request-error.js';

export interface TTSProviderOptions {
  provider?: string;
  apiKey?: string;
  maxRetries?: number;
  model?: string;
  /** Optional synthesis inputs to validate before callers open an output sink. */
  voice?: string;
  style?: string;
  /** Reuse the Gemini client when another narration step already created one. */
  geminiClient?: GoogleGenAI;
  /** HTTP transport for ElevenLabs, useful for custom runtimes and tests. */
  request?: typeof fetch;
}

/** Preserve the existing registry factory shape for callers using getTTSProvider. */
export type TTSFactory = (client?: any, options?: TTSProviderOptions) => ITTSProvider;
export type TTSProviderEntry = ITTSProvider | TTSFactory;

export interface TTSSelectionInput {
  provider?: string;
  voice?: VoiceName;
  style?: string;
  model?: string;
  apiKey?: string;
}

export interface TTSSelection {
  provider: string;
  voice: VoiceName;
  style?: string;
  model: string;
  apiKey?: string;
}

/** Apply provider-specific defaults and credentials before constructing an adapter. */
export function resolveTTSSelection({
  requested = {},
  configured = {},
  legacyApiKey,
  env = process.env,
  forSynthesis = false,
}: {
  requested?: TTSSelectionInput;
  configured?: AudioConfig;
  legacyApiKey?: string;
  env?: Record<string, string | undefined>;
  forSynthesis?: boolean;
} = {}): TTSSelection {
  const provider = normalizeTTSProviderName(
    requested.provider ?? configured.provider ?? env.MDMEDIA_TTS_PROVIDER ?? 'gemini'
  );
  const configuredProvider = normalizeTTSProviderName(configured.provider ?? 'gemini');
  const switchedProvider = provider !== configuredProvider;
  const voice =
    requested.voice ??
    (switchedProvider ? undefined : configured.voice) ??
    (provider === 'elevenlabs' ? env.ELEVENLABS_VOICE ?? env.ELEVENLABS_VOICE_ID ?? '' : 'Kore');
  const style = requested.style ?? (switchedProvider ? undefined : configured.style);
  const model =
    requested.model ??
    (switchedProvider ? undefined : configured.model) ??
    (provider === 'elevenlabs' ? DEFAULT_ELEVENLABS_TTS_MODEL : DEFAULT_GEMINI_TTS_MODEL);
  const apiKey =
    requested.apiKey ??
    (switchedProvider ? undefined : configured.apiKey) ??
    (provider === 'elevenlabs' ? elevenLabsApiKeyFromEnv(env) : legacyApiKey ?? env.GEMINI_API_KEY);

  if (forSynthesis && provider === 'elevenlabs') {
    ElevenLabsTTSProvider.validateSelection(voice, style, true);
  }
  return { provider, voice, style, model, apiKey };
}

export class ProviderRegistry<T = TTSProviderEntry> {
  private providers = new Map<string, T>();

  register(name: string, provider: T): void {
    this.providers.set(normalizeTTSProviderName(name), provider);
  }

  get(name: string): T | undefined {
    return this.providers.get(normalizeTTSProviderName(name));
  }

  has(name: string): boolean {
    return this.providers.has(normalizeTTSProviderName(name));
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const ttsRegistry = new ProviderRegistry<TTSProviderEntry>();

ttsRegistry.register('gemini', (client?: GoogleGenAI, options: TTSProviderOptions = {}) => {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  const selectedClient = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : undefined);
  if (!selectedClient) throw new Error('GEMINI_API_KEY environment variable is required.');
  return new GeminiTTSProvider(selectedClient, options.maxRetries, options.model);
});

ttsRegistry.register('elevenlabs', (_client?: unknown, options: TTSProviderOptions = {}) =>
  new ElevenLabsTTSProvider(
    options.apiKey ?? elevenLabsApiKeyFromEnv() ?? '',
    options.maxRetries,
    options.model,
    options.request
  )
);

export function getTTSProvider(
  name: string,
  client?: any,
  options?: TTSProviderOptions
): ITTSProvider | undefined {
  const entry = ttsRegistry.get(name);
  if (!entry) return undefined;
  if (typeof entry === 'function') {
    return entry(client, options);
  }
  return entry;
}

/** Create an adapter and validate any supplied synthesis settings. */
export function createTTSProvider(options: TTSProviderOptions = {}): ITTSProvider {
  const name = normalizeTTSProviderName(
    options.provider ?? process.env.MDMEDIA_TTS_PROVIDER ?? 'gemini'
  );
  if (options.model !== undefined && !options.model.trim()) {
    throw new Error('TTS model must not be empty.');
  }
  if (name === 'elevenlabs') {
    ElevenLabsTTSProvider.validateSelection(options.voice, options.style);
  }
  const provider = getTTSProvider(name, options.geminiClient, options);
  if (!provider) {
    throw new Error(
      `Unknown TTS provider "${name}". Available providers: ${ttsRegistry.list().join(', ')}.`
    );
  }
  return provider;
}

export function registerTTSProvider(name: string, provider: TTSProviderEntry): void {
  ttsRegistry.register(name, provider);
}
