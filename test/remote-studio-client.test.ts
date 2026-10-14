import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioApiError, StudioClient, assertSafeStudioUrl } from '../src/remote/client';
import { InsecureCredentialsError, readCredentials, writeCredentials } from '../src/remote/credentials';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const dirs: string[] = [];
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-creds-'));
  dirs.push(dir);
  return path.join(dir, 'mdmedia', 'credentials.json');
};
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('stored credentials', () => {
  it('are written readable only by the owner and read back', () => {
    const file = tempFile();
    writeCredentials({ url: 'http://localhost:3000', apiKey: KEY }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readCredentials({}, file)?.apiKey).toBe(KEY);
  });

  it('are refused when other users can read them', () => {
    const file = tempFile();
    writeCredentials({ url: 'http://localhost:3000', apiKey: KEY }, file);
    fs.chmodSync(file, 0o644);
    expect(() => readCredentials({}, file)).toThrow(InsecureCredentialsError);
  });

  it('come from the environment first, for CI', () => {
    expect(readCredentials({ MDMEDIA_API_KEY: KEY, MDMEDIA_STUDIO_URL: 'https://studio.example' }, tempFile()))
      .toEqual({ url: 'https://studio.example', apiKey: KEY });
  });
});

describe('studio client', () => {
  it('only sends a key over https, to this machine, or to a Tailscale host', () => {
    expect(assertSafeStudioUrl('http://localhost:3000').origin).toBe('http://localhost:3000');
    expect(assertSafeStudioUrl('http://box.tail1234.ts.net').hostname).toBe('box.tail1234.ts.net');
    expect(assertSafeStudioUrl('https://studio.example').protocol).toBe('https:');
    expect(() => assertSafeStudioUrl('http://192.168.1.20:3000')).toThrow(/Refusing/);
  });

  it('sends the key as a bearer token and keeps it out of errors', async () => {
    let authorization: string | null = null;
    const fetchStub = (async (_url: URL, init: RequestInit) => {
      authorization = new Headers(init.headers).get('authorization');
      return Response.json({ error: { code: 'visibility_not_allowed', message: 'API keys create private narrations.' } }, { status: 403 });
    }) as unknown as typeof fetch;
    const client = new StudioClient('http://localhost:3000', KEY, fetchStub);
    const error = await client.createNarration({ markdown: 'Hi', visibility: 'public' }).catch((caught) => caught);
    expect(authorization).toBe(`Bearer ${KEY}`);
    expect(error).toBeInstanceOf(StudioApiError);
    expect(error.code).toBe('visibility_not_allowed');
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(KEY.slice(4));
  });

  it('asks the user to log in instead of calling without a key', async () => {
    const client = new StudioClient('http://localhost:3000', null, (() => { throw new Error('no call expected'); }) as unknown as typeof fetch);
    await expect(client.narration('abcdefghij')).rejects.toMatchObject({ code: 'not_logged_in' });
  });
});

describe('playlist lookup', () => {
  const listing = { playlists: [
    { id: 'p1', title: 'Commute' }, { id: 'p2', title: 'Deep dives' }, { id: 'p3', title: 'deep dives' },
  ] };
  const client = new StudioClient('http://localhost:3000', KEY, (async () => Response.json(listing)) as unknown as typeof fetch);

  it('finds a playlist by id or by title, ignoring case', async () => {
    expect((await client.resolvePlaylist('p1')).id).toBe('p1');
    expect((await client.resolvePlaylist('commute')).id).toBe('p1');
  });

  it('refuses a title two playlists share, and names their ids', async () => {
    await expect(client.resolvePlaylist('Deep Dives')).rejects.toMatchObject({ code: 'playlist_ambiguous' });
    await expect(client.resolvePlaylist('Nope')).rejects.toMatchObject({ code: 'playlist_not_found' });
  });
});

describe('studio media', () => {
  type Call = { url: string; method: string; headers: Headers; body: RequestInit['body'] };
  const recording = (respond: (call: Call) => Response) => {
    const calls: Call[] = [];
    const fetchStub = (async (url: URL, init: RequestInit) => {
      const call = { url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch;
    return { calls, client: new StudioClient('http://localhost:3000', KEY, fetchStub) };
  };
  const generation = (status: string) => ({ id: 'gen1', itemId: 'item1', type: 'image', status, phase: status, assets: [], error: null });
  const item = (status: string) => ({ id: 'item1', type: 'image', status, latestGeneration: generation(status), result: null, links: { web: 'http://localhost:3000/image/item1' } });

  it('creates each medium at its route with a fresh Idempotency-Key', async () => {
    const { calls, client } = recording(() => Response.json({ id: 'item1', generation: generation('queued'), links: {}, replayed: false }, { status: 202 }));
    await client.createImage({ prompt: 'A lighthouse', output: { aspectRatio: '1:1' } });
    await client.createVideo({ prompt: 'A train' });
    await client.createMusic({ prompt: 'A waltz' });
    await client.createSfx({ prompt: 'A door creaks', promptInfluence: 0.5 });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/v1/images', 'POST /api/v1/videos', 'POST /api/v1/music', 'POST /api/v1/sfx',
    ]);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: 'A lighthouse', output: { aspectRatio: '1:1' } });
    const keys = calls.map((call) => call.headers.get('idempotency-key'));
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{10,128}$/);
    expect(new Set(keys).size).toBe(4);
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('reuses an Idempotency-Key the caller passes, so a retry cannot start a second attempt', async () => {
    const { calls, client } = recording(() => Response.json({ id: 'item1', replayed: true }, { status: 202 }));
    await client.createMusic({ prompt: 'A waltz' }, 'retry-key-123');
    await client.createMusic({ prompt: 'A waltz' }, 'retry-key-123');
    expect(calls.map((call) => call.headers.get('idempotency-key'))).toEqual(['retry-key-123', 'retry-key-123']);
  });

  it('reads an item by type and id', async () => {
    const { calls, client } = recording(() => Response.json(item('ready')));
    expect((await client.media('video', 'a/b')).id).toBe('item1');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/videos/a%2Fb');
  });

  it('uploads a reference as raw bytes for the medium that uses it', async () => {
    const { calls, client } = recording(() => Response.json({ id: 'ref1', mimeType: 'image/png' }, { status: 201 }));
    const asset = await client.uploadReference('music', new Uint8Array([137, 80, 78, 71]), 'image/png');
    expect(asset.id).toBe('ref1');
    expect(calls[0]!.url).toBe('http://localhost:3000/api/v1/assets?media=music');
    expect(calls[0]!.headers.get('content-type')).toBe('image/png');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect([...(calls[0]!.body as Uint8Array)]).toEqual([137, 80, 78, 71]);
  });

  it('downloads an asset from this studio only, whatever origin the link names', async () => {
    const { calls, client } = recording(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    const download = await client.downloadAsset('https://studio.tail1234.ts.net/api/v1/assets/a1/content?download=1');
    expect([...download.bytes]).toEqual([1, 2, 3]);
    expect(download.mimeType).toBe('audio/mpeg');
    expect(calls[0]!.url).toBe('http://localhost:3000/api/v1/assets/a1/content?download=1');
    await expect(client.downloadAsset('https://elsewhere.example/steal')).rejects.toMatchObject({ code: 'invalid_asset_link' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the key out of download errors', async () => {
    const { client } = recording(() => Response.json({ error: { code: 'insufficient_scope', message: 'This API key cannot music read.' } }, { status: 403 }));
    const error = await client.downloadAsset('/api/v1/assets/a1/content').catch((caught) => caught);
    expect(error).toMatchObject({ code: 'insufficient_scope', status: 403 });
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(KEY.slice(4));
  });

  it('waits until the latest attempt finishes, reporting each poll', async () => {
    const states = ['queued', 'generating', 'ready'];
    const { calls, client } = recording(() => Response.json(item(states.shift() ?? 'ready')));
    const seen: string[] = [];
    const finished = await client.waitForMedia('image', 'item1', { intervalMs: 1, onProgress: (resource) => seen.push(resource.latestGeneration!.status) });
    expect(finished.latestGeneration?.status).toBe('ready');
    expect(seen).toEqual(['queued', 'generating', 'ready']);
    expect(calls).toHaveLength(3);
  });

  it('keeps waiting through reads that fail transiently', async () => {
    const answers = [
      () => Response.json(item('generating')),
      () => { throw new TypeError('fetch failed'); },
      () => Response.json({ error: { code: 'http_502', message: 'Bad gateway' } }, { status: 502 }),
      () => Response.json(item('ready')),
    ];
    const { calls, client } = recording(() => answers.shift()!());
    const finished = await client.waitForMedia('video', 'item1', { intervalMs: 1 });
    expect(finished.latestGeneration?.status).toBe('ready');
    expect(calls).toHaveLength(4);
  });

  it('stops at once on a failure that will not pass', async () => {
    const { calls, client } = recording(() => Response.json({ error: { code: 'not_found', message: 'Gone.' } }, { status: 404 }));
    await expect(client.waitForMedia('music', 'item1', { intervalMs: 1 })).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toHaveLength(1);
  });

  it('throws the last failure when the deadline passes with nothing read', async () => {
    const { client } = recording(() => { throw new TypeError('fetch failed'); });
    await expect(client.waitForNarration('n1', { intervalMs: 5, timeoutMs: 20 })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('stops waiting at the timeout and returns the unfinished item', async () => {
    const { client } = recording(() => Response.json(item('generating')));
    const unfinished = await client.waitForMedia('sfx', 'item1', { intervalMs: 5, timeoutMs: 1 });
    expect(unfinished.status).toBe('generating');
  });
});
