import { describe, expect, it } from 'bun:test';
import { resolveConfig } from '../../src/config/config-resolver.js';
import { inferSoundEffectOutputFormat } from '../../src/cli/runner.js';
import { SoundEffectsPipeline } from '../../src/pipeline/sound-effects-pipeline.js';
import { UniversalEventBus } from '../../src/pipeline/pipeline-event-bus.js';
import { ElevenLabsSoundEffectsProvider } from '../../src/sfx/elevenlabs-sfx-provider.js';
import * as sfxModule from '../../src/sfx/index.js';

interface CapturedRequest {
  url: URL;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: CapturedRequest[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push({
      url: new URL(String(input)),
      init: init ?? {},
      body: JSON.parse(String(init?.body)),
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  };
  return { request, calls };
}

const mp3Bytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x44);

describe('ElevenLabsSoundEffectsProvider', () => {
  it('posts the prompt and options to the sound generation endpoint as MP3', async () => {
    const { request, calls } = fakeFetch([() => new Response(mp3Bytes)]);
    const provider = new ElevenLabsSoundEffectsProvider('eleven-key', 0, undefined, request);

    const result = await provider.generate('door creaking open', {
      durationSeconds: 2.5,
      promptInfluence: 0.7,
      loop: true,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url.origin + call.url.pathname).toBe('https://api.elevenlabs.io/v1/sound-generation');
    expect(call.url.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['xi-api-key']).toBe('eleven-key');
    expect(call.body).toEqual({
      text: 'door creaking open',
      model_id: 'eleven_text_to_sound_v2',
      duration_seconds: 2.5,
      prompt_influence: 0.7,
      loop: true,
    });
    expect(result).toEqual({ audioBytes: mp3Bytes, mimeType: 'audio/mpeg', outputFormat: 'mp3' });
  });

  it('omits optional fields so the API applies its own defaults', async () => {
    const { request, calls } = fakeFetch([() => new Response(mp3Bytes)]);
    await new ElevenLabsSoundEffectsProvider('key', 0, undefined, request).generate('thunder');
    expect(calls[0].body).toEqual({ text: 'thunder', model_id: 'eleven_text_to_sound_v2' });
  });

  it('requests 44.1 kHz PCM and wraps it in a WAV header for wav output', async () => {
    const pcm = Uint8Array.of(1, 0, 2, 0, 3, 0);
    const { request, calls } = fakeFetch([() => new Response(pcm)]);
    const result = await new ElevenLabsSoundEffectsProvider('key', 0, undefined, request).generate(
      'rain',
      { outputFormat: 'wav' }
    );

    expect(calls[0].url.searchParams.get('output_format')).toBe('pcm_44100');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.audioBytes.byteLength).toBe(44 + pcm.byteLength);
    const view = new DataView(result.audioBytes.buffer);
    expect(new TextDecoder().decode(result.audioBytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(result.audioBytes.subarray(44)).toEqual(pcm);
  });

  it('retries rate limits and server errors', async () => {
    const { request, calls } = fakeFetch([
      () => new Response('slow down', { status: 429 }),
      () => new Response('oops', { status: 503 }),
      () => new Response(mp3Bytes),
    ]);
    const result = await new ElevenLabsSoundEffectsProvider('key', 2, undefined, request).generate('wind');
    expect(calls).toHaveLength(3);
    expect(result.audioBytes).toEqual(mp3Bytes);
  });

  it('does not retry validation errors and surfaces the API detail', async () => {
    const { request, calls } = fakeFetch([
      () => new Response('{"detail":"bad duration"}', { status: 422 }),
    ]);
    const provider = new ElevenLabsSoundEffectsProvider('key', 3, undefined, request);
    await expect(provider.generate('wind')).rejects.toThrow(
      'ElevenLabs sound effects request failed (HTTP 422): {"detail":"bad duration"}'
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects out-of-range options and empty prompts before any request', async () => {
    const { request, calls } = fakeFetch([() => new Response(mp3Bytes)]);
    const provider = new ElevenLabsSoundEffectsProvider('key', 0, undefined, request);
    await expect(provider.generate('x', { durationSeconds: 0.2 })).rejects.toThrow(
      'between 0.5 and 30 seconds'
    );
    await expect(provider.generate('x', { durationSeconds: 31 })).rejects.toThrow(
      'between 0.5 and 30 seconds'
    );
    await expect(provider.generate('x', { promptInfluence: 1.5 })).rejects.toThrow('between 0 and 1');
    await expect(provider.generate('  ')).rejects.toThrow('prompt is required');
    expect(calls).toHaveLength(0);
  });

  it('requires an API key', () => {
    expect(() => new ElevenLabsSoundEffectsProvider('')).toThrow('ELEVENLABS_API_KEY');
  });

  it('rejects an empty audio response', async () => {
    const { request } = fakeFetch([() => new Response(new Uint8Array(0))]);
    await expect(
      new ElevenLabsSoundEffectsProvider('key', 0, undefined, request).generate('wind')
    ).rejects.toThrow('no sound effect audio');
  });
});

describe('Sound effects registry and pipeline', () => {
  it('creates the ElevenLabs provider by name and rejects unknown names', () => {
    expect(sfxModule.createSoundEffectsProvider('ElevenLabs', { apiKey: 'key' })).toBeInstanceOf(
      ElevenLabsSoundEffectsProvider
    );
    expect(sfxModule.getSoundEffectsProvider('nonexistent')).toBeUndefined();
    expect(() => sfxModule.createSoundEffectsProvider('nonexistent')).toThrow(
      'Unknown sound effects provider "nonexistent"'
    );
  });

  it('emits start and complete events around generation', async () => {
    const bus = new UniversalEventBus();
    const events: string[] = [];
    bus.on('sfx:start', ({ prompt }) => events.push(`start:${prompt}`));
    bus.on('sfx:complete', ({ audioBytes }) => events.push(`complete:${audioBytes.byteLength}`));

    const { request } = fakeFetch([() => new Response(mp3Bytes)]);
    const pipeline = new SoundEffectsPipeline(
      new ElevenLabsSoundEffectsProvider('key', 0, undefined, request),
      bus
    );
    await pipeline.generate('glass breaking');
    expect(events).toEqual(['start:glass breaking', `complete:${mp3Bytes.byteLength}`]);
  });
});

describe('Sound effects configuration', () => {
  it('uses the ElevenLabs key, never the Gemini key, in sfx mode', () => {
    const resolved = resolveConfig(
      { mode: 'sfx' },
      { apiKey: 'gemini-file-key' },
      { GEMINI_API_KEY: 'gemini-env-key', ELEVENLABS_API_KEY: 'eleven-env-key' }
    );
    expect(resolved.apiKey).toBe('eleven-env-key');

    const noElevenKey = resolveConfig({ mode: 'sfx' }, { apiKey: 'gemini-file-key' }, {
      GEMINI_API_KEY: 'gemini-env-key',
    });
    expect(noElevenKey.apiKey).toBeUndefined();
  });

  it('prefers the sfx config key, then an ElevenLabs audio key, then the environment', () => {
    const env = { ELEVENLABS_API_KEY: 'env-key' };
    expect(resolveConfig({ mode: 'sfx' }, { sfx: { apiKey: 'sfx-key' } }, env).apiKey).toBe('sfx-key');
    expect(
      resolveConfig({ mode: 'sfx' }, { audio: { provider: 'elevenlabs', apiKey: 'audio-key' } }, env)
        .apiKey
    ).toBe('audio-key');
    expect(
      resolveConfig({ mode: 'sfx' }, { audio: { provider: 'gemini', apiKey: 'gemini-key' } }, env)
        .apiKey
    ).toBe('env-key');
    expect(resolveConfig({ mode: 'sfx', apiKey: 'flag-key' }, { sfx: { apiKey: 'sfx-key' } }, env).apiKey)
      .toBe('flag-key');
  });

  it('merges sfx options from flags over the config file', () => {
    const resolved = resolveConfig(
      { mode: 'sfx', durationSeconds: 4 },
      { sfx: { durationSeconds: 2, promptInfluence: 0.5, loop: true, outputFormat: 'wav' } },
      {}
    );
    expect(resolved.sfx).toEqual({
      provider: 'elevenlabs',
      model: 'eleven_text_to_sound_v2',
      outputFormat: 'wav',
      durationSeconds: 4,
      promptInfluence: 0.5,
      loop: true,
    });
  });

  it('infers output format from flag, then extension, then the configured default', () => {
    expect(inferSoundEffectOutputFormat('boom.mp3', 'wav')).toBe('wav');
    expect(inferSoundEffectOutputFormat('boom.WAV')).toBe('wav');
    expect(inferSoundEffectOutputFormat('boom.mp3', undefined, 'wav')).toBe('mp3');
    expect(inferSoundEffectOutputFormat('boom.audio', undefined, 'wav')).toBe('wav');
    expect(inferSoundEffectOutputFormat('boom')).toBe('mp3');
  });
});
