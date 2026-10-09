# Agent-driven Studio project import

The first slice creates a reviewable script and timeline through the authenticated
Studio API. It never calls a generation provider or creates video jobs.

```sh
bun run src/bin.ts project import \
  --studio http://127.0.0.1:3101 \
  --token-file /path/to/private-id-token \
  --input drafts/beneath-double-coat/project.json

bun run src/bin.ts project list \
  --studio http://127.0.0.1:3101 \
  --token-file /path/to/private-id-token
```

`project get --id ID` reads the saved manifest, derived draft records and review
notes. All commands return JSON. `MDMEDIA_STUDIO_TOKEN` can replace `--token-file`.
Use a Firebase ID token for an allowlisted, verified-email account. No auth bypass
or admin key is accepted by these API routes. A production CLI login flow is not
implemented yet. Local development can use a Pyric sandbox session; it must carry
the same email/verified-email claims checked by Studio.

The reusable `StudioProjectsClient` is exported from the mdmedia TypeScript API.
It exposes `importProject`, `getProject`, and `listProjects`, accepts an injected
fetch transport, rejects insecure non-local origins and refuses redirects.
Tokens are read from the environment or a private file, not CLI arguments.

## Manifest and storage

See `ProjectImport` in `src/projects/index.ts` and the episode manifest above.
The server validates and canonicalizes a version 1 manifest before saving it:

- Project id, title, production direction and review notes.
- 1–12 parts, each with an explicit continuity policy and structured script.
- Each part is 10–180 seconds, with at most 32 shots of up to 40 seconds.
- Shots retain dialogue, visual direction, sound cues and stable identifiers.
- Continuous chains are validated against the existing generation limit.
- Imports cannot attach arbitrary existing media or inject job/owner fields.

Records live at `videos/{verifiedUid}/projects/{projectId}`. The API scopes every
read and write to the authenticated caller. Create-only writes prevent accidental
overwrite. Repeating identical content is idempotent; different content under the
same id returns 409. No update/delete operation is exposed in this first slice.

Studio lists these under Projects → Saved production plans. Opening a part loads
its timeline only when the browser does not already have that draft. Existing
local edits and generated takes are preserved. A fresh browser can recover the
imported plan from its account. **Subsequent timeline edits still use the existing
browser workspace; full cloud workspace synchronization is not implemented.**

## Episode and remaining production work

The supplied episode is a condensed adaptation in three parts: 22, 20 and 22 shots,
with durations of 178, 162 and 161 seconds (8m21s total). The plan highlights the
original chronology conflicts and intentionally omits explicit ages/elapsed years.

This is an import/review workflow, not unattended episode generation. The current
script-to-generation compiler suppresses dialogue and omits planned sound; fix
that before producing this dialogue-heavy episode. Character references, stable
voice assignments, editorial text overlays, durable generation orchestration and
agent revision operations remain subsequent work. No automatic generation is
triggered by import, opening a project or opening its timeline.

## Local sandbox findings

Verified against the existing Pyric alpha24 hosted sandbox, without upgrading it.
Pyric CLI `auth getUser` and `firestore getDoc` made account ownership and the saved
manifest directly inspectable. The normal app API remained the write boundary.
Two compatibility details mattered:

- An isolated Node client sign-in carried the uid but omitted email verification
  fields needed by this app. A sandbox custom token carrying the account's existing
  email and verified-email claims allowed the unchanged app authentication to pass.
- The hosted admin adapter lacks `DocumentReference.create()`. A server transaction
  with a read followed by set preserved atomic create-only/idempotent semantics.

A directly usable agent ID-token operation and parity for admin `create()` would
make this path simpler. No production credential or application auth bypass was
introduced.

## Agent production

`scripts/studio-build.ts` drives the same authenticated Studio endpoints as the UI. It accepts a Studio origin, project id, part id, token file and checkpoint file. It saves request IDs before submission, waits for each shot, follows explicit continuation dependencies, preserves completed takes on failure, and assembles the final export. Re-running checks saved IDs instead of starting duplicate paid takes. Failed or incomplete provider jobs receive at most two retries per shot; completed takes are retained. Policy failures are not retried. Further recovery requires an explicit production decision.

Project reads restore saved generation checkpoints into newly opened timelines. Existing browser edits still take precedence. The script compiler now includes dialogue and sound in model direction; untouched, ungenerated legacy imports upgrade automatically. Generated takes and manually edited direction are not overwritten. The project page presents the adaptation length and parts instead of implementation caveats.

The first production exercise is `drafts/beneath-double-coat/cold-open.json`: an exterior, a connected Heidi performance, and a title. Continuation preserves the same generated performance within the room. Automatic character reference creation and reuse across independent cuts is not implemented by this exercise.

The builder also accepts an optional sixth argument naming a local production-bindings JSON file. `references` supplies shared cast images for new shots; `shotReferences` overrides them per beat; `files` supplies locally rendered footage such as exact title cards. `concurrency: 2` permits two independent camera setups at once while each continuation chain remains serial. Checkpoint writes are serialized and atomic. Credentials are reread per request to support refresh during long runs. `captions` supplies bounded editorial overlays for export; text is passed through temporary text files with FFmpeg expansion disabled.

The continuation endpoint also accepts bounded multipart requests containing `id`, `draft`, `sourceVideoId`, `sourceEndSeconds`, and reference images. The production builder reattaches its cast/location references on each continuation; the runner forwards them alongside the previous interaction ID without supplying a new first frame. This reinforces identities as new characters enter a continuous shot. JSON continuation requests remain supported. `stopAfterBeat` in production bindings saves through a chosen beat for local review without submitting subsequent shots or an export.
