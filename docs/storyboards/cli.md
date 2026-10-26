# Storyboards from the CLI

`mdmedia studio storyboard` edits the independent storyboards shown in Studio.
It does not create a production or generate video. Connect with `mdmedia studio
login --url <studio-url>`. An older connection may need a fresh login to approve
storyboard access.

## Create, inspect, and edit

```sh
mdmedia studio storyboard list --json
mdmedia studio storyboard create --title "Beyond the SaaS template" --input story.json --json
mdmedia studio storyboard show <id> --json
mdmedia studio storyboard update <id> --revision 1 --title "A better title" --json
mdmedia studio storyboard update <id> --revision 2 --input revised-story.json --json
```

Omit `--input` on create to start empty. Use `--input -` for piped JSON. Input is
one storyboard document, not the response from `show`. Extract
`storyboard.document` from that response when preparing a replacement.

```json
{
  "version": 1,
  "premise": "Show how a visual style changes what a page communicates.",
  "beats": [
    {
      "id": "opening",
      "title": "Recognize the familiar template",
      "purpose": "Establish the problem",
      "summary": "Compare pages with different promises but the same appearance.",
      "script": "These products promise different things. Their pages look the same.",
      "visual": "Three pages beside one another.",
      "notes": "Choose examples later.",
      "status": "draft",
      "estimatedSeconds": null
    }
  ]
}
```

Beat `summary` and `image` are optional. Images currently reference local Studio
assets under `/assets/storyboard/`, not disk uploads or remote URLs. `status` is
`draft` or `decided`. Durations may remain `null`. The API validates content,
field names, unique IDs, and limits. These are story decisions, not permission to
spend on media generation.

## Edit individual beats

```sh
mdmedia studio storyboard beat add <id> --revision 3 --input beat.json --before closing --json
mdmedia studio storyboard beat update <id> opening --revision 4 --input patch.json --json
mdmedia studio storyboard beat move <id> opening --revision 5 --after comparison --json
mdmedia studio storyboard beat remove <id> opening --revision 6 --yes --json
```

`beat.json` contains one complete beat using the shape above. `patch.json` contains
only fields to change, for example `{ "script": "New narration.", "notes": "" }`.
Patches preserve omitted fields and cannot change `id`. Adding without `--before`
appends. Move requires exactly one of `--before` and `--after`, with a different
existing destination beat. Beat IDs are stable identifiers, not titles or indexes.

Every edit requires the current `storyboard.revision` from `show`. Each successful
save advances it. If another person or agent edits first, the CLI exits nonzero
with `storyboard_conflict`; it never retries against a newer revision. Read the
latest document, reconcile, and explicitly submit again.

## Listen or preview

```sh
mdmedia studio storyboard narrate <id> --dry-run --json
mdmedia studio storyboard narrate <id> --beat opening --view board --dry-run --json
mdmedia studio storyboard narrate <id> --voice Kore --delivery "Warm and direct." --wait --json
```

Default `--view script` reads authored narration in beat order. `--view board`
reads walkthrough summaries, falling back to narration. Empty segments are
skipped; an entirely empty selection is an error. Text is read as written.

`--dry-run` resolves the exact text, reader, model, delivery and pace, and prints
that request without submitting synthesis. Without it, narration can incur
provider charges. `--voice` accepts a Gemini name or an authorized ElevenLabs ID;
omitted settings use Studio defaults. `--deliveryPreset` selects a saved preset
by name or ID instead of `--delivery`. `--speed` accepts 0.5–2.5.

Submission returns a narration ID and `links.web`. `--wait` waits for readiness;
`--timeout` sets the waiting limit in seconds (default 900). Use
`mdmedia studio status <narration-id> --json` after an interrupted wait. Generation
is not cancelled by a waiting timeout. No automatic generation retry occurs.
The server reuses an existing recording for the same owner, storyboard, text,
reader and delivery. Changing any of these can create a new recording.

## Delete and authorize

```sh
mdmedia studio storyboard delete <id> --yes --json
```

Deletion requires `--yes`. Deleting a storyboard does not delete a production or
its generated recordings. It is not revision guarded; the explicit action deletes
the storyboard identified by ID.

API scopes: `storyboards:read` for reads; `storyboards:write` for writes. Edits that
read the current document need both. Narrate also uses `options:read` to resolve
settings and `narrations:create` to submit; waiting needs `narrations:read`.
`--json` returns structured results/errors, and failures exit nonzero. Parser-level
usage errors print command help. Credentials remain managed by the existing CLI.

The older `mdmedia cut storyboard` creates shot generation prompts. It is a
different command and does not manage these independent Studio records.

## Automatic regression coverage

`bun test` runs `test/cli/studio-storyboard-commands.test.ts` automatically. It
starts real CLI subprocesses against the actual storyboard HTTP handlers, using
isolated in-memory Firestore, real API-key checks, and a fixed reader catalogue.
There is no synthesis endpoint. This covers parsing, stdin/files, CRUD, revisions,
concurrent writers, ownership, scopes, ordering, dry-run and mistyped flags in CI.
It supplements the persistent-sandbox proof below; it does not claim to test
Firebase or provider integration.

## Reproduce the end-to-end checks

The opt-in suite starts actual CLI subprocesses and talks over HTTP to a running
Studio, using its real routes and persistence. No route handlers are mocked.
Supply disposable sandbox test credentials through environment variables:

- `STORYBOARD_E2E_URL`: running Studio origin.
- `STORYBOARD_E2E_KEY`: test owner key with storyboard read/write, production read,
  options read, and narration create/read.
- `STORYBOARD_E2E_READ_KEY`: the same test owner with only storyboard read.
- `STORYBOARD_E2E_OTHER_KEY`: a different test owner with storyboard read/write.

```sh
bun test test/e2e/studio-storyboard.test.ts
# After building, prove the shipped Node entrypoint:
npm run build
STORYBOARD_E2E_BUILT=1 bun test test/e2e/studio-storyboard.test.ts
```

Absent the URL/key, the live suite skips; ordinary unit/API tests run separately.
Records created by the suite are cleaned up through the API. Use a test owner,
not an account being edited concurrently, for stable list assertions. Do not put
keys in command arguments, source files, or logs.

`STORYBOARD_E2E_PAID=1` additionally authorizes one short real narration per run,
checks audio availability, and verifies an identical request returns the same ID.
It is off by default. The recording remains in the test owner's narration library
for review; deleting the storyboard does not delete its audio.
