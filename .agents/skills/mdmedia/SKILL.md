---
name: mdmedia
description: Make media from markdown and prompts with the `mdmedia` CLI. Use when the user asks to narrate or read something aloud, put narrations in a playlist or arrange playlists, or generate audio, video, images, music, or sound effects.
---

`mdmedia` has two kinds of work. Pick the branch first; it decides everything else.

| The user wants | Branch | Read |
| --- | --- | --- |
| A narration to listen to in their studio, or playlist changes | **studio** | [STUDIO.md](STUDIO.md) |
| A media file on disk: `.wav`, `.mp4`, `.png`, `.mp3`, a narration script | **files** | [FILES.md](FILES.md) |

"Narrate this" with no file named means **studio**: the user listens there. Use
**files** for audio only when they ask for a file, a path, or offline output.

## Rules for every branch

- Act only on what the user asked for. Never generate media on your own initiative.
  Generation costs money and takes minutes.
- Pass only the options the user asked for; defaults come from their Settings or config.
- Never read, print, or copy credentials: `~/.config/mdmedia/credentials.json`,
  `MDMEDIA_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `.env`, `.mdmedia.json` keys.
  If a command says a key or login is missing, tell the user what to run and stop.
- Narrate or generate only content the user pointed you at. Don't include
  secrets or private material from the surrounding context.
- Use `--json` whenever a command offers it, and report results from what
  the command actually printed: ids, links, paths, durations.
- On `rate_limited` or `too_many_in_progress`, tell the user and stop. Don't retry in a loop.

You're done when the user has the link or file path they asked for, taken
from the command output, or a clear statement of what failed and why.
