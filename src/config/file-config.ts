import type { AspectRatio, DeliveryMode, MediaType, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';

export interface AudioConfig {
  readonly provider?: string;
  readonly apiKey?: string;
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

export interface MusicConfig {
  readonly model?: string;
  readonly outputFormat?: 'mp3' | 'wav';
  readonly referenceImages?: string[];
}

export interface SoundEffectsConfig {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly outputFormat?: 'mp3' | 'wav';
  readonly durationSeconds?: number;
  readonly promptInfluence?: number;
  readonly loop?: boolean;
}

export interface ImageConfig {
  readonly model?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly thinkingLevel?: 'minimal' | 'medium' | 'high';
  readonly adapt?: boolean;
  readonly instructions?: string;
  readonly search?: boolean;
  readonly imageSearch?: boolean;
}

export interface MdMediaConfig {
  readonly mode?: MediaType;
  readonly audio?: AudioConfig;
  readonly video?: VideoConfig;
  readonly image?: ImageConfig;
  readonly music?: MusicConfig;
  readonly sfx?: SoundEffectsConfig;
  readonly narration?: NarrationConfig;
  readonly maxChars?: number;
  readonly maxRetries?: number;
  readonly apiKey?: string;
}

export type MdmediaConfig = MdMediaConfig;
