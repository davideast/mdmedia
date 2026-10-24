import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioApiError, StudioClient } from '../../src/remote/client.js';
import { runCommand } from 'citty';
import { imageBody, musicBody, readReference, runMediaCommand, sfxBody, videoBody } from '../../src/cli/studio-media-commands.js';
import { studioCommand } from '../../src/cli/studio-command.js';
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
  let refCount = 0;
  const origin = 'http://localhost:3000';
  const asset = { id: 'out1', mimeType: 'image/png', links: { content: `${origin}/api/v1/assets/out1/content`, thumbnail: '' } };
  const generation = { id: 'gen1', itemId: 'item1', type, status: 'ready', phase: 'ready', assets: [asset], error: null };
  const fetchStub = (async (url: URL, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: new Headers(init.headers), body: init.body });
    if (url.pathname === '/api/v1/assets') return Response.json({ id: `ref${++refCount}` }, { status: 201 });
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
    expect(() => imageBody('x', { resolution: '8K' })).toThrow('--resolution must be one of 1K, 2K, 4K');
    expect(() => imageBody('  ', {})).toThrow('The prompt is empty.');
    expect(() => imageBody('x'.repeat(32_001), {})).toThrow('the limit is 32,000');
    expect(() => imageBody('x', { instructions: 'y'.repeat(4001) })).toThrow('--instructions is limited to 4,000 characters.');
  });

  it('maps model, extended ratios, 0.5k resolution, grounding, thinking, video, refine, and from-generation', () => {
    expect(
      imageBody('Poster', {
        model: 'gemini-3.1-flash-image',
        aspect: '1:4',
        resolution: '0.5k',
        search: true,
        imageSearch: true,
        thinking: 'high',
        video: 'https://example.com/clip.mp4',
        refine: true,
        fromGeneration: 'gen1',
      }),
    ).toEqual({
      prompt: 'Poster',
      model: 'gemini-3.1-flash-image',
      output: { aspectRatio: '1:4', resolution: '0.5K' },
      searchGrounding: { web: true, imageSearch: true },
      thinkingLevel: 'high',
      videoUri: 'https://example.com/clip.mp4',
      action: 'refine',
      fromGenerationId: 'gen1',
    });
    expect(imageBody('Poster', { fromGeneration: 'gen1' })).toEqual({
      prompt: 'Poster',
      action: 'refine',
      fromGenerationId: 'gen1',
    });
    expect(imageBody('Poster', { refine: true })).toEqual({
      prompt: 'Poster',
      action: 'refine',
    });
    expect(imageBody('Poster', { search: true })).toEqual({
      prompt: 'Poster',
      searchGrounding: { web: true },
    });
    expect(imageBody('Poster', { imageSearch: true })).toEqual({
      prompt: 'Poster',
      searchGrounding: { imageSearch: true },
    });
  });

  it('rejects invalid model and per-model feature combinations', () => {
    expect(() => imageBody('x', { model: 'dall-e-3' })).toThrow('--model must be one of gemini-nano-banana-2.1');
    expect(() => imageBody('x', { model: 'gemini-3-pro-image', aspect: '1:4' })).toThrow('1:4');
    expect(() => imageBody('x', { model: 'gemini-nano-banana-2.1', resolution: '0.5k' })).toThrow('0.5K');
    expect(() => imageBody('x', { model: 'gemini-3.1-flash-lite-image', resolution: '2K' })).toThrow('1K');
    expect(() => imageBody('x', { model: 'gemini-3.1-flash-lite-image', search: true })).toThrow('gemini-3.1-flash-lite-image');
    expect(() => imageBody('x', { model: 'gemini-2.5-flash-image', search: true })).toThrow('gemini-2.5-flash-image');
    expect(() => imageBody('x', { model: 'gemini-3-pro-image', imageSearch: true })).toThrow('image-search');
    expect(() => imageBody('x', { model: 'gemini-3.1-flash-image', thinking: 'medium' })).toThrow('minimal, high');
    expect(() => imageBody('x', { model: 'gemini-3-pro-image', thinking: 'high' })).toThrow('gemini-3-pro-image');
    expect(() => imageBody('x', { video: 'http://example.com/clip.mp4' })).toThrow('https');
    expect(() => imageBody('x', { model: 'gemini-3-pro-image', video: 'https://example.com/clip.mp4' })).toThrow('gemini-3-pro-image');
  });
});

describe('studio video arguments', () => {
  it('sends only the prompt when nothing else is set', () => {
    expect(videoBody('A train', {})).toEqual({ prompt: 'A train' });
  });

  it('maps shape, resolution, duration, first frame, and adaptation', () => {
    expect(videoBody('A train', { aspect: '9:16', resolution: '4K', duration: '5', reference: 'ref.png', firstFrame: true, instructions: 'Slow' })).toEqual({
      prompt: 'A train',
      output: { aspectRatio: '9:16', resolution: '4k', durationSeconds: 5 },
      referenceRole: 'first_frame',
      adaptation: { enabled: true, instructions: 'Slow' },
    });
    expect(videoBody('x', { duration: '3' })).toEqual({ prompt: 'x', output: { durationSeconds: 3 } });
  });

  it('rejects bad values before any request is made', () => {
    expect(() => videoBody('x', { aspect: '1:1' })).toThrow('--aspect must be one of 16:9, 9:16 (got "1:1")');
    expect(() => videoBody('x', { resolution: '2K' })).toThrow('--resolution must be one of 360p, 720p, 1080p, 4k');
    expect(() => videoBody('x', { duration: '11' })).toThrow('--duration must be a whole number 3 to 10 (got "11")');
    expect(() => videoBody('x', { duration: '4.5' })).toThrow('--duration must be a whole number 3 to 10');
    expect(() => videoBody('x', { firstFrame: true })).toThrow('--first-frame needs --reference <image>.');
  });

  it('uploads a video-scoped reference and saves the assembled movie', async () => {
    const dir = tempDir();
    const reference = path.join(dir, 'start.webp');
    const output = path.join(dir, 'train.mp4');
    fs.writeFileSync(reference, new Uint8Array([1]));
    const { calls, client } = fakeStudio('video');
    await runMediaCommand(client, 'video', videoBody('A train', { reference, firstFrame: true }), { reference, output });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/assets?media=video', 'POST /api/v1/videos', 'GET /api/v1/videos/item1', 'GET /api/v1/assets/out1/content',
    ]);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ prompt: 'A train', referenceRole: 'first_frame', referenceAssetId: 'ref1' });
    expect(fs.existsSync(output)).toBe(true);
  });
});

describe('studio music arguments', () => {
  it('sends only the prompt when nothing else is set', () => {
    expect(musicBody('A waltz', {})).toEqual({ prompt: 'A waltz' });
  });

  it('maps clip mode, format, vocals, lyrics, and adaptation', () => {
    expect(musicBody('A waltz', { clip: true, format: 'WAV', vocals: 'vocals', adapt: true }, 'La la la')).toEqual({
      prompt: 'A waltz',
      output: { mode: 'clip', format: 'wav' },
      vocals: 'vocals',
      lyrics: 'La la la',
      adaptation: { enabled: true },
    });
    expect(musicBody('x', { clip: false })).toEqual({ prompt: 'x', output: { mode: 'song' } });
  });

  it('rejects bad values before any request is made', () => {
    expect(() => musicBody('x', { format: 'ogg' })).toThrow('--format must be one of mp3, wav (got "ogg")');
    expect(() => musicBody('x', { vocals: 'choir' })).toThrow('--vocals must be one of auto, vocals, instrumental');
    expect(() => musicBody('x', { vocals: 'instrumental' }, 'Words')).toThrow('--lyrics cannot be used with --vocals instrumental.');
    expect(() => musicBody('x', {}, 'y'.repeat(8001))).toThrow('--lyrics is limited to 8,000 characters.');
  });

  it('uploads a music-scoped reference', async () => {
    const reference = path.join(tempDir(), 'cover.png');
    fs.writeFileSync(reference, new Uint8Array([1]));
    const { calls, client } = fakeStudio('music');
    await runMediaCommand(client, 'music', musicBody('A waltz', {}), { reference });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/assets?media=music', 'POST /api/v1/music']);
    expect(logs).toEqual(['Music started: http://localhost:3000/music/item1']);
  });
});

describe('studio sfx arguments', () => {
  it('sends only the prompt when nothing else is set', () => {
    expect(sfxBody('A door creaks', {})).toEqual({ prompt: 'A door creaks' });
  });

  it('maps duration, influence, loop, and format', () => {
    expect(sfxBody('A door creaks', { duration: '2.5', influence: '0', loop: true, format: 'wav' })).toEqual({
      prompt: 'A door creaks',
      output: { format: 'wav', durationSeconds: 2.5, loop: true },
      promptInfluence: 0,
    });
    expect(sfxBody('x', { loop: false })).toEqual({ prompt: 'x', output: { loop: false } });
  });

  it('rejects bad values before any request is made', () => {
    expect(() => sfxBody('x', { duration: '0.4' })).toThrow('--duration must be a number 0.5 to 30 (got "0.4")');
    expect(() => sfxBody('x', { duration: '31' })).toThrow('--duration must be a number 0.5 to 30');
    expect(() => sfxBody('x', { influence: '1.5' })).toThrow('--influence must be a number 0 to 1 (got "1.5")');
    expect(() => sfxBody('x', { influence: '' })).toThrow('--influence must be a number 0 to 1');
    expect(() => sfxBody('x', { format: 'flac' })).toThrow('--format must be one of mp3, wav');
    expect(() => sfxBody('x'.repeat(4001), {})).toThrow('the limit is 4,000');
  });
});

describe('studio commands end to end', () => {
  const saved = { key: process.env.MDMEDIA_API_KEY, url: process.env.MDMEDIA_STUDIO_URL };
  let calls: Call[] = [];
  let fetchSpy: { mockRestore(): void } | null = null;
  beforeEach(() => {
    process.env.MDMEDIA_API_KEY = KEY;
    process.env.MDMEDIA_STUDIO_URL = 'http://localhost:3000';
    const studio = fakeStudio('sfx');
    calls = studio.calls;
    // The commands build their own client, which uses the global fetch.
    const stub = (studio.client as unknown as { fetchImpl: typeof fetch }).fetchImpl;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stub as typeof fetch);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    if (saved.key === undefined) delete process.env.MDMEDIA_API_KEY; else process.env.MDMEDIA_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.MDMEDIA_STUDIO_URL; else process.env.MDMEDIA_STUDIO_URL = saved.url;
  });

  it('studio sfx maps its flags to the request', async () => {
    await runCommand(studioCommand, { rawArgs: ['sfx', '-p', 'A door creaks', '-d', '2', '--influence', '0.6', '--loop', '-f', 'wav'] });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/sfx']);
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{10,128}$/);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: 'A door creaks', output: { format: 'wav', durationSeconds: 2, loop: true }, promptInfluence: 0.6 });
    expect(logs).toEqual(['Sound effect started: http://localhost:3000/sfx/item1']);
  });

  it('studio sfx reports a bad flag as one JSON error without calling the studio', async () => {
    await runCommand(studioCommand, { rawArgs: ['sfx', '-p', 'x', '--influence', '2', '--json'] });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(logs[0]!)).toEqual({ error: { code: 'error', message: '--influence must be a number 0 to 1 (got "2").' } });
    expect(process.exitCode).toBe(1);
  });

  it('studio status --type reads that medium', async () => {
    await runCommand(studioCommand, { rawArgs: ['status', 'item1', '--type', 'sfx'] });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/v1/sfx/item1']);
    expect(logs).toEqual(['A lighthouse: ready — http://localhost:3000/sfx/item1']);
  });

  it('studio status refuses an unknown --type', async () => {
    await runCommand(studioCommand, { rawArgs: ['status', 'item1', '--type', 'podcast', '--json'] });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(logs[0]!).error.message).toBe('--type must be one of narration, image, video, music, sfx (got "podcast").');
  });

  it('studio image maps model, search, thinking, video, item, and refine flags to the request', async () => {
    await runCommand(studioCommand, {
      rawArgs: [
        'image',
        '-p',
        'Poster',
        '--model',
        'gemini-3.1-flash-image',
        '--aspect',
        '1:4',
        '--resolution',
        '0.5k',
        '--search',
        '--image-search',
        '--thinking',
        'high',
        '--video',
        'https://example.com/clip.mp4',
        '--item',
        'item1',
        '--refine',
        '--from-generation',
        'gen0',
      ],
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/images/item1/generations']);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      prompt: 'Poster',
      model: 'gemini-3.1-flash-image',
      output: { aspectRatio: '1:4', resolution: '0.5K' },
      searchGrounding: { web: true, imageSearch: true },
      thinkingLevel: 'high',
      videoUri: 'https://example.com/clip.mp4',
      action: 'refine',
      fromGenerationId: 'gen0',
    });
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

  it('uploads multiple comma-separated --reference files for image and sends referenceAssetIds', async () => {
    const dir = tempDir();
    const ref1 = path.join(dir, 'ref1.png');
    const ref2 = path.join(dir, 'ref2.jpg');
    fs.writeFileSync(ref1, new Uint8Array([137, 80, 78, 71]));
    fs.writeFileSync(ref2, new Uint8Array([255, 216, 255]));
    const { calls, client } = fakeStudio('image');
    await runMediaCommand(client, 'image', { prompt: 'A lighthouse' }, { reference: `${ref1}, ${ref2}`, json: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/assets?media=image',
      'POST /api/v1/assets?media=image',
      'POST /api/v1/images',
    ]);
    expect(calls[0]!.headers.get('content-type')).toBe('image/png');
    expect(calls[1]!.headers.get('content-type')).toBe('image/jpeg');
    expect(JSON.parse(String(calls[2]!.body))).toEqual({
      prompt: 'A lighthouse',
      referenceAssetId: 'ref1',
      referenceAssetIds: ['ref1', 'ref2'],
    });
  });

  it('reads all comma-separated --reference files before uploading any and enforces max 14 references', async () => {
    const dir = tempDir();
    const valid = path.join(dir, 'ref1.png');
    const invalid = path.join(dir, 'bad.gif');
    fs.writeFileSync(valid, new Uint8Array([1]));
    fs.writeFileSync(invalid, new Uint8Array([1]));
    const { calls, client } = fakeStudio('image');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { reference: `${valid}, ${invalid}` })).rejects.toThrow('--reference must be');
    expect(calls).toHaveLength(0);

    const tooMany = Array.from({ length: 15 }, () => valid).join(',');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { reference: tooMany })).rejects.toThrow('14');
    expect(calls).toHaveLength(0);
  });

  it('with --item, creates a new generation on the existing image item', async () => {
    const { calls, client } = fakeStudio('image');
    await runMediaCommand(client, 'image', imageBody('Warmer sky', { refine: true }), { item: 'item1', json: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/images/item1/generations']);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: 'Warmer sky', action: 'refine' });
  });

  it('rejects --refine when neither --item nor --from-generation is provided', async () => {
    const { calls, client } = fakeStudio('image');
    await expect(runMediaCommand(client, 'image', imageBody('Warmer sky', { refine: true }), {})).rejects.toThrow('--refine requires --item');
    expect(calls).toHaveLength(0);
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

  it('rejects an --output that cannot be written before creating anything', async () => {
    const dir = tempDir();
    const { calls, client } = fakeStudio('image');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { output: path.join(dir, 'missing', 'out.png') })).rejects.toThrow('does not exist or cannot be written');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { output: dir })).rejects.toThrow('is a folder');
    expect(calls).toHaveLength(0);
  });

  it('leaves no file behind when the download fails', async () => {
    const output = path.join(tempDir(), 'out.png');
    const { client } = fakeStudio('image');
    spyOn(client, 'downloadAsset').mockResolvedValue({ body: new ReadableStream({ pull(controller) { controller.error(new Error('connection reset')); } }), mimeType: 'image/png' });
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { output })).rejects.toThrow('connection reset');
    expect(fs.readdirSync(path.dirname(output))).toEqual([]);
  });

  it('rejects a bad --timeout before creating anything', async () => {
    const { calls, client } = fakeStudio('image');
    await expect(runMediaCommand(client, 'image', { prompt: 'x' }, { wait: true, timeout: 'soon' })).rejects.toThrow('--timeout must be a number at least 1');
    expect(calls).toHaveLength(0);
  });
});

describe('studio media failures after creation', () => {
  /** A studio that creates the item, then answers every read with `failure`. */
  const failingStudio = (failure: Response) => new StudioClient('http://localhost:3000', KEY, (async (_url: URL, init: RequestInit) => init.method === 'POST'
    ? Response.json({ id: 'item1', type: 'image', generation: {}, links: { self: '', web: 'http://localhost:3000/image/item1', generations: '' }, replayed: false }, { status: 202 })
    : failure.clone()) as unknown as typeof fetch);

  it('name the created item in JSON, so a retry checks on it instead of paying again', async () => {
    const client = failingStudio(Response.json({ error: { code: 'not_found', message: 'That image is not available to you.' } }, { status: 404 }));
    await guarded(true, () => runMediaCommand(client, 'image', { prompt: 'A lighthouse' }, { wait: true, json: true }));
    const printed = JSON.parse(logs[0]!);
    expect(printed).toMatchObject({ id: 'item1', type: 'image', links: { web: 'http://localhost:3000/image/item1' }, error: { code: 'not_found' } });
    expect(printed.error.message).toContain('mdmedia studio status item1 --type image');
    expect(process.exitCode).toBe(1);
  });

  it('leave failures before creation unchanged', async () => {
    await guarded(true, () => runMediaCommand(failingStudio(new Response(null)), 'image', { prompt: 'x' }, { wait: true, timeout: 'soon' }));
    expect(JSON.parse(logs[0]!)).toEqual({ error: { code: 'error', message: '--timeout must be a number at least 1 (got "soon").' } });
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
