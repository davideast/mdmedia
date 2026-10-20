import { describe, expect, it } from 'bun:test';
import { GEMINI_LISTEN_MODEL, GeminiListener, listenPrompt, type GeminiContentClient } from './listen-gemini.js';
import { ListenerUnavailableError, type ListenRequest } from './listen.js';

const REQUEST: ListenRequest = {
  clip: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', seconds: 4 },
  facts: 'Speech in the clip:\n- 0.30–1.58 s, Hal: "comes with"',
  questions: [{ id: 'joke.shouted.payoff', ask: 'Is any word in "wheels!" (2.40–2.90 s) shouted?' }],
};

type Request = Parameters<GeminiContentClient['models']['generateContent']>[0];

function client(responses: Array<string | Error>): { client: GeminiContentClient; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    client: {
      models: {
        generateContent: async (request) => {
          requests.push(request);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return { text: next };
        },
      },
    },
  };
}

const ANSWER = JSON.stringify({ canHearAudio: true, answers: [{ id: 'joke.shouted.payoff', verdict: 'yes', confidence: 0.98, heard: 'WHEELS!', why: 'loud' }] });

describe('the Gemini listener', () => {
  it("sends the clip inline with judge.mjs's prompt to gemini-3.8-flash and reads its answers", async () => {
    const fake = client([ANSWER]);
    const listener = new GeminiListener(fake.client);
    expect(listener.name).toBe(`gemini:${GEMINI_LISTEN_MODEL}`);
    expect(GEMINI_LISTEN_MODEL).toBe('gemini-3.8-flash');
    const heard = await listener.listen(REQUEST);
    expect(heard).toEqual({ model: 'gemini-3.8-flash', canHearAudio: true, answers: [{ id: 'joke.shouted.payoff', verdict: 'yes', confidence: 0.98, heard: 'WHEELS!', why: 'loud' }] });
    const [request] = fake.requests;
    expect(request.model).toBe('gemini-3.8-flash');
    expect(request.contents[0].parts[0].inlineData).toEqual({ mimeType: 'video/mp4', data: 'AQID' });
    expect(request.contents[0].parts[1].text).toBe(listenPrompt(REQUEST));
    expect(request.config.responseMimeType).toBe('application/json');
    expect(listenPrompt(REQUEST)).toContain('Known facts (exact; trust these over your own estimates):\nSpeech in the clip:');
    expect(listenPrompt(REQUEST)).toContain('- [joke.shouted.payoff] Is any word in "wheels!" (2.40–2.90 s) shouted?');
  });

  it('retries an overloaded model with backoff, and gives up on anything else', async () => {
    const waits: number[] = [];
    const fake = client([new Error('503 UNAVAILABLE: high demand'), new Error('503 UNAVAILABLE'), ANSWER]);
    const listener = new GeminiListener(fake.client, { backoff: 10, sleep: async (ms) => void waits.push(ms) });
    expect((await listener.listen(REQUEST)).answers).toHaveLength(1);
    expect(waits).toEqual([10, 20]);

    const broken = new GeminiListener(client([new Error('400 bad request')]).client, { sleep: async () => undefined });
    await expect(broken.listen(REQUEST)).rejects.toThrow('400 bad request');
  });

  it('stops the run when the key is refused or missing', async () => {
    const refused = new GeminiListener(client([new Error('API key not valid. Please pass a valid API key.')]).client);
    await expect(refused.listen(REQUEST)).rejects.toBeInstanceOf(ListenerUnavailableError);
    expect(() => GeminiListener.fromEnv({})).toThrow('The listening check needs a Gemini API key. Set GEMINI_API_KEY.');
    expect(GeminiListener.fromEnv({ GEMINI_API_KEY: 'k', MDMEDIA_LISTEN_MODEL: 'gemini-9-ear' }).name).toBe('gemini:gemini-9-ear');
  });
});
