# Checking performance continuity

A cut can match and still feel wrong: the next shot gets the scene and the
person right, but the delivery is out of flow, a separate performance at a
different energy, pitch or pace. `mdmedia cut check` looks for that in a
cut's [performances](cut-format.md#performances), the groups of lines that
must sound like one continuous delivery, and `mdmedia cut storyboard` gives a
shot the context it needs so it isn't generated out of flow in the first
place. This is part one of performance continuity (Idea 4 in
`plans/video-production-kit-ideas.md`). Both take each speaker's
[character](characters.md) from the production's cast: `cut check` holds
their lines to the character's reference levels, and `cut storyboard` writes
in their look and delivery profile.

```sh
mdmedia cut check docs/cuts/big-hal-take5.cut.json            # measured, every time
mdmedia cut check docs/cuts/big-hal-take5.cut.json --listen   # and the listening check (slow)
mdmedia cut check docs/cuts/big-hal-take5.cut.json --json
mdmedia cut storyboard docs/cuts/big-hal-take7.cut.json the_guarantee --out boards/hal8-guarantee.md
```

| `cut check` option | Means |
|---|---|
| `--listen` | Also run the listening check on each performance whose stored result is missing or stale |
| `--force` | With `--listen`, listen again to every performance |
| `--json` | Print the check file's contents (and what was kept or dropped) instead of tables |
| `--listener <name>` | The listener: `gemini` (the default and only one) |
| `--root <dir>` | The media root (default `MDMEDIA_CUT_MEDIA_ROOT`, else the cut's `media.root`) |
| `--production <manifest>` | The production whose cast gives each speaker's reference levels (default: the manifest in `docs/productions` that lists this cut) |
| `--no-cast` | Check without the cast's reference levels |

The results go to `<name>.check.json` next to the cut and its words file.
The command prints them as tables: every line, then each performance's
boundaries and cuts, the flags, and the listening check, marked **filter
only**.

## What is measured

**Measured from a render of the cut's dialogue**: the cut rendered with
`planRender` (see [cut-render.md](cut-render.md)) without its music, sound
effects (including those laid into segments), overlays and picture look,
sound only, as mono 48 kHz. That is every segment's own sound and every line
with its own sound, at the cut's volumes, fades and layers: the voices as
the audience hears them, with the room tone each shot carries, and without
the music that would throw the pitch tracker and the room-tone levels. (The
sources alone would miss the cut's gains: Take 7 lifts "four seats" 2.4 dB
in the edit.) Only the chains of the render graph that the sound is made from
are run (`soundFilters`, `soundArgs`), so no picture is decoded: Big Hal
Take 5's 27 s render in about 0.2 s. (Discarding the picture into a
`nullsink` instead left ffmpeg 7 deadlocked now and then; every check render
also has a timeout, and a stuck ffmpeg is killed.) Times come from the words file
(`mdmedia cut words`); a line without fresh words is measured over its whole
span and gets no rate or pauses.

For every line (sung lines excepted):

| Measure | How |
|---|---|
| Loudness | ITU-R BS.1770 gated loudness over its speech (first word to last), K-weighted, mono, in LUFS. A stretch under 400 ms is one block |
| Pitch | A YIN detector (de Cheveigné and Kawahara) on a 16 kHz copy, 10 ms frames inside its words, 60–500 Hz, threshold 0.15: the median in Hz and the range from the 10th to the 90th percentile in semitones |
| Rate | Words per second of speech, from the words file, and syllables per second (an estimate from vowel groups) |
| Word levels | Each word's ungated loudness |

For each boundary between two of a performance's lines:

| Measure | How |
|---|---|
| Pause | From the last word of the first line to the first word of the next, from word timings, never from the model |
| Δ loudness, Δ pitch | The edges: the words nearest the boundary, at least 0.8 s of speech (or the whole line), on each side; their gated loudness and median pitch |
| Δ rate | Syllables per second, line against line, as a fraction of the slower; not judged when either line has fewer than 4 syllables |

A boundary with another speaker's lines between (Rick's lines with Buddy's
answers between them) is judged on loudness alone: across an exchange the
energy should carry, but pitch, pace and pauses move with it.

For each segment cut inside a performance (inside one of its lines, or in
the gap between two of them with nothing else said): the room tone just
before and just after, the median level (RMS, dBFS) of the 20 ms frames
within 0.6 s of the cut that are clear of every word (by 50 ms) and of every
cut (by 30 ms, the shots' mix fades). With fewer than 3 such frames on a side,
its segment's other quiet frames are used (`wide`).

Each performance's words are also compared with its median word: a word more
than `word` LU louder is flagged.

### Thresholds and flags

| Flag | When | Default |
|---|---|---|
| `splitting-rule` | The resolver found the performance breaks [the splitting rule](cut-format.md#the-splitting-rule) | |
| `loudness-jump` | \|Δ loudness\| across a boundary is over `loudness` | 2.5 LU |
| `pitch-jump` | \|Δ pitch\| is over `pitch` | 10 semitones |
| `rate-jump` | \|Δ rate\| is over `rate` | 0.4 (40 %) |
| `long-pause` | The pause is over `pause` | 0.6 s |
| `room-tone-jump` | The room tone changes by more than `roomTone` across a cut | 5 dB |
| `loud-word` | A word is over `word` LU above the performance's median word | 6 LU |
| `outside-reference` | A line is outside its speaker's reference levels (below) | |
| `unmeasured` | A line has no word timings (a note, not a flag on the performance) | |

The defaults come from the calibration below. A cut overrides them with
`check.thresholds` and a performance with its own `thresholds`
(`thresholdsFor(timeline, performance)` merges them).

### The hook for characters' reference levels

`measureCut(timeline, stem, { reference })` and `checkCut({ reference })`
take `reference: (speaker) => ReferenceLevels | undefined`. Reference levels
are ranges (`{ min?, max? }`) of `loudness` (LUFS), `pitch` (median Hz),
`pitchRange` (semitones) and `rate` (words/s), with a `source`, measured from
a character's approved lines. A line outside them is flagged
`outside-reference` ("loudness -19.2 LUFS is above Big Hal's reference,
-22 LUFS (approved lines in Take 7)"). The CLI passes the cast's
(`castReference`): each speaker's character version, its levels measured
from approved lines by `mdmedia character measure`, quoted as `big-hal@1,
from 6 approved lines`. See [characters.md](characters.md#in-mdmedia-cut-check)
for what they flag on the seeded productions.

## The listening check

With `--listen`, each performance's stretch of the cut (its speech, with
0.5 s either side) is rendered as a small preview MP4, picture and sound,
the whole mix, and sent to a `Listener` with the exact facts and its
questions. It is a **filter for obvious failures, not the judge**: the
owner's ear decides, and nothing it says approves a take.

The questions are about phrases, with their exact times in the clip, never
about cuts:

- for each pair of the performance's lines: `Do "X" (a–b s) and "Y" (c–d s)
  sound like one continuous delivery by the same speaker, rather than two
  separately recorded deliveries?` (a performance of one line: `Does "X"
  sound like one continuous delivery all the way through…?`), expecting yes;
- for each line: `Is any word in "X" (a–b s) shouted?`, expecting no;
- its `delivery`, and each line's: `Is "X Y" (a–d s) delivered like this:
  <direction>? Answer yes or no.`, expecting yes.

The facts are every line heard in the clip, with its speaker and its times
from the words. Each answer is stored as the model gave it (`verdict`,
`confidence`, `heard`, `why`), read as `yes`, `no` or `unclear`
(`readVerdict`), and marked `agrees` when the reading is what the question
expects; an unclear or missing answer never agrees. The table shows `ok`,
`FAILS` or `unclear`, with what it heard for each failure.

`Listener` is an interface, like `Aligner`, so the model can change:

```ts
interface Listener {
  readonly name: string;
  listen(request: { clip: { bytes, mimeType, seconds }, facts: string, questions: Array<{ id, ask }> }): Promise<{ model, canHearAudio, answers: Array<{ id, verdict, confidence, heard, why }> }>;
}
```

`GeminiListener` (`src/cut/listen-gemini.ts`) is the CRT TV production's
`judge.mjs` ported: the clip inline, the same prompt and JSON schema, model
`gemini-3.8-flash` (the one that hears audio; the lite models and
`gemini-4-argon` don't), retried with backoff when the model is overloaded
(503). Its key is `GEMINI_API_KEY`; `MDMEDIA_LISTEN_MODEL` changes the
model. A refused key stops the run (`ListenerUnavailableError`) after saving
what it heard. A performance takes about a minute to hear, so each result is
saved as it comes.

## The check file

`<name>.check.json`, format `mdmedia.cut-check@1`:

```json
{
  "format": "mdmedia.cut-check@1",
  "measured": {
    "method": "dialogue-stem@1", "source": "a render of the cut's dialogue: …", "range": { "from": 0, "to": 27.31 },
    "lines": [ { "id": "every", "speech": { "start": 9.98, "end": 13.84 }, "loudness": -25.8,
                 "pitch": { "median": 211.5, "low": 131.8, "high": 260.5, "range": 11.8, "voiced": 0.71 },
                 "rate": { "words": 2.59, "syllables": 3.89 }, "wordLevels": [ … ], "flags": [] }, … ],
    "performances": [ { "id": "inspection", "thresholds": { … }, "boundaries": [ … ], "cuts": [ … ], "splits": [ … ], "flags": [ … ] }, … ],
    "fingerprints": { "lines": { "every": { … } }, "performances": { "inspection": { … } } }
  },
  "listening": {
    "inspection": { "filterOnly": true, "listener": "gemini:gemini-3.8-flash", "model": "gemini-3.8-flash",
                    "clip": { "from": 9.48, "to": 15.48 }, "canHearAudio": true, "answers": [ … ],
                    "fingerprint": { … }, "heardAt": "2026-10-19T…" }
  }
}
```

A fingerprint says what a result was taken from, so results go stale as
words files do: the stretch of the cut (`from`, `to`), the SHA-256 of every
source file heard there (by its ref), and a `digest`, the SHA-256 of
everything on the timeline in that stretch (segments and lines, and for the
listening check music and sound effects too, as resolved, without labels or
absolute paths), the method, and for the listening check its questions,
facts and listener. Relabelling a segment, or editing elsewhere in the cut,
changes nothing; moving a shot or replacing a take in the stretch does
(`fingerprintMaterial`, `fingerprintChange`). The measured part is redone on
every run (it is quick); a stored listening result is kept while its
fingerprint matches (`kept` in the table), and dropped, with the reason,
when it doesn't. The file is written the same way every time, so an
unchanged run leaves it untouched.

## The storyboard helper

`mdmedia cut storyboard <cut> <line-or-performance-id> [--out file]` writes
a shot's storyboard in the CRT TV house format, with its delivery context:

- **the words just said before it**, verbatim (the line before, or the whole
  performance it ends), with their measured delivery in words: steadiness
  from the pitch range (under 7 semitones steady, under 11 lively, else very
  animated), level from loudness (quiet under -32 LUFS, conversational
  under -25, projected under -19, else loud), pitch against the same voice's
  other lines in the cut (or in Hz bands with too few), and words per second;
- **this shot's lines**: a whole performance, never part of a sentence. A
  line id brings its performance, and says so;
- **its delivery direction**: the performance's, then each line's;
- **what comes next**: the next line, and who says it.

The look and framing paragraphs (everything before its "Where this sits"
paragraph) come from `--base`, else from the storyboard the shot's current
take was generated from (its `sources` provenance), looked up by name in
`--storyboards` (default `<media root>/review/storyboards`); else they are
placeholders to fill in. The one action is always a placeholder. It measures
the cut's dialogue first, as `cut check` does. With `--out` it won't
overwrite a file without `--force`; it notes when a shot's speech is longer
than one generation holds (about 7 s). Generated from Big Hal Take 7:

```markdown
# Big Hal's car lot: At Big Hal's, you're guaranteed to get four doors! Four… (the guarantee: three bare basics as selling points)

A 1980s local television commercial shot on video: … (from hal7-guarantee4.md)

The same shot as the first frame, the camera locked off on a tripod, … (from hal7-guarantee4.md)

Where this sits in the commercial: in the shot just before this one Big Hal has said "And I personally hand-inspect every car.", lively, projected level, lower than this voice's other lines (-3.5 semitones), 2.36 words/s. This shot is the next sentence, in exactly that same voice. Right after this shot, in the next shot, Big Hal goes on: "And this one? This one even comes with wheels!"

Only Big Hal speaks. Big Hal says once, word for word, each word once, with no stumble and no repeated word: "At Big Hal's, you're guaranteed to get four doors! Four seats! A steering wheel!" A brisk, even list: each item at the same pitch and loudness, nothing builds, nothing shouted. Then Big Hal stops talking and holds, mouth closed. Big Hal does not say anything else.

[One simple action: what the hands or body do, timed to a word, with explicit negatives (never waves, never points, arms never go wide).]
```

`buildStoryboard({ timeline, target, measured, base, setting, character })`
(`src/cut/storyboard.ts`) is the pure part. `character: (speaker) =>
CharacterDelivery` is the hook for the cast (`castDelivery`; the CLI finds
the cast as `cut check` does, with the same `--production` and `--no-cast`):
the character's look, with its "never" rules, as a paragraph after the look
and framing (for the speaker and for any other cast role the base storyboard
names, `inShot`); its `register` after "Only Big Hal speaks"; its delivery
`never` rules after the direction ("Big Hal never shouts, never winks."); and
its usual delivery from the approved lines' medians, loudness and pace only.
See [characters.md](characters.md#in-mdmedia-cut-storyboard).

## Calibration

Annotated on 2026-10-19: Big Hal Take 5, which the owner heard as broken
("…by me! PERSONALLY!" as two performances, and the Wheels setup and
payoff split, with a shouted reveal); Big Hal Takes 6 and 7; and Night
Wagon Take 9, whose Rick lines are cut from one continuous take. Measured
with the defaults above; `--listen` on Takes 5 and 7.

| Cut · performance · boundary or cut | Owner | Splitting rule | Pause s | Δ LU | Δ pitch st | Δ rate | Room tone dB | Flags |
|---|---|---|---|---|---|---|---|---|
| T5 · inspection · every → personally | bad | 2 generations | 0.44 | **+3.0** | +4.1 | **+47 %** | **+5.7** | 4 |
| T5 · wheels_joke · thisone → wheels | bad | 2 generations | **0.89** | **+6.6** | **+13.2** | – | **+11.7** | 5 |
| T5 · wheels_joke · wheels → comeon | | (same take) | 0.50 | −1.2 | −2.6 | – | | |
| T5 · opening (3 boundaries) | fine | one (before the 10.01 s seam) | 0.31–0.47 | −1.0 to +1.6 | −0.7 to +2.7 | 8–20 % | | 0 |
| T5 · list · theystart → doorsclose | fine | one | 0.47 | −1.9 | −9.4 | – | +4.5 (wide) | 0 |
| T6 and T7 · wheels_joke · thisone → comeon | accepted | one | 0.38 | −0.7 | +1.0 | −7 % | | 0 |
| T7 · the_guarantee · 3 cuts inside the line | | one | | | | | –, +3.5, +0.8 | 0 |
| T7 · the other five sentences | | one each | | | | | | 0 |
| NW9 · rick_argument · 3 boundaries across Buddy | good | one | 1.2–2.1 | −2.0 to +1.5 | (−3.0 to +7.4, not judged) | | | 0 |

**The splitting rule and the measured flags separate them**: both of Take
5's broken performances break the rule and carry four and five measured
flags; nothing the owner heard as fine or accepted carries one. The margins
are thin in places: the loudness step into "PERSONALLY!" is 3.0 LU against a
2.0 LU largest step elsewhere, and room tone at the list's door cut is 4.5 dB
against the 5 dB threshold. Pitch across sentences moves a lot even within
one take ("They start!" to "The doors close!" drops 9.4 semitones, Rick
rises 7.4 into "There's no time!"), so its threshold catches only the
shouted reveal (+13.2). Take 6 keeps Take 5's opening and inspection, so it
keeps the inspection's flags.

**The listening check agrees in part, and only as a filter.** On Take 5 it
heard the shouted reveal ("shouted" 0.98 on "Wheels!"; the direction failed
0.99: "a dramatic comedic pause followed by a shouted reveal") and a
shouted "PERSONALLY!" (0.95; the direction failed 0.95), as Idea 4's
calibration had it (shouted 0.99, big reveal 0.99). But it called every pair
"one continuous delivery" (0.95), "comes with…" and "Wheels!" included, so
the "two separate deliveries 0.95" in Idea 4 didn't reproduce; the round-2
judge files show the same ("wheels_one: one continuous delivery", 0.92–0.99).
On Take 7 it passed every sentence but failed the accepted punchline
("WHEELS!" shouted 0.95, the direction failed 1.00, "a distinct pause before
shouting"), where the measurements show "wheels!" at -22.7 LUFS against
"comes" at -22.8 and no pause, and it failed the guarantee's "brisk" direction
(0.95, "slow, deliberate … pauses as he counts"). It also calls Take 5's
loud, punchy list shouted (0.98), which Take 5's direction asked for. So:
its shout and delivery questions catch the obvious failures and raise false
alarms on a loud pitchman; its continuity question doesn't separate
anything. The measured check and the splitting rule are the ones to trust;
the owner's ear decides.
