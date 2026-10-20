import { describe, expect, it } from 'bun:test';
import { decodeWav } from '../cut/onset.js';
import { DEFAULT_STS_MODEL, pcmRate, pcmToWav, speechToSpeech, speechToSpeechFields } from './speech-to-speech.js';

describe('ElevenLabs speech-to-speech', () => {
  it('posts the speech as a form to the voice, asking for the output format', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; form: FormData }> = [];
    const request = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, form: init.body as FormData });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await speechToSpeech(new Uint8Array([9, 9]), {
      apiKey: 'k', voiceId: 'v1', request, outputFormat: 'pcm_24000', settings: { stability: 0.5 }, removeBackgroundNoise: true, seed: 7,
    });
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-speech/v1?output_format=pcm_24000');
    expect(calls[0].headers['xi-api-key']).toBe('k');
    const form = calls[0].form;
    expect(form.get('model_id')).toBe(DEFAULT_STS_MODEL);
    expect(form.get('voice_settings')).toBe('{"stability":0.5}');
    expect(form.get('remove_background_noise')).toBe('true');
    expect(form.get('seed')).toBe('7');
    expect((form.get('audio') as File).size).toBe(2);
  });

  it('retries a busy server, but not a refused key or quota', async () => {
    let n = 0;
    const busy = (async () => (++n < 2 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array([5]), { status: 200 }))) as unknown as typeof fetch;
    expect([...(await speechToSpeech(new Uint8Array([1]), { apiKey: 'k', voiceId: 'v', request: busy, maxRetries: 2 }))]).toEqual([5]);
    let m = 0;
    const quota = (async () => { m++; return new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }); }) as unknown as typeof fetch;
    await expect(speechToSpeech(new Uint8Array([1]), { apiKey: 'k', voiceId: 'v', request: quota })).rejects.toThrow('HTTP 401');
    expect(m).toBe(1);
  });

  it('needs a key, a voice and some audio', async () => {
    await expect(speechToSpeech(new Uint8Array([1]), { apiKey: ' ', voiceId: 'v' })).rejects.toThrow('API key');
    await expect(speechToSpeech(new Uint8Array([1]), { apiKey: 'k', voiceId: '' })).rejects.toThrow('voice id');
    await expect(speechToSpeech(new Uint8Array(), { apiKey: 'k', voiceId: 'v' })).rejects.toThrow('some audio');
    expect(() => speechToSpeechFields({ seed: -1 })).toThrow('seed');
  });

  it('wraps raw PCM as a WAV', () => {
    const pcm = new Uint8Array(new Int16Array([0, 16384, -16384]).buffer);
    const audio = decodeWav(pcmToWav(pcm, 24_000));
    expect(audio.sampleRate).toBe(24_000);
    expect([...audio.samples].map((x) => Math.round(x * 2) / 2)).toEqual([0, 0.5, -0.5]);
    expect(pcmRate('pcm_24000')).toBe(24_000);
    expect(pcmRate('mp3_44100_128')).toBeNull();
  });
});
