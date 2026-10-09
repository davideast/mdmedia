## Local development

Studio runs on Next.js with a local Pyric Node hosted sandbox. Node 22.15+, Bun, npm, and the local Pyric checkout are required. From the repository root:

```bash
bun install
bun run build
npm pack
npm --prefix functions install
npm --prefix functions run build
cd studio
bash ~/repos/davideast/pyric/.agents/skills/pyric-node-host/scripts/pack-local.sh ~/repos/davideast/pyric .pyric-local
npm install
npm run dev:bg
```

Open [http://localhost:3000](http://localhost:3000). The hosted sandbox listens on `http://localhost:3473` and stores its data in `studio/.pyric/state/hosted/`. Run `npm run dev:status`, `npm run dev:logs`, or `npm run dev:stop` from `studio/` to manage the server. The local Pyric tarballs in `.pyric-local/` are ignored by Git; rebuild them after updating the Pyric checkout. If Pyric's version changes, update the four `file:.pyric-local/*.tgz` entries in `package.json` to match.

Set `GEMINI_API_KEY` in `studio/.env` for narration synthesis. The browser Firebase settings in `.env.local.example` are needed when connecting to the real Firebase project. Set `MDMEDIA_ALLOWED_DEV_ORIGINS` to a comma-separated list of Tailscale hostnames when using the development server through Tailscale.

If you don't need unpublished Pyric changes, the exact tarballs referenced by
`package.json` are also available from npm. Instead of packing a local checkout:

```bash
mkdir -p .pyric-local
npm pack @pyric/cli@0.1.0-alpha.24 pyric@0.1.0-alpha.24 pyric-admin@0.1.0-alpha.24 create-pyric@0.1.0-alpha.24 --pack-destination .pyric-local --ignore-scripts
```

### Tailscale on Windows with mirrored WSL networking

Use different Windows HTTPS ports and Linux backend ports to avoid conflicting
listeners. Put these settings in `studio/.env.local`, replacing the hostname:

```dotenv
PORT=3001
MDMEDIA_PYRIC_PORT=3474
NEXT_PUBLIC_PYRIC_BRIDGE_PORT=3444
MDMEDIA_ALLOWED_DEV_ORIGINS=<device>.<tailnet>.ts.net
MDMEDIA_PUBLIC_ORIGIN=https://<device>.<tailnet>.ts.net:3443
```

From the repository root, start Studio and configure Windows Tailscale:

```bash
npm run studio:bg
"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --bg --https=3443 http://127.0.0.1:3001
"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --bg --https=3444 http://127.0.0.1:3474
```

Open `http://localhost:3001` locally or
`https://<device>.<tailnet>.ts.net:3443` from a tailnet device. The background
runner reads `.env.local` and passes the allowed hostname to Pyric. Local
WebSockets use port 3474; remote browsers use HTTPS WebSockets on port 3444.
Run `npm run studio:status`, `npm run studio:logs`, or `npm run studio:stop`
from the root; restart with `npm --prefix studio run dev:restart`. Background
processes last for the current WSL session; Tailscale's proxy configuration
persists. To remove these proxies, run the Windows Tailscale executable with
`serve --https=3443 off` and `serve --https=3444 off`.

Check the backend with
`npm --prefix studio run check:hosted-connection -- http://localhost:3001`.
If WSL cannot resolve or reach its own Windows tailnet address, run the HTTPS
check with Windows Node, which uses Windows tailnet DNS:

```bash
"/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w "$PWD/studio/scripts/check-hosted-connection.mjs")" https://<device>.<tailnet>.ts.net:3443
```

### Persistent production serving on Windows and WSL

The production service runs the hosted Pyric sandbox and compiled Next.js app
under `systemd --user`, with automatic restarts and journal logs. It uses the
same `.env.local`, internal ports, tailnet HTTPS proxies, and persistent sandbox
data as the WSL development setup above. Its scripts require Node 22.15+ and
systemd enabled in WSL. Enable user lingering with `loginctl enable-linger "$USER"`
if it is not already enabled.

From the repository root, build and inspect a separate candidate:

```bash
npm --prefix studio run service:build
npm --prefix studio run service:preview
```

In another terminal, run
`node studio/scripts/check-hosted-assets.mjs http://127.0.0.1:3100` and inspect
`http://localhost:3100/studio`. Stop the preview with Ctrl-C before releasing.
Install the user service once, then release:

```bash
npm --prefix studio run service:install
npm --prefix studio run service:release
```

The first release stops the background development server. Every release stops
the production host, backs up the closed sandbox database under `.pyric/backups/`,
swaps in the staged build and matching offline worker, and checks pages, assets,
and browser SDK attachment. It restores the previous server if startup or checks
fail. Previous production builds remain in `.next-hosted-previous-*`. Do not
rebuild `.next-hosted` while its server is running.

Manage production from the repository root:

```bash
npm --prefix studio run service:status
npm --prefix studio run service:logs
npm --prefix studio run service:restart
npm --prefix studio run service:stop
```

For subsequent updates, pull changes, rebuild affected dependencies when needed,
then repeat `service:build`, preview, and `service:release`. A source pull alone
does not update the compiled production server. `studio:bg` refuses to start a
development server while the production service is active.

### Run at login on a Mac

The LaunchAgents run the hosted Pyric sandbox and a compiled Next.js production server under `launchd`, bound to `127.0.0.1`, and configure private Tailscale HTTPS proxies on ports `3000` and `3473`. Tailscale must be signed in with HTTPS enabled for the tailnet. Generate the agents for this checkout and hostname so machine paths do not enter the repository:

```bash
npm run studio:stop
npm --prefix studio run build:hosted:initial
node studio/scripts/install-launch-agents.mjs <mac>.<tailnet>.ts.net
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mdmedia.studio.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mdmedia.studio.tailscale.plist"
launchctl print "gui/$(id -u)/com.mdmedia.studio"
tailscale serve status
```

Open `http://localhost:3000` on the Mac or `https://<mac>.<tailnet>.ts.net:3000` on a phone connected to the same tailnet. Logs go to `~/Library/Logs/mdmedia-studio*.log`. Both agents start when this user logs in; the Tailscale agent retries if Tailscale is not ready yet. The studio runs while the Mac is awake.

For later changes, build into a separate directory, inspect it on port 3100, then release it:

```bash
npm --prefix studio run build:hosted
npm --prefix studio run preview:hosted
# After reviewing the preview, stop it with Ctrl-C, then:
npm --prefix studio run release:hosted
```

`release:hosted` stops the Studio agent, swaps the staged build and matching service worker into place, restarts the agent, and checks its health. It restores the previous build if startup fails. The previous build remains in a timestamped `.next-hosted-previous-*` directory until you remove it. Do not rebuild `.next-hosted` while its server is running: the old HTML can then refer to JS and CSS files that have disappeared. To restart an agent after changing its plist, boot it out and bootstrap it again. `tailscale serve --bg` keeps its proxies configured after an agent stops, so disable them explicitly with `tailscale serve --https=3000 off` and `tailscale serve --https=3473 off` if you no longer want them shared.

### Checking the hosted connection

```bash
npm --prefix studio run check:hosted-connection -- http://localhost:3000
node studio/scripts/check-hosted-assets.mjs http://127.0.0.1:3100
```

The connection check uses the served Pyric initialization, browser Origin header,
and actual browser SDK worker-port attachment. It fails on Pyric's five-second
attach timeout or a different sandbox project. Asset checks and `release:hosted`
also require this attachment; a release restores the previous build if it fails.
This check does not render the application or verify sign-in and playback.

### Offline listening on a phone

On the phone, open Studio through its Tailscale HTTPS address while the Mac is awake and sign in with an approved account. In **Library**, tap the download icon for individual narrations. In **Playlists**, use the download action to save a complete playlist. Open **Downloads** once while online, then install the site from the browser menu. The installed app starts in Studio when connected and opens Downloads when the Mac is unavailable. Downloads uses the same navigation and player dock as Studio, with Android Media Session controls for background playback. Playlist changes require a manual **Update** in Downloads or Playlists.

Downloads belong to the approved account, browser profile, and exact origin (`https://<mac>.<tailnet>.ts.net:3000`). A download made through `localhost:3000`, another port, or another browser is a separate copy. When Studio is unavailable, server-dependent controls are disabled and Downloads remains available. Signing out locks access but leaves the local files in place. Browser site-data removal removes downloads and the cached app shell. The download action requests persistent browser storage when supported, but storage retention remains subject to the browser and device. Earlier unscoped downloads appear as a one-time import choice while online; do not import files that belong to another account.

## Allowlist bootstrap

Access to mdmedia Studio is guarded by a Firestore allowlist (`allowlist/{email}`). Because Firestore Security Rules reject client `list` and `write` operations on the allowlist by design, client code cannot bootstrap or alter entries.

The root of trust is **Google Cloud IAM** on the Firebase project (`roles/datastore.user` or higher). An authorized operator manages allowlist membership using the CLI tool:

### 1. Authenticate Operator
```bash
firebase login
```

### 2. Add Allowlisted Users
```bash
# Add users to production Cloud Firestore (mdmedia-dev)
bun run studio:allowlist add user@example.test colleague@example.test

# For local Pyric development against the running local sandbox:
bun run studio:allowlist add user@example.test --local
```

### 3. Verify Membership
```bash
bun run studio:allowlist check user@example.test
bun run studio:allowlist list
```

### 4. Revoke Access and Invalidate Sessions
```bash
# Removing an entry denies future operations and can revoke active refresh tokens:
bun run studio:allowlist remove user@example.test --revoke-tokens
```

Clients can never write the allowlist; all provisioning flows require prior entry by an authorized operator.

## Voice catalog and personal voices

Studio separates voice availability from each person's preferences:

| Firestore path | Contents | Writer |
| --- | --- | --- |
| `voiceCatalog/elevenlabs:{voiceId}` | Enabled voices shared with all Studio users, optional `featuredRank` | Operator only |
| `users/{uid}/voiceGrants/elevenlabs:{voiceId}` | Private voice grants for one user | Operator only |
| `users/{uid}.settings` | Default reader and ordered `pinnedVoiceRefs` | That user |

The server checks the catalog or the caller's grant before returning ElevenLabs metadata or creating a narration. A saved default or pin never grants access. The picker shows the default, personal pins, shared featured voices, then other authorized voices. Client reads and writes of the first two paths are denied by Firestore Rules; use the operator CLI:

```bash
# The existing ElevenLabs key must be able to retrieve a voice before it can
# be enabled or granted. Quote names containing spaces.
bun run voices grant dceast@gmail.com <personal-voice-id> "David East" --local
bun run voices shared <account-voice-id> "Shared reader" --rank 1 --enabled --reviewed --local
bun run voices list dceast@gmail.com --local
bun run voices list --local
```

Use `--cloud` in place of `--local` only when targeting production. `--sandbox <url>` selects a specific live Pyric sandbox. `revoke <email> <voice-id>` removes a grant. The CLI's default for a new shared voice is **disabled**.

The public ElevenLabs Voice Library currently lists “Burt Reynolds™ - Deep, Smooth and clear” as `4YYIPFl9wE5c4L2eu2Gb`, but Studio's configured key cannot retrieve that ID. Keep a candidate record disabled until an operator has added it to the backend account, confirmed its resulting usable voice ID, and reviewed the listing's identity and permitted use. The `--enabled --reviewed` command checks synthesis with Studio's model and records the review and sample time before the voice appears. Do not put personal voice IDs or API keys in application code or client-writable settings.

New ElevenLabs narrations omit provider voice IDs from their shareable document. Firestore Rules hide older public/shared ElevenLabs narrations that still contain `voiceId` from non-owners; the owner can still read them. Run the cloud migration with an authorized Google application credential (`GOOGLE_APPLICATION_CREDENTIALS` or Application Default Credentials with Firestore write access) to remove that field and restore their public/shared reads:

```bash
npm run voices:scrub-legacy -- --cloud mdmedia-dev
npm run voices:scrub-legacy -- --cloud mdmedia-dev --apply
```

The first command is a dry run. The second removes only `voiceId` from ElevenLabs narration documents and checks each document's update time before writing. Rerun it if concurrent changes interrupt the migration.

The current backend still uses one ElevenLabs key for synthesis. Studio's grants prevent other signed-in users from invoking private voices through its routes. For provider-level isolation, move shared voices to a dedicated ElevenLabs service account and route personal voices through a separately scoped credential or explicit provider sharing. Store credentials in a secret manager, never Firestore.

## Rules verification

Three checks cover the Security Rules, and each proves something different:

| Command | What it proves |
| --- | --- |
| `npm --prefix studio run rules:verify` | **ALLOW preservation.** Replays the captured journey in `test/fixtures/allowlist-journey.session.json` against `firestore.rules`, starting from an empty database. The fixture was recorded from a fresh `pyric sandbox --hosted --fresh` session whose first events are the admin allowlist writes, so no out-of-band seed is needed. |
| `npm --prefix studio run test:assurance` | **DENY coverage.** `scripts/run-authorization-campaign.mjs` runs single-dimension adversarial probes (foreign reads, field forgery, client creates, non-allowlisted and de-allowlisted users, client Storage writes) against local sandboxes. Its three Storage *read* probes currently report `invalid-probe`: their owner-read control is denied by the local Storage sandbox, so they prove nothing. Storage read coverage comes from the hosted matrix. |
| `npm --prefix studio run rules:verify:hosted` | **Hosted parity (ALLOW and DENY).** `scripts/verify-rules-hosted.mjs` sends a mock-aware case matrix to Google's Rules Test API (`projects.test`, read-only) using your `firebase login`, and exits non-zero on any mismatch. |

Journey replay cannot catch a rule that became too permissive. It only re-issues writes that succeeded during capture. Negative control: removing `&& isAllowlisted()` from `users/{uid}` `create, update` still passes `rules:verify`. DENY regressions are caught by `test:assurance` and `rules:verify:hosted`.

To re-record the fixture, follow plan 006 step B: stop the dev server, start `npx pyric sandbox --hosted --fresh -- next dev --port 3000` from `studio/`, run `bun run studio:allowlist add alice@example.test bob@example.test --local` first, walk the journey, stop the server, then copy `.pyric/last-session.json` over the fixture. Commit only synthetic `@example.test` identities. `--fresh` archives your local database under `.pyric/state/`; move it back afterwards.

### Unsupported Pyric surfaces

These gaps are why the three checks exist separately. Details and reproductions are in `PYRIC.md` §3.8–3.11.

- **No initial-state fixtures.** `pyric verify` always replays from an empty database, so state that exists before a capture must be written inside the capture.
- **No hosted mocks.** `pyric verify cases` emits no `functionMocks` for `exists()`/`get()`, so allowlist-gated cases are wrong on the Rules Test API unless mocked by hand (as `verify-rules-hosted.mjs` does).
- **Service-account-only hosted auth.** `pyric verify --engine rules-test-api` needs a service-account key or ADC. It does not accept the Firebase CLI login.
- **No Storage session replay.** Fixtures carry Storage rules text only, not objects or requests. Storage reads are covered only by the hosted matrix (see the campaign note above).

## Deploy

Production deploys use **Firebase Hosting + Cloud Run + Cloud Firestore + Cloud Storage**, with **Firebase AI Logic** kept disabled (`firebasevertexai.googleapis.com` is never enabled; all Gemini synthesis runs server-side on Cloud Run).

### 1. Least-Privilege Cloud Run Service Account

Never run Cloud Run under the default compute service account. Create a dedicated `studio-run@<PROJECT_ID>.iam.gserviceaccount.com` identity with no exported key files and only these four narrow grants:

- `roles/datastore.user` on the project (for Admin SDK reads/writes on `allowlist`, `narrations`, `users`)
- `roles/storage.objectAdmin` scoped to the narration Storage bucket
- `roles/secretmanager.secretAccessor` scoped to the `GEMINI_API_KEY` secret
- `roles/secretmanager.secretAccessor` scoped to the `ELEVENLABS_API_KEY` secret
- `roles/firebaseauth.viewer` on the project (for `verifyIdToken` and `getUserByEmail` in `/api/users/resolve`)

### 2. Identity Platform & Blocking Functions

To prevent non-allowlisted Google accounts from minting Firebase Auth ID tokens in the first place:

1. Upgrade Firebase Authentication to **Identity Platform** in the Firebase Console (**Authentication → Settings → Blocking functions**).
2. Deploy the auth blocking functions (`beforeUserCreated` and `beforeUserSignedIn` in `functions/src/index.ts`):
   ```bash
   firebase deploy --only functions
   ```
3. In **Authentication → Settings → Blocking functions**, register `blockNonAllowlistedUserCreated` (`beforeUserCreated`) and `blockNonAllowlistedUserSignedIn` (`beforeUserSignedIn`).

### 3. Ordered Deployment Procedure

Run these steps in order so security gates land before any public traffic reaches the service:

```bash
# 1. Run preflight (verifies no client AI imports, rules artifact parity, and hosted rules test suite)
npm --prefix studio run deploy:preflight

# 2. Deploy Firestore & Storage Security Rules first
firebase deploy --only firestore:rules,storage

# 3. Deploy Identity Platform blocking functions
firebase deploy --only functions

# 4. Deploy the Next.js service to Cloud Run (bypasses Hosting's 60s timeout for POST /api/narrations)
gcloud run deploy studio \
  --source . \
  --region us-central1 \
  --service-account studio-run@${PROJECT_ID}.iam.gserviceaccount.com \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest,ELEVENLABS_API_KEY=ELEVENLABS_API_KEY:latest \
  --set-env-vars ALLOWED_WEB_ORIGINS=https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com \
  --no-cpu-throttling \
  --timeout 900 \
  --max-instances 5 \
  --allow-unauthenticated

# 5. Deploy Firebase Hosting rewrite
firebase deploy --only hosting
```
