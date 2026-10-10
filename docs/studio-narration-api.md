# Studio narration API

`/api/v1` lets a client start a narration with every option the composer has,
follow it, and download the audio. Coding agents use it through the `mdmedia
studio` CLI, which holds a key the user approved in the browser.

When hosting behind a reverse proxy, set `MDMEDIA_PUBLIC_ORIGIN` in the Studio
server environment to its public origin (for example,
`https://<device>.<tailnet>.ts.net:3443`). API approval and narration links use
that origin instead of the internal Next.js address. Without it, links use the
request URL's origin. Run `npm --prefix studio run check:narration-api -- <url>`
after deployment to check authentication boundaries and the device flow without
approving a client or generating audio.

The additive [media API](studio-media-api.md) covers Gemini images, shared
Library and Activity reads, generation versions, and authenticated image assets.
Existing narration endpoints and options retain this contract.

## Authentication

Every request carries `Authorization: Bearer <credential>`:

- **Firebase ID token** — a signed-in browser session. Full access.
- **API key** — `mdm_<keyId>_<secret>`, minted by the device flow below. The
  server stores only `sha256(secret)` in `apiKeys/{keyId}` (Firestore rules deny
  all client access), compares in constant time, and re-checks the owner's
  allowlist entry on every request, so removing someone from the allowlist
  disables their keys.

API keys carry scopes `narrations:create`, `narrations:read`, `options:read`,
`playlists:manage`, and are restricted further:

- Narrations they create are always `private`; asking for `shared` or `public`
  is `403 visibility_not_allowed`.
- They cannot delete or share narrations, list keys, or create keys.
- 30 narration starts per hour per key.

Errors are `{ "error": { "code", "message" } }`.

## Endpoints

| Method | Path | Who | |
| --- | --- | --- | --- |
| `POST` | `/api/v1/narrations` | session, key | Start a narration. `202` with `{ id, status: "streaming", visibility, links }`. |
| `GET` | `/api/v1/narrations` | session, key | Your narrations, newest first. `?q=` (title contains), `?status=`, `?limit=` (default 50). |
| `GET` | `/api/v1/narrations/{id}` | session, key | Status: `streaming`, `ready`, or `error`, with title, voice, duration, error, and `links.web` / `links.audio`. |
| `GET` | `/api/v1/narrations/{id}/audio` | session, key | WAV. `409 not_ready` while generating. |
| `GET` | `/api/v1/playlists` | session, key | Your playlists with item count, total duration, and ready / streaming / error / missing counts. |
| `POST` | `/api/v1/playlists` | session, key | `{ title, description?, narrationIds? }` |
| `GET` | `/api/v1/playlists/{id}` | session, key | The playlist and its items in order. |
| `PATCH` | `/api/v1/playlists/{id}` | session, key | `{ title?, description? }` |
| `DELETE` | `/api/v1/playlists/{id}` | session, key | Deletes the playlist, never its narrations. |
| `POST` | `/api/v1/playlists/{id}/items` | session, key | `{ ops }`: add, remove, move; one transaction (below). |
| `PUT` | `/api/v1/playlists/{id}/items` | session, key | `{ order }`: exactly the items already there, in a new order. |
| `GET` | `/api/v1/options` | session, key | Voices (Gemini and the ElevenLabs voices this person may use), models, allowed visibility, presets, defaults, limits. |
| `GET` | `/api/v1/keys` | session | Connected apps. |
| `DELETE` | `/api/v1/keys/{id}` | session; key for `current` | Revoke. A key can only revoke itself. |
| `POST` | `/api/v1/device` | anyone | Start connecting a client. 20 per 10 minutes. |
| `POST` | `/api/v1/device/token` | anyone with the device code | Poll for the key. |
| `GET`/`POST` | `/api/v1/device/approve` | session | Describe / approve or deny a user code (the `/connect` page). |

At most 3 narrations generate at once per person; more is
`429 too_many_in_progress` with `Retry-After`. Generation continues on the
server after `POST` returns.

## Narration body

Only `markdown` is required; anything omitted comes from the person's Settings.
Unknown fields are rejected.

| Field | |
| --- | --- |
| `markdown` | Up to 200,000 characters. |
| `id` | Client-chosen id, so a retry cannot create a duplicate. |
| `voice` | Gemini voice name, ElevenLabs voice id, or `{ provider, id }`. |
| `model` | Gemini TTS model. |
| `delivery` / `deliveryPreset` | Delivery text, or a preset by id or name (case-insensitive). Not both. |
| `speed` | 0.5–2.5. |
| `rewriteForNarration` | Rewrite for the ear. |
| `instructions` / `instructionsPreset` | Rewrite instructions, or a preset. Not both. |
| `structureMarkdown`, `verbalizeDiagrams` | Document cleanup options. |
| `visibility` | `private` (only value allowed for keys), `shared`, `public`. |
| `playlist` | Playlist id or exact title (case-insensitive). The narration joins it as soon as it starts. |
| `playlistPosition` | `"start"`, `"end"` (default), `{ "before": id }`, or `{ "after": id }`. |
| `createPlaylist` | Create `playlist` by that title if none matches. |

The playlist is checked before any audio is made: a missing playlist, an
ambiguous title, a full playlist, or an anchor not in it fails the request.
The `202` response then includes `playlist: { id, title, position }`
(`position` counts from 1). If generation later fails, the item stays in the
playlist with status `error`; retrying with the same `id` fills the same slot.

## Playlist edits

```json
POST /api/v1/playlists/{id}/items
{ "ops": [
  { "add": ["n1", "n2"], "at": { "after": "n9" } },
  { "remove": ["n4"] },
  { "move": "n7", "to": "start" }
] }
```

- Ops apply in order, inside one Firestore transaction, to the playlist as it
  is at that moment. Items and positions are named by narration id, so an edit
  can never be based on a stale copy, and the app and an agent cannot
  overwrite each other.
- All or nothing: an unknown narration (`narration_not_found`), an anchor not
  in the playlist (`anchor_not_found`, `not_in_playlist`), or more than 100
  items (`playlist_full`) changes nothing. Errors list the offending `ids`.
- Adding an item already there, or removing one that is not, is a no-op
  reported in `unchanged`, so retries are harmless.
- Every write returns the playlist with its resulting order.
- A full reorder (`PUT … { order }`) must list exactly the current items, once
  each; otherwise `409 invalid_order`, and the client re-reads and retries.

The app uses the same rule: adding and removing are atomic array changes, and
moving a track is a transaction against the current order.

## Connecting a client (device flow)

1. `mdmedia studio login` calls `POST /api/v1/device` and prints a code and
   `/connect?code=XXXX-XXXX`, opening it in the browser.
2. The signed-in user sees the client's name and what it may do, and chooses
   Allow or Deny.
3. The CLI polls `POST /api/v1/device/token` every 3 seconds. On approval the
   poll deletes the authorization record in a transaction and mints the key in
   that response, so the plaintext key exists only in the response. Codes
   expire after 10 minutes; the device code is stored only as a hash.
4. The CLI writes `$XDG_CONFIG_HOME/mdmedia/credentials.json` (default
   `~/.config/mdmedia`) with mode `0600` in a `0700` directory, and refuses to
   use the file if group or others can read it. `MDMEDIA_API_KEY` and
   `MDMEDIA_STUDIO_URL` override it for CI.

The client sends the key only over HTTPS, to loopback, or to a `*.ts.net`
(Tailscale) host. The key never appears in CLI output or error messages.

Revoke from Settings → Connected apps, or `mdmedia studio logout`.

## Coding agents

The `mdmedia` agent skill lives in `.agents/skills/mdmedia` in the
[Agent Skills](https://agentskills.io) format. `mdmedia studio install-skill`
copies it to `~/.agents/skills/mdmedia`, the cross-client location (`--dir`
picks another). For the studio, it tells agents to:

- narrate only when the user asks, and only what they pointed at;
- run `mdmedia studio narrate -i file.md --json` and reply with `links.web`;
- add to a playlist with `--playlist`, and arrange playlists with
  `mdmedia studio playlist list|show|create|add|remove|move|order|rename|describe|delete`,
  looking at a playlist before changing it;
- pass only options the user asked for (`mdmedia studio options --json` lists them);
- never share or publish, never run `login` approval themselves, and never
  read the credentials file or `MDMEDIA_API_KEY`;
- stop on `rate_limited` / `too_many_in_progress` instead of retrying.

The agent runs the CLI; the CLI holds the key. Its worst case with a leaked key
is private narrations within the rate limit, revocable from Settings.
