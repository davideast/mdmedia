# Plan 003: Story milestone 2 — music, and sharper line checks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 107a0df..HEAD -- src/story src/music src/cli/story-command.ts package.json`
> On any change that contradicts "Current state", STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (a second provider, an ffmpeg filter graph)
- **Depends on**: [002](002-milestone-1-voices.md) (`feat/story-m1`, 107a0df); [000 design](000-design.md) sections 5, 6, 9, 10, 12
- **Category**: feature
- **Planned at**: commit `107a0df`, 2026-10-22

## Why this matters

This turns the checked voice track into a scored audio drama, the way the
prototype's run 3 did and you heard as "pretty good". It also folds in the
follow-up from milestone 1's live run: the three lines still flagged there were
the transcriber mishearing a name ("Milo" as "Mylow", "to Harper" as "a
harper") and leaving out a "Heh" the voice laughed instead of saying. Fixing
the check saves retakes and false failures on every build.

## Scope

In:

- **Checks**: the transcriber gets the cast names; a missing non-lexical
  interjection is noise when it is the only difference.
- **Music**: a `Composer` port with a Lyria adapter; one clip per scene music
  cue, cached; scene leads in the schedule; the bed and outro mix in the audio
  runtime; `build.json` and the output tree gain music; `--no-music`.

Out: longer scores, crossfades, per-line music, sound effects, the director.

## Current state

- Milestone 0 parses ` ```music ` blocks into `scene.music` (string).
- Milestone 1 (`feat/story-m1`): `renderLines`, `scheduleStory(script,
  durations, renders)`, pure `mixClips`, `AudioRuntime.master(pcm, target)`
  and `mp3(wav, kbps)`, `buildStory`, `createGeminiTranscriber` with a fixed
  prompt, `compareTranscript(expected, heard)`.
- `LyriaMusicProvider` (`src/music/lyria-music-provider.ts`) implements
  `IMusicProvider.generate(prompt, { model })` → `{ audioBytes, mimeType }`.
  `lyria-3-clip-preview` returns about 30 s of MP3 in 10 to 14 s (findings run
  3).
- The prototype's mix (`spike/story`, `spikes/story/tools/mix.ts`): 3 s of
  music alone before a scene's first line; the clip normalized to −18 LUFS,
  full for the lead, down to 0.3 (about −10 dB) over 1.5 s, held to 16 s
  after the lead, faded out over 6 s; the first cue's clip again over a 12 s
  outro after the last line; then a limiter and loudness normalization.

## Decisions for this plan

1. **Interjections**: a fixed list of non-lexical sounds (`heh`, `hah`, `ha`,
   `hmm`, `mm`, `huh`, `uh`, `um`, `er`, `ah`). Missing ones are ignored when
   nothing else differs. Extra ones still fail: the prototype's added "Ugh"
   before "You promised" was a real defect.
2. **Names**: the transcription prompt lists the cast's display names
   ("Names you may hear: Milo, June, Harper"). No dictionary or fuzzy matching
   in code.
3. **Music mixes in ffmpeg**, not in TypeScript: the clips are 48 kHz stereo
   and should not pass through the 24 kHz mono voice track. The runtime takes a
   `MixPlan`; the gain envelopes are built by pure code and passed as data.
4. **Leads are part of the schedule**: a scene with music starts its first line
   `leadMs` (3000) after the scene starts, so every time in `timeline.json`
   already includes them.
5. **No music check yet.** Lyria clips were instrumental in every prototype
   run; a vocal check is added only if a clip is heard to have vocals.
6. **Default model `lyria-3-clip-preview`**; overridable.

## Files

| Path | Purpose |
|---|---|
| `src/story/diff.ts` | interjection rule |
| `src/story/ports.ts` | `Composer`; `MixPlan`; `AudioRuntime.mix` replaces `master` |
| `src/story/music.ts` | `musicRenderKey`, `renderMusic`, `buildMixPlan` (pure envelopes) |
| `src/story/schedule.ts` | scene leads |
| `src/story/build.ts` | music in the build; `build.json` music section |
| `src/story/node/ffmpeg.ts` | `mix(plan)` with the filter graph |
| `src/story/node/gemini.ts` | cast names in the transcription prompt |
| `src/story/node/lyria.ts` | `createLyriaComposer` (wraps `LyriaMusicProvider`) |
| `src/story/node/files.ts` | music cache entries |
| `src/cli/story-command.ts` | `--no-music`, `--music-model` |
| `test/story/*.test.ts` | tests named in each step |

## Steps

### 1. Branch

Local branch `feat/story-m2` from `feat/story-m1`. Do not push.

### 2. Interjections

In `compareTranscript`, after computing `missing` and `extra`: when `extra` is
empty and every word in `missing` is in the interjection list, the result is
`ok: true` with `missing` kept (so `build.json` still shows it).

**Verify**: `bun test test/story/diff.test.ts`, adding:

| Expected | Heard | ok |
|---|---|---|
| Heh. Okay. Funny story. | Okay. Funny story. | yes (missing `heh` kept) |
| Hmm. Six out of ten. | Six out of ten. | yes |
| You promised. | Ugh. You promised. | no (extra `ugh`) |
| Heh. Okay. Funny story. | Okay. Story. | no (missing `funny`) |

### 3. Names in the transcription prompt

`Transcriber.transcribe(wav, { names, signal })`: `names` is the cast's ids in
title case (`MILO` → `Milo`), with `NARRATOR` left out. The Gemini prompt adds
`Names you may hear: Milo, June, Harper.` `renderLines` passes them.

**Verify**: a fake transcriber records the names it was given;
`bun test test/story/render-lines.test.ts` asserts every call received the
script's names.

### 4. Composer and music cache

```ts
interface Composer {
  readonly model: string;
  /** About 30 s of instrumental music, as MP3 or WAV bytes. */
  compose(prompt: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
```

- `musicRenderKey(prompt, model)` hashes `RENDER_VERSION`, the model and the
  full prompt sent: `Instrumental only, no vocals. ` + the cue.
- `renderMusic(script, { composer, cache })` composes each distinct cue once
  (two scenes with the same cue share a clip), at most 2 at a time, and caches
  by key. A failure is reported per scene and that scene builds without music.
- `RenderCache` gains `getMusic(key)` / `putMusic(key, bytes, mimeType)`; the
  file cache stores `<key>.mp3`.
- `createLyriaComposer({ apiKey, model })` wraps `LyriaMusicProvider`.

**Verify**: `bun test test/story/music.test.ts` with a fake composer: one call
per distinct cue, a second run makes none, a failing cue is reported and the
other scenes keep their music.

### 5. Scene leads

`scheduleStory(script, durations, renders, { leadMs })`: when a scene has
music, its first line starts `leadMs` after the scene's start (`scene.startMs`
is where the music starts). Default `leadMs` is 3000 when music is on, 0 when
off. With music off, timings equal milestone 1's exactly.

**Verify**: `bun test test/story/schedule.test.ts`: a two-scene fixture with
music on scene 2 only; scene 2's first line starts 3000 ms later than without
music; scene 1 is unchanged; with `leadMs: 0` the timeline equals the milestone
1 golden.

### 6. Mix plan (pure)

`buildMixPlan(timeline, voice, music)` returns:

```ts
interface MixPlan {
  voice: Uint8Array;                         // 24 kHz mono PCM, the voice track
  beds: Array<{
    audio: Uint8Array; mimeType: string;
    atMs: number;                            // where the clip starts on the timeline
    envelope: Array<[number, number]>;       // [ms from clip start, gain], linear between points
  }>;
  durationMs: number;                        // voice end plus the outro
}
```

- A scene bed starts at `scene.startMs`; envelope
  `[[0,1],[lead,1],[lead+1500,0.3],[lead+16000,0.3],[lead+22000,0]]`.
- The outro: the first cue's clip at `voiceEndMs - 1000`; envelope
  `[[0,0.3],[1000,1],[8000,1],[13000,0]]`; `durationMs = voiceEndMs + 12000`.
- With no music, `beds` is empty and `durationMs` is the voice length.

**Verify**: `bun test test/story/music.test.ts`: envelopes and positions for a
fixed timeline; no beds when music is off.

### 7. Runtime mix

Replace `AudioRuntime.master(pcm, target)` with `mix(plan, target)`, returning
the 48 kHz stereo master WAV. The Node implementation writes the voice as a WAV
and each bed to a temporary file, then runs one ffmpeg graph: the voice
resampled to 48 kHz stereo; each bed resampled, normalized to −18 LUFS, shaped
by a `volume` expression built from its envelope, delayed to `atMs`; `amix`
with `normalize=0`; `alimiter=limit=0.89`; `loudnorm` to the target; padded or
trimmed to `durationMs`. With no beds it behaves exactly as milestone 1's
`master`.

**Verify**: `bun test test/story/audio-runtime.test.ts`: a 4 s voice tone and a
6 s music tone bed at 0 ms with a lead envelope give a master of the plan's
duration ±20 ms at the target loudness ±1.5 LU; the first second is louder than
second 3 by at least 6 dB (the bed ducks).

### 8. Build

`buildStory` gains `composer?` and `music: boolean` (default true when a
composer is given): renders music after lines, schedules with leads, builds the
plan, mixes. Output adds `audio/music/<scene>.mp3`. `build.json` adds
`music: [{ scene, key, cached, ok, error? }]` and `summary.musicClips`.

**Verify**: `bun test test/story/build.test.ts`: with a fake composer, the
build writes music files, `timeline.json` scenes carry leads, and the summary
counts clips; with `music: false` the output equals milestone 1's shape.

### 9. CLI

`story build` adds `--no-music` and `--music-model`. Without `--no-music`, a
story with music cues uses Lyria with the same API key.

**Verify**: `bun test test/story/cli.test.ts`: `--no-music` makes no composer
calls.

### 10. Live runs (need the Gemini key; not in CI)

```bash
NODE_USE_ENV_PROXY=1 node dist/bin.js story build test/story/fixtures/lunch-voices.md --out $TMPDIR/m2-lunch --cache $TMPDIR/m2-cache --no-music
NODE_USE_ENV_PROXY=1 node dist/bin.js story build test/story/fixtures/embarrassing-day.md --out $TMPDIR/m2-day --cache $TMPDIR/m2-cache
```

1. The lunch rebuild should flag fewer lines than milestone 1's 3, and make
   fewer retakes than its 8. Record both.
2. The full story (289 lines, 8 music cues, about 20 minutes) is the
   prototype's run 3 built by mdmedia. Record lines, retakes, fallbacks,
   failures, music clips and wall time, and publish the MP3 for listening.
   Its narration has no cues yet (milestone 3's director writes them), so
   expect `missing-cue` warnings and flatter narration than the comic voices.

### 11. Full checks

```bash
bunx tsc --noEmit
bun test test/story
bun run build
npm_config_cache=$TMPDIR/npm-cache bun run verify
grep -rn "from 'node:" src/story --include=*.ts | grep -v "src/story/node/" && echo "STOP" || echo "core is platform-free"
```

## Done when

- Every step's tests pass with fakes.
- The lunch rebuild flags fewer lines than milestone 1 did.
- The full story builds with music, and the MP3 is published for listening.
- Committed locally on `feat/story-m2`, not pushed.

## STOP conditions

- A Lyria clip comes back with vocals (heard or transcribed).
- The interjection rule would pass a line the prototype recorded as a real
  defect.
- The ffmpeg graph cannot express the envelopes with `volume` expressions.
- A dependency seems necessary.
