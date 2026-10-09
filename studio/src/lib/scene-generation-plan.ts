import { serializeSceneDirection, type SceneDraft } from './scene-direction';

export const MAX_SCENE_SECONDS = 40;
export interface SceneGenerationStep { start: number; end: number; durationSeconds: number; direction: string }

/** Blank rows do not lengthen a scene; untimed scenes let the model choose. */
export function sceneDuration(draft: SceneDraft): number | undefined {
  const ends = draft.beats.flatMap(beat => beat.text.trim() && beat.end !== null ? [beat.end] : []);
  return ends.length ? Math.max(3, Math.ceil(Math.max(...ends))) : undefined;
}

export function planSceneGeneration(draft: SceneDraft): SceneGenerationStep[] {
  const total = sceneDuration(draft);
  if (total === undefined) return [];
  if (total > MAX_SCENE_SECONDS) throw new RangeError(`A continuous scene can be up to ${MAX_SCENE_SECONDS} seconds. Split longer direction into separate scenes.`);
  const steps: SceneGenerationStep[] = [];
  for (let start = 0; start < total;) {
    const remaining = total - start;
    // Avoid an unsupported 1–2 second extension at the end.
    const durationSeconds = remaining <= 10 ? remaining : remaining < 13 ? remaining - 3 : 10;
    const end = start + durationSeconds;
    const beats = draft.beats.flatMap(beat => {
      if (!beat.text.trim()) return [];
      if (beat.start === null || beat.end === null) return [beat];
      if (beat.end <= start || beat.start >= end) return [];
      return [{ ...beat, start: Math.max(start, beat.start) - start, end: Math.min(end, beat.end) - start }];
    });
    const direction = serializeSceneDirection({ beats, note: draft.note });
    steps.push({ start, end, durationSeconds, direction });
    start = end;
  }
  return steps;
}
