/**
 * The instructions a coding agent follows to narrate on the user's behalf.
 * Installed as a Claude Code skill by `mdmedia studio install-skill`; the same
 * text works pasted into AGENTS.md for other agents (`--print`).
 */
export const NARRATE_SKILL_NAME = 'mdmedia-narrate';

export const NARRATE_SKILL = `---
name: ${NARRATE_SKILL_NAME}
description: Turn text or markdown into a narrated audio recording in the user's mdmedia studio. Use when the user asks to narrate something, read it aloud, make an audio version, or "make this listenable" — a file, a doc, notes, or an answer you wrote.
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
