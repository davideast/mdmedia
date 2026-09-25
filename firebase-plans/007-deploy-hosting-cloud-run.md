# 007 — Deploy to Firebase Hosting + Cloud Run for allowlisted accounts only

- **Status**: TODO
- **Commit**: ac7cd3c (+ uncommitted security-audit-hardening work)
- **Severity**: HIGH (first production deploy)
- **Outcome**: Allowlisted accounts can use the deployed app. Nobody else can reach private data or spend Gemini quota.
- **Estimated scope**: new `Dockerfile` + `.dockerignore` (repo root), `studio/package.json`, `studio/firebase.json`, `studio/scripts/deploy-preflight.mjs`, `studio/README.md`
- **Depends on**: 001–006 (the hardened rules and routes)
- **Ledger**: `.ledger/deploy-cloud-run` items 01–21. Run `bun scripts/ledger.ts --dir=.ledger/deploy-cloud-run`
- **Production boundary**: Nothing in this plan deploys automatically. Every `gcloud`/`firebase deploy` command is run by the user.

## Architecture

| Piece | Role | Who can use it |
|---|---|---|
| Firebase Hosting | Public entry point; rewrites every request to Cloud Run | Anyone (serves no data by itself) |
| Cloud Run (`studio`) | Next.js app and API routes, Gemini TTS, all server-controlled writes | API: allowlisted users only (`verifyIdToken`); public narrations' audio for anyone |
| Firestore | Data | Allowlisted users only (Security Rules) |
| Storage | Audio and timings | Owner only; everyone else goes through Cloud Run |
| Gemini | Called only from Cloud Run with `GEMINI_API_KEY` from Secret Manager | Never reachable from the browser |
| Firebase AI Logic | **Not used.** Leave it disabled in the console | — |

AI Logic was dropped because it cannot check the allowlist. App Check proves a request came from your app, not from an allowlisted user. The only client use, `assistModel`, had no callers and has been removed (item 01).

## Blockers found

1. **Local tarball dependencies.**
   - `studio/package.json` installs `mdmedia` from `file:../mdmedia-0.1.0.tgz`. That file is gitignored (`.gitignore: *.tgz`), missing from the repo, and outside `studio/`.
   - The Pyric devDependencies point at `studio/.pyric-local/*.tgz`, which is also gitignored.
   - A clean build therefore cannot run `npm install`.
2. **Firebase Hosting's 60-second limit on requests rewritten to Cloud Run.** `POST /api/narrations` streams for up to `maxDuration = 300` s.
   - Through Hosting, the stream is cut at 60 s.
   - `run()` keeps going after a disconnect, and the client already falls back to watching Firestore. That fallback only works if Cloud Run keeps CPU allocated after the response ends (`--no-cpu-throttling`).
   - Verify the limit in the Hosting docs before relying on it.
3. **Sharing is broken, but fails closed.** The share box saves emails, while the rules and server check uids. No data is exposed; sharing just doesn't work. Fixed by steps D (D1).

## Decisions (resolved)

- **D1 — sharing: the app stores uids** (user choice: app, not rules). The rules keep `request.auth.uid in sharedWith`. The client resolves each recipient's email to a uid through a server route that checks the allowlist, then writes the uid.
- **D2 — long synthesis: call Cloud Run directly for `POST /api/narrations`**, plus `--no-cpu-throttling` and a sweep for stuck narrations. Cloud Tasks is deferred until interrupted narrations actually happen.
- **D3 — block sign-up and sign-in for accounts not on the allowlist: yes.** Identity Platform blocking functions `beforeUserCreated` and `beforeUserSignedIn`.

## Steps

### A — Client has no AI endpoint
1. Remove `firebase/ai` and `assistModel` from `studio/src/lib/firebase.ts`. **Done.**
2. Firebase console → AI Logic: leave it disabled, or disable it if it was ever enabled.

### B — Hermetic build
3. `studio/package.json`:
   - Add `"vendor:mdmedia": "npm --prefix .. run build && npm --prefix .. pack --pack-destination studio/vendor"`.
   - Point `mdmedia` at `file:./vendor/mdmedia-0.1.0.tgz`.
   - Add `studio/vendor/` to `.gitignore`. It is a build output.
4. Repo-root `Dockerfile`, multi-stage:
   - **build-mdmedia:** `npm ci` at the root, `npm run build`, then `npm pack` into `studio/vendor/`.
   - **build-studio:** copy `studio/` and the vendored tarball. Run `npm pkg delete devDependencies.@pyric/cli devDependencies.pyric devDependencies.pyric-admin devDependencies.create-pyric` and remove the `postinstall` script. Then `npm install`, then `next build`. `NEXT_PUBLIC_FIREBASE_*` come in as `ARG`s; they are public web config.
   - **runtime:** `node:22-slim`, the production `node_modules` and `.next`, and `CMD ["npx", "next", "start", "-p", "8080"]`.
   - The Dockerfile must never reference `GOOGLE_APPLICATION_CREDENTIALS`, `PYRIC_SANDBOX`, `NEXT_PUBLIC_PYRIC_GEMINI_API_KEY` or `.env` files.
5. `.dockerignore`: `**/node_modules`, `**/.env*`, `studio/.pyric`, `studio/.pyric-local`, `**/*service-account*.json`, `**/.next`, `dist`.
6. `studio/scripts/deploy-preflight.mjs`, wired as `"deploy:preflight"`. It exits 1 if any of these fail:
   - `NEXT_PUBLIC_PYRIC_GEMINI_API_KEY` is set.
   - `firebase/ai` appears anywhere in `studio/src`.
   - Re-resolving `firestore.modules.rules` and `storage.modules.rules` does not byte-match the committed `firestore.rules` and `storage.rules`.
   - `rules:verify` or `rules:verify:hosted` fails.

### C — Runtime identity and secrets (runbook)
7. Create a dedicated service account `studio-run@<project>.iam.gserviceaccount.com` with:
   - `roles/datastore.user` (Firestore reads/writes and the allowlist lookup).
   - `roles/storage.objectAdmin`, bound to the bucket only.
   - `roles/secretmanager.secretAccessor`, on `GEMINI_API_KEY` only.
   - `roles/firebaseauth.viewer`, for `verifyIdToken(..., checkRevoked)`.
   - `roles/iam.serviceAccountTokenCreator` on itself, only if the non-raw signed-URL branch of the audio and timings routes is kept. The client uses `?raw=1` only.
8. `gcloud secrets create GEMINI_API_KEY`, then add a version from the key.
9. Deploy the service:

   ```
   gcloud run deploy studio --source . --region <region> \
     --service-account studio-run@… \
     --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest \
     --set-env-vars FIREBASE_PROJECT_ID=…,FIREBASE_STORAGE_BUCKET=… \
     --no-cpu-throttling --timeout 900 --max-instances 3 --allow-unauthenticated
   ```

   `--allow-unauthenticated` is required because browsers call the service directly. The allowlist check inside the app is the access control. `--max-instances` caps cost.
10. `studio/firebase.json`: add `"hosting": { "public": "public", "rewrites": [{ "source": "**", "run": { "serviceId": "studio", "region": "<region>" } }] }`.
11. Deploy order:
    1. `npm --prefix studio run deploy:preflight`
    2. `firebase deploy --only firestore:rules,storage`
    3. `gcloud run deploy …`
    4. `firebase deploy --only hosting`

    Rules go first: the previous rules were more permissive, and the new app works under the new rules.
12. Bootstrap the allowlist in production with `firebase login` and `bun run studio:allowlist add <you>` (the runbook already exists).
13. Firebase Auth → Settings → Authorized domains: add the Hosting domain.

### D — Sharing stores uids (D1)
14. `POST /api/users/resolve` takes `{ email }`.
    - `verifyIdToken` must pass, so the caller is allowlisted.
    - Normalize the email.
    - Return 404 unless `allowlist/{email}` exists **and** `adminAuth().getUserByEmail(email)` finds a user with `emailVerified`.
    - Otherwise return `{ uid, email }`.
    - The route never reveals whether an Auth account exists for an email that isn't on the allowlist.
15. `narration-settings.tsx` `addInvitee`:
    - Resolve the email first. This needs the network; show an inline error on 404.
    - Then call `updateVisibility(id, "shared", [...sharedWith, uid], { ...sharedWithLabels, [uid]: email })` as an optimistic write, following the CQRS rule for the write itself.
    - The list renders `sharedWithLabels[uid] ?? uid`.
16. `narrations.ts`: `updateVisibility` writes `sharedWithLabels` together with `sharedWith`, and clears both when visibility isn't `shared`. `toNarration` reads the new field.
17. `firestore.modules.rules`:
    - Add `sharedWithLabels` to the update `affectedKeys().hasOnly([...])`.
    - Validate it with `request.resource.data.get('sharedWithLabels', {}) is map && request.resource.data.get('sharedWithLabels', {}).size() <= 50`.
    - Rebuild `firestore.rules`.
    - Add a hosted case: Bob reads a narration shared **by uid** → ALLOW.
    - Fix the campaign or hosted cases that assumed email entries, if any.
18. No migration: nothing is deployed, and `ZERO_BACKWARDS_COMPATIBILITY` applies.

### E — Long synthesis bypasses Hosting (D2)
19. Add a public env var, `NEXT_PUBLIC_API_ORIGIN` (the Cloud Run `run.app` URL or a custom domain). `use-narration-stream.ts` posts to `${NEXT_PUBLIC_API_ORIGIN ?? ""}/api/narrations`. Every other call stays same-origin.
20. `api/narrations/route.ts`:
    - Answer `OPTIONS`.
    - Set `Access-Control-Allow-Origin` only when the request `Origin` matches `ALLOWED_WEB_ORIGINS`, a server env var listing the Hosting domains. Never use `*`.
    - Allow the `Authorization` and `Content-Type` headers.
21. Stuck narrations: when a narration is loaded (in `loadReadableNarration` callers or a small scheduled sweep), mark `status: "streaming"` older than 15 minutes (by `updatedAt`) as `status: "error"` with `errorCode: "interrupted"`, so the UI offers a retry.

### F — Block accounts not on the allowlist at sign-in (D3)
22. Upgrade the project to Firebase Authentication with Identity Platform (console). This is required for blocking functions.
23. New `functions/` codebase (TypeScript, `firebase-functions` v2 identity triggers):
    - `beforeUserCreated` and `beforeUserSignedIn` both call one `assertAllowlisted(event)`.
    - It lower-cases `event.data.email`, requires `emailVerified`, and checks that `allowlist/{email}` exists.
    - Otherwise it throws `HttpsError('permission-denied', ...)`.
24. `studio/firebase.json`: add a `functions` entry for the codebase. `firebase deploy --only functions`, then register both functions under Authentication → Settings → Blocking functions.
25. Blocking functions run only on sign-up and sign-in, not on token refresh. Revocation still relies on `studio:allowlist remove <email> --revoke-tokens` plus the existing rules and server checks.
26. Updated deploy order:
    1. preflight
    2. rules
    3. functions (then register the blocking triggers)
    4. Cloud Run
    5. Hosting

## Boundaries

- **No service-account keys.** Don't create JSON keys. Cloud Run uses its attached service account through ADC (`firebase-admin.ts` already falls back to `applicationDefault()`).
- **No Gemini key in the client.** Never put a Gemini key in any `NEXT_PUBLIC_*` variable.
- **No Pyric in production.** Don't ship Pyric in the production image. `@pyric/cli/register` must not be in `NODE_OPTIONS` at runtime.

## Verification

- **Ledger:** `bun scripts/ledger.ts --dir=.ledger/deploy-cloud-run` → 21/21.
- **Preflight:** `npm --prefix studio run deploy:preflight` → exit 0. Negative check: exporting `NEXT_PUBLIC_PYRIC_GEMINI_API_KEY=x` makes it exit 1.
- **Clean build:** `docker build .` from a fresh `git clone` (no `.pyric-local`, no tarballs) succeeds.
- **Deployed smoke tests** (run by the user):
  - A non-allowlisted Google account signs in → allowlist rejection. `POST /api/narrations` with its token → 401.
  - A signed-out `curl` of a private narration's `/audio?raw=1` → 401. A public one → 200.
  - An allowlisted account creates a narration of more than 60 s. It reaches `ready` even though the Hosting stream is cut.
  - The Cloud Run logs show no Pyric register banner.
  - Alice shares with bob's email → the entry shows the email, and Bob can open and play the narration. Sharing with an address that isn't on the allowlist → inline error, and nothing is written.
  - A narration longer than 60 s streams live to the end, with no fallback to checkpoints.
  - A Google account that isn't on the allowlist is refused **by the blocking function**: no Auth user is created (check the console Users list).
- **Repository checks:** `bun test`, `npx --prefix studio tsc --noEmit -p studio`.
