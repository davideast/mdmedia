import { sha256 } from './parse.js';
import type { Line, StoryScript } from './types.js';

/** Bump when a change to rendering should invalidate every cached line. */
export const RENDER_VERSION = 1;

/** How many earlier lines in the scene go into a line's delivery note. */
export const CONTEXT_LINES = 2;

export interface ProviderRef {
  name: string;
  model: string;
}

/**
 * The cache key for one line's audio: a hash of everything that changes its
 * bytes. That includes the lines just before it in the same scene, because
 * they are part of its delivery note. Ids and positions are left out, so
 * inserting a line renumbers files without re-rendering anything.
 */
export async function lineRenderKey(line: Line, script: StoryScript, provider: ProviderRef): Promise<string> {
  const speaker = script.cast[line.speaker];
  if (!speaker) throw new Error(`${line.speaker} is not in the cast.`);
  const payload = [
    RENDER_VERSION,
    provider.name,
    provider.model,
    speaker.voice,
    speaker.delivery,
    line.cue,
    contextLines(line, script).map((l) => [l.speaker, l.text]),
    line.text,
    script.meta.language,
  ];
  return `line:${await sha256(JSON.stringify(payload))}`;
}

/** The lines just before `line` in its scene, oldest first. */
export function contextLines(line: Line, script: StoryScript): Line[] {
  for (const chapter of script.chapters) {
    for (const scene of chapter.scenes) {
      const lines = scene.segments.filter((s): s is Line => s.kind === 'line');
      const index = lines.findIndex((l) => l.id === line.id);
      if (index >= 0) return lines.slice(Math.max(0, index - CONTEXT_LINES), index);
    }
  }
  throw new Error(`Line ${line.id} is not in this script.`);
}
