/**
 * A Web Audio player for 24 kHz / 16-bit / mono PCM that can start playing
 * before the stream has finished arriving.
 *
 * The sample buffer grows as chunks land. Playback is a chain of
 * `AudioBufferSourceNode`s scheduled back to back, so appending never
 * interrupts what is already sounding. Position is read from the audio clock
 * rather than a wall-clock timer, so it cannot drift away from what you hear.
 */

import { SAMPLE_RATE, WAV_HEADER_BYTES } from "./types";
import { timeStretchWsola } from "./wsola";

const MIN_RATE = 0.5;
const MAX_RATE = 2.5;
const INITIAL_CAPACITY = SAMPLE_RATE * 30;
/** How long to wait for more audio after the buffer drains before calling it the end. */
const STARVE_GRACE_MS = 600;
const MAX_QUEUED_SOURCES = 2;
const BATCH_SAMPLES = SAMPLE_RATE * 8; // 8 seconds per scheduled buffer

export interface PcmPlayerState {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  rate: number;
  volume: number;
}

type Subscriber = (state: PcmPlayerState) => void;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Reads the PCM payload out of a WAV file by walking its chunk table. */
function extractPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.byteLength < WAV_HEADER_BYTES) return new Uint8Array(0);

  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "data") {
      return wav.subarray(body, Math.min(body + size, wav.byteLength));
    }
    offset = body + size + (size % 2);
  }
  return wav.subarray(WAV_HEADER_BYTES);
}

export class StreamingPcmPlayer {
  private samples: Float32Array<ArrayBuffer> = new Float32Array(INITIAL_CAPACITY);
  private sampleCount = 0;
  /** A trailing odd byte from a delta that split a 16-bit frame. */
  private carryByte: number | null = null;

  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();

  private scheduledSamples = 0;
  private nextStartTime = 0;
  private anchorCtxTime = 0;
  private anchorMs = 0;
  private pausedMs = 0;

  private isPlaying = false;
  private rateValue = 1;
  private volumeValue = 1;
  private complete = false;
  private destroyed = false;

  private frame: number | null = null;
  private starveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers = new Set<Subscriber>();

  /** Appends 16-bit little-endian mono PCM, extending the track in place. */
  append(pcm: Uint8Array): void {
    if (this.destroyed || pcm.byteLength === 0) return;

    let bytes = pcm;
    if (this.carryByte !== null) {
      const joined = new Uint8Array(pcm.byteLength + 1);
      joined[0] = this.carryByte;
      joined.set(pcm, 1);
      bytes = joined;
      this.carryByte = null;
    }
    const usableBytes = bytes.byteLength - (bytes.byteLength % 2);
    if (usableBytes < bytes.byteLength) {
      this.carryByte = bytes[bytes.byteLength - 1];
    }
    if (usableBytes === 0) return;

    const incoming = usableBytes / 2;
    this.ensureCapacity(this.sampleCount + incoming);
    for (let i = 0; i < incoming; i += 1) {
      const lo = bytes[i * 2];
      const hi = bytes[i * 2 + 1];
      const signed = ((hi << 8) | lo) << 16 >> 16;
      this.samples[this.sampleCount + i] = signed / 32768;
    }
    this.sampleCount += incoming;

    if (this.isPlaying) this.pump();
    this.notify();
  }

  async play(): Promise<void> {
    if (this.destroyed) return;
    const context = this.ensureContext();
    if (!context) return;

    try {
      await context.resume();
    } catch {
      // An autoplay policy can reject this; it is reported as "not playing".
    }
    if (this.destroyed) return;
    if (context.state !== "running") {
      this.isPlaying = false;
      this.notify();
      return;
    }

    if (this.pausedMs >= this.durationMs) this.pausedMs = 0;
    this.isPlaying = true;
    this.restartFrom(this.pausedMs);
    this.startFrameLoop();
    this.notify();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.pausedMs = this.positionMs;
    this.isPlaying = false;
    this.stopSources();
    this.stopFrameLoop();
    this.notify();
  }

  seek(ms: number): void {
    const target = clamp(ms, 0, this.durationMs);
    this.pausedMs = target;
    if (this.isPlaying) {
      this.restartFrom(target);
    }
    this.notify();
  }

  scrub(deltaMs: number): void {
    this.seek(this.positionMs + deltaMs);
  }

  get rate(): number {
    return this.rateValue;
  }

  setRate(rate: number): void {
    const next = clamp(rate, MIN_RATE, MAX_RATE);
    if (next === this.rateValue) return;
    const resumeAt = this.positionMs;
    this.rateValue = next;
    if (this.isPlaying) {
      this.pausedMs = resumeAt;
      this.restartFrom(resumeAt);
    }
    this.notify();
  }

  setVolume(volume: number): void {
    this.volumeValue = clamp(volume, 0, 1);
    if (this.gain && this.context) {
      this.gain.gain.setValueAtTime(this.volumeValue, this.context.currentTime);
    }
    this.notify();
  }

  get positionMs(): number {
    if (!this.isPlaying || !this.context) {
      return clamp(this.pausedMs, 0, this.durationMs);
    }
    const elapsed = (this.context.currentTime - this.anchorCtxTime) * 1000 * this.rateValue;
    return clamp(this.anchorMs + Math.max(0, elapsed), 0, this.durationMs);
  }

  get durationMs(): number {
    return (this.sampleCount / SAMPLE_RATE) * 1000;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    callback(this.snapshot());
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Replaces or incrementally extends the buffer with a WAV recording. */
  async loadWavUrl(url: string, options?: { final?: boolean }): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("The audio for this narration could not be loaded.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.destroyed) return;

    const pcm = extractPcm(bytes);
    const existingBytes = this.sampleCount * 2;
    if (existingBytes > 0 && pcm.byteLength >= existingBytes) {
      this.complete = false;
      if (pcm.byteLength > existingBytes) {
        this.append(pcm.subarray(existingBytes));
      }
      if (options?.final !== false) {
        this.complete = true;
      }
      this.notify();
      return;
    }

    this.stopSources();
    this.stopFrameLoop();
    this.isPlaying = false;
    this.sampleCount = 0;
    this.scheduledSamples = 0;
    this.carryByte = null;
    this.pausedMs = 0;
    this.complete = false;
    this.append(pcm);
    if (options?.final !== false) {
      this.complete = true;
    }
    this.notify();
  }

  destroy(): void {
    this.destroyed = true;
    this.isPlaying = false;
    this.stopSources();
    this.stopFrameLoop();
    this.clearStarveTimer();
    this.subscribers.clear();
    const context = this.context;
    this.context = null;
    this.gain = null;
    if (context) void context.close().catch(() => undefined);
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.samples.length) return;
    let capacity = this.samples.length || INITIAL_CAPACITY;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.samples.subarray(0, this.sampleCount));
    this.samples = grown;
  }

  private ensureContext(): AudioContext | null {
    if (this.destroyed) return null;
    if (this.context) return this.context;
    if (typeof window === "undefined") return null;

    const Ctor = window.AudioContext;
    if (!Ctor) return null;

    let context: AudioContext;
    try {
      context = new Ctor({ sampleRate: SAMPLE_RATE });
    } catch {
      context = new Ctor();
    }
    const gain = context.createGain();
    gain.gain.value = this.volumeValue;
    gain.connect(context.destination);
    this.context = context;
    this.gain = gain;
    return context;
  }

  private restartFrom(ms: number): void {
    const context = this.context;
    if (!context) return;
    this.stopSources();
    this.clearStarveTimer();
    this.scheduledSamples = clamp(
      Math.floor((ms / 1000) * SAMPLE_RATE),
      0,
      this.sampleCount,
    );
    this.anchorMs = (this.scheduledSamples / SAMPLE_RATE) * 1000;
    this.anchorCtxTime = context.currentTime;
    this.nextStartTime = context.currentTime;
    this.pump();
  }

  /** Schedules samples that have arrived using pitch-preserving WSOLA time stretching. */
  private pump(): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain || !this.isPlaying) return;

    while (this.sources.size < MAX_QUEUED_SOURCES && this.scheduledSamples < this.sampleCount) {
      const pending = this.sampleCount - this.scheduledSamples;
      if (pending <= 0) break;

      const batchSize = Math.min(pending, BATCH_SAMPLES);
      const chunkEnd = this.scheduledSamples + batchSize;
      const rawChunk = this.samples.subarray(this.scheduledSamples, chunkEnd);

      const processed =
        this.rateValue === 1.0
          ? rawChunk
          : timeStretchWsola(rawChunk, this.rateValue, SAMPLE_RATE);

      if (processed.length === 0) {
        this.scheduledSamples = chunkEnd;
        continue;
      }

      this.clearStarveTimer();

      const buffer = context.createBuffer(1, processed.length, SAMPLE_RATE);
      buffer.copyToChannel(processed, 0);

      const startAt = Math.max(context.currentTime, this.nextStartTime);
      if (startAt > this.nextStartTime + 0.001) {
        // The buffer ran dry: re-anchor so position tracks the audio again.
        this.anchorMs = (this.scheduledSamples / SAMPLE_RATE) * 1000;
        this.anchorCtxTime = startAt;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      // Normal 1.0 playback rate on the Web Audio node: WSOLA has already time-stretched
      // the PCM buffer, preserving natural vocal pitch and preventing the chipmunk effect.
      source.playbackRate.value = 1.0;
      source.connect(gain);
      source.onended = () => {
        this.sources.delete(source);
        this.handleSegmentEnd();
      };
      source.start(startAt);

      this.sources.add(source);
      this.scheduledSamples = chunkEnd;
      this.nextStartTime = startAt + buffer.duration;
    }
  }

  private handleSegmentEnd(): void {
    if (!this.isPlaying || this.destroyed) return;
    if (this.sampleCount > this.scheduledSamples) {
      this.pump();
      return;
    }
    if (this.sources.size > 0) return;

    if (this.complete) {
      this.finish();
      return;
    }
    this.clearStarveTimer();
    this.starveTimer = setTimeout(() => {
      this.starveTimer = null;
      if (!this.isPlaying) return;
      if (this.sampleCount > this.scheduledSamples) {
        this.pump();
        return;
      }
      if (this.sources.size === 0) this.finish();
    }, STARVE_GRACE_MS);
  }

  private finish(): void {
    this.isPlaying = false;
    this.pausedMs = this.durationMs;
    this.stopSources();
    this.stopFrameLoop();
    this.notify();
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextStartTime = this.context?.currentTime ?? 0;
  }

  private clearStarveTimer(): void {
    if (this.starveTimer !== null) {
      clearTimeout(this.starveTimer);
      this.starveTimer = null;
    }
  }

  private startFrameLoop(): void {
    if (this.frame !== null || typeof requestAnimationFrame === "undefined") return;
    const tick = () => {
      if (!this.isPlaying || this.destroyed) {
        this.frame = null;
        return;
      }
      this.notify();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopFrameLoop(): void {
    if (this.frame !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.frame);
    }
    this.frame = null;
  }

  private snapshot(): PcmPlayerState {
    return {
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      playing: this.isPlaying,
      rate: this.rateValue,
      volume: this.volumeValue,
    };
  }

  private notify(): void {
    if (this.subscribers.size === 0) return;
    const state = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(state);
  }
}
