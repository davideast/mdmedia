import type { DocumentChunk } from '../types/chunk.js';
import type { VoiceName } from '../types/voice.js';
import type { ITTSProvider } from '../tts/tts-provider.interface.js';
import type { UniversalEventBus } from './pipeline-event-bus.js';

export class DocumentAudioPipeline {
  private aborted = false;

  constructor(
    private readonly ttsProvider: ITTSProvider,
    private readonly eventBus: UniversalEventBus
  ) {}

  abort(): void {
    this.aborted = true;
  }

  async processDocument(
    chunks: DocumentChunk[],
    voice: VoiceName,
    promptStyle?: string
  ): Promise<void> {
    this.aborted = false;
    const totalChars = chunks.reduce((acc, c) => acc + c.charCount, 0);

    this.eventBus.emit('pipeline:start', {
      totalChunks: chunks.length,
      totalChars,
    });

    let totalBytesGenerated = 0;

    try {
      for (const chunk of chunks) {
        if (this.aborted) break;
        this.eventBus.emit('chunk:start', { chunk });

        const audioStream = this.ttsProvider.streamAudio(chunk.text, voice, promptStyle);

        for await (const pcmChunk of audioStream) {
          if (this.aborted) break;
          totalBytesGenerated += pcmChunk.byteLength;
          this.eventBus.emit('audio:delta', {
            chunkIndex: chunk.index,
            audioData: pcmChunk,
          });
        }

        this.eventBus.emit('chunk:complete', {
          chunkIndex: chunk.index,
        });
      }

      // Awaited, unlike the per-chunk events above: sinks flush on this event, and
      // processDocument() must not resolve until that flush has actually landed.
      await this.eventBus.emitAndWait('pipeline:complete', {
        totalChunksProcessed: chunks.length,
        totalBytesGenerated,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Await teardown too, so sinks close their handles before the throw surfaces.
      try {
        await this.eventBus.emitAndWait('pipeline:error', { error });
      } catch {
        // A failing error-handler must not mask the original failure.
      }
      throw error;
    }
  }
}
