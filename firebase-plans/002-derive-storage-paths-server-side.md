# 002 — Derive Storage object paths on the server instead of trusting the document

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: HIGH
- **Outcome**: Authorization & identity
- **Evidence**: E4 (Rules Test API: owner rewriting `audioPath` into another user's namespace → ALLOW) + E2 (Pyric campaign `probe-bob-repoint-audioPath-to-alice` → local-counterexample) + E0 (server trace)
- **Estimated scope**: two route files (~2 lines each), `narration-server.ts` (~4 lines), one test
- **Depends on**: none. Plan 004 closes the Rules half independently; ship both.
- **Ledger**: `.ledger/security-audit-hardening` items 06–08 (`audio-route-derived-path`, `timings-route-derived-path`, `storage-path-derivation-test`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: Firebase Admin SDK (server routes)
- **Production boundary**: Server code only.
- **Rules source**: n/a (the Rules half is in plan 004)
- **Generated artifact**: n/a
- **Build command**: n/a
- **firebase.json target**: n/a

## Problem

The audio and timings routes read whatever Storage path the Firestore document names, using Admin credentials that bypass Storage Rules:

    // studio/src/app/api/narrations/[id]/audio/route.ts:26 — current
    const objectPath = narration.audioPath || audioObjectPath(narration.ownerUid, id);

    // studio/src/app/api/narrations/[id]/timings/route.ts:28 — current
    const objectPath = narration.timingsPath || timingsObjectPath(narration.ownerUid, id);

The owner can rewrite `audioPath` and `timingsPath` from the client, because `validNarrationFields()` (`studio/firestore.modules.rules`) doesn't constrain them. Hosted evidence (Rules Test API, project `mdmedia-dev`, generated `firestore.rules`):

    update narrations/bob-own as bob {audioPath: "narrations/alice/alice-private.wav"}  → hosted ALLOW (Pyric ALLOW)

**Impact:** an allowlisted user points their own narration at another user's private audio or timings path, then calls `GET /api/narrations/<own id>/audio?raw=1`. The server downloads the victim's object. The attacker needs the victim's uid and narration id; both appear on any narration that was ever public or shared with them.

## Target behavior

Invariant: the server only reads `narrations/{narration.ownerUid}/{id}.wav` and `…/{id}.timings.json` for the narration it authorized. Document fields never choose the object.

    // target — audio/route.ts:26
    const objectPath = audioObjectPath(narration.ownerUid, id);

    // target — timings/route.ts:28
    const objectPath = timingsObjectPath(narration.ownerUid, id);

| Actor | Setup | Request | Expected |
|---|---|---|---|
| alice | own ready narration `a1` | GET `/api/narrations/a1/audio?raw=1` | 200, her audio |
| bob | own narration `b1` with `audioPath` forged to `narrations/alice/a1.wav` | GET `/api/narrations/b1/audio?raw=1` | 404 (reads `narrations/bob/b1.wav`, which does not exist) |

`audioPath`/`timingsPath` stay on the document for display and backward compatibility, but nothing trusts them for access.

## Repo conventions to follow

- Reuse `audioObjectPath` / `timingsObjectPath` (`studio/src/lib/narration-server.ts:70-76`). They are already the write-side source of truth (`:503-504`).

## Steps

1. Edit the two route lines exactly as above. Remove the now-unused `narration.audioPath` / `narration.timingsPath` reads.
2. Grep `studio/src` for other reads of `.audioPath` / `.timingsPath` that feed `adminBucket()`. Apply the same derivation to any you find, and report them.
3. Add `test/studio/storage-path-derivation.test.ts`. It asserts both routes build `objectPath` only from `audioObjectPath(`/`timingsObjectPath(` and contain no `narration.audioPath ||` or `narration.timingsPath ||`.

## Boundaries

- Do not change Rules here (plan 004).
- Do not rename Storage objects or migrate data; the derived paths already match what the server writes.

## Verification

- **Repository checks**: `bun test test/studio/storage-path-derivation.test.ts test/studio/offline-audio-integration.test.ts` and `npx --prefix studio tsc --noEmit -p studio` pass.
- **Local behavior (E2)**: in the Pyric-hosted sandbox, as bob, update `narrations/b1.audioPath` to `narrations/alice/a1.wav` (allowed until plan 004 lands). `GET /api/narrations/b1/audio?raw=1` must return 404, not Alice's bytes.
- **Done when**: the forged-path request returns 404 and the tests pass.
