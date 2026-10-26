# Studio: narrations, media, and playlists

The CLI is connected to the user's studio with a key they approved. You run
`mdmedia studio …`; the CLI holds the key. Everything made this way is
private.

If a command reports `not_logged_in` or `unauthenticated`, tell the user to
run `mdmedia studio login` themselves; they approve it in their browser. If it
reports `insufficient_scope`, the key predates that kind of access (playlists,
images, video, music, or sound effects), and the user should run
`mdmedia studio login` again.

## Narrate

1. Write the content to a markdown file. For text you composed, use a temp file.
   Include only what the user asked to hear.
2. Start it:

   ```sh
   mdmedia studio narrate -i file.md --json
   ```

   Options, only when asked:
   - `--voice <name|id>`
   - `--delivery-preset <name>` or `--delivery "<text>"`
   - `--instructions-preset <name>` or `--instructions "<text>"`
   - `--speed 0.5–2.5`
   - `--no-rewrite` to read the text as written
   - `--structure` / `--no-structure`
   - `--verbalize-diagrams`

   `mdmedia studio options --json` lists voices, presets, and defaults.
3. Reply with `links.web`. Generation continues on the server. Add `--wait`
   only if the user wants to know it finished, and `-o file.wav` only if they
   want the audio file.

Use `mdmedia studio status <id> --json` to check on a narration later.

## Generate images, video, music, and sound effects

Each takes the prompt as `-p "…"`, `-i file.md`, or stdin, and prints the item's
web link. Pass only the options the user asked for.

```sh
mdmedia studio image -p "<prompt>" --json
mdmedia studio video -p "<prompt>" --json
mdmedia studio music -p "<prompt>" --json
mdmedia studio sfx   -p "<prompt>" --json
```

Options, only when asked:

- `image`: `--model` (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`,
  `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`),
  `--aspect` (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1),
  `--resolution` (0.5K, 1K, 2K, 4K), `--reference a.png,b.png` (up to 14 images),
  `--search`, `--image-search`, `--thinking minimal|medium|high`, `--video <https-url>`,
  `--item <id>` with `--refine` / `--from-generation <genId>` for multi-turn editing.
- `video`: `--aspect` (16:9, 9:16), `--resolution` (360p, 720p, 1080p, 4k),
  `--duration` (3–10 whole seconds), `--reference <image>`, plus `--first-frame`
  to start the clip from that image.
- `music`: `--clip` for a 30-second clip instead of a full song,
  `--format mp3|wav`, `--vocals auto|vocals|instrumental`, `--lyrics <file>`,
  `--reference <image>`. Lyrics can't be combined with `--vocals instrumental`.
- `sfx`: `--duration` (0.5–30 seconds), `--influence` (0–1, how literally to
  follow the prompt), `--loop`, `--format mp3|wav`.
- `image`, `video`, `music`: `--adapt` to rewrite notes into a prompt first,
  `--instructions "<text>"` to steer that rewrite.

`mdmedia studio options --json` lists narration options only.

Reply with the web link. Generation continues on the server and can take
minutes. Add `--wait` only if the user wants to know it finished, and
`-o <file>` only if they want the file; `-o` implies `--wait`. A wait that times
out (`--timeout`, default 900 seconds) is not a failure; check later with:

```sh
mdmedia studio status <id> --type image|video|music|sfx --json
```

If a command fails after the item was created (a lost connection, a download
or save error), the error includes the item's `id`. Check on it with `status`
instead of running the command again: a second run starts, and pays for, a
second generation.

## Narrate into a playlist

```sh
mdmedia studio narrate -i file.md --playlist "<id or exact title>" --json
```

- Placement: `--start`, `--before <id>`, or `--after <id>`. The default is the end.
- Add `--create-playlist` only when the user wants a new playlist.
- The output's `playlist` field gives `{ id, title, position }`, with
  position counting from 1. If it holds an `error` instead, the narration
  started but wasn't added; tell the user.

## Arrange playlists

Look before you change anything:

```sh
mdmedia studio playlist list --json
mdmedia studio playlist show <playlist> --json   # items in order, with ids
mdmedia studio narrations --q "<title text>" --status ready --json
```

`<playlist>` is an id or exact title. Edit items by narration id. Give
positions relative to other ids, never as numbers:

```sh
mdmedia studio playlist create "Title" [<id>…] [--description "…"]
mdmedia studio playlist add <playlist> <id>… [--start | --before <id> | --after <id>]
mdmedia studio playlist remove <playlist> <id>…
mdmedia studio playlist move <playlist> <id> --start | --end | --before <id> | --after <id>
mdmedia studio playlist order <playlist> <id>…   # every current item, once, new order
mdmedia studio playlist rename <playlist> "New title"
mdmedia studio playlist describe <playlist> "Description"
mdmedia studio playlist delete <playlist>        # keeps the narrations
```

- Every edit prints the resulting order. Check it matches the request before
  you report back.
- `unchanged` lists adds of items already present, or removes of items that
  weren't there. Those are harmless.
- On `invalid_order`, the playlist changed underneath you. Run `show` again
  and redo the edit against what's there now.
- On `playlist_ambiguous`, use the id from the error.
- Before a sweeping change, like deleting a playlist or removing or reordering
  many items, list what you'll change and wait for the user to agree.

## Independent storyboards

Use `mdmedia studio storyboard`, not `mdmedia cut storyboard`, to create and edit
Studio's independent story plans. Creating or editing a plan does not generate
media or create a production.

- `list --json`, `show <id> --json`
- `create --title "…" [--input document.json] --json`
- `update <id> --revision <n> [--title "…"] [--input document.json] --json`
- `beat add <id> --revision <n> --input beat.json [--before <beat-id>] --json`
- `beat update <id> <beat-id> --revision <n> --input patch.json --json`
- `beat move <id> <beat-id> --revision <n> --before <other-id> --json`
  (or `--after`, never both)
- `beat remove <id> <beat-id> --revision <n> --yes --json`
- `delete <id> --yes --json`

Read with show first. Use its `storyboard.revision` and preserve stable beat IDs.
On `storyboard_conflict`, reconcile against the latest content; never blindly retry
using the new revision. `--input -` accepts stdin. Whole-document input is the
`storyboard.document` shape, not the response envelope. Beat patches cannot change
IDs; omitted fields remain unchanged. Use command help and the repository's
`docs/storyboards/cli.md` for document/beat examples.

`narrate <id> [--beat <beat-id>] [--view script|board] --dry-run --json` previews
exact text and reader settings without generation. Without `--dry-run` it can cost
money: require the user's authorization. Script reads authored narration; Board
reads walkthrough summaries with narration as fallback. Use the returned
`links.web`, and `mdmedia studio status <narration-id>` after an interrupted wait.
An identical request reuses its recording. Do not automatically retry generation.


Minimal whole-document input (supply authored content rather than these examples):

```json
{
  "version": 1,
  "premise": "The story this video develops",
  "beats": [{
    "id": "opening",
    "title": "A concrete opening moment",
    "purpose": "What this moment establishes",
    "summary": "A short walkthrough of the moment",
    "script": "The words to read aloud.",
    "visual": "What the viewer sees",
    "notes": "",
    "status": "draft",
    "estimatedSeconds": null
  }]
}
```

A beat-add input is one object from `beats`. A beat-update input contains only
changed fields, for example `{"script":"Revised narration."}`. `image` is an
optional local `/assets/storyboard/<name>.png` (or `.webp`/`.jpg`) path on a beat; status is `draft` or `decided`.

### Production assembly

Use `mdmedia studio production` for storyboard handoff and agent-authored multitrack assemblies. `create --from-storyboard ID --idempotency-key KEY` copies saved beats into untimed scenes. `media add FILE` registers sources. `assembly export ID` returns the draft revision/hash and assets; add `--download-dir DIR` for bytes. Edit the document externally, then `assembly update ID --file FILE --expected-revision N`. Render with external tools and `publish ID --render FILE --expected-revision N --assembly-hash HASH --idempotency-key KEY`. Reuse keys only when retrying the same operation. Published renders are immutable; a new render needs a new publication. `comments watch ID` emits NDJSON snapshots and changes, reconnecting after interruption; fetch full conversations with `comments context`. No paid generation is implicit in these commands. See `docs/productions/assembly.md` in the source checkout for the schema and complete workflow.
