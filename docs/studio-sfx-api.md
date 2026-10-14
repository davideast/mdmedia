# Studio sound effects API

Studio generates short sound effects with ElevenLabs. A saved sound effect is
one Library item; each generation is an immutable attempt with one MP3 or WAV
asset and a waveform thumbnail. There is no composer yet: items appear in
Library and Activity under All media and link to `/library`.

Defaults: MP3, the model chooses the length, no loop, prompt influence 0.3.
Options are a length of 0.5–30 seconds, a seamless loop, prompt influence from
0 to 1, and MP3 or WAV output. There is no notes adaptation and no reference
upload.

## API

Use the existing bearer authentication and allowlist. New connections receive
`sfx:create` and `sfx:read`; existing keys are not expanded. Run
`mdmedia studio login` again to approve sound effects. Browser sessions have
full access to their own work.

| Method | Path | Purpose |
| --- | --- | --- |
| POST / GET | `/api/v1/sfx` | Create or list saved sound effects. |
| GET / PATCH | `/api/v1/sfx/{id}` | Read the item or rename with `{ "title": "…" }`. |
| POST / GET | `/api/v1/sfx/{id}/generations` | Generate again or page through attempts, newest first. |
| GET | `/api/v1/generations/{id}` | Read an attempt. |
| GET | `/api/v1/assets/{id}/content` | The audio. Add `thumbnail=1` for the waveform WebP. |
| GET | `/api/v1/options?media=sfx` | Availability, model, defaults, capabilities, and limits. |

Create and generate-again require an `Idempotency-Key` header with the same
rules as images, and answer `202` with `{ id, type: "sfx", generation, links,
replayed }`.

```json
{
  "prompt": "Heavy wooden door creaking open in a stone hallway",
  "output": { "format": "wav", "durationSeconds": 4, "loop": false },
  "promptInfluence": 0.5
}
```

Only `prompt` (1–4,000 characters) is required on create. Omitted fields take
the defaults; `durationSeconds: null` lets the model choose. On generate-again,
omitted fields, including `prompt`, keep the item's current request. Unknown
fields return `unknown_fields`; invalid values return `invalid_prompt`,
`invalid_format`, `invalid_duration`, `invalid_loop`, or `invalid_influence`.

A user may have three attempts in progress (`429 too_many_in_progress`) and an
API key may start 30 per hour (`429 rate_limited`). Without an ElevenLabs key or
ffmpeg, create returns `503 provider_unavailable` and options report
`available: false`. `MDMEDIA_SFX_MODEL` overrides the default
`eleven_text_to_sound_v2`.

A 4xx from ElevenLabs ends the attempt as `error` with `provider_rejected`.
Studio stores the audio as soon as ElevenLabs returns it, so a failed decode or
a restart after that point finishes from the stored copy; audio that still
cannot be decoded ends as `error` with `invalid_sfx`. A server error, or a
restart before the audio arrives, ends the attempt as `interrupted`; Studio
never calls the paid API again on its own. Previous results are preserved
either way.

## Verification

```sh
bun test test/studio/sfx-request.test.ts test/studio/sfx-server.test.ts
./node_modules/.bin/tsc --noEmit -p studio/tsconfig.json
```

The server fixture runs with an in-memory transactional database and a stubbed
ElevenLabs `fetch`. It checks idempotency, scopes, ownership, quotas, retained
results after failure, and recovery without resubmission.
