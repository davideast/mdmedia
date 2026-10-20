import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCutJson, type Timeline } from '../../src/cut/index';
import { imageTypeOf } from '../../src/production/probe';
import { stillThumbPlan, thumbFilters } from '../../src/production/thumbs';

function timelineOf(name: string): Timeline {
  const json: unknown = JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}.cut.json`, import.meta.url), 'utf8'));
  const result = resolveCutJson(json);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function segmentOf(timeline: Timeline, id: string) {
  const segment = timeline.segments.find((s) => s.id === id);
  if (!segment) throw new Error(`no ${id}`);
  return segment;
}

describe('typing an image by its bytes', () => {
  it('reads PNG, JPEG and WebP from their first bytes, whatever the name says', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'image-type-'));
    try {
      const png = path.join(dir, 'a.png');
      const jpegAsPng = path.join(dir, 'k-stadium.png');
      const webp = path.join(dir, 'c.webp');
      const text = path.join(dir, 'd.png');
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
      writeFileSync(jpegAsPng, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]));
      writeFileSync(webp, Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP')]));
      writeFileSync(text, 'not an image');
      expect(await imageTypeOf(png)).toBe('image/png');
      expect(await imageTypeOf(jpegAsPng)).toBe('image/jpeg');
      expect(await imageTypeOf(webp)).toBe('image/webp');
      expect(await imageTypeOf(text)).toBeNull();
      expect(await imageTypeOf(path.join(dir, 'missing.png'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('still segment thumbnails', () => {
  it('draw a countdown still as it ends: its digits drawn in, then its push-in', () => {
    const timeline = timelineOf('rigg-take5');
    const root = timeline.output?.replace(/\/takes\/rigg-take5\.mp4$/, '');
    const c0030 = segmentOf(timeline, 'c0030');
    const plan = stillThumbPlan(timeline, c0030);
    // Its last frame, 0.8 s in less one frame.
    expect(plan.at).toBeCloseTo(c0030.end - 1 / 24, 6);
    expect(plan.inputs).toEqual([`${root}/rigg5/d0030.png`]);
    // The digits are drawn into the still, before its zoom (1 + 0.05 · 0.758 / 0.8 = 1.0474 by then, about the middle).
    expect(plan.graph).toBe(
      '[0:v]scale=1280:720,setsar=1,format=rgba[p0];[1:v]format=rgba[g1];[p0][g1]overlay=x=0:y=0[p1];' +
        '[p1]scale=1340.667:754.125,crop=1280:720:30.333:17.062[z];[z]crop=960:720,scale=240:180,format=yuvj420p[thumb]',
    );
  });

  it('draw a bumper still with the layers over the finished picture that are up on its last frame', () => {
    const timeline = timelineOf('football-take1');
    const bump = stillThumbPlan(timeline, segmentOf(timeline, 'bump'));
    expect(bump.inputs.map((f) => f.split('/').pop())).toEqual(['g-bumper-stripes.png', 'g-bumper-cgl.png', 'g-bumper-football.png']);
    // The keys card shows all three keys by its end; the outro's layers are cut off with the cut but up on its last frame.
    const card = stillThumbPlan(timeline, segmentOf(timeline, 'card'));
    expect(card.inputs.map((f) => f.split('/').pop())).toEqual(['g-keys-1.png', 'g-keys-2.png', 'g-keys-3.png']);
    const outro = stillThumbPlan(timeline, segmentOf(timeline, 'outro'));
    expect(outro.inputs).toHaveLength(3);
    // Shots keep their one-input recipe.
    expect(thumbFilters(timeline, segmentOf(timeline, 'stad'))).toEqual(['scale=1280:720', 'crop=960:720', 'scale=240:180']);
  });
});
