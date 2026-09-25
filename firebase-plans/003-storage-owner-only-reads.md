# 003 — Make narration audio in Storage owner-only; stop authorizing from stale metadata

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: HIGH
- **Outcome**: Authorization & identity
- **Evidence**: E4 (Rules Test API: signed-out read of an object whose metadata still says `public` → ALLOW) + E2 (Pyric campaign `probe-anon-read-unpublished-audio` → local-counterexample)
- **Estimated scope**: `studio/storage.modules.rules` (~6 lines), `studio/storage.rules` (regenerated), `narration-server.ts` (1 line), campaign cases
- **Depends on**: none
- **Ledger**: `.ledger/security-audit-hardening` items 09–12 (`storage-modules-owner-only-read`, `storage-artifact-owner-only-read`, `storage-metadata-no-visibility`, `campaign-storage-owner-only-probes`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: Firebase SDK (Storage Rules)
- **Production boundary**: Rules change takes effect only on a deploy the user runs. Hosted verification is authorized via the Firebase CLI login, read-only through the Rules Test API.
- **Rules source**: `studio/storage.modules.rules`
- **Generated artifact**: `studio/storage.rules`
- **Build command**: `npm --prefix studio run rules:build:storage` (`pyric storage rules resolve storage.modules.rules --out storage.rules`)
- **firebase.json target**: `storage.rules` (verified in `studio/firebase.json`)

## Problem

    // studio/storage.modules.rules:25-26 — current
    allow read: if isOwner(ownerUid)
      || resource.metadata.visibility == 'public';

The `visibility` metadata is written once, at synthesis time:

    // studio/src/lib/narration-server.ts:505 — current
    const objectMetadata = { metadata: { ownerUid: uid, visibility: request.visibility } };

Later visibility changes update only Firestore:

    // studio/src/lib/narrations.ts:193-197 — current
    void updateDoc(doc(db(), 'narrations', id), { visibility, sharedWith: recipients, updatedAt: Date.now() })

**Impact:** if an owner publishes a narration and later makes it private or shared, the audio stays readable by anyone, signed out included, at `narrations/{uid}/{id}.wav`. Anyone who saw the public version already knows that path.

Nothing in the app reads Storage directly from the client. `studio/src/lib/firebase.ts:31` exports `storage()`, but no module calls `getDownloadURL`, `getBytes` or `ref(storage…)`. All playback goes through `/api/narrations/[id]/audio|timings`, which authorize against the Firestore document. The public branch is dead weight that only creates exposure.

## Target behavior

Invariant: client Storage reads are owner-only. Public and shared playback is served by the server after it checks Firestore.

| Actor | Object metadata | Operation | Expected |
|---|---|---|---|
| alice (owner) | any | get `narrations/alice/a.wav` | ALLOW |
| signed out | `visibility: public` | get `narrations/alice/a.wav` | **DENY** |
| bob (signed in) | `visibility: public` | get `narrations/alice/a.wav` | **DENY** |
| alice | any | write `narrations/alice/a.wav` | DENY (unchanged) |

    // target — studio/storage.modules.rules
    match /narrations/{ownerUid}/{fileName} {
      // Owners may read their own objects directly. Every other reader —
      // shared recipients and the public — goes through the server routes,
      // which authorize against the Firestore document's CURRENT visibility.
      //
      // DELIBERATE: no metadata-based public branch. Object metadata is set
      // once at synthesis and is not rewritten when visibility changes, so
      // trusting it would keep un-published audio public.
      allow read: if isOwner(ownerUid);

      // DELIBERATE: no client writes at all. (unchanged comment + rule)
      allow write: if false;
    }

## Repo conventions to follow

- Keep the existing DELIBERATE-comment style in `studio/storage.modules.rules`.
- Imitate Storage cases in `studio/scripts/run-authorization-campaign.mjs` (`obs-anon-read-public-audio`) and `studio/test/assurance/cases.json`.

## Steps

1. Replace the `allow read` rule and its comment block in `studio/storage.modules.rules` as above.
2. At `studio/src/lib/narration-server.ts:505`, drop `visibility` from `objectMetadata` (keep `ownerUid`), so nothing can authorize from it again.
3. In `studio/scripts/run-authorization-campaign.mjs`, replace the `obs-anon-read-public-audio` control (it encodes the old policy). Use: control `obs-alice-read-public-audio` (`actor-alice` get `narrations/alice/narr-public.wav`, ALLOW); probe `probe-anon-read-public-audio` (`actor-anon`, same path, expected **DENY**); probe `probe-bob-read-public-audio` (`actor-bob`, same path, expected **DENY**).
4. Run `npm --prefix studio run rules:build:storage`. Commit only the resulting `storage.rules` diff.

## Boundaries

- Do not add a Cloud Function to sync metadata. The server-mediated design makes it unnecessary.
- Do not change Firestore Rules in this plan.
- Never point `firebase.json` at `storage.modules.rules`.
- Do not deploy.

## Verification

- **Build**: `npm --prefix studio run rules:build:storage`. Then `pyric storage rules resolve storage.modules.rules --out /tmp/s.rules && diff /tmp/s.rules studio/storage.rules` shows no drift.
- **Local behavior (E2)**: `node studio/scripts/run-authorization-campaign.mjs` reports the new anon and bob probes as `no-counterexample` and the alice control as ALLOW.
- **Hosted behavior (E4)**: add the same three Storage cases to `studio/scripts/verify-rules-hosted.mjs` (created in plan 006) and run it. Hosted must report ALLOW for alice and DENY for anon and bob.
- **Repository checks**: `bun test test/studio` passes.
- **Done when**: the hosted signed-out read of a `visibility: public` object returns DENY. Pyric does not support replaying captured sessions for Storage, so the campaign and hosted cases are the regression proof.
