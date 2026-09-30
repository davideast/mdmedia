import { createTTSProvider } from "mdmedia/tts";
import { wrapPcmAsWav } from "./wav";

const SAMPLE_TEXT = "Hello, this is a sample of my reading voice.";
const MAX_PCM_BYTES = 1024 * 1024;
const samples = new Map<string, Promise<Uint8Array>>();

/** Generate each Gemini voice/model sample once per server process. */
export function geminiVoiceSample(voice: string, model: string, apiKey: string): Promise<Uint8Array> {
  const key = `${model}:${voice}`;
  const existing = samples.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const provider = createTTSProvider({ provider: "gemini", apiKey, model });
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of provider.streamAudio(SAMPLE_TEXT, voice)) {
      total += chunk.byteLength;
      if (total > MAX_PCM_BYTES) throw new Error("Voice sample exceeded the audio limit.");
      chunks.push(chunk);
    }
    if (total === 0) throw new Error("Gemini returned an empty voice sample.");
    const pcm = new Uint8Array(total - (total % 2));
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk.subarray(0, Math.min(chunk.byteLength, pcm.byteLength - offset)), offset);
      offset += Math.min(chunk.byteLength, pcm.byteLength - offset);
    }
    return wrapPcmAsWav(pcm);
  })();
  samples.set(key, pending);
  void pending.catch(() => {
    if (samples.get(key) === pending) samples.delete(key);
  });
  return pending;
}
