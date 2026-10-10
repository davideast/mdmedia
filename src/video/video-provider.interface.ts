import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';

export interface GenerateVideoOptions {
  model?: string;
  aspectRatio?: AspectRatio;
  task?: VideoTask;
  delivery?: DeliveryMode;
  firstFrame?: string;
  referenceImages?: string[];
  previousInteractionId?: string;
  durationSeconds?: number;
  resolution?: '360p' | '720p' | '1080p' | '4k';
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  reference?: { bytes: Uint8Array; mimeType: string; role: 'first_frame' | 'reference' };
  /** Persist the real provider receipt before retrieving any output. Never retry a paid create. */
  onInteraction?: (interactionId: string) => Promise<void>;
}

/** Only the latest generated clip, never the assembled sequence or its conversation history. */
export interface VideoContinuationSource { videoBytes: Uint8Array; durationSeconds: number }
export type ContinueVideoOptions = Omit<GenerateVideoOptions, 'previousInteractionId' | 'firstFrame' | 'task'>;

export interface VideoGenerationResult {
  interactionId: string;
  videoBytes: Uint8Array;
  durationSeconds?: number;
}

export interface IVideoProvider {
  generateVideoClip(
    prompt: string,
    options?: GenerateVideoOptions
  ): Promise<VideoGenerationResult>;
}
