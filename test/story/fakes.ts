import { PCM_RATE, SpeechRefused, type AudioRuntime, type CachedLine, type CachedMusic, type Composer, type FileSink, type MixPlan, type RenderCache, type SpeakRequest, type Speaker, type Transcriber } from '../../src/story/index.js';

/**
 * A tone, 50 ms per character. The first samples carry the spoken text (its
 * length, then one character per sample) so the scripted transcriber can read
 * it back exactly.
 */
export function toneSpeaker(options: { refuse?: (req: SpeakRequest) => boolean } = {}): Speaker & { calls: SpeakRequest[] } {
  const calls: SpeakRequest[] = [];
  return {
    provider: { name: 'fake', model: 'tone' },
    calls,
    async speak(req) {
      calls.push(req);
      if (options.refuse?.(req)) throw new SpeechRefused();
      const samples = Math.max(req.text.length + 1, Math.round((req.text.length * 50 * PCM_RATE) / 1000));
      const out = new Int16Array(samples);
      out[0] = req.text.length;
      for (let i = 0; i < req.text.length; i++) out[i + 1] = req.text.charCodeAt(i);
      for (let i = req.text.length + 1; i < samples; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 330 * i) / PCM_RATE) * 8000);
      return new Uint8Array(out.buffer);
    },
  };
}

/** Reads the text a tone speaker encoded in a WAV. */
export function textOf(wav: Uint8Array): string {
  const samples = new Int16Array(wav.slice(44).buffer);
  const length = samples[0] ?? 0;
  return String.fromCharCode(...samples.slice(1, 1 + length));
}

/**
 * Hears exactly what was spoken, unless `mishear` returns another transcript
 * for a given line text and call number (1-based, per text).
 */
export function scriptedTranscriber(mishear: (text: string, call: number) => string | undefined = () => undefined): Transcriber & { calls: number; names: string[][] } {
  const counts = new Map<string, number>();
  const self = {
    model: 'fake-transcriber',
    calls: 0,
    names: [] as string[][],
    async transcribe(wav: Uint8Array, options: { names?: string[] } = {}) {
      self.calls++;
      self.names.push(options.names ?? []);
      const text = textOf(wav);
      const call = (counts.get(text) ?? 0) + 1;
      counts.set(text, call);
      return mishear(text, call) ?? text;
    },
  };
  return self;
}

export function memoryCache(): RenderCache & { entries: Map<string, CachedLine>; music: Map<string, CachedMusic> } {
  const entries = new Map<string, CachedLine>();
  const music = new Map<string, CachedMusic>();
  return {
    entries,
    music,
    async get(key) { return entries.get(key); },
    async put(key, line) { entries.set(key, line); },
    async getMusic(key) { return music.get(key); },
    async putMusic(key, clip) { music.set(key, clip); },
  };
}

/** Returns a few bytes per prompt; `fail` makes chosen prompts throw. */
export function fakeComposer(fail: (prompt: string) => boolean = () => false): Composer & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    model: 'fake-music',
    prompts,
    async compose(prompt) {
      prompts.push(prompt);
      if (fail(prompt)) throw new Error('composer failed');
      return { bytes: new TextEncoder().encode(prompt), mimeType: 'audio/mpeg' };
    },
  };
}

export function memorySink(): FileSink & { files: Map<string, Uint8Array | string> } {
  const files = new Map<string, Uint8Array | string>();
  return { files, async write(path, data) { files.set(path, data); } };
}

/** Returns the voice track; records the last mix plan it was given. */
export const passThroughRuntime: AudioRuntime & { lastPlan?: MixPlan } = {
  async mix(plan) { passThroughRuntime.lastPlan = plan; return plan.voice; },
  async mp3(wav) { return wav; },
  async describe() { return { path: 'fake', version: 'fake' }; },
};
