# Studio storyboard CLI implementation plan

Status: complete. Implemented and verified locally; nothing committed or pushed.
Public CLI + HTTP boundaries confirmed. User additionally authorized a sensible
amount of paid generation; one short live narration has been generated and reused.

## Outcome

An agent or person can create a standalone storyboard, read it, edit its beats,
rehearse its authored text, and delete it through `mdmedia studio storyboard`.
The CLI and Studio UI use the same API and records. No production is created.
The older `mdmedia cut storyboard` remains a distinct shot-prompt helper.

Continue in the existing isolated `feat/studio-storyboards` worktree: the API is
uncommitted work in this feature. Do not commit, push, or migrate other branches.
Existing CLI/client changes on other local branches are integration risks, not
reasons to replace their work. No open PR currently implements this CLI.

## Command contract

All commands reuse Studio login, `MDMEDIA_STUDIO_URL`, `MDMEDIA_API_KEY`, normal
error formatting, and `--json`. IDs are explicit; do not ambiguously resolve titles.

- `list`: owner-scoped summaries.
- `show <id>`: title, revision, ordered beats; `--json` returns the API resource.
- `create --title <title> [--input <document.json|->]`: empty or authored document.
- `update <id> --revision <n> [--title <title>] [--input <document.json|->]`:
  replace the document and/or rename. Preserve document when renaming only.
- `delete <id> --yes`: explicit destructive intent, actionable not-found/auth errors.
- `beat add <id> --revision <n> --input <beat.json|-> [--before <beat-id>]`.
- `beat update <id> <beat-id> --revision <n> --input <patch.json|->`:
  change only supplied supported fields; preserve identity and unrelated content.
- `beat remove <id> <beat-id> --revision <n> --yes`.
- `beat move <id> <beat-id> --revision <n> (--before <beat-id>|--after <beat-id>)`:
  reorder by stable identity, preserving all fields. Reject missing targets and
  conflicting position flags.
- `narrate <id> [--beat <beat-id>] [--view script|board]` with existing voice and
  delivery conventions. Script is the default; Board uses the same walkthrough
  text selection as the UI. Return a narration ID and web link for normal Studio
  playback/status. `--dry-run` previews the resolved request without generating; `--wait` and
  `--timeout` use normal narration status. No automatic generation retries or
  new provider integrations.

Mutation commands read the current record when needed, compare the required
revision, then PUT with that same revision. A concurrent update between GET and
PUT is rejected by the API. Never fetch a newer revision and silently retry.
Create accepts document JSON, not an API response envelope. Help and examples
make the file formats explicit. Missing or malformed input fails before writes.

## Confirmed test boundaries

1. CLI process boundary: arguments, stdin/files, stdout/stderr, exit codes, help.
2. Studio HTTP API boundary: observable persisted results and error responses.

Assert behavior through these interfaces, not private helpers, UI markup, or
inspection of database contents. Isolated integration fixtures may substitute
infrastructure at the database/provider boundary; do not describe those alone as
live end-to-end proof. The final CRUD proof must use the real Studio HTTP server
and sandbox persistence. Test records are disposable and cleaned up.

Routine narration checks use `--dry-run`, which never submits synthesis. The user
authorized a short live end-to-end narration: test it once, request the identical
audio again to prove reuse, and keep paid tests opt-in. Do not automatically retry
a failed paid generation.

## TDD slices

For each slice: write one behavior test, run it and record the meaningful failure,
implement the minimum, rerun to green, then move to the next behavior. No bulk
imagined tests or implementation before red evidence.

1. List/create/show: independent record is discoverable and round-trips exact
   narration, visual direction, notes, artwork, and stable beat IDs.
2. Update: rename and document changes persist; omitted fields survive; stale
   revisions return a conflict with nonzero exit and no overwrite.
3. Beat add/update: file and stdin workflows, supported-field validation,
   duplicate/missing IDs, preservation of untouched beats.
4. Beat move/remove: ordered results, invalid targets, explicit removal, CAS.
5. Delete: explicit intent, successful disappearance, other-owner isolation.
6. Narrate: exact Script/walkthrough text and order, selected beat, voice/delivery,
   empty text rejection, existing narration reuse, no blind retries.
7. Credentials/errors: missing login, invalid key, insufficient scopes, wrong
   owner, malformed JSON, invalid options; machine-readable errors and exit codes.
8. Built CLI proof: execute the distributable under Node against real Studio,
   create/show/update/reorder/delete, conflict and read-only-key cases. Clean up
   only test-created records and credentials. Confirm no production is created.

## Integration and completion

- Add typed methods to the existing Studio client; keep server/CLI contract aligned.
- Register one storyboard command group without changing smart routing of others.
- Document commands, payloads, scopes, revision recovery, and narration costs.
- Update bundled agent guidance so agents discover the feature correctly.
- Run root and Studio type checks, relevant CLI/API tests, build, and regression
  checks for adjacent Studio commands. Measure machine load before timed scenarios.
- Save the red/green record and reproducible end-to-end command/results here.
- Review the final diff for accidental UI changes, credentials, generated media,
  and unrelated work. Nothing is committed or pushed.

Done means the commands work through the real HTTP path, conflict protection and
owner isolation are proven, tests and build pass, docs match help, and the final
report states exactly what was tested and any remaining limits. Mark the goal
complete only then. Production conversion, asset upload, video generation, ripple
editing, and broader storyboard/UI redesign are out of scope.


## Completion evidence — 2026-10-25

The command contract above is implemented. Each behavior slice first failed at
its public CLI boundary, then passed after implementation:

| Slice | Observed red | Green proof |
| --- | --- | --- |
| Create/read/list | Unknown storyboard command | Exact document round-trip; no production created |
| Update | Missing update command | File/stdin edits, rename preservation, stale revision rejection |
| Beat edits | Missing beat command | Add/patch preservation and invalid patch/duplicate ID rejection |
| Order/removal | Missing move/remove commands | Before/after ordering, invalid targets, explicit removal |
| Delete/auth | Missing delete command | Explicit intent, owner isolation, read-only and invalid-key errors |
| Narration preview | Missing narrate command | Exact text/settings, invalid selections, no synthesis |
| Live narration | Submission not implemented | One short paid recording ready; identical request reused its ID; audio HTTP 200 |
| Malformed input | Null document unexpectedly accepted | Null/array/malformed/version errors rejected before creation |
| Flag safety | `--dryrun` reached API instead of being rejected | Unknown option fails before generation |

Final verification:

- Built Node CLI against the real Studio HTTP server and persistent sandbox:
  **9 passed, 1 paid test intentionally skipped, 108 assertions**.
- Earlier built Node run with the paid test enabled: **7 passed, 85 assertions**,
  including one successful short narration and recording reuse. Later checks did
  not generate more audio.
- Adjacent CLI/client/storyboard regression suite: **73 passed, 276 assertions**.
- Root and Studio TypeScript checks, distributable TypeScript build, and
  `git diff --check` passed.
- Package dry run includes the command implementation, types, and bundled Studio
  agent guidance. No package was published.
- Concurrent same-revision writers were tested: exactly one save succeeds.
- Disposable storyboards were deleted; all three temporary API keys were revoked.
  The one narration remains under an isolated test owner, not the user's library.

Reproduce using the environment variables and commands in [cli.md](cli.md#reproduce-the-end-to-end-checks).
The live suite is opt-in and requires Studio and scoped test credentials; a normal
unit-test run does not imply live HTTP or paid generation coverage. The local
build is available in `dist/bin.js`; this has not been released globally.


## PR-readiness follow-up — 2026-10-26

The four review findings have been addressed:

1. Automatic unpaid CLI coverage now runs under `bun test` using the existing
   nine CLI scenarios against actual HTTP handlers with isolated in-memory
   persistence. It needs no external service, credentials or generation credits.
2. Explicit `document: null` returns 400 at the create API; omission still creates
   an empty board. The API test failed with 201 before the fix and passes now.
3. Clean editors adopt a newer API revision; dirty drafts retain their content
   and concurrency token. Accepting a refreshed resource also clears an obsolete
   recovery draft left by Undo. Both refresh cases were reproduced in a browser.
4. Add beat is disabled at 100. Draft recovery preserves oversized authored text
   without relaxing API save limits. A browser test reproduced loss of an 8000-
   character field before the fix and verifies its recovery afterward.

The full local suite passes: **1,324 tests, 40 skipped, zero failures**. The
automatic CLI test runs nine additional scenarios in its isolated child suite.
Browser checks pass clean refresh/undo/revisit, dirty preservation, oversized
recovery, and phone width. Root and Studio type checks and the CLI build pass;
verification checks pass **22/22**, package consumer checks **13/13**, and Studio
structural fixtures **2/2**. Studio production compilation and the offline worker
build pass using `.next-pr-check`; the worker was explicitly pointed at that
directory because the standard npm script assumes `.next`. No paid generation was performed in this follow-up.

The README records intentional sample/migration files and excluded local outputs.
Existing referenced image URLs remain intact; earlier art-direction examples are
explicitly historical. No commits, pushes, releases, or PRs were made. These are
local checks on Node 24/Bun; GitHub's Node-version matrix and fresh-install job
still need to run when a PR is authorized.
