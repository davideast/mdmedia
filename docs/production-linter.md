# Production linter

`mdmedia production lint` checks the plan, generated takes and assembled edit. The agent resolves findings and delivers the video. These checks belong to the production workflow; they do not add a checklist for the user.

The shared TypeScript module is exported from `mdmedia/production` and the package root. CLI and API use the same rules. Automatic Studio build gating is not wired in by this change.

## Story checks

Plans and edits require the seven existing checks (exposition, transitions, continuity, speakers, pacing, motion and sound) plus five story checks:

| Category | Evidence the reviewer must look for |
| --- | --- |
| `audience-understanding` | Viewers can explain the setting, relevant relationships, current situation and stakes before later events depend on them. Mentioning a name is not enough. |
| `causality` | Viewers can follow the cause, response and consequence. Investigations and resolutions have understandable reasons; a retrospective explanation does not automatically replace the missing dramatic middle. |
| `reactions` | Significant discoveries produce a readable response or choice before another plot turn. The response can happen within action or dialogue; it need not be a separate reaction shot. |
| `reveal-setup` | A belief or expectation exists before the reveal overturns it. A deliberate mystery can withhold the answer while still establishing the question and why it matters. |
| `story-density` | New threats, relationships, locations and resolutions leave room for motivation and response. Fast cuts and concise dialogue are fine; compressed plot summaries need fewer developments or connecting beats, not padded silence. |

These are semantic review gates, not an arbitrary shot-count or seconds-per-reveal formula. Isolated takes retain the seven original checks, judged against their assigned role. A single performance does not have to introduce the entire story.

## Review actual understanding before supplying the plan

Edit review makes two independent provider requests:

1. **Blind audience pass.** Supply only the video and review rubric. Withhold the screenplay, synopsis, cast names, expected answers and `initialFacts`. Ask for a retelling, observed facts, comprehension gaps and all five story checks, citing timestamps and repairs. Deliberately unanswered mysteries are not automatically comprehension failures.
2. **Comparison pass.** Supply the intended plan alongside the observations. Compare what the audience actually understood with the intended story. A planned explanation cannot serve as evidence that the film communicated it.

The saved review includes the original response in `observations` and structured `audience` evidence. Blind findings and uncertainties remain active even when the comparison passes. Reviews append to history; another model pass does not replace previous findings. Audience findings bind to the actual rendered bytes, so changing the title or synopsis cannot erase them.

Malformed audience evidence, missing categories, timestamps outside the video and failures without repairs cannot count as a completed blind review. Approximate model timestamps are not confirmed source speech measurements.

## Agent workflow

1. Write a version 2 plan containing facts, scenes, exact dialogue, generation takes and timeline shots. Run `production lint --stage plan` and repair structural issues.
2. Run a plan review. Trace what viewers learn, what each character wants, what changes, how they respond and what motivates the next scene. Resolve story gaps before generation.
3. For an uncertain sequence, assemble a cheap rough cut or animatic with temporary dialogue and the relevant preceding footage. Review it using `--stage edit` **before generating expensive takes**. Declare this rough sequence as the plan revision's `renderAssetId`; it is the actual video the reviewer watches. `review` can inspect that render before future generation takes exist. A rough-cut story pass does not imply final technical readiness.
4. Generate the approved takes. Use actual source frames for returning setups and actual predecessor bindings for extensions. Run `--stage takes`; silent editing handles are intentional source material.
5. Assemble the edit and record measured source speech intervals, words and speakers with their file hashes. Review the assembled sequence in context, then run `--stage edit`.
6. Repair findings and review the changed film. Deliver it for user review when the checks pass. User rejection remains independent of model assessments.

A section that relies on earlier exposition should be reviewed with that preceding footage, not a prose synopsis supplied to the blind reviewer. Rough and final renders have different hashes and require their own review evidence. Regeneration remains a deliberate action; lint never submits paid jobs or replaces accepted footage.

## CLI

From the repository root, use `bun src/bin.ts` in place of the installed `mdmedia` executable:

```sh
bun src/bin.ts production lint \
  --input plan.json --root . --stage plan --json

bun src/bin.ts production review \
  --input plan.json --root . --stage plan --output evidence.json

bun src/bin.ts production review \
  --input plan.json --root . --stage takes --take sadie-performance \
  --evidence evidence.json --output evidence.json

bun src/bin.ts production review \
  --input plan.json --root . --stage edit \
  --evidence evidence.json --output evidence.json

bun src/bin.ts production lint \
  --input plan.json --root . --stage edit \
  --evidence evidence.json --output report.json --json
```

`lint` and `feedback` are local and need no API key. `review` sends the creative plan and, for takes/edit review, the selected video to Gemini. It strips local asset paths and fingerprints from prompts and uses the production's existing sharing authorization. Review itself generates no media.

Record the user's actual feedback separately:

```sh
bun src/bin.ts production feedback \
  --input plan.json --root . --stage edit \
  --evidence evidence.json --output evidence.json \
  --message 'The story speeds up to the point where it completely falls apart.' \
  --repair 'Rebuild the ending around motivated scenes, responses and an earned reveal.'
```

This appends a `fail` finding attributed to `user` by default, with the inspected video's hash. `--verdict uncertain` records an unresolved concern; `--reviewer` sets attribution. Take feedback requires `--stage takes --take ID`. Automated review cannot erase feedback. A repaired render with different bytes needs fresh review; old rejection remains in history but does not automatically reject that different film. Plan feedback is tied to the exact plan hash.

## Readiness and findings

Reports expose independent `readiness.technical` (`valid` or `invalid`) and `readiness.editorial` (`passed`, `needs-review` or `blocked`). This allows a valid render to fail because its story is incomprehensible. Overall exit codes remain compatible:

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `ready` | Required checks and evidence pass for this stage. An edit is **ready for user review**, not automatically accepted by the user. |
| 1 | `blocked` | A technical or editorial failure needs repair. |
| 2 | `needs-review` | Required evidence is missing or uncertain. |

Each issue contains `code`, `domain`, `severity`, `at`, `message` and `repair`. Missing checks never imply a pass. Earlier seven-category evidence remains readable but cannot establish current story readiness without the five new checks and, for edits, the saved blind review.

## Production contract

See `src/production/types.ts` for complete types.

- **Facts:** `requires` must be established earlier or supplied by preceding context in `initialFacts`. `establishes` cites visible/audible evidence. A character description alone does not introduce a character.
- **Scenes:** location, current situation, dramatic purpose and orientation fact.
- **Takes:** source footage, setup, camera, visible cast, eyelines, physical states, actions, speaking turns, sound and references. Provider duration limits apply to takes rather than edited shots.
- **Shots:** source ranges, story function and motivated incoming transition. Continuations select contiguous footage, an extension of the actual ending or footage seeded from that exact ending frame. Seeded restarts remain distinct from provider extensions.
- **Assets:** files pinned by SHA-256. `--root` resolves paths, defaulting to the plan directory. Inspection hashes bytes and reads MP4/MOV metadata.
- **Speech:** actual utterance ranges, words and speaker, bound to the source hash. `estimated` intervals keep the edit in review. `confirmed` requires checking source audio rather than accepting approximate model timestamps.
- **Reviews:** evidence for each required category, `pass`/`fail`/`uncertain`, with specific repairs for failures and uncertainties. Comparison reviews bind to plan and media hashes. Blind audience evidence and user feedback also persist independently for the same media bytes.

Current pacing and action-risk evidence can resolve heuristics; resolved warnings stay in `resolvedIssues`. A review cannot waive wrong speakers, missing words, clipped dialogue, missing assets or broken dependencies.

## TypeScript

```ts
import { parseProductionPlan, inspectProductionAssets, lintProduction } from 'mdmedia/production';

const plan = parseProductionPlan(input);
const report = lintProduction(plan, {
  stage: 'edit',
  assets: await inspectProductionAssets(plan, projectRoot),
  evidence,
});
if (report.status !== 'ready') {
  // Agent repairs report.issues before delivering for user review.
}
```

`reviewProduction` accepts an injected `ProductionReviewer`; `geminiProductionReviewer` supplies the provider transport. `appendProductionReview` preserves prior reviews, speech and feedback. The existing version 1 generation compiler remains unchanged.

## Regression examples

`test/production/fixtures/breakfast.plan.json` describes the accepted 28.25-second breakfast section, with earlier context in `initialFacts`. Its legacy evidence is retained as historical evidence, not upgraded to claim a new blind pass. Media lives in the ignored `.design/beneath-double-coat/breakfast-exchange` folder.

`rushed-ending.plan.json` preserves the user-rejected 49-second ending's structure. The curated `rushed-ending.audience.json` records the failure pattern: weak family stakes, omitted rescue causality, discoveries without responses, a late death claim and too many plot turns. Tests intentionally give the comparison all passes and confirm that the audience failures still block delivery. These fixtures calibrate the checker, not a live model's accuracy. No new provider review or video generation is needed to run tests.

Run `bun test test/production`. Tests cover source integrity, measured speech, continuity, blind-review isolation, retained rejection, CLI exit codes and the rushed-ending regression.

The current contract covers native dialogue retained with source footage, one sequence of edits and MP4/MOV video. Separate narration/music placements remain outside this checker. Reports distinguish those technical checks from evidence about whether the story works.
