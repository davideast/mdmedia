# Lyria music research for Studio

Investigated 2026-10-09. Primary Google documentation accessed on that date. This is a capability and engine audit, with implementation implications; it does not claim that a paid request was made or that every documented option was exercised against the live API.

## Use the finite song API for the first Studio music flow

| API | Models | Fit for this Studio feature |
| --- | --- | --- |
| Gemini Interactions | `lyria-3.5`, `lyria-3-clip-preview` | A saved song or a short music result, matching prompt → result → player. |
| Gemini Live music WebSocket | `models/lyria-realtime-exp` | A different future product: an ongoing instrumental performance with live steering. |
| Vertex AI Lyria family | Separate Cloud API/deployment configuration | An alternative platform, unnecessary to enable the engine's existing Gemini path. |

The stable `lyria-3.5` model accepts text and images and returns audio and lyrics. Its model page documents 44.1 kHz stereo audio and says Live API, structured outputs, Batch, Flex, and Priority inference are unsupported. [Lyria 3.5 model](https://ai.google.dev/gemini-api/docs/models/lyria-3.5)

The Clip model is a 30-second preview generator. Its model card says 48 kHz stereo, whereas the general music guide says 44.1 kHz for both models. Persist measured file metadata instead of promising a fixed rate in the UI. [Clip model](https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview), [music guide](https://ai.google.dev/gemini-api/docs/music-generation)

Vertex's earlier Lyria 3 and Pro launch describes 30-second and up-to-three-minute models, vocals, and timed lyrics. Those limits do not establish an exact duration limit or continuation contract for Gemini's newer `lyria-3.5`. [Vertex launch](https://cloud.google.com/blog/products/ai-machine-learning/lyria-3-and-lyria-3-pro-on-vertex-ai/)

## Finite generation: actual contract

Send `interactions.create({ model: 'lyria-3.5', input: prompt })`. Images use typed `input` blocks with `type`, `mime_type`, and base64 `data`; at most ten images are documented. MP3 is default. For 3.5, `response_format: { type: 'audio' }` requests WAV. Clip always returns 30 seconds; full-song length is influenced through prompt/timestamps, rather than a documented audio duration parameter. Responses expose `output_audio`, `output_text`, and raw `steps` with `model_output` text/audio blocks. Text may contain lyrics or JSON song structure. Multi-turn editing is unsupported; identical prompts may differ. Audio carries SynthID. [Music guide](https://ai.google.dev/gemini-api/docs/music-generation)

The shared Interactions schema allows audio `data` or `uri`, plus optional MIME, sample rate, and channel metadata. `AudioResponseFormat` defines `bit_rate`, `delivery` (`inline`/`uri`), `mime_type`, and `sample_rate`; it has no `duration`. The schema spans multiple models: its wider format list is not evidence that every format/control works with Lyria. [Interactions API reference](https://ai.google.dev/api/interactions-api)

Use the music guide's MP3/default and 3.5 WAV contract initially. Do not expose arbitrary shared-schema codecs or quality sliders without model-specific validation. Treat a returned URI as provider transport: download through a validated server path, never turn it into an unrestricted fetch endpoint or public asset URL.

## Musical customization is mostly prompt direction

| User intent | Documented finite-song mechanism | UI consequence |
| --- | --- | --- |
| Vocals or instrumental | Vocal tracks/lyrics are the default; request instrumental in the prompt. | A simple instrumental toggle can compose prompt direction. |
| Own lyrics | Lyrics beneath a separate header, with section tags. | Optional lyrics field in the drawer; preserve user text. |
| Genre, mood, instruments | Natural-language musical direction. | The main prompt already covers these; avoid mandatory separate forms. |
| Tempo and key | Musical descriptions such as BPM/key in prompt. | Optional drawer fields; label as direction, not measured guarantees. |
| Arrangement and timing | Section tags, progression, and timing markers in prompt. | Advanced instructions; no compulsory timeline editor. |
| Vocal delivery | Describe singer range/timbre and delivery. | Optional freeform direction; no invented voice-ID picker. |

These are explicitly prompting strategies. They are not separate finite-generation fields in the documented Lyria payload. [Lyria prompt guide](https://ai.google.dev/gemini-api/docs/lyria-prompt-guide)

Separate application controls from native provider fields in the API. For example, `instrumental: true` can be Studio intent resolved into the prepared prompt, while `model` and `outputFormat` select the provider request. Save both the original source and final prepared prompt so users can inspect what was submitted. A duration selector should represent requested length, while the player uses measured duration.

Do not add video-style Continue or Extend to the finite music UI. Generating again makes a new version of the same music item, preserving the previous playable song. A clip preview is another independent generation; it is not a checkpoint from which a full song can resume.

## RealTime configuration inventory, for future reference

This experimental API uses bidirectional WebSockets, weighted prompts, and play/pause/stop/reset. It is instrumental-oriented; `VOCALIZATION` adds vocal sounds, not a finite lyrical-song contract. The specification says stereo PCM16/48 kHz; its JavaScript example explicitly requests 44.1 kHz. Use negotiated metadata. [RealTime guide](https://ai.google.dev/gemini-api/docs/realtime-music-generation)

| Configuration | Range/default |
| --- | --- |
| Prompt weight | Nonzero; start at 1.0 |
| `guidance` | 0–6; default 4 |
| `bpm` | Integer 60–200; otherwise model decides |
| `density`, `brightness` | 0–1; otherwise model decides |
| `scale` | Unspecified or twelve relative major/minor pairs |
| `mute_bass`, `mute_drums`, `only_bass_and_drums` | False |
| `music_generation_mode` | QUALITY default; DIVERSITY; VOCALIZATION |
| `temperature` | 0–3; default 1.1 |
| `top_k` | 1–1000; default 40 |
| `seed` | 0–2,147,483,647; random by default |

Scale pairs: C/A, D♭/B♭, D/B, E♭/C, E/D♭, F/D, G♭/E♭, G/E, A♭/F, A/G♭, B♭/G, B/A♭, plus unspecified. Each pair is major/minor. Config updates replace the whole config; BPM/scale changes require context reset and cause hard transitions. [RealTime guide](https://ai.google.dev/gemini-api/docs/realtime-music-generation)

None of these native RealTime steering controls currently exists in `IMusicProvider`; they should not appear as supported finite-song engine knobs.

## Existing TypeScript engine audit

Source state inspected before the Studio music work in this task:

| Source | Supported behavior | Gaps/material cautions |
| --- | --- | --- |
| [Provider interface](../src/music/music-provider.interface.ts) | `model`, `outputFormat: mp3\|wav`, local `referenceImages`; result bytes, MIME, lyrics, interaction ID; optional duration type. | No duration, lyrics-mode, tempo, scale, or live session fields. Duration is declared but not populated by the provider. |
| [Lyria provider](../src/music/lyria-music-provider.ts) | Interactions request; default `lyria-3.5`; reference file bytes; WAV response format; top-level and steps fallback parsing. | Unknown/missing reference files silently skipped; no ten-reference validation; steps audio MIME hardcoded MPEG; only last audio block retained; synthetic receipt when missing; no retrieval checkpoint; create retries can duplicate charged requests. |
| [Registry](../src/music/provider-registry.ts) | Lyria registered as default finite music provider; model/retry constructor options. | No Live music implementation. |
| [Pipeline](../src/pipeline/document-music-pipeline.ts) | Prompt and provider options pass through; start/complete/error events. | No markdown-to-music adaptation or musical direction composition; no persistence or durable job recovery. |
| [CLI](../src/cli/command.ts), [runner](../src/cli/runner.ts) | Prompt or Markdown-file input; output path; model, `--clip`, format, references; writes audio bytes and prints lyrics. | File suffix is not proof of actual encoding. Input Markdown is submitted directly, rather than adapted into lyrics. |
| [Configuration](../src/config/config-resolver.ts) | Default full model and MP3; CLI overrides file configuration. | No musical-control config layer. |
| [Unit tests](../test/music/lyria-music-provider.test.ts) | Payload, convenience and steps responses, WAV request, empty output, clip selection. | Fake responses; do not prove current provider access or output encoding. Paid end-to-end tests are explicitly gated. |

## Implications for the Studio API and player

Keep one Music item in the shared Library, immutable generation attempts beneath it, and audio/lyrics assets underneath each successful attempt. Reuse Activity, Find, pins, drafts, and the existing right options drawer. A provider name does not need its own navigation section.

The service should validate known models, owned reference assets, reference count/size, and supported model/format combinations before accepting a job. Its options response should distinguish native request choices from prompt direction. New independent generations need idempotency, one active job per item, deterministic output storage, and preserved latest success. Disable automatic paid-create retries; an uncertain interrupted request should not silently generate again. Only checkpoint an actual provider receipt, and only advertise recoverability that has been implemented and verified.

Store returned text without assuming every text block is display-ready lyrics. Keep raw structure inspectable; parse timed lyrics only after validating a real documented/example schema. Measured duration, MIME, channels, sample rate, waveform peaks, and file size should come from the saved audio, not user direction or inferred defaults.

The player can be built independently of the provider: actual audio playback through a single audio element, a scrubber from saved waveform peaks, and an `AnalyserNode` driving frequency/oscillation visuals only while audible. The animation must follow audio data, pause when playback pauses, stop when hidden, and respect reduced motion. Playback and seeking must continue when Web Audio or canvas is unavailable. This is a product recommendation, not a Lyria generation capability.
