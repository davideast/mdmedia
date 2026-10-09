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
