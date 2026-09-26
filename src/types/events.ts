import type { StoryboardScene } from '../chunker/storyboard-parser.js';
import type { DocumentChunk } from './chunk.js';

export interface PipelineStartedEvent {
  totalChunks: number;
  totalChars: number;
}

export interface ChunkStartedEvent {
  chunk: DocumentChunk;
}

export interface AudioDeltaEvent {
  chunkIndex: number;
  audioData: Uint8Array;
}

export interface ChunkCompletedEvent {
  chunkIndex: number;
}

export interface PipelineCompletedEvent {
  totalChunksProcessed: number;
  totalBytesGenerated: number;
}

export interface SceneStartedEvent {
  scene: StoryboardScene;
}

export interface SceneCompletedEvent {
  sceneIndex: number;
  videoBytes: Uint8Array;
  interactionId: string;
}

export interface VideoPipelineCompletedEvent {
  totalScenesProcessed: number;
  totalBytesGenerated: number;
}

export interface MusicGenerationStartedEvent {
  prompt: string;
}

export interface MusicGenerationCompletedEvent {
  interactionId: string;
  audioBytes: Uint8Array;
  lyrics?: string;
}

export interface MusicPipelineCompletedEvent {
  totalBytesGenerated: number;
}

export type PipelineEventMap = {
  'pipeline:start': PipelineStartedEvent;
  'chunk:start': ChunkStartedEvent;
  'audio:delta': AudioDeltaEvent;
  'chunk:complete': ChunkCompletedEvent;
  'pipeline:complete': PipelineCompletedEvent;
  'pipeline:error': { error: Error };
  'scene:start': SceneStartedEvent;
  'scene:complete': SceneCompletedEvent;
  'video:pipeline:complete': VideoPipelineCompletedEvent;
  'music:start': MusicGenerationStartedEvent;
  'music:complete': MusicGenerationCompletedEvent;
  'music:pipeline:complete': MusicPipelineCompletedEvent;
};

