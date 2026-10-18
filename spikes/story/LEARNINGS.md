# Story spike: learnings

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
