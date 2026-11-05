import { describe, expect, it } from 'bun:test';
import { parseArgs } from 'citty';
import { videoCommand, videoOutputOptions } from '../../src/cli/command.js';
import { DocumentVideoPipeline } from '../../src/pipeline/document-video-pipeline.js';
import type { GenerateVideoOptions, IVideoProvider } from '../../src/video/video-provider.interface.js';

/**
 * Videos stayed in Studio only because the plain `mdmedia video` had no way to
 * ask for a clip's length or resolution. It takes the same flags as
 * `mdmedia studio video` now.
 */
describe('mdmedia video --duration and --resolution', () => {
  it('reads both flags from the command line', () => {
    const args = parseArgs(['--input', 'shots.md', '--duration', '6', '--resolution', '1080p'], videoCommand.args as never) as Record<string, unknown>;
    expect(videoOutputOptions(args.duration as string, args.resolution as string)).toEqual({ durationSeconds: 6, resolution: '1080p' });
  });

  it('accepts 3 to 10 whole seconds and every Omni resolution', () => {
    expect(videoOutputOptions('3', '360p')).toEqual({ durationSeconds: 3, resolution: '360p' });
    expect(videoOutputOptions('10', '4k')).toEqual({ durationSeconds: 10, resolution: '4k' });
    expect(videoOutputOptions('8', '720p')).toEqual({ durationSeconds: 8, resolution: '720p' });
  });

  it('leaves the provider defaults alone when neither flag is given', () => {
    expect(videoOutputOptions(undefined, undefined)).toEqual({});
    expect(videoOutputOptions('4', undefined)).toEqual({ durationSeconds: 4 });
  });

  it('refuses lengths and resolutions Omni cannot make before any paid call', () => {
    expect(() => videoOutputOptions('2', undefined)).toThrow('--duration');
    expect(() => videoOutputOptions('11', undefined)).toThrow('--duration');
    expect(() => videoOutputOptions('4.5', undefined)).toThrow('--duration');
    expect(() => videoOutputOptions(undefined, '2160p')).toThrow('--resolution');
  });

  it('sends them on every scene of a storyboard', async () => {
    const seen: GenerateVideoOptions[] = [];
    const provider: IVideoProvider = {
      async generateVideoClip(_prompt, options = {}) {
        seen.push(options);
        return { interactionId: `i${seen.length}`, videoBytes: new Uint8Array([1]) };
      },
    };
    const scenes = [1, 2].map((index) => ({ index, prompt: `Shot ${index}`, referenceImages: [] }));
    await new DocumentVideoPipeline(provider).processScenes(scenes as never, { durationSeconds: 6, resolution: '1080p' });
    expect(seen.map((o) => [o.durationSeconds, o.resolution])).toEqual([[6, '1080p'], [6, '1080p']]);
  });
});
