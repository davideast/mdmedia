# Plan 001: Story milestone 0 — parser, schemas, scheduler, cache keys, `story check`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4eb8f62..HEAD -- src/index.ts src/cli/command.ts package.json src/chunker`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (no audio, no network, no providers)
- **Depends on**: [000 design](000-design.md), sections 1, 3, 4, 7, 9, 10, 12
- **Category**: feature
- **Planned at**: commit `4eb8f62`, 2026-10-18

## Why this matters

Every later milestone reads the script and the timeline. This milestone makes
those two structures real and pinned by tests, with the smallest parser that
can carry a story: front matter, narration, lines, scenes, chapters and pauses.
Nothing here guesses at taste or guards against problems not yet seen
(design section 1).

## Scope

In: `src/story/` with the script and timeline types, front matter parsing,
body parsing, the six errors in design 3.5, the scheduler, render cache keys,
the `mdmedia/story` subpath and `mdmedia story check`.

Out: anything from design 3.4 (credits, effects, music, art), audio, providers,
`build.json` writing, `story build`, `story plan`, warnings of any kind,
pacing rules beyond the one default gap.

## Current state

- `marked`'s lexer parses markdown elsewhere:

  ```ts
  // src/chunker/storyboard-parser.ts:1
  import { lexer, type Token, type Tokens } from 'marked';
  ```

- CLI commands are `citty` definitions registered in `src/cli/command.ts`.
- The package exposes subpaths through `package.json` `exports` and re-exports
  them from `src/index.ts`.
- Dependencies include `marked` and `citty`; there is no YAML parser.
- Tests run with `bun test` at the repository root. CI runs `bunx tsc --noEmit`,
  `bun run build`, `bun test`, `bun run verify`.

## Decisions for this plan

1. **Add `yaml` (eemeli/yaml)**, the only new dependency. `parseDocument` keeps
   source ranges, so front matter errors point at the exact key. Validation is
   hand-written against its nodes; no schema library.
2. **Keep `marked`.** Its lexer tokens are contiguous with `raw` text, so a
   running offset gives each token's position. Step 3 proves this on the
   fixtures.
3. **Web Crypto for hashing** (`crypto.subtle.digest('SHA-256')`), so the key
   function also runs in a browser. It is async.
4. **Nothing under `src/story/` imports a `node:` module**; only
   `src/cli/story-command.ts` may.

## Files

| Path | Purpose |
|---|---|
| `src/story/types.ts` | `StoryScript`, `CastMember`, `VoiceRef`, `Chapter`, `Scene`, `Segment`, `StoryTimeline`, `Diagnostic`, `SourceRange`, `StoryError` (design 4.1, 4.2) |
| `src/story/source.ts` | Offset to 1-based line and column; `parseDuration` (`1.5s`, `1500ms`, `0:02`) |
| `src/story/front-matter.ts` | Split and parse front matter; validate the keys in design 3.1 |
| `src/story/parse.ts` | `parseStory(markdown, { path })` → `{ script?, diagnostics }` |
| `src/story/schedule.ts` | `scheduleStory(script, durations)` → `StoryTimeline` |
| `src/story/key.ts` | `renderKey(segment, script, provider?)` → `line:<sha256>` |
| `src/story/index.ts` | Public exports |
| `src/cli/story-command.ts` | `mdmedia story check <file> [--json]` |
| `test/story/fixtures/` | `two-voices.md`, `scenes-and-pauses.md`, and one file per error under `errors/` |
| `test/story/golden/` | Expected `script.json` and `timeline.json` for the two fixtures |
| `test/story/*.test.ts` | The tests named in each step |

## Steps

### 1. Branch and dependency

1. Work on a local branch `feat/story-m0` from `main`. Do not push.
2. `bun add yaml`.
3. **Verify**: `grep '"yaml"' package.json` shows it under `dependencies`.

### 2. Types and source helpers

- `types.ts` exactly as design 4.1 and 4.2, plus
  `type VoiceRef = string | { provider: 'gemini' | 'elevenlabs'; id: string }`,
  `interface SourceRange { line; column; endLine; endColumn }` (1-based),
  `interface Diagnostic { code; message; source?: SourceRange }` with the six
  codes from design 3.5, and `class StoryError extends Error { code; source? }`.
- `source.ts`: `toSourceRange(text, start, end)` and `parseDuration(text)`,
  which returns milliseconds or `undefined` for anything that is not
  `Ns`, `N.Ns`, `Nms` or `M:SS` with a positive value.

**Verify**: `bunx tsc --noEmit` and `bun test test/story/source.test.ts`.

### 3. Tokens with positions

In `parse.ts`, lex the body with `marked.lexer` and walk top-level tokens with
a running offset that starts after the front matter.

**Verify**: a test asserts that joining every top-level token's `raw` equals
the body of each fixture exactly. If any fixture fails, STOP.

### 4. Front matter

- A missing leading `---` block is `missing-front-matter`.
- `yaml.parseDocument` errors become `bad-yaml` with positions.
- Allowed keys: `title`, `author`, `imprint`, `language`, `gap`, `narrator`,
  `cast`. Anything else is `unknown-key`. `title` and `narrator` are required
  (`unknown-key` is not the right code for these: report `missing-voice` for a
  narrator without a voice and a `bad-yaml`-style message for a missing title;
  if a seventh code seems necessary, STOP and report rather than inventing one).
- `narrator` and each cast member need `voice`; otherwise `missing-voice`.
  `delivery` defaults to an empty string.
- `gap` uses `parseDuration`; invalid is `bad-duration`; absent is 400 ms.
- The narrator becomes cast member `NARRATOR`. Cast ids are upper-cased.

**Verify**: `bun test test/story/front-matter.test.ts`.

### 5. Body

| Token | Becomes |
|---|---|
| `heading` depth 1 | a new chapter, id `NN-slug` from its text |
| `heading` depth 2 | stored as the current scene's `title`; not spoken |
| `heading` depth 3, `hr` | a new scene |
| `paragraph` that starts with `**Name**`, an optional `*(delivery)*`, then `:` | a `line` for that speaker |
| any other `paragraph`, `list`, `blockquote` | a `line` spoken by `NARRATOR` |
| `code` with lang `pause` | a `pause` segment from `parseDuration` of its text; invalid is `bad-duration` |
| any other `code`, `space`, `html` | nothing |

- Speaker names match cast ids case-insensitively; no match is
  `unknown-speaker` with the range of the bold name.
- `delivery` is the character's default plus the parenthetical, joined with
  `, ` when both exist.
- `text` is the spoken form with inline markdown removed; `display` keeps the
  original.
- Content before the first `#` heading forms chapter `00` with no title.
- Segment ids: `<chapterId>/<NNNN>-<speaker lower-case | pause>`, numbered
  within the chapter.

**Verify**: `bun test test/story/parse.test.ts`, with golden `script.json` for
both fixtures and one test per error code.

### 6. Scheduler

`scheduleStory(script, durations)`:

- Walks segments in order. A `line` occupies its duration from `durations`
  (missing is a `StoryError` with code `missing-duration`). After each line
  comes the script's `gapMs`, unless the next segment is a `pause`, which
  replaces the gap with its own duration. Consecutive pauses add up.
- No gap after the last line.
- Fills `clips` (lines only, with `render` set to the segment's render key),
  `chapters`, `scenes` and `durationMs`.

**Verify**: `bun test test/story/schedule.test.ts`, with golden timelines from
fixed durations, and checks that clips never overlap, every gap equals
`gapMs` or the written pause, and chapters and scenes cover `[0, durationMs]`
without gaps.

### 7. Render keys

`renderKey(segment, script, provider = { name: 'gemini', model: 'default' })`
hashes the provider name and model, the speaker's voice, the full delivery,
`text`, `meta.language`, and a `RENDER_VERSION` constant, and returns
`line:<hex>`. Pauses have no key.

**Verify**: `bun test test/story/key.test.ts`:

- inserting a line in a fixture changes no other line's key;
- changing one character's default delivery changes only that character's keys;
- the same input gives the same key twice.

### 8. Exports and CLI

1. `src/story/index.ts` exports `parseStory`, `scheduleStory`, `renderKey`,
   `StoryError` and the types. Add `"./story"` to `package.json` `exports`
   following the existing entries, and `export * from './story/index.js'` to
   `src/index.ts`.
2. `src/cli/story-command.ts` defines `mdmedia story check <file> [--json]`:
   prints `file:line:col code message` per diagnostic (or `no problems`), or a
   JSON array with `--json`; exits `1` if there are any diagnostics, else `0`.
3. Register it in `src/cli/command.ts`. Extension routing never picks it.

**Verify**:

```bash
bun run build
node dist/bin.js story check test/story/fixtures/two-voices.md                         # "no problems", exit 0
node dist/bin.js story check test/story/fixtures/errors/unknown-speaker.md; echo $?   # the diagnostic, then 1
node dist/bin.js story check test/story/fixtures/errors/unknown-speaker.md --json     # JSON array
```

and `bun test test/story/cli.test.ts` (JSON output and exit codes).

### 9. Full checks

```bash
bunx tsc --noEmit
bun test
bun run build
bun run verify
grep -rn "from 'node:" src/story && echo "STOP: node import in src/story" || echo "story is platform-free"
```

All pass, and the last line prints `story is platform-free`.

## Done when

- Both fixtures produce their golden `script.json` and `timeline.json`.
- Each of the six error codes has a test.
- Scheduler and key tests pass.
- `mdmedia story check` works from the built CLI with the exit codes above.
- Nothing under `src/story/` imports a `node:` module.
- The branch is committed locally and not pushed.

## STOP conditions

- Joined token `raw` does not reproduce a fixture's body (step 3).
- A schema in design section 4 needs a change, or a seventh error code seems
  necessary.
- A dependency other than `yaml` seems necessary.
- `bun test` fails outside `test/story/` after your changes.
- The drift check shows changes that contradict "Current state".
