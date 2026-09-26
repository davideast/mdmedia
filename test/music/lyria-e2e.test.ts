/**
 * E2E Test Harness: Lyria Music Generation — Pixel Art Game Songs
 *
 * Runs 10 real Lyria API calls with pixel-art game-music prompts.
 * Each prompt generates a 30-second clip via lyria-3-clip-preview.
 * Generated MP3 files are written to test/music/e2e-output/ for manual inspection.
 *
 * Run:   MUSIC_E2E=1 bun test test/music/lyria-e2e.test.ts
 * Skip:  bun test (skipped by default to avoid API costs in CI)
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { GoogleGenAI } from '@google/genai';
import { LyriaMusicProvider } from '../../src/music/lyria-music-provider.js';
import { DocumentMusicPipeline } from '../../src/pipeline/document-music-pipeline.js';
import { UniversalEventBus } from '../../src/pipeline/pipeline-event-bus.js';
import { NodeMusicFileWriter } from '../../src/music/music-file-writer.js';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const SKIP = !process.env.MUSIC_E2E;
const OUTPUT_DIR = resolve(import.meta.dir, 'e2e-output');

const PIXEL_ART_PROMPTS = [
  {
    name: '01-overworld-theme',
    prompt: 'A cheerful 8-bit chiptune overworld theme for a pixel art RPG. Major key, bouncy tempo around 130 BPM, featuring square wave melody over arpeggiated triangle wave bass. Instrumental only, no vocals.',
  },
  {
    name: '02-dungeon-crawl',
    prompt: 'A dark and mysterious dungeon exploration theme for a retro pixel art roguelike. Minor key, slow tempo around 80 BPM, eerie pulse wave arpeggios with reverb-heavy triangle wave pads. Instrumental only, no vocals.',
  },
  {
    name: '03-boss-battle',
    prompt: 'An intense boss battle theme for a 16-bit pixel art action game. Fast tempo around 160 BPM, aggressive saw wave leads, driving percussion with snare rolls, dramatic key changes. Instrumental only, no vocals.',
  },
  {
    name: '04-village-morning',
    prompt: 'A peaceful village morning theme for a pixel art farming simulator. Gentle acoustic guitar melody with soft flute and light tambourine, 100 BPM, warm and nostalgic feeling. Instrumental only, no vocals.',
  },
  {
    name: '05-space-shooter',
    prompt: 'A high-energy synthwave space shooter theme for a pixel art arcade shmup. 140 BPM, pulsing bass synth, rapid-fire arpeggiated leads, electronic drums with lots of fills. Instrumental only, no vocals.',
  },
  {
    name: '06-puzzle-game',
    prompt: 'A catchy and upbeat puzzle game theme for a pixel art Tetris-like game. Playful marimba melody with chiptune accompaniment, 120 BPM, major key, loopable and non-fatiguing. Instrumental only, no vocals.',
  },
  {
    name: '07-credits-roll',
    prompt: 'A bittersweet credits roll theme for a pixel art adventure game. Piano-led arrangement building to full orchestra, 90 BPM, starts gentle and swells to a triumphant finale. Instrumental only, no vocals.',
  },
  {
    name: '08-haunted-forest',
    prompt: 'A spooky haunted forest theme for a pixel art platformer. Music-box melody in a minor key with detuned chiptune harmonics, creepy ambient wind samples, 70 BPM. Instrumental only, no vocals.',
  },
  {
    name: '09-racing-game',
    prompt: 'A fast and exciting racing game theme for a pixel art top-down racer. Funk-inspired bassline with wah guitar, punchy drums at 150 BPM, energetic brass stabs. Instrumental only, no vocals.',
  },
  {
    name: '10-title-screen',
    prompt: 'A grand and memorable title screen theme for a pixel art JRPG. Orchestral strings with choir pads opening into a soaring trumpet melody, 110 BPM, heroic and epic. Instrumental only, no vocals.',
  },
];

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  fileSizeKb?: number;
  hasLyrics?: boolean;
  mimeType?: string;
  error?: string;
}

const results: TestResult[] = [];

describe.skipIf(SKIP)('Lyria E2E: Pixel Art Game Songs', () => {
  let provider: LyriaMusicProvider;
  let fileWriter: NodeMusicFileWriter;

  beforeAll(async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not found in .env');

    const client = new GoogleGenAI({ apiKey });
    // Use clip model for faster 30s generations
    provider = new LyriaMusicProvider(client, 2, 'lyria-3-clip-preview');
    fileWriter = new NodeMusicFileWriter();

    // Clean and recreate output directory
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
  });

  afterAll(() => {
    // Print summary table
    console.log('\n' + '='.repeat(80));
    console.log('  LYRIA E2E RESULTS: Pixel Art Game Songs');
    console.log('='.repeat(80));
    console.log(
      '  #  | Status | Size (KB) | Lyrics | Duration (s) | Name'
    );
    console.log('-'.repeat(80));
    for (const r of results) {
      const sizeStr = r.fileSizeKb ? r.fileSizeKb.toFixed(1).padStart(9) : '      N/A';
      const lyricsStr = r.hasLyrics ? '   yes' : '    no';
      const durStr = (r.durationMs / 1000).toFixed(1).padStart(12);
      const statusStr = r.status === 'pass' ? ' ✅  ' : r.status === 'fail' ? ' ❌  ' : ' ⏭️  ';
      console.log(
        `  ${statusStr} | ${sizeStr} | ${lyricsStr} | ${durStr} | ${r.name}`
      );
    }
    console.log('='.repeat(80));
    const passed = results.filter((r) => r.status === 'pass').length;
    const failed = results.filter((r) => r.status === 'fail').length;
    console.log(`  Total: ${passed} passed, ${failed} failed out of ${results.length}`);
    console.log(`  Output: ${OUTPUT_DIR}`);
    console.log('='.repeat(80) + '\n');
  });

  for (const { name, prompt } of PIXEL_ART_PROMPTS) {
    it(
      `generates ${name}`,
      async () => {
        const start = performance.now();
        try {
          const eventBus = new UniversalEventBus();
          const pipeline = new DocumentMusicPipeline(provider, eventBus);

          const result = await pipeline.generate(prompt);
          const elapsed = performance.now() - start;

          // Write file
          const ext = result.mimeType?.includes('wav') ? 'wav' : 'mp3';
          const outPath = resolve(OUTPUT_DIR, `${name}.${ext}`);
          await fileWriter.writeMusicFile(outPath, result.audioBytes);

          const fileSizeKb = result.audioBytes.byteLength / 1024;

          results.push({
            name,
            status: 'pass',
            durationMs: elapsed,
            fileSizeKb,
            hasLyrics: !!result.lyrics,
            mimeType: result.mimeType,
          });

          // Assertions
          expect(result.audioBytes.byteLength).toBeGreaterThan(1024); // At least 1KB
          expect(result.interactionId).toBeTruthy();
          expect(result.mimeType).toBeTruthy();
        } catch (err: any) {
          const elapsed = performance.now() - start;
          results.push({
            name,
            status: 'fail',
            durationMs: elapsed,
            error: err.message || String(err),
          });
          throw err;
        }
      },
      { timeout: 120_000 } // 2 minutes per generation
    );
  }
});
