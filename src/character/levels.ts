import type { LevelRange, LineMeasure, ReferenceLevels } from '../cut/check.js';
import { median } from '../cut/prosody.js';
import type { CharacterReference, MeasuredLine, ReferenceMargins } from './character.js';

/**
 * A character's reference levels, from measured approved lines: each
 * measure's span over those lines, widened by a margin, so "too loud for
 * Hal" is a number. Pure.
 */

/**
 * How far past the approved lines a line may go before `cut check` flags it.
 * Loudness matches the continuity check's 2.5 LU step; pitch allows a few
 * semitones of ordinary variation either side of the approved medians; the
 * pitch range may be a little wider than the widest approved line; pace may
 * be 20 % quicker or slower than the quickest or slowest.
 */
export const DEFAULT_MARGINS: ReferenceMargins = { loudness: 2.5, pitch: 3, pitchRange: 3, rate: 0.2 };

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/** A line's measures as a character file records them. */
export function measuredLine(cut: string, m: LineMeasure): MeasuredLine {
  return {
    cut,
    line: m.id,
    text: m.text,
    loudness: m.loudness,
    pitch: m.pitch?.median ?? null,
    pitchRange: m.pitch?.range ?? null,
    rate: m.rate?.words ?? null,
  };
}

function span(values: number[]): { min: number; max: number } | null {
  return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The reference from these approved lines. `source` says where they came
 * from ("approved lines in Night Wagon Take 9"); it is quoted in every flag.
 */
export function referenceFromLines(
  lines: readonly MeasuredLine[],
  options: { margins?: Partial<ReferenceMargins>; source: string; method: string; measuredAt: string },
): CharacterReference {
  if (lines.length === 0) throw new Error('Reference levels need at least one approved line.');
  const margins: ReferenceMargins = { ...DEFAULT_MARGINS, ...options.margins };
  const of = (key: 'loudness' | 'pitch' | 'pitchRange' | 'rate') => lines.map((l) => l[key]).filter((v): v is number => v !== null);
  const levels: ReferenceLevels = { source: options.source };
  const loud = span(of('loudness'));
  if (loud) levels.loudness = { min: round(loud.min - margins.loudness, 1), max: round(loud.max + margins.loudness, 1) };
  const pitch = span(of('pitch'));
  const factor = 2 ** (margins.pitch / 12);
  if (pitch) levels.pitch = { min: round(pitch.min / factor, 1), max: round(pitch.max * factor, 1) };
  const pitchRange = span(of('pitchRange'));
  if (pitchRange) levels.pitchRange = { max: round(pitchRange.max + margins.pitchRange, 1) } satisfies LevelRange;
  const rate = span(of('rate'));
  if (rate) levels.rate = { min: round(rate.min * (1 - margins.rate), 2), max: round(rate.max * (1 + margins.rate), 2) };
  const typical = (key: 'loudness' | 'pitch' | 'pitchRange' | 'rate', places: number) => {
    const values = of(key);
    return values.length === 0 ? null : round(median(values), places);
  };
  return {
    levels,
    typical: { loudness: typical('loudness', 1), pitch: typical('pitch', 1), pitchRange: typical('pitchRange', 1), rate: typical('rate', 2) },
    margins,
    lines: [...lines],
    method: options.method,
    measuredAt: options.measuredAt,
  };
}

/** "-25.1 to -19.6 LUFS, 98–171 Hz, range up to 13.2 st, 2.1–3.4 words/s". */
export function describeLevels(levels: ReferenceLevels): string {
  const r = (x: LevelRange | undefined, unit: string, digits = 1) => {
    if (!x) return null;
    if (x.min !== undefined && x.max !== undefined) return `${x.min.toFixed(digits)} to ${x.max.toFixed(digits)}${unit}`;
    if (x.max !== undefined) return `up to ${x.max.toFixed(digits)}${unit}`;
    return x.min !== undefined ? `from ${x.min.toFixed(digits)}${unit}` : null;
  };
  return [
    r(levels.loudness, ' LUFS'),
    r(levels.pitch, ' Hz', 0),
    levels.pitchRange ? `pitch range ${r(levels.pitchRange, ' st')}` : null,
    r(levels.rate, ' words/s', 2),
  ].filter(Boolean).join(', ');
}
