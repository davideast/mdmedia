# Story prototype: findings

Copied from the throwaway `spike/story` branch (`spikes/story/LEARNINGS.md`, commit 41562c4). Tool names refer to scripts on that branch.

Run 1, 2026-10-18, `lighthouse.md` (1,185 spoken characters), model
`gemini-3.1-flash-tts-preview`, four calls in flight.

## Measured

| | line | run |
|---|---|---|
| API calls | 16 | 9 |
| Audio | 120.9 s | 107.7 s |
| Wall time | 22.3 s | 16.6 s |
| Output tokens (audio) | 2,815 | 2,556 |
| Input tokens | 537 | 636 |

- **Audio costs 25 output tokens per second**, in both modes. A 10-minute
  story is about 15,000 audio tokens; input is noise next to that.
- **Each call takes 0.4 to 0.9 times its audio length**, so four in flight
  render about five times faster than real time. Speed is not a reason to
  cache yet; money might be, depending on the price per audio token.
- **Every clip carries its own silence: about 250 ms before and 300 ms after**
  (lead 140 to 730 ms, tail 0 to 890 ms). With the 400 ms gap, the real
  space between two lines is about 950 ms, and it varies by call. The gaps
  we write are not the gaps we hear.
- **Run mode is 13 s shorter** for the same text, mostly from seven fewer
  sets of clip edges and gaps. Inside one multi-speaker call the model
  places its own turn pauses (5 to 8 pauses over 300 ms per call).
- **The `0ms` pause tested nothing.** I placed it after Mara's interruption
  instead of between `She says—` and her line, so the interruption itself
  got the full gap plus both clip edges, about 940 ms. Line mode cannot make
  an interruption without trimming clip edges.

## Heard

_To fill in from listening:_

1. Delivery cues (whisper, sharp, barely audible): audible?
2. Mara across seven separate calls: one person?
3. Run mode: more like a scene? Right voice per speaker? Any speaker labels
   or bracketed cues read aloud?
4. Gaps: natural or mechanical?
5. Mara's whisper (`line/calls/014-mara.wav`) ends without a quiet tail; is
   it cut off?

## Run 2 inputs: real texts

Two public domain texts from Project Gutenberg, adapted by hand (Claude as
director), so the director step is being exercised too:

- `pride-and-prejudice-34.md`: the full proposal scene. Narrator plus two
  speakers.
- `earnest-act-1.md`: from the opening to "What on earth do you mean by a
  Bunburyist?". Three speakers plus one narrated setting.

Director decisions made while adapting, each a candidate rule or a judgment
to leave to the model:

- **Speech tags dropped** ("replied she", "said Darcy"); their manner became
  delivery ("in a less tranquil tone, with a heightened colour" → `less
  tranquil, colour heightening`).
- **Speech broken by narration** ("But, perhaps," added he, stopping in his
  walk, "these offences…") became two lines by the same speaker with
  different deliveries; the action went into the second line's delivery.
- **Stage directions** in the play became delivery when they describe manner
  (`[Languidly]`) and were dropped when they describe action that sound
  cannot carry (`[Hands them on a salver]`). Entrances and exits were dropped
  or replaced by a pause.
- **Mid-line interruption by action** ("Divorces are made in Heaven—" then
  Algernon snatches the plate) became two lines with a `0ms` pause between.
- **Pauses** were added where the text names a silence ("The pause was to
  Elizabeth's feelings dreadful") and after exits.
- **Italic emphasis** (`*feel*`, `*there*`) is kept in the display text and
  lost in the spoken text. Whether the TTS should get emphasis is open.

Run mode now caps each call at 1,500 characters (`--max-run`), because an
uncapped Earnest run reached 3,040 characters, about three and a half minutes
in one call.

## Run 2 measured

| | calls | audio | wall | audio tokens | chars per audio second |
|---|---|---|---|---|---|
| P&P line | 31 | 750 s | 103 s | 18,053 | 13.0 |
| P&P run | 12 | 714 s | 91 s | 17,650 | 13.9 |
| Earnest line | 76 (1 refused) | 733 s | 112 s | 17,428 | 10.9 |
| Earnest run | 12 | 636 s | 81 s | 15,750 | 12.6 |

- **Run mode speaks faster, not just with fewer gaps.** Earnest is 97 s
  shorter in run mode; about 70 s of that is 64 fewer gaps and clip edges,
  the rest is delivery: 12.6 characters per second against 10.9. One-line
  calls are slower and more deliberate, which may suit drama and hurt comedy.
- **Clip edges are the same everywhere**: about 260 ms lead and 360 ms tail
  across all six renders. That is a property of the model, so it is
  measurable once and correctable mechanically.
- **Cost is still 25 audio tokens per second** in every render. A 12-minute
  chapter is about 18,000 audio tokens per mode.
- **Rendering is about seven times faster than real time** with four calls in
  flight.
- **The safety filter refused a harmless line.** Earnest line mode, Jack:
  `[earnest, easily flustered, trying to keep his dignity]\nIn the country.`
  The same words passed inside a longer run-mode prompt. Short single-line
  prompts seem more exposed to false positives, so a build needs per-call
  failure reporting, a retry, and a way to rephrase the cue or merge the line
  with a neighbour. The render must not die on one refusal.

## Run 2 checked by a model listener

`check.ts` sends a render (downsampled to 32 kb/s mono) and its story file
to `gemini-3.5-flash` and asks for timestamped problems. Each flagged moment
was then transcribed on its own to confirm it.

- **The checker is a usable screen, not proof.** With four errors planted in
  the script it caught three (a changed word, a reassigned line, a deleted
  line) and missed one ("Divorces" changed to "Marriages"). Its free-text
  notes praised every render and are worthless.
- **Real: TTS dropped the end of a line.** P&P line mode, Darcy: "My faults,
  according to this calculation, are heavy indeed!" ends at "are"; the last
  two words are missing from the clip. A build needs a verify step that
  compares each clip's transcript with its text and re-renders on mismatch.
- **Real: run mode read markup aloud.** Earnest run mode: "Algernon. Reading
  aloud, relishing it." was spoken before the line. The multi-speaker prompt
  format (`NAME: [cue] text`) leaks into the audio.
- **False alarm: "wrong voice".** Algernon's aside after Lane leaves was
  flagged as the narrator's voice; a voice-labelled transcript shows it is
  Algernon's voice, and that call could only use his voice.
- **A clip with no quiet tail is not a truncation signal.** Four clips ended
  without one; only one (the Darcy line above) was cut. The others end on a
  whisper or a trailing comma.
- **Refusal fallback works.** Jack's refused line rendered with its line cue
  only (`fallback: "line cue only"` in the report).
- **Quota**: checking four 12-minute renders back to back hit 429s on
  `gemini-3.5-flash`; `gemini-3.5-flash-lite` served the short transcriptions.

## Run 3: a whole graphic novel with music (The Most Embarrassing Day of My Life)

Input: `embarrassing-day/raw.md` (the author's text, untouched), adapted by
hand into `embarrassing-day/story.md` (notation) and `embarrassing-day/panels.json`
(51 panels). Output: a private reader page with four art versions, one audio
track and panel sync.

Pipeline, each step a separate throwaway tool:

| Step | Tool | Result |
|---|---|---|
| Voices | `render.ts --mode run` | 24 calls, 19.3 min, about 2.8 min wall |
| Check | `check.ts`, `tools/transcribe.ts` + word diff | 2 real defects found, fixed by re-rendering 2 calls |
| Music | `tools/music.ts` (Lyria `lyria-3-clip-preview`) | 8 clips of about 30 s, 10 to 14 s each |
| Mix | `tools/mix.ts` | 3 s music lead per scene, bed at -10 dB fading after 16 s, theme over the ending; 19.9 min |
| Art | `tools/art.ts` | character sheet per style, then 51 panels against it; 204 panels, 0 failures |
| Page | `tools/page.ts` + `tools/reader.html` | WebP panels, 96 kb/s MP3, timeline inlined; one Artifact publish |

Findings:

- **Narrator as a cast member works.** `narrator: MILO` puts narration in
  Milo's voice, so a narration run with June is a two-speaker call. 289 lines
  became 24 calls.
- **Run mode loses per-line timing.** A run call returns one clip, so line
  times inside it are estimated by character share. Good enough for panel
  sync at this granularity; captions word-synced to audio would need forced
  alignment or line mode.
- **The fixed prompt format (notes "never say them aloud") still leaks
  sometimes.** In 19 minutes: one cue read aloud ("calling from down the
  hallway") and one duplicated line ("My stomach did a backflip" twice).
  A re-render with a new cue then read *that* cue aloud ("typing fast,
  thrilled"). Cues that describe an action leak more than cues that describe a
  feeling; the third take with `(thrilled)` was clean. Leaks are per take,
  so verification after every render is required, not a one-time fix.
- **Transcript plus word diff is a better checker than asking a model for
  problems.** The diff found both real defects; three other diffs were
  transcription noise and were ruled out by transcribing short windows. The
  model listener (flash-lite) reported one false problem and missed both.
- **Caching makes fixes cheap.** Editing two cues in the story file
  re-rendered 2 of 24 calls (35 s) and nothing else.
- **Character consistency is strong** with a character sheet as the reference
  image: outfits, hair and proportions held across 51 panels in every style.
  Scene settings must be stated per panel or the model invents them (June's
  cafeteria close-up first came back with a hallway behind her).
- **Image models still write text into the art** (posters, milk cartons,
  "REFUND") despite "no text"; harmless here.
- **Model lettering is good in big bubbles and bad in small text.** Speech
  bubbles were spelled right; the tiny phone screen read "autdiion" and
  "Thankel". Page lettering stays exact and editable; model lettering looks
  more like a comic.
- **Flash image drew the manga version in half the time** and added spot
  color (June's yellow cardigan) to a black-and-white style it was told to
  keep monochrome.
- **Lyria clips are fast and short (30 s)**, which suits scene intros and
  beds; a continuous score would need longer songs or crossfaded clips.
- **Quota is the practical limit.** Checks on `gemini-3.5-flash` hit 429s
  repeatedly; `flash-lite` was available throughout.

Open questions for the design:

- Should panel timing come from the timeline (as here) or from the director
  naming the line a panel starts on (also as here)? Both were needed.
- Text placement on panels is naive (captions top, bubbles bottom). A
  director step could name a bubble position per panel, or the art step
  could leave space.
- Sound effects are still untested (no ElevenLabs key).

## Run 4: traditional comic format (the lunch scene)

`embarrassing-day/comic-lunch.md` is a comic script in the trade's page and
panel format: `## Page N` with a `layout:` of panel rows, `### Panel N` with a
`>` art note (shot, who stands left/center/right, balloon zone), then
captions, balloons and sound effects in reading order. 4 pages, 21 panels,
38 captions and balloons. Tools: `comic.ts` (parse, slot geometry, art plan),
`art.ts --bleed`, `faces.ts`, `comic-audio.ts`, `render.ts --mode line`,
`comic-page.ts` + `comic.html`.

- **Adapting prose to comics is the main judgment.** The scene's 42 story
  lines became 38 lettered items on 21 panels; most narration became
  pictures. "Not angry. Worse. Hurt." became three close-ups, one caption
  each. This is director work; the notation only has to carry its result.
- **"Leave space for balloons" makes the image model draw empty boxes.**
  Three of five panels came back with blank white frames. Asking for a
  full-bleed image with headroom ("the top quarter shows only background
  scenery") fixed it.
- **Narrow slots override "tight close-up".** Two of three narrow close-ups
  came back as full figures. "Extreme close-up: only her face, filling the
  frame from her bangs to her chin" plus dropping the headroom rule for
  close-ups worked first time.
- **Lettering needs to know where heads are.** Guessed speaker sides put
  Harper's balloons over her face. A vision pass (`gemini-3.5-flash`, one
  call per panel, boxes 0-1000) found every named head correctly in all 21
  panels; the layout then places items in reading order off faces, and tails
  end just short of the speaker's head.
- **Code owns lettering, model owns positions.** Balloons, tails, caption
  boxes and reading order are deterministic page code (live text, exact
  spelling); the model only supplies head boxes. Page lettering stayed exact
  where model lettering misspelled small text in run 3.
- **When art leaves no headroom, balloons go below the speaker.** Readable,
  but a letterer would ask for more room; joined balloons for consecutive
  lines by one speaker would help.
- **Line mode suits comics.** One clip per caption or balloon gives exact
  ranges for tap-to-hear and guided read-aloud. 37 lines, 131 s, 38 s wall;
  4 short lines were refused by the input filter and rendered with their cue
  dropped, which matches the earlier finding that short single-line prompts
  trip the filter.
- **Lettering scales with the page, which is too small on a phone.** The
  page view letters at print size (2% of page width); the guided view
  re-letters one panel with a minimum size so it reads on a phone. Wide
  panels on a portrait phone get crowded.

## Run 5: making line-by-line voices follow each other (lunch scene)

Line mode renders each balloon alone, so tone resets between lines. 20 of the
37 lines also had no cue: cues were borrowed from the story file by text match
and the rest fell back to the character default. Four takes of the same 37
lines (`embarrassing-day/comic-lunch-voices.md` holds the new cues):

| Take | How | Lines exact by transcript* | Real problems found |
|---|---|---|---|
| A | line mode, borrowed cues (what was heard) | 23/37 | "Heh" dropped; an "Ugh" added before "You promised" |
| B | line mode, a context-aware cue on every line | 27/37 | "I tried to laugh" dropped; whispered "The dancing one" garbled; "pleading" added an "Ugh" |
| C | `gemini-3.8-flash-tts`, cue plus the two previous lines as a `speech_metadata` note | 29/37 | "Clip" dropped from "What. Clip."; "but" cut from "I know, but—"; "Heh" became a real laugh |
| D | two-speaker runs, cut into balloons | content complete | cuts wrong: see below |

*Most remaining mismatches are transcription noise ("lawnmower", "gonna",
"Harper Black"); the problems column is the ones that hold up.

- **Every line needs a cue, written with the previous line in mind.** That is
  director work, and it is cheap. Emotion-only cues; action cues leak.
- **The verbatim model takes notes in a separate field and never spoke them**,
  including the context ("Just before this, June said ..."). Its text
  fidelity was the best of the three, and it voices non-verbal sounds
  ("Heh" as a laugh). It also clips trailing words after a dash or full stop
  more readily ("What. Clip." -> "What?").
- **Runs cannot be cut into balloons with what we have.** Snapping to pauses
  put nearly every cut one segment off (9/37), because turn pauses inside a
  run don't match line boundaries. Asking Gemini for per-line start and end
  times fixed the first lines and then fell apart around line 20 (12/37).
  Per-balloon clips from a run need a real forced aligner, which is a new
  dependency, or tap-to-hear per panel instead of per balloon.
- **Batch transcription drifts.** Sending 37 clips in one request shifted
  answers by a clip and merged neighbours; one request per clip works.
- **Short, quiet lines are the weak spot in every take**: whispers garble,
  sighs get added, the filter refuses some (A needed 4 fallbacks, B 1, C 0).

**Verdict (by ear): C is far better than A and B.** The build voices lines
one at a time on a verbatim model, with a context-aware cue on every line and
the previous lines passed as a delivery note. Its remaining defect (a word
clipped after a dash or full stop) is exactly what the per-line transcript
check catches, so verify-and-re-render stays in the pipeline.

## Run 6: making panels follow each other (lunch scene, page 3 and page 4 panel 1)

Each panel was drawn alone from a note that said what happens, not what it
means, so seats moved, June lounged through "You sent my video?", and the
three close-ups were three different faces. Seven panels in three takes
(`embarrassing-day/art-context.json`, `tools/art-context.ts`):

| Take | How | Result |
|---|---|---|
| A | as before: art note only | inconsistent seats, wrong tone, drifting faces |
| B | an acting note written in context for each panel, plus the panel's and the previous panel's dialogue as context | tone right (shock, hurt, pleading); the room changed every panel (a brown table in an empty room); faces still drifted |
| C | B plus a staging image for the scene, a screen-side rule, earlier panels as references, edit chains for the close-ups, and a yes/no vision check with up to two redraws | same table, seats and camera across panels; the three close-ups are one face with only the expression changing (identical head boxes) |

- **Edit chains are the image version of passing the previous lines.**
  "Same panel, same face; change only her expression" kept framing and
  identity exactly across three panels.
- **A staging image fixes the room**, and the screen-side rule (June left,
  Milo right) keeps two-shots readable.
- **A drifted reference spreads.** The first staging image gave June long
  hair; every C panel copied it and the panel checks passed it. The staging
  image now gets its own on-model check before anything is drawn from it,
  and every panel check asks on-model questions (hair, clothes).
- **Dialogue passed as context leaks onto the page.** One panel came back with
  garbled drawn balloons; a "no written words" check caught it on the redraw.
- **The vision check only catches what it is asked.** It passed long hair and
  wrong trousers until asked about them; it reliably failed the drawn text
  once asked. Concrete questions from the script and the character sheet,
  never "is this good".
- Cost for C: 1 staging image, 7 panels, one redraw; about 10 image calls and
  9 checks.

## Cases for later

- **Many voices (Alice, the Mad Tea-Party).** Render each voice or pair in
  isolation and interleave them like a real radio production, including
  overlaps, rather than forcing everything through two-speaker calls. This
  makes the timeline a mix of placed clips, not a sequence.
- **Narrator who is also a character (Holmes, Watson).** Watson's narration
  and his dialogue are one voice; the narration can get a post-production
  effect so it sounds like thought, inside his head. That makes per-line
  audio effects a production feature, and the speaker model needs "narrator
  is cast member X".

## What this changes in the design (provisional)

- The silence between lines is decided by the model's clip edges as much as
  by our gap, so timing needs either measured trimming or the model's own
  turn-taking (run mode). The design removed silence trimming as unproven;
  it is now proven to matter for timing, if not yet by ear.
- The unit of rendering may not be a line. If run mode sounds better, the
  timeline's clip is a run of up to two speakers, and the cache key covers
  the run.
