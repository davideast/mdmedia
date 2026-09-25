# 006 — Resolve allowlist bootstrapping for production and for regression replay

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: MEDIUM
- **Outcome**: Production readiness & regression safety
- **Evidence**: E3 (`pyric verify .pyric/last-session.json` → 3 state-drift failures) + E1 (Pyric replay source: empty initial state, admin writes replayed) + E4 (the hosted harness needed hand-written `exists()` mocks that Pyric's derived cases lack)
- **Estimated scope**: README section, one committed fixture, `studio/scripts/verify-rules-hosted.mjs`, two npm scripts, `studio/PYRIC.md` entries
- **Depends on**: none. Execute first: 003, 004 and 005 use its fixture and hosted harness for verification.
- **Ledger**: `.ledger/security-audit-hardening` items 22–26 (`allowlist-bootstrap-runbook`, `replayable-allowlist-fixture`, `rules-verify-scripts`, `hosted-rules-parity-harness`, `pyric-upstream-gap-reports`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: CLI launcher (`pyric sandbox --hosted`), `pyric verify`, Firebase CLI login
- **Production boundary**: The production bootstrap is a trusted operator action through the Admin/REST path (`studio/scripts/allowlist.mjs`). Nothing in this plan deploys or changes production Rules. Recording a fresh capture archives the local hosted DB; this is recoverable but needs the user's go-ahead.
- **Rules source**: n/a
- **Generated artifact**: n/a
- **Build command**: n/a
- **firebase.json target**: n/a

## Problem

"Bootstrapping" is two separate problems. Only the second one is actually broken.

### A. Production: who allowlists the first user? (working as designed; undocumented)

Clients can never write `allowlist/*` (`allow list, write: if false`). The allowlist therefore cannot bootstrap itself, which is the point. The root of trust is **Google Cloud IAM on `mdmedia-dev`**, not the allowlist. A project member with Firestore write permission runs `bun run studio:allowlist add <email>` (`studio/scripts/allowlist.mjs`). That call uses the Firebase CLI login, falling back to Admin SDK/ADC, and IAM-authorized requests bypass Security Rules. This is how the two current production entries were created. The process isn't written down anywhere, so the next operator has to rediscover it.

### B. Regression replay: pre-existing state is invisible to `pyric verify` (broken)

    $ npx --prefix studio pyric verify .pyric/last-session.json --engine sandbox
    ✗ last-session - firestore: 3 failure(s)
      state-drift: allowlist/dceast@gmail.com: {…} -> undefined
      state-drift: allowlist/deast@google.com: {…} -> undefined
      state-drift: users/<uid>: {…} -> undefined

Root cause, from the installed Pyric source:

    // node_modules/@pyric/cli/dist/verify/index.js:72
    const { divergences } = replayFirestore(fixture.events, rules, {}, firestore.state.documents);
    // node_modules/pyric/dist/sandbox/replay/index.js:68-79
    const sandbox = initializeSandbox();          // always EMPTY
    const writes = events.filter((e) => e.kind === 'write');
    for (const wEv of writes) { const bypassRules = isAdminWrite(wEv); … }   // admin writes ARE replayed

- Replay always starts from an empty database. The fixture format (`pyric.verify.fixture.v1`) has only the **final** `state.documents` and no initial snapshot.
- The allowlist docs were written straight into the hosted SQLite while the server was stopped, so no capture recorded them. On replay, `exists(/allowlist/…)` is false, the allowlisted user's `users/{uid}` create is denied, and final state diverges.
- **Admin writes made *during* a capture are replayed**, with Rules bypassed. That is the fix: record the bootstrap as the first event of the session.
- `--seed FILE` loads state "before application code runs". Nothing shows it being emitted as capture events, so assume it is **not** replayable until proven otherwise (see step B-6).

### C. Hosted parity gaps found during the audit (Pyric upstream)

1. `pyric verify cases` produces no `functionMocks` for `exists()`/`get()`. Every allowlist-gated case is therefore wrong on the Rules Test API unless someone mocks it by hand.
2. `--engine rules-test-api|both` accepts only service-account keys (`fromServiceAccount: input is missing required fields`), not the Firebase CLI or gcloud user login.
3. `pyric firestore rules validate` reports 12 SEM-4 "undefined function" errors on the resolver's own output (top-level Standard Library functions). The hosted Rules Test API compiled the same file with no issues, so these are false positives.
4. The captured fixture contains real account emails. A committed regression fixture must use synthetic identities.

## Target behavior

1. **Production:** a documented, repeatable operator bootstrap. IAM gates the allowlist; the allowlist gates the app.
2. **Regression:** a committed fixture, `studio/test/fixtures/allowlist-journey.session.json`, whose first events are admin writes of the allowlist. `pyric verify` on it passes with 0 divergences, from an empty start and with no out-of-band seed.
3. **Hosted:** `npm --prefix studio run rules:verify:hosted` runs a hand-authored, mock-aware case suite through the Rules Test API using the Firebase CLI login, and exits non-zero on any mismatch.

## Repo conventions to follow

- Upstream Pyric bugs are catalogued in `studio/PYRIC.md` §3 ("Upstream Pyric bugs found"). Add C1–C3 there, numbered after the last entry.
- Operator scripts follow `studio/scripts/allowlist.mjs` (Firebase CLI login first, ADC fallback, `--project` defaulting to `studio/.firebaserc`).
- The hosted harness starts from the audit scratch script `~/.gemini/jetski/brain/8ac18ddc-8dab-465f-a1e2-dc5c8a53b3c7/scratch/rules-test-api.mjs` (12 cases, all matching Pyric). It may only call `firebaserules.googleapis.com/v1/projects/{id}:test`, which is read-only.

## Steps

### A — Production bootstrap runbook
1. Add an `## Allowlist bootstrap` section to `studio/README.md` with these points:
   - The root of trust is IAM (`roles/datastore.user` or higher on the project).
   - The first operator runs `firebase login`, then `bun run studio:allowlist add <email>`.
   - Verify with `bun run studio:allowlist check <email>`.
   - Revoke with `bun run studio:allowlist remove <email> --revoke-tokens`.
   - Clients can never write the allowlist, by design.
   - The local equivalent adds `--local` (targets the live Pyric sandbox when it is running).

### B — Replayable regression fixture
2. **User decision gate:** recording from empty archives the current local hosted DB. `--fresh` archives it; it does not delete. Get approval first.
3. `npm --prefix studio run dev:stop`, then start a fresh capture: `npx --prefix studio pyric sandbox --hosted --fresh -- next dev --port 3000` (from `studio/`).
4. First action, while the sandbox is running: `bun run studio:allowlist add alice@example.test bob@example.test --local`. This goes through the live sandbox's admin path and must be captured as `write` events with `detail.admin: true`.
5. Journey. In the Pyric Google picker, sign in as **alice@example.test**: profile is created; create a narration; rename it; set visibility to shared with bob; sign out. Sign in as **bob@example.test**: open the shared narration; sign out. Sign in as **mallory@example.test** (not allowlisted): access denied; client signs out.
6. Stop the server. Confirm the bootstrap was captured:
   `node -e 'const s=require("./studio/.pyric/last-session.json");console.log(s.events.filter(e=>e.kind==="write"&&e.detail?.admin&&e.path.startsWith("allowlist/")).length)'` must print `2`.
   If it prints `0`, stop and report: admin writes over the live bridge are not captured in this Pyric version. Fallback: generate the fixture with `pyric-admin` writes inside `pyric sandbox -- node <script>`.
7. Copy it: `cp studio/.pyric/last-session.json studio/test/fixtures/allowlist-journey.session.json`. Confirm it contains only `@example.test` identities: `grep -c "@gmail\|@google\|@live" …` must print `0`.
8. Add npm scripts in `studio/package.json`:
   - `"rules:verify": "pyric verify test/fixtures/allowlist-journey.session.json --rules firestore=firestore.rules"`
   - `"rules:verify:hosted": "node scripts/verify-rules-hosted.mjs"`
9. Restore the local dev DB if the user wants it back from the archive `--fresh` created, then `npm --prefix studio run dev:bg`.

### C — Hosted harness and upstream reports
10. Create `studio/scripts/verify-rules-hosted.mjs` from the scratch harness:
    - Read the project from `studio/.firebaserc`.
    - Read `firestore.rules` and `storage.rules` from `studio/`.
    - Get the OAuth token by refreshing the Firebase CLI login. Never write credentials to disk or print them.
    - Print a `pyric=/hosted=/secure=` table.
    - `process.exit(1)` on any row where hosted ≠ expected.
    - Keep the 12 existing cases; plans 003/004/005 append their matrices.
11. Add C1–C4 to `studio/PYRIC.md` §3 under these exact headings (the ledger oracle matches them): "Replay has no initial-state fixture", "Derived Rules Test API cases omit exists()/get() functionMocks", "Hosted verify accepts only service-account credentials", "SEM-4 false positives on resolved Standard Library functions". Include each gap's exact reproduction command and output quoted in this plan.

## Boundaries

- Do not deploy, and do not write production data. `rules:verify:hosted` calls only `projects.test`.
- Do not create service-account keys to satisfy `--engine rules-test-api`. That is exactly what C2 reports upstream.
- Do not commit fixtures that contain real emails, uids of real accounts, or tokens.
- Do not patch Pyric's replay in `node_modules`. The fixture approach works on the installed version.

## Verification

- **Journey regression (E3)**: `npm --prefix studio run rules:verify` → `✓` with 0 divergences.
- **Negative control**: copy `firestore.modules.rules` to `/tmp`, remove `&& isAllowlisted()` from `users/{uid}` `create, update`, resolve to `/tmp/f.rules`, then run `npx --prefix studio pyric verify studio/test/fixtures/allowlist-journey.session.json --rules firestore=/tmp/f.rules`. It still passes, because replay only re-issues writes that succeeded in the capture. That is the expected limit: journey replay proves **ALLOW preservation**. Record in `studio/README.md` that **DENY coverage** lives in `studio/scripts/run-authorization-campaign.mjs` and `rules:verify:hosted`.
- **Hosted behavior (E4)**: `npm --prefix studio run rules:verify:hosted` → 12/12 match, exit 0.
- **Repository checks**: `bun test test/studio` passes.
- **Done when**:
  - `rules:verify` passes from an empty start.
  - The README bootstrap runbook exists.
  - `rules:verify:hosted` passes.
  - PYRIC.md lists C1–C4.
  - Unsupported Pyric surfaces are named in the README: no initial-state fixtures, no hosted mocks, service-account-only hosted auth, and no Storage session replay.
