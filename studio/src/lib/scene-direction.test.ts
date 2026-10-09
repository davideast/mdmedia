import { describe, expect, test } from "bun:test";
import {
  CONTINUOUS_SHOT, createSceneDraft, hasOverlappingCues, insertCameraPhrase,
  readSceneDraft, serializeSceneDirection, setContinuousShot, timingError,
} from "./scene-direction";

describe("scene direction", () => {
  test("serializes visible cues and notes without blank beats or hidden camera settings", () => {
    const draft = createSceneDraft();
    draft.beats.push({ id: "empty", text: "  ", start: null, end: null });
    draft.note = CONTINUOUS_SHOT;
    expect(serializeSceneDirection(draft)).toBe(
      `[0–3s] ${draft.beats[0]!.text}\n\n[3–6s] ${draft.beats[1]!.text}\n\n${CONTINUOUS_SHOT}`,
    );
  });

  test("camera assistance replaces the selected words and returns the insertion caret", () => {
    const result = insertCameraPhrase("Keep the old motion gentle.", 9, 19, "new direction");
    expect(result.text).toBe("Keep the new direction gentle.");
    expect(result.text.slice(result.caret)).toBe(" gentle.");
  });

  test("continuity never duplicates its sentence or deletes a user's rewrite", () => {
    const note = setContinuousShot("Keep the lighting soft.", true);
    expect(setContinuousShot(note, true)).toBe(note);
    expect(setContinuousShot(note, false)).toBe("Keep the lighting soft.");
    expect(setContinuousShot("Keep a continuous shot, with a gentle cut at the end.", false))
      .toBe("Keep a continuous shot, with a gentle cut at the end.");
  });

  test("rejects incomplete, nonfinite and inverted cues, allowing both fields to be empty", () => {
    expect(timingError("", "")).toBeNull();
    expect(timingError("0", "3")).toBeNull();
    for (const cue of [["", "3"], ["Infinity", "4"], ["-1", "2"], ["3", "3"], ["5", "2"]]) {
      expect(timingError(cue[0]!, cue[1]!)).not.toBeNull();
    }
  });

  test("distinguishes adjacent cues from overlapping cues after reordering", () => {
    const draft = createSceneDraft();
    expect(hasOverlappingCues([...draft.beats].reverse())).toBe(false);
    draft.beats[1]!.start = 2;
    expect(hasOverlappingCues(draft.beats)).toBe(true);
  });

  test("browser restoration requires versioned, unique, valid beat data", () => {
    const draft = createSceneDraft();
    expect(readSceneDraft({ version: 1, draft })).toEqual(draft);
    expect(readSceneDraft({ version: 0, draft })).toBeNull();
    expect(readSceneDraft({ version: 1, draft: { ...draft, beats: [draft.beats[0], draft.beats[0]] } })).toBeNull();
    expect(readSceneDraft({ version: 1, draft: { ...draft, beats: [{ ...draft.beats[0], start: "0" }] } })).toBeNull();
    expect(readSceneDraft({ version: 1, draft: { ...draft, mode: "unknown" } })).toBeNull();
  });
});
