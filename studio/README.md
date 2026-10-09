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

Set `GEMINI_API_KEY` in `studio/.env` for narration and video generation. The browser Firebase settings in `.env.local.example` are needed when connecting to the real Firebase project. Set `MDMEDIA_ALLOWED_DEV_ORIGINS` to a comma-separated list of Tailscale hostnames when using the development server through Tailscale.

### Workspace navigation

**Create** opens a separate Narration or Video document. **Projects** groups documents without requiring a project first; **Library** holds generated narration and video takes, playlists, and offline media; **Activity** shows narration and video jobs. Workspace tabs contain creative documents. Projects, document titles, and drafts are saved per account in this browser.

Video uses one workspace: beat outline or Assets at left, preview in the center, selected-beat controls at right, and a resizable timeline docked below. **Direction** opens focused writing without leaving the video. On narrow screens, Preview, Beat details, Assets, and Direction provide direct access while the timeline remains visible. **Scene settings** and **Export video** apply to the whole document. Clip settings are collapsed inside the selected-beat inspector.

Add a ready narration from **Assets** at the playhead, or choose **Create narration for this video**. The narration form preserves the video destination; its finished result can be inserted and returns to that video. Library narration cards also offer **Use in video**. An audio placement references a particular saved take, with independent position, source trims, volume, and mute. Preview synchronizes it with the sequence; export mixes it with the video audio and ends at the video duration. Regeneration never silently replaces an inserted take. Audio sources must belong to the signed-in account. Music and sound-effect generation are future tools, not active forms yet.

### Prompt to script

New Video documents open with **Brief and script**. Upload a MOV, MP4 or WebM reference (30 MB / 120 seconds maximum), choose a reference range, describe the video and select **Draft script**. **Use as reference** is the default: appearance and setting inform new shots, while recorded demo words stay out of the script. **Include original footage** explicitly preserves the selected recording and its speech as the opening. The server retains the original privately, prepares an MP4 preview and poster with FFmpeg, and sends the preview plus brief to Gemini for analysis and a structured script. `GEMINI_SCRIPT_MODEL` optionally overrides the default text/video-understanding model.

The editable script is a continuous reading surface with dialogue and visuals for every section, explicit production labels, and expandable timing/sound controls. Speech is budgeted at an adjustable section length using a planning estimate of 150 words/minute plus explicit action/pause time (at least three seconds for screencasts). Rushed sections are flagged live; total timing is compared with the requested duration. The planner validates both pacing and target duration (10% tolerance, minimum two seconds) and makes at most one correction pass before preserving the existing script and reporting the problem. It never silently stretches an incomplete outline. The planned sequence distinguishes original footage, presenter performances, authentic screencasts and generated cutaways. The source transcript is separate from proposed dialogue. Source assets are account-scoped server records; the brief and edited script currently persist in the browser workspace. Replacing a script requires explicit confirmation. The existing beat editor remains accessible through **Open editor**.

**Build video** snapshots the script into timeline placements and starts available generated sections. Included original footage is linked as a private source; presenter and screencast sections remain placeholders with **Attach recording**. The upload route imports a saved recording into the video media pipeline without changing the original. The same preview and export now support uploaded and generated sources together.

**Scene continuity** is an explicit brief setting. One continuous shot overrides planner cuts, keeps shared direction and initial visual identity, and chains each generated beat to its predecessor. New briefs default to continuous; legacy all-generated scripts also require continuity unless Planned cuts is explicitly selected. Build and generation preflight the entire connected run (40 seconds maximum, at least 3 seconds for each continuation) before submitting clips. Oversized plans and legacy independent timelines cannot silently generate unrelated shots. Replacements require acceptance before generating dependent continuations. Build/generation checkpoints save validated private snapshots under `videos/{uid}/plans/{draftId}` through `/api/video-plans/{id}`, including the brief, normalized script, shared direction and attempted clip IDs; the browser workspace remains the editable source. These checkpoints are not cross-device workspace synchronization.

Script section identity is retained independently of the selected take. Rebuilding keeps matching takes and trims; source-type changes archive the previous take. Regeneration preserves existing footage until **Use this take**. Previous takes can be restored, and replacing an upstream source invalidates its dependent continuations. A short recording or partial generated result keeps its planned timeline slot until **Use available duration** explicitly shifts later video sections; existing audio positions do not move. Longer footage remains available for trimming. Final export requires ready included sections and reviews which picture/audio assets are actually attached. Written voiceover/music/SFX cues are not automatically synthesized. Presenter footage and screencasts remain explicit production requirements. Omni supports uploaded-video extension up to 10 seconds, but does not support adding new dialogue while extending uploaded talking footage. This path must not be presented as voice cloning or a validated talking-avatar workflow. See [provider extension constraints](https://ai.google.dev/gemini-api/docs/omni#video-extension).

### Scene generation

Open `/studio/scene` to edit beats and preview their tracks in one workspace. **Direction** opens the scene's beats and shared camera/continuity direction for focused writing. Each track has its own Generate/Regenerate control. **Generate beat clips** generates missing or changed beats and waits for the previous result when the next beat continues it. No final video is assembled until **Export final video** is pressed.

**Regenerate all beat clips** generates fresh footage for every included beat, including already-ready results, using the current direction and saved generation choices. It resets source trims and waits for each fresh parent before submitting its continuation. Final export remains a separate action. The direction editor and timeline share the current sequence preview; earlier whole-scene videos remain downloadable. Per-beat feedback distinguishes submitting, checking status, generating, saving, blocked, partial, and failed states, with elapsed time for active requests. **Check beat status** performs a new server read for active or problem jobs. A blocked continuation explains the preceding beat's current and original ending, with **Restore previous ending** available directly in its inspector.

In the selected-beat inspector, choose **New shot** or **Continue previous beat**. Continuation uses the preceding included beat's saved interaction context to extend its action, camera, lighting, and audio. Connected beats remain separate editable tracks, but preview and export use ranges from the latest continued source. Adjacent unmodified ranges are rendered together without a fade or an artificial clip boundary. The first included beat must be a new shot. This version supports connected shots up to 40 seconds and requires the preceding beat's original ending; **Restore original ending** removes an incompatible end trim. Continuation needs no image reattachment. The model still determines the visual result, so inspect the generated join.

Select text, first-frame animation, or reference images, then landscape or portrait framing. Image inputs accept PNG, JPEG, and WebP, up to 10 MB each, six references, and 32 MB combined. Images are shared inputs for the beat generations and stay in the current browser session; reattach them to generate again after a reload. Independent clips may have visible cuts; continuity direction is model guidance rather than a guarantee of seamless transitions.

The timeline previews the included clips in order without making a combined file. The main viewer uses a full 16:9 monitor, and each beat row has Play/Pause controls that stop at its source trim. Select a track to edit its direction, apply source In/Out trims, mute audio, exclude it, or move it earlier/later. The visible handles also trim with dragging or arrow keys (Shift uses larger steps). Editing beat prose, duration, framing, mode, or shared direction marks its existing clip as changed and requires generation before exporting. Replacing an upstream result, trimming its ending, or changing the preceding included beat marks dependent tracks **Needs continuation**; saved footage remains available and regeneration is explicit. Moving a new shot preserves its clip. Untimed beats default to six seconds; sub-three-second beats generate the model's minimum three seconds and trim to the directed length.

The server explicitly requests duration from the last timed beat. Gemini Omni generates 3–10 seconds per turn, so a longer individual beat is automatically extended, up to 40 seconds. It saves each completed section and measures the actual MP4 duration. If extension fails, the saved partial clip remains playable; **Finish this beat** resumes a saved section boundary without regenerating the opening. Other partial results can be regenerated. See [Omni extension guidance](https://ai.google.dev/gemini-api/docs/omni#video-extension).

Drafts, beat clip IDs, trims, mute/include choices, order, selected view, and latest export ID are saved per account in the browser workspace. Generation and export continue on the server when switching tabs or closing the page. Refreshing loads saved jobs and their private MP4s. Old whole-scene results stay available as earlier scene videos. Duplicate request IDs return the existing job. If a submission response is lost, use **Check status** before another attempt.

Track boundaries default to **Hard cut**. Choose **Fade** in a row or the selected-beat inspector and set its overlap length to opt in. The last included beat has no outgoing transition. Fades overlap adjacent footage and audio, reducing total sequence length; individual preview playback uses cuts, and chosen fades are rendered on final export. Changing transitions, trims, mute or inclusion does not regenerate clips.

Final export uses the server's `ffmpeg-static` binary (or `FFMPEG_BIN` override) to trim and join the selected clips, preserving unmuted source audio and supplying silence where needed. It generates an H.264/AAC MP4 at 24 fps, 1280×720 landscape or 720×1280 portrait. Export supports up to 32 included clips, 300 seconds, 512 MB combined source data and 200 MB output. No Gemini request is made during export. The deployment must include the encoder binary installed for its own OS/platform.

The server uses mdmedia's `GeminiOmniVideoProvider` with `gemini-omni-1.1-flash`; set `GEMINI_VIDEO_MODEL` to override it. Jobs live at `videos/{uid}/clips/{id}` in Firestore and MP4s at `videos/{uid}/{id}.mp4` in Storage. Authenticated API routes enforce allowlist membership and ownership for generation, continuation, export sources and playback. The Gemini key stays on the server. Pyric supplies local Firebase services; generation calls the real Gemini API, while export runs locally.

Generation has a ten-minute timeout and export has a five-minute deadline. A server restart can interrupt active work; after eleven idle minutes a stopped job becomes an error or a playable partial result. This slice keeps the latest source result for each beat and latest export; it does not yet offer take history, overlapping compositing, transitions beyond cuts/fades, or separate music/voice lanes.

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
