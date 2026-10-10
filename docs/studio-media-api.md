# Studio media API and image UI

Studio supports Narration and Gemini Image. Create, Drafts, Library, Activity,
Pinned, Recent, and Find work serve both. Video and Music are registered media
types but remain unavailable until their editors and handlers exist.

The existing [narration API](studio-narration-api.md) remains compatible. Its
`streaming` status, WAV endpoint, playlists, visibility, and request options
retain their existing meaning. Images are private in this release.

## Authentication and access

Use `Authorization: Bearer <Firebase ID token or approved Studio API key>`.
The existing allowlist and revocation checks apply. New connections receive
`images:create` and `images:read` in addition to existing scopes; existing keys
are not silently expanded. Run `mdmedia studio login` again to approve image
access. Browser sessions have full access to their own images.

- `images:create`: submit images/versions, rename images, upload references.
- `images:read`: read images, attempts, and owned image assets.
- Shared catalog/activity reads include only the types the caller may read.
  Explicitly requesting a type outside that scope returns `403`.
- Image assets and references are owner-only, including when an ID is known.
- API keys and provider credentials never appear in asset URLs or response data.

## Resource hierarchy

An image item has a stable identity, editable source/settings, a latest-attempt
pointer, and a separate latest-successful-result pointer. Each generation stores
an immutable input/options snapshot. Output files and references are assets.
Regeneration adds an attempt; it never replaces prior output files. Failure
retains the previous successful preview and all source material.

Legacy narrations remain in their existing collection and are projected into the
shared catalog. For Activity, each existing narration is one legacy attempt;
this does not introduce image-style version history into old narration records.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/images` | Create an image and enqueue its first attempt. |
| GET | `/api/v1/images` | Paginated image catalog. |
| GET | `/api/v1/images/{id}` | Item, current request, latest attempt, and latest successful result. |
| PATCH | `/api/v1/images/{id}` | Rename with `{ "title": "…" }`, 1–200 characters. |
| POST | `/api/v1/images/{id}/generations` | Enqueue another version of that image. |
| GET | `/api/v1/images/{id}/generations` | History, newest first, 50 per page. |
| GET | `/api/v1/generations/{id}` | Read an attempt. Legacy narration attempt IDs have a `narration_` prefix. |
| GET | `/api/v1/generations` | Cross-medium Activity, including failed/interrupted attempts. |
| GET | `/api/v1/media` | Cross-medium Library. |
| POST | `/api/v1/assets` | Upload one reference as raw PNG/JPEG/WebP bytes. |
| GET | `/api/v1/assets/{id}/content` | Authorized original image; `?thumbnail=1` returns a bounded WebP preview. |
| GET | `/api/v1/options?media=image` | Availability, defaults, supported settings, and limits. |

Catalog and Activity accept `type`, `q`, and `cursor`. Activity additionally
accepts `status`. Responses contain `{ items, nextCursor, indexing }`. Pass
`JSON.stringify(nextCursor)` as the next request's `cursor` query parameter.
Ordering is stable by creation time and document ID. Catalog scans are bounded
at 500 entries per request and return up to 50 matches, so a sparse search may
return an empty page with a continuation cursor. Activity reads 50 records per
page before text filtering, and likewise may require continuing to older work.

Existing narration indexing proceeds in batches of 100. While `indexing` is
true, repeat the catalog request before browsing results. New narration creation,
checkpoints, completion, deletion, and Studio title edits update the projection.
The UI uses one mixed catalog, rather than fetching whole collections per medium.

## Submit an image

Only `prompt` is required. It is one prompt, including literal Markdown, for one
still image. Markdown image links do not upload references or split the request
into multiple images.

```http
POST /api/v1/images
Authorization: Bearer <credential>
Idempotency-Key: <unique-key-at-least-10-characters>
Content-Type: application/json
```

```json
{
  "prompt": "An illustrated coastal village",
  "adaptation": {
    "enabled": false,
    "instructions": ""
  },
  "output": {
    "aspectRatio": "16:9",
    "resolution": null
  },
  "referenceAssetId": null
}
```

Omitted options resolve from the person's image defaults. On regeneration,
omitted options resolve from that item's current request. Prompt is always
explicit. Initial defaults are direct generation, wide 16:9, model-default
resolution, and no reference. Supported resolutions are 1K/2K/4K; supported
ratios are exposed through options. Provider/model overrides, filesystem paths,
visibility, unknown fields, and narration-specific controls are rejected.
Prompt limit: 32,000 characters; adaptation instructions: 4,000 characters.

Adaptation uses a dedicated visual-brief step. Original source, custom
instructions, prepared prompt, and resolved generator/model are retained with
the attempt. Disabled adaptation submits the original prompt directly.

The server returns `202` with `{ id, type: "image", generation, links, replayed }`.
`generation.id` identifies this particular attempt and `links.self` identifies
the image item. Links use `MDMEDIA_PUBLIC_ORIGIN`, including the tailnet origin
when configured. Poll the generation's `links.self` or reopen `links.web`.

Statuses: `queued`, `generating`, `ready`, `error`, `interrupted`. During work,
phase is `starting`, `preparing`, `generating`, or `saving`. There is no fabricated
percentage progress or incremental preview. Ready attempts expose an `assets`
array with ID, actual MIME type, dimensions, byte length, and content/thumbnail
links. Output format is determined from decoded image bytes, not a requested
filename extension.

## References and downloads

Upload raw image bytes to `POST /api/v1/assets`; its response includes the asset
ID to use as `referenceAssetId`. The server limits input to 10 MiB, decodes the
file, accepts only still PNG/JPEG/WebP, and creates a thumbnail. One owned
reference can guide generation; exact visual reproduction is not guaranteed.
An owned output asset may also be reused as a reference.

Use authenticated fetches for original/thumbnail content. The browser converts
responses into local blob URLs. Add `?download=1` for attachment headers. Images
download as ordinary files; narration's offline Downloads and Playlists retain
their audio behavior.

## Idempotency, admission, and recovery

Both creation POST endpoints require an `Idempotency-Key` of 10–128 letters,
numbers, underscores, or hyphens. The key is scoped to owner and target item
(or new-item creation). Repeating the same body returns the original attempt,
even after later versions exist. Object property order is ignored. A different
body under the same key returns `409 idempotency_conflict`. Resolve omitted
options only on first acceptance; the stored attempt is the authoritative
snapshot. Use a fresh key for an intentional new version.

The acceptance transaction persists the item, attempt, catalog/activity entry,
quota, and request key before paid work starts. At most three image attempts may
be outstanding per owner, and a key may start 30 images per hour. Narration
retains its existing limits. Retries do not consume another image quota slot.
Additional attempts on an image already queued/generating return `409`.

A worker inside the always-on Studio process claims queued jobs transactionally,
renews leases, and records terminal results. Workers use a process-wide pool of
three image executions. A restarted process recovers queued work and checks
expired leases. If output storage completed before the final database update,
it finishes persistence using that output. It never repeats a provider call
whose outcome is uncertain. The Gemini image call disables SDK retries.
Interrupted attempts explain that a new version is another provider request.

This worker requires a continuously running Node host such as this machine's
Studio service. Request-only/serverless hosting needs a separately managed worker
before adopting this execution model.

Errors retain `{ "error": { "code", "message" } }`. Provider exception text is
not returned. Validation failures are `400`; missing/foreign resources `404`;
permission failures `401/403`; conflicts `409`; admission/rate limits `429` with
`Retry-After`; missing Gemini configuration `503`.

## UI behavior

Create → Image opens a typed, locally saved draft. Narration and Image use one
composer layout: a short heading, large editor, and rounded primary action.
Options, Markdown import, attachments, and result tools use icons with accessible
labels and tooltips. Image options starts closed.
Its drawer contains adaptation/custom instructions, shape, resolution, and one
reference attachment. Once attached, the reference is also visible beside the
prompt. Options can be saved as account image defaults.

Results are saved automatically. The viewer supports editing/regeneration,
download, full-window/actual-size viewing, rename, duplicate, attempt history,
and source/prepared-prompt details.
A pending submission retains its key and body across refresh and provides Retry
submission, so a lost HTTP response does not create a second paid request.
Pinned, Recent, Find work, and Drafts recognize images independently of narration.

Video/Music can add medium-specific endpoints and editors, then register their
available type in shared navigation. The catalog, attempt statuses, asset
records, and item links already have a media discriminator. This release does
not require a generic editor or a compulsory project hierarchy.

## Build and verification

The image engine is exported as `mdmedia/image`; Studio installs the local
engine tarball. After engine source changes, rebuild/repack it and refresh
Studio's dependency before building Studio. Add the Firestore indexes and
generate rules from `firestore.modules.rules` for deployments. New media records
are server-only, and Storage's default-deny policy covers image objects.

Focused verification:

```sh
bun test test/image test/studio/image-request.test.ts test/studio/image-server.test.ts
bun test test/studio/workspace-navigation.test.ts test/studio/narration-api.test.ts test/remote-studio-client.test.ts
./node_modules/.bin/tsc --noEmit -p studio/tsconfig.json
```

The server lifecycle fixture runs in an isolated child process with an in-memory
transactional database, actual image decoding/storage metadata, and a fake Gemini
client. It checks concurrent idempotency, scoped routes, ownership, immutable
versions, failed-regeneration retention, and recovery without resubmission.

Verified on 2026-10-09:

- Full repository suite: 532 passed, 12 optional live music tests skipped,
  zero failures. Production build and TypeScript passed.
- New media files passed ESLint and the CQRS scanner. Repository-wide checks
  still report pre-existing AppShell effect lint errors and a client transaction
  in playlist reordering; neither originated in the image implementation.
- Browser checks covered typed drafts, persisted options, pinning, mixed
  Library/Activity, duplication, history, full-size viewing, downloads, and
  320/390 px layouts without page errors.
- One real Gemini generation used an uploaded reference, returned a 1024×1024
  JPEG, and remained available after restarting the persistent Studio service.
- Build `zQfN-7Vs4Wy3btVy7Nm6T` was released through the service's backup/rollback
  script. Local and tailnet checks passed; unauthenticated media reads returned
  401. The user service is enabled and active.
- The shared composer and icon controls were subsequently released as build
  `V30LBOlukgM10tzBQ0_a3`, with image and narration layouts checked at mobile
  and desktop widths.
- Local rules replay passed. Automatic approval review rejected the hosted
  Google Rules Test API check because it would export repository rules without
  specific authorization. That external check was not run.
