import type { ResolvedAudio, ResolvedKey, ResolvedMotionKey, ResolvedOverlay } from './types.js';

/** A keyframed value at time `t`: linear between keys, held before the first and after the last. */
export function keyValueAt(keys: ResolvedKey[], t: number): number {
  if (keys.length === 0) return 1;
  if (t <= keys[0].t) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t < b.t) return b.t === a.t ? b.value : a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
  }
  return keys[keys.length - 1].value;
}

/** The linear fade multiplier for an item at time `t`. */
function fadeAt(start: number, end: number, fadeIn: number, fadeOut: number, t: number): number {
  let gain = 1;
  if (fadeIn > 0 && t < start + fadeIn) gain *= Math.max(0, (t - start) / fadeIn);
  if (fadeOut > 0 && t > end - fadeOut) gain *= Math.max(0, (end - t) / fadeOut);
  return gain;
}

/** An audio clip's gain at time `t` on the timeline: its volume keys times its fades, 0 outside it. */
export function gainAt(clip: ResolvedAudio, t: number): number {
  if (t < clip.start || t >= clip.end) return 0;
  return keyValueAt(clip.volume, t) * fadeAt(clip.start, clip.end, clip.fadeIn, clip.fadeOut, t);
}

/** An overlay's top-left position at time `t`. */
export function positionAt(overlay: ResolvedOverlay, t: number): { x: number; y: number } {
  const keys: ResolvedMotionKey[] = overlay.motion;
  return {
    x: keyValueAt(keys.map((k) => ({ t: k.t, value: k.x })), t),
    y: keyValueAt(keys.map((k) => ({ t: k.t, value: k.y })), t),
  };
}

/** An overlay's opacity at time `t`: 0 outside it or in a blink's off phase, faded at its ends. */
export function opacityAt(overlay: ResolvedOverlay, t: number): number {
  if (t < overlay.start || t > overlay.end) return 0;
  if (overlay.blink) {
    const phase = (t - overlay.start) % overlay.blink.period;
    if (phase >= overlay.blink.on) return 0;
  }
  return fadeAt(overlay.start, overlay.end, overlay.fadeIn, overlay.fadeOut, t);
}
