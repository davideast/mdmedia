import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from 'citty';
import { StudioClient } from '../../src/remote/client.js';
import { studioAnalysisBody } from '../../src/cli/studio-analyze-command.js';
import { studioCommand } from '../../src/cli/studio-command.js';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ORIGIN = 'http://localhost:3000';
const ANSWER = '# Shot list\n\n- 00:01 A train arrives.';
const dirs: string[] = [];
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-studio-analyze-')); dirs.push(dir); return dir; };
const video = (bytes = 16, name = 'clip.mp4') => { const file = path.join(tempDir(), name); fs.writeFileSync(file, new Uint8Array(bytes)); return file; };

let out: string[] = [];
let err: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
type Call = { method: string; path: string; headers: Headers; body: RequestInit['body'] };
let calls: Call[] = [];
/** Steps to report, one per GET, while the analysis is still running. */
let running: string[] = [];
let narration: { narrationId: string | null; narrationError: { code: string; message: string } | null } = { narrationId: null, narrationError: null };

/** A studio that accepts anything and answers each GET of an analysis as ready, with a Markdown answer. */
const fetchStub = (async (url: URL, init: RequestInit) => {
  calls.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: new Headers(init.headers), body: init.body });
  if (url.pathname === '/api/v1/assets') return Response.json({ id: 'upload1', mimeType: 'video/mp4' }, { status: 201 });
  if (url.pathname.endsWith('/content')) return new Response(ANSWER, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
  const asset = { id: 'analysis_gen1', mimeType: 'text/markdown', links: { content: `${ORIGIN}/api/v1/assets/analysis_gen1/content`, thumbnail: '' } };
  const generation = { id: 'gen1', itemId: 'item1', type: 'analysis', status: 'ready', phase: 'ready', assets: [asset], error: null, interactionId: 'v1_abc', ...narration };
  const links = { self: `${ORIGIN}/api/v1/analyses/item1`, web: `${ORIGIN}/library`, generations: `${ORIGIN}/api/v1/analyses/item1/generations` };
  if (init.method === 'POST') return Response.json({ id: 'item1', type: 'analysis', generation: { ...generation, status: 'queued', assets: [] }, links, replayed: false }, { status: 202 });
  if (running.length) {
    const latest = { ...generation, status: 'generating', phase: 'analyzing', assets: [], progress: running.shift() };
    return Response.json({ id: 'item1', type: 'analysis', title: 'Shot list', status: 'generating', latestGeneration: latest, result: null, links });
  }
  return Response.json({ id: 'item1', type: 'analysis', title: 'Shot list', status: 'ready', latestGeneration: generation, result: generation, links });
}) as unknown as typeof fetch;

const saved = { key: process.env.MDMEDIA_API_KEY, url: process.env.MDMEDIA_STUDIO_URL };
beforeEach(() => {
  out = []; err = []; calls = []; running = []; narration = { narrationId: null, narrationError: null };
  process.env.MDMEDIA_API_KEY = KEY; process.env.MDMEDIA_STUDIO_URL = ORIGIN;
  spies = [
    spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); }),
    spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); }),
    spyOn(globalThis, 'fetch').mockImplementation(fetchStub),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (saved.key === undefined) delete process.env.MDMEDIA_API_KEY; else process.env.MDMEDIA_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.MDMEDIA_STUDIO_URL; else process.env.MDMEDIA_STUDIO_URL = saved.url;
  process.exitCode = 0;
});
const run = (...rawArgs: string[]) => runCommand(studioCommand, { rawArgs: ['analyze', ...rawArgs] });
const sent = (index = 0) => JSON.parse(String(calls[index]!.body));

describe('studio analyze arguments', () => {
  it('maps a YouTube link, an existing video, and engine settings; omitted settings stay for the studio', async () => {
    expect(await studioAnalysisBody('Shot list', { video: 'https://youtu.be/9hE5-98ZeCg' })).toEqual({ body: { prompt: 'Shot list', source: { kind: 'youtube', url: 'https://youtu.be/9hE5-98ZeCg' } } });
    expect((await studioAnalysisBody('x', { fromVideo: 'v1', generation: 'g1', clip: '2' })).body.source).toEqual({ kind: 'video', videoItemId: 'v1', generationId: 'g1', clip: 2 });
    expect((await studioAnalysisBody('x', { fromVideo: 'v1', model: 'gemini-3.6-flash', start: '1:30', end: '2m', fps: '0.5', mediaResolution: 'LOW', system: 'Cite MM:SS.' })).body).toEqual({
      prompt: 'x', source: { kind: 'video', videoItemId: 'v1' }, model: 'gemini-3.6-flash', processing: { mode: 'static', startSeconds: 90, endSeconds: 120, fps: 0.5 }, mediaResolution: 'low', systemInstruction: 'Cite MM:SS.',
    });
    expect((await studioAnalysisBody('x', { fromVideo: 'v1', processing: 'agentic' })).body.processing).toEqual({ mode: 'agentic' });
    const file = video();
    expect(await studioAnalysisBody('x', { video: file })).toEqual({ body: { prompt: 'x' }, upload: file });
  });

  it('maps narration to true or to the two overrides, which turn it on', async () => {
    expect((await studioAnalysisBody('x', { fromVideo: 'v1', narrate: true })).body.narrate).toBe(true);
    expect((await studioAnalysisBody('x', { fromVideo: 'v1', narrateVoice: 'Puck', narratePlaylist: 'Lectures' })).body.narrate).toEqual({ voice: 'Puck', playlist: 'Lectures' });
    expect((await studioAnalysisBody('x', { fromVideo: 'v1' })).body.narrate).toBeUndefined();
  });

  it('runs again or follows up on --item, keeping the stored source', async () => {
    expect((await studioAnalysisBody('Shorter', { item: 'a1' })).body).toEqual({ prompt: 'Shorter' });
    expect((await studioAnalysisBody('Why?', { item: 'a1', followUp: 'v1_abc' })).body).toEqual({ prompt: 'Why?', previousInteractionId: 'v1_abc' });
  });

  it('rejects bad flags before anything is uploaded or created', async () => {
    const file = video();
    for (const [args, message] of [
      [{}, 'Choose a video'], [{ video: file, fromVideo: 'v1' }, 'either --video or --from-video'], [{ clip: '1' }, 'need --from-video'],
      [{ fromVideo: 'v1', clip: '0' }, '--clip must be a whole number at least 1'], [{ fromVideo: 'v1', clip: '1.5' }, '--clip must be a whole number'],
      [{ video: 'https://vimeo.com/1' }, 'links must be YouTube'], [{ video: video(4, 'clip.gif') }, 'not a supported video'], [{ video: path.join(tempDir(), 'missing.mp4') }, 'is not a file'],
      [{ video: video(0) }, 'is empty'], [{ followUp: 'v1_abc' }, '--follow-up needs --item'], [{ item: 'a1', followUp: 'v1', fromVideo: 'v1' }, 'reuses the earlier video'],
      [{ item: 'a1', followUp: 'v1', mediaResolution: 'low' }, 'reuses the earlier video'], [{ fromVideo: 'v1', processing: 'agentic', fps: '1' }, 'only apply to static'],
      [{ fromVideo: 'v1', processing: 'agentic', model: 'gemini-2.5-flash' }, 'agentic needs one of'], [{ fromVideo: 'v1', start: '2m', end: '1m' }, '--end must be after --start'],
      [{ fromVideo: 'v1', start: 'soon' }, '--start must be seconds'], [{ fromVideo: 'v1', fps: '0' }, '--fps must be greater than 0'],
      [{ fromVideo: 'v1', mediaResolution: 'huge' }, '--media-resolution must be one of'], [{ fromVideo: 'v1', processing: 'fast' }, '--processing must be one of'],
      [{ fromVideo: 'v1', system: ' ' }, '--system is empty'], [{ fromVideo: 'v1', narrate: false, narrateVoice: 'Puck' }, 'drop --no-narrate'],
      [{ fromVideo: '../v1' }, '--from-video must be an id'],
    ] as const) await expect(studioAnalysisBody('x', args as never), JSON.stringify(args)).rejects.toThrow(message);
    await expect(studioAnalysisBody(' ', { fromVideo: 'v1' })).rejects.toThrow('The prompt is empty.');
  });

  it('reads --schema into responseSchema, capped, and never with narration', async () => {
    const dir = tempDir(); const schemaFile = path.join(dir, 'shots.json');
    fs.writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: { shots: { type: 'array' } } }));
    expect((await studioAnalysisBody('Shots', { fromVideo: 'v1', schema: schemaFile })).body.responseSchema).toEqual({ type: 'object', properties: { shots: { type: 'array' } } });
    fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ description: 'x'.repeat(32_001) }));
    fs.writeFileSync(path.join(dir, 'list.json'), '[]'); fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    for (const [args, message] of [
      [{ schema: path.join(dir, 'big.json') }, 'limited to 32,000'], [{ schema: path.join(dir, 'list.json') }, 'JSON Schema object'],
      [{ schema: path.join(dir, 'bad.json') }, 'not valid JSON'], [{ schema: path.join(dir, 'none.json') }, 'cannot read'], [{ schema: schemaFile, narrate: true }, 'Narration reads a Markdown answer'],
    ] as const) await expect(studioAnalysisBody('x', { fromVideo: 'v1', ...args } as never), JSON.stringify(args)).rejects.toThrow(message);
  });
});

describe('studio analyze end to end', () => {
  it('uploads a local video first, then creates the analysis from it', async () => {
    const file = video(32);
    await run('--video', file, '-p', 'Shot list', '--narrate-voice', 'Puck');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/assets?media=analysis', 'POST /api/v1/analyses']);
    expect(calls[0]!.headers.get('content-type')).toBe('video/mp4'); expect((calls[0]!.body as Uint8Array).length).toBe(32);
    expect(calls[1]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{10,128}$/);
    expect(sent(1)).toEqual({ prompt: 'Shot list', source: { kind: 'asset', assetId: 'upload1' }, narrate: { voice: 'Puck' } });
    expect(out).toEqual(['Analysis started: http://localhost:3000/library (id item1)']);
  });

  it('with --wait prints the Markdown answer on stdout and status on stderr', async () => {
    narration = { narrationId: 'narr_gen1', narrationError: null };
    await run('--from-video', 'v1', '--clip', '2', '-p', 'Shot list', '--wait');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/analyses', 'GET /api/v1/analyses/item1', 'GET /api/v1/assets/analysis_gen1/content']);
    expect(out).toEqual([ANSWER]);
    expect(err).toContain('Shot list: ready — http://localhost:3000/library (id item1)');
    expect(err).toContain('Narration: http://localhost:3000/narration/narr_gen1');
    expect(process.exitCode).toBe(0);
  });

  it('with --wait prints each new step Gemini reports on stderr, once', async () => {
    running = ['Finding the interruptions', 'Finding the interruptions'];
    await run('--video', 'https://youtu.be/9hE5-98ZeCg', '-p', 'Shot list', '--wait');
    expect(err.filter((line) => line === '  Finding the interruptions')).toHaveLength(1);
    expect(out).toEqual([ANSWER]);
  }, 15_000);

  it('reports a narration that did not start without failing the analysis', async () => {
    narration = { narrationId: 'narr_gen1', narrationError: { code: 'narration_too_long', message: 'Too long for narration.' } };
    await run('--from-video', 'v1', '-p', 'x', '--narrate', '--wait');
    expect(out).toEqual([ANSWER]); expect(err).toContain('Narration did not start: Too long for narration.'); expect(process.exitCode).toBe(0);
  });

  it('with -o saves the Markdown asset', async () => {
    const output = path.join(tempDir(), 'notes.md');
    await run('--video', 'https://youtu.be/9hE5-98ZeCg', '-p', 'x', '-o', output);
    expect(fs.readFileSync(output, 'utf8')).toBe(ANSWER);
    expect(out).toEqual([`Shot list: ready — http://localhost:3000/library (id item1)\nSaved ${output}`]);
  });

  it('with --json prints the resource, not the Markdown', async () => {
    await run('--from-video', 'v1', '-p', 'x', '--wait', '--json');
    expect(calls).toHaveLength(2); expect(JSON.parse(out[0]!)).toMatchObject({ id: 'item1', type: 'analysis', status: 'ready' });
  });

  it('runs a follow-up as a new generation on --item', async () => {
    await run('--item', 'item1', '--follow-up', 'v1_abc', '-p', 'And then?');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/v1/analyses/item1/generations']);
    expect(sent()).toEqual({ prompt: 'And then?', previousInteractionId: 'v1_abc' });
  });

  it('checks every flag before uploading', async () => {
    await run('--video', video(), '-p', 'x', '--processing', 'agentic', '--fps', '1', '--json');
    expect(calls).toHaveLength(0); expect(JSON.parse(out[0]!).error.message).toContain('only apply to static'); expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run('--video', video(), '-p', 'x', '-o', path.join(tempDir(), 'missing', 'notes.md'));
    expect(calls).toHaveLength(0); expect(process.exitCode).toBe(1);
  });

  it('studio status --type analysis reads the analysis', async () => {
    await runCommand(studioCommand, { rawArgs: ['status', 'item1', '--type', 'analysis'] });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/v1/analyses/item1']);
    expect(out).toEqual(['Shot list: ready — http://localhost:3000/library']);
  });
});

describe('studio client for analyses', () => {
  it('uploads a video reference as raw bytes for analysis, separate from image references', async () => {
    const seen: Array<{ url: string; type: string | null }> = [];
    const client = new StudioClient(ORIGIN, KEY, (async (url: URL, init: RequestInit) => { seen.push({ url: String(url), type: new Headers(init.headers).get('content-type') }); return Response.json({ id: 'v1' }, { status: 201 }); }) as unknown as typeof fetch);
    expect((await client.uploadVideoReference(new Uint8Array([0, 0, 0, 24]), 'video/webm')).id).toBe('v1');
    expect(seen).toEqual([{ url: `${ORIGIN}/api/v1/assets?media=analysis`, type: 'video/webm' }]);
  });
});
