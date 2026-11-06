import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeOptions, readResponseSchema, videoSources } from '../../src/cli/analyze-command.js';
import { resolveSmartCliArgv } from '../../src/cli/command.js';

describe('mdmedia analyze flags', () => {
  it('splits --video into files and YouTube links', () => {
    expect(videoSources('a.mp4, https://youtu.be/abc')).toEqual([
      { kind: 'path', path: 'a.mp4' },
      { kind: 'youtube', url: 'https://youtu.be/abc' },
    ]);
    expect(videoSources(undefined)).toEqual([]);
    expect(() => videoSources('https://example.com/v.mp4')).toThrow('--video links must be YouTube');
    expect(() => videoSources(Array(11).fill('a.mp4').join(','))).toThrow('at most 10 videos');
  });

  it('turns flags into provider options and rejects bad values up front', () => {
    expect(analyzeOptions({ processing: 'STATIC', start: '20m', end: '25:00', fps: '0.5', mediaResolution: 'low', system: 'Be brief.', followUp: 'int_1' }, 'gemini-3.8-flash')).toEqual({
      model: 'gemini-3.8-flash', processing: 'static', startSeconds: 1200, endSeconds: 1500, fps: 0.5, mediaResolution: 'low', systemInstruction: 'Be brief.', previousInteractionId: 'int_1',
    });
    expect(() => analyzeOptions({ processing: 'smart' }, 'm')).toThrow('--processing must be one of static, agentic');
    expect(() => analyzeOptions({ mediaResolution: 'max' }, 'm')).toThrow('--media-resolution must be one of');
    expect(() => analyzeOptions({ start: 'later' }, 'm')).toThrow('--start must be');
  });

  it('reads --schema as a JSON Schema object and rejects anything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-schema-'));
    try {
      fs.writeFileSync(path.join(dir, 'ok.json'), '{"type":"object"}');
      fs.writeFileSync(path.join(dir, 'list.json'), '[1]');
      fs.writeFileSync(path.join(dir, 'bad.json'), 'type: object');
      expect(await readResponseSchema(path.join(dir, 'ok.json'))).toEqual({ type: 'object' });
      expect(await readResponseSchema(undefined)).toBeUndefined();
      await expect(readResponseSchema(path.join(dir, 'list.json'))).rejects.toThrow('must hold a JSON Schema object');
      await expect(readResponseSchema(path.join(dir, 'bad.json'))).rejects.toThrow('is not valid JSON');
      await expect(readResponseSchema(path.join(dir, 'missing.json'))).rejects.toThrow('cannot read');
      await expect(readResponseSchema(' ')).rejects.toThrow('needs a JSON Schema file');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a named subcommand, so extension routing leaves it alone', () => {
    expect(resolveSmartCliArgv(['analyze', '-v', 'a.mp4', '-o', 'notes.md'])).toEqual(['analyze', '-v', 'a.mp4', '-o', 'notes.md']);
  });
});
