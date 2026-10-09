import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';

export interface GenerateVideoOptions {
  model?: string;
  aspectRatio?: AspectRatio;
  task?: VideoTask;
  delivery?: DeliveryMode;
  firstFrame?: string;
  referenceImages?: string[];
  previousInteractionId?: string;
  /** Requested generated seconds for this turn (3–10 for Omni). */
  durationSeconds?: number;
  /** Bounds both the interaction request and Files API polling. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

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
