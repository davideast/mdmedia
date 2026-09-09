import type { AspectRatio, DeliveryMode, MediaType, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';
import type { AudioConfig, MdMediaConfig, NarrationConfig, VideoConfig } from './file-config.js';

export interface ResolvedAudioConfig {
  readonly voice: VoiceName;
  readonly style?: string;
  readonly model: string;
  readonly play: boolean;
}

export interface ResolvedVideoConfig {
  readonly model: string;
  readonly aspectRatio: AspectRatio;
  readonly task: VideoTask;
  readonly delivery: DeliveryMode;
  readonly referenceImages?: string[];
  readonly firstFrame?: string;
  readonly previousInteractionId?: string;
}

export interface ResolvedNarrationConfig {
  readonly enabled: boolean;
  readonly model: string;
}

export interface ResolvedConfig {
  readonly mode: MediaType;
  readonly audio: ResolvedAudioConfig;
  readonly video: ResolvedVideoConfig;
  readonly narration: ResolvedNarrationConfig;
  readonly maxChars: number;
  readonly maxRetries: number;
  readonly apiKey?: string;
}

export interface CLIArgs {
  mode?: MediaType;
  voice?: VoiceName;
  style?: string;
  audioModel?: string;
  play?: boolean;
  narration?: boolean;
  narrationModel?: string;
  videoModel?: string;
  aspectRatio?: AspectRatio;
  task?: VideoTask;
  delivery?: DeliveryMode;
  referenceImages?: string[];
  firstFrame?: string;
  previousInteractionId?: string;
  maxChars?: number;
  maxRetries?: number;
  apiKey?: string;
}

export function resolveConfig(
  cliArgs: CLIArgs = {},
  fileConfig: MdMediaConfig = {},
  env: Record<string, string | undefined> = process.env
): ResolvedConfig {
  const mode = cliArgs.mode ?? fileConfig.mode ?? 'audio';

  const audioConfig: AudioConfig = fileConfig.audio ?? {};
  const videoConfig: VideoConfig = fileConfig.video ?? {};
  const narrationConfig: NarrationConfig = fileConfig.narration ?? {};

  const resolvedAudio: ResolvedAudioConfig = {
    voice: cliArgs.voice ?? audioConfig.voice ?? 'Kore',
    style: cliArgs.style ?? audioConfig.style,
    model: cliArgs.audioModel ?? audioConfig.model ?? 'gemini-3.1-flash-tts-preview',
    play: cliArgs.play ?? audioConfig.play ?? false,
  };

  const resolvedVideo: ResolvedVideoConfig = {
    model: cliArgs.videoModel ?? videoConfig.model ?? 'gemini-omni-flash-preview',
    aspectRatio: cliArgs.aspectRatio ?? videoConfig.aspectRatio ?? '16:9',
    task: cliArgs.task ?? videoConfig.task ?? 'text_to_video',
    delivery: cliArgs.delivery ?? videoConfig.delivery ?? 'uri',
    referenceImages: cliArgs.referenceImages ?? videoConfig.referenceImages,
    firstFrame: cliArgs.firstFrame ?? videoConfig.firstFrame,
    previousInteractionId: cliArgs.previousInteractionId ?? videoConfig.previousInteractionId,
  };

  const resolvedNarration: ResolvedNarrationConfig = {
    enabled: cliArgs.narration ?? narrationConfig.enabled ?? false,
    model: cliArgs.narrationModel ?? narrationConfig.model ?? 'gemini-3.5-flash-lite',
  };

  return {
    mode,
    audio: resolvedAudio,
    video: resolvedVideo,
    narration: resolvedNarration,
    maxChars: cliArgs.maxChars ?? fileConfig.maxChars ?? 400,
    maxRetries: cliArgs.maxRetries ?? fileConfig.maxRetries ?? 3,
    apiKey: cliArgs.apiKey ?? fileConfig.apiKey ?? env.GEMINI_API_KEY,
  };
}
