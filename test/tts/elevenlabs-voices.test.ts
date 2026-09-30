import { describe, expect, it } from 'bun:test';
import { ElevenLabsVoiceCatalog } from '../../src/tts/elevenlabs-voices.js';
import { ElevenLabsTTSProvider } from '../../src/tts/elevenlabs-tts-provider.js';
import { resolveConfig } from '../../src/config/config-resolver.js';

function voiceResponse(
  voices: Array<{ voice_id: string; name: string; preview_url?: string | null }>,
  nextPageToken: string | null = null
): Response {
  return Response.json({
    voices,
    has_more: nextPageToken !== null,
    next_page_token: nextPageToken,
  });
}

describe('ElevenLabs voice references', () => {
  it('accepts a voice name from ELEVENLABS_VOICE without replacing the ID setting', () => {
    const resolved = resolveConfig(
      { mode: 'audio' },
      {},
      {
        MDMEDIA_TTS_PROVIDER: 'elevenlabs',
        ELEVENLABS_VOICE: 'George',
        ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
      }
    );
    expect(resolved.audio.voice).toBe('George');
  });

  it('uses the short display name for synthesis and resolves it once per provider', async () => {
    let lookups = 0;
    const paths: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/voices') {
        lookups++;
        expect(url.searchParams.get('search')).toBe('george');
        return voiceResponse([{ voice_id: 'voice-123', name: 'George - Warm Storyteller' }]);
      }
      paths.push(url.pathname);
      return new Response(Uint8Array.of(0, 0));
    };
    const provider = new ElevenLabsTTSProvider('key', 0, undefined, request);

    for (const text of ['First chunk.', 'Second chunk.']) {
      for await (const _ of provider.streamAudio(text, 'george')) {
        // consume
      }
    }

    expect(lookups).toBe(1);
    expect(paths).toEqual([
      '/v1/text-to-speech/voice-123/stream',
      '/v1/text-to-speech/voice-123/stream',
    ]);
  });

  it('keeps a voice ID usable without voice-catalog permission', async () => {
    const paths: string[] = [];
    const request: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(Uint8Array.of(0, 0));
    };
    const provider = new ElevenLabsTTSProvider('key', 0, undefined, request);
    for await (const _ of provider.streamAudio('Hello.', 'JBFqnCBsd6RMkjVDRZzb')) {
      // consume
    }
    expect(paths).toEqual(['/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream']);
  });

  it('lists every voice page with names and IDs', async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      return url.searchParams.get('next_page_token') === 'page-2'
        ? voiceResponse([{ voice_id: 'id-adam', name: 'Adam' }])
        : voiceResponse([{ voice_id: 'id-rachel', name: 'Rachel' }], 'page-2');
    };
    const voices = await new ElevenLabsVoiceCatalog('key', request).list();
    expect(voices).toEqual([
      { id: 'id-adam', name: 'Adam' },
      { id: 'id-rachel', name: 'Rachel' },
    ]);
  });

  it('exposes hosted samples while keeping voices without samples usable', async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/voices') return voiceResponse([
        { voice_id: 'voice-with-sample', name: 'Sampled', preview_url: 'https://example.com/sample.mp3' },
        { voice_id: 'voice-no-sample', name: 'Silent', preview_url: null },
      ]);
      return Response.json({
        voice_id: 'voice-with-sample',
        name: 'Sampled',
        preview_url: 'https://example.com/sample.mp3',
      });
    };
    const catalog = new ElevenLabsVoiceCatalog('key', request);
    expect((await catalog.listPage()).voices).toEqual([
      { id: 'voice-with-sample', name: 'Sampled', previewUrl: 'https://example.com/sample.mp3' },
      { id: 'voice-no-sample', name: 'Silent', previewUrl: null },
    ]);
    expect(await catalog.get('voice-with-sample')).toEqual({
      id: 'voice-with-sample', name: 'Sampled', previewUrl: 'https://example.com/sample.mp3',
    });
  });

  it('asks for an ID when a name is ambiguous', async () => {
    const request: typeof fetch = async () =>
      voiceResponse([
        { voice_id: 'first-id', name: 'Narrator - Warm' },
        { voice_id: 'second-id', name: 'Narrator - Calm' },
      ]);
    await expect(new ElevenLabsVoiceCatalog('key', request).resolve('Narrator'))
      .rejects.toThrow('Multiple ElevenLabs voices match "Narrator"');
  });

  it('explains the voices_read permission when name lookup is unavailable', async () => {
    const request: typeof fetch = async () =>
      Response.json(
        { detail: { status: 'missing_permissions', message: 'Missing voices_read permission' } },
        { status: 401 }
      );
    await expect(new ElevenLabsVoiceCatalog('key', request).resolve('Rachel'))
      .rejects.toThrow('voices_read');
  });
});
