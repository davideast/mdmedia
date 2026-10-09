import type {
  GenerateSoundEffectOptions,
  ISoundEffectsProvider,
  SoundEffectResult,
} from '../sfx/sfx-provider.interface.js';
import type { UniversalEventBus } from './pipeline-event-bus.js';

export class SoundEffectsPipeline {
  constructor(
    private readonly sfxProvider: ISoundEffectsProvider,
    private readonly eventBus?: UniversalEventBus
  ) {}

  async generate(
    prompt: string,
    options: GenerateSoundEffectOptions = {}
  ): Promise<SoundEffectResult> {
    this.eventBus?.emit('sfx:start', { prompt });

    try {
      const result = await this.sfxProvider.generate(prompt, options);

      this.eventBus?.emit('sfx:complete', {
        audioBytes: result.audioBytes,
        mimeType: result.mimeType,
      });

      return result;
    } catch (error: any) {
      this.eventBus?.emit('pipeline:error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }
}
