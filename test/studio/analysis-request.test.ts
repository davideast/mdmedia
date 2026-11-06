import { describe, expect, it } from 'bun:test';
import { parseAnalysisRequest, providerOptions, resolveAnalysisNarration } from '../../studio/src/lib/analysis-request';
import { readSettings } from '../../studio/src/lib/settings';

const youtube = { kind: 'youtube', url: 'https://youtu.be/9hE5-98ZeCg' };
const parse = (body: unknown, defaults = null as ReturnType<typeof parseAnalysisRequest>['request'] | null, followUps = false) =>
  parseAnalysisRequest(body, { defaults, model: 'gemini-3.8-flash', followUps });

describe('analysis request contract', () => {
  it('resolves omitted settings to null so the studio and model defaults apply', () => {
    expect(parse({ prompt: 'Shot list', source: youtube })).toEqual({ narrate: undefined, request: {
      prompt: 'Shot list', source: { kind: 'youtube', url: youtube.url }, model: null, processing: null, mediaResolution: null, systemInstruction: null, responseSchema: null, previousInteractionId: null,
    } });
    expect(parse({ prompt: 'x', source: { kind: 'video', videoItemId: 'v1', clip: 2 } }).request.source).toEqual({ kind: 'video', videoItemId: 'v1', generationId: null, clip: 2 });
    expect(parse({ prompt: 'x', source: youtube, processing: { startSeconds: 20 } }).request.processing).toEqual({ mode: 'static', startSeconds: 20, endSeconds: null, fps: null });
  });

  it('rejects unknown fields and invalid combinations before acceptance', () => {
    for (const body of [
      { prompt: 'x', source: youtube, temperature: 1 }, { prompt: 'x', source: { ...youtube, start: 1 } }, { prompt: 'x', source: { kind: 'vimeo', url: 'x' } },
      { prompt: 'x', source: { kind: 'video', videoItemId: '../v' } }, { prompt: 'x', source: { kind: 'video', videoItemId: 'v', clip: 0 } },
      { prompt: 'x', source: { kind: 'youtube', url: 'https://example.com/v' } }, { prompt: 'x', source: youtube, processing: { mode: 'agentic', startSeconds: 1 } },
      { prompt: 'x', source: youtube, model: 'gemini-2.5-flash', processing: { mode: 'agentic' } }, { prompt: 'x', source: youtube, processing: { startSeconds: 9, endSeconds: 3 } },
      { prompt: 'x', source: youtube, processing: { fps: 0 } }, { prompt: 'x', source: youtube, processing: { mode: 'slow' } }, { prompt: 'x', source: youtube, mediaResolution: 'huge' },
      { prompt: 'x', source: youtube, systemInstruction: '' }, { prompt: 'x', source: youtube, model: 'bad model' }, { prompt: 'x'.repeat(32_001), source: youtube }, { prompt: 'x' },
      { prompt: 'x', source: youtube, previousInteractionId: 'abc' },
    ]) expect(() => parse(body), JSON.stringify(body)).toThrow();
  });

  it('keeps the previous request on a re-run and allows follow-ups only on an existing analysis, without a new video', () => {
    const previous = parse({ prompt: 'First', source: youtube, mediaResolution: 'high', systemInstruction: 'Be brief.' }).request;
    expect(parse({ prompt: 'Second' }, previous, true).request).toEqual({ ...previous, prompt: 'Second' });
    expect(parse({ prompt: 'Why?', previousInteractionId: 'v1_abc' }, previous, true).request.previousInteractionId).toBe('v1_abc');
    expect(() => parse({ prompt: 'Why?', previousInteractionId: 'v1_abc', source: youtube }, previous, true)).toThrow('leave out source');
    expect(parse({ prompt: 'Again' }, { ...previous, previousInteractionId: 'old' }, true).request.previousInteractionId).toBeNull();
  });

  it('maps a stored request onto engine options', () => {
    expect(providerOptions(parse({ prompt: 'x', source: youtube, processing: { mode: 'static', endSeconds: 30, fps: 0.5 }, mediaResolution: 'low', systemInstruction: 'Cite MM:SS.' }).request))
      .toEqual({ processing: 'static', endSeconds: 30, fps: 0.5, mediaResolution: 'low', systemInstruction: 'Cite MM:SS.' });
  });
});

describe('analysis response schema', () => {
  const schema = { type: 'object', properties: { shots: { type: 'array', items: { type: 'string' } } } };
  it('accepts a JSON Schema object, keeps it on re-runs and follow-ups, and clears it with null', () => {
    const previous = parse({ prompt: 'Shots', source: youtube, responseSchema: schema }).request;
    expect(previous.responseSchema).toEqual(schema);
    expect(providerOptions(previous)).toEqual({ responseSchema: schema });
    expect(parse({ prompt: 'Only the first?', previousInteractionId: 'v1_abc' }, previous, true).request.responseSchema).toEqual(schema);
    expect(parse({ prompt: 'Describe it', responseSchema: null }, previous, true).request.responseSchema).toBeNull();
    expect(parse({ prompt: 'x' }, { ...previous, responseSchema: undefined as never }, true).request.responseSchema).toBeNull();
  });

  it('rejects non-objects, oversized schemas and arrays inside arrays', () => {
    for (const responseSchema of [[], 'x', 3, true, { enum: [[1]] }, { description: 'x'.repeat(32_001) }]) {
      expect(() => parse({ prompt: 'x', source: youtube, responseSchema }), JSON.stringify(responseSchema).slice(0, 30)).toThrow('responseSchema');
    }
  });
});

describe('analysis narrate option', () => {
  const settings = readSettings(undefined);
  it('uses the narration validator, defaults and all, without the text or id', () => {
    expect(resolveAnalysisNarration(undefined, settings, true)).toBeNull();
    const defaults = resolveAnalysisNarration(true, settings, true)!;
    expect(defaults.request).not.toHaveProperty('markdown'); expect(defaults.request).not.toHaveProperty('id');
    expect(defaults.request.visibility).toBe('private'); expect(defaults.placement).toBeNull();
    const custom = resolveAnalysisNarration({ voice: 'Puck', playlist: 'Lectures' }, settings, true)!;
    expect(custom.request.voice).toBe('Puck'); expect(custom.placement).toEqual({ playlist: 'Lectures', position: 'end', create: false });
  });

  it('rejects text, ids, unknown fields and public narrations from API keys', () => {
    expect(() => resolveAnalysisNarration({ markdown: 'x' }, settings, false)).toThrow('narrate.markdown');
    expect(() => resolveAnalysisNarration({ id: 'abcdefghijk' }, settings, false)).toThrow('narrate.id');
    expect(() => resolveAnalysisNarration({ narrationPrompt: 'x' }, settings, false)).toThrow('Unknown field');
    expect(() => resolveAnalysisNarration({ visibility: 'public' }, settings, true)).toThrow('API keys create private narrations');
    expect(resolveAnalysisNarration({ visibility: 'public' }, settings, false)!.request.visibility).toBe('public');
    expect(() => resolveAnalysisNarration('yes', settings, false)).toThrow();
  });
});
