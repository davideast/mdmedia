import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioApiError, StudioClient } from '../../src/remote/client.js';
import { imageBody, readReference, runMediaCommand } from '../../src/cli/studio-media-commands.js';
import { guarded } from '../../src/cli/studio-support.js';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-studio-media-'));
  dirs.push(dir);
  return dir;
};

let logs: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  logs = [];
  spies = [
    spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); }),
    spyOn(console, 'error').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

type Call = { method: string; path: string; headers: Headers; body: RequestInit['body'] };

/** A studio that accepts anything and answers each GET of an item as `ready`, with one asset. */
function fakeStudio(type: string) {
  const calls: Call[] = [];
  const origin = 'http://localhost:3000';
  const asset = { id: 'out1', mimeType: 'image/png', links: { content: `${origin}/api/v1/assets/out1/content`, thumbnail: '' } };
  const generation = { id: 'gen1', itemId: 'item1', type, status: 'ready', phase: 'ready', assets: [asset], error: null };
  const fetchStub = (async (url: URL, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: new Headers(init.headers), body: init.body });
    if (url.pathname === '/api/v1/assets') return Response.json({ id: 'ref1' }, { status: 201 });
    if (url.pathname.endsWith('/content')) return new Response(new Uint8Array([7, 8, 9]), { headers: { 'Content-Type': 'image/png' } });
    const links = { self: `${origin}${url.pathname}`, web: `${origin}/${type}/item1`, generations: '' };
    if (init.method === 'POST') return Response.json({ id: 'item1', type, generation: { ...generation, status: 'queued', assets: [] }, links, replayed: false }, { status: 202 });
    return Response.json({ id: 'item1', type, title: 'A lighthouse', status: 'ready', latestGeneration: generation, result: generation, links });
  }) as unknown as typeof fetch;
  return { calls, client: new StudioClient(origin, KEY, fetchStub) };
}

describe('studio image arguments', () => {
  it('sends only the prompt when nothing else is set, so studio defaults apply', () => {
    expect(imageBody('A lighthouse', {})).toEqual({ prompt: 'A lighthouse' });
  });

  it('maps shape, resolution, and adaptation', () => {
    expect(imageBody('A lighthouse', { aspect: '4:5', resolution: '2k', adapt: true, instructions: 'Watercolor' })).toEqual({
      prompt: 'A lighthouse',
      output: { aspectRatio: '4:5', resolution: '2K' },
      adaptation: { enabled: true, instructions: 'Watercolor' },
    });
    expect(imageBody('x', { resolution: '4K' })).toEqual({ prompt: 'x', output: { resolution: '4K' } });
  });

  it('turns adaptation on for --instructions alone, and off for --no-adapt', () => {
    expect(imageBody('x', { instructions: 'Moody' }).adaptation).toEqual({ enabled: true, instructions: 'Moody' });
    expect(imageBody('x', { adapt: false }).adaptation).toEqual({ enabled: false });
  });

  it('rejects bad values before any request is made', () => {
    expect(() => imageBody('x', { aspect: '7:3' })).toThrow('--aspect must be one of 1:1, 2:3');
    expect(() => imageBody('x', { resolution: '8K' })).toThrow('--resolution must be one of 1K, 2K, 4K (got "8K")');
    expect(() => imageBody('  ', {})).toThrow('The prompt is empty.');
    expect(() => imageBody('x'.repeat(32_001), {})).toThrow('the limit is 32,000');
    expect(() => imageBody('x', { instructions: 'y'.repeat(4001) })).toThrow('--instructions is limited to 4,000 characters.');
  });
});

describe('studio media references', () => {
  it('accepts PNG, JPEG, and WebP files and rejects others', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'ref.JPG'), new Uint8Array([1, 2]));
    expect((await readReference(path.join(dir, 'ref.JPG'))).mimeType).toBe('image/jpeg');
    await expect(readReference(path.join(dir, 'ref.gif'))).rejects.toThrow('--reference must be a .png, .jpg, .jpeg, or .webp image.');
  });
});

describe('studio media flow', () => {
  it('without --wait, creates the item and prints its link', async () => {
    const { calls, client } = fakeStudio('image');
    await runMediaCommand(client, 'image', { prompt: 'A lighthouse' }, {});
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/images']);
    expect(logs).toEqual(['Image started: http://localhost:3000/image/item1']);
  });

  it('uploads --reference first and sends its asset id', async () => {
    const dir = tempDir();
    const reference = path.join(dir, 'ref.png');
    fs.writeFileSync(reference, new Uint8Array([137, 80, 78, 71]));
    const { calls, client } = fakeStudio('image');
    await runMediaCommand(client, 'image', { prompt: 'A lighthouse' }, { reference, json: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/assets?media=image', 'POST /api/v1/images']);
    expect(calls[0]!.headers.get('content-type')).toBe('image/png');
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ prompt: 'A lighthouse', referenceAssetId: 'ref1' });
    expect(JSON.parse(logs[0]!).id).toBe('item1');
  });

  it('with --output, waits, downloads the result, and saves it', async () => {
    const output = path.join(tempDir(), 'out.png');
    const { calls, client } = fakeStudio('image');
    await runMediaCommand(client, 'image', { prompt: 'A lighthouse' }, { output, json: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/images', 'GET /api/v1/images/item1', 'GET /api/v1/assets/out1/content']);
    expect([...fs.readFileSync(output)]).toEqual([7, 8, 9]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ id: 'item1', status: 'ready', savedTo: output });
    expect(process.exitCode).toBe(0);
  });

  it('rejects a bad --timeout before creating anything', async () => {
    const { calls, client } = fakeStudio('image');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { wait: true, timeout: 'soon' })).rejects.toThrow('--timeout must be a number at least 1');
    expect(calls).toHaveLength(0);
  });
});

describe('studio errors', () => {
  it('tell the user to log in again when the key lacks a scope', async () => {
    await guarded(true, async () => { throw new StudioApiError(403, 'insufficient_scope', 'This API key cannot images create.'); });
    expect(JSON.parse(logs[0]!)).toEqual({ error: {
      code: 'insufficient_scope',
      message: 'This API key cannot images create. Run `mdmedia studio login` again to approve this access.',
    } });
    expect(process.exitCode).toBe(1);
  });
});
