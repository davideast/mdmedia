export type MusicModel = 'lyria-3.5' | 'lyria-3-clip-preview' | (string & {});

export type MusicOutputFormat = 'mp3' | 'wav';

export interface GenerateMusicOptions {
  model?: MusicModel;
  outputFormat?: MusicOutputFormat;
  referenceImages?: string[];
  reference?: { bytes: Uint8Array; mimeType: string };
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onInteraction?: (id: string) => void | Promise<void>;
}

export interface MusicGenerationResult {
  interactionId: string;
  audioBytes: Uint8Array;
  mimeType: string;
  lyrics?: string;
  durationSeconds?: number;
}

export interface IMusicProvider {
  generate(
    prompt: string,
    options?: GenerateMusicOptions
  ): Promise<MusicGenerationResult>;
}
