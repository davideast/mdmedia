import path from 'node:path';
import { defineCommand } from 'citty';
import type { CheckFile, ListeningResult } from '../cut/check.js';
import { checkCut, type CutCheckResult } from '../cut/check-run.js';
import { GeminiListener } from '../cut/listen-gemini.js';
import type { Listener } from '../cut/listen.js';
import { castOfCut, castReference, describeCast } from '../character/cast.js';
import { cutMediaRootArg } from './cut-root.js';

/** `mdmedia cut check`: performance continuity, measured and (with --listen) listened to. See docs/cut-check.md. */

/** Listener names `--listener` accepts. The first is the default. */
export const LISTENERS = ['gemini'] as const;

export function createListener(name: string, env: Record<string, string | undefined> = process.env): Listener {
  if (name === 'gemini') return GeminiListener.fromEnv(env);
  throw new Error(`--listener must be one of ${LISTENERS.join(', ')} (got "${name}").`);
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => (row[c] ?? '').length)));
  return rows.map((row) => row.map((cell, c) => (cell ?? '').padEnd(widths[c])).join('  ').trimEnd());
}

function signed(value: number | null, digits = 1, unit = ''): string {
  if (value === null) return '–';
  const text = value.toFixed(digits);
  return `${value > 0 ? '+' : ''}${text}${unit}`;
}

function fixed(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '–' : value.toFixed(digits);
}

function short(text: string, max = 46): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The measured part of a check, as tables: every line, then each performance's boundaries and cuts, then the flags. */
export function formatMeasured(file: CheckFile): string[] {
  const m = file.measured;
  const out: string[] = [`Measured, from ${m.source} (${m.method}).`, ''];
  out.push(
    ...table([
      ['line', 'speaker', 'speech (s)', 'LUFS', 'pitch Hz', 'range st', 'words/s'],
      ...m.lines.map((l) => [
        l.id,
        l.speaker,
        `${l.speech.start.toFixed(2)}–${l.speech.end.toFixed(2)}${l.timedBy === 'line' ? '*' : ''}`,
        fixed(l.loudness),
        l.pitch ? l.pitch.median.toFixed(0) : '–',
        l.pitch ? l.pitch.range.toFixed(1) : '–',
        l.rate ? l.rate.words.toFixed(2) : '–',
      ]),
    ]),
  );
  if (m.lines.some((l) => l.timedBy === 'line')) out.push('* no word timings: the whole line was measured');
  if (m.performances.length === 0) {
    out.push('', 'No performances: add a "performances" list to the cut to check continuity across its lines.');
    return out;
  }
  out.push('');
  const rows: string[][] = [['performance', 'boundary or cut', 'pause s', 'Δ LU', 'Δ pitch st', 'Δ rate', 'room tone dB', 'flags']];
  for (const p of m.performances) {
    let first = true;
    const name = (): string => {
      const n = first ? p.id : '';
      first = false;
      return n;
    };
    if (p.boundaries.length === 0 && p.cuts.length === 0) rows.push([name(), '(one line)', '', '', '', '', '', String(p.flags.length || '')]);
    for (const b of p.boundaries) {
      rows.push([
        name(),
        `${b.from} → ${b.to}${b.between.length > 0 ? ` (across ${b.between.join(', ')})` : ''}`,
        fixed(b.pause, 2),
        signed(b.loudness),
        signed(b.pitch),
        b.rate === null ? '–' : `${b.rate > 0 ? '+' : ''}${Math.round(b.rate * 100)} %`,
        '',
        String(b.flags.length || ''),
      ]);
    }
    for (const c of p.cuts) {
      rows.push([
        name(),
        `cut ${c.from} → ${c.to} at ${c.at.toFixed(2)}`,
        '', '', '', '',
        `${fixed(c.before)} → ${fixed(c.after)} (${signed(c.change)})${c.wide ? ' wide' : ''}`,
        String(c.flags.length || ''),
      ]);
    }
  }
  out.push(...table(rows));
  const flags = m.performances.flatMap((p) => p.flags.map((f) => `${p.id}: ${f.message}`));
  const lineFlags = m.lines.flatMap((l) => l.flags.filter((f) => f.code !== 'unmeasured').map((f) => f.message));
  out.push('');
  if (flags.length + lineFlags.length === 0) out.push('No flags.');
  else out.push(...[...flags, ...lineFlags].map((f) => `flag: ${f}`));
  return out;
}

/** The listening part: each answer against what it should be. Marked filter only: it never approves a take. */
export function formatListening(listening: Record<string, ListeningResult>, status: CutCheckResult['listening'] = {}): string[] {
  const ids = Object.keys(status).length > 0 ? Object.keys(status) : Object.keys(listening);
  if (ids.length === 0) return [];
  const results = Object.values(listening);
  const by = [...new Set(results.map((r) => r.listener))].join(', ');
  const out: string[] = ['', `Listening check (filter only: it catches obvious failures, it is not the judge)${by ? `, by ${by}` : ''}.`, ''];
  const rows: string[][] = [['performance', 'question', 'expect', 'verdict', 'conf.', 'result']];
  const notes: string[] = [];
  for (const id of ids) {
    const r = listening[id];
    const s = status[id];
    if (!r) {
      rows.push([id, s?.status === 'stale' ? `(dropped: ${s.reason ?? 'stale'})` : s?.reason ? `(not heard: ${s.reason})` : '(not heard; run with --listen)', '', '', '', '']);
      continue;
    }
    let first = true;
    for (const a of r.answers) {
      rows.push([
        first ? `${id}${s?.status === 'fresh' ? ' (kept)' : ''}` : '',
        short(a.id.slice(id.length + 1).replaceAll('.', ' ')),
        a.expect,
        short(a.verdict, 32),
        a.confidence.toFixed(2),
        a.agrees ? 'ok' : a.reading === 'unclear' ? 'unclear' : 'FAILS',
      ]);
      first = false;
    }
    if (!r.canHearAudio) notes.push(`${id}: the listener said it couldn't hear the sound, so its answers mean little`);
    for (const a of r.answers.filter((x) => !x.agrees)) notes.push(`${id} ${a.id.slice(id.length + 1)}: heard ${JSON.stringify(short(a.heard, 160))}; ${short(a.why, 200)}`);
  }
  out.push(...table(rows));
  if (notes.length > 0) out.push('', ...notes.map((n) => `note: ${n}`));
  return out;
}

export function formatCheckReport(result: Pick<CutCheckResult, 'file' | 'listening' | 'staleWords' | 'hasWordsFile'>): string {
  const out = formatMeasured(result.file);
  out.push(...formatListening(result.file.listening, result.listening));
  const warnings: string[] = [];
  if (!result.hasWordsFile) warnings.push('the cut has no words file, so lines were measured whole, without rates or pauses (run mdmedia cut words)');
  for (const s of result.staleWords) warnings.push(`${s.id}: its stored words are stale (${s.reason}), so it was measured whole`);
  if (warnings.length > 0) out.push('', ...warnings.map((w) => `warning: ${w}`));
  return out.join('\n');
}

export const cutCheckCommand = defineCommand({
  meta: {
    name: 'check',
    description: "Measure performance continuity (loudness, pitch, pace, pauses, room tone) and, with --listen, run the listening check; writes <name>.check.json",
  },
  args: {
    cut: { type: 'positional', required: true, description: 'Path to a <name>.cut.json file' },
    listen: { type: 'boolean', default: false, description: 'Also run the listening check on performances whose result is missing or stale (slow; a filter, not the judge)' },
    force: { type: 'boolean', default: false, description: 'With --listen, listen again to every performance' },
    json: { type: 'boolean', default: false, description: 'Print the check as JSON instead of tables' },
    root: { type: 'string', description: "Media root (default MDMEDIA_CUT_MEDIA_ROOT, else the cut's media.root)" },
    listener: { type: 'string', default: LISTENERS[0], description: `Listener for --listen: ${LISTENERS.join(', ')}` },
    production: { type: 'string', description: "The production manifest whose cast gives each speaker's reference levels (default: the one in docs/productions that lists this cut)" },
    cast: { type: 'boolean', default: true, description: "Hold each speaker to their character's reference levels (--no-cast to skip)" },
  },
  async run({ args }) {
    try {
      const listener = args.listen ? createListener(args.listener) : undefined;
      const cast = args.cast ? await castOfCut(path.resolve(args.cut), { production: args.production }) : null;
      const result = await checkCut({
        cutPath: path.resolve(args.cut),
        reference: cast ? castReference(cast.members) : undefined,
        root: cutMediaRootArg(args.root),
        listen: args.listen,
        listener,
        force: args.force,
        onStep: process.stderr.isTTY && !args.json ? (m) => process.stderr.write(`${m}\n`) : undefined,
      });
      if (args.json) {
        console.log(JSON.stringify({ ...result.file, status: { listening: result.listening, staleWords: result.staleWords, cast: cast ? describeCast(cast) : [] } }, null, 2));
      } else {
        if (cast) console.log(`Cast, from ${path.relative(process.cwd(), cast.manifest) || cast.manifest}: ${describeCast(cast).join('; ')}.\n`);
        console.log(formatCheckReport(result));
        const relative = path.relative(process.cwd(), result.checkPath);
        const shown = relative && !relative.startsWith('..') ? relative : result.checkPath;
        console.log(result.written ? `\nWrote ${shown}` : `\n${shown} is up to date`);
      }
    } catch (error) {
      console.error(`mdmedia cut check: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});
