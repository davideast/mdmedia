# Story: design

A **story** is a markdown document that builds into a dramatic audio recording
(narrator, cast, sound effects, music) and, optionally, an illustrated graphic
novel and an MP4 playthrough. mdmedia treats it like a build tool: a source
file compiles to a timeline, renders are cached by content, and a build writes
a predictable output tree.

This document settles everything that has to be decided before implementation:
the notation, the data model, the platform boundaries, the public API, the CLI,
the output layout, caching, testing and the order of work. Later plans in this
folder (`001-…`) are step-by-step implementation plans that point back here.

- **Status**: draft for review
- **Planned at**: commit `4eb8f62`, 2026-10-18
- **Scope of v0**: audio only (milestones 0 to 5). Art, captions, the reader and
  video are designed here so v0 does not paint them into a corner, but they are
  built later.

## 1. Goals and non-goals

**Goals**

1. One markdown file is the whole production: cast, delivery, cues, scenes.
   It stays readable as plain markdown on GitHub or in any editor.
2. The output sounds produced: paced dialogue, level-matched voices, music that
   ducks under speech, crossfaded transitions, opening and closing credits.
3. Every part is usable alone. A two-voice narration, an audiobook with credits,
   or a narration with a music bed uses the same modules as the full graphic
   novel.
4. Builds are incremental and reproducible. Editing one line re-renders one
   line. The same source and cache give byte-identical output.
5. Platform work sits behind interfaces. v0 ships Node implementations backed
   by ffmpeg; a browser implementation (Web Audio, WebCodecs, Mediabunny) can
   be added later without changing callers.

**Non-goals for v0**

- Generated video clips (the MP4 in this design is a composition of stills).
- A visual timeline editor.
- Real-time collaborative editing of stories in Studio.
- Inline cues inside a sentence (reserved syntax only; see 3.6).

## 2. Concepts

| Term | Meaning |
|---|---|
| **Story** | The source markdown file. |
| **Cast** | The narrator and characters, each with a voice and default delivery. |
| **Segment** | One unit on the timeline: a spoken line, a narration paragraph, a sound effect, a music cue, a pause, or a credit. |
| **Scene** | A run of segments sharing one illustration. Starts at a `###` heading or a `scene` block. |
| **Chapter** | A `#` heading. Chapters carry transition music and chapter art. |
| **Script** | The parsed, validated story (`script.json`). Pure data, no durations. |
| **Render** | One generated asset (a line's audio, an effect, a music cue, an image), cached by content hash. |
| **Timeline** | The script plus measured durations and scheduling: every segment's start, end, gain and fades (`timeline.json`). |
| **Target** | One kind of output: `audio`, `text`, `art`, `video`, `player`. |
| **Build** | One run that writes a `dist/` tree and `build.json`. |

## 3. Notation (v0)

Plain markdown carries the story. Front matter declares the production. Fenced
blocks with a type carry cues where they happen. Nothing requires the tool to
read.

### 3.1 Front matter

```yaml
---
title: The Most Embarrassing Day of My Life
author: David East
imprint: East Side Audio          # used in the opening credit; never defaulted to a real publisher
language: en
narrator:
  voice: Puck                     # a Gemini voice name, or { provider: elevenlabs, id: … }
  delivery: warm, unhurried
cast:
  MAYA:
    voice: Kore
    delivery: quick, defensive
    look: 11 years old, curly hair, yellow raincoat     # used by art; ignored for audio-only builds
  DAD:
    voice: Charon
    delivery: dry, amused
credits:
  opening: true                   # "{imprint} presents… {title}, by {author}. Read by {cast}."
  closing: true                   # "The End."
pacing: default                   # or a map overriding the rules in section 9
art:                              # optional; absent means audio-only
  style: inked graphic novel, muted watercolor
  aspect: 3:2
---
```

Cast keys are upper-case names used in the text. A missing `voice` is an error.
Unknown top-level keys are an error, so typos fail fast.

### 3.2 Narration

Any paragraph that is not a line or a cue is narration, spoken by the narrator.
List items and block quotes are narration too. Inline markdown (`**`, `_`,
links) is stripped before speech and kept for display.

### 3.3 Lines

A paragraph that starts with a bold cast name followed by a colon is a line:

```markdown
**MAYA** *(whispering)*: Please tell me nobody saw that.
**DAD**: Everyone saw that.
```

- The name must be in `cast`; an unknown name is an error with its position.
- An optional italic parenthetical is that line's delivery. It is added to the
  character's default delivery, not substituted for it.
- A line continues until the end of the paragraph. A new speaker needs a new
  paragraph.

### 3.4 Structure

- `#` heading: chapter. Its text is the chapter title (spoken in a chapter
  credit if `credits.chapters` is on, and used for file names).
- `##` heading: part or section title, displayed but not spoken unless the
  pacing says so.
- `###` heading: a new scene.
- A horizontal rule (`---` in the body) is a scene break with a long pause.

### 3.5 Cue blocks

Fenced code blocks whose info string is a cue type. Their body is YAML.

````markdown
```sfx
prompt: whole bus bursts out laughing
duration: 3s
at: after         # after (default) | with | before — relative to the previous segment
gain: -6dB
```

```music
cue: intro        # intro | outro | bed | transition | stinger
prompt: playful pizzicato, light percussion
fade_in: 2s
fade_out: 3s
duck: -14dB       # gain under speech while it plays; omitted means no ducking
until: chapter    # bed only: chapter | scene | next-music
```

```pause
duration: 1.5s
```

```scene
art: the school bus aisle from Maya's seat, everyone turned around
characters: [MAYA]
```
````

Rules:

- A block with an unknown type is passed through as a normal code block and a
  warning is reported, so documentation code samples still work.
- `at: with` overlaps the previous segment (an effect under a line). `before`
  places it so it ends as the next segment starts.
- Durations are written `1.5s`, `1500ms` or `0:02`.
- Every cue gets a stable id from its position and content (section 8).

### 3.6 Reserved for later

- `{sfx: door}` inline markers for mid-sentence effects.
- `[whispers]`-style inline delivery tags passed through to providers that
  support them (ElevenLabs v3).

They are parsed as plain text in v0 and flagged by `story check` so authors
know they are not yet active.

### 3.7 Validation

`story check` reports diagnostics with file, line and column:

| Code | Severity | Example |
|---|---|---|
| `unknown-speaker` | error | `**MAYOR**:` with no `MAYOR` in cast |
| `missing-voice` | error | cast entry without `voice` |
| `unknown-key` | error | `narator:` in front matter |
| `bad-duration` | error | `duration: soon` |
| `unknown-block` | warning | ` ```sfxx ` |
| `reserved-syntax` | warning | `{sfx: door}` in text |
| `voice-unavailable` | error | an ElevenLabs voice the account cannot use (needs network; `check --online`) |

## 4. Data model

All three files carry a `schema` field with a version. Readers reject an
unknown major version.

### 4.1 `script.json` (parse output, no durations)

```ts
interface StoryScript {
  schema: 'mdmedia.story.script/1';
  source: { path: string; sha256: string };
  meta: { title: string; author?: string; imprint?: string; language: string };
  cast: Record<CastId, CastMember>;          // includes 'NARRATOR'
  credits: { opening: boolean; closing: boolean; chapters: boolean };
  pacing: PacingRules;                        // resolved: defaults merged with overrides
  art?: ArtDirection;
  chapters: Chapter[];
}

interface CastMember { id: CastId; voice: VoiceRef; delivery: string; look?: string }

interface Chapter { id: string; index: number; title: string; scenes: Scene[] }
interface Scene { id: string; index: number; title?: string; art?: SceneArt; segments: Segment[] }

type Segment =
  | { kind: 'line'; id: string; speaker: CastId; text: string; display: string; delivery: string; source: SourceRange }
  | { kind: 'sfx'; id: string; prompt: string; durationMs?: number; at: 'after' | 'with' | 'before'; gainDb: number; source: SourceRange }
  | { kind: 'music'; id: string; cue: MusicCue; prompt: string; fadeInMs: number; fadeOutMs: number; duckDb?: number; until?: 'chapter' | 'scene' | 'next-music'; source: SourceRange }
  | { kind: 'pause'; id: string; durationMs: number; source: SourceRange }
  | { kind: 'credit'; id: string; role: 'opening' | 'closing' | 'chapter'; text: string };
```

Narration is a `line` whose speaker is `NARRATOR`. Credits are generated
segments, so they render, cache and mix like any other line.

### 4.2 `timeline.json` (schedule)

```ts
interface StoryTimeline {
  schema: 'mdmedia.story.timeline/1';
  durationMs: number;
  sampleRate: 48000;
  channels: 2;
  chapters: { id: string; title: string; startMs: number; endMs: number }[];
  scenes: { id: string; chapterId: string; startMs: number; endMs: number; image?: string }[];
  clips: TimelineClip[];                      // sorted by startMs
  words?: { segmentId: string; startMs: number; endMs: number; charStart: number; charEnd: number }[];
}

interface TimelineClip {
  segmentId: string;
  track: 'voice' | 'sfx' | 'music';
  render: string;                             // cache key of the audio
  startMs: number;
  endMs: number;
  offsetMs: number;                           // into the render, for trims
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  duck?: { depthDb: number; attackMs: number; releaseMs: number };   // music under voice
}
```

The timeline is the only input to every renderer: the mixer, caption writer,
reader and video composer. Nothing downstream reads the markdown.

### 4.3 `build.json` (manifest)

```ts
interface StoryBuild {
  schema: 'mdmedia.story.build/1';
  tool: { name: 'mdmedia'; version: string };
  source: { path: string; sha256: string };
  targets: Target[];
  runtime: { name: string; capabilities: string[] };   // e.g. 'node-ffmpeg', ffmpeg version
  renders: Record<string, {                    // cache key -> provenance
    segmentId: string; kind: string; provider: string; model: string;
    durationMs?: number; bytes: number; cached: boolean; costUnits?: number;
  }>;
  outputs: { path: string; sha256: string; bytes: number }[];
  diagnostics: Diagnostic[];
}
```

## 5. Architecture

```
story.md
   │ parse            (pure)
   ▼
StoryScript ── resolve cast, credits, pacing defaults   (pure)
   │ plan             (pure: cache keys, what needs rendering, cost estimate)
   ▼
BuildPlan
   │ render           (providers: TTS, SFX, music, image; results into RenderCache)
   ▼
Renders + measured durations   (MediaProbe)
   │ schedule         (pure: pacing rules -> TimelineClip[])
   ▼
StoryTimeline
   │ targets          (runtime ports)
   ├─ audio:  AudioMixer -> master; AudioEncoder; AudiobookPackager -> m4b, mp3, chapters, stems, lines
   ├─ text:   transcript.md, captions.vtt, alignment.json   (pure)
   ├─ art:    ImageProcessor -> display sizes; caption layout   (later)
   ├─ video:  VideoComposer -> mp4   (later)
   └─ player: static reader bundle   (later)
```

Pure stages have no I/O and no platform dependency; they run unchanged in Node
and the browser and are tested with golden files. Everything with I/O goes
through a port.

## 6. Platform ports

Ports describe a job with data, never an ffmpeg operation. Each port has one
contract test suite; an implementation is accepted when it passes.

### 6.1 Media handles

Browsers have no file paths, so ports exchange handles, not paths.

```ts
interface MediaHandle {
  readonly id: string;                         // cache key or artifact path
  readonly mimeType: string;
  readonly bytes: number;
  stream(): ReadableStream<Uint8Array>;
  /** Node only: a local file path, so ffmpeg can read without copying. */
  readonly localPath?: string;
}

interface PcmAudio { sampleRate: number; channels: 1 | 2; frames: Float32Array[] }
```

### 6.2 The ports

```ts
interface MediaProbe {
  probe(input: MediaHandle): Promise<{ durationMs: number; sampleRate: number; channels: number; codec: string }>;
}

interface AudioDecoder {
  /** Provider output (wav, mp3) to PCM at the requested rate and channel count. */
  decode(input: MediaHandle, to: { sampleRate: number; channels: 1 | 2 }): Promise<PcmAudio>;
}

interface AudioMixer {
  /** Render the whole timeline to one PCM master, applying gain, fades and ducking. */
  mix(timeline: StoryTimeline, sources: (renderKey: string) => MediaHandle, opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<MediaHandle>;
}

interface LoudnessNormalizer {
  measure(input: MediaHandle): Promise<{ integratedLufs: number; truePeakDb: number }>;
  normalize(input: MediaHandle, target: { integratedLufs: number; truePeakDb: number }): Promise<MediaHandle>;
}

interface AudioEncoder {
  readonly formats: readonly AudioFormat[];    // e.g. ['wav', 'mp3', 'aac', 'opus']
  encode(input: MediaHandle, format: AudioFormat, opts?: { bitrateKbps?: number; range?: { startMs: number; endMs: number } }): Promise<MediaHandle>;
}

interface AudiobookPackager {
  /** One file with chapter markers, cover art and tags. */
  package(input: { audio: MediaHandle; chapters: { title: string; startMs: number }[]; cover?: MediaHandle; tags: AudiobookTags }, format: 'm4b' | 'mp3'): Promise<MediaHandle>;
}

interface ImageProcessor {                     // art target (later)
  resize(input: MediaHandle, opts: { width: number; format: 'webp' | 'png' | 'jpeg'; quality?: number }): Promise<MediaHandle>;
}

interface VideoComposer {                      // video target (later)
  compose(input: { timeline: StoryTimeline; image: (sceneId: string) => MediaHandle; audio: MediaHandle; captions?: MediaHandle; burnCaptions?: boolean; fps: number; size: { width: number; height: number } }): Promise<MediaHandle>;
}

interface ArtifactStore {                      // where a build writes (fs dir, OPFS, zip)
  write(path: string, data: MediaHandle | Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(prefix: string): Promise<void>;
}

interface RenderCache {                        // content-addressed renders (fs, IndexedDB)
  get(key: string): Promise<MediaHandle | undefined>;
  put(key: string, data: Uint8Array | MediaHandle, mimeType: string): Promise<MediaHandle>;
}

interface MediaRuntime {
  name: string;
  capabilities: ReadonlySet<Capability>;       // checked before a build starts
  probe: MediaProbe;
  decoder: AudioDecoder;
  mixer: AudioMixer;
  loudness: LoudnessNormalizer;
  encoder: AudioEncoder;
  audiobook: AudiobookPackager;
  images?: ImageProcessor;
  video?: VideoComposer;
}
```

`Capability` values such as `audio.mix`, `encode.mp3`, `package.m4b`,
`video.compose` let a build fail before rendering anything when a target is
impossible on the current runtime ("this runtime cannot write M4B; choose mp3").

### 6.3 Implementations

| Port | v0 (Node) | Later (browser) |
|---|---|---|
| `MediaProbe`, `AudioDecoder` | ffprobe / ffmpeg | Web Audio `decodeAudioData`; Mediabunny for containers |
| `AudioMixer` | ffmpeg `filter_complex` (`adelay`, `volume`, `afade`, `amix`, `sidechaincompress`) | `OfflineAudioContext` gain automation |
| `LoudnessNormalizer` | ffmpeg `loudnorm` (two pass) | an R128 meter over PCM |
| `AudioEncoder` | ffmpeg (`libmp3lame`, `aac`, `libopus`) | WebCodecs via Mediabunny |
| `AudiobookPackager` | ffmpeg with an `FFMETADATA` chapter file | Mediabunny MP4 with chapters, if supported; otherwise not offered |
| `ImageProcessor` | sharp | canvas `OffscreenCanvas.convertToBlob` |
| `VideoComposer` | ffmpeg (`zoompan`, `xfade`, ASS subtitles) | Mediabunny with canvas frames |
| `ArtifactStore`, `RenderCache` | filesystem | OPFS / IndexedDB / zip |

ffmpeg comes from `ffmpeg-static`, which Studio already uses, with an
`MDMEDIA_FFMPEG` override for a system binary. `createNodeRuntime()` checks the
binary and its version once and reports a clear error if it is missing.

`fluent-ffmpeg` is not used; it is deprecated. The Node runtime spawns ffmpeg
directly with argument arrays (no shell).

### 6.4 Providers

Providers stay where they are and are injected:

- `ITTSProvider` (Gemini, ElevenLabs). v0 adds an optional
  `streamAudioWithTimings` so providers that return word timestamps
  (ElevenLabs) can feed `timeline.words`; others fall back to the existing
  estimator.
- `ISoundEffectsProvider`, `IMusicProvider` as they are.
- A new `IImageProvider` interface wrapping `generateGeminiImage`, needed for
  the art target; reference images carry the character sheets.

## 7. Public API (`mdmedia/story`)

```ts
import { parseStory, planStory, scheduleStory, buildStory, createNodeRuntime } from 'mdmedia/story';

const { script, diagnostics } = parseStory(markdown, { path: 'story.md' });   // pure
const plan = planStory(script, { targets: ['audio', 'text'], cache });       // what renders, cache hits, cost estimate
const timeline = scheduleStory(script, durations);                           // pure; durations by segment id

const result = await buildStory({
  source: { path: 'story.md', markdown },
  outDir: 'dist/the-most-embarrassing-day',
  targets: ['audio', 'text'],
  runtime: createNodeRuntime(),
  providers: { tts, sfx, music, images },
  cache: createFileRenderCache('.mdmedia/cache'),
  store: createDirectoryStore('dist/the-most-embarrassing-day'),
  only: { chapters: ['01-the-bus'] },          // optional partial build
  force: false,                                 // ignore cache hits
  tableRead: false,                             // fast, cheap voices for pacing passes
  signal,
  onEvent: (event) => {},                       // typed progress events
});
// result: { build: StoryBuild; timeline: StoryTimeline; outputs: string[] }
```

Rules:

- Pure functions take and return plain data and never touch I/O, so Studio can
  run `parseStory` and `scheduleStory` in the browser for live previews.
- `buildStory` never reads globals or environment variables; everything comes
  in through its options.
- Errors are `StoryError` with a `code` and, where it applies, a
  `SourceRange`.
- Events extend the existing pipeline event bus types:
  `parse:done`, `render:start|done|cached`, `schedule:done`,
  `target:start|done`, `build:done`.

## 8. Caching and incrementality

A render's cache key is a SHA-256 of everything that affects its bytes:

```
line:   provider, model, voice, delivery (default + per line), normalized text, language, tool render version
sfx:    provider, model, prompt, duration, loop, tool render version
music:  provider, model, prompt, cue kind, tool render version
image:  provider, model, prompt, style, aspect, reference image keys, tool render version
```

- Segment ids are derived from chapter, scene, kind and an ordinal, for file
  names only. Cache keys never include ids or ordinals, so inserting a line
  renumbers files without re-rendering anything.
- Mixing and encoding outputs are keyed by the timeline hash plus runtime
  version, so a pacing change re-mixes without re-rendering voices.
- `.mdmedia/cache` lives next to the story by default; `--cache <dir>` moves
  it. `story clean` removes `dist/`; `story clean --cache` also prunes renders
  no longer referenced by any build manifest in the project.
- Encoded files use fixed metadata dates so identical inputs give identical
  bytes.

## 9. Pacing

The scheduler turns segments into clips with these rules. All values are
defaults that front matter `pacing:` can override.

| Rule | Default |
|---|---|
| Gap between two lines by different speakers | 350 ms |
| Gap between two lines by the same speaker | 600 ms |
| Gap after narration before a line, and the reverse | 500 ms |
| Gap at a scene break | 1.5 s |
| Gap at a chapter break (before transition music) | 2.5 s |
| Opening credit to first chapter | 2 s |
| Room tone under voice tracks | on, −60 dBFS |
| Music duck under speech | as written on the cue; attack 120 ms, release 600 ms |
| Target loudness | −19 LUFS integrated, −2 dBTP |

Each line's render is trimmed of leading and trailing silence before
scheduling, so the gaps above are the real gaps. `story build --table-read`
uses a fast model and skips music so pacing can be tuned in seconds.

## 10. CLI

```
mdmedia story check <story.md> [--online] [--json]
mdmedia story plan  <story.md> [--targets audio,text] [--json]
mdmedia story build <story.md> [--out dist/<slug>] [--targets audio,text,art,video,player]
                               [--chapter 01-the-bus] [--force] [--table-read] [--cache .mdmedia/cache] [--json]
mdmedia story cast  <story.md> [--preview MAYA] [--json]
mdmedia story clean <story.md> [--cache]
```

| Command | What it does | Network |
|---|---|---|
| `check` | Parse and validate; print diagnostics with positions | no (`--online` checks voices) |
| `plan` | Show what would render, cache hits, estimated provider calls and cost | no |
| `build` | Render, schedule and write the requested targets | yes |
| `cast` | List the cast with voices and deliveries; `--preview` renders one sample line per character | yes for previews |
| `clean` | Remove the build output, optionally prune the cache | no |

- Default targets are `audio,text`. `art`, `video` and `player` are rejected
  in v0 with a message naming the milestone that adds them.
- `--json` prints machine-readable results for agents and CI.
- Exit codes: `0` success, `1` diagnostics with errors, `2` provider failure,
  `3` runtime missing a capability (for example no ffmpeg), `130` cancelled.
- `.mdmedia.json` may hold a `story` section with defaults (`out`, `cache`,
  `targets`, provider choice), lower precedence than flags.
- The existing extension routing is unchanged; `story` is always explicit.

## 11. Output

```
dist/<slug>/
  build.json
  script.json
  timeline.json
  audio/
    <slug>.m4b
    <slug>.mp3
    master.wav                                  # 48 kHz stereo, normalized
    chapters/00-opening-credits.mp3 … 99-closing-credits.mp3
    stems/voices.wav  sfx.wav  music.wav
    lines/<chapter>/<NNNN>-<speaker|sfx-slug|music-cue>.wav
  text/
    transcript.md
    captions.vtt                                # <v Speaker> spans, word timestamps when known
    alignment.json
  art/                                          # art target (later)
    cover.png
    characters/<id>.png
    scenes/<chapter>/<NN>.png  <NN>.webp  <NN>.thumb.webp
    chapters/<chapter>.png
    layout/<chapter>/<NN>.json
  video/<slug>.mp4                              # video target (later)
  player/index.html                             # player target (later)
```

- `slug` is derived from the title (`the-most-embarrassing-day`), overridable
  with `--out`.
- Chapter files are slices of the master, so transitions match the full file.
- Lines stay at the provider's native format (24 kHz mono) and are trimmed and
  level-matched copies of their renders.
- Paths are stable for a given script; a reader or agent can rely on them.

## 12. Studio integration (after v0)

- A new `story` media type in `MediaType`, with the same output tree stored
  under `stories/{uid}/{id}/` and served through the existing asset routes.
- Studio uses the same `buildStory` with the Node runtime on the server; the
  browser runs `parseStory` and `scheduleStory` for the editor's live
  diagnostics and timeline preview.
- Retention applies to stories like any other media; `master.wav` and `stems/`
  default to a short TTL because they can be rebuilt from the cache.

## 13. Testing

| Layer | How |
|---|---|
| Parser | Golden files: `test/story/fixtures/*.md` → expected `script.json`, plus one test per diagnostic code |
| Scheduler | Golden timelines from fixed fake durations; property tests (no overlaps on the voice track, gaps match rules) |
| Ports | One contract suite per port in `test/story/contracts/`, run against the Node runtime now and the browser runtime later |
| Providers | A deterministic fake TTS, SFX and music provider that emits tones of a length derived from the text, so full builds run offline in CI |
| Build | End-to-end build of a fixture story with fake providers; assert the output tree, `build.json`, durations (via `MediaProbe`) and loudness within tolerance |
| CLI | `--json` output snapshots and exit codes |

CI already runs `bun test` at the repository root; ffmpeg-backed tests skip
with a reason when no ffmpeg binary is available, the same way the Studio
render test skips without Studio's React.

## 14. Milestones

| # | Milestone | Exit criteria |
|---|---|---|
| 0 | Notation, schemas, parser, scheduler with fake durations, `story check` and `story plan` | Golden tests pass; three fixture stories produce `script.json` and `timeline.json`; no audio |
| 1 | Node runtime (probe, decode, mix, loudness, encode), render cache, two voices, `story build --targets audio,text`, table read | A two-voice scene builds to `master.wav`, `.mp3` and `lines/`; editing one line re-renders one line |
| 2 | Any cast size, narration between lines, pacing overrides | A multi-character scene sounds paced; property tests hold |
| 3 | Opening, chapter and closing credits; `.m4b` with chapters and cover | The audiobook opens in a standard player with chapters |
| 4 | Sound effect cues (`after`, `with`, `before`) | Effects land where written; stems separate cleanly |
| 5 | Music cues: intro, outro, beds with ducking, chapter transitions | A full chapter production at target loudness |
| A | Prototype (in parallel with 1 to 3): character sheets and scene consistency | A go or no-go on the art approach; any notation changes folded back here |
| B | Prototype (in parallel with 1 to 3): caption placement on one image | A go or no-go on caption layout |
| 6 | Art target and reader (two columns on desktop, stacked on phone) | An illustrated build plays in `player/index.html` |
| 7 | Scene and chapter art across a story | A consistent illustrated production |
| 8 | Captions with word highlighting | The graphic novel |
| 9 | Video target (ffmpeg composition) | `video/<slug>.mp4` matches the timeline |

Milestones 0 to 5 ship a multi-voice audiobook on their own.

## 15. Decisions needed before milestone 0

1. **Name.** `story` for the media type, CLI group and package subpath, as used
   here. Alternatives: `drama`, `production`.
2. **Line syntax.** `**NAME** *(delivery)*: text` as above, versus
   Fountain-style upper-case names on their own line. The bold form reads
   well in any markdown renderer and needs no blank-line rules.
3. **Default speech renderer.** One provider call per line (works with both
   providers and any cast size) as the default, with ElevenLabs Text to
   Dialogue as an opt-in renderer for conversational runs.
4. **Master format.** 48 kHz stereo, so stereo music survives; lines stay at
   24 kHz mono.
5. **ffmpeg source.** `ffmpeg-static` by default with an `MDMEDIA_FFMPEG`
   override, matching Studio.
6. **Credits wording.** The opening credit template in 3.1, with `imprint`
   required for it to be spoken and never defaulted to a real publisher.
