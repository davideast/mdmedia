# Plan 001: Story milestone 0 — parser, schemas, scheduler, `story check` and `story plan`

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
- **Effort**: M
- **Risk**: LOW (no audio, no network, no providers)
- **Depends on**: [000 design](000-design.md), sections 3, 4, 7, 8, 9, 10, 13 and 15
- **Category**: feature
- **Planned at**: commit `4eb8f62`, 2026-10-18

## Why this matters

Everything later in the story work (rendering, mixing, captions, the reader,
video) reads the script and the timeline. Milestone 0 makes those two data
structures real, validated and tested, with no audio at all, so every later
milestone builds on a format that is already pinned down by golden files.

## Scope

In:

- `src/story/` module: types for `script.json` and `timeline.json` (design 4.1,
  4.2), duration parsing, front matter parsing and validation, body parsing,
  diagnostics, pacing defaults, scheduling with supplied durations, build
  planning with cache keys.
- `mdmedia/story` package subpath.
- `mdmedia story check` and `mdmedia story plan`.
- Fixtures, golden files and tests.

Out (later milestones): any provider call, audio, the Node runtime and its
ports, `build.json` writing, `story build`, `cast`, `clean`, art, captions.
The `build.json` type is declared (design 4.3) but not produced.

## Current state

- Markdown is parsed with `marked`'s lexer elsewhere:

  ```ts
  // src/chunker/storyboard-parser.ts:1
  import { lexer, type Token, type Tokens } from 'marked';
  ```

- CLI commands are `citty` definitions registered in `src/cli/command.ts`
  (`audioCommand`, `videoCommand`, `imageCommand`, `musicCommand`,
  `sfxCommand`, plus `studio`).
- The package exposes subpaths through `package.json` `exports`
  (`./audio`, `./video`, `./chunker`, `./pipeline`, `./tts`, …) and re-exports
  from `src/index.ts`.
- Dependencies include `marked` and `citty`; there is no YAML parser and no
  schema library.
- Tests run with `bun test` at the repository root; CI runs `bunx tsc --noEmit`,
  `bun run build`, `bun test`, `bun run verify`.

## Decisions for this plan

1. **YAML: add `yaml` (eemeli/yaml).** Its `parseDocument` keeps source ranges
   for every node, so front matter and cue block diagnostics can point at the
   exact key. No schema library: validation is hand-written against `yaml`
   nodes so every error carries a position.
2. **Markdown: keep `marked`.** Its lexer tokens are contiguous and each has
   `raw`, so a running offset gives every token's source position. Step 4
   verifies this holds for the fixtures; if it does not, that is a STOP
   condition (switching to remark is a design change, not an executor choice).
3. **Hashing: Web Crypto.** Cache keys use `crypto.subtle.digest('SHA-256')`,
   available in Node 18+ and browsers, so `planStory` stays platform-free. It is
   therefore async.
4. **No `node:` imports anywhere under `src/story/` except `src/cli/story-command.ts`.**
   The parser, scheduler and planner must run unchanged in a browser.

## Files

| Path | Purpose |
|---|---|
| `src/story/types.ts` | `StoryScript`, `CastMember`, `VoiceRef`, `Chapter`, `Scene`, `Segment`, `StoryTimeline`, `TimelineClip`, `StoryBuild`, `Diagnostic`, `SourceRange`, `PacingRules` (design section 4) |
| `src/story/diagnostics.ts` | Diagnostic codes from design 3.7, `StoryError`, offset → line/column conversion |
| `src/story/duration.ts` | `parseDuration('1.5s' \| '1500ms' \| '0:02')` → ms or a diagnostic |
| `src/story/front-matter.ts` | Split front matter from the body, parse with `yaml`, validate, resolve cast (adding `NARRATOR`), credits and pacing |
| `src/story/pacing.ts` | Default pacing rules (design section 9) and merging overrides |
| `src/story/parse.ts` | `parseStory(markdown, { path })` → `{ script?, diagnostics }` |
| `src/story/credits.ts` | Opening, chapter and closing credit text from front matter (design 15.6) |
| `src/story/schedule.ts` | `scheduleStory(script, durations)` → `StoryTimeline` |
| `src/story/plan.ts` | `renderKey(segment, script)` and `planStory(script, { cache? })` |
| `src/story/fake-durations.ts` | Deterministic durations for tests and `story plan` (words × 380 ms + 250 ms; cue durations as written, else 2 s) |
| `src/story/index.ts` | Public exports for `mdmedia/story` |
| `src/cli/story-command.ts` | `mdmedia story check` and `mdmedia story plan` |
| `test/story/fixtures/*.md` | `two-voices.md`, `chapter-with-cues.md`, `credits-and-pacing.md`, plus one file per diagnostic under `errors/` |
| `test/story/golden/*.json` | Expected `script.json` and `timeline.json` per fixture |
| `test/story/*.test.ts` | Tests listed in step 9 |

## Steps

### 1. Branch and dependency

1. Work on a local branch `feat/story-m0` from `main`. Do not push.
2. `bun add yaml`.
3. **Verify**: `grep '"yaml"' package.json` shows it under `dependencies`.

### 2. Types

Write `src/story/types.ts` exactly as design section 4, with these additions:

- `type CastId = string` (upper-case).
- `type VoiceRef = string | { provider: 'gemini' | 'elevenlabs'; id: string }`.
- `interface SourceRange { line: number; column: number; endLine: number; endColumn: number }` (1-based).
- `type MusicCue = 'intro' | 'outro' | 'bed' | 'transition' | 'stinger'`.
- `interface Diagnostic { code: DiagnosticCode; severity: 'error' | 'warning'; message: string; source?: SourceRange }`.

**Verify**: `bunx tsc --noEmit` passes.

### 3. Durations and diagnostics

- `parseDuration` accepts `Ns`, `N.Ns`, `Nms`, `M:SS`; rejects negatives,
  empty strings and anything else with `bad-duration`.
- `toSourceRange(markdown, startOffset, endOffset)` converts offsets to 1-based
  line and column.

**Verify**: `bun test test/story/duration.test.ts test/story/diagnostics.test.ts`.

### 4. Body tokenization with positions

In `parse.ts`, lex the body with `marked.lexer`, walking tokens with a running
offset that starts after the front matter. For every token record
`[start, start + raw.length)`.

**Verify**: a test asserts that concatenating every top-level token's `raw` for
each fixture equals the body exactly. If any fixture fails this, STOP.

### 5. Front matter

- Split on a leading `---\n … \n---\n`. A missing front matter block is
  `missing-front-matter` (add this code; error).
- `yaml.parseDocument`; YAML syntax errors become `bad-yaml` diagnostics with
  positions (add this code; error).
- Validate keys from design 3.1. Unknown top-level keys: `unknown-key`. Cast
  entries without `voice`: `missing-voice`. `narrator` is required.
- Upper-case cast keys; the narrator becomes `NARRATOR`.
- `credits.opening` / `credits.closing` accept `true`, `false` or a string.
- `pacing` accepts `default` or a map of the rule names in `pacing.ts`; unknown
  rule names are `unknown-key`.

**Verify**: `bun test test/story/front-matter.test.ts`.

### 6. Body classification

Walk tokens in order and build chapters, scenes and segments:

| Token | Becomes |
|---|---|
| `heading` depth 1 | new chapter (id `NN-slug-of-title`) |
| `heading` depth 2 | displayed section title (stored on the scene; not spoken) |
| `heading` depth 3 | new scene |
| `hr` | new scene with a scene-break gap |
| `paragraph` matching `^\*\*([^*]+)\*\*\s*(?:\*\(([^)]*)\)\*)?\s*:\s*(.+)$` (single line or wrapped) | `line` for that speaker; delivery = cast default + parenthetical |
| other `paragraph`, `list`, `blockquote` | `line` spoken by `NARRATOR` |
| `code` with lang `sfx`, `music`, `pause`, `scene` | cue segment; body parsed with `yaml` and validated |
| `code` with any other lang | ignored for speech; `unknown-block` warning only if the lang looks like a typo of a cue type (edit distance ≤ 2) |
| `space` | nothing |

Rules:

- Speaker names match cast keys case-insensitively; no match is
  `unknown-speaker` with the range of the bold name.
- `text` is the spoken form (inline markdown stripped); `display` keeps the
  original markdown.
- `{sfx: …}` and `[tag]` patterns in text add a `reserved-syntax` warning and
  are spoken as written.
- Segment ids: `<chapterId>/<NNNN>-<kind-or-speaker>`, numbered within the
  chapter, for file names only.
- Content before the first `#` heading goes into an implicit chapter `00` with
  no title.
- Credits from `credits.ts` are inserted as `credit` segments: opening before
  the first chapter, closing after the last, chapter credits when enabled.

**Verify**: `bun test test/story/parse.test.ts` (golden scripts for the three
fixtures; one test per diagnostic code).

### 7. Scheduler

`scheduleStory(script, durations: Record<segmentId, number>)`:

- Places voice segments (lines and credits) sequentially with the gaps from
  `script.pacing`: different speakers, same speaker, narration boundary, scene
  break, chapter break, opening credit to first chapter.
- `sfx` at `after` starts when the previous voice segment ends and does not
  delay the next voice segment unless it is longer than the gap; `with` starts
  with the previous segment; `before` ends when the next voice segment starts.
- `pause` adds its duration to the voice track.
- `music`: `intro` before the opening credit with its fades; `outro` after the
  closing credit; `bed` from its position until `until`; `transition` between
  chapters, extending the chapter gap to its duration; ducking parameters
  copied from the cue and pacing.
- Fills `chapters[]` and `scenes[]` ranges, `durationMs`, `sampleRate: 48000`,
  `channels: 2`. `render` is the segment's render key from `plan.ts`; `words`
  is omitted in milestone 0.
- Missing durations for a segment are an error (`StoryError` code
  `missing-duration`).

**Verify**: `bun test test/story/schedule.test.ts` — golden timelines from
`fake-durations.ts`, plus property tests over all fixtures:

- no two voice clips overlap;
- every gap between consecutive voice clips equals the matching pacing rule
  (or the pause, transition or `sfx` override);
- chapters and scenes cover `[0, durationMs]` without gaps or overlaps;
- every clip ends at or before `durationMs`.

### 8. Planner and render keys

- `renderKey(segment, script)` hashes exactly the inputs listed in design
  section 8 (no ids, no ordinals), prefixed by kind: `line:<sha>`, `sfx:<sha>`,
  `music:<sha>`.
- `planStory(script, { cache? })` returns
  `{ renders: { key, segmentId, kind, cached }[], counts: { total, cached, toRender }, estimate: { ttsCharacters, sfxCalls, musicCalls } }`.
  `cache` is an optional `(key) => Promise<boolean>`; without it everything is
  `toRender`.

**Verify**: `bun test test/story/plan.test.ts`, including:

- inserting a line in the middle of a fixture changes no other segment's key;
- changing a character's default delivery changes only that character's keys;
- the same input gives the same keys in two runs.

### 9. Public exports and CLI

1. `src/story/index.ts` exports `parseStory`, `scheduleStory`, `planStory`,
   `renderKey`, `fakeDurations` and all types. Add `"./story"` to `package.json`
   `exports` (matching the existing subpath entries) and
   `export * from './story/index.js'` in `src/index.ts`.
2. `src/cli/story-command.ts` defines `mdmedia story` with:
   - `check <file> [--json]`: prints diagnostics as `file:line:col severity code message`;
     exit `1` if any error, else `0`.
   - `plan <file> [--json]`: runs check, then plans with fake durations and
     prints chapter count, segment counts by kind, total duration (fake),
     renders to do, and the estimate. Exit `1` on errors.
   - `--online` on `check` and the `build`, `cast`, `clean` subcommands are not
     added in this milestone.
3. Register it in `src/cli/command.ts`. It is never chosen by extension
   routing.

**Verify**:

```bash
bun run build
node dist/bin.js story check test/story/fixtures/two-voices.md            # exit 0, "no problems"
node dist/bin.js story check test/story/fixtures/errors/unknown-speaker.md; echo $?   # prints the diagnostic, exit 1
node dist/bin.js story plan test/story/fixtures/chapter-with-cues.md --json   # valid JSON matching the plan shape
```

and `bun test test/story/cli.test.ts` (JSON snapshots and exit codes).

### 10. Full checks

**Verify**, all from the repository root:

```bash
bunx tsc --noEmit
bun test
bun run build
bun run verify
grep -rn "from 'node:" src/story && echo "STOP: node import in src/story" || echo "story is platform-free"
```

All pass, and the last line prints `story is platform-free`.

## Done when

- The three fixtures produce golden `script.json` and `timeline.json`.
- Every diagnostic code in design 3.7 (plus `missing-front-matter`, `bad-yaml`)
  has a test.
- The scheduler property tests hold for every fixture.
- `mdmedia story check` and `mdmedia story plan` work from the built CLI with
  the exit codes above.
- Nothing under `src/story/` imports a `node:` module.
- The branch is committed locally and not pushed.

## STOP conditions

- Concatenated token `raw` does not reproduce a fixture's body (step 4).
- Any schema in design section 4 needs a change to implement this plan.
- A dependency other than `yaml` seems necessary.
- `bun test` fails outside `test/story/` after your changes.
- The drift check shows changes to in-scope files that contradict "Current state".
