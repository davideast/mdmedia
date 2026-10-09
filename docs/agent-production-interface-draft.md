# Agent driven production interface

**Status: provisional design for discussion.** Finish the current *Beneath the Double Coat* video before committing to this interface or implementing a new production architecture. Command examples below are proposals, not existing CLI commands.

The agent makes creative decisions. mdmedia provides persistent production state, reliable media operations, and evidence about their results. Studio and the CLI operate on the same production so a user can see, edit, and interrupt the work.

## Current implementation

The latest breakfast and Penny sequences were made with local scripts in `.design/beneath-double-coat`. These use mdmedia's Gemini video provider and production linter, but their orchestration, audio inspection, and edits are production-specific scripts. The latest video was saved locally and has not been imported as an editable Studio timeline.

Reusable foundations already exist:

- `src/video`: video generation, reference images, first frames, provider interaction IDs, and duration inspection.
- `src/production`: structured plans, asset inspection, linting, and review evidence.
- `src/cli/production-command.ts`: existing `production lint` and `production review` commands.
- `src/projects`: authenticated Studio project import and inspection.
- `studio/src/lib/video-job-runner.ts`: generation and continuation execution with saved job state.
- `studio/src/lib/video-export-runner.ts`: trim, concatenate, mix audio, and export.
- `scripts/studio-build.ts`: an earlier agent runner using Studio's authenticated endpoints.

The shared production workflow connecting these capabilities is unfinished. The linter validates supplied plans and evidence; it does not independently direct or produce a film.

## Production as shared working memory

A production retains:

1. **Intent:** premise, tone, audience, pacing, and project-specific constraints.
2. **Characters and places:** relationships, accepted visual references, available voice references, established geography, and current physical state.
3. **Story knowledge:** what viewers have learned, what each scene introduces, and unresolved questions.
4. **Media and edit decisions:** source takes, measured dialogue, timeline placements, audio, previews, and exports.
5. **Decisions and provenance:** why a transition exists, which footage anchors it, and which results the user has accepted.

Plans may be incomplete. Validate the prerequisites for the requested operation. Drafting a scene does not require final speech measurements; exporting its final edit does.

A generated take and a timeline placement are separate objects. Several shots can use different ranges of one performance. This preserves identity and voice across return cuts without generating a new interpretation each time.

## A flexible production loop

The agent inspects context, chooses an operation, observes the result, and revises its approach. A scene may require a new reference and several performance takes; another may need only an extension or an edit of existing footage.

For Penny, the loop was:

1. Inspect the accepted breakfast ending.
2. Identify the need to show the daughter before she speaks.
3. Establish her beside the parents in a wider composition.
4. Generate a short proof and inspect it.
5. Extract references from the accepted proof.
6. Generate separate performances and reuse them across dialogue cuts.
7. Detect unwanted audio, repair the edit, and review it in context.

This is an example of agent judgment, not a mandatory sequence for every production.

## Proposed operation interface

| Operation | Intent | Result |
| --- | --- | --- |
| Inspect | Retrieve relevant story context, references, footage, timeline, and findings | A scoped snapshot and accessible evidence artifacts |
| Revise | Apply explicit changes to the story, references, or timeline | A new revision and affected dependencies |
| Generate | Produce selected planned takes or assets | A persistent job and candidate results with provenance |
| Analyze | Examine dialogue, speakers, motion, transitions, or an assembled sequence | Measurements and specific findings with evidence |
| Assemble | Render a preview or final export | A playable artifact tied to the exact source revision |
| Job get, watch, cancel | Observe or control long-running work | Current state, progress events, partial results, and terminal outcome |

These operations should hide mechanical complexity such as frame extraction, provider payloads, file transfer, polling, and FFmpeg syntax. The agent retains control of creative choices: which references matter, what to generate, where to cut, and whether the result serves the story.

## Illustrative CLI interaction

All commands in this section are proposed.

Inspect a focused context rather than dumping the entire production:

```sh
mdmedia production inspect double-coat --sequence breakfast --json
```

```json
{
  "projectId": "double-coat",
  "revision": 12,
  "sequenceId": "breakfast",
  "ending": {
    "speaker": "bruno",
    "dialogue": "It was very good cheese.",
    "takeId": "bruno-breakfast",
    "frameAssetId": "breakfast-ending-frame"
  },
  "establishedCharacters": ["bruno", "sadie"],
  "unintroducedCharacters": ["penny"],
  "acceptedReferences": ["breakfast-master", "penny-portrait"],
  "findings": []
}
```

The agent submits structured production changes:

```sh
mdmedia production revise double-coat \
  --input penny-introduction.json \
  --expect-revision 12 \
  --json
```

The JSON describes changes to the production, not an executable program. Revision application is deterministic. A natural-language rewrite feature can use an agent to prepare these same structured changes. The change schema remains to be designed.

Generate selected takes from the saved plan:

```sh
mdmedia production generate double-coat \
  --takes penny-reveal,penny-performance \
  --request-id introduce-penny-01 \
  --json
```

```json
{
  "jobId": "job_42",
  "projectId": "double-coat",
  "inputRevision": 13,
  "status": "queued"
}
```

The runner resolves references, checks provider capabilities, orders dependencies, and saves candidates. Repeating a request ID retrieves the existing operation. Unknown provider outcomes must be reconciled before a retry can initiate another paid generation.

```sh
mdmedia job watch job_42 --jsonl
mdmedia production analyze double-coat \
  --take penny-performance --checks dialogue,speakers,motion --json
mdmedia production assemble double-coat --sequence breakfast --preview --json
```

The agent can inspect findings, revise the edit, and assemble again. Selecting a candidate for the timeline is an explicit recorded change; generation does not silently replace accepted footage.

## Evidence and feedback

Findings need a location, observation, expected condition, confidence, and accessible evidence. For example:

```json
{
  "code": "UNSCRIPTED_VOICE",
  "takeId": "penny-performance",
  "range": { "start": 3.48, "end": 3.66 },
  "observed": "Adult male voice says 'Hmm'.",
  "expected": "Penny is the only speaker.",
  "confidence": "high",
  "evidenceAssetId": "audio-excerpt-82"
}
```

The agent chooses a repair. Suggested repairs are options, not automatic creative decisions.

Keep distinct kinds of evidence:

- Deterministic checks: file integrity, source ranges, references, dependencies, and render duration.
- Measurements: speech boundaries, audible words, silence, and audio level.
- Interpretive review: identity, speaker ownership, exposition, pacing, and visual continuity, with uncertainty retained.

A linter pass means its checked conditions are satisfied. It does not prove that a film is compelling. Model review does not establish exact word boundaries by itself. Review evidence must be tied to the actual media and production revision.

## Shared state and reversible work

Accepted takes, candidates, and timeline placements have separate identities. Experiments retain the accepted version. Changes identify affected dependencies; replacing an anchor may invalidate later continuations without requiring unrelated footage to be regenerated.

Studio and CLI edits use the same revision mechanism. If a user edits the timeline while the agent works, a stale operation must return a conflict and relevant changes. Browser-local drafts cannot be the sole authority for shared production edits.

Jobs persist progress, inputs, provider interactions, outputs, attempts, and costs. Support cancellation, bounded attempts, interruption recovery, and visible partial completion. Output artifacts use stable IDs and can be downloaded or materialized locally for inspection.

## Shared implementation and Studio experience

The mdmedia production module supplies the shared implementation. Studio invokes it through authenticated server operations. A connected CLI uses those same operations. Standalone CLI execution can use the module with local storage.

Studio shows generated clips arriving on the timeline, playable previews, and concise progress such as "Checking Penny's dialogue." Detailed evidence is available when useful. The user can trim a pause, replace a line, or keep a performance, and the agent incorporates that decision on its next inspection.

The interface should expose discoverable command schemas, runtime provider capabilities, predictable error codes, and progress events. The agent should not need to guess supported parameters or write a new script for every scene.

## Questions to resolve through the remaining production

- What is the smallest useful context returned by inspection, and how should the agent expand it?
- Which revisions should be semantic operations, and which should be direct structured edits?
- How should accepted references and physical state be scoped to characters, camera setups, scenes, and episodes?
- How do dialogue measurements and editorial audio placements represent speech across a picture cut?
- Which defects can be repaired deterministically, and which need a creative choice or new generation?
- How should candidate comparison, approval, and dependent invalidation appear in Studio?
- How much orchestration belongs in a reusable operation versus the directing agent?

## Candidate first integration milestone

After finishing the video, use the existing breakfast and Penny footage to test the interface without paying to regenerate accepted material. Import source takes, references, dialogue, and exact cuts into Studio; assemble them through the shared CLI/Studio implementation; then make one targeted agent revision that appears on the same editable timeline.

The acceptance criterion is that another episode can use the same supported operations with different production data, without production-specific TypeScript programs.

## Observations from finishing the short

These are workflow evidence, not a commitment to the command design above.

- A useful revision can be much smaller than a beat. Heidi's alarm lost its final word; the repair starts from an exact frame inside the original take and replaces only its remaining performance. The interface needs source-range provenance, not just a “regenerate scene” button.
- Returning to a character often needs no generation. Bruno's question, listening reaction, denial and final interior return are different ranges of one performance. Takes and timeline placements must remain separate.
- Broad model review can miss defects or assign inaccurate timestamps. One review accepted incomplete dialogue; audio-only transcription and short independently transcribed fragments exposed it. Preserve observations, uncertainty and actual media excerpts rather than a single opaque pass/fail score.
- Repairs can be editorial. A distracting partial muzzle in an evidence insert was removed by recropping the existing source. The agent needs trim, crop, audio gain and assembly operations alongside generation.
- The agent needs to inspect a whole transition, not just each clip. The missing brother must be introduced before his fur is recognized; the estate and shed must be spatially connected before the lookalike reveal.
- This production still uses existing local provider/render helpers and JSON manifests. It does not establish that Studio and the CLI already share a production workspace. That integration remains to be designed after reviewing the finished film.
