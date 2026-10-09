import type { UniversalEventBus } from '../pipeline/pipeline-event-bus.js';

export class ProgressLogger {
  constructor(private readonly verbose = false) {}

  attach(eventBus: UniversalEventBus): () => void {
    const unsubs: Array<() => void> = [];

    // Audio pipeline events
    unsubs.push(
      eventBus.on('pipeline:start', ({ totalChunks, totalChars }) => {
        console.log(`[Audio Pipeline] Starting audio narration synthesis...`);
        console.log(`[Audio Pipeline] Document split into ${totalChunks} chunk(s) (${totalChars} characters total).`);
      })
    );

    unsubs.push(
      eventBus.on('chunk:start', ({ chunk }) => {
        console.log(`[Audio Chunk ${chunk.index + 1}] Synthesizing "${chunk.text.slice(0, 60)}${chunk.text.length > 60 ? '...' : ''}" (${chunk.charCount} chars)`);
      })
    );

    let currentChunkBytes = 0;
    unsubs.push(
      eventBus.on('audio:delta', ({ audioData }) => {
        currentChunkBytes += audioData.byteLength;
        if (this.verbose) {
          console.log(`  -> Streaming delta: +${(audioData.byteLength / 1024).toFixed(1)} KB (chunk total: ${(currentChunkBytes / 1024).toFixed(1)} KB)`);
        }
      })
    );

    unsubs.push(
      eventBus.on('chunk:complete', ({ chunkIndex }) => {
        console.log(`[Audio Chunk ${chunkIndex + 1}] Synthesis completed (${(currentChunkBytes / 1024).toFixed(1)} KB audio streamed).`);
        currentChunkBytes = 0;
      })
    );

    unsubs.push(
      eventBus.on('pipeline:complete', ({ totalChunksProcessed, totalBytesGenerated }) => {
        console.log(`[Audio Pipeline] Complete! Processed ${totalChunksProcessed} chunk(s).`);
        console.log(`[Audio Pipeline] Total raw PCM audio: ${(totalBytesGenerated / 1024).toFixed(1)} KB.`);
      })
    );

    // Video pipeline events
    unsubs.push(
      eventBus.on('scene:start', ({ scene }) => {
        const titleStr = scene.title ? ` - "${scene.title}"` : '';
        console.log(`[Video Scene ${scene.index + 1}${titleStr}] Generating clip via Gemini Omni Flash...`);
        if (this.verbose) {
          console.log(`  Prompt: ${scene.prompt.slice(0, 80)}...`);
        }
      })
    );

    unsubs.push(
      eventBus.on('scene:complete', ({ sceneIndex, videoBytes, interactionId }) => {
        console.log(`[Video Scene ${sceneIndex + 1}] Completed (${(videoBytes.byteLength / 1024).toFixed(1)} KB video, ID: ${interactionId}).`);
      })
    );

    unsubs.push(
      eventBus.on('video:pipeline:complete', ({ totalScenesProcessed, totalBytesGenerated }) => {
        console.log(`[Video Pipeline] Complete! Processed ${totalScenesProcessed} scene(s).`);
        console.log(`[Video Pipeline] Total MP4 video: ${(totalBytesGenerated / 1024).toFixed(1)} KB.`);
      })
    );

    // Sound effects events
    unsubs.push(
      eventBus.on('sfx:start', ({ prompt }) => {
        console.log(`[Sound Effect] Generating "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}" via ElevenLabs...`);
      })
    );

    unsubs.push(
      eventBus.on('sfx:complete', ({ audioBytes, mimeType }) => {
        console.log(`[Sound Effect] Completed (${(audioBytes.byteLength / 1024).toFixed(1)} KB ${mimeType}).`);
      })
    );

    unsubs.push(
      eventBus.on('pipeline:error', ({ error }) => {
        console.error(`[Media Pipeline Error] ${error.message}`);
      })
    );

    return () => {
      for (const fn of unsubs) fn();
    };
  }
}
