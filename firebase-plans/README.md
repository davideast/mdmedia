# Firebase improvement plans

Source: `improve-firebase` security audit of Firestore Rules, Storage Rules and Admin SDK routes, commit `ac7cd3c` (2026-09-24).
Hosted comparison: 12/12 cases matched between Pyric and the Firebase Rules Test API (`mdmedia-dev`).

| Order | Plan | Severity | Evidence | Depends on | Hosted verification | Status |
|---|---|---|---|---|---|---|
| 1 | [006 — Allowlist bootstrap & replayable regression fixture](006-allowlist-bootstrap-and-replay.md) | MEDIUM | E3 + E4 | — | Yes (creates `rules:verify:hosted`) | TODO |
| 2 | [001 — Refuse narration ids owned by another user](001-narration-id-ownership.md) | HIGH | E0 | — | No (Admin SDK path) | TODO |
| 3 | [002 — Derive Storage paths on the server](002-derive-storage-paths-server-side.md) | HIGH | E4 + E2 | — (ship with 004) | No | TODO |
| 4 | [004 — Restrict client narration writes to edited fields](004-narration-client-field-allowlist.md) | MEDIUM | E4 + E2 | — (ship with 002) | Yes | TODO |
| 5 | [003 — Owner-only Storage reads](003-storage-owner-only-reads.md) | HIGH | E4 + E2 | 006 (harness) | Yes | TODO |
| 6 | [005 — Real-user read gate](005-real-user-read-gate.md) | MEDIUM | E4 + E2 | 006 (harness) | Yes | TODO |

Why this order:
- 006 goes first because it provides the replay fixture and hosted harness that the Rules plans use for verification.
- 001 and 002 are server-only and close the two ways an allowlisted user can reach another user's data.
- 002 and 004 together remove client control over Storage paths at both layers.
- 004 and 005 both edit `firestore.modules.rules`. They can land together with a single regeneration of `firestore.rules`.

None of these plans deploy. Rules changes take effect only when you run `firebase deploy --only firestore:rules,storage` from `studio/`.

## Ledger tracking

Each plan is broken into small, machine-checked items in `.ledger/security-audit-hardening/` (26 items, governed by six new standing rules in `.ledger/rules.json`):

| Plan | Items | Standing rule |
|---|---|---|
| 001 | 01–05 | `ADMIN_WRITE_OWNERSHIP_GUARD` |
| 002 | 06–08 | `SERVER_DERIVED_STORAGE_PATHS` |
| 003 | 09–12 | `STORAGE_RULES_NO_STALE_METADATA_AUTH` |
| 004 | 13–17 | `CLIENT_WRITE_FIELD_ALLOWLIST` (+ `ELIMINATE_DEAD_CODE` for item 15) |
| 005 | 18–21 | `REAL_USER_READ_GATE` |
| 006 | 22–26 | `REPLAYABLE_REGRESSION_BOOTSTRAP` |

```bash
bun scripts/ledger.ts --dir=.ledger/security-audit-hardening                 # status
bun scripts/ledger.ts --dir=.ledger/security-audit-hardening --commit-fixes  # write receipts
```

The ledger checks text patterns only; it proves the code matches the plan, not that the fix works. Each plan's Verification section (Pyric campaign, `rules:verify`, `rules:verify:hosted`, tests) still has to pass before a plan is marked done.

## Deployment

| Order | Plan | Severity | Depends on | Ledger | Status |
|---|---|---|---|---|---|
| 7 | [007 — Deploy to Firebase Hosting + Cloud Run](007-deploy-hosting-cloud-run.md) | HIGH | 001–006 | `.ledger/deploy-cloud-run` (21 items; rules `NO_CLIENT_AI_ENDPOINTS`, `HERMETIC_DEPLOY_BUILD`, `DEPLOY_RUNBOOK_LEAST_PRIVILEGE`, `SHARE_BY_RESOLVED_UID`, `LONG_REQUESTS_BYPASS_HOSTING`, `AUTH_BLOCKING_ALLOWLIST`) | TODO (item 01 done) |

Plan 007 decisions: D1 app stores uids, D2 direct Cloud Run POST + stale recovery, D3 blocking functions.
