import { describe, expect, it } from 'bun:test';
import { AlignerUnavailableError } from '../../src/cut/words.js';
import {
  ElevenLabsAligner,
  ElevenLabsMissingPermissionError,
  MISSING_KEY_MESSAGE,
  forcedAlignment,
} from '../../src/elevenlabs/forced-alignment.js';
import { ElevenLabsRequestError } from '../../src/elevenlabs/request-error.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  form: FormData;
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: CapturedRequest[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, form: init?.body as FormData });
    return responses[Math.min(calls.length - 1, responses.length - 1)]();
  }) as typeof fetch;
  return { request, calls };
}

const wav = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4);

const aligned = () =>
  Response.json({
    characters: [{ text: 'H', start: 0.1, end: 0.12 }],
    words: [
      { text: "They're", start: 0.18, end: 0.3, loss: 0.7 },
      { text: ' ', start: 0.3, end: 0.34, loss: 0 },
      { text: 'getting', start: 0.34, end: 0.52, loss: 0.56 },
      { text: '', start: 0.52, end: 0.52, loss: 0 },
    ],
    loss: 0.716,
  });

describe('ElevenLabs forced alignment', () => {
  it('posts the audio and the known text as multipart form data with the key', async () => {
    const { request, calls } = fakeFetch([aligned]);
    await forcedAlignment(wav, "They're getting away, Buddy.", { apiKey: 'eleven-key', request });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.elevenlabs.io/v1/forced-alignment');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['xi-api-key']).toBe('eleven-key');
    expect(call.form.get('text')).toBe("They're getting away, Buddy.");
    const file = call.form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav);
  });

  it('returns the spoken words with their loss, dropping the whitespace entries', async () => {
    const { request } = fakeFetch([aligned]);
    const result = await forcedAlignment(wav, "They're getting", { apiKey: 'k', request });
    expect(result).toEqual({
      words: [
        { text: "They're", start: 0.18, end: 0.3, loss: 0.7 },
        { text: 'getting', start: 0.34, end: 0.52, loss: 0.56 },
      ],
      loss: 0.716,
    });
  });

  it('says plainly when the key lacks the forced_alignment permission', async () => {
    const body = { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission forced_alignment to execute this operation.' } };
    const { request, calls } = fakeFetch([() => Response.json(body, { status: 401 })]);
    const error = await forcedAlignment(wav, 'Hi.', { apiKey: 'k', request }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsMissingPermissionError);
    expect((error as Error).message).toStartWith("This ElevenLabs API key doesn't have the forced_alignment permission.");
    expect(calls).toHaveLength(1);
  });

  it('turns a missing permission into AlignerUnavailableError, so a run stops instead of failing every line', async () => {
    const body = { detail: { status: 'missing_permissions', message: 'missing forced_alignment' } };
    const { request } = fakeFetch([() => Response.json(body, { status: 401 })]);
    const aligner = new ElevenLabsAligner('k', { request });
    const error = await aligner.align({ bytes: wav, sampleRate: 16000 }, 'Hi.').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlignerUnavailableError);
    expect((error as Error).message).toContain('forced_alignment permission');
  });

  it('needs a key, from ELEVENLABS_API_KEY or ELEVEN_LABS_KEY', async () => {
    await expect(forcedAlignment(wav, 'Hi.', { apiKey: ' ' })).rejects.toThrow(MISSING_KEY_MESSAGE);
    expect(() => ElevenLabsAligner.fromEnv({})).toThrow(AlignerUnavailableError);
    expect(ElevenLabsAligner.fromEnv({ ELEVEN_LABS_KEY: 'k' }).name).toBe('elevenlabs');
  });

  it('reports other HTTP failures with their status, retrying only server errors', async () => {
    const bad = fakeFetch([() => new Response('{"detail":"bad audio"}', { status: 400 })]);
    const error = await forcedAlignment(wav, 'Hi.', { apiKey: 'k', request: bad.request }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsRequestError);
    expect((error as ElevenLabsRequestError).status).toBe(400);
    expect((error as Error).message).toBe('ElevenLabs forced alignment request failed (HTTP 400): {"detail":"bad audio"}');
    expect(bad.calls).toHaveLength(1);

    const flaky = fakeFetch([() => new Response('busy', { status: 503 }), aligned]);
    const result = await forcedAlignment(wav, 'Hi.', { apiKey: 'k', request: flaky.request, maxRetries: 1 });
    expect(flaky.calls).toHaveLength(2);
    expect(result.words).toHaveLength(2);
  });

  it('rejects a response without words', async () => {
    const { request } = fakeFetch([() => Response.json({ loss: 1 })]);
    await expect(forcedAlignment(wav, 'Hi.', { apiKey: 'k', request })).rejects.toThrow('unexpected response: no words');
  });
});
