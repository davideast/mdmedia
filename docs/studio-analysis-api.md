# Studio video analysis API

Studio asks Gemini about a video and saves the answer as Markdown (or JSON, with
`responseSchema`). A saved Analysis is one Library item; each generation is an
immutable attempt whose output is one `text/markdown` or `application/json` asset. The source can be a video already in your
Studio (the whole sequence, a version, or one clip), a video you upload, or a
public YouTube link. Analyses have no dedicated Studio screen yet; saved items appear in the Library.

The engine is `mdmedia/analysis` (`GeminiVideoAnalysisProvider`), the same one
`mdmedia analyze` uses. Small requests send the video inline; larger ones go
through the Gemini Files API first. Studio keeps the video bytes and never stores
a Gemini file URI, which is temporary.

## API

Use the existing bearer authentication and allowlist. New connections receive
`analyses:create` and `analyses:read`; existing keys are not expanded. Run
`mdmedia studio login` again to approve analyses. Browser sessions have full
access to their own work.

- `analyses:create`: create analyses and attempts, rename, upload source videos.
- `analyses:read`: read analyses, attempts, answers, and uploaded source videos.
- A `video` source also needs `videos:read`. `narrate` also needs
  `narrations:create`, and `narrate.playlist` needs `playlists:manage`. All
  scopes are checked before the request is accepted.
- `/api/v1/media` and `/api/v1/generations` include analyses only for callers
  with `analyses:read`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST / GET | `/api/v1/analyses` | Create or list saved analyses. |
| GET / PATCH | `/api/v1/analyses/{id}` | Read the item or rename with `{ "title": "…" }`. |
| POST / GET | `/api/v1/analyses/{id}/generations` | Run again, ask a follow-up, or page through attempts, newest first. |
| GET | `/api/v1/generations/{id}` | Read an attempt. |
| POST | `/api/v1/assets?media=analysis` | Upload a source video as raw bytes. |
| GET | `/api/v1/assets/{id}/content` | The answer (`text/markdown; charset=utf-8`, or `application/json; charset=utf-8`). Add `download=1` for a `.md` or `.json` file. |
| GET | `/api/v1/options?media=analysis` | Availability, model, capabilities, and limits. |

Both POST endpoints require an `Idempotency-Key` of 10–128 letters, numbers,
underscores, or hyphens, and answer `202` with
`{ id, type: "analysis", generation, links, replayed }`. Reusing a key with the
same body replays the first attempt; with a different body it returns `409`.

```json
{
  "prompt": "List every shot with MM:SS timestamps.",
  "source": { "kind": "video", "videoItemId": "abc123", "clip": 2 },
  "processing": { "mode": "static", "fps": 2 },
  "mediaResolution": "high",
  "narrate": { "voice": "Puck" }
}
```

| Field | Notes |
| --- | --- |
| `prompt` | Required. 1–32,000 characters. |
| `source` | Required on create. Exactly one of `{ kind: "video", videoItemId, generationId?, clip? }`, `{ kind: "asset", assetId }`, or `{ kind: "youtube", url }`. |
| `model` | Optional Gemini model id. Default: `MDMEDIA_ANALYSIS_MODEL`, else `gemini-3.8-flash`. |
| `processing` | `{ mode: "static" \| "agentic", startSeconds?, endSeconds?, fps? }`. The range and `fps` are static only; `agentic` needs a model that supports it. Omitted: the model's default (static, 1 FPS). |
| `mediaResolution` | `low`, `medium`, `high`, or `ultra_high`. |
| `systemInstruction` | Up to 8,000 characters. |
| `responseSchema` | A JSON Schema object, up to 32,000 characters of JSON (no arrays directly inside arrays). The answer is JSON matching it, saved as `application/json`. Not with `narrate`. |
| `narrate` | `true` or narration options; see below. |
| `previousInteractionId` | Follow-ups only, on `/generations`. |

Unknown fields are rejected. The engine's own checks run before acceptance, so
agentic processing on a static-only model, a clip range with `agentic`, or a link
that isn't YouTube fails with `400`, not after the request was paid for.

Sources:

- `video`: an owned Studio video. Without `generationId`, its latest successful
  result is used; the accepted attempt records the version it resolved to. With
  `clip`, Studio sends only that clip (a saved clip, or a local extract).
- `asset`: an owned upload from `POST /api/v1/assets?media=analysis`. Send the
  bytes with a video `Content-Type` (mp4, mpeg, mov, avi, x-flv, mpg, webm, wmv,
  3gpp), up to 200 MiB. Other types return `415`, larger files `413`.
- `youtube`: a public YouTube link, passed straight through (Gemini preview).

The item has separate `latestGeneration` and `result` pointers; a failed attempt
never replaces the last good answer. The item's `sourcePreview` is a short
plain-text excerpt of the answer (for JSON, its text values). Each attempt includes `interactionId`,
`progress` (while running, the latest step Gemini reported as one short line; otherwise `null`),
`usage` (token counts), `trace` (thought summaries, when the model shares them),
`narrationId`, `narrationError`, and `assets[0]`, the Markdown answer.

### Run again and follow up

`POST /api/v1/analyses/{id}/generations` takes the same body. Omitted fields
keep the item's last request, including its source and `responseSchema`, so
`{ "prompt": "Only the second half" }` is a complete re-run. Send
`"responseSchema": null` to go back to Markdown.

A follow-up names an `interactionId` from the same analysis and sends no video;
Gemini keeps the earlier video context:

```json
{ "prompt": "Expand on the second shot.", "previousInteractionId": "v1_ChdQ…" }
```

`source`, `processing`, and `mediaResolution` can't be combined with a
follow-up. An interaction id from another item returns `404`. How long Gemini
keeps that context isn't documented; when it expires, run again instead.

### Narrate the answer

`narrate` is one field: `true` narrates with your Studio narration defaults; an
object is any [`POST /api/v1/narrations`](studio-narration-api.md) field except
`markdown` and `id`. It goes through the narration validator, so defaults,
presets, unknown-field checks, and the API-key private-only rule are the same.
The resolved options are saved on the attempt.

```json
{ "prompt": "Write a two-minute narration script of this video.", "source": { "kind": "youtube", "url": "https://youtu.be/…" },
  "narrate": { "voice": "Puck", "deliveryPreset": "Documentary", "playlist": "Lectures" } }
```

When the answer is saved, Studio starts one narration from it with the id
`narr_<generationId>`, reported as `narrationId` from the start. Retries and lease
recovery reuse that id and never start a second narration. The narration records
`source: { kind: "analysis", analysisId, generationId }`. A narration that can't
start (an answer over 200,000 characters, an unavailable voice, a playlist error)
sets `narrationError`; the analysis is still `ready`. There is no separate
narration endpoint and no setting to narrate every analysis.

### Lifecycle

Phases: `queued`, `starting`, `preparing` (reading the source), `uploading` and
`processing` (Files API only), `analyzing`, `saving`, `narrating` (with
`narrate`), then `ready`, `error`, or `interrupted`. Requests always run in the
background on Gemini. The interaction id is saved before polling, so a restarted
worker reads that receipt (or the saved answer) and never sends a second paid
request. An attempt that stopped with neither is `interrupted`; running it again
starts a new request. While Gemini works, the worker streams the interaction for
thought summaries and keeps only the newest title in `progress` (at most one write
every few seconds). Progress is best effort; the answer never depends on it.

Server configuration:

- `GEMINI_API_KEY`: required.
- `MDMEDIA_ANALYSIS_MODEL`: defaults to `gemini-3.8-flash`.

## CLI

```sh
# Upload a local video, then analyze it; print the Markdown when done
mdmedia studio analyze --video clip.mp4 -p "Shot list with MM:SS" --wait
# An existing Studio video: the whole sequence, a version, or one clip
mdmedia studio analyze --from-video <videoItemId> [--generation <id>] [--clip 2] -p "…" -o notes.md
# YouTube, agentic processing, narrated with a chosen voice
mdmedia studio analyze --video https://youtu.be/… --processing agentic --narrate-voice Puck --json
# Run again or ask a follow-up on an existing analysis
mdmedia studio analyze --item <analysisId> -p "Only the second half"
mdmedia studio analyze --item <analysisId> --follow-up <interactionId> -p "Expand on shot 3" --wait
```

Flags match `mdmedia analyze`: `--model`, `--processing`, `--start`, `--end`,
`--fps`, `--media-resolution`, `--system`, `--schema <file.json>`, `--follow-up`. Narration takes
`--narrate`, `--narrate-voice`, and `--narrate-playlist` (either override turns
narration on). For other narration options, pipe the answer:
`mdmedia studio analyze … --wait | mdmedia studio narrate -i -`.

With `--wait` and no `-o` or `--json`, the answer goes to stdout and status
lines, including each new step Gemini reports, go to stderr. `-o` saves the answer. Every flag is checked before
anything is uploaded or created. Check on an analysis later with
`mdmedia studio status <id> --type analysis`.

## Validation

`test/studio/analysis-server.test.ts` runs the routes and worker against a
transactional test store, real clip extraction, and a fake Gemini client. It
covers concurrent idempotency, inline and Files API uploads, upload limits,
ownership and scopes (including `videos:read` for Studio videos), the receipt
saved before polling, recovery from a receipt or a saved answer without another
create, failed attempts keeping the last result, follow-ups limited to the
item's own receipts, and the follow-on narration: scope and option checks before
acceptance, the deterministic id across recovery, and an analysis that stays
`ready` when narration fails. `test/studio/analysis-request.test.ts` covers the
request contract and `test/cli/studio-analyze-command.test.ts` the CLI.
