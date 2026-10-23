# Plan 004: Story milestone 3 — the director (`story direct`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6b69b56..HEAD -- src/story src/narration src/cli/story-command.ts package.json`
> On any change that contradicts "Current state", STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (model output must become valid, faithful notation)
- **Depends on**: [003](003-milestone-2-music.md) (`feat/story-m2`, 6b69b56); [000 design](000-design.md) sections 1, 4.1, 4.3, 5, 11
- **Category**: feature
- **Planned at**: commit `6b69b56`, 2026-10-22

## Why this matters

Every story file so far was adapted by hand. The audio sounds best when every
line, narration included, carries a cue written with the line before it in
mind (findings run 5), and the full-story build showed what happens without:
flat narration and 213 `missing-cue` warnings. The director turns an author's
raw text into a story file a person can read and edit, and loops on
`story check` until the file is valid. It also folds in the comparison fixes
from milestone 2's full build, where all nine flagged lines were checked by ear
and found fine.

## Scope

In:

- `mdmedia story direct <raw.md> -o <story.md>`: cast and voices, scenes,
  music cues, a cue on every line, pauses, and dramatized background lines,
  checked and repaired until `story check` passes with no `missing-cue`.
- A fidelity check in code: the author's words must survive.
- Notation: `names:` front matter (other proper nouns, for the transcriber)
  and `<!-- director: … -->` comments marking the director's additions.
- Comparison fixes: compound numbers, a few units, `'d` and `'ve`
  contractions, and names from `names:` in the transcription hint.

Out: the comic director (milestone 6), any change to how lines are voiced,
listening reviews by a model.

## Current state

- `parseStory` (milestone 0) accepts front matter keys `title`, `author`,
  `language`, `gap`, `narrator`, `cast`; HTML comments are `html` tokens and
  are skipped by the parser.
- `castNames(script)` (milestone 2) feeds the transcriber's name list.
- `compareTranscript` normalizes single number words, a few contractions
  (`gonna`), joined/split compounds, and ignores missing interjections.
- The narration adapter (`src/narration/gemini-narration-adapter.ts`) calls
  `client.models.generateContent` with a system instruction and a low
  temperature; the director follows that pattern.
- Ground truth for the live run: the prototype's raw text
  (`spike/story`: `spikes/story/embarrassing-day/raw.md`) and the hand-adapted
  story file now in `test/story/fixtures/embarrassing-day.md` (290 lines, 8
  scenes, music on each, cast MILO narrating, JUNE, HARPER, ALVAREZ, TECHKID,
  KID, and the kid's added ketchup line).
- Milestone 2's full build flagged nine lines; all were transcriber or
  comparison noise: "forty-five" vs "45", "three hundred" vs "300", "feet" vs
  "ft", "might've" vs "might have", "he'd"/"you'd" heard as "he"/"you",
  "Shah" heard as "Shaw", "just to Harper" heard as "just a Harper", "Yeah?"
  heard as "ia".

## Decisions for this plan

1. **Two model passes, code in between.** A cast pass reads the whole text
   and returns JSON (cast, voices, narrator, scenes, music cues, names). A
   scene pass writes one scene of notation at a time, with the cast, the
   scene's raw text and the previous scene's last lines. Code assembles the
   front matter, validates, and loops.
2. **The author's words are kept.** The director may drop speech tags ("I
   said", "she asked") when the voice makes the speaker clear, split a
   paragraph into lines, and add short dramatized lines; it may not reword
   sentences, and it cuts one only when a dramatized line replaces it. Code
   checks this (step 5), not the model.
3. **Show, don't tell twice.** A dramatized line replaces the sentence that
   describes the same thing, so it lands as a beat (the kid's "Ketchup is TOO
   a vegetable!" lands as a punchline only without the sentence explaining the
   argument first; you caught the double telling in milestone 2's build, and
   the comic had already cut it).
4. **Every change is visible**: an added line is preceded by
   `<!-- director: added -->`, and a replaced sentence is kept in
   `<!-- replaced: "…" -->` right where it was, so a person can restore it.
   The parser ignores both; the fidelity check reads them. The hand-adapted
   fixture uses the same comment for the ketchup line (5850386).
5. **Voices come from a fixed list** with Google's one-word descriptions
   (Puck upbeat, Kore firm, Leda youthful, Charon informative, …). The cast
   pass must pick from it; code rejects anything else. Verify the list
   against Google's speech generation documentation before committing it.
6. **Repairs are bounded**: up to 2 repair rounds per scene for check errors,
   missing cues or fidelity gaps; anything left is reported, and the file is
   still written so a person can finish it.
7. **Default text model `gemini-3.5-flash`**, overridable. Confirm it is
   available with a models list call at the start of the live run; if a pro
   model is listed, record its result too.

## Files

| Path | Purpose |
|---|---|
| `src/story/front-matter.ts`, `types.ts` | `names:` key; `script.meta.names` |
| `src/story/diff.ts` | compound numbers, units, `'d` and `'ve` |
| `src/story/render-lines.ts` | transcriber names: cast names plus `meta.names` |
| `src/story/direct/voices.ts` | the voice list with descriptions |
| `src/story/direct/prompts.ts` | the cast-pass and scene-pass instructions, as data |
| `src/story/direct/fidelity.ts` | `fidelityGaps(raw, script)` |
| `src/story/direct/assemble.ts` | front matter from the cast JSON, scenes joined |
| `src/story/direct/direct.ts` | `directStory(raw, { writer, signal, onEvent })` |
| `src/story/ports.ts` | `TextModel` |
| `src/story/node/gemini.ts` | `createGeminiTextModel` |
| `src/cli/story-command.ts` | `story direct` |
| `test/story/direct/*.test.ts` | tests named in each step |

## Steps

### 1. Branch

Local branch `feat/story-m3` from `feat/story-m2`. Do not push.

### 2. Comparison fixes

In `words()`:

- compound numbers: `twenty-three`, `forty five` → `23`, `45`; `three
  hundred` → `300`; `one hundred and twelve` → `112` (up to 999,999);
- units, both ways to one form: `ft` → `feet`, `%` and `per cent` →
  `percent`, `mr` → `mister`, `mrs` → `missus`, `dr` → `doctor`;
- `'ve` → ` have`; a trailing `'d` is dropped (`he'd` and `he` compare equal),
  because the transcriber hears the elided `'d` either way.

**Verify**: `bun test test/story/diff.test.ts` with milestone 2's pairs, all
`ok: true`:

| Expected | Heard |
|---|---|
| At 1:45, I had forty-five minutes to save my friendship. | At 1:45, I had 45 minutes to save my friendship. |
| Three hundred heads turned toward me. | 300 heads turned toward me. |
| June's face. Twenty feet tall. | June's face 20 ft tall. |
| I might've been cooler | I might have been cooler |
| like he'd just won the Super Bowl | like he just won the Super Bowl |

and the prototype's real defects still fail ("What. Clip." / "What?",
"You promised." / "Ugh. You promised.").

### 3. `names:` front matter

- `names:` is a list of strings (other proper nouns in the story). Unknown
  types are `bad-yaml`-style errors with a position (`missing-field` is not
  right; use a new code `bad-names` only if needed and add it to design 4.3).
- `script.meta.names` carries them; the transcriber's list is cast names plus
  `meta.names`, without duplicates.

**Verify**: front matter and render-lines tests: the names reach the
transcriber; a story without `names:` behaves as before.

### 4. Voices and prompts as data

- `voices.ts`: every Gemini voice name in `src/types/voice.ts` with its
  description, and `isVoice(name)`.
- `prompts.ts`: the two instructions. The scene instruction states, from the
  findings:
  - keep every sentence of the author's text, in order, word for word;
  - drop speech tags only when the speaker is clear from the voice;
  - every line and every narration paragraph gets a cue about feeling, written
    with the previous line in mind; never an action ("typing fast"), which
    gets spoken;
  - narration paragraphs start with `*(cue)*`;
  - add a `pause` block only where the text names a silence or after a big
    beat;
  - when the text describes background speech vividly or funnily (a kid
    arguing that ketchup is a vegetable), you may add one short line for it,
    preceded by `<!-- director: added -->`, and replace the sentence that
    describes it with `<!-- replaced: "…" -->` so it is shown, not told twice;
    never reword the author's lines;
  - the notation, with a short example taken from the fixture.

**Verify**: `bun test test/story/direct/prompts.test.ts`: the scene
instruction contains each rule; `isVoice` accepts `Puck` and rejects `Bob`.

### 5. Fidelity (pure)

`fidelityGaps(raw, markdown, script)`: words of the raw text (normalized as in
`words()`) against the spoken words of the script's lines in order, by
longest common subsequence. Returns `missing` spans (raw words not in the
script) and `added` spans (script words not in the raw), each with the raw
sentence it falls in.

- A missing span of 1 to 4 words next to a quotation (a speech tag) is
  allowed.
- A missing span that matches the text of a `<!-- replaced: "…" -->` comment
  in the story markdown is allowed, but only if a line marked
  `<!-- director: added -->` follows it in the same scene.
- Added spans inside lines marked `<!-- director: added -->` are allowed.
- Anything else is a gap.

**Verify**: `bun test test/story/direct/fidelity.test.ts`: the hand-adapted
fixture against `raw.md` has only allowed spans (its speech tags, the ketchup
line and its replaced sentence; mark the ketchup line in the fixture with
`<!-- director: added -->` for this); deleting a sentence from the fixture
yields a gap naming it; rewording a word yields a gap; a `replaced` comment
with no added line after it yields a gap.

### 6. Assemble (pure)

`assembleStory(cast, scenes)`: YAML front matter from the cast JSON (title,
narrator, gap, cast with voice, delivery and look, names), then `# title`, then
each scene's notation under its `###` heading with its ` ```music ` block.

**Verify**: assembling the fixture's cast and scenes reproduces a file that
parses to the same script as the fixture, ignoring source positions.

### 7. The director loop

`directStory(raw, { writer, signal, onEvent })`:

1. Cast pass → JSON; validate shape and voices; one retry on invalid JSON.
2. Scene pass for each scene, at most 3 in flight, each with the previous
   scene's last two lines.
3. Assemble; `parseStory`; collect, per scene, errors, `missing-cue`
   warnings and fidelity gaps.
4. For each scene with problems, a repair call with the scene's current text
   and the exact problems (diagnostic codes and messages, missing sentences).
   Up to 2 rounds.
5. Return `{ markdown, diagnostics, gaps, report }`; `report` lists additions,
   repairs and anything left unfixed.

`TextModel` port: `generate({ system, prompt, json?: boolean, signal })` →
string. `createGeminiTextModel({ apiKey, model, temperature = 0.4 })`, retrying
busy errors like the transcriber.

**Verify**: `bun test test/story/direct/direct.test.ts` with a scripted fake
writer: a scene returned with an unknown speaker gets one repair call and the
final file parses; a scene that drops a sentence gets a repair with that
sentence named; a writer that never fixes a gap stops after 2 rounds and the
gap is in the report; invalid voice names are rejected.

### 8. CLI

`mdmedia story direct <raw.md> -o <story.md> [--model id] [--json]`: writes
the file even when problems remain; prints the report (additions, repairs,
remaining problems); exit `0` when the file passes `story check` with no
errors, no `missing-cue` warnings and no fidelity gaps; `1` otherwise; `2` on
provider failure.

**Verify**: `bun test test/story/cli.test.ts` with the fake writer.

### 9. Live run (needs the Gemini key; not in CI)

```bash
NODE_USE_ENV_PROXY=1 node dist/bin.js story direct test/story/fixtures/embarrassing-day.raw.md -o $TMPDIR/m3/story.md
node dist/bin.js story check $TMPDIR/m3/story.md
NODE_USE_ENV_PROXY=1 node dist/bin.js story build $TMPDIR/m3/story.md --out $TMPDIR/m3/build --cache $TMPDIR/m3-cache
```

Copy `raw.md` from the prototype into `test/story/fixtures/embarrassing-day.raw.md`
first. Record against the hand-adapted fixture: cast and voices chosen,
scenes, lines, narration lines with cues (target: all), additions (list
them), fidelity gaps (target: none), repair rounds, wall time; then the build's
flagged lines and retakes against milestone 2's (9 flagged, 46 retakes).
Publish the MP3 next to milestone 2's for listening: the narration should no
longer sound flat.

### 10. Full checks

```bash
bunx tsc --noEmit
bun test test/story
bun run build
npm_config_cache=$TMPDIR/npm-cache bun run verify
grep -rn "from 'node:" src/story --include=*.ts | grep -v "src/story/node/" && echo "STOP" || echo "core is platform-free"
```

## As built (2026-10-22)

Committed locally on `feat/story-m3` (8a42b06, eb83677 and the fixtures), not pushed.

- **The comparison fixes** shipped first (c36d9a9): compound numbers, `ft`,
  `mr`, `%`, `'ve` and an elided `'d`. A real number reader keeps separate
  numbers apart ("Eleven! Twelve!" is two numbers).
- **The ketchup line lands as a punchline** in the hand-adapted fixture
  (5850386): you heard the double telling at 7:01; the narration no longer
  explains the argument first, and the cut sentence is kept in a `replaced`
  comment. The rebuild rendered just the three changed lines.
- **Fidelity found real cuts in my hand adaptation**: seven short beats
  ("Harper continued.", "She smiled.", "I blinked.", …), the subtitle and
  ".mp4". The fixture test pins those down.
- **A speech tag is judged by touching a quotation**, not by sharing a
  paragraph with one: `"Wait!" Maya shouted.` drops a tag; `Dad laughed.
  "It left."` keeps a beat.
- **Dramatizing moved to the cast pass.** Asked in the scene pass, the model
  never replaced a sentence, because it conflicts with keeping every sentence.
  Now the cast pass lists moments (exact sentence, speaker, cue, line) and code
  applies them, with the `replaced` and `added` comments.
- **Comments get their own paragraph** when the file is assembled; the first
  live run had glued an `added` comment to its line.
- **Models available**: `gemini-3.5-flash` (default) and newer
  `gemini-3.6/3.7/3.8-flash`, `gemini-3.1-pro-preview`, and a dedicated
  `gemini-3.5-transcribe` worth trying for line checks.
- **Live run** (third, final): story file in 2 min 17 s, 8 scenes, 377 lines,
  all cued (247 narration, 130 dialogue), one repair round, no fidelity gaps,
  one dramatization ("Ketchup is made from tomatoes, so it is TOTALLY a
  vegetable!"). Cast: Milo narrating (Puck), June (Leda), the same voices as
  by hand. Build: 21 min 13 s of audio in 6 min 36 s, 45 retakes, 4 flagged
  (transcriber slips on short narration lines), 8 music clips. Published next
  to the hand-adapted build. Kept as `test/story/fixtures/embarrassing-day.directed.md`.
- **Observed**: the director splits narration into more, shorter lines than I
  did; short lines draw most of the transcriber's slips and retakes.

## Done when

- Every step's tests pass with fakes.
- The live run writes a story file from the raw text that passes `story
  check` with no errors and no `missing-cue` warnings, with no fidelity gaps
  or with each one reported.
- Its build is published for listening.
- Committed locally on `feat/story-m3`, not pushed.

## STOP conditions

- The fidelity check cannot tell speech-tag drops from cuts on the fixture.
- The model rewords the author's lines in more than a few places after two
  repair rounds (the rule is not holding; the prompt or the pass split needs
  rethinking).
- A dependency seems necessary.
