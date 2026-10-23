# Plan 005: Story milestone 4 — comic scripts and checked art (`story draw`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2b1d4ed..HEAD -- src/story src/image src/cli/story-command.ts package.json`
> On any change that contradicts "Current state", STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM (image generation is slow and varies; checks only catch what they ask)
- **Depends on**: [004](004-milestone-3-director.md) (`feat/story-m3`, 2b1d4ed); [000 design](000-design.md) sections 4.2, 7, 9, 10, 11
- **Category**: feature
- **Planned at**: commit `2b1d4ed`, 2026-10-23

## Why this matters

This is the first half of the graphic novel: a comic script becomes drawn,
checked panels with the same characters, the same room and the right tone from
panel to panel. Run 6 settled the method (take C: a checked staging image,
acting notes, earlier panels as references, edit chains for close-ups, yes/no
checks with redraws); this milestone builds it into the package. Lettering,
comic voices and the reader are milestone 5.

## Scope

In: the comic script notation and parser; `story check` for comic scripts;
page geometry; the character sheet, staging images and panels with their
references, edit chains and checks; head boxes; the image cache;
`mdmedia story draw`; a preview page of the drawn pages without lettering.

Out: lettering, balloons and tails, comic voices, the guided reader
(milestone 5); the comic director (milestone 6); MP4.

## Current state

- `generateGeminiImage(client, { prompt, model, aspectRatio, resolution, reference })`
  (`src/image/index.ts`) takes one reference image; the prototype's
  `art-context.ts` sent several references in one request, which C needs.
- Prototype notation (`spike/story`: `spikes/story/embarrassing-day/comic-lunch.md`)
  and direction (`art-context.json`): pages with `layout:`, panels with a `>`
  art note holding `Left/Center/Right: NAME` and `Balloons: top|bottom`, then
  captions, balloons (`**NAME** *(small|off)*:`) and ` ```sfx ` blocks. Acting
  notes, staging, screen-side rules, references and edit chains lived in
  `art-context.json`.
- The story fixture's cast has voices and deliveries but no `look`.
- Available models (2026-10-22): `gemini-3-pro-image`, `gemini-3.1-flash-image`,
  `gemini-3.5-flash` (checks and head boxes).

## Decisions for this plan

1. **One comic script holds all the direction** (design 4.2): acting notes,
   staging, rules and edit chains move from `art-context.json` into the file.
2. **Balloon cues and lettering marks are separate.** `*(cue)*` is how the line
   sounds (for milestone 5's voices, as in story files); `[small]`, `[off]`,
   `[loud]` after it is how it is lettered:
   `**JUNE** *(barely holding it together)* [small]: I guess that was stupid.`
3. **Cast comes from the story file** named by `story:`; looks come from its
   `look:` fields. A comic panel may only name cast members.
4. **References**: the character sheet; the current staging image when the
   page has staging; the previous panel on the same page. A `continue: P.N`
   panel is an edit of panel N on page P and takes only that panel.
5. **Checks are generated, not written**: on-model per character from its
   `look`, no written words, screen sides from `Left/Right`, extreme close-up
   framing, the acting note as a question, and "same face and framing" for
   `continue`. Up to 2 redraws; the panel with the most yes answers is kept.
6. **Pages draw in parallel, panels within a page in order** (each may
   reference the one before), at most 2 pages at once.
7. **Defaults**: `gemini-3-pro-image` for art, `gemini-3.5-flash` for checks and
   head boxes; both overridable.

## Notation

````markdown
---
title: The Most Embarrassing Day of My Life — Lunch
story: embarrassing-day.md
style: flat
setting: the busy school cafeteria at lunch
staging: >
  Side view across one lunch table. June sits on the bench on the left, facing
  right; Milo on the right, facing left.
rules: Whenever both are in a panel, June is on the left and Milo on the right.
---

## Page 3

layout: 1 1 1 | 1 1 | 1

### Panel 2

continue: 3.1

> Extreme close-up: only June's face. Center: JUNE. Balloons: top.
>
> acting: Same face and framing. The almost-smile is gone; her face goes blank.

*(quiet, careful)* Not angry.

### Panel 4

> June pulls back from the table in shock; Milo raises both palms. Left: JUNE.
> Right: MILO. Balloons: top.
>
> acting: She has just understood he betrayed her trust. Stunned and hurt.

**JUNE** *(stunned, disbelieving)*: You sent my video?

**MILO** *(defensive, too fast)* [small]: It was just to Harper.
````

- Front matter: `title`, `story`, `style` required; `setting`, `staging`,
  `rules` optional. A page may start with `setting:` or `staging:` lines that
  apply from that page on.
- `style` is a preset (`flat`, `watercolor`, `manga`, from the prototype) or a
  free description.

Errors: `missing-front-matter`, `bad-yaml`, `unknown-key`, `missing-field`
(also a panel with no art note), `unknown-speaker` (balloons and positions),
`layout-mismatch`, `bad-continue`. Warning: `missing-cue` on captions and
balloons (milestone 5 voices them).

## Files

| Path | Purpose |
|---|---|
| `src/story/comic/types.ts` | `ComicScript`, `ComicPage`, `ComicPanel`, `ComicItem`, slots |
| `src/story/comic/parse.ts` | `parseComic(markdown, { path, cast })` |
| `src/story/comic/geometry.ts` | page slots and nearest aspect ratios |
| `src/story/comic/styles.ts` | style presets and drawing phrases, as data |
| `src/story/comic/prompts.ts` | sheet, staging and panel prompts; check questions |
| `src/story/comic/draw.ts` | `drawComic(comic, cast, { image, vision, cache, ... })` |
| `src/story/comic/preview.ts` | the preview page (HTML string) |
| `src/story/ports.ts` | `ImageModel`, `Vision`; image entries in `RenderCache` |
| `src/story/node/gemini.ts` | `createGeminiImageModel`, `createGeminiVision` |
| `src/story/node/files.ts` | image cache entries |
| `src/cli/story-command.ts` | `story check` for comic scripts; `story draw` |
| `test/story/comic/*.test.ts` | tests named in each step |
| `test/story/fixtures/comic-lunch.md` | the lunch comic in this notation |

## Steps

### 1. Branch and fixtures

1. Local branch `feat/story-m4` from `feat/story-m3`. Do not push.
2. Add `look:` to MILO, JUNE and HARPER in `test/story/fixtures/embarrassing-day.md`
   from the prototype's character descriptions (`spikes/story/embarrassing-day/panels.json`);
   update the golden script. Line keys do not include looks, so cached audio
   stays valid.
3. Write `test/story/fixtures/comic-lunch.md`: the prototype's lunch comic with
   the acting notes, staging and rules from `art-context.json`, `continue: 3.1`
   and `continue: 3.2` for the close-ups, and cues on every caption and balloon
   from `comic-lunch-voices.md`.

### 2. Types, geometry, parser

- Geometry as in the prototype: 1000 × 1500 page, 14 gutter, rows share the
  height, panels share a row by weight; each panel gets the nearest of the
  image model's aspect ratios.
- `parseComic` mirrors `parseStory`: positioned diagnostics, `script` only
  without errors.

**Verify**: `bun test test/story/comic/parse.test.ts`: golden `comic.json` for
the fixture (21 panels on 4 pages); one test per error; `[small]` and the cue
both read; `continue` resolved to panel ids; slots and aspects match the
prototype (16:9 wide panels, 2:3 narrow ones).

### 3. `story check` for comic scripts

`story check` reads the front matter: a file with `story:` is a comic script,
checked against that story's cast.

**Verify**: CLI tests: the fixture passes; an unknown speaker in a balloon is an
error at its position.

### 4. Prompts and checks as data

- Styles from the prototype; the bleed phrase; headroom as "the top quarter
  shows only background scenery"; "extreme close-up: only her face, filling the
  frame"; the reference legend; dialogue context marked "do not write".
- `panelQuestions(panel, cast, previousForContinue)` produces the questions in
  decision 5.

**Verify**: `bun test test/story/comic/prompts.test.ts`: a two-shot panel with
JUNE left and MILO right asks about both looks, no text, the sides and its
acting note; a `continue` panel asks about the same face and framing; a panel
prompt never contains "leave space" (it drew empty boxes in the prototype).

### 5. Ports and cache

```ts
interface ImageModel {
  readonly model: string;
  draw(req: { prompt: string; references: Array<{ bytes: Uint8Array; mimeType: string }>; aspectRatio: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
interface Vision {
  readonly model: string;
  /** Strict yes/no answers, in order. `images` are shown before the questions, labeled. */
  ask(req: { images: Array<{ label: string; bytes: Uint8Array; mimeType: string }>; questions: string[]; signal?: AbortSignal }): Promise<boolean[]>;
  /** Head boxes [ymin, xmin, ymax, xmax] as fractions, for named characters. */
  heads(req: { image: { bytes: Uint8Array; mimeType: string }; characters: Array<{ id: string; look: string }>; signal?: AbortSignal }): Promise<Array<{ id: string; box: [number, number, number, number] }>>;
}
```

`RenderCache` gains `getImage(key)` / `putImage(key, { bytes, mimeType, meta })`.
Keys hash the model, the full prompt and the reference keys (design 9).

### 6. Draw

`drawComic(comic, cast, { image, vision, cache, concurrency, signal, onEvent })`:

1. Sheet from the cast looks (once per style).
2. Staging images, each checked on model (up to 3 tries) before use.
3. Panels: pages in parallel (2), panels in order; references per decision 4;
   check, redraw up to 2 times, keep the best; cache accepted panels as
   accepted.
4. Head boxes for every final panel.

Returns the panels with their answers, attempts and head boxes.

**Verify**: `bun test test/story/comic/draw.test.ts` with fakes: references are
the sheet, staging and previous panel; a `continue` panel gets only its source
panel; a failing check redraws twice then keeps the best; a drifted staging
image is redrawn before any panel uses it; a second run draws nothing.

### 7. Output, preview and CLI

`mdmedia story draw <comic.md> [--out] [--cache] [--image-model] [--vision-model] [--json]`
writes `dist/<slug>/comic/comic.json` (the parsed comic with answers and head
boxes), `art/sheet.png`, `art/staging-NN.png`, `art/panel-P-N.png`,
`draw.json` (every image, its questions, answers, attempts) and `preview.html`
(the pages laid out with the drawn panels and each panel's answers, no
lettering). Exit `0`, `1` on script errors, `2` on provider failure, `4` when a
panel still fails a check.

**Verify**: CLI tests with fakes: the tree, exit 4 on a persistent failure.

### 8. Live run (needs the Gemini key; not in CI)

```bash
NODE_USE_ENV_PROXY=1 node dist/bin.js story draw test/story/fixtures/comic-lunch.md --out $TMPDIR/m4 --cache $TMPDIR/m4-cache
```

Record images drawn, redraws, checks failed, head boxes found, wall time; look
at every page; publish the preview for review next to the prototype's take C.

### 9. Full checks

```bash
bunx tsc --noEmit
bun test test/story
bun run build
npm_config_cache=$TMPDIR/npm-cache bun run verify
grep -rn "from 'node:" src/story --include=*.ts | grep -v "src/story/node/" && echo "STOP" || echo "core is platform-free"
```

## Done when

- Every step's tests pass with fakes.
- The live run draws all 21 panels with checks, and the preview is published.
- Committed locally on `feat/story-m4`, not pushed.

## STOP conditions

- The image model no longer accepts several reference images in one request.
- More than a third of panels still fail their checks after two redraws.
- A dependency seems necessary.

## As built

Done on `feat/story-m4` (727f57f parser, 6e275cf draw, 481f5ce check fixes),
local only. 131 story tests pass; verify 13/13; core is platform-free.
Preview: private Artifact `2qWuaSqzt9efF3rVS8jD3W`.

**Live runs** (`comic-lunch.md`, 4 pages, 21 panels):

| Run | Cached | Redraws | Failing | Head boxes | Wall |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 16 | 3 (1.4, 2.3, 4.1) | 30 | 9m03 |
| 2, new checks, same cache | 15 | 6 | 1 (1.4) | 30 | 4m43 |

Under the STOP threshold (a third of the panels) both times. The sheet came out
first try; the page 3 staging needed 2 takes in run 1.

**What looking at every panel showed**

- The checker fails for the wrong reason sometimes. In run 1, panel 1.4 failed
  "Milo on model", but Milo was fine; the real defect was a panel divider the
  model drew across the image, which no question asked about. Added
  `ONE_IMAGE_QUESTION`. The redraw has no divider; Harper lost her varsity
  jacket and the check caught it correctly.
- Too strict: 2.3 failed only for "MILK" on a carton. `NO_TEXT_QUESTION` now
  allows labels on objects.
- It also misses things. Run 1's 4.1 had June with long hair and a June
  lookalike, which it caught. Run 2's 4.1 has Milo with straight hair and no
  freckles, and it passed. On-model questions over a long `look` are weak on
  hair texture.
- Cached images carried answers to the old question list, so after a question
  changed the answers no longer lined up. Cached images now store their
  questions; a different list re-checks the image before redrawing anything.
  Re-checking re-judges, though: 1.3, 3.4 and the staging failed a second look
  and were redrawn. The vision answers are noisy at the margin.
- The character sheet carries name labels despite "no text or labels". That's
  harmless as a reference, and no panel copied them.
- Continue chains (3.1→3.2→3.3) hold the same face and framing. Acting notes
  land: 3.4 reads as panic against shock.

**Left for later**

- A panel's cache key holds its references' keys, not their images, so a
  redrawn staging image or previous panel does not invalidate the panels drawn
  from it. That's fine for review; revisit if continuity drifts.
- Consider asking about hair and clothing separately per character instead of
  one long on-model question.

**Two new stories** (2026-10-23, db106eb, 78121a5): *Midnight Line* (color
anime, 15 panels) and *Wren Backwards* (stop-motion, 16 panels), written as
raw prose, directed with `story direct`, comic scripts by hand.

| Run | Redraws | Failing | Wall |
| --- | --- | --- | --- |
| Wren Backwards | 14 | 2 | ~12 min, both drawn in parallel |
| Midnight Line | 18 | 8 (over the STOP threshold) | |
| Midnight Line, after fixes, fresh cache | 9 | 3, all acting questions | 6m40 |

- Both character sheets were right first time, including a two-tailed cat, a
  six-armed grandmother and a neat double of the heroine.
- Most Midnight Line failures were on-model questions over small details of a
  long look (scraped knees, shoelaces). On-model questions now judge only hair,
  face and main outfit; after that, every character stayed on model.
- A page's setting applied to a panel that changed scene; panels now take a
  `setting:` line of their own.
- The director's looks were too thin to draw from ("short black hair, track
  uniform"), and it once wrote a literal `*(cue)*`. The cast prompt now asks for
  drawable looks, and `story check` reports placeholder cues as errors so the
  director repairs them.
- Still open: drawn panel borders recur (caught by the border question); an
  afterimage drawn as the wrong character (2.1) was caught by the acting
  question.
