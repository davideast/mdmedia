# Plan 009: Recover the comics and lock what's approved (overnight)

## Status

- **Branch**: `feat/story-recover`, from `feat/story-adapt` (447fa1d), local only
- **Planned at**: 2026-10-25, approved by David ("Do this")
- **Runs**: overnight, unattended; review pages ready in the morning

## Why

The comics regressed:
- **Voices:** Harper in a man's voice.
- **Art:** panels redrawn and characters drifting.
- **Lettering:** tall balloons over faces.

One cause: work David had approved could be replaced without him, through re-worded checks, a cache version bump and layout changes re-run over all three comics and republished. Milestone 6 (`story adapt`) added no visible feature, and its comic was worse than the hand-written one.

## Rules for this plan

1. **Approved work is locked.** A locked panel image, line or cast choice is used as it is: never re-checked, redrawn, re-voiced or recast, whatever checks, prompts or cache versions change. Only `--unlock <id>` replaces it.
2. **Nothing replaces David's published readers.** Every change goes to a new before/after review page.
3. **One subsystem per step:** art, voices and lettering never change together.
4. **What a model got wrong goes to a fixed table or to David,** never back to the model alone.
5. **The bugs David found become tests.**
6. **Milestone 6 is parked:** nothing David sees is made with `story adapt`.

## Steps

### 1. Guardrails

- **A lock manifest beside each comic** (`<comic>.lock.json`): locked panel images (by panel id and content hash), locked cast voices, locked line takes.
  - `drawComic` and `voiceComic` use locked items first and never touch them.
  - `--unlock <id>` releases one.
  - Tests: a changed check question doesn't redraw a locked panel; a changed `RENDER_VERSION` doesn't re-voice a locked line.
- **A before/after review page generator:** each changed panel and line, old against new, playable.
- **Regression tests from David's findings:**
  - a balloon taller than its text needs, in a narrow panel;
  - a balloon over a face, from recorded panels;
  - a tail to the wrong character;
  - a man's voice cast for a girl.

### 2. Art baseline (no new drawing)

Lock each comic's art from its first milestone 5 reader: what David saw before the re-worded checks redrew panels. Those images survive as the WebP copies `old-page-{lunch,midnight,wren}-*`. Head boxes are re-found on the locked images. Publish an art side-by-side page per comic (first version against current) so David can swap any panel in the morning.

### 3. Voice facts, measured blind (once, shipped as data)

- **Measure:** every Gemini voice reads three neutral lines with no brief. A judge that has not seen any brief describes each take's gender and age.
- **Record:** a voice whose takes agree is recorded in `src/story/voice-facts.ts` with its gender and age range. A voice whose takes disagree is listed for David to hear once.
- **Why blind:** the judge cast Algenib, a man's voice, as Harper after reading her brief; it heard what the brief told it to.

### 4. Casting from the facts

- **Target:** each brief's gender and age band, read once by a text model.
- **Filter:** casting only auditions voices whose measured gender matches and whose age range can play the band. Unmeasured or disputed voices are left out.
- **Rank:** the judge ranks within that set.
- **Confirm:** the cast voice gets a final blind check (gender and age, no brief); a mismatch moves to the next voice.
- **Recast** the 17 characters, then publish a cast page: each character, brief, voice, and a sample.
- No voicing of the comics until step 5.

### 5. Voices for the comics

Voice the three comics with the new cast on the locked art, then publish a before/after voice page: every line, old take against new. Readers are not updated.

### 6. Lettering only, art and voices locked

- **Tall balloons:** cap a balloon's height-to-width ratio, and wrap wider in narrow panels.
- **Faces, not heads:** avoid faces (brows to chin) instead of whole heads, so close-ups have room.
- **Visible speakers:** when the art shows a balloon's speaker (a head was found), the tail points at them even if the script didn't place them, and it isn't marked off panel.
- **A placement check:** draw the planned boxes onto the art (ffmpeg) and ask the vision model whether any box covers a face; re-place the ones that do.
- Publish before/after lettering pages.

### 7. Full rebuild, for review

Rebuild the three comic readers (locked art, new voices, new lettering) and each story's audio drama (`story build`, same cast) as new review pages. Write a morning report.

## STOP conditions

- More than 8 of the 30 voices measure inconsistently: list them for David and stop casting.
- Gemini quota runs out: stop, keep what's done, say where it stopped.
- Any step would overwrite a published reader or an approved item.

## In the morning, David decides

- Art swaps on the side-by-side pages, if any.
- The disputed voices, a few minutes of listening, if any.
- Whether the new cast, voices and lettering replace the published readers.
