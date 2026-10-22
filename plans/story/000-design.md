# Story: design

A **story** builds an author's text into two productions that share one cast and
one render pipeline:

- an **audio drama**: every line voiced in character, with music, as an MP3;
- a **graphic novel**: comic pages with lettered balloons and captions, read at
  your own pace, where any balloon can be heard.

mdmedia treats it like a build tool: source files compile to a timeline, every
generated piece is cached by content and checked after it is made, and a build
writes a predictable output tree.

This version replaces the 2026-10-18 design. Six prototype runs on real text
answered the questions that design guessed at; the evidence is in
[prototype-findings.md](prototype-findings.md), cited below as **F-run N**.

- **Status**: rewritten from prototype evidence, 2026-10-22
- **Planned at**: commit `4eb8f62`

## 1. Principles

1. **Code owns what is mechanical and checkable; the model owns judgment.**

   | Code | Model |
   |---|---|
   | Parsing the notation, with exact errors | Adapting prose into the notation (the director) |
   | The render cache, retries, refusal fallbacks | Each line's delivery cue and each panel's acting note |
   | Comparing a transcript with the script, word by word | Transcribing a clip |
   | Page geometry, balloon layout, tails, reading order, lettering | Where each character's head is in a panel |
   | Mixing, music beds, loudness, encoding | Generating voices, music and art |
   | Asking concrete yes/no questions after each image | Answering them |

2. **Judgment is data.** Cues, acting notes, staging and pauses are written in the
   source files (by the author or the director) and the code applies them. There
   are no rule tables of taste.
3. **Every generated piece is checked, and checks ask concrete questions.**
   Voices are transcribed and compared with the script; images are asked yes/no
   questions taken from the script and the character sheet. A model asked "is
   this good?" praised everything (F-run 2, 6); a model asked "is June's hair a
   chin-length bob?" answers reliably.
4. **Context makes pieces consistent.** A line voiced alone, or a panel drawn
   alone, resets tone and drifts. Each one is generated knowing what came just
   before: the previous lines for a voice, the staging and previous panels for an
   image (F-run 5, 6).
5. **Make it cheap to redo one piece.** Content-addressed caching means a fix to
   one cue or one panel regenerates that piece and nothing else (F-run 3).
6. **Evidence before rules.** Every rule in this document is backed by a
   prototype finding. New checks are added only after their failure is seen or
   heard.
7. **The CLI is a model's toolbox.** Commands are fast, deterministic where they
   can be, and offer `--json`, so the director can loop: write, check, build one
   piece, read the report, adjust.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Raw text** | The author's story, untouched. |
| **Director** | The model step that adapts raw text into a story file, and a story file into a comic script. Its output is plain files a person can read and edit. |
| **Story file** (`story.md`) | The audio drama's source: cast, scenes, lines with cues, pauses, music cues. |
| **Comic script** (`comic.md`) | The graphic novel's source: pages, panels, art and acting notes, captions and balloons in reading order. |
| **Cast** | Characters with a voice, a default delivery and a look. The narrator can be a cast member (first-person stories). |
| **Line** | One spoken unit: a line of dialogue, a narration paragraph, or (in a comic) one caption or balloon. Always voiced alone, in context. |
| **Render** | One generated asset (a line's audio, a music clip, a reference image, a panel), cached by content hash. |
| **Check** | The verification of one render: a transcript diff for audio, yes/no questions for images. |
| **Timeline** | Lines with measured start and end times. |
| **Build** | One run that writes a `dist/` tree and `build.json`. |

## 3. Pipeline

```
raw.md ──director──▶ story.md ──director──▶ comic.md
                        │                       │
                 parse + check           parse + check
                        │                       │
             voice every line (context)   reference images ─▶ panels (context)
             check each, redo failures    check each, redo failures
                        │                  head boxes per panel
                  music per scene                │
                        │                 voice every caption and balloon
                  schedule + mix                 │
                        ▼                 lay out pages and lettering
              audio drama (MP3)                  ▼
                                         graphic novel (reader site)
```

The two productions share the cast, the voice pipeline and the cache. The
graphic novel's voices are rendered from the comic script's own captions and
balloons, which are shorter than the story's lines (F-run 4).

## 4. Notation

### 4.1 Story file

````markdown
---
title: The Most Embarrassing Day of My Life
narrator: MILO                 # a cast member narrates; or { voice, delivery } for a separate narrator
gap: 400ms
cast:
  MILO:
    voice: Puck
    delivery: a funny, quick-talking thirteen-year-old boy telling his own story
    look: messy curly brown hair, freckles, oversized forest-green hoodie, red high-tops
  JUNE:
    voice: Leda
    delivery: a smart, sarcastic thirteen-year-old girl, dry and warm
    look: straight black chin-length bob with blunt bangs, mustard-yellow cardigan
---

# The Most Embarrassing Day of My Life

### Lunch

```music
cheerful cafeteria bustle that slowly turns uneasy, light percussion
```

By lunch, things were going better than I'd imagined.

**JUNE** *(flat, quietly suspicious)*: What clip?

**MILO** *(barely audible, ashamed)*: The dancing one.

```pause
1.5s
```
````

- Front matter: `title`, `narrator`, `cast` (each with `voice`) are required;
  `delivery` and `look` are optional; unknown keys are errors.
- `narrator: NAME` makes narration paragraphs that character's lines, marked as
  narration (F-run 3). The Holmes case (narration as inner voice with an effect)
  builds on this later.
- A paragraph starting `**NAME** *(cue)*:` is a line by NAME; any other
  paragraph is narration. Inline markdown is stripped for speech and kept for
  display.
- **Every line should carry a cue**, written with the previous line in mind, and
  about feeling, not action: action cues ("typing fast") get spoken (F-run 3,
  5). `story check` warns on lines without one; telling feeling from action is
  the director's judgment, not a check.
- `###` or a horizontal rule starts a scene; `#` a chapter; `##` is displayed
  only.
- ` ```pause ` replaces the default gap at that point (`1.5s`, `1500ms`, `0:02`).
- ` ```music ` at the start of a scene is that scene's music cue (F-run 3).
- Other fenced blocks are kept for display and ignored by speech.

### 4.2 Comic script

````markdown
---
title: The Most Embarrassing Day of My Life — Lunch
story: story.md                # cast, voices and looks come from here
style: flat
setting: the busy school cafeteria at lunch
staging: >
  Side view across one lunch table. June sits on the bench on the left, facing
  right; Milo on the right, facing left.
rules: Whenever both are in a panel, June is on the left and Milo on the right.
---

## Page 3

layout: 1 1 1 | 1 1 | 1

### Panel 1

> Extreme close-up: only June's face, filling the frame from her bangs to her
> chin. Center: JUNE.
>
> acting: For one split second she hasn't taken it in; mid-blink, the ghost of
> her dry half-smile still there.

For one second, I thought she'd laugh.

### Panel 2

continue: 3.1

> acting: Same face and framing. The almost-smile is gone; her face goes blank.

Not angry.

### Panel 4

> June pulls back from the table in shock; Milo raises both palms. Left: JUNE.
> Right: MILO. Balloons: top.
>
> acting: She has just understood he betrayed her trust. Stunned and hurt, not
> relaxed.

**JUNE**: You sent my video?

**MILO**: It was just to Harper.
````

- `layout:` lists panel rows, `|` between rows, each number a panel's relative
  width. Code turns it into panel slots on a 2:3 page (F-run 4).
- The first `>` block is the art note: the shot, and `Left/Center/Right: NAME`
  for who stands where. `Balloons: top|bottom` names the lettering zone.
- `acting:` is the meaning of the moment, written in context (F-run 6).
- `continue: P.N` draws this panel as an edit of panel N on page P: same face,
  same framing, only what the acting note changes (F-run 6).
- Plain paragraphs are captions (the narrator); `**NAME**: text` is a balloon,
  `*(small)*` for quieter lettering, `*(off)*` for a speaker outside the panel;
  ` ```sfx ` is a lettered sound effect. All in reading order.
- `staging:` and `rules:` fix the room and the screen sides for the whole script
  or, as a scene-level block, for one scene (F-run 6).
- Balloon cues for voicing come from a matching story line or are written by the
  director; the comic script carries them the same way as the story file.

### 4.3 Errors and warnings

`story check` reports, with file, line and column:

| Code | Kind | Example |
|---|---|---|
| `missing-front-matter`, `bad-yaml`, `unknown-key`, `missing-field` | error | no `title`; `narator:` |
| `unknown-speaker` | error | `**MAYOR**:` with no MAYOR in the cast |
| `bad-duration` | error | ` ```pause ` containing `soon` |
| `misplaced-music` | error | a ` ```music ` cue after a scene's first line |
| `layout-mismatch` | error | a page whose `layout:` has 5 slots but 6 panels |
| `bad-continue` | error | `continue:` naming a panel that doesn't exist or comes later |
| `missing-cue` | warning | a line or balloon with no cue (F-run 5) |

## 5. Voices

Settled by F-run 5 ("C is infinitely better"):

- **One line per call, on a verbatim TTS model** (`gemini-3.8-flash-tts`).
  The spoken text and the delivery note are separate fields, so notes are never
  spoken. The existing `GeminiTTSProvider` already supports this.
- **The delivery note** is the character's default delivery, the line's cue, and
  the two previous lines in the same scene ("Just before this, June said …").
- Two-speaker runs are not used: they sounded natural but leak notes into the
  audio and can't be cut into per-line clips without a forced aligner (F-run 3,
  5).
- **Refusals fall back, never fail the build**: full note, then cue only, then
  no note. The fallback is recorded (F-run 2, 4).
- **Every line is checked**: transcribed alone (`gemini-3.5-flash-lite`, one
  request per clip; batching drifts) and compared word by word with the line,
  after normalizing numbers, contractions and compounds. A mismatch re-renders
  with a fresh take up to twice; a line that still fails is reported for a
  person, with what was heard (F-run 3, 5).
- Measured once per model and recorded, not corrected yet: clips carry about
  260 ms of silence before and 360 ms after, and audio costs 25 output tokens per
  second (F-run 1, 2).

## 6. Music

Settled by F-run 3:

- Each ` ```music ` cue becomes one Lyria clip (`lyria-3-clip-preview`, about 30
  s, instrumental).
- Mix: 3 s of music alone before the scene's first line, then a bed at about
  −10 dB fading out after 16 s; the first cue's theme returns over the ending.
- Longer scores (crossfaded clips or full songs) wait until a story needs one.

## 7. Art

Settled by F-run 3, 4 and 6 (C was chosen):

1. **Character sheet** per style, from the cast's `look` (one image).
2. **Staging image** per scene, from `staging:`, drawn against the sheet and
   **checked on model before anything is drawn from it** (a drifted staging
   image spreads to every panel; F-run 6).
3. **Each panel** is drawn with: the style; the art note; the acting note; the
   panel's and the previous panel's dialogue as context, marked "do not write";
   the rules; and references (sheet, staging, previous panel). `continue:`
   panels are edits of the panel they continue.
4. **Wording that works** (F-run 4): "one full-bleed illustration… no text";
   headroom as "the top quarter shows only background scenery" (never "leave
   space for balloons", which draws empty boxes); "extreme close-up: only her
   face, filling the frame" for narrow close-ups.
5. **Every image is checked** with yes/no questions: on model (hair, clothes,
   from the cast's `look`), no written words, the staging and screen sides, and
   the questions the acting note implies. Up to two redraws; the panel with the
   most passes is kept and the failures reported.
6. **Head boxes**: one vision call per finished panel returns where each named
   character's head is, for lettering (F-run 4).

Default image model `gemini-3-pro-image`; `gemini-3.1-flash-image` is half the
time and less faithful (F-run 3).

## 8. Pages, lettering and reading

Settled by F-run 4:

- Page geometry: a 2:3 page; rows share the height; panels share a row by
  weight; each panel is drawn at the nearest supported aspect ratio and cropped
  to its slot.
- **Lettering is live text laid out by code**: caption boxes, oval balloons,
  tails, sound effects, in a lettering face. Items take the best free spot in
  reading order, never over a head, as high as possible, captions to the left,
  balloons near their speaker above or beside the head. Tails end just short of
  the speaker's head. Spelling is always exact (model lettering misspelled small
  text, F-run 3).
- Lettering size follows the page; the **guided view** re-letters one panel at a
  minimum readable size for phones.
- **Reading**: page view; guided view (one panel at a time, tap or arrow keys);
  tap any caption or balloon to hear it; "read aloud" voices a panel in order and
  turns to the next.

## 9. Caching

A render's key is a SHA-256 (Web Crypto) of everything that affects its bytes:

| Render | Key includes |
|---|---|
| Line audio | provider, model, voice, full delivery note **including the context lines**, spoken text, language, render version |
| Music clip | model, prompt, render version |
| Character sheet | model, style, looks |
| Staging image | model, style, staging text, sheet key |
| Panel | model, style, full prompt, reference keys (so a redrawn staging image redraws its panels) |
| Head boxes | model, panel key |

- Keys never include ids or positions; inserting a line renumbers files only.
- Because the note includes the two previous lines in the scene, editing a line
  re-renders it and the next two lines in that scene. That is intended: their
  context changed.
- A failed check never caches the take as accepted; a take that passes is kept.

## 10. Runtime boundaries

All ffmpeg use stays behind one small interface so a browser implementation can
replace it later (unchanged from the previous design):

```ts
interface AudioRuntime {
  probe(input: MediaHandle): Promise<{ durationMs: number }>;
  mix(plan: MixPlan, out: { loudnessLufs: number; truePeakDb: number }): Promise<MediaHandle>;
  encode(input: MediaHandle, format: 'mp3' | 'wav'): Promise<MediaHandle>;
}
```

`MixPlan` is the timeline's clips plus music beds with their gain envelopes. Image
conversion (PNG to WebP) uses the same runtime when the art milestone needs it.
ffmpeg resolution and licensing notes are as before: `MDMEDIA_FFMPEG`, an
installed `ffmpeg-static` (optional peer dependency, GPL-3.0), then `PATH`.

Providers are passed in, never read from globals: `tts`, `transcriber`, `music`,
`image`, `vision`. Each wraps an existing mdmedia provider where one exists.
Busy-model errors (429, 500, 503, timeouts) retry with backoff; concurrency is
limited per provider because quota, not speed, is the practical limit (F-run 2,
3).

## 11. CLI

| Command | Milestone | What it does |
|---|---|---|
| `mdmedia story check <file> [--json]` | 0 (story), 4 (comic) | Parse and validate; `file:line:col severity code message`; exit 1 on errors |
| `mdmedia story build <story.md> [--out] [--cache] [--json]` | 1, 2 | Voice, check, schedule, mix; write `dist/` |
| `mdmedia story direct <raw.md> -o <story.md>` | 3 | Director: raw text to a story file, looping on `check --json` |
| `mdmedia story draw <comic.md> [--json]` | 4 | Reference images and panels, checked; head boxes |
| `mdmedia story comic <comic.md> [--out]` | 5 | Comic voices, pages, lettering, reader site |
| `mdmedia story adapt <story.md> -o <comic.md>` | 6 | Director: story file to comic script |

Exit codes: `0` success; `1` errors in the source; `2` provider failure; `3`
ffmpeg missing; `4` built, but some renders still fail their checks (listed in
`build.json` and the `--json` output); `130` cancelled. `story` is never chosen
by extension routing.

## 12. Output

```
dist/<slug>/
  build.json                       # renders, checks, fallbacks, failures, costs
  script.json                      # parsed story
  timeline.json
  audio/
    <slug>.mp3
    master.wav
    lines/<scene>/<NNNN>-<speaker>.wav
    music/<scene>.mp3
  comic/                           # graphic novel milestones
    comic.json                     # parsed comic script with head boxes and line timings
    art/<style>/sheet.png, staging-<scene>.png, panel-<PNN>.png
    voices/<NNNN>-<speaker>.wav
  reader/                          # static site: index.html, img/, audio
  text/transcript.md
```

`build.json` lists every render with its check result: the transcript and diff for
a line, the answers for an image, the fallback used, and attempts. A person
reviews the failures, not the whole production.

## 13. Testing

| Layer | How |
|---|---|
| Parsers | Golden JSON for fixtures taken from the prototype (`story.md`, `comic-lunch.md`); one test per error and warning code |
| Cache keys | Inserting a line changes no unrelated key; editing a line changes it and the next two; changing a look changes the sheet and everything drawn from it |
| Transcript diff | Fixed pairs from the prototype: noise that must pass ("lawnmower" for "lawn mower", "gonna"), defects that must fail (a dropped "Clip", an added "Ugh") |
| Balloon layout | Fixed panel sizes and head boxes; balloons never overlap a head or each other; reading order holds |
| Audio runtime | One contract suite against the Node implementation; skipped with a reason without ffmpeg |
| Build | Fake providers (tones for voices, a solid image for art, a scripted transcriber and vision model) so CI needs no network; check the tree, `build.json` and that a scripted transcript mismatch triggers a re-render |

## 14. Milestones

| # | Milestone | Usable at the end |
|---|---|---|
| 0 | Story file parser, `story check` with errors and warnings, schemas | Write a story file and get exact errors and cue warnings; no audio |
| 1 | Voices: line-by-line in context, refusal fallbacks, transcript checks with re-renders, cache, schedule, mix, `story build` | An audio drama MP3 where every line is checked; edit one cue and only it and its next two lines re-render |
| 2 | Music cues, leads, beds, theme outro | A scored audio drama, as in the prototype's run 3 |
| 3 | Director: `story direct raw.md` writes `story.md` with cast, a cue on every line, pauses and music cues; loops on `story check --json` | Paste a story, get an editable production script |
| 4 | Comic script parser and art: sheets, staging, panels in context, edit chains, image checks, head boxes | Drawn, checked panels for a comic script |
| 5 | Pages, lettering, comic voices, reader (page view, guided view, tap to hear) | The graphic novel, as in the prototype's lunch scene |
| 6 | Director for comics: `story adapt story.md` writes `comic.md` (page breakdown, art and acting notes, staging) | From a story file to a comic script you can edit |

Open, each waiting for evidence or a key:

- **Sound effects**: untested; needs an ElevenLabs key.
- **MP4**: a 20-minute video exceeds artifact limits; local output only, after 5.
- **Many voices overlapping** (Alice): placed clips instead of a sequence.
- **Narrator as inner voice** (Holmes): a per-line audio effect.
- **Credits and M4B chapters**: from the previous design; after 2 when wanted.
- **Studio `story` media type**: after 5.
- **Clip edge trimming**: measured, not yet heard to matter with context voices.

## 15. Decisions

Carried over from 2026-10-18: the name `story`; the line syntax
`**NAME** *(cue)*: text`; 48 kHz stereo master; ffmpeg resolved at runtime with
`ffmpeg-static` as an optional peer; credit templates you can override.

New, from the prototype:

1. **Voices: one line per call on a verbatim model, with context.** Replaces
   "one provider call per line" and drops two-speaker runs (F-run 5).
2. **Every render is checked**: transcript diff for audio, yes/no questions for
   images, with bounded redos and a report (F-run 2, 3, 5, 6).
3. **Two source files**: the story file for the audio drama and the comic script
   for the graphic novel, both written by the director and editable by people
   (F-run 4).
4. **Lettering is code**, positions come from a vision pass (F-run 4).
5. **Art consistency**: character sheet, checked staging image, acting notes,
   previous-panel references, edit chains (F-run 6).
6. **Music: Lyria clips per scene** with leads and beds (F-run 3).
