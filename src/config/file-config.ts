import type { AspectRatio, DeliveryMode, MediaType, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';

export interface AudioConfig {
  readonly voice?: VoiceName;
  readonly style?: string;
  readonly model?: string;
  readonly play?: boolean;
}

export interface VideoConfig {
  readonly model?: string;
  readonly aspectRatio?: AspectRatio;
  readonly task?: VideoTask;
  readonly delivery?: DeliveryMode;
  readonly referenceImages?: string[];
  readonly firstFrame?: string;
  readonly previousInteractionId?: string;
}

export interface NarrationConfig {
  readonly enabled?: boolean;
  readonly model?: string;
}

export interface MdMediaConfig {
  readonly mode?: MediaType;
  readonly audio?: AudioConfig;
  readonly video?: VideoConfig;
  readonly narration?: NarrationConfig;
  readonly maxChars?: number;
  readonly maxRetries?: number;
  readonly apiKey?: string;
}
