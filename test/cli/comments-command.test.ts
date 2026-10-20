import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from 'citty';
import { StudioClient, type ProductionSummary, type ThreadDetail, type ThreadResource } from '../../src/remote/client.js';
import { commentsCommand, describeList, describeThread, prepareSuggestions, resolveProduction, timedRefFrom } from '../../src/cli/comments-command.js';
import type { Suggestion } from '../../src/threads/types.js';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ORIGIN = 'http://localhost:3000';
const PRODUCTION = 'pr0123456789abcdef01234567';

const production = {
  id: PRODUCTION, slug: 'big-hal', title: 'Big Hal', series: null, coverAssetId: null, currentCutId: 'take5', approvedCutId: null, cutCount: 2,
  cuts: [
    { id: 'take5', label: 'Take 5 (shot by shot)', status: 'review', kind: 'cut', lengthSeconds: 27.3, createdAt: 1, order: 4, renderedAssetId: 'pmr', links: { self: '', rendered: null } },
    { id: 'take6', label: 'Take 6 (wheels in one breath)', status: 'review', kind: 'cut', lengthSeconds: 25.9, createdAt: 2, order: 5, renderedAssetId: 'pmr6', links: { self: '', rendered: null } },
  ],
  createdAt: 1, updatedAt: 1, links: { self: '', cover: null, coverThumbnail: null },
} as ProductionSummary;

const option = (over: Partial<Suggestion>): Suggestion => ({
  id: 's4', threadId: 't2', author: 'agent:editor', round: 2, letter: 'A', title: 'One take through "save big!"', approach: '', steps: [], cost: { generations: 3, minutes: 40 }, risks: [], checks: [],
  previews: [{ assetId: 'pmp15' }, { assetId: 'pmp16', label: 'without the level ride' }], keeps: [], overturns: [], creates: [], state: 'applied', appliedAs: 'take6', createdAt: 3, ...over,
});
const thread: ThreadResource = {
  id: 't2', productionId: PRODUCTION, version: { cutId: 'take5', cutUpdatedAt: 1 },
  anchor: { time: 21.8, items: [{ kind: 'segment', id: 'finish', start: 21.13, end: 27.31 }, { kind: 'line', id: 'wheels', start: 21.68, end: 22.42 }] },
  snapshot: null, text: 'The joke is split across two clips.', author: 'owner', status: 'addressed', claim: null, createdAt: 1, updatedAt: 4,
  statusLine: { tone: 'needs-you', text: 'Addressed in Take 6' }, needsAgent: false, links: { self: '', context: '' },
};
const detail: ThreadDetail = {
  thread,
  messages: [
    { id: 'm3', threadId: 't2', author: 'agent:editor', text: 'One take.', suggestions: ['s4'], createdAt: 3 },
    { id: 'm4', threadId: 't2', author: 'owner', text: 'Too loud here.', at: { video: { kind: 'preview', suggestionId: 's4', assetId: 'pmp16' }, time: 2.5 }, createdAt: 4 },
    { id: 'm5', threadId: 't2', author: 'agent:editor', text: 'Applied.', version: { cutId: 'take6' }, replyTo: 'm4', createdAt: 5 },
  ],
  suggestions: [option({})],
};

type Call = { method: string; path: string; body: unknown };
/** A studio that answers the comments routes from the fixtures above, and records what it was sent. */
function fakeFetch(calls: Call[], have: Set<string> = new Set()) {
  return (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof Blob ? `blob:${init.body.size}` : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const p = url.pathname;
    if (p === '/api/v1/productions') return Response.json({ productions: [production], series: [] });
    if (p === `/api/v1/productions/${PRODUCTION}`) return Response.json(production);
    if (p === '/api/v1/productions/media') { const sha = url.searchParams.get('sha256')!; return Response.json({ found: have.has(sha) ? { [sha]: { id: `pm-${sha.slice(0, 6)}` } } : {} }); }
    if (p.startsWith('/api/v1/productions/media/')) return Response.json({ id: `pm-${p.split('/').at(-1)!.slice(0, 6)}` }, { status: 201 });
    if (p.endsWith('/threads/t2') && method === 'GET') return Response.json(detail);
    if (p.endsWith('/threads/t2') && method === 'PATCH') return Response.json({ ...thread, status: (body as { status: string }).status, statusLine: { tone: 'done', text: 'Resolved' } });
    if (p.endsWith('/messages')) return Response.json({ id: 'm9', threadId: 't2', author: 'agent:editor', createdAt: 9, ...(body as object) }, { status: 201 });
    if (p.endsWith('/suggestions/s4')) return Response.json(option({ ...(body as object) }));
    if (p.endsWith('/claim')) return Response.json({ ...thread, status: 'in-progress', statusLine: { tone: 'working', text: 'Agent working' } });
    return Response.json({ error: { code: 'not_found', message: `no route ${method} ${p}` } }, { status: 404 });
  }) as unknown as typeof fetch;
}

let logs: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
const dirs: string[] = [];
beforeEach(() => {
  logs = [];
  spies = [spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); }), spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('comments: reading', () => {
  it('finds a production by slug or id', async () => {
    const client = new StudioClient(ORIGIN, KEY, fakeFetch([]));
    expect((await resolveProduction(client, 'big-hal')).id).toBe(PRODUCTION);
    expect((await resolveProduction(client, PRODUCTION)).slug).toBe('big-hal');
    await expect(resolveProduction(client, 'nope')).rejects.toThrow('No production "nope"');
  });

  it('lists threads one line each, by plain labels', () => {
    const text = describeList([thread, { ...thread, id: 't3', needsAgent: true, statusLine: { tone: 'waiting', text: 'Waiting for an agent' } }], production);
    expect(text).toContain('t2  Take 5 · 21.8 s  Addressed in Take 6\n    The joke is split across two clips.');
    expect(text).toContain('Waiting for an agent (needs an agent)');
    expect(describeList([], production)).toBe('No threads.');
  });

  it('prints a thread top to bottom, each time naming its video', () => {
    const text = describeThread(detail, production);
    expect(text).toContain('t2 · Take 5 · 21.8 s · during line wheels · finish shot');
    expect(text).toContain('s4  Option A · round 2 · applied as Take 6 — One take through "save big!"');
    expect(text).toContain('preview pmp16: Option A · round 2 · without the level ride');
    expect(text).toContain('at Option A · round 2 · without the level ride · 2.5 s [m4]');
    expect(text).toContain('presents Take 6 [m5, replying to m4]');
    expect(text).not.toMatch(/\.mp4/);
  });
});

describe('comments: writing', () => {
  it('reads where a reply\'s time is: the thread\'s cut, another cut, or a preview', () => {
    expect(timedRefFrom({}, detail)).toBeUndefined();
    expect(timedRefFrom({ at: '21.5' }, detail)).toEqual({ video: { kind: 'cut', cutId: 'take5' }, time: 21.5 });
    expect(timedRefFrom({ at: '3', video: 'take6' }, detail)).toEqual({ video: { kind: 'cut', cutId: 'take6' }, time: 3 });
    expect(timedRefFrom({ at: '1.2', preview: 's4:2' }, detail)).toEqual({ video: { kind: 'preview', suggestionId: 's4', assetId: 'pmp16' }, time: 1.2 });
    expect(() => timedRefFrom({ preview: 's4' }, detail)).toThrow('need --at');
    expect(() => timedRefFrom({ at: 'soon' }, detail)).toThrow('--at must be seconds');
    expect(() => timedRefFrom({ at: '1', preview: 's4:3' }, detail)).toThrow('has no preview 3');
  });

  it('uploads each preview once, by its hash, and sends the options with their asset ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-suggest-'));
    dirs.push(dir);
    // The smallest MP4 the reader accepts: an ftyp box and nothing else (no length).
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    fs.writeFileSync(path.join(dir, 'a.mp4'), mp4);
    fs.writeFileSync(path.join(dir, 'b.mp4'), Buffer.concat([mp4, Buffer.from([1])]));
    const known = createHash('sha256').update(Buffer.concat([mp4, Buffer.from([1])])).digest('hex');
    fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({
      message: 'I read this as: say it plainly.',
      suggestions: [{ title: 'One breath', previews: [{ file: 'a.mp4' }, { file: 'b.mp4', label: 'without the ride' }] }, { title: 'Re-cut', previews: [{ assetId: 'pmold' }] }],
    }));
    const calls: Call[] = [];
    const client = new StudioClient(ORIGIN, KEY, fakeFetch(calls, new Set([known])));
    const prepared = await prepareSuggestions(client, path.join(dir, 'options.json'));
    expect(prepared.message).toBe('I read this as: say it plainly.');
    expect(prepared.suggestions[0]!.previews!.map((p) => p.assetId)).toEqual([`pm-${createHash('sha256').update(mp4).digest('hex').slice(0, 6)}`, `pm-${known.slice(0, 6)}`]);
    expect(prepared.suggestions[0]!.previews![1]!.label).toBe('without the ride');
    expect(prepared.suggestions[1]!.previews).toEqual([{ assetId: 'pmold' }]);
    // One upload: the known file was found by its hash.
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('?')[1])).toEqual(['mediaType=video']);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ suggestions: [{ title: 'x' }] }));
    await expect(prepareSuggestions(client, path.join(dir, 'bad.json'))).rejects.toThrow('needs "message"');
    fs.writeFileSync(path.join(dir, 'still.json'), JSON.stringify({ message: 'm', suggestions: [{ title: 'x', previews: [{ file: 'still.png' }] }] }));
    await expect(prepareSuggestions(client, path.join(dir, 'still.json'))).rejects.toThrow('A preview must be');
  });

  it('runs reply, claim and state through the connected studio, signed as the agent', async () => {
    const calls: Call[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(calls));
    const env = { url: process.env.MDMEDIA_STUDIO_URL, key: process.env.MDMEDIA_API_KEY };
    process.env.MDMEDIA_STUDIO_URL = ORIGIN;
    process.env.MDMEDIA_API_KEY = KEY;
    try {
      await runCommand(commentsCommand, { rawArgs: ['reply', 'big-hal', 't2', '--text', 'On it.', '--at', '1.5', '--preview', 's4', '--agent', 'editor'] });
      const reply = calls.find((c) => c.path.endsWith('/messages'))!;
      expect(reply.body).toEqual({ text: 'On it.', agent: 'editor', at: { video: { kind: 'preview', suggestionId: 's4', assetId: 'pmp15' }, time: 1.5 } });
      expect(logs.at(-1)).toBe('m9: replied at Option A · round 2 · 1.5 s');

      await runCommand(commentsCommand, { rawArgs: ['claim', 'big-hal', 't2', '--agent', 'editor', '--minutes', '30'] });
      expect(calls.find((c) => c.path.endsWith('/claim'))!.body).toEqual({ agent: 'editor', minutes: 30 });
      expect(logs.at(-1)).toBe('t2: Agent working');

      await runCommand(commentsCommand, { rawArgs: ['state', 'big-hal', 't2', 's4', 'applied', '--as', 'take6', '--agent', 'editor'] });
      expect(calls.find((c) => c.path.endsWith('/suggestions/s4'))!.body).toEqual({ state: 'applied', appliedAs: 'take6', agent: 'editor' });
      expect(logs.at(-1)).toBe('s4: Option A · round 2 applied as Take 6');

      await runCommand(commentsCommand, { rawArgs: ['state', 'big-hal', 't2', 'resolved'] });
      expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/threads/t2'))!.body).toEqual({ status: 'resolved' });

      await runCommand(commentsCommand, { rawArgs: ['state', 'big-hal', 't2', 'finished'] });
      expect(process.exitCode).toBe(1);
    } finally {
      fetchSpy.mockRestore();
      process.env.MDMEDIA_STUDIO_URL = env.url;
      process.env.MDMEDIA_API_KEY = env.key;
      if (env.url === undefined) delete process.env.MDMEDIA_STUDIO_URL;
      if (env.key === undefined) delete process.env.MDMEDIA_API_KEY;
    }
  });
});
