import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { imageGenerationConfig } from '../../src/cli/command.js';
import { resolveStoryboardPaths } from '../../src/cli/runner.js';

describe('image --size', () => {
  it('leaves the size to the model unless asked', () => {
    expect(imageGenerationConfig('3:2')).toEqual({ aspectRatio: '3:2' });
    expect(imageGenerationConfig('3:2', '')).toEqual({ aspectRatio: '3:2' });
  });

  it('accepts 1K, 2K and 4K, in either case', () => {
    expect(imageGenerationConfig('16:9', '4K')).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
    expect(imageGenerationConfig('1:1', '2k')).toEqual({ aspectRatio: '1:1', imageSize: '2K' });
  });

  it('rejects other sizes before any request is made', () => {
    expect(() => imageGenerationConfig('16:9', '8K')).toThrow('--size must be 1K, 2K or 4K');
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
