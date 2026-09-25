# 004 — Restrict client narration writes to the fields the UI actually edits

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: MEDIUM (raises #2 to exploitable when combined; ship with 002)
- **Outcome**: Data integrity & model fit
- **Evidence**: E4 (Rules Test API: owner forging `status`/`durationMs` plus an unknown key → ALLOW; owner rewriting `audioPath` → ALLOW) + E2 (Pyric `probe-bob-forge-status-and-extra-key`, `probe-bob-repoint-audioPath-to-alice` → local-counterexample)
- **Estimated scope**: `studio/firestore.modules.rules` (~10 lines), regenerated `studio/firestore.rules`, campaign cases
- **Depends on**: none (pairs with 002)
- **Ledger**: `.ledger/security-audit-hardening` items 13–17 (`narration-client-create-denied`, `narration-update-affected-keys`, `remove-dead-required-narration-fields`, `firestore-artifact-field-allowlist`, `campaign-narration-field-probes`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: Firebase SDK (Firestore Rules)
- **Production boundary**: Takes effect only on a user-run deploy. Hosted verification is authorized through the Firebase CLI login (Rules Test API, read-only).
- **Rules source**: `studio/firestore.modules.rules`
- **Generated artifact**: `studio/firestore.rules`
- **Build command**: `npm --prefix studio run rules:build:firestore`
- **firebase.json target**: `firestore.rules` (verified in `studio/firebase.json`)

## Problem

    // studio/firestore.modules.rules:55-65 — current
    allow create: if isAllowlisted()
      && isOwner(request.resource.data.ownerUid)
      && hasRequiredNarrationFields()
      && validNarrationFields();

    allow update: if isAllowlisted()
      && isOwner(resource.data.ownerUid)
      && immutableFields(['ownerUid', 'createdAt'])
      && validNarrationFields();

- `update` accepts any keys. The owner can set server-owned fields (`status`, `durationMs`, `transcript`, `audioPath`, `timingsPath`, `errorMessage`, `authorName`, …) and add unknown keys.
- `create` lets a client write a whole narration, including `status: 'ready'` and a forged `audioPath`. The app never creates narrations from the client. Creation is server-only, via Admin at `narration-server.ts:359`. The only client `setDoc` calls are in `lib/playlists.ts:96` and `lib/users.ts:138`.
- The only client narration updates are `updateVisibility` (`visibility`, `sharedWith`, `updatedAt`) and `updateNarrationTitle` (`title`, `updatedAt`) in `studio/src/lib/narrations.ts:187-210`.

**Impact:** clients can forge generation state, which passes the routes' `status === 'ready'` check, and can pick Storage paths (see 002). The document shape can also drift from what readers assume.

## Target behavior

| Actor | Operation | Payload | Expected |
|---|---|---|---|
| bob (owner, allowlisted) | update `narrations/bob-own` | `{title: 'Renamed', updatedAt: 2}` | ALLOW |
| bob | update | `{visibility: 'shared', sharedWith: ['alice'], updatedAt: 2}` | ALLOW |
| bob | update | `{status: 'ready', durationMs: 999999, updatedAt: 2}` | **DENY** |
| bob | update | `{audioPath: 'narrations/alice/a.wav', updatedAt: 2}` | **DENY** |
| bob | update | `{featured: true, updatedAt: 2}` | **DENY** |
| bob | create `narrations/new-1` | full valid narration | **DENY** (server-only) |
| alice | update `narrations/bob-own` | `{title: 'x', updatedAt: 2}` | DENY (unchanged) |

    // target — studio/firestore.modules.rules, /narrations/{narrationId}
    // DELIBERATE: narrations are created only by the synthesis route with the
    // Admin SDK (which bypasses Rules). No client create path exists, so a
    // client-authored narration — with forged status or Storage paths — is refused.
    allow create: if false;

    // Owners may edit only what the UI edits: the title and who can reach it.
    // Everything else (status, transcript, durations, Storage paths, author
    // snapshot) is server-owned and written with the Admin SDK.
    allow update: if isAllowlisted()
      && isOwner(resource.data.ownerUid)
      && request.resource.data.diff(resource.data).affectedKeys()
           .hasOnly(['title', 'visibility', 'sharedWith', 'updatedAt'])
      && validNarrationFields();

`immutableFields(['ownerUid','createdAt'])` becomes redundant under `hasOnly`. You may keep it for defense in depth. If you drop it, remove the now-unused `immutableFields` import only if playlists no longer use it; they do, so keep the import. `hasRequiredNarrationFields()` becomes unused after `create: false`. Delete the function.

## Repo conventions to follow

- Standard Library imports only; do not copy helper bodies (header comment, `firestore.modules.rules:9-18`).
- Campaign style: `studio/scripts/run-authorization-campaign.mjs` (observations → invariants → propose).

## Steps

1. Edit `/narrations/{narrationId}` in `studio/firestore.modules.rules` as above. Delete `hasRequiredNarrationFields()`.
2. Add campaign coverage in `studio/scripts/run-authorization-campaign.mjs`. Control `obs-bob-update-own-title` (ALLOW). Payload probes `probe-bob-forge-status`, `probe-bob-repoint-audio-path` and `probe-bob-unknown-key`, all expected **DENY**. Operation probe `probe-bob-client-create-narration`, expected **DENY**.
3. Run `npm --prefix studio run rules:build:firestore`.
4. Update source-contract assertions in `test/studio/allowlist-auth-gate.test.ts` that reference `hasRequiredNarrationFields` or narration `create` so they reflect `create: if false`.

## Boundaries

- Do not touch playlist or user rules here (plan 005 covers read gating).
- Do not change client write helpers. They already send only the allowed keys.
- Keep `validNarrationFields()` (it bounds `sharedWith` ≤ 50 and validates `title`/`visibility`).

## Verification

- **Build**: `npm --prefix studio run rules:build:firestore`. Then `pyric firestore rules resolve firestore.modules.rules --out /tmp/f.rules && diff /tmp/f.rules studio/firestore.rules` shows no drift.
- **Static**: `pyric firestore rules validate studio/firestore.rules` reports no new diagnostics beyond the known SEM-4 false positives (recorded in plan 006).
- **Local behavior (E2)**: `node studio/scripts/run-authorization-campaign.mjs`: all new DENY probes `no-counterexample`, controls ALLOW.
- **Hosted behavior (E4)**: run `studio/scripts/verify-rules-hosted.mjs` (plan 006) with the matrix rows above. All match.
- **Journey regression**: `npx --prefix studio pyric verify studio/test/fixtures/allowlist-journey.session.json` (plan 006) passes. Rename and share flows must still ALLOW.
- **Repository checks**: `bun test test/studio` and `npx --prefix studio tsc --noEmit -p studio`.
- **Done when**: hosted DENY for the forged-status, forged-path, unknown-key and client-create rows, and hosted ALLOW for the title and visibility rows.
