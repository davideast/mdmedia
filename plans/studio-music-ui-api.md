# Studio music: prompt, saved track, player

Implemented on the existing Studio media branch. Research: [Lyria capabilities and engine audit](lyria-music-research.md). The first release uses finite Lyria generation; RealTime performance is a different future workflow.

## Main job and navigation

Create → Music opens `/studio/music`: the same header, pin, prompt composer, import/reference icons, full-width mobile Generate action, and right-panel icon as Narration, Image, and Video. The prompt is the complete starting interface. No obligatory genre grid, mixer, timeline, or instrument taxonomy.

Music joins Drafts, Library, Activity, Find, Pinned, and Recent. One song is one saved Library item at `/music/{id}`. Generate again saves another take under that item, preserving the last successful playable result when an attempt fails. History, Duplicate, and Rename live under the header overflow. No tabs and no separate music navigation hierarchy.

## Progressive options

| Surface | Control | Actual effect |
| --- | --- | --- |
| Main composer | Prompt | Genre, mood, instruments, tempo, key, arrangement, vocal delivery, and requested song length can be described directly. |
| Composer icons | Markdown import, one image reference | Import source or inspire the music with an owned image. The engine supports ten images; Studio deliberately starts with one. |
| Options drawer | Full song / 30-second clip | Select `lyria-3.5` or `lyria-3-clip-preview`. Full-song duration is generated, not an exact promised number. |
| Options drawer | Automatic / With vocals / Instrumental | Studio appends explicit prompt direction; these are not native finite-model parameters. |
| Drawer disclosure | Your lyrics | Optional text/section tags, preserved verbatim and appended after notes adaptation. Instrumental rejects conflicting lyrics. |
| Options drawer | Adapt notes for music | Optional Gemini prompt preparation, with custom instructions shown only when enabled. Default is direct prompting. |
| Drawer disclosure | Download format | MP3 or WAV; full-song WAV uses the documented provider request. Clip WAV is converted locally from the provider's native MP3. |
| Options drawer | Save as defaults | Saves options without retaining the prompt, lyrics, or reference attachment. |

No fake BPM, density, brightness, scale, guidance, or seed sliders. The finite song API documents musical directions in prompts. Native live controls belong to the separate Lyria RealTime WebSocket API. There is no documented finite-song continuation/edit contract; another take is a new generation, not an extension.

## Player and visual life

A successful result replaces the empty state with a single player above the same composer. Play/Pause is the primary control; seek by clicking/touching the waveform or using its keyboard-accessible slider. Elapsed/total time, loop, mute, visualization toggle, and download use concise icon controls. Lyrics or provider song text stay collapsed below the composer.

The seek waveform is derived from decoded audio and stored with the result. A Web Audio analyser drives an oscilloscope and a soft frequency bed. The visualization reacts to actual samples, not a prerecorded animation or fake beat timer. It does not run while paused, hidden, disabled, or under `prefers-reduced-motion`. Playback remains user-initiated; the AudioContext is created/resumed from the Play gesture. Each result owns one audio graph, cleaned up on unmount. Music pauses narration when started and pauses when narration starts. This first player is scoped to the music page: navigating away stops it; a global mixed-media queue remains future work.

Private audio is fetched with authorization into a revocable blob URL. No public storage URLs or provider receipts enter the player. The server measures decoded duration and generates 256 waveform peaks plus a Library thumbnail, preserving truthful metadata even when provider sample rates differ from documentation.

## API contract

All routes use existing bearer authentication, owner checks, private visibility, stable cursor pagination, and the same `202` asynchronous generation pattern. New connections can approve `music:create` and `music:read`; existing keys gain no scopes automatically.

| Method | Route | Behavior |
| --- | --- | --- |
| POST / GET | `/api/v1/music` | Create from a prompt; list owned tracks. |
| GET / PATCH | `/api/v1/music/{id}` | Read item plus latest attempt/result; rename. |
| POST / GET | `/api/v1/music/{id}/generations` | Generate another take; list attempts. |
| GET | `/api/v1/generations/{id}` | Discriminated music attempt with assets, lyrics/text, waveform, measured duration. |
| POST | `/api/v1/assets?media=music` | Upload one scoped still image reference. |
| GET | `/api/v1/assets/{id}/content` | Authorized audio, reference, or waveform thumbnail; supports download. |
| GET | `/api/v1/options?media=music` | Availability, defaults, supported modes/formats, prompt controls, limits. |
| GET | `/api/v1/media`, `/api/v1/generations` | Shared Library/Activity, with `type=music`. |

Only `prompt` is required:

```json
{
  "prompt": "Warm piano and brushed drums, a gentle melody at 85 BPM",
  "output": { "mode": "song", "format": "mp3" },
  "vocals": "instrumental",
  "lyrics": "",
  "adaptation": { "enabled": false, "instructions": "" },
  "referenceAssetId": null
}
```

POST requires `Idempotency-Key` (10–128 letters, numbers, underscores, or hyphens). Responses contain `{id,type:"music",generation,links,replayed}`. Poll `generation.links.self` or the item until ready/error/interrupted. `latestGeneration` describes the attempt, while `result` always identifies the latest successful take. Public attempt data contains the original request, prepared prompt, actual duration, `waveform`, optional song text, and authorized asset links. Model, receipt, and storage details cannot be supplied by the client; receipt and storage paths remain private.

Limits: 32,000 source characters, 4,000 adaptation-instruction characters, 8,000 lyric characters, one image up to 10 MiB, 100 MiB audio output, three outstanding attempts per owner, and 30 starts/hour per API key. Options report clipSeconds=30, songSeconds=null, and continuation=false. Formats are Studio output capabilities; clip WAV is transcoded locally.

## Execution and recovery

Acceptance, idempotency replay, owner/reference validation, pending-item checks, quota reservation, and activity creation happen transactionally before paid work. Requests are canonically hashed. Replay precedes current pending-state checks and always returns the original attempt. Music has its own durable worker and quotas; image/video workers never process music jobs.

The engine saves the real provider receipt before decoding/downloading audio. It disables both SDK and wrapper retries for paid creates, fails on missing references/receipts, preserves WAV MIME, bounds audio, honors cancellation/deadlines, and allows only Google Files resource downloads through the SDK. Its public `retrieve` method performs safe recovery reads and never creates a new song.

The worker renews its lease while generating. A restart recovers deterministic saved output or retrieves the existing receipt; unknown outcomes become interrupted and require explicit user retry. No automatic second paid request. Saving decodes the audio with ffmpeg, measures actual duration, computes peaks, normalizes the requested file format, stores original/thumbnail, then publishes the result. A failed take leaves the previous player available.

## Configuration and rollout

`GEMINI_API_KEY` enables music. `MDMEDIA_MUSIC_MODEL` defaults to `lyria-3.5`; clip mode uses `lyria-3-clip-preview`. `MDMEDIA_MUSIC_ADAPTATION_MODEL` defaults to `gemini-3.5-flash-lite`. ffmpeg is required and checked before accepting work. No browser provider credentials, new service, or WebSocket deployment is needed.

Validate transport and lifecycle with fake provider responses plus real ffmpeg; verify one actual generated song through the staged API/player, keyboard/mobile controls, waveform seeking, pause/hidden/reduced-motion behavior, private downloads, regeneration history, and cross-medium regression checks. Release through the existing staged build and backup workflow after confirming no media jobs are running. Avoid restarting the host during a paid request.

## Verification evidence

The full repository suite passed with 557 tests and 12 opt-in live music tests skipped. Root/Studio types and targeted lint passed. The lifecycle fixture uses real ffmpeg with a fake provider to cover competing duplicate submissions, pending-item rejection, quotas, provider failures preserving the previous take, ownership/scopes, references and unchanged custom lyrics after adaptation, MP3/WAV decode and format normalization, measured duration/peaks, history, and receipt/durable-output recovery without another paid create. The CQRS scan reports only the pre-existing client transaction in `src/lib/playlists.ts:166`.

One real `lyria-3.5` song was submitted through the staged composer and saved: 111.047 measured seconds. Browser verification covered authorized downloads, Library/History, keyboard seeking, loop/mute, animated canvas changes during actual playback, static canvas while paused/reduced-motion, and 320/390/1280px layouts. Verification reruns reused that saved song, without another paid generation.
