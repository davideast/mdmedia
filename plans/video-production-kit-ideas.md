# Video production kit: ideas

Captured 2026-10-19 from making the fake 1980s TV clips for satisfy.md's CRT TV component (Night Wagon, Bellamy Ranch, RIGG, Big Hal's and the rest). These are two ideas that aren't built yet. **Overall effort: medium.**

The method behind the clip the user called perfect, Night Wagon Take 7, is the starting point:
- a script built around the joke;
- one action and at most one speaker per shot;
- shots started from stills of approved takes;
- voice-only lines as TTS;
- precise storyboards with physics language and explicit negatives;
- the edit as code;
- graphics as our own PNG overlays;
- every take checked by frames and transcript.

Today that method lives in a scratchpad as ad hoc scripts. See "Where things are today" at the end.

---

## Idea 1: mechanical tools, with the edit as data, plus a minimal editor view

### What's ad hoc now

The steps that do one thing are already close to tools: generate a shot, extend, TTS, SFX, still, contact sheet, transcribe, loudness envelope, publish, poster and light copy.

The ad hoc part is **the edit**. Each clip has its own `edit.mjs` that builds a long ffmpeg filter graph by hand, and it re-implements the same moves every time:
- trims and freeze-holds;
- crops;
- forward-and-back loops (to keep a light sweeping on a held shot);
- J-cuts;
- music volume automation;
- overlays that fade, slide or blink;
- synthetic sounds such as a hazard-relay tick.

A note like "move the title to the end" means editing code.

Storyboards, takes and which take won are files and folders, not something a tool can read.

### The tools

One small CLI per production, where each step reads and writes the production's files:

| Tool | What it does |
|---|---|
| `shot <prod> <id>` | Generates the next take from the storyboard and its start frame, and records it under that shot |
| `voice <prod> <line>`, `sfx`, `music` | Audio, recorded the same way |
| `check <take>` | One JSON report: frames at key times, words with timestamps, loudness, and a scene-change detector (catches the "set changed mid-shot" and "night turned to day" failures automatically) |
| `render <prod>` | Compiles the cut file into the video. One generic renderer replaces every per-clip `edit.mjs` |
| `publish <prod>` | Posts to the review page (exists today as `publish.mjs`) |

### The cut file

The edit becomes data. Times can be relative to another item, so lengthening one line doesn't push everything else off.

```json
{
  "video": [
    { "id": "stun", "take": "nw7-rick-stunned-t1", "in": 0.5, "out": 2.95 },
    { "id": "btn",  "take": "nw6-button-t1", "in": 1.4, "out": 3.0, "hold": 1.05 }
  ],
  "lines":    [ { "id": "b12", "file": "tts/b12b.wav", "at": "stun+0.4" } ],
  "music":    [ { "file": "nw6-theme.mp3", "volume": [[0, 1], [4.2, 0.18], ["halt", 0]] } ],
  "overlays": [ { "png": "title.png", "from": "out+0.25", "fade": 0.35 } ]
}
```

"Move the title to the end" becomes a two-line diff. Agents follow the steps instead of improvising them, and the method's rules can be enforced by the tools:
- one speaker per shot;
- 0.2 to 0.4 s gaps between lines;
- silence before the punchline.

### The editor view (minimal)

A timeline page on the review server, read from the cut file and the `check` reports:
- **Player:** the light copy, with a playhead synced to the timeline.
- **Shots track:** a thumbnail strip, each shot labelled with its take and in/out points. Click one to see its source take and the other takes of that shot.
- **Dialogue track:** each line as a box with its words and start time, so a gap between lines is visible.
- **Music track:** the volume drawn as a line, so the silent stretch is obvious.
- **SFX and overlays tracks.**
- **Timecodes on everything.**

The first version is read-only. The user scrubs, reads timecodes and replies in chat ("b6 is 0.2 s late", "hold stun 0.5 s longer"), and the agent changes one number and re-renders. Later:
- notes pinned at a timestamp, saved for the agent to read;
- after that, dragging trims in the page.

### Effort

| Piece | Size |
|---|---|
| Cut-file format, generic renderer and `check`, proven by rebuilding Night Wagon Take 9 exactly from a cut file | Medium (mostly porting patterns that already work) |
| The other tools wrapped consistently, plus an agent skill describing them | Small |
| Read-only editor view | Small, once the cut file exists |
| Notes pinned at timestamps | Small |
| Editing in the page (drag trims, re-render) | Medium to large; later |

Suggested home: `mdmedia` itself, as `mdmedia cut …` commands, so other projects can use it.

---

## Idea 2: consistent characters, props and sets (a cast)

### What exists now

Consistency happens by habit, not by any record or tools:
- **Faces:** a few saved stills (`nw6/rick.png`, `bellamy5/rex.png`, Victoria's close-ups) plus frames pulled from approved takes as needed. Nothing records which still is the approved Rick or which take it came from.
- **Descriptions:** every storyboard re-types the character in its own words, so the wording drifts. That's how Victoria's brooch became pearls between shots.
- **Voices:**
  - Only the TTS voices are locked: Buddy is "Bill"; Chet and Moose are "Eric" and "Roger". Even those live only in `gens.log` and the scripts.
  - On-camera voices aren't locked; the video model invents Rick's voice in each shot. That's why Rick varies in "Drive-In", and why Take 7 cut all his lines from one continuous take.
- **Props and sets:** the wagon, Buddy's dashboard and the Regulars bar are described in text and restarted from stills, with no approved reference.
- **Drift checks:** drift is caught by eye from frames, with no automatic "is this still Rick?" test. Misses so far:
  - Walt recast mid-scene in Regulars Take 2;
  - a different Rick in two of the Drive-In family-car stills.

### Representation

A cast folder per series. Characters, props (the wagon, the dashboard) and sets (the bar) all use the same shape:

```
cast/rick/
  rick.json         canonical description, approved takes with timestamps, voice, don'ts
  refs/front.png    face, 3/4, full body: pulled from approved frames
```

```json
{
  "name": "Rick",
  "describe": "mid-30s man, dark mullet, black leather jacket over a white tee",
  "refs": ["refs/front.png", "refs/three-quarter.png"],
  "approved": [{ "take": "nw7-rick-lines-t1", "at": 2.1 }],
  "voice": { "kind": "swap", "voice": "<chosen voice>" },
  "never": ["resembles a real actor", "aviators", "different jacket"]
}
```

### Tools

| Tool | What it does |
|---|---|
| `cast add` / `cast ref <id> <take> <t>` | Saves an approved frame as a reference and records where it came from |
| `shot … --cast rick,wagon` | Adds the canonical descriptions and don'ts to the storyboard and picks the right reference as the start frame. No re-typing, no drift |
| `check --cast rick` | Compares the face in each new take with the references and flags drift. Needs a small local face-matching model |
| Voice swap | Keep the video model's on-camera line for its timing and acting, then run it through ElevenLabs' speech-to-speech voice changer with the character's voice, so Rick sounds the same in every shot. Check whether `mdmedia` wraps that API yet; it may need adding |

### Effort

- **Small:** the cast folders, `cast ref`, and adding descriptions and start frames to shots.
- **Medium:** the face-drift check and the voice swap. Each needs a new dependency or API path, and testing against existing takes.

Cast is the step before `shot`, so it fits naturally with Idea 1. Built together, the whole thing is still medium.

### Built: characters, first version (2026-10-20)
See [docs/characters.md](../docs/characters.md).
- **Character files:** `docs/characters/<id>.character.json` (`mdmedia.character@1`): name, description, look with "never" rules, reference stills with provenance (a take and a time, or a generation), a voice (provider, name or id, settings, uses), a delivery profile (register, "never" rules, reference levels measured from named approved lines), and a version with a changelog. Earlier versions are kept as `<id>@<n>.character.json`.
- **Casts:** a production manifest's `cast` maps roles (cut speakers) to `id@version`. `cut check` holds lines to the cast's reference levels; `cut storyboard` writes in the look, "never" rules and usual delivery.
- **CLI:** `mdmedia character new|show|list|measure|still|swap`.
- **Studio:** characters stored per version (`/api/v1/characters`), productions link to them as their cast, and the production page shows it.
- **Seeded:** Big Hal, Rick, Buddy, Chet and Moose, measured from approved lines in Big Hal Takes 6/7, Night Wagon Take 9 and CGL Football Take 1.
- **Voice swap:** `mdmedia character swap` and the `swap` step in a cut's `sources` are built, but the test wasn't run: ElevenLabs was out of credits. `voiceswap/run-test.sh` in the media root runs it.

---

## Idea 3: taxonomy in Studio (agreed 2026-10-19)

Studio's media types today (`narration | image | video | music | sfx`) are all **generations**: one prompt, one provider call, one file. A Night Wagon episode isn't a generation. It's an **arrangement** of many generations in time that renders to a video. So "video" was meaning two things. The agreed split:

| Layer | Types | What it is |
|---|---|---|
| Assets | image, video, voice (was narration), music, sfx | One file each |
| Characters | people and talking things (Sets later, if needed) | Reusable, versioned references, portable across productions |
| Productions | Production → shots → takes, lines, cuts | Documents that arrange assets in time; render to a video asset |
| Groupings | Series (optional from the start), Playlists | A series shares a cast; playlists order finished media |

### Assets
- **The types stay:** image, video, music and sfx are unchanged.
- **Voice replaces narration:** a character's line isn't narration.
- **Origin:** every asset records where it came from (generated by a provider, uploaded, or rendered from a cut).
- **Example:** a finished episode is a normal `video` asset whose origin is "rendered from cut X". It plays and downloads like any video, but it knows it can be re-rendered and edited.

### Characters
- **Their own place in Studio,** like Voices, and usable from any production or series. A production's **cast** links to characters; it doesn't copy them.
- **A character holds:**
  - a description;
  - reference stills saved from approved frames, with where each came from;
  - a voice: a TTS voice, such as Buddy's "Bill", or a voice swap for an on-camera character like Rick;
  - "never" rules, such as "doesn't resemble a real actor".
- **Versioned:** refining Rick for a new episode mustn't change a finished cut. A production records the character versions it was made with; moving to a newer version is deliberate.
- **People or things:** a character can be either. Buddy is a character whose body is a station wagon. Places (the Regulars bar, Buddy's dashboard) are sets; start with Characters and add Sets as a sibling only if needed.

### Productions
- **A production is one piece:** an episode or a commercial. It holds:
  - the script;
  - shots, each with a storyboard and a start frame;
  - each shot's takes (video assets, one circled);
  - the voice lines, music and graphics;
  - cuts, the reviewable versions. Take 7, 8 and 9 are cuts of one production, not separate videos.
- **Create flow:** script → shots → generate takes → assemble a cut → word timings and checks → review in the cut viewer → render → publish.
- **A take is today's video generation,** run from a shot with its storyboard, start frame and cast filled in. The plain "Create → Video" stays for one-off clips.
- **A series** is optional from the start and groups productions that share a cast. Night Wagon already has two episodes sharing Rick and Buddy.

### Names
Production, Cut, Shot, Take, Cast, Series, Characters; Voice replaces Narration.

---

## Idea 4: performance continuity (planned 2026-10-19)

### The problem
- **A cut can match and still feel wrong.** The next shot gets the scene and the person right, but the delivery is out of flow: a separate performance at a different energy, pitch or pace. It's the most common failure in these generations.
- **Hal, Big Hal Take 5:**
  - "…by me! PERSONALLY!" is two performances.
  - "This one even comes with… WHEELS!" is a calm setup and a shouted reveal split across two clips, which kills a joke that only works if he says it like an ordinary selling point.
- **Night Wagon avoided it:**
  - Rick's lines were cut from one continuous take.
  - His intensity never changes, so seams don't show.

The general cause: each shot is generated from a still with no knowledge of what was just said, how it was said, or what comes next.

### The model
1. **Performances in the cut.** A `performances` list groups the lines that must sound like one continuous delivery:
   - each has an intent, e.g. "setup and punchline";
   - each has its own delivery direction, e.g. "ordinary selling point, one breath, no pause before 'wheels'".
   - Lines can also carry delivery notes of their own.
2. **A delivery profile on each character,** next to their voice:
   - **Register:** for example, "proud, sincere, steady local pitchman".
   - **"Never" rules:** for example, "never shouts".
   - **Reference levels measured from approved lines:** loudness, pitch and speech rate, so "too loud for Hal" is a number, not a guess.
3. **Generation context, assembled automatically.** When a shot carries part of a performance, its storyboard is given:
   - the words just said before it, verbatim, and how they were delivered (measured and described);
   - the delivery for this shot, from the performance and the character profile;
   - what comes next.
   No more fresh shots that don't know the line they're continuing.
4. **A splitting rule:** a sentence, and a setup with its payoff, comes from **one generation**, always.
   - Write the whole line into one storyboard; a sentence of up to about 7 s fits.
   - If the picture must change inside it, cut the picture over that one take's continuous audio (a cutaway or insert played over it), never the voice.
   - Never generate part of a sentence as a separate clip, and never finish one with an extend. An extend continues the picture, but its sound is a new generation, so the delivery comes back as a separate performance. Round 2's extended "Personally!" showed exactly that.
   - Only a new sentence may start a new generation, and then it gets the delivery context (what was just said, how, and what comes next).
5. **Checks, stored on each take and cut:**
   - **Measured:** for every performance, loudness, pitch and speech rate per word, plus the change across each boundary between its lines. Flag jumps beyond the character's profile. Pause lengths come from word timings.
   - **Listening check:** gemini-3.8-flash hears the clip. Its questions are generated from the performances and profile:
     - "Do 'This one even comes with' and 'wheels' sound like one continuous delivery?";
     - "Is any word shouted?";
     - "Is the punchline delivered as an ordinary selling point?".
     Give it every known time and ask about phrases, not cuts. Calibration: on Take 5 it heard "shouted 0.99, two separate deliveries 0.95, big reveal 0.99".
   - **Ranking:** when several takes are generated, rank them by the checks, and don't offer takes that fail.

### Where it lives
- **Cut format:** `performances` and line `delivery`.
- **Cast:** each character's delivery profile.
- **`mdmedia cut check`:**
  - measured prosody with continuity deltas;
  - the listening check, with results written next to the words file;
  - the listening check as an interface, like the aligner, so the model can change.
- **A storyboard helper** that writes the delivery context into a shot's storyboard from the cut, the performances and the profile.
- **Agent context bundles:** performances, profiles and check results.

### Effort
Medium overall:
- **Small:**
  - the format fields;
  - the profile on characters;
  - the listening-check wrapper (it exists as `judge.mjs`);
  - the storyboard helper.
- **Medium:** the measured prosody. Pitch tracking needs a small pitch detector, and reference levels need approved lines to measure.

### Validated by
The round-2 simulation on Big Hal applies all of this by hand. Its results show which parts matter most.

### Built: part one (2026-10-19)
See [docs/cut-check.md](../docs/cut-check.md) and the Performances section of [docs/cut-format.md](../docs/cut-format.md).
- **Format:**
  - a cut-level `performances` list (`id`, `lines`, `intent`, `delivery`, own `thresholds`);
  - a line-level `delivery` note;
  - `check.thresholds`.
  
  The resolver reports unknown lines, lines in two performances and lines out of order. It puts each splitting-rule problem on the resolved performance: separate generations, a line across an extend seam, an unknown seam, mixed speakers. An extended take's seam is the length of the take it continued, so Take 4's opening counts as one generation.
- **`mdmedia cut check <cut> [--listen] [--json]`:**
  - **Measured:** taken from a render of the cut's dialogue (no music or effects, the cut's own gains).
    - Per line: BS.1770 loudness, YIN pitch (median and range) and words/s.
    - Per boundary: deltas at the edges and the pause from word timings.
    - Per cut inside a performance: room tone either side.
    - Loud words.
  - **Listening:** a `Listener` interface with `GeminiListener` (judge.mjs ported, `gemini-3.8-flash`). Questions about phrases are generated from the performances and deliveries.
  - **Results:** written to `<name>.check.json` with fingerprints, so they go stale like words files.
- **`mdmedia cut storyboard <cut> <id>`:** writes the house-format storyboard:
  - the words said before, verbatim, with their measured delivery in words;
  - the whole performance and its direction;
  - what comes next.
  
  The look and framing come from the take's own storyboard.
- **Calibration:** Big Hal Takes 5, 6 and 7 and Night Wagon Take 9 are annotated.
  - **Measured flags and the splitting rule:** they separate Take 5's two broken performances (4 and 5 flags each) from everything the owner heard as fine (none).
  - **The listening check:**
    - It catches the shouted reveal and the shouted "PERSONALLY!".
    - It calls every pair "one continuous delivery", so Take 5's "two separate deliveries 0.95" above didn't reproduce.
    - It fails the accepted Take 6/7 punchline as shouted, though measured "wheels" is level with "comes".
    
    It stays a filter.
- **Hooks for characters:**
  - `reference: (speaker) => ReferenceLevels` in the check, which flags `outside-reference`;
  - `character: (speaker) => CharacterDelivery` (register and "never" rules) in the storyboard helper.
- **Left for part two and characters:**
  - **The cast:** each character's delivery profile, and its reference levels measured from approved lines.
  - **Ranking takes:** rank several takes by the checks, and drop those that fail.
  - **Agent context bundles:** performances, profiles and check results.
  - **Inside a single line:** a pitch or loudness measure that holds within a line (a reveal inside one line, as in Take 6's take, is only caught by its words).
  - **Studio:** showing performances and checks.

---

## Where things are today

The working pipeline is in the satisfy.md session scratchpad under `crt/`, which is temporary:

- **Generation:** `gen.sh`, `shot.sh`/`shot.mjs`, `extend.sh`/`extend.mjs`, `tts.sh`, `sfx.sh`, `voices.sh`
- **Inspection:** `still.mjs`, `frames.mjs`, `envelope.mjs`, `stt.py` (faster-whisper)
- **Edits and graphics:** the per-clip `edit.mjs` and `gfx.mjs` (`nw7/`, `nw9/`, `nw10/`, `bellamy6/`, `rigg5/`, `hal5/`, `br4/`, `football/`, `nwdi/`, `regulars3/`)
- **Publishing and review:** `publish.mjs`, `review/build.mjs` (posters and light copies), `review/index.html` with `shows.json` (the review page, grouped by show and status)
- **The method:** `PRINCIPLES.md`

If this gets built, copy the method and the reusable scripts out of the scratchpad first.
