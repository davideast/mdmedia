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
  /**
   * `wav` is a complete WAV file. `names` are the cast's names, so they are
   * spelled the way the story spells them.
   */
  transcribe(wav: Uint8Array, options?: { names?: string[]; signal?: AbortSignal }): Promise<string>;
}

/** How well an audition clip matches a performance brief, each 0 to 10. */
export interface VoiceScore {
  /** Apparent gender and age. */
  who: number;
  accent: number;
  /** Texture, resonance and rhythm. */
  texture: number;
  /** Overall: would you cast this voice. */
  fit: number;
  /** One sentence on what was heard. */
  note: string;
}

/** Listens to an audition and scores it against a brief, for casting. */
export interface VoiceJudge {
  readonly model: string;
  /** `wav` is a complete WAV file. */
  score(request: { wav: Uint8Array; brief: string; signal?: AbortSignal }): Promise<VoiceScore>;
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

/** A text model, for the director. */
export interface TextModel {
  readonly model: string;
  /** With `json`, the reply must be one JSON value and nothing else. */
  generate(request: { system: string; prompt: string; json?: boolean; signal?: AbortSignal }): Promise<string>;
}

/** Writes about 30 seconds of instrumental music for a prompt. */
export interface Composer {
  readonly model: string;
  compose(prompt: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface CachedMusic {
  bytes: Uint8Array;
  mimeType: string;
}

/** An image, as bytes. */
export interface ImageBytes {
  bytes: Uint8Array;
  mimeType: string;
}

/** Draws images, with reference images it should follow. */
export interface ImageModel {
  readonly model: string;
  draw(request: { prompt: string; references: ImageBytes[]; aspectRatio: string; signal?: AbortSignal }): Promise<ImageBytes>;
}

/** Looks at images: strict yes/no answers, and where named characters' heads are. */
export interface Vision {
  readonly model: string;
  /** One answer per question, in order. The images are shown first, each with its label. */
  ask(request: { images: Array<ImageBytes & { label: string }>; questions: string[]; signal?: AbortSignal }): Promise<boolean[]>;
  /** Head boxes as fractions of the image: [ymin, xmin, ymax, xmax]. */
  heads(request: { image: ImageBytes; characters: Array<{ id: string; look: string }>; signal?: AbortSignal }): Promise<Array<{ id: string; box: [number, number, number, number] }>>;
}

/** A cached image or JSON result, with what its checks found. */
export interface CachedImage extends ImageBytes {
  meta: Record<string, unknown>;
}

/** Content-addressed store for rendered lines, music and images. */
export interface RenderCache {
  get(key: string): Promise<CachedLine | undefined>;
  put(key: string, line: CachedLine): Promise<void>;
  getMusic(key: string): Promise<CachedMusic | undefined>;
  putMusic(key: string, music: CachedMusic): Promise<void>;
  getImage(key: string): Promise<CachedImage | undefined>;
  putImage(key: string, image: CachedImage): Promise<void>;
}

/** A music clip under the voices, with its gain over time. */
export interface MixBed {
  audio: Uint8Array;
  mimeType: string;
  /** Where the clip starts on the timeline. */
  atMs: number;
  /** [ms from the clip's start, gain]; linear between points, the last gain holds. */
  envelope: Array<[number, number]>;
}

/** Everything the runtime needs to make the master. */
export interface MixPlan {
  /** The voice track: 24 kHz mono PCM. */
  voice: Uint8Array;
  beds: MixBed[];
  durationMs: number;
}

/**
 * The one place audio is normalized and encoded. The Node implementation uses
 * ffmpeg; a browser one can replace it.
 */
export interface AudioRuntime {
  /** A 48 kHz stereo WAV master: the voice track with its music beds, normalized to the target. */
  mix(plan: MixPlan, target: { loudnessLufs: number; truePeakDb: number }): Promise<Uint8Array>;
  /** An MP3 of a WAV file. */
  mp3(wav: Uint8Array, kbps: number): Promise<Uint8Array>;
  /** A WebP of a PNG or JPEG image, for the reader. */
  webp(image: Uint8Array, quality: number): Promise<Uint8Array>;
  /** Where the encoder came from, for build.json. */
  describe(): Promise<{ path: string; version: string }>;
}

/** Where a build writes its files. Paths are relative to the build's output folder. */
export interface FileSink {
  write(path: string, data: Uint8Array | string): Promise<void>;
}
