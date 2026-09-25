This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

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
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --set-env-vars ALLOWED_WEB_ORIGINS=https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com \
  --no-cpu-throttling \
  --timeout 900 \
  --max-instances 5 \
  --allow-unauthenticated

# 5. Deploy Firebase Hosting rewrite
firebase deploy --only hosting
```

