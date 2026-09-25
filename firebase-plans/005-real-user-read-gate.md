# 005 — Require a real (allowlisted) user for every non-public read

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: MEDIUM
- **Outcome**: Authorization & identity
- **Evidence**: E4 (Rules Test API: non-allowlisted account reading a narration shared with it → ALLOW) + E2 (Pyric `probe-eve-nonallowlisted-read-shared` → local-counterexample)
- **Estimated scope**: `studio/firestore.modules.rules` (~8 lines), regenerated `studio/firestore.rules`, campaign cases
- **Depends on**: none (may be applied in the same change as 004)
- **Ledger**: `.ledger/security-audit-hardening` items 18–21 (`narration-read-requires-real-user`, `playlist-read-requires-real-user`, `firestore-artifact-real-user-gate`, `campaign-real-user-read-probes`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: Firebase SDK (Firestore Rules)
- **Production boundary**: User-run deploy only. Hosted verification is authorized through the Firebase CLI login.
- **Rules source**: `studio/firestore.modules.rules`
- **Generated artifact**: `studio/firestore.rules`
- **Build command**: `npm --prefix studio run rules:build:firestore`
- **firebase.json target**: `firestore.rules`

## Problem

    // studio/firestore.modules.rules — current
    function canReadNarration() {
      return isOwner(resource.data.ownerUid)
        || resource.data.visibility == 'public'
        || (resource.data.visibility == 'shared'
            && isAuthenticated()
            && request.auth.uid in resource.data.sharedWith);
    }

    match /playlists/{playlistId} {
      allow get, list: if isOwner(resource.data.ownerUid);

Any Firebase Auth account (including one refused by the allowlist, or one whose entry was later removed) can read narrations shared with it, including `sourceMarkdown` and `transcript`, straight from Firestore. A removed owner keeps reading their own narrations and playlists. The server routes already refuse these callers because `verifyIdToken` requires an allowlist entry (`studio/src/lib/firebase-admin.ts`). Rules and server disagree.

**Product decision (user, 2026-09-24):** only a real user of the app, meaning an allowlisted account, may read a narration shared with them. Anyone, signed in or not, may read a public narration.

## Target behavior

| Actor | Document | Operation | Expected |
|---|---|---|---|
| signed out | public narration | get / `list where visibility=='public'` | ALLOW |
| eve (signed in, not allowlisted) | public narration | get | ALLOW |
| bob (allowlisted, in `sharedWith`) | shared narration | get / `list where visibility=='shared' && sharedWith array-contains bob` | ALLOW |
| eve (not allowlisted, in `sharedWith`) | shared narration | get | **DENY** |
| alice (allowlisted owner) | own private | get / `list where ownerUid==alice` | ALLOW |
| alice after allowlist removal | own private | get | **DENY** |
| alice (allowlisted) | own playlist | get / `list where ownerUid==alice` | ALLOW |
| alice after allowlist removal | own playlist | get | **DENY** |

    // target — studio/firestore.modules.rules
    // Public narrations are readable by anyone. Every other read requires a real
    // user of the app (an allowlisted account): the owner, or a named recipient.
    // Mirrors the server gate in src/lib/firebase-admin.ts#verifyIdToken.
    function canReadNarration() {
      return resource.data.visibility == 'public'
        || (isAllowlisted()
            && (isOwner(resource.data.ownerUid)
                || (resource.data.visibility == 'shared'
                    && request.auth.uid in resource.data.sharedWith)));
    }

    match /playlists/{playlistId} {
      allow get, list: if isAllowlisted() && isOwner(resource.data.ownerUid);

Query compatibility: `isAllowlisted()` depends only on `request.auth` plus one `exists()`, never on `resource`. The three documented list shapes (mine, public, shared; comment at `firestore.modules.rules:45-52`) stay provable. Cost: one extra document read per rule evaluation for signed-in non-public reads. For a list query, Firestore evaluates `exists()` once per query, not once per document.

## Repo conventions to follow

- Keep `isAllowlisted()` / `hasVerifiedEmail()` as defined (`firestore.modules.rules:88-99`).
- Campaign conventions: `studio/scripts/run-authorization-campaign.mjs` (actors alice/bob allowlisted, eve not).

## Steps

1. Replace `canReadNarration()` and the playlist `allow get, list` line as above. Update the narration read comment block to name the allowlist requirement.
2. Campaign additions. Control `obs-eve-get-public` (eve get public, ALLOW). Probe: eve get `narrations/narr-shared` with `sharedWith: ['bob','eve']`, expected **DENY**. Control: bob get the same doc, ALLOW. Probe: an actor whose uid is the owner but whose email is not allowlisted (add `actor-alice-removed` with a new auth user `alice2@example.com`, owner of `narrations/narr-alice2`, no allowlist doc) get own doc, expected **DENY**.
3. Run `npm --prefix studio run rules:build:firestore`.

## Boundaries

- Do not change write rules here (004).
- Do not make public narrations require sign-in. The user explicitly chose "anyone if public".
- Do not deploy.

## Verification

- **Build**: resolve and diff shows no drift (same commands as 004).
- **Local behavior (E2)**: campaign: new DENY probes `no-counterexample`, controls ALLOW. Also use `firestore_simulate_rules` (or the campaign) for the three list shapes as alice, bob and signed-out, each ALLOW with the documented constraints. An unconstrained `list narrations` as bob must be DENY.
- **Hosted behavior (E4)**: run every matrix row through `studio/scripts/verify-rules-hosted.mjs` (plan 006). All must match, and the eve-shared row must now be DENY.
- **Journey regression**: `pyric verify studio/test/fixtures/allowlist-journey.session.json` passes.
- **Done when**: the hosted DENY for non-allowlisted shared reads and the hosted ALLOW for signed-out public reads both hold.
