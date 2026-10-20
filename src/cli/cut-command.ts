import path from 'node:path';
import { defineCommand } from 'citty';
import { alignCutWords, type LineReport } from '../cut/align.js';
import type { Aligner } from '../cut/words.js';
import { ElevenLabsAligner } from '../elevenlabs/forced-alignment.js';
import { cutCheckCommand } from './cut-check-command.js';
import { cutMediaRootArg } from './cut-root.js';
import { cutRenderCommand } from './cut-render-command.js';
import { cutStoryboardCommand } from './cut-storyboard-command.js';

/** Aligner names `--aligner` accepts. The first is the default. */
export const ALIGNERS = ['elevenlabs'] as const;
export type AlignerName = (typeof ALIGNERS)[number];

export function createAligner(name: string, env: Record<string, string | undefined> = process.env): Aligner {
  if (name === 'elevenlabs') return ElevenLabsAligner.fromEnv(env);
  throw new Error(`--aligner must be one of ${ALIGNERS.join(', ')} (got "${name}").`);
}

export { cutMediaRootArg } from './cut-root.js';

function seconds(value: number): string {
  return value.toFixed(2);
}

/** The per-line table and its warnings, as printed by `mdmedia cut words`. */
export function formatLineReports(lines: readonly LineReport[]): string {
  const rows = [
    ['id', 'speaker', 'speech (s)', 'loss', 'status'],
    ...lines.map((l) => [
      l.id,
      l.speaker,
      l.speech ? `${seconds(l.speech.start)}–${seconds(l.speech.end)}` : '–',
      l.loss === null ? '–' : l.loss.toFixed(3),
      // A sung line's words are approximate: its first word isn't snapped and its loss isn't judged.
      l.approximate ? `${l.status}, approximate (sung)` : l.status,
    ]),
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
  const table = rows.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd());
  const notes: string[] = [];
  for (const l of lines) {
    if (l.status === 'stale') notes.push(`${l.id}: no words: ${l.reason ?? 'unknown reason'}`);
    for (const warning of l.warnings) notes.push(`${l.id}: ${warning}`);
  }
  return [...table, ...(notes.length > 0 ? ['', ...notes.map((n) => `warning: ${n}`)] : [])].join('\n');
}

const wordsCommand = defineCommand({
  meta: {
    name: 'words',
    description: "Time every dialogue line's words by forced alignment, into <name>.words.json next to the cut",
  },
  args: {
    cut: { type: 'positional', required: true, description: 'Path to a <name>.cut.json file' },
    force: { type: 'boolean', default: false, description: 'Realign every line, even ones whose words still match' },
    root: { type: 'string', description: "Media root (default MDMEDIA_CUT_MEDIA_ROOT, else the cut's media.root)" },
    aligner: { type: 'string', default: ALIGNERS[0], description: `Aligner to use: ${ALIGNERS.join(', ')}` },
  },
  async run({ args }) {
    try {
      const aligner = createAligner(args.aligner);
      const result = await alignCutWords({
        cutPath: path.resolve(args.cut),
        aligner,
        root: cutMediaRootArg(args.root),
        force: args.force,
      });
      console.log(formatLineReports(result.lines));
      const shown = path.relative(process.cwd(), result.wordsPath) || result.wordsPath;
      console.log(result.written ? `\nWrote ${shown}` : `\n${shown} is up to date`);
      if (result.lines.some((l) => l.status === 'stale')) process.exitCode = 1;
    } catch (error) {
      console.error(`mdmedia cut words: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});

export const cutCommand = defineCommand({
  meta: { name: 'cut', description: 'Work with cut files (edits written as data)' },
  subCommands: { words: wordsCommand, render: cutRenderCommand, check: cutCheckCommand, storyboard: cutStoryboardCommand },
});
