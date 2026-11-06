import { describe, expect, it } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GeminiVideoAnalysisProvider,
  MAX_INLINE_REQUEST_BYTES,
  canHearAudio,
  processingConfig,
  progressLine,
  validateAnalysis,
} from './gemini-video-analysis-provider.js';
import { parseVideoTime } from './time.js';

type Call = { kind: string; params?: any; options?: any };

/** A stand-in for the parts of the Gemini client the provider uses. */
function fakeClient(script: { create?: (params: any) => any; gets?: any[]; uploads?: any[]; fileGets?: any[]; stream?: any[] } = {}) {
  const calls: Call[] = [];
  const gets = [...(script.gets ?? [])];
  const fileGets = [...(script.fileGets ?? [])];
  const client = {
    interactions: {
      create: async (params: any, options: any) => {
        calls.push({ kind: 'create', params, options });
        return script.create ? script.create(params) : { id: 'int_1', status: 'completed', output_text: 'An answer.' };
      },
      get: async (id: string, params?: any) => {
        if (params?.stream) {
          calls.push({ kind: 'stream', params: id });
          const events = script.stream ?? [];
          return (async function* () { for (const event of events) yield event; })();
        }
        calls.push({ kind: 'get', params: id });
        const next = gets.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    files: {
      upload: async (params: any) => {
        calls.push({ kind: 'upload', params });
        return (script.uploads ?? [{ name: 'files/abc', state: 'PROCESSING', mimeType: 'video/mp4' }])[0];
      },
      get: async (params: any) => {
        calls.push({ kind: 'fileGet', params });
        return fileGets.shift();
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

async function tempVideo(bytes: number, name = 'clip.mp4'): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mdmedia-analysis-'));
  const file = path.join(dir, name);
  await writeFile(file, Buffer.alloc(bytes, 1));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('GeminiVideoAnalysisProvider', () => {
  it('sends a small local video inline, before the prompt, in the background', async () => {
    const { file, cleanup } = await tempVideo(1024);
    try {
      const { client, calls } = fakeClient();
      const receipts: string[] = [];
      const result = await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('Summarize this.', [{ kind: 'path', path: file }], {
        onInteraction: (id) => { receipts.push(id); },
      });
      const create = calls.find((call) => call.kind === 'create')!;
      expect(create.params.model).toBe('gemini-3.8-flash');
      expect(create.params.background).toBe(true);
      expect(create.params.store).toBe(true);
      expect(create.params.input[0]).toMatchObject({ type: 'video', mime_type: 'video/mp4' });
      expect(create.params.input[0].data).toBe(Buffer.alloc(1024, 1).toString('base64'));
      expect(create.params.input[1]).toEqual({ type: 'text', text: 'Summarize this.' });
      expect(create.options.maxRetries).toBe(0);
      expect(calls.some((call) => call.kind === 'upload')).toBe(false);
      expect(receipts).toEqual(['int_1']);
      expect(result).toMatchObject({ interactionId: 'int_1', model: 'gemini-3.8-flash', text: 'An answer.' });
    } finally { await cleanup(); }
  });

  it('uploads through the Files API when the request would exceed the inline limit', async () => {
    const { file, cleanup } = await tempVideo(Math.ceil(MAX_INLINE_REQUEST_BYTES * 0.8));
    try {
      const { client, calls } = fakeClient({
        fileGets: [{ name: 'files/abc', state: 'PROCESSING' }, { name: 'files/abc', state: 'ACTIVE', uri: 'https://files/abc', mimeType: 'video/mp4' }],
      });
      const phases: string[] = [];
      await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('What happens?', [{ kind: 'path', path: file }], {
        onPhase: (phase) => phases.push(phase),
      });
      expect(calls.filter((call) => call.kind === 'fileGet')).toHaveLength(2);
      const part = calls.find((call) => call.kind === 'create')!.params.input[0];
      expect(part).toEqual({ type: 'video', uri: 'https://files/abc', mime_type: 'video/mp4' });
      expect(phases).toEqual(['uploading', 'processing', 'analyzing']);
    } finally { await cleanup(); }
  });

  it('fails clearly when the Files API cannot process the video', async () => {
    const { file, cleanup } = await tempVideo(Math.ceil(MAX_INLINE_REQUEST_BYTES * 0.8));
    try {
      const { client, calls } = fakeClient({ uploads: [{ name: 'files/abc', state: 'FAILED' }] });
      await expect(new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('What happens?', [{ kind: 'path', path: file }]))
        .rejects.toThrow('could not process clip.mp4');
      expect(calls.some((call) => call.kind === 'create')).toBe(false);
    } finally { await cleanup(); }
  });

  it('passes YouTube links straight through with processing and resolution on the video part', async () => {
    const { client, calls } = fakeClient();
    await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('Key moments?', [{ kind: 'youtube', url: 'https://www.youtube.com/watch?v=9hE5-98ZeCg' }], {
      startSeconds: 1200, endSeconds: 1500, fps: 0.5, mediaResolution: 'low', systemInstruction: 'Be brief.', background: false,
    });
    const params = calls.find((call) => call.kind === 'create')!.params;
    expect(params.input[0]).toEqual({
      type: 'video', uri: 'https://www.youtube.com/watch?v=9hE5-98ZeCg', resolution: 'low',
      processing: { type: 'static', start_offset: '1200s', end_offset: '1500s', fps: 0.5 },
    });
    expect(params.system_instruction).toBe('Be brief.');
    expect(params.background).toBeUndefined();
  });

  it('polls a background interaction until it completes and keeps its trace and usage', async () => {
    const { client, calls } = fakeClient({
      create: () => ({ id: 'int_bg', status: 'in_progress' }),
      gets: [
        { status: 'in_progress' },
        new Error('fetch failed'),
        {
          status: 'completed',
          steps: [
            { type: 'thought', summary: [{ type: 'text', text: 'Inspecting transcript…' }] },
            { type: 'processing_call', id: 'call_01' },
            { type: 'model_output', content: [{ type: 'text', text: 'Three arguments.' }] },
          ],
          usage: { total_input_tokens: 10, total_thought_tokens: 4, total_tool_use_tokens: 2, total_tokens: 20 },
        },
      ],
    });
    const result = await new GeminiVideoAnalysisProvider(client, 2, undefined, 1).analyzeVideo('Main arguments?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], {
      processing: 'agentic',
    });
    expect(calls.find((call) => call.kind === 'create')!.params.input[0].processing).toBe('agentic');
    expect(calls.filter((call) => call.kind === 'get')).toHaveLength(3);
    expect(result.text).toBe('Three arguments.');
    expect(result.trace).toEqual(['Inspecting transcript…']);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: undefined, thoughtTokens: 4, toolUseTokens: 2, totalTokens: 20 });
  });

  it('reports a failed interaction and never re-creates it', async () => {
    const { client, calls } = fakeClient({
      create: () => ({ id: 'int_bad', status: 'in_progress' }),
      gets: [{ status: 'failed', error: { message: 'video too long' } }],
    });
    await expect(new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }]))
      .rejects.toThrow('Video analysis failed: video too long');
    expect(calls.filter((call) => call.kind === 'create')).toHaveLength(1);
  });

  it('asks a follow-up without a video using previous_interaction_id', async () => {
    const { client, calls } = fakeClient();
    await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('And the second one?', [], { previousInteractionId: 'int_1' });
    const params = calls.find((call) => call.kind === 'create')!.params;
    expect(params.previous_interaction_id).toBe('int_1');
    expect(params.input).toEqual([{ type: 'text', text: 'And the second one?' }]);
  });

  it('retrieves a stored receipt without creating anything', async () => {
    const { client, calls } = fakeClient({ gets: [{ status: 'completed', output_text: 'Recovered.' }] });
    const result = await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).retrieveAnalysis('int_saved');
    expect(result).toMatchObject({ interactionId: 'int_saved', text: 'Recovered.' });
    expect(calls.map((call) => call.kind)).toEqual(['get']);
  });

  it('asks for JSON with a schema and checks the answer parses', async () => {
    const schema = { type: 'object', properties: { shots: { type: 'array', items: { type: 'string' } } }, required: ['shots'] };
    const { client, calls } = fakeClient({ create: () => ({ id: 'int_json', status: 'completed', output_text: '{"shots":["00:00 Bars"]}' }) });
    const result = await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('List the shots.', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], { responseSchema: schema });
    expect(calls.find((call) => call.kind === 'create')!.params.response_format).toEqual({ type: 'text', mime_type: 'application/json', schema });
    expect(JSON.parse(result.text)).toEqual({ shots: ['00:00 Bars'] });

    const bad = fakeClient({ create: () => ({ id: 'int_bad', status: 'completed', output_text: 'Not JSON.' }) });
    await expect(new GeminiVideoAnalysisProvider(bad.client, 0, undefined, 1).analyzeVideo('?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], { responseSchema: schema }))
      .rejects.toThrow('without valid JSON');
  });

  it('checks JSON on recovery from the format the interaction echoes back', async () => {
    const { client } = fakeClient({ gets: [{ status: 'completed', output_text: 'oops', response_format: { type: 'text', mime_type: 'application/json' } }] });
    await expect(new GeminiVideoAnalysisProvider(client, 0, undefined, 1).retrieveAnalysis('int_saved')).rejects.toThrow('without valid JSON');
  });

  it('reports each new thought title while a background analysis runs', async () => {
    const thought = (index: number, text: string) => ({ event_type: 'step.delta', index, delta: { type: 'thought_summary', content: { type: 'text', text } } });
    const { client, calls } = fakeClient({
      create: () => ({ id: 'int_bg', status: 'in_progress' }),
      stream: [
        { event_type: 'interaction.created' },
        { event_type: 'step.start', index: 1, step: { type: 'processing_call' } },
        thought(2, '**Finding the'), thought(2, ' interruptions**\n\nLooking near 00:20.'),
        { event_type: 'step.stop', index: 2 },
        thought(3, '**Finding the interruptions**\n\nAgain.'),
        thought(4, 'Checking the closing card. Then more.'),
        { event_type: 'step.stop', index: 4 },
        { event_type: 'step.delta', index: 5, delta: { type: 'text', text: 'The answer.' } },
      ],
      gets: [{ status: 'in_progress' }, { status: 'in_progress' }, { status: 'completed', output_text: 'The answer.' }],
    });
    const steps: string[] = [];
    await new GeminiVideoAnalysisProvider(client, 0, undefined, 5).analyzeVideo('When is Gemini interrupted?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], {
      processing: 'agentic', onProgress: (step) => steps.push(step),
    });
    expect(calls.find((call) => call.kind === 'create')!.params.generation_config).toEqual({ thinking_summaries: 'auto' });
    expect(calls.filter((call) => call.kind === 'stream')).toHaveLength(1);
    expect(steps).toEqual(['Finding the interruptions', 'Checking the closing card. Then more.']);
  });

  it('does not stream or ask for summaries without onProgress', async () => {
    const { client, calls } = fakeClient({ create: () => ({ id: 'int_bg', status: 'in_progress' }), gets: [{ status: 'completed', output_text: 'Done.' }] });
    await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }]);
    expect(calls.find((call) => call.kind === 'create')!.params.generation_config).toBeUndefined();
    expect(calls.some((call) => call.kind === 'stream')).toBe(false);
  });

  it('keeps going when the progress stream fails', async () => {
    const { client } = fakeClient({ create: () => ({ id: 'int_bg', status: 'in_progress' }), gets: [{ status: 'completed', output_text: 'Done.' }] });
    (client as any).interactions.get = ((get) => async (id: string, params?: any) => {
      if (params?.stream) throw new Error('stream refused');
      return get(id, params);
    })((client as any).interactions.get);
    const result = await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], { onProgress: () => {} });
    expect(result.text).toBe('Done.');
  });

  it('warns when the model cannot hear audio', async () => {
    const { client } = fakeClient();
    const warnings: string[] = [];
    await new GeminiVideoAnalysisProvider(client, 0, undefined, 1).analyzeVideo('?', [{ kind: 'youtube', url: 'https://youtu.be/abc' }], {
      model: 'gemini-4-argon', onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual(['gemini-4-argon cannot hear audio; the analysis will use the picture only.']);
  });
});

describe('validateAnalysis', () => {
  const youtube = [{ kind: 'youtube' as const, url: 'https://youtu.be/abc' }];
  it('rejects bad input before any network call', () => {
    expect(() => validateAnalysis(' ', youtube, 'gemini-3.8-flash', {})).toThrow('The prompt is empty.');
    expect(() => validateAnalysis('?', [], 'gemini-3.8-flash', {})).toThrow('at least one video');
    expect(() => validateAnalysis('?', Array(11).fill(youtube[0]), 'gemini-3.8-flash', {})).toThrow('At most 10 videos');
    expect(() => validateAnalysis('?', [{ kind: 'youtube', url: 'https://vimeo.com/1' }], 'gemini-3.8-flash', {})).toThrow('not a YouTube link');
    expect(() => validateAnalysis('?', [{ kind: 'path', path: 'notes.txt' }], 'gemini-3.8-flash', {})).toThrow('not a supported video');
    expect(() => validateAnalysis('?', youtube, 'gemini-2.5-flash', { processing: 'agentic' })).toThrow('Agentic processing needs one of');
    expect(() => validateAnalysis('?', youtube, 'gemini-3.8-flash', { processing: 'agentic', fps: 2 })).toThrow('only apply to static');
    expect(() => validateAnalysis('?', youtube, 'gemini-3.8-flash', { startSeconds: 30, endSeconds: 10 })).toThrow('end time must be after');
    expect(() => validateAnalysis('?', youtube, 'gemini-3.8-flash', { fps: 0 })).toThrow('fps must be greater than 0');
    expect(() => validateAnalysis('?', youtube, 'gemini-3.8-flash', { responseSchema: [] as never })).toThrow('JSON Schema object');
  });
});

describe('processingConfig', () => {
  it('omits processing unless something differs from the default', () => {
    expect(processingConfig({})).toBeUndefined();
    expect(processingConfig({ processing: 'static' })).toBe('static');
    expect(processingConfig({ processing: 'agentic' })).toBe('agentic');
    expect(processingConfig({ startSeconds: 10.5 })).toEqual({ type: 'static', start_offset: '10.5s' });
  });
});

describe('progressLine', () => {
  it('keeps a thought to its title or first line, plain and short', () => {
    expect(progressLine('**Analyzing User Interruptions**\n\nI am now focusing…')).toBe('Analyzing User Interruptions');
    expect(progressLine('Checking `the` _card_\nmore')).toBe('Checking the card');
    expect(progressLine('x'.repeat(300))).toHaveLength(120);
  });
});

describe('canHearAudio', () => {
  it('knows argon and lite models are picture-only', () => {
    expect(canHearAudio('gemini-3.8-flash')).toBe(true);
    expect(canHearAudio('gemini-4-argon')).toBe(false);
    expect(canHearAudio('gemini-3.5-flash-lite')).toBe(false);
  });
});

describe('parseVideoTime', () => {
  it('reads seconds, units, and timestamps', () => {
    expect(parseVideoTime('--start', '90')).toBe(90);
    expect(parseVideoTime('--start', '10.5s')).toBe(10.5);
    expect(parseVideoTime('--start', '20m')).toBe(1200);
    expect(parseVideoTime('--start', '01:15')).toBe(75);
    expect(parseVideoTime('--start', '1:02:03')).toBe(3723);
    expect(parseVideoTime('--start', undefined)).toBeUndefined();
    expect(() => parseVideoTime('--start', 'soon')).toThrow('--start must be');
  });
});
