# Plan 002: Story milestone 1 — voices in context, checked, built

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat <milestone 0 merge>..HEAD -- src/story src/tts src/cli/command.ts package.json`
> On any change that contradicts "Current state", STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (providers, ffmpeg, non-deterministic output)
- **Depends on**: [001](001-milestone-0-parse-check.md) merged; [000 design](000-design.md) sections 5, 9, 10, 11, 12, 13
- **Category**: feature
- **Planned at**: commit `4eb8f62`, 2026-10-22

## Why this matters

This is the audio drama: every line voiced in character, knowing what was just
said, checked against the script, and mixed into an MP3. The prototype settled
each mechanism (findings runs 2, 3, 5); this plan builds them into the package
with fakes for CI and one live run against the prototype's lunch scene.

## Scope

In: ports for speech and transcription; the delivery note builder; the refusal
fallback ladder; the transcript diff; the render-and-check loop with bounded
retakes; the file render cache; the scheduler; the Node audio runtime (ffmpeg:
probe, mix, loudness, encode); `buildStory`; `mdmedia story build`; `build.json`.

Out: music (milestone 2), the director (3), comics (4 to 6), clip-edge trimming
(open; measured and recorded only).

## Current state

- `GeminiTTSProvider` (`src/tts/gemini-tts-provider.ts`) implements
  `ITTSProvider.streamAudio(text, voice, promptStyle)`. For
  `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` it sends `text` as the
  spoken words and `promptStyle` as a separate `speech_metadata` style, and asks
  for 24 kHz 16-bit PCM. Non-retryable errors are thrown with `code` and
  `status` copied from the stream's error event.
- Refusals arrive as HTTP 400 with body code `prohibited_content` ("Input
  blocked…"), nested at `error.error.error.code` on the SDK error in the
  prototype (`spike/story`, `spikes/story/render.ts`).
- There is no speech-to-text provider in `src/`.
- `ffmpeg-static` is a dev dependency of the workspace (Studio depends on it).
- Milestone 0 provides `parseStory`, `lineRenderKey` and the script types.

## Decisions for this plan

1. **Default voice model `gemini-3.8-flash-tts`**; transcriber
   `gemini-3.5-flash-lite` (it stayed available when flash hit quota; findings
   run 2, 3). Both overridable.
2. **Retakes reuse the same request**: generation is not deterministic, so the
   same request gives a new take. A take is cached only after it passes.
3. **At most 2 retakes per line**, then the line is reported as failing with the
   best take kept (fewest missing plus extra words) so the build still finishes.
4. **No new dependencies.** ffmpeg via `MDMEDIA_FFMPEG`, an installed
   `ffmpeg-static`, then `PATH` (design 10).

## Files

| Path | Purpose |
|---|---|
| `src/story/ports.ts` | `Speaker`, `Transcriber`, `AudioRuntime`, `RenderCache`, `MediaHandle`, `MixPlan` |
| `src/story/note.ts` | `deliveryNote(line, script, level)` |
| `src/story/diff.ts` | `compareTranscript(expected, heard)` |
| `src/story/render-lines.ts` | The render, check and retake loop with the fallback ladder |
| `src/story/schedule.ts` | `scheduleStory(script, durations)` → timeline |
| `src/story/build.ts` | `buildStory(options)` |
| `src/story/node/ffmpeg.ts` | ffmpeg resolution and the Node `AudioRuntime` |
| `src/story/node/file-cache.ts` | `createFileRenderCache(dir)` |
| `src/story/node/gemini.ts` | `createGeminiSpeaker` (wraps `GeminiTTSProvider`), `createGeminiTranscriber` |
| `src/cli/story-command.ts` | adds `story build` |
| `test/story/fakes.ts` | tone speaker, scripted transcriber, in-memory cache |
| `test/story/*.test.ts` | tests named in each step |

`src/story/node/` may import `node:` modules; the rest of `src/story/` still
may not.

## Steps

### 1. Branch

Local branch `feat/story-m1` from `main` after 001 is merged (or from
`feat/story-m0` if not yet merged). Do not push.

### 2. Ports

```ts
interface Speaker {
  /** 24 kHz 16-bit mono PCM for `text`, voiced by `voice`, following `note`. */
  speak(req: { text: string; voice: VoiceRef; note: string; signal?: AbortSignal }): Promise<Uint8Array>;
  readonly id: string;                         // provider and model, for keys and build.json
}
class SpeechRefused extends Error {}           // speak() throws this for input-filter refusals

interface Transcriber {
  transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<string>;
}
```

`AudioRuntime`, `RenderCache`, `MediaHandle` as design 10; `MixPlan` is a list of
`{ handle, startMs }` clips for now (music beds come in milestone 2).

**Verify**: `bunx tsc --noEmit`.

### 3. Delivery note (pure)

`deliveryNote(line, script, level)`:

- level 0: the speaker's default delivery, the line's cue, and
  `Just before this, in the same scene: SPEAKER said "…". Then SPEAKER said "…".`
  for the two previous lines in story order (fewer at the start of a scene);
- level 1: the cue only;
- level 2: empty.

Parts joined with `. `; empty parts dropped. The context never crosses a scene
boundary (a new scene starts fresh).

**Verify**: `bun test test/story/note.test.ts` with lines from the lunch fixture,
including the first line of a scene (no context) and a narration line.

### 4. Transcript diff (pure)

`compareTranscript(expected, heard)` → `{ ok, missing: string[], extra: string[] }`:

- lower-case; strip punctuation; split on whitespace;
- normalize before comparing: number words and digits (`one` ⇄ `1`),
  `gonna`/`going to`, `wanna`/`want to`, split and joined compounds
  (`lawn mower` ⇄ `lawnmower`) by comparing with spaces removed when a run of
  words differs only by spacing;
- longest common subsequence for `missing` and `extra`;
- `ok` when both are empty.

**Verify**: `bun test test/story/diff.test.ts` with these prototype pairs:

| Expected | Heard | ok |
|---|---|---|
| I tried to laugh. It sounded like a lawn mower failing to start. | I tried to laugh. It sounded like a lawnmower failing to start. | yes |
| Yeah! Right before we announce the new host. It's going to kill! | Yeah, right before we announce the new host, it's gonna kill. | yes |
| For one second, I thought she'd laugh. | For 1 second, I thought she'd laugh. | yes |
| What. Clip. | What? | no, missing `clip` |
| You promised. | Ugh. You promised. | no, extra `ugh` |
| I know, but— | I know. | no, missing `but` |

Names misheard by the transcriber ("Harper Black", "Mylo") will still fail;
that is accepted for now and visible in `build.json`. Do not add name
dictionaries without a recorded failure that needs them.

### 5. Render, check, retake

`renderLines(script, { speaker, transcriber, cache, concurrency })` for every
line, in order of ids, with at most `concurrency.speak` (default 4) speech calls
and `concurrency.transcribe` (default 6) transcriptions in flight:

1. `key = lineRenderKey(line, script, speaker.id)`. A cache hit marked accepted
   is used as is.
2. Speak at note level 0. On `SpeechRefused`, retry at level 1, then level 2;
   record the level used. Refused at level 2: the line fails with reason
   `refused`, 1 s of silence stands in, and the build continues.
3. Transcribe the take; `compareTranscript(line.text, heard)`.
4. Not ok: retake (same request) up to 2 times. Keep the take with the fewest
   `missing + extra`.
5. Cache the kept take with its check result; mark it accepted only if `ok`.
6. Busy errors (429, 500, 503, timeouts) retry with backoff inside the provider
   wrappers and do not count as retakes.

Each line's result: `{ id, key, cached, level, attempts, heard, missing, extra, ok, durationMs }`.

**Verify**: `bun test test/story/render-lines.test.ts` with fakes:
- a transcriber scripted to mismatch once makes exactly one retake, then caches
  the passing take as accepted;
- a transcriber that always mismatches gives 3 attempts, `ok: false`, the best
  take kept and not marked accepted;
- a speaker that refuses at level 0 records level 1;
- a second run with the same cache makes no speech calls for accepted lines and
  re-renders unaccepted ones;
- editing one line's text re-renders that line and the next two in its scene only.

### 6. Scheduler (pure)

`scheduleStory(script, durations)`: lines in order, each followed by the
script's `gapMs`, replaced by any pause written after it (consecutive pauses
add up); no gap after the last line. Timeline lines carry `startMs`, `endMs`,
`speaker`, `narration`, `text`; scenes and chapters carry their spans.

**Verify**: `bun test test/story/schedule.test.ts`: fixed durations give golden
timelines; clips never overlap; every gap equals `gapMs` or the written pause.

### 7. Node audio runtime and cache

- `resolveFfmpeg()`: `MDMEDIA_FFMPEG`, then `require.resolve('ffmpeg-static')`
  if installed, then `ffmpeg` on `PATH`; missing is `StoryError('ffmpeg-missing')`.
- `probe` via `ffmpeg -i` duration parsing; `mix` writes clips at their start
  times into one 24 kHz track (in TypeScript: PCM placement, as the prototype
  did), then ffmpeg converts to 48 kHz stereo with `loudnorm=I=-19:TP=-2`;
  `encode` to MP3 (160 kb/s) or WAV.
- `createFileRenderCache(dir)`: `<dir>/<key>.wav` plus `<key>.json` holding the
  check result and `accepted`.

**Verify**: `bun test test/story/audio-runtime.test.ts` (skipped with a printed
reason when ffmpeg cannot be resolved): mixing two tone clips at known offsets
gives the expected duration within 20 ms, and the output measures −19 LUFS ±1.

### 8. `buildStory` and output

`buildStory({ source, outDir, speaker, transcriber, runtime, cache, signal, onEvent })`
parses (errors stop the build with code 1), renders and checks lines, schedules,
mixes and writes design 12's tree: `build.json`, `script.json`, `timeline.json`,
`audio/<slug>.mp3`, `audio/master.wav`, `audio/lines/...wav`,
`text/transcript.md`. `build.json` lists every line result from step 5, totals
(lines, cached, retakes, refusals, failures, audio seconds), the models, and the
ffmpeg path and version.

`onEvent` emits `line-start`, `line-done` (with the check result), `mix-done`,
`build-done`.

**Verify**: `bun test test/story/build.test.ts` with fakes: the output tree
exists, durations add up, a scripted persistent mismatch yields `failures: 1` in
`build.json`.

### 9. CLI

`mdmedia story build <story.md> [--out dir] [--cache dir] [--voice-model id]
[--transcribe-model id] [--json]`:

- reads the Gemini key the way the existing CLI does (config, then
  `GEMINI_API_KEY`);
- prints one line per line rendered (`✓`, `↻ retake`, `⚠ fallback`, `✗ failed`)
  unless `--json`, which prints the `build.json` summary;
- exit codes per design 11: `0`, `1`, `2`, `3`, `4` (built with failing
  checks), `130`.

**Verify**: `bun test test/story/cli.test.ts` (fakes injected through the
command's test seam): exit 4 with a scripted failure; `--json` shape.

### 10. Live run (needs a Gemini key; not in CI)

```bash
bun run build
node dist/bin.js story build test/story/fixtures/lunch-voices.md --out /tmp/story-m1 --json > /tmp/story-m1.json; echo $?
```

`lunch-voices.md` is the prototype's `comic-lunch-voices.md`. Expect 37 lines,
roughly 110 s of audio, and most lines passing; the prototype's take C had 29 of
37 exact before any retake. Record in the PR description: lines, retakes,
refusals, failures (with what was heard), wall time, and audio tokens if the API
reports them. Listen to `audio/<slug>.mp3` across "What. Clip." to "The dancing
one".

### 11. Full checks

```bash
bunx tsc --noEmit
bun test
bun run build
bun run verify
grep -rn "from 'node:" src/story --include=*.ts | grep -v "src/story/node/" && echo "STOP" || echo "core is platform-free"
```

## Done when

- Every step's tests pass, with fakes; CI needs no network.
- A live build of the lunch voices fixture finishes, with retakes, refusals and
  failures listed in `build.json`, and the MP3 plays.
- Editing one cue in the fixture and rebuilding re-renders that line and the
  next two in its scene only (check the `cached` flags).
- Committed locally on `feat/story-m1`, not pushed.

## STOP conditions

- `GeminiTTSProvider` no longer sends `promptStyle` as a separate field for the
  3.8 models.
- Refusals cannot be told apart from other 400 errors.
- The live run fails more than a third of lines after retakes (the prototype's
  rate was far lower; something is wrong with the note or the diff).
- A dependency seems necessary.
- `bun test` fails outside `test/story/`.
