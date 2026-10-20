import type { CutFile, SourceRef } from './types.js';

/**
 * Every source a cut plays, as written, in file order (repeats included):
 * each segment's picture and sound, each line with its own sound, each music
 * and sfx clip's file and every part of a bed, and each overlay. Synths and
 * sound heard in a segment have none. With `provenance`, the sources its
 * `sources` entries name (the takes they were extended from, their first
 * frames) come last.
 */
export function cutSourceRefs(cut: CutFile, options: { provenance?: boolean } = {}): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const segment of cut.segments) {
    refs.push(segment.src);
    if (segment.audio && segment.audio.src !== undefined) refs.push(segment.audio.src);
  }
  for (const line of cut.lines ?? []) if (line.src !== undefined) refs.push(line.src);
  for (const clip of [...(cut.music ?? []), ...(cut.sfx ?? [])]) {
    if (clip.src !== undefined) refs.push(clip.src);
    for (const part of clip.parts ?? []) refs.push(part.src);
  }
  for (const overlay of cut.overlays ?? []) refs.push(overlay.src);
  if (options.provenance) {
    for (const entry of Object.values(cut.sources ?? {})) {
      if (entry.extendedFrom !== undefined) refs.push(entry.extendedFrom);
      if (entry.swappedFrom !== undefined) refs.push(entry.swappedFrom);
      if (entry.firstFrame !== undefined) refs.push(entry.firstFrame);
    }
  }
  return refs;
}
