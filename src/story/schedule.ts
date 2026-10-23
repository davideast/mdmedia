import type { CastId, Line, StoryScript } from './types.js';

export interface TimedLine {
  id: string;
  speaker: CastId;
  narration: boolean;
  text: string;
  /** The render key of the take used. */
  render: string;
  startMs: number;
  endMs: number;
}

export interface StoryTimeline {
  schema: 'mdmedia.story.timeline/1';
  durationMs: number;
  chapters: Array<{ id: string; title?: string; startMs: number; endMs: number }>;
  scenes: Array<{ id: string; chapterId: string; title?: string; music?: string; startMs: number; endMs: number }>;
  lines: TimedLine[];
}

/**
 * Places lines one after another: each line's duration, then the script's gap,
 * or the pauses written after it instead (consecutive pauses add up). There is
 * no gap after the last line. A scene with a lead (its music playing alone)
 * starts where the lead starts, and its first line comes `lead` ms later.
 * Pure; durations, keys and leads come from rendering.
 */
export function scheduleStory(
  script: StoryScript,
  durations: ReadonlyMap<string, number>,
  renders: ReadonlyMap<string, string>,
  options: { leads?: ReadonlyMap<string, number> } = {}
): StoryTimeline {
  const lines: TimedLine[] = [];
  const chapters: StoryTimeline['chapters'] = [];
  const scenes: StoryTimeline['scenes'] = [];
  let cursor = 0;
  let afterLine = false;
  let pauseSinceLine = false;

  for (const chapter of script.chapters) {
    const chapterStart = cursor;
    for (const scene of chapter.scenes) {
      let sceneStart: number | undefined;
      const lead = options.leads?.get(scene.id) ?? 0;
      if (lead > 0) {
        if (afterLine && !pauseSinceLine) cursor += script.gapMs;
        sceneStart = cursor;
        cursor += lead;
        pauseSinceLine = true;
      }
      for (const segment of scene.segments) {
        if (segment.kind === 'pause') {
          cursor += segment.durationMs;
          pauseSinceLine = true;
          continue;
        }
        if (afterLine && !pauseSinceLine) cursor += script.gapMs;
        const duration = durations.get(segment.id);
        if (duration === undefined) throw new Error(`No duration for line ${segment.id}.`);
        sceneStart ??= cursor;
        lines.push(timed(segment, renders.get(segment.id) ?? '', cursor, duration));
        cursor += duration;
        afterLine = true;
        pauseSinceLine = false;
      }
      scenes.push({
        id: scene.id,
        chapterId: chapter.id,
        ...(scene.title ? { title: scene.title } : {}),
        ...(scene.music ? { music: scene.music } : {}),
        startMs: sceneStart ?? cursor,
        endMs: cursor,
      });
    }
    chapters.push({ id: chapter.id, ...(chapter.title ? { title: chapter.title } : {}), startMs: chapterStart, endMs: cursor });
  }
  return { schema: 'mdmedia.story.timeline/1', durationMs: cursor, chapters, scenes, lines };
}

function timed(line: Line, render: string, startMs: number, durationMs: number): TimedLine {
  return {
    id: line.id,
    speaker: line.speaker,
    narration: line.narration,
    text: line.text,
    render,
    startMs,
    endMs: startMs + durationMs,
  };
}
