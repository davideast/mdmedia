# Studio agent instructions

## Page top bars hold only the title and critical actions

A page's top bar (the `WorkbenchPanel` header) holds the title, the page's
critical actions, and the existing navigation and right-panel toggles. Nothing
else goes there.

- **Critical actions only.** On a narration that is Copy and Play. Do not add
  a control to a top bar unless the owner asked for that exact control there.
  A new feature's per-item control goes in the right panel (the `KeepSection`
  holds pinning and retention) or in the page content; say where it went.
- **No status or loading in the top bar.** No spinners, "saving" marks,
  progress, badges or counts. Show loading in the content or the player.
- **One visual scale.** Pass actions as `HeaderActions` from
  `components/shell/header-action.tsx`: one or two `HeaderAction` objects, the
  last rightmost. `HeaderActionButton` draws every action as the same filled
  32px circle with a 16px icon; the main action (`emphasis: "primary"`) is the
  inverted fill. Never pass JSX to `actions`, and never style a header button
  by hand. `test/studio/header-actions.test.ts` fails if you do.
- **Check it.** After any top bar change, render it at phone width (about
  390px) and compare the actions side by side. The title should read as more
  than a few words, and the actions should look the same size.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
