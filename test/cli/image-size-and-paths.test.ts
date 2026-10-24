import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { parseArgs } from 'citty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  imageCommand,
  imageGenerationConfig,
  inferImageOutputMimeType,
  readReferenceImage,
  runImageGeneration,
} from '../../src/cli/command.js';
import { resolveStoryboardPaths } from '../../src/cli/runner.js';
import { DEFAULT_IMAGE_CONFIG, resolveConfig } from '../../src/config/index.js';
import { DEFAULT_IMAGE_MODEL, IMAGE_ASPECT_RATIOS, type ImageInput } from '../../src/image/index.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-cli-image-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('image --size and aspect ratios', () => {
  it('leaves the size to the model unless asked', () => {
    expect(imageGenerationConfig('3:2')).toEqual({ aspectRatio: '3:2' });
    expect(imageGenerationConfig('3:2', '')).toEqual({ aspectRatio: '3:2' });
    expect(imageGenerationConfig('3:2', '  ')).toEqual({ aspectRatio: '3:2' });
  });

  it('accepts 0.5K, 1K, 2K and 4K, in either case', () => {
    expect(imageGenerationConfig('16:9', '0.5k')).toEqual({ aspectRatio: '16:9', imageSize: '0.5K' });
    expect(imageGenerationConfig('16:9', '4K')).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
    expect(imageGenerationConfig('1:1', '2k')).toEqual({ aspectRatio: '1:1', imageSize: '2K' });
    expect(imageGenerationConfig('4:3', ' 1k ')).toEqual({ aspectRatio: '4:3', imageSize: '1K' });
  });

  it('supports all 14 aspect ratios including extended ratios', () => {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      expect(imageGenerationConfig(ratio)).toEqual({ aspectRatio: ratio });
    }
  });

  it('defaults aspectRatio to 16:9 for standalone text-to-image and null when ref or interactionId is present', () => {
    expect(imageGenerationConfig(undefined, '2k')).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
    expect(imageGenerationConfig(undefined, '2k', { hasReference: true })).toEqual({
      aspectRatio: null,
      imageSize: '2K',
    });
    expect(imageGenerationConfig(undefined, undefined, { hasInteractionId: true })).toEqual({
      aspectRatio: null,
    });
    expect(imageGenerationConfig('4:5', undefined, { hasReference: true })).toEqual({
      aspectRatio: '4:5',
    });
  });

  it('parses --size, -s, --image-size, --imageSize, and --resolution CLI flags into args.size', () => {
    const argsDef = imageCommand.args as Record<string, any>;
    for (const flag of ['--size', '-s', '--image-size', '--imageSize', '--resolution']) {
      const parsed = parseArgs([flag, '4k', '-o', 'out.png'], argsDef);
      expect(parsed.size).toBe('4k');
      expect(imageGenerationConfig(parsed.aspectRatio as string | undefined, parsed.size as string)).toEqual({
        aspectRatio: '16:9',
        imageSize: '4K',
      });
    }
  });

  it('rejects unsupported sizes and aspect ratios before any request is made', () => {
    expect(() => imageGenerationConfig('16:9', '8K')).toThrow('--size must be 0.5K, 1K, 2K or 4K');
    expect(() => imageGenerationConfig('7:3', '1K')).toThrow('--aspect must be one of');
  });
});

describe('image CLI flags, config defaults, references, adaptation, and output', () => {
  let logs: string[] = [];
  let logSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('resolves DEFAULT_IMAGE_CONFIG and .mdmedia.json image settings', () => {
    expect(DEFAULT_IMAGE_CONFIG).toEqual({ model: DEFAULT_IMAGE_MODEL });
    const defaults = resolveConfig({}, {});
    expect(defaults.image).toEqual({ model: 'gemini-nano-banana-2.1' });

    const configured = resolveConfig(
      {},
      {
        mode: 'image',
        image: {
          model: 'gemini-3.1-flash-image',
          aspectRatio: '1:4',
          resolution: '2K',
          thinkingLevel: 'high',
          adapt: true,
          instructions: 'Minimalist line art',
          search: true,
          imageSearch: true,
        },
      },
    );
    expect(configured.mode).toBe('image');
    expect(configured.image).toEqual({
      model: 'gemini-3.1-flash-image',
      aspectRatio: '1:4',
      resolution: '2K',
      thinkingLevel: 'high',
      adapt: true,
      instructions: 'Minimalist line art',
      search: true,
      imageSearch: true,
    });
  });

  it('parses all new imageCommand flags', () => {
    const argsDef = imageCommand.args as Record<string, any>;
    const parsed = parseArgs(
      [
        '-p',
        'A lighthouse',
        '-o',
        'out.jpg',
        '--interactionId',
        'int_prev',
        '--search',
        '--imageSearch',
        '--thinking',
        'medium',
        '--video',
        'https://youtu.be/dQw4w9WgXcQ',
        '--adapt',
        '--instructions',
        'Oil painting',
      ],
      argsDef,
    );
    expect(parsed.interactionId).toBe('int_prev');
    expect(parsed.search).toBe(true);
    expect(parsed.imageSearch).toBe(true);
    expect(parsed.thinking).toBe('medium');
    expect(parsed.video).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(parsed.adapt).toBe(true);
    expect(parsed.instructions).toBe('Oil painting');
  });

  it('infers output mimeType from extension and reads comma-separated references', async () => {
    expect(inferImageOutputMimeType('photo.jpg')).toBe('image/jpeg');
    expect(inferImageOutputMimeType('photo.JPEG')).toBe('image/jpeg');
    expect(inferImageOutputMimeType('diagram.png')).toBe('image/png');

    const dir = makeTempDir();
    const ref1 = path.join(dir, 'one.png');
    const ref2 = path.join(dir, 'two.jpg');
    fs.writeFileSync(ref1, new Uint8Array([1, 2, 3]));
    fs.writeFileSync(ref2, new Uint8Array([4, 5]));
    expect(readReferenceImage(ref1)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    });

    const outPath = path.join(dir, 'result.jpg');
    let capturedPayload: any;
    const client = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            id: 'int_123',
            output_image: {
              data: Buffer.from([9, 8, 7]).toString('base64'),
              mime_type: 'image/jpeg',
            },
          };
        },
      },
      models: {
        generateContent: async () => ({ text: 'Adapted visual brief' }),
      } as any,
    };

    await runImageGeneration(
      {
        prompt: '# Notes',
        ref: `${ref1}, ${ref2}`,
        output: outPath,
        instructions: 'Warm sunset lighting',
        search: true,
        imageSearch: true,
        thinking: 'high',
        video: 'https://example.com/clip.mp4',
      },
      { cwd: dir, client },
    );

    expect(capturedPayload.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(capturedPayload.response_format).toEqual({
      type: 'image',
      mime_type: 'image/jpeg',
    });
    expect(capturedPayload.generation_config).toEqual({ thinking_level: 'high' });
    expect(capturedPayload.tools).toEqual([
      { type: 'google_search', search_types: ['web_search', 'image_search'] },
    ]);
    expect(capturedPayload.input[0]).toEqual({ type: 'text', text: 'Adapted visual brief' });
    expect(capturedPayload.input).toHaveLength(4); // text + 2 images + 1 video
    expect([...fs.readFileSync(outPath)]).toEqual([9, 8, 7]);
    expect(logs).toContain(`Saved image to ${outPath}`);
    expect(logs).toContain('Interaction ID: int_123');
  });

  it('applies .mdmedia.json image defaults when CLI flags are omitted', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, '.mdmedia.json'),
      JSON.stringify({
        image: {
          model: 'gemini-3.1-flash-image',
          aspectRatio: '1:4',
          resolution: '0.5k',
          thinkingLevel: 'minimal',
          search: true,
        },
      }),
    );
    const outPath = path.join(dir, 'banner.png');
    let capturedPayload: any;
    const client = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            output_image: {
              data: Buffer.from([1, 2]).toString('base64'),
              mime_type: 'image/png',
            },
          };
        },
      },
    };

    await runImageGeneration(
      {
        prompt: 'A tall banner',
        output: outPath,
      },
      { cwd: dir, client },
    );

    expect(capturedPayload.model).toBe('gemini-3.1-flash-image');
    expect(capturedPayload.response_format).toEqual({
      type: 'image',
      aspect_ratio: '1:4',
      image_size: '512',
    });
    expect(capturedPayload.generation_config).toEqual({ thinking_level: 'minimal' });
    expect(capturedPayload.tools).toEqual([{ type: 'google_search' }]);
  });

  it('passes previousInteractionId and omits aspect_ratio when --interactionId is provided without --aspect', async () => {
    const dir = makeTempDir();
    const outPath = path.join(dir, 'edited.png');
    let capturedPayload: any;
    const client = {
      interactions: {
        create: async (payload: any) => {
          capturedPayload = payload;
          return {
            id: 'int_456',
            output_image: {
              data: Buffer.from([3, 4]).toString('base64'),
              mime_type: 'image/png',
            },
          };
        },
      },
    };

    await runImageGeneration(
      {
        prompt: 'Make it night time',
        interactionId: 'int_123',
        output: outPath,
      },
      { cwd: dir, client },
    );

    expect(capturedPayload.previous_interaction_id).toBe('int_123');
    expect(capturedPayload.response_format).toEqual({
      type: 'image',
    });
  });
});

describe('storyboard image paths', () => {
  it('resolves relative paths against the storyboard, not the working directory', () => {
    const [scene] = resolveStoryboardPaths(
      [{ firstFrame: './start.png', referenceImages: ['refs/hero.jpg', '/abs/style.jpg'] }],
      'projects/walk/storyboard.md'
    );
    const base = path.resolve('projects/walk');
    expect(scene.firstFrame).toBe(path.join(base, 'start.png'));
    expect(scene.referenceImages).toEqual([path.join(base, 'refs/hero.jpg'), '/abs/style.jpg']);
  });

  it('leaves a scene without images alone', () => {
    const [scene] = resolveStoryboardPaths([{ referenceImages: [] }], 'a/b.md');
    expect(scene.firstFrame).toBeUndefined();
    expect(scene.referenceImages).toEqual([]);
  });
});
