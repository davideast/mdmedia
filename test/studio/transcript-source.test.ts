import { describe, it, expect } from 'bun:test';
import {
  resolveTranscriptSource,
  buildHighlightedMarkdownBlocks,
} from '../../src/studio/highlight-renderer.js';
import type { ChunkTiming } from '../../src/storage/types.js';

const ORIGINAL = `## Deploying

Run \`npm run build\` then upload the \`dist/\` folder to the CDN.

The cache TTL is 3600s.`;

const ADAPTED = `Deploying.

Run the build script, then upload the dist folder to the C D N.

The cache time to live is thirty six hundred seconds.`;

function timingsFor(text: string): ChunkTiming[] {
  const paras = text.split('\n\n').filter((p) => p.trim());
  let t = 0;
  return paras.map((p, i) => {
    const dur = Math.max(400, p.length * 55);
    const timing: ChunkTiming = { chunkIndex: i, startMs: t, endMs: t + dur, text: p.trim() };
    t += dur;
    return timing;
  });
}

/** Fraction of sampled playhead positions that yield a highlighted word. */
function highlightCoverage(renderText: string, timings: ChunkTiming[]): number {
  const totalMs = timings[timings.length - 1]!.endMs;
  const samples = 60;
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const pos = Math.floor((i / samples) * totalMs);
    const active = buildHighlightedMarkdownBlocks(renderText, timings, pos).find((b) => b.isActive);
    if (active?.activeWord?.trim()) hits++;
  }
  return hits / samples;
}

describe('resolveTranscriptSource (regression: highlights vanish with narration adapter)', () => {
  const adaptedTimings = timingsFor(ADAPTED);

  it('pairs adapted timings with the adapted transcript, not the original markdown', () => {
    const turn = { markdown: ORIGINAL, track: undefined };
    const track = { transcript: ADAPTED, chunkTimings: adaptedTimings };

    const { text, chunkTimings } = resolveTranscriptSource(turn, track);

    expect(text).toBe(ADAPTED);
    expect(text).not.toBe(ORIGINAL);
    expect(chunkTimings).toBe(adaptedTimings);
  });

  it('measurably restores highlight coverage', () => {
    const correct = highlightCoverage(ADAPTED, adaptedTimings);
    const buggy = highlightCoverage(ORIGINAL, adaptedTimings);

    // The old pane rendered ORIGINAL against adapted timings and lost ~half the highlights.
    expect(buggy).toBeLessThan(0.75);
    expect(correct).toBeGreaterThan(0.95);

    const resolved = resolveTranscriptSource({ markdown: ORIGINAL }, {
      transcript: ADAPTED,
      chunkTimings: adaptedTimings,
    });
    expect(highlightCoverage(resolved.text, resolved.chunkTimings)).toBe(correct);
  });

  it('reads timings off the turn track when the selected track has none', () => {
    const turnTimings = timingsFor(ADAPTED);
    const turn = { markdown: ORIGINAL, track: { transcript: ADAPTED, chunkTimings: turnTimings } };
    const track = { transcript: 'unrelated', chunkTimings: [] };

    const { text, chunkTimings } = resolveTranscriptSource(turn, track);
    expect(chunkTimings).toBe(turnTimings);
    expect(text).toBe(ADAPTED);
  });

  it('prefers the selected track when both have timings', () => {
    const selected = timingsFor(ADAPTED);
    const turn = { markdown: ORIGINAL, track: { transcript: 'turn text', chunkTimings: timingsFor(ORIGINAL) } };
    const track = { transcript: 'selected text', chunkTimings: selected };

    const { text, chunkTimings } = resolveTranscriptSource(turn, track);
    expect(chunkTimings).toBe(selected);
    expect(text).toBe('selected text');
  });

  it('falls back to turn markdown when a timed track predates transcript storage', () => {
    const timings = timingsFor(ORIGINAL);
    const turn = { markdown: ORIGINAL, track: { chunkTimings: timings } };

    const { text, chunkTimings } = resolveTranscriptSource(turn, null);
    expect(text).toBe(ORIGINAL);
    expect(chunkTimings).toBe(timings);
  });

  it('shows the human-readable markdown when there are no timings at all', () => {
    expect(resolveTranscriptSource({ markdown: ORIGINAL }, null)).toEqual({
      text: ORIGINAL,
      chunkTimings: [],
    });
    expect(resolveTranscriptSource(null, { transcript: ADAPTED })).toEqual({
      text: ADAPTED,
      chunkTimings: [],
    });
  });

  it('returns empty state for empty input rather than throwing', () => {
    expect(resolveTranscriptSource(null, null)).toEqual({ text: '', chunkTimings: [] });
    expect(resolveTranscriptSource(undefined, undefined)).toEqual({ text: '', chunkTimings: [] });
  });
});
