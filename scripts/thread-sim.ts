#!/usr/bin/env bun
/**
 * Fills the two simulated review threads on Big Hal Take 5 the way Studio's
 * cut viewer would: resolve the cut with its words (as Studio's loader merges
 * them), anchor at the playhead, take a 4:3 still of the rendered take there,
 * and record the words heard around it.
 *
 *   bun scripts/thread-sim.ts
 *
 * Writes `<media root>/sim/productions/big-hal/threads/{t1-personally,t2-wheels}.json`
 * and their stills under `snapshots/`. The media root is `MDMEDIA_CUT_MEDIA_ROOT`,
 * else `~/.local/share/mdmedia/productions/crt-tv`. Running it again writes the same files.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, loadCutWithWords, sha256File, wordsFilePath } from '../src/cut/align.js';
import type { Timeline } from '../src/cut/types.js';
import { anchorItems, spokenLines } from '../src/threads/anchor.js';
import type { Anchor, Snapshot, SnapshotWord, Thread } from '../src/threads/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.resolve(process.env.MDMEDIA_CUT_MEDIA_ROOT ?? path.join(homedir(), '.local', 'share', 'mdmedia', 'productions', 'crt-tv'));
const PRODUCTION = 'big-hal';
const CUT_ID = 'big-hal-take5';
const PRODUCTION_DIR = path.join(MEDIA_ROOT, 'sim', 'productions', PRODUCTION);
/** A fixed time for the simulated comments, so the files are the same on every run. */
const SIM_TIME = '2026-10-19T12:00:00.000Z';
/** Seconds of words either side of the playhead. */
const WORD_WINDOW = 2;

interface ThreadSpec {
  id: string;
  time: number;
  range: (timeline: Timeline) => NonNullable<Anchor['range']>;
  text: string;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function segment(timeline: Timeline, id: string) {
  const found = timeline.segments.find((s) => s.id === id);
  if (!found) throw new Error(`${CUT_ID} has no segment ${id}`);
  return found;
}

function line(timeline: Timeline, id: string) {
  const found = timeline.lines.find((l) => l.id === id);
  if (!found) throw new Error(`${CUT_ID} has no line ${id}`);
  return found;
}

const THREADS: ThreadSpec[] = [
  {
    id: 't1-personally',
    time: 14.3,
    // The comment is about how the setup is split across shots, so the range is the two shots it is split across.
    range: (timeline) => {
      const inspect = segment(timeline, 'inspect');
      const pat = segment(timeline, 'pat');
      return {
        start: inspect.start,
        end: pat.end,
        why: 'The comment is about the setup "And every car on my lot is hand-inspected... by me! PERSONALLY!" being split across two shots, so the range is those two shots, from the cut into the medium by the hood (inspect) to the cut out of the hood-pat insert (pat). Shot boundaries rather than word times, because the note is about the picture and the "personally" words are unreliable (see missing).',
      };
    },
    text: 'When Al says "PERSONALLY" it is jarring and this splits the joke setup across disjointed screens. It\'s odd to see the zoomed up pat on the car hood. We have to have two clips due to the length but we need a way to better split across the two, like continuing the shot. Let\'s think of ways to reformulate this section so it works across to continuous clips.',
  },
  {
    id: 't2-wheels',
    time: 21.8,
    // The comment quotes the phrase it is about, so the range is that phrase's words.
    range: (timeline) => {
      const thisone = line(timeline, 'thisone');
      const wheels = line(timeline, 'wheels');
      const first = thisone.words.find((w) => w.text === 'This');
      const last = wheels.words.at(-1);
      if (!first || !last) throw new Error('missing words for thisone or wheels');
      return {
        start: first.start,
        end: last.end,
        why: 'The comment quotes the punchline "This one even comes with wheels." and is about how it is delivered across the cut, so the range is that phrase as spoken: from the start of the second "This" to the end of "Wheels!", taking in the pause and the cut from hood to finish inside it.',
      };
    },
    text: 'The joke, "This one even comes with wheels." is split across two clips and deflates the punchline because it sounds like "This one even comes with... <long-pause> ...WHEELS!" The punch line needs to be delivered like he\'s saying something totally normal even though it\'s not. "This one even comes with wheels!" That\'s what makes it funny.',
  },
];

/** The middle 4:3 of the picture, as the TV shows it. */
function tvCrop(timeline: Timeline): Snapshot['crop'] {
  const { width = 1280, height = 720 } = timeline.meta;
  const w = Math.round((height * 4) / 3);
  return { x: Math.round((width - w) / 2), y: 0, width: w, height };
}

function wordsAround(timeline: Timeline, at: number): SnapshotWord[] {
  const words: SnapshotWord[] = [];
  for (const { line: l } of spokenLines(timeline)) {
    for (const w of l.words) {
      if (w.end > at - WORD_WINDOW && w.start < at + WORD_WINDOW) words.push({ line: l.id, text: w.text, start: w.start, end: w.end });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

async function main(): Promise<void> {
  const cutPath = path.join(REPO, 'docs', 'cuts', `${CUT_ID}.cut.json`);
  const loaded = await loadCutWithWords(cutPath, { root: MEDIA_ROOT });
  if (loaded.merge.stale.length > 0) throw new Error(`stale words: ${loaded.merge.stale.map((s) => s.id).join(', ')}`);
  const { timeline } = loaded;
  if (!timeline.output) throw new Error(`${CUT_ID} has no output`);
  const render = path.relative(MEDIA_ROOT, timeline.output);
  const ffmpeg = await findFfmpeg();
  const version: Thread['version'] = {
    cutId: CUT_ID,
    cutSha256: await sha256File(cutPath),
    wordsSha256: loaded.hasWordsFile ? await sha256File(wordsFilePath(cutPath)) : null,
  };

  await mkdir(path.join(PRODUCTION_DIR, 'threads'), { recursive: true });
  await mkdir(path.join(PRODUCTION_DIR, 'snapshots'), { recursive: true });

  for (const spec of THREADS) {
    const range = spec.range(timeline);
    if (spec.time < range.start || spec.time > range.end) throw new Error(`${spec.id}: the range doesn't contain the playhead`);
    const crop = tvCrop(timeline);
    const frame = path.join('snapshots', `${spec.id}.png`);
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', timeline.output, '-ss', String(spec.time), '-frames:v', '1',
      '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, '-map_metadata', '-1', '-bitexact', path.join(PRODUCTION_DIR, frame),
    ]);
    const thread: Thread = {
      id: spec.id,
      production: PRODUCTION,
      version,
      anchor: { time: spec.time, range: { start: round(range.start), end: round(range.end), why: range.why }, items: anchorItems(timeline, spec.time) },
      snapshot: {
        at: spec.time,
        view: '4:3',
        frame,
        render,
        crop,
        overlays: timeline.overlays.filter((o) => spec.time >= o.start && spec.time < o.end).map((o) => o.id),
        window: WORD_WINDOW,
        words: wordsAround(timeline, spec.time),
      },
      text: spec.text,
      author: 'owner',
      status: 'open',
      createdAt: SIM_TIME,
      updatedAt: SIM_TIME,
    };
    const out = path.join(PRODUCTION_DIR, 'threads', `${spec.id}.json`);
    await writeFile(out, `${JSON.stringify(thread, null, 2)}\n`);
    console.log(`${spec.id}: ${thread.anchor.items.map((i) => `${i.kind}:${i.id}`).join(', ')} -> ${out}`);
  }
}

await main();
