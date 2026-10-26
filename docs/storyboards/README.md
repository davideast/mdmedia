# Working storyboards

This first slice plans the high-level story before recording or generation. Each
storyboard is an independent, owner-scoped record; creating one does not create a production. Script and Board are views of the same
versioned document; neither is generated from the other. The intaglio fixture is
six provisional beats, with timing and the detailed transformation deliberately
open. The expanded sample in `intaglio-expanded.storyboard.json` adds 11 narrated
beats, estimated timing, and four generated concept images. Both remain examples,
not approved footage. No assets or media jobs are created by importing them.

## Navigation

- `/storyboards`: storyboard master list and New storyboard action.
- `/storyboards/{id}?view=board`: visual plans in story order.
- `/storyboards/{id}?view=script`: continuous script and visual direction.
- Add `&beat={stableBeatId}` to open a beat's editor in either view.
- Legacy `/productions/{id}/storyboard` links redirect, preserving view and beat.
- Productions and their cuts keep their existing routes and navigation.

The two views share one Recent/Find work identity and preserve selected beat
links. Breadcrumbs navigate to real parents, not browser-history guesses. Invalid
view values use Board; a removed beat displays an explanation without selecting
another beat silently. Save lives in page content; the API accepts agent-authored documents.

## Agent interface

Use `mdmedia studio storyboard` with the normal Studio connection. See
[the CLI guide](cli.md) for commands, JSON examples, revision handling and
end-to-end checks. Agents can also call the API directly; no new agent runtime
or skill executor is required.

1. `POST /api/v1/storyboards` with `{ "title": "My story", "document": { ... } }`
   creates an independent storyboard at revision 1. Omitting document creates an
   empty board. The UI creates an untitled board; rename it in the inspector.
2. `GET /api/v1/storyboards` lists owner-scoped summaries. `GET
   /api/v1/storyboards/{id}` returns `{ id, title, createdAt, updatedAt,
   storyboard: { revision, updatedAt, document } }`.
3. `PUT /api/v1/storyboards/{id}` accepts `{ "expectedRevision": 1,
   "title": "Optional new title", "document": { ... } }`. Title and document save
   atomically. Use the current revision from GET. Example JSON files contain the
   document, not the whole request body.
4. A stale revision returns 409 without changing anything. Reconcile deliberately
   before saving again. Do not retry a stale document replacement blindly.
5. `DELETE /api/v1/storyboards/{id}` deletes that storyboard, never a production.

Reads require `storyboards:read`; mutations require `storyboards:write`. Session
access also works. All operations are owner-only. Existing API keys must explicitly
acquire these scopes; production scopes do not grant storyboard access. Documents
live in the `storyboards` collection and are limited to 160 KB. Deleting a
production does not affect them. List responses omit the full document.

Revision is a concurrency token, not an archive of past revisions. The UI has
session undo and account-scoped browser recovery of unsaved edits through the
existing workspace store. Explicit Save persists to Studio. There are no JSON import/export controls in the UI.

## Deliberate limits

This slice has optional local concept artwork, script notes, purpose, open questions,
optional duration estimates, story decisions, and beat reorder/add/remove.
`decided` concerns the story only, never approval to record or generate footage.

The board lives inside Studio’s standard resizable shell. The existing navigation
and right inspector can be resized and docked to give the board more room. Its
grid adapts from one to four columns, with equal-height cards and selectable text.
Each Edit control opens the right inspector, or its standard sheet on a phone.
The optional `summary` field holds a concise walkthrough, independent of the
verbatim `script`. The new high-level example is `art-direction.storyboard.json`;
it preserves the user’s draft narration and leaves associations, styles, and timing
open. Earlier examples remain available for comparison.
An optional `image` field references a static PNG, JPG or WebP under
`/assets/storyboard/`; it is deliberately limited to local concept assets, not a
general upload or media attachment API. Generated prompts and paths are recorded
in `concept-prompts.md`. These examples are not recordings of a working website.

The page header plays the current view through Studio's narration engine and
shared audio player. The inspector uses the existing Reader picker. Each beat
also has Play/Pause beside Edit. Board reads walkthrough summaries (falling back
to narration); Script reads only authored narration, skipping unwritten beats.
Playback uses private narrations with rewriting disabled. The same owner,
storyboard, text, voice and delivery reuse the saved recording. A transaction
reserves a new narration before synthesis to prevent duplicate concurrent starts.
No generation runs on page load. Changing text or reader creates a new recording
only when Play is pressed. Errors appear in the page content.

`POST /api/v1/storyboards/{id}/narration` accepts the normal narration
voice/delivery fields and markdown, and returns a narration id for the existing
player. It requires both `narrations:create` and `storyboards:read`, and checks
storyboard ownership. Recordings use the normal narration library and retention.

Editing, changing views, and leaving the page stop storyboard playback. Script
is a continuous text document with section headings, visual directions and
narration. Images stay in Board view and the inspector.

Media attachment, cut creation, ripple edits, revision
history, and skill management are later slices. Existing productions and cuts
continue to work as before. Storyboards has its own main navigation destination. Production handoff is deferred;
there is no automatic conversion or synchronization.

## Migration

`studio/scripts/migrate-storyboard.mjs <productionId> copy` backs up the source
privately in `/tmp`, copies its working document into an independent record with
the same ID, and preserves revision, owner, title, and timestamps. It refuses to
overwrite an unrelated destination. Run with the same backend environment as Studio.
After verifying the destination, `remove-empty-source` rechecks the source
fingerprint and refuses removal if it has cuts, cast, cover, series, or other
production relationships. Source removal is a separate, explicit step.

The same ID preserves narration cache identity. Workspace recovery canonicalizes
old storyboard URLs while retaining pinned state and unsaved fields. Legacy API
paths delegate to independent handlers and require the new storyboard scopes.


## Files included with this feature

- `art-direction.storyboard.json` is the current high-level teaching example.
- `intaglio.storyboard.json` and `intaglio-expanded.storyboard.json` are earlier
  prototype examples, retained for import compatibility tests and existing saved
  boards. They are not the recommended creative direction.
- `concept-prompts.md` records the provenance of the four generated concept
  images; it is not current agent guidance.
- `studio/public/assets/storyboard/` contains the images referenced by those
  examples and saved boards. Retain their stable URLs. They are sample artwork,
  not generated output from tests or private production footage.
- `studio/scripts/migrate-storyboard.mjs` is an explicit administrator tool for
  the older embedded-record format. It does not run on install, build or startup.
  Its private recovery backups stay in `/tmp`, outside the repository.
- Local credentials, narration recordings, browser screenshots, test logs, build
  directories and package archives are not feature source and must not be staged.
  The separate production-check directory `.next-pr-check` is ignored.

## Editor browser regression

With local sandbox Studio running, run
`PLAYWRIGHT_MODULE=<installed-playwright-module> node test/browser/storyboard-editor.mjs`.
`STORYBOARD_BROWSER_URL` overrides the default localhost port 3171. The check uses
sandbox Google login, intercepts storyboard HTTP with disposable data, and makes
no storyboard writes or generation requests. It verifies clean refresh, dirty
preservation, the 100-beat control, oversized draft recovery and phone layout.
This is a manual browser check, separate from automatic CI coverage.
