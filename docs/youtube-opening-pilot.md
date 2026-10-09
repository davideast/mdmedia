# YouTube opening: I Made a Movie Without Leaving My Terminal

## Editorial intent

Show the result first, prove its origin with commands and outputs, and use short
presenter appearances for personality. Speech continues across picture changes.
Fifteen shots cover thirty seconds. Cuts follow reveals and changes of information;
there are no automatic fades between clips.

The opening follows a spaceship from still image to launch video to scored payoff,
with a deliberately wrong engine sound as the joke. A short opening introduces the
tutorial; it does not attempt to teach every command in thirty seconds.

## Real generation evidence

The local mdmedia CLI generated the image, animated that image, and generated an
instrumental Lyria clip. Terminal sequences replay those successful command runs,
including their actual arguments and stdout, with waiting time removed. They are
rendered terminal replays, not continuous desktop screen recordings.

This checkout has no standalone sound-effect command. The engine audio is part
of the generated video. The comic squeak is synthesized editorial audio. The
spoken conclusion therefore says **three commands**, not four.

The first video request failed because the CLI defaults to `text_to_video` even
with `--firstFrame`; the successful command explicitly uses
`--task image_to_video`. Both run records are retained. No CLI behavior was changed.

The presenter uses the reference-based technique established in
[the presenter proof](presenter-generation-proof.md), with a generated voice.
Three successive generation turns provide the speech and reaction footage.

## Local artifacts

All media live in `.design/youtube-pilot/` (ignored by git):

- `terminal-hollywood-opening.mp4`: finished thirty-second edit.
- `edit-decision-list.json`: ordered picture placements with source in-points.
- `image-command.json`, `video-command.json`, `music-command.json`: actual runs.
- `ship.png`, `launch.mp4`, `score.mp3`: generated source assets.
- `presenter-3.mp4`: full generated presenter dialogue; covered by demonstrations
  through most of the edit.
- `presenter.json`: prompts and saved continuation interaction IDs.

Reproducer scripts (paid generation commands refuse to replace saved assets):

```sh
bun --env-file=studio/.env scripts/youtube-pilot-assets.ts image
bun --env-file=studio/.env scripts/youtube-pilot-assets.ts video
bun --env-file=studio/.env scripts/youtube-pilot-assets.ts music
bun --env-file=studio/.env scripts/youtube-pilot-presenter.ts 1
bun --env-file=studio/.env scripts/youtube-pilot-presenter.ts 2
bun --env-file=studio/.env scripts/youtube-pilot-presenter.ts 3
bun scripts/youtube-pilot-edit.ts
```

The presenter experiment requires the prepared three-second reference at
`/private/tmp/mdmedia-presenter-reference.mp4`. Editing uses the repository's
FFmpeg binary and macOS fonts. The scripts do not modify Studio projects.

## What this establishes for the app

The planning model needs separate spoken passages, visual shots, generated assets,
and sound placements. A spoken passage must be able to span multiple visual shots.
The presenter role must not force every line into a talking-head clip. CLI demos
need verifiable execution and an explicit method for removing waiting time.

This is an editorial pilot, not yet a reusable automatic production workflow or an
import into the Studio timeline. The EDL and individual assets preserve the edit
for that next integration.
