# Parked Studio video and production work

Parked on 2026-10-08 for unrelated work on `main`. This is a local work-in-progress checkpoint, not a release or a published PR.

## Workspaces

- Video feature: `/Users/davideast/repos/davideast/mdmedia`, branch `feature/studio-video-generation`.
- Separate main checkout: `/Users/davideast/repos/davideast/mdmedia-main`, branch `main`.
- Backup snapshots: `/Users/davideast/repos/davideast/mdmedia-video-backups/`. Each snapshot records the exact checkpoint commit and archive checksums in `manifest.json`.

The main worktree shares Git history with the original checkout but has its own working files. Keep the original checkout: it owns the shared Git directory and retains the existing local media, environment, and dependencies. Local environment files and dependencies are not automatically installed or copied into the new main worktree.

## What is preserved

The checkpoint includes all current non-ignored source changes, tests, scripts, documentation, and drafts. It also explicitly tracks `.design` source files, Markdown, prompts, and JSON production data even though the directory is generally ignored. Binary production assets remain ignored.

The separate `.design` archive excludes every `.mp4` file, as requested. Other existing files, including reference images and audio, are retained. Existing MP4s remain in the original directory; they are not deleted or included in the backup. Restoring the archive alone will not restore rendered videos or source video takes.

Secrets, dependency directories, caches, and local environment files are not newly added to the checkpoint. Nothing is pushed or published.

## Current feature scope

- Studio navigation separates media generation forms and supports video briefs, script review, scene direction, beat tracks, assets, preview, and export.
- Script-to-timeline planning, reference footage, generation jobs, continuation controls, generation feedback, and explicit hard-cut/transition choices.
- Shared production plan, lint, evidence, review, and feedback modules in `src/production/`, with CLI integration in `src/cli/production-command.ts`.
- Project import support in `src/projects/`, `src/cli/project-command.ts`, and Studio project routes.
- Agent interface design remains a local proposal in `docs/agent-production-interface-draft.md`; production experiments do not yet constitute a complete shared Studio/CLI agent workflow.

## Latest Berner production

- Screenplay: `drafts/beneath-double-coat/mystery-revision.md`.
- Production directory: `.design/beneath-double-coat/mystery-revision/`.
- Planning and generation: `sequence.json`, `generation-jobs.json`, `production.plan.json`, and per-take receipt JSON files.
- Editing: `final-edit.json`, `speech-windows.json`, and `the-secret-in-the-snow-revised.edit.json`.
- Review and disposition: `production-summary.json`, `final-review.evidence.json`, `production.final-report.json`, and the retained raw review files.
- Latest existing film: `the-secret-in-the-snow-revised.mp4`, approximately 2:57. This MP4 is intentionally excluded from the backup.

The accepted 73-second breakfast opening is followed by three connected scenes: remembering Sebastian, Heidi investigating a familiar scent, and the family assessing the fur before an outside lookalike reveal. Confinement, overheating, and rescue were deferred to avoid compressing too many plot turns.

All five blind story checks passed. A later full-film quality review passed seven media checks. The raw linter still records earlier speaker-misattribution failures and the deliberate unanswered identity question: its current model cannot adjudicate a false positive. `production-summary.json` preserves the conflicting evidence and the independent Sadie identity comparison; do not silently erase failures or claim the raw linter is green.

## Where to resume

1. Resume in the video feature checkout; inspect the checkpoint and this note before making changes.
2. Read `docs/agent-production-interface-draft.md` and `docs/production-linter.md` for the proposed agent interface and implemented checks.
3. Consult the latest production manifest and review summary before regenerating anything. Earlier `mystery-finish` footage was rejected for rushing the story.
4. Keep generations and edits evidence-based: establish characters and setting, motivate transitions, preserve identity across cuts, and explicitly assign each spoken line to the visible speaker. Continuations inherit prior footage; fades remain an explicit editing choice.
5. Consolidate reusable production operations into the shared mdmedia API and CLI before expanding Studio integration. Existing experiment helpers include `.design/beneath-double-coat/breakfast-exchange/generate.ts` and `render.ts`; some later orchestration ran from temporary `/tmp` scripts that are no longer present. The saved manifests and edit decisions are durable, but those transient helpers are not a supported public API.

This checkpoint preserves work as it stands. No fresh application test suite is implied by creating it. The prior recorded production checks passed; the broader suite had unrelated failures that should be reassessed when implementation resumes.

## Restore the non-video assets

Use the `manifest.json` in the matching backup snapshot to identify its commit, archive, and checksums. The snapshot README contains exact restore commands. Restore into a fresh directory or inspect existing files first rather than overwriting newer production work. The archive intentionally contains no MP4s.
