# Plan 001: Story milestone 0 — story file parser, schemas, `story check`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/story/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4eb8f62..HEAD -- src/index.ts src/cli/command.ts package.json src/chunker src/tts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (no audio, no network, no providers)
- **Depends on**: [000 design](000-design.md), sections 1, 2, 4.1, 4.3, 9, 11, 13
- **Category**: feature
- **Planned at**: commit `4eb8f62`, 2026-10-22 (replaces the 2026-10-18 plan)

## Why this matters

Every later milestone reads the parsed story. This milestone makes the story
file real, pinned by fixtures taken from the prototype, and gives the director
(milestone 3) the exact errors and warnings it loops on. The notation is the one
the prototype proved on real text: a narrator who is a cast member, a cue on
every line, scene music cues, pauses.

## Scope

In: `src/story/` with the script types, front matter parsing (including
`narrator: NAME`, `look`), body parsing (lines, narration, scenes, chapters,
pauses, music cues), the errors and the `missing-cue` warning in design 4.3,
line render keys (design 9), the `mdmedia/story` subpath, and
`mdmedia story check`.

Out: the comic script (milestone 4), audio, providers, timelines with durations
(milestone 1), the director.

## Current state

- `marked`'s lexer parses markdown elsewhere: `src/chunker/storyboard-parser.ts:1`
  imports `{ lexer, type Token, type Tokens } from 'marked'`.
- CLI commands are `citty` definitions registered in `src/cli/command.ts`.
- Subpaths are exposed through `package.json` `exports` and re-exported from
  `src/index.ts`.
- Dependencies include `marked` and `citty`; there is no YAML parser.
- Tests run with `bun test`. CI runs `bunx tsc --noEmit`, `bun run build`,
  `bun test`, `bun run verify`.
- Prototype fixtures to copy (branch `spike/story`, read-only):
  `spikes/story/embarrassing-day/story.md`,
  `spikes/story/embarrassing-day/comic-lunch-voices.md`,
  `spikes/story/lighthouse.md`.

## Decisions for this plan

1. **Add `yaml` (eemeli/yaml)**, the only new dependency, for positioned front
   matter errors.
2. **Keep `marked`**; its top-level tokens are contiguous with `raw`, so a
   running offset gives positions (step 3 proves it).
3. **Web Crypto for keys** (`crypto.subtle.digest('SHA-256')`), async.
4. **Nothing under `src/story/` imports a `node:` module**; only
   `src/cli/story-command.ts` may.

## Files

| Path | Purpose |
|---|---|
| `src/story/types.ts` | `StoryScript`, `CastMember`, `VoiceRef`, `Chapter`, `Scene`, `Line`, `Pause`, `Diagnostic`, `SourceRange`, `StoryError` |
| `src/story/source.ts` | Offset to line and column; `parseDuration` |
| `src/story/front-matter.ts` | Split and validate front matter |
| `src/story/parse.ts` | `parseStory(markdown, { path })` → `{ script?, diagnostics }` |
| `src/story/key.ts` | `lineRenderKey(line, script, provider)` |
| `src/story/index.ts` | Public exports |
| `src/cli/story-command.ts` | `mdmedia story check <file> [--json]` |
| `test/story/fixtures/` | The three prototype stories, plus one file per error and warning |
| `test/story/golden/` | Expected `script.json` per fixture |
| `test/story/*.test.ts` | Tests named in each step |

## Steps

### 1. Branch and dependency

1. Local branch `feat/story-m0` from `main`. Do not push.
2. `bun add yaml`.
3. **Verify**: `grep '"yaml"' package.json` shows it under `dependencies`.

### 2. Types and source helpers

```ts
interface StoryScript {
  schema: 'mdmedia.story.script/1';
  source: { path: string; sha256: string };
  meta: { title: string; author?: string; language: string };
  gapMs: number;
  narrator: CastId;                       // a cast id; 'NARRATOR' when the narrator is separate
  cast: Record<CastId, CastMember>;
  chapters: Chapter[];
}
interface CastMember { id: CastId; voice: VoiceRef; delivery: string; look?: string }
interface Chapter { id: string; index: number; title?: string; scenes: Scene[] }
interface Scene { id: string; index: number; title?: string; music?: string; segments: Segment[] }
type Segment = Line | Pause;
interface Line { kind: 'line'; id: string; speaker: CastId; narration: boolean; cue: string; text: string; display: string; source: SourceRange }
interface Pause { kind: 'pause'; id: string; durationMs: number; source: SourceRange }
type VoiceRef = string | { provider: 'gemini' | 'elevenlabs'; id: string };
interface Diagnostic { code: string; severity: 'error' | 'warning'; message: string; source?: SourceRange }
```

`source.ts`: `toSourceRange(text, start, end)` (1-based) and `parseDuration`
(`Ns`, `N.Ns`, `Nms`, `M:SS`, positive; anything else `undefined`).

**Verify**: `bunx tsc --noEmit`; `bun test test/story/source.test.ts`.

### 3. Tokens with positions

Lex the body with `marked.lexer`; walk top-level tokens with a running offset
starting after the front matter.

**Verify**: joining every top-level token's `raw` reproduces each fixture body
exactly. If not, STOP.

### 4. Front matter

- Missing leading `---` block: `missing-front-matter`. YAML errors: `bad-yaml`.
- Allowed keys: `title`, `author`, `language`, `gap`, `narrator`, `cast`.
  Others: `unknown-key`. Cast member keys: `voice`, `delivery`, `look`.
- `narrator` is either a string naming a cast member (the narrator is that
  character) or an object with `voice` and optional `delivery` (becomes cast
  member `NARRATOR`). A string that names no cast member is `unknown-speaker`.
- Missing `title`, `narrator` or a `voice`: `missing-field`.
- `gap` via `parseDuration`; invalid `bad-duration`; absent 400 ms. Cast ids
  upper-cased.

**Verify**: `bun test test/story/front-matter.test.ts`.

### 5. Body

| Token | Becomes |
|---|---|
| `heading` depth 1 | a new chapter |
| `heading` depth 2 | displayed only (stored as the current scene's subtitle) |
| `heading` depth 3, `hr` | a new scene |
| `code` lang `music`, before the scene's first line | the scene's `music` |
| `code` lang `music` anywhere else | error `misplaced-music` |
| `code` lang `pause` | a pause; invalid `bad-duration` |
| `paragraph` starting `**Name** *(cue)*:` or `**Name**:` | a line by Name; unknown names `unknown-speaker` |
| any other `paragraph`, `list`, `blockquote` | a narration line by `script.narrator`, `narration: true` |
| other `code`, `space`, `html` | nothing |

- A line with an empty cue: warning `missing-cue`, with the line's range.
- `text` strips inline markdown; `display` keeps it.
- Content before the first `#` forms chapter `00`; before the first `###`, scene
  `00`.
- Ids: `<chapter>/<scene>/<NNNN>-<speaker lower-case>` for lines,
  `.../<NNNN>-pause` for pauses.

**Verify**: `bun test test/story/parse.test.ts`: golden `script.json` for the
three fixtures; one test per error and for `missing-cue`. The Embarrassing Day
fixture must parse with no errors and its narration lines must be Milo's.

### 6. Line render keys

`lineRenderKey(line, script, provider)` hashes provider name and model, the
speaker's voice, the speaker's default delivery, the line's cue, the text of the
two previous lines in the same scene (with their speakers), `text`,
`meta.language` and a `RENDER_VERSION`. Returns `line:<hex>`.

**Verify**: `bun test test/story/key.test.ts`:
- editing line *n* changes the keys of *n* and the next two lines in its scene, and no others;
- the first line of a scene has no context, so editing the last line of the previous scene leaves it unchanged;
- inserting a pause changes no line key;
- changing a character's default delivery changes only that character's keys;
- the same input gives the same key twice.

### 7. Exports and CLI

1. `src/story/index.ts` exports `parseStory`, `lineRenderKey`, `StoryError` and
   the types; `"./story"` in `package.json` `exports`; re-export from
   `src/index.ts`.
2. `mdmedia story check <file> [--json]`: prints
   `file:line:col severity code message` (or `no problems`), or a JSON array with
   `--json`. Exit `1` on any error; warnings alone exit `0`.
3. Register in `src/cli/command.ts`; extension routing never picks it.

**Verify**:

```bash
bun run build
node dist/bin.js story check test/story/fixtures/embarrassing-day.md           # warnings only, exit 0
node dist/bin.js story check test/story/fixtures/errors/unknown-speaker.md; echo $?   # the error, then 1
node dist/bin.js story check test/story/fixtures/errors/unknown-speaker.md --json
```

and `bun test test/story/cli.test.ts`.

### 8. Full checks

```bash
bunx tsc --noEmit
bun test
bun run build
bun run verify
grep -rn "from 'node:" src/story && echo "STOP: node import in src/story" || echo "story is platform-free"
```

## As built (2026-10-22)

- `parseStory` is async: the source hash uses Web Crypto, which has no
  synchronous form. Callers `await` it.
- Narration paragraphs take a leading `*(cue)*`; without it, narration could
  not carry a cue and would always warn.
- `parseDuration` accepts zero (`0ms`), which the prototype used to remove the
  gap for an interruption.
- `bun run verify` needs a writable npm cache; in the sandbox, run it with
  `npm_config_cache=$TMPDIR/npm-cache`.
- In a fresh worktree, three Studio tests fail until Studio's own
  dependencies are installed (`studio/node_modules`); they pass on main.

## Done when

- The three prototype fixtures produce their golden `script.json`.
- Every error code and the `missing-cue` warning has a test.
- Key tests pass, including the context rule.
- `mdmedia story check` works from the built CLI with the exit codes above.
- Nothing under `src/story/` imports a `node:` module.
- The branch is committed locally and not pushed.

## STOP conditions

- Joined token `raw` does not reproduce a fixture body.
- A schema in this plan needs a field the design doesn't name.
- A dependency other than `yaml` seems necessary.
- `bun test` fails outside `test/story/` after your changes.
- The drift check contradicts "Current state".
