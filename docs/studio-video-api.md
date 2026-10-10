# Studio video sequences

Studio creates one clip at a time with Gemini Omni. A saved Video is one Library
item and one locally assembled playable movie. Each generation saves a short clip.
Continue extends only the latest clip; Studio appends its new tail locally; Regenerate latest
replaces the last addition using its original parent. Previous full versions
remain available in History. There is no timeline, compulsory project hierarchy,
or separate navigation for sequences.

Create → Video uses the same composer, icon actions, header, pinning, and right
options drawer as Narration and Image. The first screen has a prompt and Generate
video. A result adds one player, download/fullscreen controls, and What happens
next? with Continue video. Clips and History open from the overflow menu;
historical versions are read-only. Options remain closed by default.

Defaults: direct prompt, 16:9, 720p, 10 seconds, generated audio, no image. Options
include 3–10 whole seconds, landscape/portrait, 360p/720p/1080p/4k, optional notes
adaptation and instructions, and one reference image. Initial generation can use
that image as its first frame; continuation accepts a reference only. Shape and
resolution lock after the first successful clip. Options can be saved as account
defaults. Markdown import and attachment use the shared icon controls.

## API

Use the existing bearer authentication and allowlist. New connections receive
`videos:create` and `videos:read`; existing keys are not expanded. Reconnect to
approve video access. Browser sessions have full access to their own work.
Video files, posters, reference uploads, and extracted clips require ownership
and the corresponding video scope.

| Method | Path | Purpose |
| --- | --- | --- |
| POST / GET | `/api/v1/videos` | Create or list saved videos. |
| GET / PATCH | `/api/v1/videos/{id}` | Read the item or rename with `{ "title": "…" }`. |
| POST / GET | `/api/v1/videos/{id}/generations` | Continue/regenerate or page through attempts. |
| GET | `/api/v1/generations/{id}` | Read an image or video attempt through a discriminated resource. |
| GET | `/api/v1/videos/{id}/clips/{index}/content?generationId={id}` | Download a clip from a selected complete version. Add `thumbnail=1` for its poster. |
| POST | `/api/v1/assets?media=video` | Upload a video-scoped still PNG/JPEG/WebP reference as raw bytes. |
| GET | `/api/v1/assets/{id}/content` | Read an owned video/reference. Add `thumbnail=1` or `download=1`. |
| GET | `/api/v1/options?media=video` | Availability, defaults, capabilities, and limits. |

Video items and attempts also appear in `/api/v1/media` and
`/api/v1/generations`, filtered by the caller's scopes. Video drafts participate
in Drafts, Pinned, Recent, and Find. Music stays unavailable. Narration and image
request/response shapes remain compatible.

Create requires only a prompt; omitted options resolve from account defaults:

```json
{
  "prompt": "A red toy train crosses a tabletop, with gentle wheel clicks",
  "output": { "durationSeconds": 5 },
  "adaptation": { "enabled": false, "instructions": "" },
  "referenceAssetId": null,
  "referenceRole": "reference"
}
```

Both POST endpoints require an `Idempotency-Key` of 10–128 letters, numbers,
underscores, or hyphens. They return `202` with
`{ id, type: "video", generation, links, replayed }`. Poll the generation or item.
The stable item has separate `latestGeneration` and `result` pointers; a failed
attempt never hides or replaces the last successful video. `canContinue` reflects
the measured remaining duration and any known expired continuation context.

Continue explicitly names the current successful result:

```json
{
  "action": "continue",
  "fromGenerationId": "current-successful-generation",
  "prompt": "The train passes a blue station"
}
```

Regenerate latest uses the same shape with `action: "regenerate_latest"`.
Studio resolves its parent from the current last clip's original parent, not the
current tip's receipt. A failed first attempt can also be regenerated, naming
its latest attempt ID. An arbitrary historical source, concurrent distinct
submission, or changed shape/resolution returns `409`.

For existing videos, omitted options resolve from the source generation;
references default to none. Prompt is always explicit. The server resolves the
provider context and clamps duration to remaining capacity. Clients never send
provider interaction IDs, model overrides, storage paths, or uploaded videos.

History has 50 attempts per page and uses the same stable cursor format as the
shared catalog. Each video attempt includes its action, immutable source/options,
prepared prompt, parent/replaced generation IDs, clip number, measured complete
duration, `clipDurationSeconds`, and public asset resources. Provider receipts and storage paths stay
private. Item `clips` contains numbered ranges into the current complete movie;
old versions can be downloaded independently from History.

## Engine and persistence

`mdmedia/video` exposes `GeminiOmniVideoProvider.continueVideoClip(prompt,
{ videoBytes, durationSeconds }, options)` and `retrieveVideoClip(id, options)`.
Continuation requires only the latest generated 3–10-second clip. The provider
sends that clip as explicit model conversation history, followed by the new
prompt, without chaining older interactions. This avoids Omni selecting the
original clip again when several generated videos exist in the history.
Generate/edit still support `previousInteractionId` independently.

Omni returns the source clip plus its continuation. Studio trims the source
portion locally, saves the new short clip independently, and appends it to the
previous sequence with ffmpeg. Neither the assembled movie nor the earlier clips
are sent for generation. No model call generates the whole sequence. The real
receipt is saved with `store: true` for safe retrieval after a crash.

The provider checkpoints a real receipt before downloading, normalizes inline,
Files URI, and REST-step video outputs, applies abort/deadline and output limits,
and measures MP4 movie headers. There are no fabricated interaction IDs.
Automatic retries apply only to safe reads/downloads. A potentially accepted paid
create is never retried by either wrapper or SDK, including when it times out.
This intentionally changes the old video provider's blanket retry behavior.

Studio has a single video execution slot per host and separate video admission
quotas: three outstanding attempts per owner, 30 starts per hour per API key.
Acceptance, ownership, active-job checks, exact source, quota and idempotency are
transactional. Replay is checked before stale-source validation and returns the
original attempt even after the video advances. Image workers explicitly filter
image jobs in the shared generation collection.

Queued jobs resume after restart. Expired leases recover deterministic stored
output or retrieve the existing receipt; they never create a second interaction.
A crash before any receipt is saved becomes interrupted with an unknown provider
outcome. Once the new clip is stored, recovery only assembles local files; it
needs neither another paid generation nor a provider read. Expired conversation
receipts do not disable continuation from locally stored clips.

Generations store both the independent clip and the assembled version.
`durationSeconds` remains the complete playable sequence duration;
`clipDurationSeconds` is just that generation's new clip. History and regeneration
preserve the original parent and previous versions. Older cumulative generations
remain readable; their final clip is extracted locally when first continued.
Clip downloads use independent clip assets when present, with local extraction
as the fallback for older versions. Both preserve audio.

Requested total capacity remains 40 seconds, with a 40.25-second container timing
tolerance. Fewer than three whole seconds remaining disables Continue. Source
clips are limited to 10.25 measured seconds; provider responses must match source
clip plus requested addition within 0.5 seconds. Two concurrent legacy extraction
cache misses are allowed, and identical requests share work.

Limits: 32,000 prompt characters, 4,000 instruction characters, 10 MiB per
reference, 200 MiB per complete video. `ffmpeg-static` is a Studio runtime
dependency and is checked before accepting video work. Production standalone
tracing includes the binary. The durable worker needs a continuously running
Node host; request-only hosting needs a separately managed worker.

Server configuration:

- `GEMINI_API_KEY`: required server credential.
- `MDMEDIA_VIDEO_MODEL`: defaults to `gemini-omni-1.1-flash`.
- `MDMEDIA_VIDEO_ADAPTATION_MODEL`: defaults to `gemini-3.5-flash-lite`.

## Validation and sources

The video lifecycle fixture uses a transactional test store, the actual engine,
real MP4 decoding/posters/extraction, and a fake Gemini client. It covers
concurrent idempotency, stale source rejection, original-parent regeneration,
failed-result retention, ownership/scopes, output validation, receipt recovery
without another paid create, recovery from a saved clip with no provider reads,
legacy migration, 10/20/30/40-second local assembly, and audio-bearing clips.
Engine tests cover create/edit/continue payloads, SDK retry prevention,
normalization, cancellation, source-clip limits, missing receipts, and repeated
continuations without cumulative context.

```sh
bun test src/video test/studio/video-request.test.ts test/studio/video-server.test.ts
npm run build
./node_modules/.bin/tsc --noEmit -p studio/tsconfig.json
```

Provider behavior follows Google's [Omni guide](https://ai.google.dev/gemini-api/docs/omni),
[Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview),
and [official video sample](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

After engine changes, run `npm --prefix studio run vendor:mdmedia` to rebuild,
repack, and refresh Studio's `file:../mdmedia-0.1.0.tgz` dependency, then build
Studio. Webpack's cache version
includes the installed engine's JavaScript contents because local tarballs keep
the same package version; a cached worker must not outlive its engine update.

Verified locally on 2026-10-09:

- 547 tests passed and 12 optional live music tests skipped. Three hosted readiness
  tests required localhost networking and passed when rerun with it enabled.
- Root and Studio TypeScript, targeted ESLint, and the staged production build
  passed. Staging browser checks loaded saved video, clips, image, and narration.
- Real Omni proof used only the latest 10-second clip from a saved 20-second
  sequence. The response contained that clip and the requested new 10-second
  scene. The live item was recovered without another create call: 30.042-second
  assembled playback, three clips, and a separate 10-second audio-bearing download.
  Earlier results and failed attempts remain in History.
- Provider credentials and private receipts stay on the server. Tailscale Serve
  continues to proxy HTTPS port 3443 to the local Studio service on port 3001.
- Released build `FjW3mJUDKO6S_NCpAJR8u` using the local service backup and
  rollback workflow; the saved 30-second result passed the live browser check.
