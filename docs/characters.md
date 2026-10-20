# Characters

A **character** is a person or a talking thing that appears across
productions: Rick and Buddy in Night Wagon, Big Hal, Chet and Moose in CGL
Football. Before this, a character lived in habits: each storyboard re-typed
how they look (which is how Victoria's brooch became pearls), their voices
lived in `gens.log`, and "too loud for Hal" was a guess. A character file
holds all of it in one versioned place, and the tools read it:

- `mdmedia cut check` holds each speaker to their character's **reference
  levels**, measured from approved lines;
- `mdmedia cut storyboard` writes their **look**, their **"never" rules** and
  their **delivery profile** into a shot's storyboard;
- `mdmedia character swap` puts a take's on-camera speech into their
  **voice** (the voice swap), so Chet in the booth sounds like Chet over the
  plays.

This is Idea 2 and part two of Idea 4 in
`plans/video-production-kit-ideas.md`, on the taxonomy agreed there (Idea 3):
assets (image, video, voice, music, sfx), **characters**, productions (shots,
takes, lines, cuts) and groupings (series, playlists). Characters are
portable: any production can cast one, and a production links to a character
version; it never copies it.

```sh
mdmedia character list
mdmedia character show chet                     # or chet@1
mdmedia character new walt --name Walt --root ~/.local/share/mdmedia/productions/crt-tv
mdmedia character still big-hal hal6-wheels-close-t1 1.0 --as medium --note "medium by the hood"
mdmedia character measure big-hal docs/cuts/big-hal-take6.cut.json#howdy,thisone,comeon --source "approved lines in Take 6"
mdmedia character swap takes/vs-chet-t1.mp4 chet --out voiceswap/chet-t1-eric.mp4 --text "What a thrilling …"
mdmedia cut check docs/cuts/big-hal-take7.cut.json         # the cast's reference levels, found from the production
mdmedia cut storyboard docs/cuts/big-hal-take7.cut.json the_guarantee
```

## The character file

`docs/characters/<id>.character.json`, format `mdmedia.character@1`
(`src/character/character.ts`: `parseCharacter`, `serializeCharacter`). From
`docs/characters/chet.character.json`, shortened:

```json
{
  "format": "mdmedia.character@1",
  "id": "chet",
  "version": 1,
  "name": "Chet",
  "kind": "person",
  "description": "The play-by-play announcer of CGL Football …",
  "look": {
    "description": "a trim, neat man of about fifty with side-parted greying brown hair, in a navy blazer, white shirt and striped tie, …",
    "never": ["any resemblance to a real announcer or actor", "glasses", "a blazer in any other colour", "…"]
  },
  "media": { "root": "~/.local/share/mdmedia/productions/crt-tv" },
  "stills": [
    { "id": "booth-key", "file": "football/k-booth-a.png", "from": { "generated": { "provider": "gemini image", "prompt": "football/prompts/k-booth.md", "at": "2026-10-19T00:21:33-07:00" } }, "note": "…" },
    { "id": "booth", "file": "characters/chet/booth.png", "from": { "take": "fb-booth-t1", "at": 2.5 }, "note": "Chet on the left, in CGL Football Take 1's booth shot" }
  ],
  "voice": { "provider": "elevenlabs", "name": "Eric", "settings": { "model": "eleven_multilingual_v2" }, "uses": ["tts", "swap"], "notes": "…" },
  "delivery": {
    "register": "a polished, warm network play-by-play man: crisp, upbeat and quick, moving things along",
    "never": ["never shouts", "never laughs at Moose", "never sounds sarcastic"],
    "reference": {
      "levels": { "loudness": { "min": -27, "max": -18.4 }, "pitch": { "min": 132.4, "max": 243.4 }, "pitchRange": { "max": 19.7 }, "rate": { "min": 2.58, "max": 5.86 }, "source": "Chet's voice-over lines in CGL Football Take 1" },
      "typical": { "loudness": -22.3, "pitch": 168.3, "pitchRange": 10.4, "rate": 3.86 },
      "margins": { "loudness": 2.5, "pitch": 3, "pitchRange": 3, "rate": 0.2 },
      "lines": [ { "cut": "docs/cuts/football-take1.cut.json", "line": "c1", "text": "Good afternoon, everybody, …", "loudness": -22.3, "pitch": 168.3, "pitchRange": 10.4, "rate": 3.86 }, … ],
      "method": "dialogue-stem@1",
      "measuredAt": "2026-10-20T07:…Z"
    }
  },
  "changelog": [ { "version": 1, "date": "2026-10-20", "changes": "First version: … Reference levels measured from 7 approved lines …" } ]
}
```

| Field | Means |
|---|---|
| `id` | Lowercase words joined by hyphens (`big-hal`), like a production's slug |
| `version` | A whole number from 1. See [Versions](#versions) |
| `name` | As cut lines give the speaker: `"Big Hal"` |
| `kind` | `person` or `thing` (Buddy is a station wagon). Sets may join later |
| `description` | Who they are, in a sentence |
| `look.description` | How they look, in the words every storyboard should use |
| `look.never` | What they are never shown with, as noun phrases: `"sunglasses"`, `"any resemblance to a real actor"` |
| `media.root` | Where `stills` are, like a cut's `media.root`; `~` is home |
| `stills` | Reference stills: `id`, `file` (under the media root), `from` (provenance), `note` |
| `stills[].from` | `{ take, at }` (a frame of that take at that second) or `{ generated: { provider, prompt?, ref?, at? } }` |
| `voice.provider` | `elevenlabs`, or `video-model` (the video model's own voice) |
| `voice.name`, `voice.id` | The provider's voice; the id wins. An ElevenLabs voice needs one |
| `voice.settings` | Provider settings (model, `stability`, `similarity_boost`, `style`, `speed`, `use_speaker_boost`); `swap` passes the voice ones on |
| `voice.uses` | `tts` (voice-only lines), `swap` (on-camera speech converted to this voice), `on-camera` (the take's own voice). A `video-model` voice is only `on-camera` |
| `delivery.register` | How they speak, in a phrase; written after "Only X speaks" |
| `delivery.never` | Delivery rules: `"never shouts"` |
| `delivery.reference` | Measured levels, or `null` until measured (below) |
| `changelog` | `{ version, date, changes }`, oldest first, with an entry for `version` and none after it |

The parser reports every problem at once, and writing is stable (fixed key
order, two-space indent, final newline), so writing an unchanged character
changes nothing.

### Versions

A production records the character versions it was made with, and a version
never changes once a production uses it: refining Rick for a new episode must
not change a finished cut. So:

- the folder holds the current version as `<id>.character.json` and each
  earlier one as `<id>@<version>.character.json` (`writeNewVersion` moves the
  old file aside, never over an existing one);
- `rick@1` means exactly that version, from either file (`loadCharacter`);
- a change that a production would see (look, voice, delivery, levels, stills)
  is a new version with its changelog entry: `mdmedia character measure
  --bump`, or `nextVersion` in code. Editing a version in place is fine only
  before any production uses it (and before it is pushed: Studio refuses a
  changed version with `409 version_exists`);
- moving a production to a newer version is deliberate: change its cast.

The folder is `docs/characters` in the repository (`--dir`, or
`MDMEDIA_CHARACTERS_DIR`). Files whose names don't match what they hold are
refused.

### Reference levels

`mdmedia character measure <id> <cut>#<line>,<line> … --source "…"` renders
each named cut's dialogue and measures it exactly as `mdmedia cut check` does
(method `dialogue-stem@1`: BS.1770 loudness, YIN pitch median and its 10th to
90th percentile range, words per second from the words file), keeps the named
lines, and writes:

- `lines`: each approved line's cut, id, text and measures;
- `typical`: each measure's median over them;
- `levels`: the span of the approved lines widened by `margins`: loudness
  ±2.5 LU (the check's loudness step), median pitch ±3 semitones, pitch range
  up to 3 semitones above the widest, pace ±20 %. These are the ranges
  `cut check` flags outside of.

Only lines named as approved are measured; a line spoken by someone other
than the character's name, or without word timings, is warned about.
Measuring needs the cuts' words files but no network: it works while
ElevenLabs is out of credits. A character that already has levels needs
`--bump` (a new version; productions keep the old levels) or `--force`.

**Caveats.** Loudness is measured in the cut's mix, at its gains, so a
character's levels assume a production mixed like the ones they were
measured in. YIN reads these voices with wide ranges (10 to 15 semitones on
steady lines) and the odd octave slip, so pitch ranges are loose and pitch is
never described in words to a video model (below); medians compared within
one voice are the useful part.

## Casts

A production's manifest names its cast: each role (a cut line's `speaker`)
and the character version that plays it.

```json
{
  "format": "mdmedia.production@1",
  "slug": "night-wagon-the-argument",
  "media": { "root": "~/.local/share/mdmedia/productions/crt-tv" },
  "cast": [
    { "role": "Rick", "character": "rick@1" },
    { "role": "Buddy", "character": "buddy@1" }
  ],
  "cuts": [ … ]
}
```

Each role is cast once and every entry names a version. A cut finds its cast
through the production that lists it (`productionOfCut`: the manifest in
`docs/productions` with this cut file, or `--production`), so cuts don't
repeat it.

### In `mdmedia cut check`

The cast's levels go through the check's `reference: (speaker) =>
ReferenceLevels` hook (`castReference`). A line outside its speaker's levels
is flagged `outside-reference`, quoting the version:

```
Cast, from docs/productions/big-hal.production.json: Big Hal = big-hal@1 (reference from 6 approved lines).
…
flag: personally: speech rate 1.43 words/s is below Big Hal's reference, 1.71 words/s (big-hal@1, from 6 approved lines)
```

`--no-cast` checks without it; `--json` lists the cast under `status.cast`.
On the seeded productions:

- **Big Hal Take 5**, which the owner heard as broken: `personally` (1.43
  words/s, the slow shouted "PERSONALLY!") and `wheels` (315 Hz, above 309; an
  18.7 semitone range; 1.35 words/s) are flagged, with `theystart`,
  `doorsclose` and `thisone` (Take 5's own take, quieter and lower than the
  accepted one).
- **Big Hal Take 6/7's approved lines** are inside, by construction. Take 7's
  four new lines in review (`dealers`, `nothal`, `deal`, `inspected`) all sit
  below Hal's approved pitch (154 to 190 Hz against 198 or more). Worth a
  listen: it could be a lower, calmer Hal, or YIN reading a different octave.
- **Night Wagon Take 9** has no flags: its lines are the reference.

### In `mdmedia cut storyboard`

The `character: (speaker) => CharacterDelivery` hook (`castDelivery`) now
carries the look, the "never" rules, the delivery profile and the version.
The storyboard gets:

- after the look and framing paragraphs, one paragraph per character in the
  shot (the speaker, and any other cast role the base storyboard names):
  `Big Hal looks exactly like this, as in the first frame: <look>. Never shown
  with: sunglasses; a hat in any other colour or shape; …`;
- after "Only Big Hal speaks", the register; after the direction, the
  delivery "never" rules; then the usual delivery from the approved lines'
  medians, loudness and pace only: `Big Hal's usual delivery, as in the
  approved lines: projected level, 3.07 words/s.` (pitch in words would tell
  a video model a steady pitchman is "very animated");
- a note naming the version (`Big Hal's look and delivery are from
  big-hal@1`). The version is never written into the prompt.

## The voice swap

On-camera speech is the video model's own voice, which changes from take to
take (why Rick varies in "Drive-In"). For CGL Football Take 2 the announcers
must sound the same in the booth, on camera, and over the plays, where they
are text-to-speech in "Eric" and "Roger". The swap keeps the take's speech for
its timing, lip sync and acting, and converts the voice with ElevenLabs
speech-to-speech (`POST /v1/speech-to-speech/{voice_id}`,
`src/elevenlabs/speech-to-speech.ts`).

`mdmedia character swap <video> <voice> --out <file> [--text "…"]`
(`src/character/swap-run.ts`):

1. takes the take's sound out as mono 44.1 kHz WAV (`<name>.before.wav`);
2. converts it to the voice: a character (`chet`, `chet@1`: its ElevenLabs
   voice and settings; it must list `swap` in `voice.uses`) or a voice name;
   model `eleven_english_sts_v2`, ElevenLabs' background removal on (the edit
   lays its own crowd or room bed; `--keep-noise` sends the take as it is),
   24 kHz PCM back (`pcm_44100` is Pro-tier only) as `<name>.after.wav`;
3. puts it back under the same picture, copied, not re-encoded, padded or cut
   to the take's length (`<out>`);
4. with `--text`, aligns the words before and after (the forced aligner) and
   writes the comparison into `<name>.swap.json`
   (`compareSwap`, `src/character/swap.ts`): whether the words are the same,
   each word's start before and after (**lip-sync drift**: median and
   largest), the lag that best lines up the two loudness envelopes, and
   loudness, pitch, pitch range and pace before, after and the change.

Nothing is overwritten, and a failed swap leaves nothing half made. The
listening check stays a filter only: the owner's ear decides.

### In a cut

A swapped take is a new file with the same picture and timing, so a cut
plays it like any take. Its provenance says what it is, in `sources` (see
[cut-format.md](cut-format.md#where-a-source-came-from-sources)):

```json
"sources": {
  "voiceswap/booth-close-chet.mp4": { "step": "swap", "swappedFrom": "take:cgl2-booth-close-t1", "voice": "chet@1" }
}
```

The splitting rule treats a swapped take as the take it was swapped from (the
same generation, at the same times), so a sentence cut between a take and
its swap is still one performance; without the provenance it counts as two
generations. The storyboard helper follows `swappedFrom` back to the
storyboard the take was generated from. Lines need no swap step of their own:
a line in a swapped take's segment is heard in the new voice.

### The recipe for CGL Football Take 2

1. Generate each booth line as one on-camera take, as usual (one speaker, the
   whole sentence, from the approved booth still), with `mdmedia cut
   storyboard` for its delivery context.
2. Swap it: `bash voiceswap.sh takes/<take>.mp4 chet voiceswap/<take>-eric.mp4
   "<the line>"` (or `moose`), from the media root. `voiceswap.sh` runs
   `mdmedia character swap` with the characters in `docs/characters` and logs
   to `gens.log`.
3. Read `<take>-eric.swap.json`: the same words, word drift under about 40 ms
   (one frame at 24 fps is 42 ms), no large envelope lag, and pitch near the
   character's typical (Chet about 168 Hz, Moose about 108 Hz). Listen at the
   line's own times.
4. Cut with the swapped file as the segment's `src`, its `swap` provenance
   in `sources`, and the voice-over lines as TTS in the same voices.
5. `mdmedia cut check` the cut: the cast holds booth and voice-over lines to
   the same reference levels.

### The test, 2026-10-20: not run

ElevenLabs was out of credits for the whole run. The key's own limit (10,000
credits) was spent, and every ElevenLabs call (speech-to-speech, TTS, the
aligner, sound effects) was refused. The one test call, Chet's 8 s take, was
refused for quota (it needed 88 credits; an earlier attempt showed
`pcm_44100` needs the Pro tier, so the swap asks for 24 kHz). **So the voice
swap is not tested**: lip-sync drift, delivery and how "Eric" and "Roger"
sound converted are unknown.

Ready to run once credits are topped up:

```sh
bash ~/.local/share/mdmedia/productions/crt-tv/voiceswap/run-test.sh
```

It swaps both booth takes, writes their reports, and makes
`voiceswap/after.mp4` beside `voiceswap/before.mp4` (both: Chet 0 to 8 s,
speech 0.7 to 6.6 s; Moose 8 to 14 s, speech 8.7 to 12.4 s).

What was made and measured without ElevenLabs (`voiceswap/` in the media
root):

- **The booth shots** (`shot.sh`, house-style storyboards
  `voiceswap/vs-chet.md`, `vs-moose2.md`): `takes/vs-chet-t1.mp4` (8 s, from
  the approved booth still; "What a thrilling come-from-behind win by the
  Icebreakers! Moose, what do you think sparked that comeback?", word perfect,
  only Chet's lips move) and `takes/vs-moose2-t3.mp4` (6 s, from a still of
  Take 1's booth shot; "Yeah, Chet. I've seen it, and it is not effective.",
  word perfect). The video service refused 14 of 16 booth requests as
  "prohibited content", 11 of them Moose's: with the first wording ("former
  lineman", "Don't tackle your own guys?") from either booth still or from
  stills of Chet's take, with gentler wording from the booth still, and with
  no first frame. The gentler wording from a frame of Take 1's own booth shot
  went through. CGL Take 2 should expect refusals on booth shots and start
  them from Take 1's booth frames.
- **`voiceswap/before.mp4`**, the two takes back to back.
- **The gap the swap has to close** (`before-measure.json`; word times from
  local faster-whisper):

  | | On camera (video model) | Its voice-over voice | Character's typical |
  |---|---|---|---|
  | Chet | 188.6 Hz, range 9.6 st, 3.03 words/s | "Eric" (fb-c5): 165.4 Hz, 3.85 words/s | 168.3 Hz, 3.86 words/s |
  | Moose | 138.5 Hz, range 5.9 st, 2.72 words/s | "Roger" (fb-m3b): 118.7 Hz, 4.17 words/s | 107.8 Hz, 3.52 words/s |

  On camera, Chet is 2.0 semitones above his typical and Moose 4.3 above
  his: the model's Moose is a lighter voice than Roger. Both speak slower on
  camera than their voice-over (Moose was asked to be slow). Loudness isn't
  comparable here: the takes are measured raw, the references in the cut's
  mix.

## Studio

Characters are stored with their versions, and a production links to them as
its cast. They share the productions scopes (`productions:read`,
`productions:write`); see
[studio-productions-api.md](studio-productions-api.md#characters).

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/characters` | Your characters by name, each with its versions |
| `GET` | `/api/v1/characters/{id or slug}` | The character, its versions, and its latest version whole |
| `GET` | `/api/v1/characters/{id or slug}/versions/{version}` | One version whole, with links to its stills |
| `PUT` | `/api/v1/characters/{slug}/versions/{version}` | `{ character, stills: { [stillId]: assetId } }`: `201` new, `200` the same content again, `409 version_exists` other content |

`POST /api/v1/productions` takes `cast: [{ role, character: "rick@1" }]`
(each version stored first; left out keeps the cast, `[]` clears it), and a
production carries its `cast`: each role with its character's name,
version, voice, register, first still and how many approved lines its levels
came from.

`mdmedia production push` pushes the cast: it uploads every character's
stills with the production's media, stores each version (a no-op when it is
there), then links the production. The production page shows a **Cast**
section under the featured cut: each character's still, name, version, voice,
how many lines its levels came from, and register (screenshots in
`.design/characters/`).

## Seeded characters

All at version 1 in `docs/characters`, measured on 2026-10-20 from named
approved lines, and cast in Big Hal, Night Wagon: The Argument and CGL
Football (pushed to Studio).

| Character | Voice | Measured from | Reference levels | Typical |
|---|---|---|---|---|
| `big-hal@1` | the video model's own (on camera) | Take 6/7: `howdy`, `nomoney`, `zero`, `month` (the opening heard as fine) and `thisone`, `comeon` (the accepted one-breath punchline and close), from `big-hal-take6` | -28.1 to -21.5 LUFS, 198 to 309 Hz, range up to 18.3 st, 1.71 to 4.16 words/s | -24.7 LUFS, 245 Hz, 3.07 words/s |
| `rick@1` | the video model's own (on camera) | Night Wagon Take 9: `getaway`, `jump`, `boost`, `notime`, `turbo` | -26.4 to -18.2 LUFS, 129 to 407 Hz, range up to 21.7 st, 2.00 to 7.50 words/s | -22.2 LUFS, 212 Hz, 4.08 words/s |
| `buddy@1` | ElevenLabs "Bill - Wise, Mature, Balanced" (TTS) | Night Wagon Take 9: `bridge`, `gap`, `cant`, `no`, `wagon` | -32.0 to -22.6 LUFS, 100 to 300 Hz, range up to 16.6 st, 1.70 to 5.15 words/s | -26.0 LUFS, 147 Hz, 3.16 words/s |
| `chet@1` | ElevenLabs "Eric" (TTS and swap) | CGL Football Take 1: `c1`, `c2`, `c3a`, `c3f`, `c3c`, `c4`, `c5` | -27.0 to -18.4 LUFS, 132 to 243 Hz, range up to 19.7 st, 2.58 to 5.86 words/s | -22.3 LUFS, 168 Hz, 3.86 words/s |
| `moose@1` | ElevenLabs "Roger" (TTS and swap) | CGL Football Take 1: `m1`, `m2`, `m3`, `m3b`, `m4`, `m5` | -28.4 to -20.3 LUFS, 78 to 145 Hz, range up to 18.9 st, 2.22 to 4.94 words/s | -24.3 LUFS, 108 Hz, 3.52 words/s |

Stills, each a frame of an approved take unless noted: Big Hal `medium`
(hal6-wheels-close-t1 at 1.0 s) and `wide` (big-hal-4ab-t2 at 1.5 s); Rick
`driving` (nw7-rick-lines-t1 at 1.0 s); Buddy `exterior` (nw7-halt-t3 at
3.0 s) and `dashboard` (nw7-dash-t1 at 2.0 s); Chet and Moose `booth`
(fb-booth-t1 at 2.5 s) and `booth-key` (the generated booth still
`football/k-booth-a.png`). Football Take 1 is still in review; its voices
carry into Take 2's plan, so its lines stand as approved for the voices.

## What's left

- **Run the voice-swap test** once ElevenLabs has credits
  (`voiceswap/run-test.sh`), and judge drift and delivery by ear. Until then
  the recipe is untested.
- **A swap voice for Rick and Big Hal**, whose voices are still the video
  model's.
- **Face drift** (`check --cast`), comparing new takes' faces with the
  stills: needs a face-matching model.
- **`shot --cast`**: start a shot from the right still with the look filled
  in, instead of `cut storyboard` plus `shot.sh` by hand.
- **Sets** as a sibling of characters (the Regulars bar, Buddy's
  dashboard), if needed.
- **A characters page in Studio**; today characters show only as a
  production's cast.
- **Pitch**: a steadier pitch tracker would tighten the pitch ranges.
