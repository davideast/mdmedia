import type {
  GenerateMusicOptions,
  IMusicProvider,
  MusicGenerationResult,
} from '../music/music-provider.interface.js';
import type { UniversalEventBus } from './pipeline-event-bus.js';

export class DocumentMusicPipeline {
  constructor(
    private readonly musicProvider: IMusicProvider,
    private readonly eventBus?: UniversalEventBus
  ) {}

  async generate(
    prompt: string,
    options: GenerateMusicOptions = {}
  ): Promise<MusicGenerationResult> {
    this.eventBus?.emit('music:start', { prompt });

    try {
      const result = await this.musicProvider.generate(prompt, options);

      this.eventBus?.emit('music:complete', {
        interactionId: result.interactionId,
        audioBytes: result.audioBytes,
        lyrics: result.lyrics,
      });

      this.eventBus?.emit('music:pipeline:complete', {
        totalBytesGenerated: result.audioBytes.byteLength,
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
