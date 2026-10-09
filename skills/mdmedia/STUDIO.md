# Studio: narrations and playlists

The CLI is connected to the user's studio with a key they approved. You run
`mdmedia studio …`; the CLI holds the key. Narrations made this way are
always private.

If a command reports `not_logged_in` or `unauthenticated`, tell the user to
run `mdmedia studio login` themselves; they approve it in their browser. If it
reports `insufficient_scope` for playlists, the key predates playlist access,
and the user should run `mdmedia studio login` again.

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
