import type {
  ResolvedAudio,
  ResolvedBedPart,
  ResolvedFades,
  ResolvedKey,
  ResolvedLayer,
  ResolvedLine,
  ResolvedMotionKey,
  ResolvedOverlay,
  ResolvedSegment,
  ResolvedWave,
} from './types.js';

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

/**
 * The linear fade multiplier at time `t`: rising from `fadeInStart` over
 * `fadeIn`, and falling to 0 at `fadeOutEnd` over `fadeOut`. Silent before an
 * anchored fade in starts and after a fade out ends.
 */
export function fadeAt(fades: ResolvedFades, t: number): number {
  let gain = 1;
  if (fades.fadeIn > 0 && t < fades.fadeInStart + fades.fadeIn) gain *= Math.max(0, (t - fades.fadeInStart) / fades.fadeIn);
  if (fades.fadeOut > 0 && t > fades.fadeOutEnd - fades.fadeOut) gain *= Math.max(0, (fades.fadeOutEnd - t) / fades.fadeOut);
  return gain;
}

/** The gain a segment's mix fades put on a layer of it at `t`: 0 outside the segment. */
export function layerGainAt(layer: ResolvedLayer | null, t: number): number {
  if (!layer) return 1;
  if (t < layer.start || t >= layer.end) return 0;
  return fadeAt({ fadeIn: layer.fadeIn, fadeOut: layer.fadeOut, fadeInStart: layer.start, fadeOutEnd: layer.end }, t);
}

/**
 * An audio clip's gain at time `t` on the timeline: its volume keys times its
 * fades (and its segment's mix fades when it is a layer of one), 0 outside it.
 * A clip heard in a segment's own sound adds none, so its gain is 0; for a
 * bed, this is the whole bed's gain, over its parts' crossfades (`bedPartGainAt`).
 */
export function gainAt(clip: ResolvedAudio, t: number): number {
  if (clip.segment !== null || t < clip.start || t >= clip.end) return 0;
  return keyValueAt(clip.volume, t) * fadeAt(clip, t) * layerGainAt(clip.layer, t);
}

/** A bed part's crossfade gain at `t`, 0 outside it; multiply by the bed's `gainAt`. */
export function bedPartGainAt(part: ResolvedBedPart, t: number): number {
  if (t < part.start || t >= part.end) return 0;
  return fadeAt(part, t);
}

/** The gain of a line's own sound at `t`: its volume, fades and layer; 0 for a line heard in other sound, and outside it. */
export function lineGainAt(line: ResolvedLine, t: number): number {
  if (line.audio.kind !== 'file' || t < line.start || t >= line.end) return 0;
  return line.audio.volume * fadeAt(line.audio, t) * layerGainAt(line.audio.layer, t);
}

/** The gain of a segment's own audio at `t`: its volume and fades, times the segment's mix fades; 0 outside it. */
export function segmentGainAt(segment: ResolvedSegment, t: number): number {
  const audio = segment.audio;
  if (!audio || t < audio.start || t >= audio.end) return 0;
  const own = fadeAt({ fadeIn: audio.fadeIn, fadeOut: audio.fadeOut, fadeInStart: audio.start, fadeOutEnd: audio.end }, t);
  const mix = { segment: segment.id, start: segment.start, end: segment.end, fadeIn: segment.mix.fadeIn, fadeOut: segment.mix.fadeOut };
  return audio.volume * own * layerGainAt(mix, t);
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
 * Whether an overlay is drawn at time `t`: from its start through its end,
 * both included (an overlay until 14.0 s is on the frame at 14.0 s), and not
 * in a blink's off phase. Its alpha may still be 0 there (`opacityAt`).
 */
export function overlayShownAt(overlay: ResolvedOverlay, t: number): boolean {
  if (t < overlay.start || t > overlay.end) return false;
  return !overlay.blink || (t - overlay.start) % overlay.blink.period < overlay.blink.on;
}

/**
 * An overlay's opacity at time `t`: 0 where it isn't shown (`overlayShownAt`),
 * else its opacity keys times its fades.
 */
export function opacityAt(overlay: ResolvedOverlay, t: number): number {
  if (!overlayShownAt(overlay, t)) return 0;
  return keyValueAt(overlay.opacity, t) * fadeAt({ fadeIn: overlay.fadeIn, fadeOut: overlay.fadeOut, fadeInStart: overlay.start, fadeOutEnd: overlay.fadeOutEnd }, t);
}

/**
 * The frames from `start` through `end`, both included, at `fps`: frame k is
 * at k / fps, so an overlay from 11.5 s until 14.0 s is on frames 276 to 336.
 * Null when no frame falls inside.
 */
export function framesIn(start: number, end: number, fps: number): { first: number; last: number } | null {
  // Times are rounded to the microsecond, so a frame time like 5.166667 (frame 124 at 24 fps) is that frame.
  const first = Math.ceil((start - 1e-6) * fps);
  const last = Math.floor((end + 1e-6) * fps);
  return last >= first ? { first, last } : null;
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
