# Studio productions API

A **production** is one piece: an episode or a commercial. Its **cuts** are
the reviewable versions of it (Take 7, 8 and 9 are cuts of one production, not
three videos). Productions can belong to a **series**, which groups episodes
that share a cast. This is the data layer for the taxonomy in
`plans/video-production-kit-ideas.md` (Idea 3). [Characters](characters.md)
are stored beside productions (below), and a production links to the
character versions it was made with as its **cast**; shots and takes as
their own records come later.

A cut is either:

- **`cut`**: a [cut file](cut-format.md) with `extends` already merged and
  every media source rewritten to `asset:<id>`, its words file beside it, its
  rendered video, and a thumbnail per segment; or
- **`rendered`**: only a finished video, for takes made before cut files
  existed.

All media (takes, voice lines, music, effects, stills, graphics, renders and
thumbnails) are ordinary `mediaAssets` with `purpose: "production"`, stored
once per owner and content hash, so episodes that share takes share assets.

`mdmedia production push <manifest>` fills all of this from a production
manifest (below). Everything is private to its owner.

## Authentication

As for the rest of `/api/v1`: `Authorization: Bearer <Firebase ID token or
approved Studio API key>`, with the allowlist checked on every request. Keys
need these scopes; browser sessions have both:

- `productions:read`: list and read productions, cuts and production media,
  and look media up by hash.
- `productions:write`: create, change and delete productions and cuts, and
  upload production media.

New connections get both; existing keys are not widened. Run
`mdmedia studio login` again to approve them. Production assets are served by
`GET /api/v1/assets/{id}/content` under `productions:read`, whatever their
media type.

Errors are `{ "error": { "code", "message" } }`, plus `ids`, `errors` or
`sources` where they help (below).

## Endpoints

| Method | Path | Scope | |
| --- | --- | --- | --- |
| `GET` | `/api/v1/productions` | read | `{ productions, series }`: your productions, most recently changed first, each with its cut summaries; your series, each with its `productionIds`. |
| `POST` | `/api/v1/productions` | write | `{ slug, title, series?, coverAssetId?, cast? }`: creates the production with this slug (`201`) or updates it (`200`). |
| `GET` | `/api/v1/productions/{id}` | read | The production with its cut summaries, in order. |
| `PATCH` | `/api/v1/productions/{id}` | write | `{ title?, coverAssetId?, approvedCutId?, currentCutId?, cuts?: [{ id, status?, label?, notes? }] }` |
| `DELETE` | `/api/v1/productions/{id}` | write | Deletes the production, its cuts and its [comments](studio-comments-api.md), never its media. `204`. |
| `GET` | `/api/v1/productions/{id}/cuts/{cutId}` | read | The whole cut: stored cut file and words, the resolved `timeline` with words applied, and every asset it names. |
| `PUT` | `/api/v1/productions/{id}/cuts/{cutId}` | write | Replaces the cut, or adds it (`201`). Body below. |
| `DELETE` | `/api/v1/productions/{id}/cuts/{cutId}` | write | Removes one cut, never its media. `204`. |
| `GET` | `/api/v1/productions/media?sha256=<hex>,…` | read | `{ found: { [sha256]: asset } }`: which of up to 100 files you already have. |
| `PUT` | `/api/v1/productions/media/{sha256}` | write | Uploads one file as raw bytes, named by its SHA-256. Below. |
| `GET`, `HEAD` | `/api/v1/assets/{id}/content` | per asset | The bytes. Video and audio honour byte ranges. Below. |
| `POST` | `/api/v1/assets/links` | per asset | `{ ids }` → short-lived signed links a `<video>` or `<img>` can load without the header. Below. |
| `GET` | `/api/v1/characters` | read | `{ characters }`: yours by name, each with its versions. [Characters](#characters). |
| `GET` | `/api/v1/characters/{id}` | read | The character (by id or slug), its versions, and `latest`, its newest version whole. |
| `GET` | `/api/v1/characters/{id}/versions/{version}` | read | One version whole, with links to its stills. |
| `PUT` | `/api/v1/characters/{slug}/versions/{version}` | write | `{ character, stills }`: stores the version once. Below. |

## Productions

```json
{
  "id": "pr69c228a56d0666e5242451d4",
  "slug": "night-wagon-the-argument",
  "title": "Night Wagon: The Argument",
  "series": { "id": "se…", "title": "Night Wagon" },
  "coverAssetId": "pm…",
  "currentCutId": "take10",
  "approvedCutId": "take9",
  "cutCount": 10,
  "cuts": [
    { "id": "take9", "label": "Take 9 (opens on the road)", "status": "approved", "kind": "cut",
      "lengthSeconds": 26.3, "createdAt": 1792392951502, "order": 8, "renderedAssetId": "pm…",
      "posterAssetId": "pm…", "notes": "Opens on the road; …", "notesTruncated": false,
      "links": { "self": "…/api/v1/productions/pr…/cuts/take9", "rendered": "…/api/v1/assets/pm…/content" } }
  ],
  "createdAt": 1792400000000,
  "updatedAt": 1792400000000,
  "activityAt": 1792430000000,
  "links": { "self": "…", "cover": "…/api/v1/assets/pm…/content", "coverThumbnail": "…?thumbnail=1" }
}
```

- **Ids come from the slug.** A production's id is derived from its owner and
  `slug` (lowercase words joined by hyphens), so posting the same slug again
  updates it: that is what makes a push idempotent. `series: { title, slug? }`
  is upserted the same way (its slug defaults to the title's); `null` takes the
  production out of its series; leaving it out keeps it.
- **Statuses:** `review` (needs your review), `approved`, `final`, or `none`
  (no verdict). `kind` is `cut` or `rendered`. `order` is the cut's place in
  the production, oldest first.
- **The approved cut** is the one circled. `approvedCutId` always names a cut
  whose status is `approved` or `final`: approving a cut that isn't marks it
  `approved`; a cut whose status changes to anything else stops being the
  approved cut. Approving a cut while giving it another status in the same
  request is `409 conflicting_status`.
- **The current cut** is the one to show first. A production with none (new,
  or its current cut was deleted) takes the last cut in order; it stays until
  changed. `mdmedia production push` sets it to the manifest's `current`,
  default the last cut, when it creates the production (or with
  `--reset-status`).
- `cuts` in a `PATCH` edit a cut's `status`, `label` or `notes` (the review
  note); they don't add or remove cuts. An unknown cut is `404 cut_not_found`.
- **Cut summaries** carry what a listing shows: `posterAssetId` (a still from
  the rendered video, an image with its own thumbnail) and `notes`, the review
  note up to 2,000 characters, cut at a word with `notesTruncated: true` when
  longer (shorter still if a production's summaries would outgrow its
  document). The cut itself always has the whole note.
- **`activityAt`** is the later of the newest cut's `createdAt` and the last
  review (a cut's status, or the approved cut, changing). The listing is
  sorted by it, most recent first; pushing again doesn't count as activity.
- Deleting a production or a cut keeps its media assets: another production
  may use them.

Firestore holds `productions/{id}` (with the cut summaries), the cuts at
`productions/{id}/cuts/{cutId}` and `series/{id}`. Security Rules let the owner
read them (a listing must filter on `ownerUid`) and deny every client write:
only this API writes them, because only it can check that a cut's assets are
the owner's and that the cut resolves.

## Characters

A character ([characters.md](characters.md)) is stored per owner and slug, one
document per version that never changes:

```
characters/{id}                     { ownerUid, slug, name, kind, latestVersion, versions: [{ version, date, changes, createdAt }], … }
characters/{id}/versions/{version}  { ownerUid, characterId, version, character, stills, createdAt }
```

- `PUT /api/v1/characters/{slug}/versions/{version}` with `{ character,
  stills: { [stillId]: assetId } }`: `character` is the character file
  (`mdmedia.character@1`), checked whole (`422 invalid_character` with its
  `errors`) and matching the path; every still is named with an image asset
  of yours (upload them as production media first; `400 asset_not_found`,
  `invalid_stills`). A new version is `201`; the same version with the same
  content again is `200`; with other content `409 version_exists`, since a
  production may have been made with it.
- Ids derive from the owner and the slug (`ch…`), so a `GET` takes either.
- No Rules match `characters`, so clients can't read them directly: pages use
  this API.

**Casts.** `POST /api/v1/productions` takes `cast: [{ role, character:
"rick@1" }]`. Each role is cast once, and each version must be one of yours
(`400 character_not_found`, `invalid_cast`). Leaving `cast` out keeps it; `[]`
clears it. A production then carries:

```json
"cast": [ { "role": "Rick", "characterId": "ch…", "slug": "rick", "version": 1, "ref": "rick@1", "name": "Rick",
            "description": "…", "register": "grim and intense, …", "voice": "The video model's own voice (on camera)",
            "stillAssetId": "pm…", "referenceLines": 5 } ]
```

what the production page shows, copied from the version (which never
changes). `mdmedia production push` stores the manifest's cast: it uploads
each character's stills with the production's media, puts each version, then
links the production; a manifest without a `cast` leaves the studio's as it
is.

## Cuts

`PUT /api/v1/productions/{id}/cuts/{cutId}`, where `cutId` is letters, digits,
`_` and `-` (up to 80):

```json
{
  "label": "Take 9 (opens on the road)",
  "status": "approved",
  "kind": "cut",
  "notes": "Opens on the road; Buddy's lines over the dash.",
  "order": 8,
  "createdAt": 1792392951502,
  "cut": { "format": "mdmedia.cut@1", "meta": { … }, "media": { "root": "." }, "segments": [ { "id": "hw", "src": "asset:pm…", "in": 0, "out": 3.2 } ], … },
  "words": { "format": "mdmedia.cut-words@1", "lines": { "bridge": { "fingerprint": { "source": "asset:pm…", … }, … } } },
  "renderedAssetId": "pm…",
  "posterAssetId": "pm…",
  "thumbs": { "hw": "pm…", "pov": "pm…" },
  "source": { "cut": "docs/cuts/night-wagon-take9.cut.json", "rendered": "takes/night-wagon-take9.mp4" }
}
```

- A `cut` cut must parse as a full cut file (merge `extends` first) and every
  `src` must be an `asset:` of yours or a `color:`; anything else is
  `400 unportable_source` with the `sources`. An asset that isn't yours is
  `400 asset_not_found` with the `ids`. `renderedAssetId` must be a video,
  `thumbs` and `posterAssetId` images. The cut must resolve, else `422 invalid_cut` with the
  resolver's `errors`; its `lengthSeconds` is the timeline's. Its `output`
  path is dropped: the render is `renderedAssetId`.
- A `rendered` cut has no `cut` or `words`, and needs `renderedAssetId`. Its
  `lengthSeconds` is the video's, when the upload gave a duration.
- Without `createdAt`, a replaced cut keeps the one it had (else now).
- The words file's fingerprints name the same `asset:` refs as the cut. Words
  are applied when the cut is read and checked against each asset's content
  hash, so words for a line whose audio changed are left out, never misplaced.
- A cut and its words must fit in one Firestore document (about 900 KB), else
  `413 cut_too_large`. A production holds up to 200 cuts.

`GET` returns the stored fields plus what a viewer needs, so a UI never
re-implements merging or words:

| Field | |
| --- | --- |
| `cut`, `words` | As stored. |
| `timeline` | `resolveCut`'s timeline (`mdmedia/cut`'s `Timeline`) with the fresh words applied: every item's start and end, segments, lines with `words` on the timeline, music, effects, overlays. Asset sources resolve to `{ kind: "asset", ref, id }`. `null` for a rendered cut, or if it no longer resolves (see `errors`). |
| `wordsSummary` | `{ applied, stale: [{ id, reason }], unchecked }` by line id, or `null` with no words file. |
| `errors` | Resolver errors, normally `[]`. |
| `assets` | Every asset the cut names (sources, render, thumbnails) by id: `{ id, mediaType, mimeType, byteLength, sha256, width, height, durationMs?, links: { content, thumbnail } }`. |
| `links` | `self`, `production`, and `rendered` (the render's content URL, or `null`). |

## Production media

```
PUT /api/v1/productions/media/{sha256}?mediaType=video&durationMs=26300
Content-Type: video/mp4
<raw bytes>
```

- `mediaType` is what the file is in the production: `video`, `image`,
  `voice` (a spoken line; the taxonomy's word for what was narration),
  `music` or `sfx`. The content type must suit it: `video/mp4`,
  `video/quicktime`, `video/webm`; `image/png`, `image/jpeg`, `image/webp`; or
  for sound `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`,
  `audio/flac`. Otherwise `415 unsupported_media`; the first bytes must match
  the type, too.
- The body streams to Storage as it arrives and is never held whole, up to
  **256 MiB** (images 32 MiB, since they are decoded to check them and make
  their thumbnail). A larger `Content-Length`, or a body that grows past the
  bound, is `413 media_too_large`. Takes run to about 25 MB; a long render
  such as CGL Football is about 160 MB.
- The bytes must hash to the path, else `400 hash_mismatch` and nothing is
  kept. A body shorter than its `Content-Length` is `400 incomplete_upload`.
- **Idempotent:** if you already have these bytes the answer is `200` with
  that asset and the body is not read; a new file is `201`. The asset id is
  derived from your uid and the hash, so the same bytes are one asset however
  many cuts or productions use them.
- `durationMs`, `width` and `height` are optional and stored as given (the
  client can read the whole file; the server sees it only as a stream).
  Images get their size and a WebP thumbnail from the bytes. Video and audio
  have no thumbnail (`links.thumbnail: null`); a cut's segment thumbnails are
  images of their own.

Look files up before uploading: `GET /api/v1/productions/media?sha256=a,b,c`
answers with the ones you have.

## Streaming: byte ranges

`GET /api/v1/assets/{id}/content` streams video and audio from Storage and
honours one byte range, so a player can seek without downloading the file:

- `Accept-Ranges: bytes` and a fixed `ETag` (assets never change) on every
  answer; `HEAD` returns the headers alone.
- `Range: bytes=start-end`, `bytes=start-` or `bytes=-suffix` is `206` with
  `Content-Range: bytes start-end/size` and only those bytes. A range outside
  the file is `416` with `Content-Range: bytes */size`. Multiple ranges are
  answered with the whole file (`200`).
- `If-None-Match` with the ETag is `304`; an `If-Range` that doesn't match
  sends the whole file.
- Images and `?thumbnail=1` are unchanged: always the whole file, `200`.
  `?download=1` adds `Content-Disposition` as before. An asset without a
  thumbnail answers `?thumbnail=1` with `404 no_thumbnail`.

## Signed media links

A `<video>` or `<img>` can't send the `Authorization` header, so a page asks
for links instead:

```
POST /api/v1/assets/links   { "ids": ["pm…", "pm…"] }
→ { "links": { "pm…": { "content": "…/api/v1/assets/pm…/content?exp=…&sig=…", "thumbnail": "…&thumbnail=1" | null } },
    "expiresAt": 1792432800000 }
```

- Up to 100 ids. Ids that aren't yours, or that your key's scopes can't read
  (`productions:read` for production media), are left out.
- Each link opens **one asset** (and its thumbnail) until `expiresAt`: 15 to
  20 minutes away, rounded up to five minutes so links asked for close
  together are the same URL and stay in the browser's cache.
- `sig` is HMAC-SHA256 under a server secret over the asset id, its owner and
  `exp`. The content route checks it in place of the header and serves the
  same bytes, ranges (`206`, `416`), ETag and `304`. An expired link is
  `403 link_expired`; a changed `exp`, a changed signature, another asset's
  link or a link to a missing asset is `403 invalid_link`. With an
  `Authorization` header, the header is used and any link ignored.
- The secret is `MDMEDIA_MEDIA_LINK_SECRET` (32 characters or more), set like
  Studio's other secrets in `.env.local` or the host's environment. Without
  it each server process makes a random one, so links stop working when it
  restarts (pages fetch fresh ones) and can't cross several instances. Set it
  for a deployment with more than one.
- Links are never logged; the dev server's request log skips URLs with a
  `sig`.
- A link outlives its approval: removing someone from the allowlist, or
  revoking a key, stops new links at once and old ones within 20 minutes.

## Pushing a production

```sh
mdmedia production push docs/productions/night-wagon-the-argument.production.json [more.production.json …]
```

It goes through the connected studio (`mdmedia studio login`, or
`MDMEDIA_STUDIO_URL` and `MDMEDIA_API_KEY`), checks every manifest before
sending anything, and is safe to run again:

1. Reads each cut, merging `extends`, resolves it against the media root, and
   lists every file it plays (takes, voice lines, music, effects and every
   part of a bed, stills, overlays) and the first-frame stills its `sources`
   name, its rendered video (`rendered`, else the cut's `output`), the
   rendered-only takes and the cover.
2. Makes a thumbnail per segment with ffmpeg (`FFMPEG_PATH`, else the bundled
   `ffmpeg-static`, else `ffmpeg` on the PATH): the shot's first frame, framed
   as the cut frames it, the middle 4:3, 240 × 180 JPEG, cached in
   `~/.cache/mdmedia/production-thumbs`. A still segment is drawn as the cut
   shows it on its last frame, with the overlays drawn into it, its zoom, and
   the overlays up over the picture then (a bumper's layers, a card's keys, a
   countdown's digits), since a still is often a bare background whose
   picture is in its overlays. It also makes each cut's poster from
   its rendered video the way the review page does: the frame 30% in, the
   middle 4:3, 480 × 360. `--no-thumbs` skips both.
3. Hashes every file, asks which the studio has, and uploads the rest. An
   image is typed by its bytes, so a generated still saved as `.png` that is
   really a JPEG uploads as one.
4. Upserts the production by slug, replaces each cut (sources rewritten to
   `asset:` refs, words file fingerprints likewise), removes cuts the manifest
   no longer lists, and, for a production that had no cuts before, sets the
   approved and current cuts.

Reviews made in Studio win over the manifest. A cut gets the manifest's
`status` only when the push creates it; a cut the studio already has keeps
the status it has there, and a production that already had cuts keeps its
approved and current cut. `--reset-status` sets every cut's status, and the
approved and current cut, from the manifest again, overriding those reviews.

It prints one line per production, e.g. `Night Wagon: The Argument — 10 cuts
(2 cut files, 8 rendered); uploaded 47 files (66.2 MB), reused 0 (0.0 MB)`,
ending with what it kept that differs from the manifest (`; kept from Studio:
take9 review, approved take10`), and totals; `--json` prints the reports
(`keptStatus` and `keptPointers`). `--root` (or `MDMEDIA_CUT_MEDIA_ROOT`)
overrides the media root.

### The manifest

`docs/productions/<slug>.production.json`:

```json
{
  "format": "mdmedia.production@1",
  "slug": "night-wagon-the-argument",
  "title": "Night Wagon: The Argument",
  "series": { "title": "Night Wagon", "slug": "night-wagon" },
  "media": { "root": "~/.local/share/mdmedia/productions/crt-tv" },
  "cover": "review/posters/ch-night-wagon-take9.jpg",
  "approved": "take9",
  "cuts": [
    { "id": "take1", "rendered": "review/clips/ch-night-wagon.mp4", "label": "Take 1", "status": "none",
      "notes": "Red scanner sweep in the first frame…", "createdAt": "2026-10-18T21:37:00.727Z" },
    { "id": "take9", "cut": "docs/cuts/night-wagon-take9.cut.json", "label": "Take 9 (opens on the road)",
      "status": "approved", "notes": "…", "createdAt": "2026-10-19T06:55:51.502Z" }
  ]
}
```

- `cut` paths are relative to the repository (the nearest folder above the
  manifest with a `.git`); `rendered` and `cover` paths are relative to
  `media.root`, where `~` is your home folder.
- Each cut needs `cut` or `rendered` and a `label`; `status` defaults to
  `none`, `notes` to empty. `id` defaults to the file's stem. `createdAt` is an
  ISO date or milliseconds. A `cut` entry may also give `rendered` to override
  the cut's own `output`.
- Cuts are listed oldest first; their place in the list is their `order`.
- `approved` (default the last approved or final cut) must be approved or
  final; `current` defaults to the last cut. `series` may also be just a title.
  Statuses, `approved` and `current` are where a production starts; once it
  is in the studio, reviews there take over (see above).
- `cast` (optional) is `[{ "role": "Rick", "character": "rick@1" }]`: each
  role is a cut line's `speaker`, cast once, to a character version in
  `docs/characters` ([characters.md](characters.md#casts)). Unlike statuses,
  the manifest's cast is pushed every time.

The CRT TV productions in `docs/productions` were written from the review
page's data (`review/manifest.json` and `review/shows.json` in the media root):
every take on the review page is a cut, oldest first, with its note; takes
with a cut file use it, the rest are rendered cuts.

## Notes for UI work

- **Playing video:** use signed links (`useMediaLinks` and `useSteadySource`
  in `studio/src/lib/use-media-links.ts`), not `usePrivateMedia`, which
  fetches whole files into a blob and can't seek before the download ends.
  The pages under `/productions` do: a player keeps its link until it pauses,
  then moves to the fresh one where it stood; if a link fails while playing,
  the page fetches new links and carries on from the same time.
- **Live reads:** owners may read `productions` and their `cuts` with the
  Firestore client SDK (rules allow it); writes must go through this API.
- **Grouping:** `GET /api/v1/productions` has the series and their
  `productionIds`; a production's `series` is `null` when it has none.
- **Thumbnails** are per segment of a `cut` cut (`thumbs`); every cut with a
  rendered video has a `posterAssetId`. The production's `coverAssetId` is an
  image with its own thumbnail.

## Studio pages

- **`/productions`** (Productions in the left rail, between Library and
  Playlists): your productions as cards, each series under its own heading
  and the rest under Standalone, most recent activity first. Each card has its
  cover (else its newest poster), status, newest version and version count.
  Pictures load lazily from signed links; no video loads here.
- **`/productions/{id}`**: the approved cut (else the current one) called
  out, then its **Cast** (each character's still, name, version, voice, the
  lines its levels came from, and register), then every version newest first with its poster, length, date and
  review note (clamped; the whole note on hover). A version's status is a
  menu on its row; Approved or Final also makes it the approved cut.
- **`/productions/{id}/cuts/{cutId}`**: a `cut` cut in the cut viewer; a
  rendered one as the player and its note. The header leads back to the
  production and switches versions; switching between two `cut` cuts keeps
  the playhead.
- Productions and cuts are work items: Find work searches them by title and
  label ("Take 9 · Night Wagon: The Argument"), and they can be pinned and
  come back on reload like other work.
- `/cut/{name}` stays a development-only view of a cut file straight from
  `docs/cuts` and the local media folder.
