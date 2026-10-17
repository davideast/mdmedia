# Studio agent instructions

## Page headers hold only the essentials

A page header (the `WorkbenchPanel` top bar) holds the navigation toggle, the
title, at most two actions, and the right-panel toggle. Nothing else.

- Pass actions as `HeaderActions` (`components/shell/header-action.tsx`): one or
  two `HeaderAction` objects, the last rightmost. The type allows no more, and
  `HeaderActionButton` draws every one at the same size, so the row stays
  aligned. Never pass JSX to `actions`; `test/studio/header-actions.test.ts`
  fails if you do.
- Only actions someone needs on nearly every visit belong there, such as Play
  and Copy on a narration. Mark the main one `emphasis: "primary"`.
- Everything else, including pinning, retention, sharing, playlists and
  settings, goes in the right panel. The `KeepSection` there already holds
  pinning and retention.
- Do not add header controls as a side effect of other work. If a feature needs
  a per-item control, put it in the right panel and say where it went.
- Check the header at phone width (about 390px) after any change to it: the
  title should still read as more than a few words.
