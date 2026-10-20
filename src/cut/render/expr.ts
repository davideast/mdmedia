import type { Blink, ResolvedKey, ResolvedWave } from '../types.js';

/**
 * ffmpeg expression and option text for the render plan. Pure string
 * building: every function here takes times already in the clock of the
 * filter that evaluates them (`t` from 0 at the stream's start).
 */

/** A number for an ffmpeg option or expression: at most six decimals, no exponent, no trailing zeros. */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

/** Keys moved by `offset` seconds (a timeline key at `offset` lands at 0). */
export function shiftKeys(keys: readonly ResolvedKey[], offset: number): ResolvedKey[] {
  return keys.map((k) => ({ t: k.t - offset, value: k.value }));
}

/** `a + (b − a)·(v − ta)/(tb − ta)`, simplified when the value doesn't change. */
function lerp(a: ResolvedKey, b: ResolvedKey, v: string): string {
  if (a.value === b.value) return num(a.value);
  const delta = b.value - a.value;
  const at = a.t < 0 ? `+${num(-a.t)}` : `-${num(a.t)}`;
  return `${num(a.value)}${delta < 0 ? '-' : '+'}${num(Math.abs(delta))}*(${v}${at})/${num(b.t - a.t)}`;
}

/**
 * Keyframes as an expression in `v`, with `keyValueAt`'s semantics: linear
 * between keys, held before the first and after the last, and at a jump (two
 * keys at one time) the later key's value from that instant.
 */
export function keysExpr(keys: readonly ResolvedKey[], v = 't'): string {
  if (keys.length === 0) return '1';
  const last = keys[keys.length - 1];
  let expr = num(last.value);
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1];
    const b = keys[i];
    // Two keys at one time are a jump: nothing lies between them.
    if (b.t === a.t) continue;
    const between = lerp(a, b, v);
    if (between === expr) continue;
    expr = `if(lt(${v},${num(b.t)}),${between},${expr})`;
  }
  const first = num(keys[0].value);
  return expr === first ? expr : `if(lt(${v},${num(keys[0].t)}),${first},${expr})`;
}

/** A number as an operand: negative values in brackets, so `a*(-2)` never reads as `a*-2`. */
export function operand(value: number): string {
  return value < 0 ? `(${num(value)})` : num(value);
}

/** True when every key has the same value. */
export function isConstant(keys: readonly ResolvedKey[]): boolean {
  return keys.every((k) => k.value === keys[0]?.value);
}

/**
 * True when the keys only ever jump: every change of value happens between
 * two keys at the same time, so the value is a step function.
 */
export function isStepwise(keys: readonly ResolvedKey[]): boolean {
  for (let i = 1; i < keys.length; i++) if (keys[i].t !== keys[i - 1].t && keys[i].value !== keys[i - 1].value) return false;
  return true;
}

/** A wave in `t`, its timeline origin moved to `origin` (the time the filter's `t` is 0 at). */
export function waveExpr(wave: ResolvedWave, clockStart: number): string {
  const shift = wave.origin - clockStart + wave.phase;
  const angle = `2*PI*(t${shift === 0 ? '' : shift > 0 ? `-${num(shift)}` : `+${num(-shift)}`})/${num(wave.period)}`;
  return `${num(wave.center)}+${operand(wave.amplitude)}*${wave.shape === 'cos' ? 'cos' : 'sin'}(${angle})`;
}

/** Whether an overlay is drawn: from `start` through `end`, both included, and on in its blink. Times in the filter's clock. */
export function shownExpr(start: number, end: number, blink: Blink | null): string {
  const between = `between(t,${num(start)},${num(end)})`;
  if (!blink) return between;
  return `${between}*lt(mod(t-${num(start)},${num(blink.period)}),${num(blink.on)})`;
}

/**
 * Whether an overlay is drawn, by frame: on frames `first` through `last`
 * (`framesIn`), so a time rounded to the microsecond still lands on its frame,
 * and on in its blink, counted from `start` (seconds). Frame k is at `t = k / fps`.
 */
export function shownFramesExpr(first: number, last: number, fps: number, start: number, blink: Blink | null): string {
  const between = `between(t*${num(fps)},${num(first - 0.5)},${num(last + 0.5)})`;
  if (!blink) return between;
  return `${between}*lt(mod(t-${num(start)},${num(blink.period)}),${num(blink.on)})`;
}

/** Quotes an expression for a filter option, so its commas and colons stay inside it. */
export function quote(expr: string): string {
  return `'${expr}'`;
}
