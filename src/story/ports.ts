import type { VoiceRef } from './types.js';

/** 24 kHz, signed 16-bit, mono PCM: what every speech provider here returns. */
export const PCM_RATE = 24_000;

export interface SpeakRequest {
  /** The words to say. */
  text: string;
  voice: VoiceRef;
  /** How to say them; sent apart from the words so it is never spoken. */
  note: string;
  signal?: AbortSignal;
}

/** Voices one line. */
export interface Speaker {
  /** Provider and model, recorded in keys and build.json. */
  readonly provider: { name: string; model: string };
  speak(request: SpeakRequest): Promise<Uint8Array>;
}

/** Thrown by a Speaker when the provider's input filter refuses a request. */
export class SpeechRefused extends Error {
  constructor(message = 'The speech provider refused this request.') {
    super(message);
    this.name = 'SpeechRefused';
  }
}

/** Turns one clip of speech back into words, for checking. */
export interface Transcriber {
  readonly model: string;
  /** `wav` is a complete WAV file. */
  transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<string>;
}

export interface LineCheck {
  heard: string;
  missing: string[];
  extra: string[];
  ok: boolean;
}

export interface CachedLine {
  pcm: Uint8Array;
  check: LineCheck;
  /** Only takes that passed their check are reused without a new take. */
  accepted: boolean;
}

/** Content-addressed store for rendered lines. */
export interface RenderCache {
  get(key: string): Promise<CachedLine | undefined>;
  put(key: string, line: CachedLine): Promise<void>;
}

/**
 * The one place audio is normalized and encoded. The Node implementation uses
 * ffmpeg; a browser one can replace it.
 */
export interface AudioRuntime {
  /** A 48 kHz stereo WAV master from 24 kHz mono PCM, normalized to the target. */
  master(pcm: Uint8Array, target: { loudnessLufs: number; truePeakDb: number }): Promise<Uint8Array>;
  /** An MP3 of a WAV file. */
  mp3(wav: Uint8Array, kbps: number): Promise<Uint8Array>;
  /** Where the encoder came from, for build.json. */
  describe(): Promise<{ path: string; version: string }>;
}

/** Where a build writes its files. Paths are relative to the build's output folder. */
export interface FileSink {
  write(path: string, data: Uint8Array | string): Promise<void>;
}
