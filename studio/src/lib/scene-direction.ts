/** The editable document. Camera and continuity helpers always become visible prose. */
export interface SceneBeat {
  id: string;
  text: string;
  start: number | null;
  end: number | null;
}

export type SceneMode = "text" | "image" | "references";
export type SceneFrame = "16:9" | "9:16";

export interface SceneDraft {
  beats: SceneBeat[];
  note: string;
  mode: SceneMode;
  frame: SceneFrame;
}

export const CONTINUOUS_SHOT = "One continuous shot, with no cuts.";

export const CAMERA_MOVES = [
  { id: "locked", label: "Locked camera", phrase: "Keep the camera still." },
  { id: "push", label: "Slow push-in", phrase: "Slowly move the camera closer to the subject." },
  { id: "pull", label: "Pull back", phrase: "Slowly pull the camera back to reveal the surroundings." },
  { id: "pan", label: "Pan across", phrase: "Gently pan across the scene." },
  { id: "follow", label: "Follow subject", phrase: "Follow the subject with a steady camera movement." },
] as const;

export function createSceneDraft(): SceneDraft {
  return {
    mode: "text",
    frame: "16:9",
    note: "",
    beats: [
      {
        id: "opening",
        start: 0,
        end: 3,
        text: "Glide through luminous cyan leaves. Deep blue water, soft morning light, a slow camera drift.",
      },
      {
        id: "unfurl",
        start: 3,
        end: 6,
        text: "Move closer as the leaves unfurl. Keep the motion gentle and the frame uninterrupted.",
      },
    ],
  };
}

export function timingError(start: string, end: string): string | null {
  if (!start.trim() && !end.trim()) return null;
  if (!start.trim() || !end.trim()) return "Enter both times, or clear both to remove the cue.";
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
    return "Use finite, nonnegative times in seconds.";
  }
  if (to <= from) return "End time must be after start time.";
  return null;
}

export function formatBeatTime(beat: SceneBeat): string {
  return beat.start === null || beat.end === null ? "Add time" : `[${beat.start}–${beat.end}s]`;
}

export function serializeSceneDirection(draft: Pick<SceneDraft, "beats" | "note">): string {
  const paragraphs = draft.beats.flatMap((beat) => {
    const text = beat.text.trim();
    if (!text) return [];
    return [beat.start === null || beat.end === null ? text : `${formatBeatTime(beat)} ${text}`];
  });
  if (draft.note.trim()) paragraphs.push(draft.note.trim());
  return paragraphs.join("\n\n");
}

export function setContinuousShot(note: string, enabled: boolean): string {
  if (enabled) {
    return note.includes(CONTINUOUS_SHOT) ? note : [note.trim(), CONTINUOUS_SHOT].filter(Boolean).join("\n");
  }
  // Preserve all user wording, including a rewritten version of the helper.
  return note.replace(CONTINUOUS_SHOT, "").trim();
}

export function insertCameraPhrase(text: string, start: number, end: number, phrase: string) {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const insertion = `${before && !/\s$/.test(before) ? " " : ""}${phrase}${after && !/^[\s.,;!?]/.test(after) ? " " : ""}`;
  return { text: before + insertion + after, caret: before.length + insertion.length };
}

export function hasOverlappingCues(beats: SceneBeat[]): boolean {
  const timed = beats.filter((beat) => beat.start !== null && beat.end !== null)
    .sort((a, b) => a.start! - b.start!);
  return timed.some((beat, index) => index > 0 && beat.start! < timed[index - 1]!.end!);
}

/** Validate browser storage before allowing it to become an editable document. */
export function readSceneDraft(value: unknown): SceneDraft | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("draft" in value) || !value.draft || typeof value.draft !== "object") return null;
  const draft = value.draft;
  if (!("mode" in draft) || !["text", "image", "references"].includes(String(draft.mode)) ||
      !("frame" in draft) || !["16:9", "9:16"].includes(String(draft.frame)) ||
      !("note" in draft) || typeof draft.note !== "string" ||
      !("beats" in draft) || !Array.isArray(draft.beats) || !draft.beats.length || draft.beats.length > 100) return null;
  const beats: SceneBeat[] = [];
  const ids = new Set<string>();
  for (const beat of draft.beats) {
    if (!beat || typeof beat !== "object" || typeof beat.id !== "string" || !beat.id || ids.has(beat.id) ||
        typeof beat.text !== "string") return null;
    const untimed = beat.start === null && beat.end === null;
    const validTime = typeof beat.start === "number" && Number.isFinite(beat.start) && beat.start >= 0 &&
      typeof beat.end === "number" && Number.isFinite(beat.end) && beat.end > beat.start;
    if (!untimed && !validTime) return null;
    ids.add(beat.id);
    beats.push({ id: beat.id, text: beat.text, start: beat.start, end: beat.end });
  }
  return { beats, note: draft.note, mode: draft.mode as SceneMode, frame: draft.frame as SceneFrame };
}
