import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractWindow } from '../../src/cut/align.js';
import { toSourceClock } from '../../src/cut/words.js';
import { ElevenLabsAligner } from '../../src/elevenlabs/forced-alignment.js';

/**
 * Calls ElevenLabs for real. Runs only with MDMEDIA_LIVE_ALIGNMENT=1, a key in
 * ELEVENLABS_API_KEY (or ELEVEN_LABS_KEY), and the Night Wagon media at
 * MDMEDIA_CUT_MEDIA_ROOT, else at the cut file's own `media.root`. Without the
 * media it is skipped.
 */
const live = process.env.MDMEDIA_LIVE_ALIGNMENT === '1';
const cutFile = new URL('../../docs/cuts/night-wagon-take9.cut.json', import.meta.url);
const root = process.env.MDMEDIA_CUT_MEDIA_ROOT || (JSON.parse(readFileSync(cutFile, 'utf8')) as { media: { root: string } }).media.root;
const take = path.join(root, 'takes/nw7-rick-lines-t1.mp4');

describe.skipIf(!live || !existsSync(take))('ElevenLabs forced alignment, live', () => {
  it("times Rick's noisy on-camera line to the speech measured from loudness (0.65–1.58 s)", async () => {
    const window = { start: 0.45, end: 1.75 };
    const audio = await extractWindow(take, window.start, window.end);
    expect(audio.sampleRate).toBe(16000);
    const alignment = await ElevenLabsAligner.fromEnv().align(audio, "They're getting away, Buddy.");
    const words = toSourceClock(alignment, window);
    expect(words.map((w) => w.text)).toEqual(["They're", 'getting', 'away,', 'Buddy.']);
    expect(Math.abs(words[0].start - 0.65)).toBeLessThan(0.05);
    expect(Math.abs(words[words.length - 1].end - 1.58)).toBeLessThan(0.05);
    expect(alignment.loss).toBeLessThan(0.9);
  }, 60_000);
});
