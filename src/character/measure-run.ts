import path from 'node:path';
import { MEASURE_METHOD, measureCut, type LineMeasure } from '../cut/check.js';
import { loadCutForCheck, renderDialogue } from '../cut/check-run.js';
import { findRepoRoot } from '../production/manifest.js';
import type { MeasuredLine } from './character.js';
import { measuredLine } from './levels.js';

/**
 * Measures named approved lines for a character's reference levels: each
 * cut's dialogue is rendered and measured exactly as `mdmedia cut check`
 * does it, and the named lines' loudness, pitch and pace are kept.
 */

/** `docs/cuts/big-hal-take7.cut.json#howdy,thisone`: a cut and some of its line ids. */
export interface LineSelection {
  cut: string;
  lines: string[];
}

export function parseLineSelection(text: string): LineSelection {
  const hash = text.lastIndexOf('#');
  if (hash <= 0 || hash === text.length - 1) throw new Error(`"${text}" should be a cut file and its line ids, like docs/cuts/big-hal-take7.cut.json#howdy,thisone`);
  const lines = text.slice(hash + 1).split(',').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`"${text}" names no lines.`);
  return { cut: text.slice(0, hash), lines };
}

export interface MeasuredSelection {
  lines: MeasuredLine[];
  /** Lines whose speaker isn't the character's name (a warning, not an error: a role can differ from a name). */
  otherSpeakers: Array<{ cut: string; line: string; speaker: string }>;
  /** Lines measured without word timings (no rate; loudness and pitch over the whole line). */
  untimed: Array<{ cut: string; line: string }>;
}

export async function measureLines(selections: readonly LineSelection[], options: { name: string; root?: string; ffmpeg?: string; onStep?: (message: string) => void }): Promise<MeasuredSelection> {
  const out: MeasuredSelection = { lines: [], otherSpeakers: [], untimed: [] };
  const byCut = new Map<string, Set<string>>();
  for (const s of selections) {
    const cut = path.resolve(s.cut);
    const set = byCut.get(cut) ?? new Set<string>();
    for (const l of s.lines) set.add(l);
    byCut.set(cut, set);
  }
  for (const [cut, wanted] of byCut) {
    options.onStep?.(`measuring ${[...wanted].join(', ')} in ${path.basename(cut)}`);
    const loaded = await loadCutForCheck(cut, { root: options.root, ffmpeg: options.ffmpeg });
    const pcm = await renderDialogue(loaded, { ffmpeg: options.ffmpeg });
    const measured = measureCut(loaded.timeline, { audio: { samples: pcm.samples, sampleRate: pcm.sampleRate }, start: pcm.start });
    const byId = new Map<string, LineMeasure>(measured.lines.map((m) => [m.id, m]));
    const missing = [...wanted].filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`${cut} has no spoken line ${missing.map((m) => `"${m}"`).join(', ')}.`);
    const ref = path.relative(findRepoRoot(path.dirname(cut)), cut).split(path.sep).join('/');
    for (const id of wanted) {
      const m = byId.get(id)!;
      out.lines.push(measuredLine(ref, m));
      if (m.speaker !== options.name) out.otherSpeakers.push({ cut: ref, line: id, speaker: m.speaker });
      if (m.timedBy === 'line') out.untimed.push({ cut: ref, line: id });
    }
  }
  return out;
}

export { MEASURE_METHOD };
