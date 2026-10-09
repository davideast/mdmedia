export type SoundEffectModel = 'eleven_text_to_sound_v2' | (string & {});

export type SoundEffectOutputFormat = 'mp3' | 'wav';

export interface GenerateSoundEffectOptions {
  model?: SoundEffectModel;
  outputFormat?: SoundEffectOutputFormat;
  /** Target length between 0.5 and 30 seconds; omitted lets the model choose. */
  durationSeconds?: number;
  /** How literally to follow the prompt, between 0 and 1. */
  promptInfluence?: number;
  /** Produce a seamlessly looping effect. */
  loop?: boolean;
}

export interface SoundEffectResult {
  audioBytes: Uint8Array;
  mimeType: string;
  outputFormat: SoundEffectOutputFormat;
}

export interface ISoundEffectsProvider {
  generate(
    prompt: string,
    options?: GenerateSoundEffectOptions
  ): Promise<SoundEffectResult>;
}
