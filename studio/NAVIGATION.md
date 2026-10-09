# Studio navigation

Variant A was selected after comparing Library navigation with document tabs.
The prototype and its measurements are preserved on branch
`prototype/studio-navigation` (stress-test commit `3f3df3f`). Production uses the
existing Studio components and authorization, with one active route and no tab strip.

- Drafts, Library, Activity, Playlists, Downloads, and Settings are stable destinations.
- Create narration starts an independent draft. Drafts are saved per account on
  this browser, including narration settings; they do not sync between devices.
- Document header pins add shortcuts to the sidebar. Each sidebar section shows
  five shortcuts; Pinned has a paginated directory and Recent retains the last
  50 opened documents. Find work (Ctrl/Command K) shows at most 20 local matches
  and links to Library search for saved media not opened on this device.
- The existing v1 workspace storage remains compatible. Its historical `tabs`
  field is now a route-state cache. The cache retains 100 recent routes, pins,
  and unfinished form edits; draft records remain independent of that cache.
- Library keeps search and cursor in the URL, and scroll and previous-page
  cursors in the workspace. Returning through the sidebar restores that view.
- Library reads are scoped to the authenticated owner, with a stable timestamp
  and document-ID cursor and at most 50 displayed narrations. Text search scans
  at most 500 records per request; **Continue search** advances through older
  work, including batches with no matches. This is bounded scanning, not a
  full-text index. A dedicated search index is the next step if search volume
  or library size warrants it.

Future media types can share these destinations and add their own creation and
viewer controls without adding another navigation rail. Current production
only exposes supported narration and playlist operations.

Verification: workspace migration and cross-window pin/edit merging; directory
pagination with 10,000 documents; search with duplicate and Unicode titles;
server pagination across tied timestamps and past the old newest-100 limit;
bounded sparse searches. Browser acceptance checks independent drafts, pins,
refresh, Find work, Library authorization, and mobile navigation.
