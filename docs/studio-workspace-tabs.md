# Route-based Studio workspace

## Scope and acceptance

All signed-in application routes use normal Next routing inside a persistent tab strip.
Only the selected page renders. Generation and the single audio player live above it.

- Deep links open/focus a tab; query changes update that tab rather than duplicating it.
- Tab selection updates the address bar. Browser Back/Forward restores the matching tab.
- Refresh restores open tabs, account-scoped drafts, unfinished form values, and scroll positions.
- Multiple drafts have independent text and voice options, identified by `/studio?draft=<id>`.
- Playlist and downloaded-item views have URLs using `?playlist=<id>` and `?track=<id>`.
- Opening a narration reads text/alignment without replacing the playing audio.
- Closing tabs never cancels generation, deletes a narration, or stops playback.
- Closed drafts remain recoverable from Studio's saved drafts list.
- Generation status and the playing item are visible on tabs without taking focus.
- Offline online tabs/actions are disabled; downloaded-item switching uses local views.
- Storage failures are visible. Work remains editable in memory.

The active URL wins over the previously active tab on initial load. Local drafts are
device-local, not cross-device share links. Refresh does not automatically resume audio
or restart generation requests. Persisted server job state is reconciled from Firestore.

## State boundaries

`WorkspaceStore` contains versioned serializable tab/view state and draft data. The
provider connects it to Next routing and flushes storage on backgrounding/page exit.
Saved snapshots merge fields changed since each window’s last save. Browser Web Locks
serialize commits across windows; a synchronous recovery journal protects edits when
refresh/page exit happens before a lock is granted. Storage events reconcile other
windows without discarding pending local edits. Browsers without Web Locks retain work
in memory and show the existing storage-unavailable warning.
URLs contain entity identity, document mode, and search filters; they never contain draft text.
`observeNarrationDocument` reads narration text and timings, with no player dependency.
Playback starts only through an explicit play/seek action.

## Rollback

Baseline: `ba907c4f3f4fac4f228df2bb1c0b1acfa7cd6321`.
Local tag: `rollback/studio-before-workspace-tabs-20260930`.
Feature branch: `feature/studio-workspace-tabs`.

The original checkout and live service are preserved. To inspect/build the old version safely:

```sh
git worktree add --detach .loop/worktrees/studio-workspace-rollback rollback/studio-before-workspace-tabs-20260930
```

To undo this feature after integrating its commits, revert those commits (or the PR's
squash commit) and rebuild using the existing staged release workflow. Do not reset or
clean the original dirty checkout. The `mdmedia.workspace.v1:<uid>` browser data is a new,
isolated storage key: the previous app ignores it and existing downloads are unaffected.

## Regression checks

`test/studio/workspace-routing.test.ts` exercises the workspace public interface for URL
identity, history, restoration, draft isolation, closing, retries, and storage/account handling.
`test/studio/narration-document.test.ts` exercises document loading and stale-request cleanup.
Additional regressions cover cross-window saves, denied subscription replay, fresh alignment
checkpoints, and acknowledgement of form saves without losing newer edits. Existing Media
Session and offline suites remain gates.

Manual browser acceptance checklist: actual tab navigation, refresh, Back/Forward,
mobile overflow, offline downloaded-item tabs, and playback while switching documents.
These checks require a connected preview browser; SDK/HTTP connectivity alone does not
verify their UI behavior.

## Hosted connection incident

On 2026-09-30 the live service at `localhost:3000` intermittently exceeded Pyric's
five-second browser attach deadline. The actual browser SDK reproduced the exact
timeout twice in ten attempts against port 3473; even bridge health requests could
take over eight seconds. The isolated preview bridge on port 3474 remained responsive.
Restarting the existing launch service with its current build restored six consecutive
attachments in 5–43ms and retained its persisted sandbox state. This is a recovery,
not proof of the underlying cause of the stalls.

`studio/scripts/check-hosted-connection.mjs` preserves the browser-transport probe.
The release and asset checks now require an SDK attachment as well as HTTP readiness.
`test/studio/hosted-connection-check.test.ts` uses real HTTP/WebSocket fixtures to
cover successful attachment with the browser Origin header, the exact timeout despite
HTTP 200, and rejection of a different project. Browser UI acceptance remains separate.
