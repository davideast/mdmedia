# Plan 006: Story milestone 5 — pages, lettering, comic voices and the reader (`story comic`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78121a5..HEAD -- src/story src/cli/story-command.ts package.json`
> On any change that contradicts "Current state", STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM (balloon layout is the new judgment code; a phone screen is the hard case)
- **Depends on**: [005](005-milestone-4-comic-art.md) (`feat/story-m4`, 78121a5); [000 design](000-design.md) sections 5, 8, 9, 10, 11, 12
- **Category**: feature
- **Planned at**: commit `78121a5`, 2026-10-23

## Why this matters

This is the second half of the graphic novel. Milestone 4 draws checked panels;
this milestone puts them on pages with exact, readable lettering, voices every
caption and balloon, and ships a reader you can page through, read panel by
panel on a phone, and listen to. At the end, a comic script becomes the
graphic novel the prototype's lunch scene showed (run 4), built by the package.

## Scope

In: balloon and caption layout from head boxes; comic voices, one checked clip
per caption or balloon; WebP art; the reader site (page view, guided view, tap
to hear, read aloud); `mdmedia story comic`.

Out: the comic director, `story adapt` (milestone 6); sound effects audio
(needs an ElevenLabs key); music in the reader; MP4; the studio media type.

## Current state

- `drawComic` (`src/story/comic/draw.ts`) returns every panel's image, its
  check answers and head boxes (`{ id, box: [y0, x0, y1, x1] }`, 0–1 of the
  drawn image). `story draw` writes them to `comic/comic.json` and `art/`.
- A panel is drawn at `panel.aspect`, the nearest supported ratio to its slot
  (`geometry.ts`), and shown cropped to the slot with `object-fit: cover`, so
  head boxes must be mapped from image space into slot space.
- Comic items (`ComicItem`): captions `{ kind: 'caption', cue, text }`, balloons
  `{ kind: 'balloon', who, cue, mark?: 'small' | 'off' | 'loud', text }`, and
  `{ kind: 'sfx', text }`, in reading order per panel.
- `renderLines(script, options)` (`src/story/render-lines.ts`) voices a
  `StoryScript`: one call per line, the delivery note with the two previous
  lines in the scene, refusal fallbacks, a transcript check with up to 2
  retakes, and a cache. Comic voices can reuse it unchanged by building a
  script whose scenes are pages and whose lines are captions and balloons.
- `AudioRuntime` (`src/story/ports.ts`, Node: `src/story/node/ffmpeg.ts`) has
  `probe`, `mix` and `encode`; no image conversion yet.
- The prototype's lettering and reader are `spikes/story/tools/comic.html`
  (386 lines: layout, balloons, tails, guided view) and `comic-page.ts`
  (`spike/story`). They are the starting point, not the code to copy:
  their placement was naive until head boxes came in.
- Three comics exist: `comic-lunch.md` (21 panels), `comic-midnight-line.md`
  (15), `comic-wren-backwards.md` (16), with drawn art in local caches.

## Decisions for this plan

1. **One layout function, run in the browser.** `letterPanel(panel, heads,
   box, measure)` is pure TypeScript in core (no DOM, no `node:`). The reader
   runs the compiled module at view time with canvas text measurement, after
   the lettering font loads, so the page view and the guided view (re-lettered
   at a minimum size) use the same rules. Tests run it with a fixed-width
   `measure`. The reader imports the compiled module files directly; no
   bundler, so `letter.ts` may only import other pure relative modules.
2. **Placement rules** (design 8, run 4), in order:
   - Items are laid out in reading order; each one goes in the highest free
     spot after the one before, left to right within a row.
   - Never over a head box, never over another item.
   - Captions are boxes, preferring the top left corner.
   - Balloons are ovals near their speaker, above the head first, then beside
     it, then below it, as a last resort when the art has no headroom.
   - Consecutive balloons by one speaker are joined: two ovals with a short
     connector and one tail.
   - Tails point at the speaker and end just short of the head box.
   - The panel's `Balloons: top|bottom` is the preferred zone.
   - `[small]` sets smaller type, `[loud]` sets bold type with a spiky outline,
     and `[off]` means the speaker is off panel: the tail points to the nearest
     panel edge.
   - Sound effects are big tilted display text in free space.
   - When nothing fits, the font shrinks step by step to the minimum, then the
     item takes the spot with the least overlap and is reported as crowded.
3. **Text is never changed.** The lettered text is the script text exactly,
   only wrapped; tests assert it.
4. **Comic voices reuse milestone 1.** Each caption and balloon is one line;
   the speaker of a caption is the story's narrator; the cue is the item's cue;
   a page is a scene for context. Sound effects are lettered, not voiced. The
   voice cache is shared with `story build` by key; because the key includes
   the context lines, a comic line rarely matches its audio drama take, which
   is expected.
5. **Audio in the reader**: one MP3 per item (96 kb/s, normalized to the same
   loudness as the audio drama), so tap-to-hear plays exactly that item and
   read-aloud plays a panel's items in order with a 400 ms gap, then turns.
6. **WebP art**: panels are converted with the existing ffmpeg runtime (a new
   `AudioRuntime.webp`, quality 82), as the design's runtime section says.
7. **The reader looks like mdmedia studio**: colors, type and controls copied
   from `studio/src/app/globals.css` and studio's components; a top bar with
   only the title and the critical actions, at one visual scale: page or
   guided view, and read aloud. Nothing else in it. Lettering uses Comic Neue
   from Google Fonts (OFL), falling back to a system sans; sound effects use
   Bangers.
8. **`story comic` draws first.** It runs `drawComic` (cached panels cost
   nothing), then voices, then writes the site. `--no-voices` skips audio for
   a quick lettering pass.

## Steps

### 1. Panel geometry for lettering

`src/story/comic/letter.ts`: `slotHeads(panel, heads)` maps head boxes from
the drawn image into the slot, given the image aspect and `cover` cropping;
heads cropped out of view are dropped.

**Verify**: unit tests: a centered head in a 16:9 image shown in a 1:1 slot
moves as expected; a head in the cropped margin is dropped.

### 2. Lettering layout

`letterPanel(panel, heads, box, measure, options?)` returns
`{ items: Placed[], crowded: string[] }`, where a placed item has its kind,
shape (box, oval, joined ovals, sfx), position, size, wrapped lines,
font size and, for a balloon, its tail from the shape edge to a point just
short of the head. `options.minFontPx` sets the guided view's minimum.

**Verify** (`test/story/comic/letter.test.ts`, fixed panel sizes and heads):
- No item overlaps a head box or another item.
- Reading order holds: each item starts at or below the one before it, or
  further right in the same row.
- Captions sit in the top left when it's free.
- A balloon's tail ends within a few pixels outside its speaker's head box.
- An `[off]` tail ends at the panel edge.
- Two balloons in a row by one speaker are joined.
- With no headroom, a balloon goes below its speaker.
- An impossible panel shrinks the type to the minimum and reports the item as
  crowded.
- The wrapped text joins back into exactly the item's text.
- Every panel in the three fixture comics, with recorded head boxes from the
  live draws (copied into `test/story/fixtures/heads/*.json`), lays out with no
  head overlap at page size, and at the guided minimum on a 390 px wide panel.

### 3. Comic voices

`src/story/comic/voices.ts`: `comicScript(comic, story)` builds the
`StoryScript` of captions and balloons (scenes are pages; ids stay stable by
panel and item index); `voiceComic(...)` calls `renderLines` and returns each
item's clip and check.

**Verify**: unit tests with `toneSpeaker` and `scriptedTranscriber`: one clip
per caption and balloon, none for sound effects; a caption uses the narrator's
voice; the note for a panel's second balloon includes the line before it; a
second run is fully cached.

### 4. Image conversion

Add `webp(input, quality)` to `AudioRuntime` and the Node runtime.

**Verify**: the runtime contract test converts a PNG to WebP (skipped with a
reason without ffmpeg).

### 5. The reader site

`src/story/comic/reader.ts` writes `reader/`: `index.html`, `reader.css`,
`reader.js`, the compiled `letter.js` and its pure dependencies, `comic.json`
(pages, slots, items, head boxes, audio file names and durations),
`img/panel-P-N.webp` and `audio/<item>.mp3`.

`reader.js` (browser, no framework):
- **Page view**: the page at its 2:3 shape, panels in their slots, lettering
  laid out live.
- **Guided view**: one panel at a time, re-lettered at the minimum size; tap
  the right side or press → for the next panel, tap the left side or press ←
  for the previous one.
- **Tap any caption or balloon** to hear it.
- **Read aloud** voices the current panel in order, then turns to the next one.
- The current view and position stay in the URL hash, so a reload keeps your
  place.

**Verify**:
- Unit test: the writer produces the tree and a `comic.json` that matches the
  comic.
- Smoke test with Playwright's Chromium (run locally; skipped in CI when no
  browser is found): open the fixture reader built with fakes, check that no
  lettered item overlaps a head box in the DOM, move through the guided view
  with the arrow keys, and check that tapping a balloon starts its audio
  element.

### 6. `mdmedia story comic`

`mdmedia story comic <comic.md> [--out] [--cache] [--no-voices] [--image-model] [--vision-model] [--json]`
draws, voices and writes `dist/<slug>/comic/` plus `reader/`, and
`comic-build.json` (every panel and line with its checks, crowded items).
Exit codes as before: `4` when a panel or line still fails its check, or an
item is crowded.

**Verify**: CLI tests with fakes: the tree, exit 4 on a crowded item, exit 4
on a line that keeps failing its transcript check.

### 7. Live runs (needs the Gemini key; not in CI)

```bash
NODE_USE_ENV_PROXY=1 node dist/bin.js story comic test/story/fixtures/comic-lunch.md --out $TMPDIR/m5 --cache $TMPDIR/m4-cache
NODE_USE_ENV_PROXY=1 node dist/bin.js story comic test/story/fixtures/comic-midnight-line.md --out $TMPDIR/m5 --cache $TMPDIR/ml2-cache
NODE_USE_ENV_PROXY=1 node dist/bin.js story comic test/story/fixtures/comic-wren-backwards.md --out $TMPDIR/m5 --cache $TMPDIR/wb-cache
```

Art comes from the milestone 4 caches. For each run, record lines voiced,
retakes, lines still flagged, crowded items and wall time. Then:
- Read every page in the page view and every panel in the guided view at
  phone width.
- Listen to one page per comic with read aloud.
- Publish each reader as a private Artifact.

### 8. Full checks

```bash
bunx tsc --noEmit
bun test test/story
bun run build
npm_config_cache=$TMPDIR/npm-cache bun run verify
grep -rn "from 'node:" src/story --include=*.ts | grep -v "src/story/node/" && echo "STOP" || echo "core is platform-free"
```

## Done when

- Every step's tests pass with fakes.
- All three comics build, read in both views at phone width with no balloon
  over a face, and are published for review.
- Committed locally on `feat/story-m5`, branched from `feat/story-m4`, not
  pushed.

## STOP conditions

- Lettering can't avoid faces on more than 2 panels in a comic at page size;
  that would mean the art needs headroom rules, not more layout code.
- Canvas text measurement in the reader differs from layout assumptions enough
  that text overflows its balloon.
- A dependency seems necessary (a bundler, a font package, a UI framework).
- More than a fifth of comic lines still fail their transcript check after
  retakes.
