# Story: design

A **story** is a markdown document that builds into a dramatic audio recording
(narrator, cast, and later sound effects and music) and, eventually, an
illustrated graphic novel and an MP4 playthrough. mdmedia treats it like a build
tool: a source file compiles to a timeline, renders are cached by content, and a
build writes a predictable output tree.

This document fixes what has to be decided before implementation and leaves
everything else to the milestone that proves it is needed. Later plans in this
folder (`001-…`) are step-by-step implementation plans that point back here.

- **Status**: decisions settled 2026-10-18 (section 14); scope trimmed to what is
  proven (section 1)
- **Planned at**: commit `4eb8f62`, 2026-10-18

## 1. Principles

These decide what gets built and what does not.

1. **Code owns what is mechanical and checkable; the model owns judgment.**

   | Code | Model |
   |---|---|
   | Parsing the stated notation | Turning loose prose into that notation |
   | Hashing and the render cache | Choosing each line's delivery |
   | Timing arithmetic: durations plus the gaps written in the script | Deciding pacing: where a beat lands, where to rush |
   | Provider calls, mixing, encoding, loudness to a published standard | Art prompts and character consistency |
   | The output file layout | Placing captions on an image (it can return boxes) |
   | Machine-readable errors | Fixing a story from those errors |

2. **Judgment is data, not constants.** Pacing, delivery and placement are
   written in the script (by the author or a model) and the code applies them.
   There are no rule tables of taste; there is one default gap.
3. **Evidence before rules.** A check, heuristic or cleanup step is added only
   after its failure has been seen or heard, and is removed if a model can do
   the job instead.
4. **Generation is not deterministic, so make it cheap to redo one piece.**
   Content-addressed caching gives reproducible builds and lets one line, effect
   or image be regenerated without touching the rest.
5. **The CLI is a model's toolbox.** Commands are fast, deterministic and offer
   `--json`, so an agent can loop: write, check, table-read, listen, adjust one
   thing, rebuild.
6. **Schemas grow by milestone.** Each version carries only what has been
   built. Fields for sound effects, music, art and captions are added by the
   milestones that build them, behind the schema version.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Story** | The source markdown file. |
| **Cast** | The narrator and characters, each with a voice and default delivery. |
| **Segment** | One unit of the script: a spoken line (narration is a line by the narrator) or a pause. Later milestones add credits, effects and music. |
| **Scene** | A run of segments. Starts at a `###` heading or a horizontal rule. Later carries one illustration. |
| **Chapter** | A `#` heading. |
| **Script** | The parsed, validated story (`script.json`). Pure data, no durations. |
| **Render** | One generated asset, cached by content hash. |
| **Timeline** | The script plus measured durations: every segment's start and end (`timeline.json`). |
| **Build** | One run that writes a `dist/` tree and `build.json`. |

## 3. Notation

Plain markdown carries the story. Front matter declares the production. Nothing
requires the tool to read.

### 3.1 Front matter (milestone 0)

```yaml
---
title: The Most Embarrassing Day of My Life
author: David East
imprint: East Side Audio     # spoken in the opening credit (milestone 3); never defaulted
language: en
gap: 400ms                   # the one default pause between segments
narrator:
  voice: Puck                # a Gemini voice name, or { provider: elevenlabs, id: … }
  delivery: warm, unhurried
cast:
  MAYA:
    voice: Kore
    delivery: quick, defensive
  DAD:
    voice: Charon
    delivery: dry, amused
---
```

- `title`, `narrator` and at least a `voice` per cast member are required.
- Cast keys are names used in the text; they match case-insensitively.
- Unknown keys are an error. A strict, explicit error is what lets a model
  correct itself.
- Later milestones add `credits` (3), `art` (6) and per-character `look` (A).

### 3.2 Narration and lines

Any paragraph, list or block quote that is not a line is narration, spoken by
the narrator. A paragraph that starts with a bold cast name and a colon is a
line:

```markdown
The bus was already moving when Maya realized.

**MAYA** *(whispering)*: Please tell me nobody saw that.

**DAD**: Everyone saw that.
```

- An optional italic parenthetical is that line's delivery, added to the
  character's default.
- Inline markdown is stripped for speech and kept for display.
- A new speaker needs a new paragraph.

### 3.3 Structure and pauses

- `#` heading: a chapter. `###` heading or a horizontal rule: a new scene.
  `##` headings are displayed, not spoken.
- Every segment is followed by the default `gap`. Anything else is written
  explicitly:

````markdown
```pause
1.5s
```
````

  A `pause` block replaces the gap at that point. Durations are `1.5s`,
  `1500ms` or `0:02`. Chapter and scene breaks get no special treatment; the
  author or the director step (section 8) adds pauses where they belong.
- Any other fenced code block is left out of the speech and kept for display.

### 3.4 Added by later milestones

Each is specified, implemented and tested in the milestone that needs it:

| Notation | Milestone |
|---|---|
| `credits:` front matter and credit segments | 3 |
| ` ```sfx ` blocks and their timing relative to lines | 4 |
| ` ```music ` blocks: fades, beds, ducking, transitions | 5 |
| ` ```scene ` art direction, `art:` and `look:` front matter | A, 6, 7 |
| Inline cues inside a sentence | when a story needs one |

### 3.5 Errors

`story check` reports only problems that would stop a build, each with file,
line and column:

| Code | Example |
|---|---|
| `missing-front-matter` | no front matter block |
| `bad-yaml` | YAML syntax error |
| `unknown-key` | `narator:` in front matter |
| `missing-field` | no `title`, no `narrator`, or a cast member without `voice` |
| `unknown-speaker` | `**MAYOR**:` with no `MAYOR` in the cast |
| `bad-duration` | ` ```pause ` containing `soon` |

## 4. Data model

Every file carries a `schema` field; readers reject an unknown major version.
Later milestones add segment kinds and fields as minor versions.

### 4.1 `script.json` (milestone 0)

```ts
interface StoryScript {
  schema: 'mdmedia.story.script/1';
  source: { path: string; sha256: string };
  meta: { title: string; author?: string; imprint?: string; language: string };
  gapMs: number;
  cast: Record<CastId, CastMember>;            // includes 'NARRATOR'
  chapters: Chapter[];
}

interface CastMember { id: CastId; voice: VoiceRef; delivery: string }
interface Chapter { id: string; index: number; title?: string; scenes: Scene[] }
interface Scene { id: string; index: number; title?: string; segments: Segment[] }

type Segment =
  | { kind: 'line'; id: string; speaker: CastId; text: string; display: string; delivery: string; source: SourceRange }
  | { kind: 'pause'; id: string; durationMs: number; source: SourceRange };
```

### 4.2 `timeline.json` (milestone 0)

```ts
interface StoryTimeline {
  schema: 'mdmedia.story.timeline/1';
  durationMs: number;
  chapters: { id: string; startMs: number; endMs: number }[];
  scenes: { id: string; chapterId: string; startMs: number; endMs: number }[];
  clips: { segmentId: string; render: string; startMs: number; endMs: number }[];
}
```

The scheduler places lines one after another: each line's duration, then the
default gap or the pause written after it. That is all it does.

### 4.3 `build.json` (milestone 1)

```ts
interface StoryBuild {
  schema: 'mdmedia.story.build/1';
  tool: { name: 'mdmedia'; version: string };
  source: { path: string; sha256: string };
  ffmpeg: { path: string; version: string };
  renders: Record<string, { segmentId: string; provider: string; model: string; durationMs: number; cached: boolean }>;
  outputs: { path: string; sha256: string; bytes: number }[];
}
```

## 5. Pipeline

```
story.md
  │ parseStory                 pure
  ▼
script.json
  │ render each line           providers, render cache            (milestone 1)
  ▼
durations
  │ scheduleStory              pure: durations + gaps
  ▼
timeline.json
  │ mix, normalize, encode     audio runtime (ffmpeg)             (milestone 1)
  ▼
dist/
```

Parsing and scheduling do no I/O and import nothing from Node, so they run
unchanged in a browser (Studio's live preview, later).

## 6. The audio runtime boundary

All ffmpeg use lives in one module behind a small interface, so a browser
implementation (Web Audio and Mediabunny) can replace it later. Only what
milestone 1 uses is defined now; image, video and other interfaces are added
with their milestones, and a capability registry only if a second runtime
appears.

```ts
interface MediaHandle {
  readonly id: string;
  readonly mimeType: string;
  stream(): ReadableStream<Uint8Array>;
  readonly localPath?: string;                 // Node only, so ffmpeg reads without copying
}

interface AudioRuntime {
  probe(input: MediaHandle): Promise<{ durationMs: number }>;
  /** Mix the timeline's clips into one master and normalize it to the loudness target. */
  mix(timeline: StoryTimeline, source: (renderKey: string) => MediaHandle, out: { loudnessLufs: number; truePeakDb: number }): Promise<MediaHandle>;
  encode(input: MediaHandle, format: 'mp3' | 'wav'): Promise<MediaHandle>;
}

interface RenderCache {
  get(key: string): Promise<MediaHandle | undefined>;
  put(key: string, data: Uint8Array, mimeType: string): Promise<MediaHandle>;
}
```

- The Node implementation spawns ffmpeg with argument arrays; it does not use
  `fluent-ffmpeg` (deprecated).
- ffmpeg is found in this order: `MDMEDIA_FFMPEG` (or an `ffmpegPath` option),
  an installed `ffmpeg-static`, then `ffmpeg` on the `PATH`. `ffmpeg-static` is
  an optional peer dependency, because it and its binary are GPL-3.0 and
  mdmedia is MIT. A missing binary is a clear error, not a crash.
- One contract test suite covers `AudioRuntime`; a browser implementation is
  accepted by passing the same suite.
- Loudness targets a published audiobook standard (−19 LUFS, −2 dBTP). Room
  tone, silence trimming and other cleanup are added only if milestone 1's
  renders are heard to need them.

Licensing (not legal advice): running ffmpeg yourself has no GPL obligations,
and generated media is not covered. Distributing the binary (for example a
public Studio image) means shipping the GPL text and pointing to that build's
source. Audio-only builds need only LGPL or BSD codecs; GPL enters with an
H.264 encoder for video (OpenH264 is the BSD alternative).

## 7. Public API (`mdmedia/story`)

Milestone 0:

```ts
import { parseStory, scheduleStory, renderKey } from 'mdmedia/story';

const { script, diagnostics } = parseStory(markdown, { path: 'story.md' });
const key = await renderKey(segment, script);           // content hash, see section 9
const timeline = scheduleStory(script, durations);      // durations by segment id
```

Milestone 1 adds:

```ts
import { buildStory, createNodeAudioRuntime, createFileRenderCache } from 'mdmedia/story';

const result = await buildStory({
  source: { path: 'story.md', markdown },
  outDir: 'dist/the-most-embarrassing-day',
  runtime: createNodeAudioRuntime(),
  tts,                                   // existing ITTSProvider
  cache: createFileRenderCache('.mdmedia/cache'),
  tableRead: false,
  signal,
  onEvent,
});
```

- Pure functions take and return plain data.
- `buildStory` reads nothing from globals or the environment except through the
  runtime it is given.
- Errors are `StoryError` with a `code` and, where it applies, a `SourceRange`.

## 8. The director step (after milestone 2)

Rather than coding heuristics for pacing, delivery or structure, an optional
model step turns any markdown or prose into canonical story notation, with
explicit cast, deliveries and pauses, written to a file the author can read and
edit:

```bash
mdmedia story direct notes.md -o story.md
```

It follows the pattern of the existing narration rewrite adapter. The parser
stays small and strict; the model handles what is ambiguous, once and visibly.
A model that can listen (Gemini understands audio) reviewing a table read and
suggesting pause changes is an option to try later, not part of the plan.

## 9. Caching

A render's cache key is a SHA-256 (Web Crypto, so it also works in a browser)
of what affects its bytes:

```
line: provider, model, voice, delivery (default + per line), spoken text, language, render version
```

- Segment ids name files only. Keys never include ids or positions, so
  inserting a line renumbers files without re-rendering anything.
- A change to gaps or pauses re-mixes without re-rendering voices.
- The cache lives in `.mdmedia/cache` next to the story; `--cache` moves it.
- Later milestones add keys for effects, music and images in the same way.

## 10. CLI

| Command | Milestone | What it does |
|---|---|---|
| `mdmedia story check <file> [--json]` | 0 | Parse and validate; diagnostics as `file:line:col code message`; exit 1 on errors |
| `mdmedia story build <file> [--out] [--table-read] [--cache] [--json]` | 1 | Render lines, schedule, mix, write `dist/` |
| `mdmedia story direct <input> -o <story.md>` | after 2 | Model step from section 8 |
| `cast`, `clean` | when needed | Previews and cleanup, added if real use asks for them |

Exit codes: `0` success, `1` errors in the story, `2` provider failure, `3`
ffmpeg missing, `130` cancelled. `story` is never chosen by extension routing.

## 11. Output

```
dist/<slug>/
  build.json
  script.json
  timeline.json
  audio/
    <slug>.mp3
    master.wav                                   # 48 kHz stereo, normalized
    lines/<chapter>/<NNNN>-<speaker>.wav         # each line as rendered
  text/
    transcript.md
```

- Milestone 3 adds `audio/<slug>.m4b`, `audio/chapters/` and `text/captions.vtt`.
  Milestones 4 and 5 add `audio/stems/` once there is more than one track.
  Art, the reader and video add `art/`, `player/` and `video/`.
- `slug` comes from the title; `--out` overrides it.
- Paths are stable for a given script, so a reader or agent can rely on them.

## 12. Testing

| Layer | How |
|---|---|
| Parser | Golden `script.json` for a few fixture stories; one test per error code |
| Scheduler | Golden timelines from fixed durations; clips never overlap and each gap equals what the script says |
| Cache keys | Inserting a line changes no other key; changing a delivery changes only that character's keys |
| Audio runtime | One contract suite, run against the Node implementation; skipped with a reason when no ffmpeg is available |
| Build | A fixture story built with a fake TTS provider that emits tones, so CI needs no network; check the output tree and durations |
| CLI | `--json` snapshots and exit codes |

## 13. Milestones

| # | Milestone | Usable at the end |
|---|---|---|
| 0 | Parser, schemas, scheduler, cache keys, `story check` | Write a story and get exact errors with positions; no audio |
| 1 | Audio runtime (ffmpeg), render cache, one call per line, `story build`, table read | A two-voice scene as an MP3; edit one line and only it re-renders |
| 2 | Any cast size, narrator between lines | Multi-character dialogue scenes |
| D | Director step | Turn loose notes into a story file a person can edit |
| 3 | Credits, M4B with chapters and cover, captions VTT | A standard audiobook |
| 4 | Sound effects | Effects where the story says |
| 5 | Music: fades, beds with ducking, transitions | A fully produced audio drama |
| S | Studio `story` media type | Write and listen from your phone |
| A | Prototype: character sheets and scene consistency | A go or no-go on art |
| B | Prototype: caption placement on one image | A go or no-go on captions |
| 6 | Art target and reader | Read and listen together |
| 7 | Art for every scene and chapter | An illustrated production |
| 8 | Captions with word highlighting | The graphic novel |
| 9 | Video (ffmpeg composition) | A shareable MP4 playthrough |

Each milestone specifies its own notation, schema fields and checks, and adds a
rule only after hearing or seeing the problem it solves. A and B run alongside
1 to 3.

## 14. Decisions (settled 2026-10-18)

1. **Name: `story`** for the media type, CLI group and package subpath.
2. **Lines: `**NAME** *(delivery)*: text`**, names matched case-insensitively.
3. **Speech: one provider call per line by default.** ElevenLabs Text to
   Dialogue is tried in milestone 2 and kept only if it clearly sounds better.
4. **Master: 48 kHz stereo**, lines at their native 24 kHz mono.
5. **ffmpeg: resolved at runtime** (`MDMEDIA_FFMPEG`, an installed
   `ffmpeg-static`, then `PATH`); `ffmpeg-static` is an optional peer
   dependency. Studio keeps its direct dependency.
6. **Credits (milestone 3): default templates you can override.** Opening:
   "{imprint} presents… {title}, by {author}. Read to you by {narrator voice}."
   (starting at the title when there is no imprint). Closing: "This has been
   {title}, by {author}. The End." Custom text replaces either. A real
   publisher's name is never a default.
