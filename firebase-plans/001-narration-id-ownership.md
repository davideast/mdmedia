# 001 — Refuse client-supplied narration ids that belong to another user

- **Status**: TODO
- **Commit**: ac7cd3c
- **Severity**: HIGH
- **Outcome**: Authorization & identity
- **Evidence**: E0 (source trace; Admin SDK writes bypass Rules, so no Rules engine can observe this path)
- **Estimated scope**: `studio/src/lib/narration-server.ts` (~30 lines), `studio/src/app/api/narrations/route.ts` (~10 lines), one new test file
- **Depends on**: none
- **Ledger**: `.ledger/security-audit-hardening` items 01–05 (`claim-narration-id-helper`, `route-rejects-foreign-narration-id`, `transactional-initial-narration-write`, `active-stream-owner-guard`, `narration-id-ownership-test`) — run `bun scripts/ledger.ts --dir=.ledger/security-audit-hardening`
- **Configuration surface**: Firebase Admin SDK (server route)
- **Production boundary**: Server code only. No Rules, no deploy. Local proof runs against the Pyric-hosted sandbox.
- **Rules source**: n/a
- **Generated artifact**: n/a
- **Build command**: n/a
- **firebase.json target**: n/a

## Problem

The client pre-generates the narration id (`studio/src/lib/use-generation-queue.ts:149`) and sends it in the POST body (`:201`). The server accepts any id that matches a shape regex:

    // studio/src/lib/narration-request.ts:54-58 — current
    const customId =
      typeof raw.id === 'string' &&
      /^[A-Za-z0-9_-]{10,128}$/.test(raw.id) &&
      !RESERVED_IDS.has(raw.id.toLowerCase())
        ? raw.id
        : undefined;

    // studio/src/app/api/narrations/route.ts:32 — current
    const id = parsed.id ?? newNarrationId();

Then it writes the document with Admin credentials, which skip Security Rules, and never checks whether the document already exists or who owns it:

    // studio/src/lib/narration-server.ts:259 — current
    activeStreams.set(id, { uid, abort: abortStream });

    // studio/src/lib/narration-server.ts:359 — current
    await docRef.set(initialNarration);   // initialNarration.ownerUid = caller uid

**Impact:** any allowlisted user who knows another user's narration id can overwrite that document and become its owner. Public and shared narration ids are visible to other users, so this is realistic. The victim loses the document (title, transcript, sharing) and their Storage objects are orphaned. `activeStreams.set` also replaces the victim's abort handle. If the attacker then cancels, `purgeDocumentAndStorage` (`:293-307`) deletes the document it just hijacked.

## Target behavior

Invariant: a narration id belongs to the first uid that writes it. Only that uid may start a generation under it.

| Actor | Request | Expected |
|---|---|---|
| alice | POST `{id: "alice-new-0001", …}` (id unused) | 200; doc created with `ownerUid: alice` |
| alice | POST `{id: "alice-new-0001", …}` again (her own id; retry after an error) | 200; doc re-seeded, `ownerUid: alice` |
| bob | POST `{id: "alice-new-0001", …}` (Alice owns it) | **409**; Alice's doc unchanged; no `activeStreams` entry for bob |
| bob | POST without `id` | 200; server-minted id |

    // target — studio/src/lib/narration-server.ts (new export)
    /**
     * Reserve `id` for `uid`. Returns false when the id already belongs to
     * someone else. Admin writes bypass Rules, so this check is the only
     * ownership boundary on the create path.
     */
    export async function claimNarrationId(id: string, uid: string): Promise<boolean> {
      const snap = await adminDb().collection("narrations").doc(id).get();
      if (!snap.exists) return true;
      return snap.data()?.ownerUid === uid;
    }

    // target — studio/src/lib/narration-server.ts, replacing line 359
    await adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const owner = snap.exists ? snap.data()?.ownerUid : undefined;
      if (owner !== undefined && owner !== uid) {
        throw new Error("Forbidden: narration id belongs to another user.");
      }
      tx.set(docRef, initialNarration);
    });

    // target — studio/src/app/api/narrations/route.ts, after `const id = …`
    if (!(await claimNarrationId(id, uid))) {
      return Response.json({ message: "That narration id is already in use." }, { status: 409 });
    }

Also, in `createNarrationStream`, do not overwrite another uid's `activeStreams` entry:

    // target — replacing line 259
    const existingStream = activeStreams.get(id);
    if (existingStream && existingStream.uid !== uid) {
      throw new Error("Forbidden: narration id belongs to another user.");
    }
    activeStreams.set(id, { uid, abort: abortStream });

The route pre-check gives a fast 409. The transaction is the authoritative guard: it closes the time-of-check/time-of-use gap between the route check and the write, which happens after `readAuthorProfile`. `docWritten` stays `false` when the transaction throws, so the failure path cannot delete a document the caller never owned.

## Repo conventions to follow

- Imitate the ownership transaction in `purgeNarrationData` at `studio/src/lib/narration-server.ts:176-184`.
- Server-side Admin transactions are allowed. AGENTS.md's "no `runTransaction`" rule applies only to client Web SDK flows.
- Test style: imitate `test/studio/narration-deletion.test.ts` and `test/studio/allowlist-auth-gate.test.ts` (source-contract assertions with `bun test`).

## Steps

1. Add `claimNarrationId` next to `newNarrationId` in `studio/src/lib/narration-server.ts` (~line 79).
2. Replace line 259 and line 359 as shown above. Keep `docWritten = true;` immediately after the transaction resolves.
3. In `studio/src/app/api/narrations/route.ts`, import `claimNarrationId` and add the 409 branch after line 32.
4. Add `test/studio/narration-id-ownership.test.ts`. It asserts that `route.ts` calls `claimNarrationId` before `createNarrationStream`, that `narration-server.ts` no longer contains a bare `docRef.set(initialNarration)`, and that the transaction compares `ownerUid` against `uid`.

## Boundaries

- Do not remove client-generated ids; the generation queue needs them for cancel and delete (`use-generation-queue.ts:110-118`).
- Do not change Security Rules in this plan.
- Do not deploy.

## Verification

- **Repository checks**: `bun test test/studio/narration-id-ownership.test.ts test/studio/narration-creation-regression.test.ts test/studio/generation-queue.test.ts` and `npx --prefix studio tsc --noEmit -p studio` both pass.
- **Local behavior (E2 end-to-end)**: with `bun run studio:bg` running and two allowlisted sandbox users, alice and bob:
  1. As alice, POST `/api/narrations` with `{"id":"audit-id-000001","markdown":"# a","voice":"Kore","visibility":"public"}`. Expect 200, and `narrations/audit-id-000001.ownerUid == alice` in Pyric Studio.
  2. As bob, POST the same body. Expect **409**. `ownerUid` is still alice and `title` is unchanged.
  3. Before the fix, step 2 returns 200 and flips `ownerUid` to bob. Record that as the pre-fix counterexample.
- **Hosted behavior**: not applicable. Admin SDK paths are not evaluated by the Rules Test API.
- **Done when**: step 2 returns 409 and the tests pass. Unsupported Pyric surface: none needed.
