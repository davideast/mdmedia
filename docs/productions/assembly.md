# Production assemblies

Studio stores scenes, media references, an assembly draft, and published review versions. Rendering happens outside Studio. Both supplied screencasts and generated footage use the same workflow. An assembly describes timing and source selection, not effects, compositing, transitions, or audio mixing.

## CLI workflow

```sh
mdmedia studio production create --from-storyboard STORYBOARD_ID --idempotency-key my-first-production --json
mdmedia studio production media add screen.mp4 --json
mdmedia studio production media add narration.wav --type voice --json
mdmedia studio production assembly export PRODUCTION_ID --out assembly.json --download-dir ./sources --json
# Edit assembly.json's document using the returned asset IDs.
mdmedia studio production assembly check assembly.json --json
mdmedia studio production assembly update PRODUCTION_ID --file assembly.json --expected-revision 1 --json
mdmedia studio production assembly export PRODUCTION_ID --out render-input.json --download-dir ./sources --json
# Render externally from this exported snapshot; retain the external render recipe.
mdmedia studio production publish PRODUCTION_ID --render preview.mp4 --expected-revision 2 --assembly-hash HASH_FROM_EXPORT --idempotency-key first-review --label 'First review' --json
mdmedia studio production version select PRODUCTION_ID VERSION_ID --json
mdmedia studio production version approve PRODUCTION_ID VERSION_ID --json
mdmedia comments watch PRODUCTION_ID
mdmedia comments context PRODUCTION_ID THREAD_ID --json
```

`list` and `show` inspect productions. `show` includes the draft for assembly productions. Media uploads deduplicate by owner and content hash. `--download-dir` explicitly downloads sources; export otherwise returns metadata only. Existing downloaded files are reused only when their hashes match. Export does not bundle credentials.

Reuse the same idempotency key and request when retrying creation or publication after an interrupted connection. Different productions or review versions need different keys. Reusing a key for different input returns `idempotency_conflict`.

A storyboard creates ordered, untimed scenes. Its current saved revision is copied, not live-linked. The default output is 1920×1080 at 30 fps and is editable in the assembly. Creating from the UI is disabled while storyboard edits are unsaved. Multiple productions can reference the same storyboard.

## Assembly document

```json
{
  "format": "mdmedia.assembly@1",
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "scenes": [
    { "id": "intro", "title": "Show the problem", "script": "Here is the starting point.", "visual": "Screen capture", "notes": "" }
  ],
  "tracks": [
    { "id": "screen", "name": "Screen", "type": "video" },
    { "id": "voice", "name": "Narration", "type": "audio" }
  ],
  "placements": [
    { "id": "screen_intro", "trackId": "screen", "assetId": "ASSET_ID", "start": 0, "in": 2, "out": 7, "sceneId": "intro" }
  ]
}
```

Times are finite seconds. A placement's duration is `out - in`; the assembly ends at the latest placement end. Still-image source ranges describe their display duration. Gaps and overlaps are allowed, including within a track. Track array order is display/layer order; later video tracks are intended above earlier ones. External tools decide how layers are composed. Audio is represented only by audio-track placements; an external renderer must decide which streams to mix. A video asset may also supply an audio placement.

Scene and track order come from their arrays; placement order does not alter explicit timestamps. IDs are unique across scenes, tracks, and placements, and contain letters, digits, underscores, or hyphens. Keep IDs stable through revisions so review references remain meaningful. Replacing footage means changing a placement's asset/source range while retaining its ID. For a ripple edit, the agent shifts the affected starts, including related audio, and submits the whole draft atomically.

The optional `provenance` records `storyboardId`, its `revision`, and a `beats` mapping from original beat IDs to scene IDs. It records the original handoff even if scenes are later removed. Draft limits are 2,000 items per collection and 700 KB of normalized document JSON.

The shared `mdmedia/assembly` module exports types, parsing, duration calculation, and storyboard conversion. `assembly check` validates document structure and timing locally; draft updates additionally validate asset ownership, media types, and known source bounds on the server. Its review-timeline projection exists solely to reuse review anchors. It is not a cut document or an input to `mdmedia cut render`.

## Drafts, renders, and review

Draft updates require `expectedRevision`. A stale write returns `assembly_conflict`; export the current draft and reconcile it rather than retrying blindly. Every export includes a server content hash and source manifest. Do not compute the publication hash from locally formatted JSON; use the hash returned by Studio.

Publication requires the exact revision/hash and an owned rendered video with known duration. Its duration must match within one output frame. CLI MP4 renders carry duration probed locally; API uploads may supply duration metadata. The check uses that metadata and does not independently prove that pixels, sound, effects, or source choices match the assembly. Use an MP4 preview for the CLI workflow.

Publishing creates an immutable snapshot and makes it the current version. It does not approve it. Approval, labels, notes, and the current-version pointer can change separately; the snapshot and render binding cannot. A changed render needs a new publication. If the draft changes while rendering, publication fails and the uploaded video remains registered. Retrying an already successful publication returns that version even if the draft has since advanced.

The production page shows the draft and its scenes. Published version pages play only their bound render and show the snapshot's tracks. Selection and review use the standard right panel. Comments retain their version and placement anchors; later edits do not move old comments. Agent comment context also includes the assembly snapshot.

## HTTP interface

All endpoints require the existing owner-scoped Studio credentials. Reads use `productions:read`; writes use `productions:write`. Storyboard conversion additionally requires `storyboards:read`.

| Endpoint | Request / result |
| --- | --- |
| `POST /api/v1/productions/from-storyboard` | `{storyboardId, title?, idempotencyKey}` → `{id, assembly}` |
| `GET /api/v1/productions/{id}/assembly` | `{revision, hash, updatedAt, document, assets}` |
| `PUT /api/v1/productions/{id}/assembly` | `{expectedRevision, document}` → updated draft |
| `POST /api/v1/productions/{id}/publish` | `{expectedRevision, assemblyHash, renderedAssetId, idempotencyKey, label?}` → published cut resource |
| `GET /api/v1/productions/{id}/comments/watch?cut=VERSION_ID` | SSE current-state snapshots; requires `comments:read` |

Existing production list/detail/patch, media upload/download, cut reads, and comment operations are reused. Stable failures include `invalid_assembly`, `assembly_conflict`, `idempotency_conflict`, `render_duration_mismatch`, `asset_not_found`, and `immutable_assembly`.

`comments watch` emits newline-delimited JSON. Each connection starts with a `snapshot` containing threads and decisions, followed by `change` events with their current state. Fetch a thread's context for its full conversation. Network interruptions reconnect with a fresh snapshot and bounded backoff. This is state synchronization, not an exactly-once event log: intermediate changes while disconnected may not be observed. Interrupting the CLI closes the request and releases server listeners.

Legacy cut-file and rendered productions continue unchanged. Legacy upsert/replace/delete-cut operations reject assembly-managed productions. There is no implicit migration, media generation, or internal renderer for this format.

## Verification

`bun test test/assembly/model.test.ts test/studio/assembly.test.ts` runs public model checks and isolated route/CLI processes. Only Firebase persistence and authentication are substituted in the automatic fixture; HTTP routing, CLI, validation, media upload/download, external FFmpeg rendering, publication, approval, comment anchoring, and stream reconnects run for real. Tests use local media and no generation credits.

`test/browser/assembly-review.mjs` verifies the actual Studio shell and player in an isolated local Pyric sandbox. Supply `ASSEMBLY_BROWSER_URL`, `ASSEMBLY_AUTH_STATE` (a sandbox-only Playwright storage-state file), `ASSEMBLY_PRODUCTION_ID`, and `ASSEMBLY_VERSION_ID` for the fixture. Optional `ASSEMBLY_TEST_TOKEN_FILE` enables real browser-comment → CLI-watch/reconnect checks; `ASSEMBLY_LEGACY_ID` and `ASSEMBLY_STORYBOARD_ID` enable legacy playback and UI handoff checks. The fixture uses scenes named “Show the problem” and “Unfilled ending” and a “Picture in picture” track with a `pip` placement starting at one second. `PLAYWRIGHT_MODULE` and `BUN_EXECUTABLE` may point to installed executables. The browser harness blocks non-local HTTP and WebSocket requests and uses no generation services.
