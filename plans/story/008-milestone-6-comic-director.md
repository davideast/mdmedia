# Plan 008: Story milestone 6 — the comic director (`story adapt`)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (adaptation is judgment; the checks only hold the mechanics)
- **Depends on**: 005, 006, 007 (`feat/story-casting`); [000 design](000-design.md) sections 4.2, 14
- **Branch**: `feat/story-adapt`, from `feat/story-casting`, local only
- **Planned at**: 2026-10-25

## Why this matters

Every comic script so far was written by hand. `story adapt` drafts one from a story file, the way `story direct` drafts the story file from prose. With it, prose becomes a graphic novel end to end: `direct`, then `adapt`, then `comic`.

## Scope

In:
- the adapter (a text model per scene, returning JSON);
- code that assembles the comic notation;
- checks and repair rounds;
- `mdmedia story adapt <story.md> -o <comic.md> [--style] [--scene] [--model] [--json]`.

Out:
- drawing (that's `story draw` and `story comic`);
- a studio UI.

## Decisions

1. **The model chooses; code writes the notation.**
   - Per scene, the model returns JSON: the scene's setting, staging and rules, then pages of panels.
   - Each panel has a shot, who stands left, center or right, a balloon zone, an acting note, an optional panel setting, and whether it continues the panel before.
   - Each item names a story line by id (`L12`), with `text` when only part of the line is used.
   - Code writes the notation, so the format is always right. Cues come from the story's lines.
2. **Fidelity, checked by code:**
   - Every caption and balloon is an exact piece of its story line.
   - Every line of dialogue appears in balloons, all of its words, in story order.
   - Narration may become pictures: captions are optional, short, and verbatim.
   - Items stay in story order.
3. **Mechanics, checked by code:**
   - `parseComic` passes.
   - Pages hold 3 to 7 panels in rows of 1 to 3.
   - Only cast members with a `look` are placed.
   - A speaker who isn't placed in the panel is marked `[off]` automatically.
   - A `continue` panel must follow a panel on the same page.
4. **Repair:** each scene's problems go back with its JSON, up to 2 rounds, as `story direct` does.
5. **What the prompt asks for comes from the evidence:**
   - Prototype runs 4 and 6, and the milestone 4 and 5 reviews.
   - Most narration becomes pictures.
   - Headroom rather than "leave space for balloons".
   - Extreme close-ups worded as "only X's face, filling the frame".
   - Continue chains for a face changing over a beat.
   - Acting notes written in context.
   - Staging plus screen-side rules for scenes in fixed places.
   - A panel setting when a panel leaves the scene's place.
   - No written words in the art.
   - Sound effects only for sounds.
   - Pages end on a hook.
6. **Style** comes from `--style` (default `flat`). The adapter doesn't choose it.

## Steps

1. **`src/story/adapt/prompts.ts`:** the instruction, with every rule above.
2. **`src/story/adapt/assemble.ts`:** JSON to comic notation, with page numbering across scenes, layouts from rows, continue ids, and automatic `[off]`.
3. **`src/story/adapt/fidelity.ts`:** item text, dialogue coverage, order, panel counts.
4. **`src/story/adapt/adapt.ts`:** scenes in parallel (3 at a time), then check, repair and report.
5. **The `story adapt` command.**
6. **Tests with a fake text model:** assembly golden; each check; a repair round; `--scene`.
7. **Live run:**
   - Adapt Wren Backwards and Midnight Line whole, and the lunch scene of *The Most Embarrassing Day of My Life* (`--scene Lunch`).
   - Compare each with the hand-written script: pages, panels, captions kept, problems left.
   - Build one adapted comic end to end with `story comic` and publish the reader.

## Done when

- Tests pass with fakes.
- The three adaptations check clean, or report what's left.
- One adapted comic is built and published.
- Committed locally, not pushed.

## STOP conditions

- An adapter reply can't be made to cover the dialogue after two repair rounds on more than one scene.
- A dependency seems necessary.
