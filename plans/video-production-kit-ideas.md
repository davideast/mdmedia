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

## Where things are today

The working pipeline is in the satisfy.md session scratchpad under `crt/`, which is temporary:

- **Generation:** `gen.sh`, `shot.sh`/`shot.mjs`, `extend.sh`/`extend.mjs`, `tts.sh`, `sfx.sh`, `voices.sh`
- **Inspection:** `still.mjs`, `frames.mjs`, `envelope.mjs`, `stt.py` (faster-whisper)
- **Edits and graphics:** the per-clip `edit.mjs` and `gfx.mjs` (`nw7/`, `nw9/`, `nw10/`, `bellamy6/`, `rigg5/`, `hal5/`, `br4/`, `football/`, `nwdi/`, `regulars3/`)
- **Publishing and review:** `publish.mjs`, `review/build.mjs` (posters and light copies), `review/index.html` with `shows.json` (the review page, grouped by show and status)
- **The method:** `PRINCIPLES.md`

If this gets built, copy the method and the reusable scripts out of the scratchpad first.
