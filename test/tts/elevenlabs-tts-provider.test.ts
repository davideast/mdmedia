import { describe, expect, it } from 'bun:test';
import { createTTSProvider } from '../../src/tts/provider-registry.js';
import { ElevenLabsTTSProvider } from '../../src/tts/elevenlabs-tts-provider.js';
import { resolveConfig } from '../../src/config/config-resolver.js';

describe('ElevenLabs narration', () => {
  it('uses ElevenLabs credentials, voice and model for a mixed-case selection', async () => {
    const resolved = resolveConfig(
      { mode: 'audio', audioProvider: 'ElevenLabs' },
      { apiKey: 'gemini-file-key', audio: { voice: 'Puck', model: 'gemini-file-model' } },
      { ELEVENLABS_API_KEY: 'eleven-key', ELEVENLABS_VOICE_ID: 'eleven-voice' }
    );
    let requestOptions: RequestInit | undefined;
    const provider = createTTSProvider({
      provider: resolved.audio.provider,
      apiKey: resolved.apiKey,
      model: resolved.audio.model,
      voice: resolved.audio.voice,
      request: async (_input, options) => {
        requestOptions = options;
        return new Response(Uint8Array.of(0, 0));
      },
    });
    for await (const _ of provider.streamAudio('Hello.', resolved.audio.voice)) {
      // consume
    }

    expect(resolved.audio.provider).toBe('elevenlabs');
    expect(resolved.audio.voice).toBe('eleven-voice');
    expect(resolved.apiKey).toBe('eleven-key');
    expect(JSON.parse(String(requestOptions?.body)).model_id).toBe('eleven_multilingual_v2');
  });

  it('rejects unusable voice and style at provider creation', () => {
    expect(() => createTTSProvider({ provider: 'elevenlabs', apiKey: 'key', voice: '' }))
      .toThrow('An ElevenLabs voice ID is required.');
    expect(() => createTTSProvider({ provider: 'elevenlabs', apiKey: 'key', voice: 'id', style: 'gentle' }))
      .toThrow('Free-form --style delivery notes are not supported by ElevenLabs TTS.');
  });

  it('selects ElevenLabs and streams compatible PCM bytes', async () => {
    const pcm = Uint8Array.of(0, 0, 16, 0);
    let requestUrl = '';
    let requestOptions: RequestInit | undefined;
    const request: typeof fetch = async (input, options) => {
      requestUrl = String(input);
      requestOptions = options;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(pcm.subarray(0, 2));
            controller.enqueue(pcm.subarray(2));
            controller.close();
          },
        })
      );
    };

    const provider = createTTSProvider({
      provider: 'elevenlabs',
      apiKey: 'test-key',
      model: 'eleven_multilingual_v2',
      request,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.streamAudio('Read this paragraph.', 'voice-id')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([Uint8Array.of(0, 0), Uint8Array.of(16, 0)]);
    expect(requestUrl).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-id/stream?output_format=pcm_24000'
    );
    expect(requestOptions?.method).toBe('POST');
    expect(requestOptions?.headers).toEqual({
      'xi-api-key': 'test-key',
      'Content-Type': 'application/json',
      Accept: 'audio/pcm',
    });
    expect(JSON.parse(String(requestOptions?.body))).toEqual({
      text: 'Read this paragraph.',
      model_id: 'eleven_multilingual_v2',
    });
  });

  it('cancels upstream audio when narration stops early', async () => {
    let cancelled = false;
    const request: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(0, 0));
          },
          cancel() {
            cancelled = true;
          },
        })
      );
    const provider = new ElevenLabsTTSProvider('test-key', 0, undefined, request);
    const stream = provider.streamAudio('Hello.', 'voice-id')[Symbol.asyncIterator]();

    expect((await stream.next()).value).toEqual(Uint8Array.of(0, 0));
    await stream.return?.();
    expect(cancelled).toBe(true);
  });

  it('fails when a successful response contains no audio', async () => {
    const request: typeof fetch = async () => new Response(new Uint8Array());
    const provider = new ElevenLabsTTSProvider('test-key', 0, undefined, request);

    const consume = async () => {
      for await (const _ of provider.streamAudio('Hello.', 'voice-id')) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow('ElevenLabs returned no audio.');
  });
});
