/**
 * The instructions a coding agent follows to narrate on the user's behalf.
 * Installed as a Claude Code skill by `mdmedia studio install-skill`; the same
 * text works pasted into AGENTS.md for other agents (`--print`).
 */
export const NARRATE_SKILL_NAME = 'mdmedia-narrate';

export const NARRATE_SKILL = `---
name: ${NARRATE_SKILL_NAME}
description: Turn text or markdown into a narrated audio recording in the user's mdmedia studio, and organize narrations into playlists. Use when the user asks to narrate something, read it aloud, make an audio version, "make this listenable", or to create, fill, reorder, or tidy their playlists.
---

# Narrate with mdmedia

The user's mdmedia studio turns markdown into narrated audio. The \`mdmedia\`
CLI is already connected to it with a key the user approved; you run the CLI,
it holds the key.

## When to use it

Only when the user asks for audio. Do not narrate on your own initiative, and
do not narrate secrets, credentials, or private material the user did not
point you at.

## How

1. Put the text in a markdown file (write a temp file for content you
   composed). Narrate what the user asked for, not surrounding context.
2. Start it:

   \`\`\`sh
   mdmedia studio narrate -i path/to/file.md --json
   \`\`\`

   The user's Settings supply the voice, delivery, and cleanup options. Only
   pass options the user asked for:
   \`--voice <name>\`, \`--delivery-preset <name>\`, \`--delivery "<text>"\`,
   \`--instructions-preset <name>\`, \`--speed 1.25\`, \`--no-rewrite\`,
   \`--structure\` / \`--no-structure\`, \`--verbalize-diagrams\`.
   \`mdmedia studio options --json\` lists voices, presets, and defaults.
3. Reply with the \`links.web\` URL from the output. Generation takes a while;
   the page shows progress. Add \`--wait\` only when the user wants to know it
   finished, and \`--output file.wav\` only when they want the audio file.

## Playlists

Add a new narration to a playlist as it is created:

\`\`\`sh
mdmedia studio narrate -i file.md --playlist "Commute" --json
\`\`\`

\`--playlist\` takes an id or exact title. Add \`--create-playlist\` only when
the user wants a new playlist, and \`--start\`, \`--before <id>\`, or
\`--after <id>\` to place it (default: the end).

To arrange existing playlists, look before you change anything:

\`\`\`sh
mdmedia studio playlist list --json
mdmedia studio playlist show "Commute" --json      # items in order, with ids
mdmedia studio narrations --q "pyric" --json        # find narration ids
\`\`\`

Then edit by narration id; positions are relative to other ids, never indexes:

\`\`\`sh
mdmedia studio playlist create "Title" [<id>…] [--description "…"]
mdmedia studio playlist add <playlist> <id>… [--start | --before <id> | --after <id>]
mdmedia studio playlist remove <playlist> <id>…
mdmedia studio playlist move <playlist> <id> --start | --end | --before <id> | --after <id>
mdmedia studio playlist order <playlist> <id>…    # every item, once, in the new order
mdmedia studio playlist rename <playlist> "New title"
mdmedia studio playlist describe <playlist> "Description"
mdmedia studio playlist delete <playlist>          # keeps the narrations
\`\`\`

Every edit prints the resulting order; check it matches what the user asked
for. If an edit fails because the playlist changed (\`invalid_order\`), show
it again and redo the edit against what is there now. Before a sweeping
reorganization (deleting playlists, removing many items), say what you will
change and wait for the user to agree.

## Boundaries

- Narrations made this way are always private. Never try to share or publish
  them; the user does that in the studio.
- If the CLI says it is not connected (\`not_logged_in\`, \`unauthenticated\`),
  tell the user to run \`mdmedia studio login\` themselves. It asks them to
  approve in their browser. Never approve it, never look for, read, print, or
  copy the credentials file or \`MDMEDIA_API_KEY\`.
- On \`rate_limited\` or \`too_many_in_progress\`, tell the user and stop; do
  not retry in a loop.
`;
