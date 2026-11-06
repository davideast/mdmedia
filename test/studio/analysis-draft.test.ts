import { describe, expect, it } from 'bun:test';
import { DEFAULT_ANALYSIS_DRAFT, analysisBody, normalizeAnalysisMarkdown, parseTimestamp, readAnalysisDraft, splitTimestamps } from '../../studio/src/lib/analysis-draft';
import { WorkspaceStore, workspaceRoute } from '../../studio/src/lib/workspace';
import { workspaceItems } from '../../studio/src/lib/workspace-navigation';

const youtube = { kind: 'youtube' as const, url: 'https://youtu.be/9hE5-98ZeCg' };
const draft = (patch: Partial<typeof DEFAULT_ANALYSIS_DRAFT> = {}) => ({ ...DEFAULT_ANALYSIS_DRAFT, prompt: 'Shot list', source: youtube, ...patch });

describe('analysis answer timestamps', () => {
  it('turns MM:SS and H:MM:SS into seek targets and leaves other numbers alone', () => {
    expect(splitTimestamps('At 0:05 and 12:34, then 1:02:03.')).toEqual(['At ', { label: '0:05', seconds: 5 }, ' and ', { label: '12:34', seconds: 754 }, ', then ', { label: '1:02:03', seconds: 3723 }, '.']);
    expect(splitTimestamps('**00:01**')).toEqual(['**', { label: '00:01', seconds: 1 }, '**']);
    expect(splitTimestamps('video: - 00:02: The grid')).toEqual(['video: - ', { label: '00:02', seconds: 2 }, ': The grid']);
    for (const text of ['ratio 112:34', '1:23:45:67', 'version 1.2:30', 'at 5:60', 'plain text', 'v10:1']) expect(splitTimestamps(text)).toEqual([text]);
    expect(splitTimestamps('')).toEqual([]);
  });

  it('parses typed times', () => {
    expect(parseTimestamp('90')).toBe(90); expect(parseTimestamp('1:30')).toBe(90); expect(parseTimestamp(' 1:02:03 ')).toBe(3723); expect(parseTimestamp('2.5')).toBe(2.5);
    for (const bad of ['', '1:5', '1:60', 'soon', '-3', '1:61:00']) expect(parseTimestamp(bad)).toBeNull();
  });

  it('repairs collapsed single-line Markdown lists and headings while leaving prose and code untouched', () => {
    const collapsed = 'Here is a bulleted list of key moments from the video: - 00:00: An intricate vintage-style diagram illustrates a mechanical data pipeline. - 00:02: The schematic transforms into a futuristic 3D grid. - 00:04: A cluster of metallic gears turns smoothly. - 00:06: The camera highlights a digital filing cabinet.';
    expect(normalizeAnalysisMarkdown(collapsed)).toBe([
      'Here is a bulleted list of key moments from the video:',
      '',
      '- 00:00: An intricate vintage-style diagram illustrates a mechanical data pipeline.',
      '- 00:02: The schematic transforms into a futuristic 3D grid.',
      '- 00:04: A cluster of metallic gears turns smoothly.',
      '- 00:06: The camera highlights a digital filing cabinet.',
    ].join('\n'));
    expect(normalizeAnalysisMarkdown('- 00:00: First cut. - 00:03: Second cut.')).toBe('- 00:00: First cut.\n- 00:03: Second cut.');
    expect(normalizeAnalysisMarkdown('Steps: 1. 00:00: Open panel. 2. 00:04: Run build.')).toBe('Steps:\n\n1. 00:00: Open panel.\n2. 00:04: Run build.');
    expect(normalizeAnalysisMarkdown('Overview complete. ## Key moments')).toBe('Overview complete.\n\n## Key moments');
    const clean = '# Key moments\n\nThe pipeline runs from 00:00 - 00:08 - fast and calm - with `video: - 00:00: First. - 00:02: Second.` intact.\n\n```yaml\nitems: - 00:00: First. - 00:02: Second.\n```';
    expect(normalizeAnalysisMarkdown(clean)).toBe(clean);
  });
});

describe('analysis composer request body', () => {
  it('sends only what was set, so Studio defaults fill the rest', () => {
    expect(analysisBody(draft())).toEqual({ prompt: 'Shot list', source: youtube });
    expect(analysisBody(draft({ source: { kind: 'video', videoItemId: 'v1', generationId: null, clip: null } })).source).toEqual({ kind: 'video', videoItemId: 'v1' });
    expect(analysisBody(draft({ source: { kind: 'video', videoItemId: 'v1', generationId: 'g1', clip: 2 } })).source).toEqual({ kind: 'video', videoItemId: 'v1', generationId: 'g1', clip: 2 });
    expect(analysisBody(draft({ model: ' gemini-3.6-flash ', mediaResolution: 'high', systemInstruction: 'Cite MM:SS.', start: '1:30', end: '2:00', fps: '0.5' }))).toEqual({
      prompt: 'Shot list', source: youtube, model: 'gemini-3.6-flash', mediaResolution: 'high', systemInstruction: 'Cite MM:SS.', processing: { mode: 'static', startSeconds: 90, endSeconds: 120, fps: 0.5 },
    });
  });

  it('long video mode sends agentic processing and drops the clip range and frame rate', () => {
    expect(analysisBody(draft({ longVideo: true, start: '1:00', end: '2:00', fps: '2' })).processing).toEqual({ mode: 'agentic' });
    expect(analysisBody(draft({ longVideo: true, start: 'nonsense' })).processing).toEqual({ mode: 'agentic' });
  });

  it('narrates with the Studio voice, a chosen voice, or not at all', () => {
    expect(analysisBody(draft()).narrate).toBeUndefined();
    expect(analysisBody(draft({ narrate: false, voice: { provider: 'gemini', id: 'Puck', name: 'Puck' } })).narrate).toBeUndefined();
    expect(analysisBody(draft({ narrate: true })).narrate).toBe(true);
    expect(analysisBody(draft({ narrate: true, voice: { provider: 'elevenlabs', id: 'abcdefghijklmnopqrst', name: 'Rae' } })).narrate).toEqual({ voice: { provider: 'elevenlabs', id: 'abcdefghijklmnopqrst' } });
  });

  it('rejects a bad range before anything is sent', () => {
    expect(() => analysisBody(draft({ start: 'soon' }))).toThrow('Start must be a time');
    expect(() => analysisBody(draft({ start: '2:00', end: '1:00' }))).toThrow('End must be after start');
    expect(() => analysisBody(draft({ fps: '0' }))).toThrow('Frame rate');
  });
});

describe('analysis drafts', () => {
  it('read saved drafts defensively', () => {
    expect(readAnalysisDraft({ kind: 'video' })).toBeNull();
    expect(readAnalysisDraft({ kind: 'analysis', prompt: 4, source: { kind: 'video', videoItemId: '../x' }, mediaResolution: 'huge', voice: { provider: 'other' } })).toEqual(DEFAULT_ANALYSIS_DRAFT);
    expect(readAnalysisDraft({ ...draft({ narrate: true, longVideo: true }), extra: 1 })).toEqual(draft({ narrate: true, longVideo: true }));
  });

  it('persist across windows and appear in Drafts with the analysis type', () => {
    expect(workspaceRoute('/studio/analysis?draft=abc')).toMatchObject({ key: '/studio/analysis:abc', draftId: 'abc', title: 'Analysis draft' });
    expect(workspaceRoute('/analysis/item1')).toMatchObject({ key: '/analysis/item1', title: 'Analysis' });
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = new WorkspaceStore('owner'); first.initialize(storage, '/studio/analysis?draft=abc');
    first.setAnalysisDraft('abc', draft({ prompt: '# Shot list\nWith MM:SS', sourceLabel: 'Train' })); first.flush();
    const second = new WorkspaceStore('owner'); second.initialize(storage, '/library');
    expect(second.getSnapshot().analysisDrafts?.abc).toMatchObject({ prompt: '# Shot list\nWith MM:SS', source: youtube, sourceLabel: 'Train' });
    expect(workspaceItems(second.getSnapshot()).find(item => item.draftId === 'abc')).toMatchObject({ type: 'analysis', title: 'Shot list', href: '/studio/analysis?draft=abc' });
    second.clearAnalysisDraft('abc'); second.flush(); first.reconcile(); expect(first.getSnapshot().analysisDrafts?.abc).toBeUndefined();
    first.dispose(); second.dispose();
  });
});
