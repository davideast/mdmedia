import type { ResolvedAudio, ResolvedKey, ResolvedMotionKey, ResolvedOverlay, ResolvedSegment, ResolvedWave } from './types.js';

/**
 * A keyframed value at time `t`: linear between keys, held before the first
 * and after the last. Two keys at the same time are a jump, and at that
 * instant the value is the later key's.
 */
export function keyValueAt(keys: ResolvedKey[], t: number): number {
  if (keys.length === 0) return 1;
  if (t < keys[0].t) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t < b.t) return b.t === a.t ? b.value : a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
  }
  return keys[keys.length - 1].value;
}

/** A wave's value at timeline time `t`: `center + amplitude · sin(2π(u − phase) / period)` (or cos), `u` from its origin. */
export function waveAt(wave: ResolvedWave, t: number): number {
  const angle = (2 * Math.PI * (t - wave.origin - wave.phase)) / wave.period;
  return wave.center + wave.amplitude * (wave.shape === 'cos' ? Math.cos(angle) : Math.sin(angle));
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

/**
 * An overlay's top-left position at time `t`: a wave on its axis, else its
 * motion keys. An overlay in a segment is placed in the segment's picture,
 * before the segment's zoom (see `zoomAt`).
 */
export function positionAt(overlay: ResolvedOverlay, t: number): { x: number; y: number } {
  const keys: ResolvedMotionKey[] = overlay.motion;
  const { wave } = overlay;
  return {
    x: wave.x ? waveAt(wave.x, t) : keyValueAt(keys.map((k) => ({ t: k.t, value: k.x })), t),
    y: wave.y ? waveAt(wave.y, t) : keyValueAt(keys.map((k) => ({ t: k.t, value: k.y })), t),
  };
}

/**
 * An overlay's opacity at time `t`: 0 outside it or in a blink's off phase,
 * else its opacity keys times its fades.
 */
export function opacityAt(overlay: ResolvedOverlay, t: number): number {
  if (t < overlay.start || t > overlay.end) return 0;
  if (overlay.blink) {
    const phase = (t - overlay.start) % overlay.blink.period;
    if (phase >= overlay.blink.on) return 0;
  }
  return keyValueAt(overlay.opacity, t) * fadeAt(overlay.start, overlay.end, overlay.fadeIn, overlay.fadeOut, t);
}

/**
 * A segment's zoom at time `t`: the picture's scale and the point that stays
 * fixed on screen (output pixels of the picture as framed). Without a zoom the
 * scale is 1 and there is no focus. A picture point `p` lands on screen at
 * `focus + (p − focus) · scale`.
 */
export function zoomAt(segment: ResolvedSegment, t: number): { scale: number; focus: { x: number; y: number } | null } {
  if (!segment.zoom) return { scale: 1, focus: null };
  return { scale: keyValueAt(segment.zoom.keys, t), focus: segment.zoom.focus };
}
