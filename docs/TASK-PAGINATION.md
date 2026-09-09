# Task pagination — P4 / D1

Verified 2026-09-09. This is the bounded first part of P4, not completion of the whole scale plan.
It replaces the silent 2,000-row read limit without pretending that a partial
browser list is a complete workspace.

## API and compatibility

`GET /api/tasks?page=1&workspace_id=workspaces:...` returns at most 100 items,
`next_cursor` (null at the end), and `as_of` (Unix milliseconds). Follow the
cursor with the same workspace/cutoff. `limit` accepts 1–100. Task IDs are
strictly descending, independent of creation timestamp ties or edits. No
offset scan is used. A deleted cursor row need not still exist.

Every request resolves current memberships. A cursor, even one copied from
another user, grants no access. Explicit forbidden workspaces return 403;
omitting a workspace scans all currently accessible workspaces. Own legacy
rows with no workspace remain visible in an allowed workspace, as before.
Trash is excluded. Typed IDs, numeric bounds and cursor/cutoff combinations
are validated before the query; values are bound, not interpolated SQL.

`as_of` excludes later creation milliseconds. This is **not a snapshot**:
edits, removals, restores and permission changes between pages can alter the
result. Refresh starts a new traversal. The millisecond boundary uses the
[SurrealDB time functions](https://surrealdb.com/docs/reference/query-language/functions/database-functions/time).

Compatibility: unpaged callers retain the array format only when their complete
result fits in 100 rows. Larger unpaged requests now return **409** with upgrade
instructions instead of a silently incomplete array. Old browser tabs with
large workspaces must reload. Ordering is ID-descending; clients needing a
different sort apply it after traversal. New UI and versioned assets ship with
the backend. There is no database migration in D1.

Task reads have a per-user, process-local allowance of 600 requests/minute,
with 429 and `Retry-After: 60`. Invalid pagination is 400; database failure is
503, not an empty successful result. This is not durable/distributed abuse
control or a storage quota.

## Browser behavior

- Reads the selected workspace sequentially into a staging list; progress and
  Cancel are visible. Each network page has a 15-second client timeout.
- Publishes only a completed traversal. A failed/cancelled refresh preserves
  the prior complete list, labels it stale and offers explicit retry. Initial
  failure does not claim that an empty workspace was successfully loaded.
- Account/workspace changes and newer refreshes abort old loads and discard
  late responses. A local task write cancels a pending scan before sending,
  so an older staged read cannot overwrite its result. No write is replayed.
- A denied workspace page clears retained tasks. Other refresh failures keep
  the last list; server authorization remains authoritative for every write.
- Search, tags, saved views, sorting and counts operate on the full loaded
  workspace. The list and board show at most 50 parents per page; children
  paginate separately in groups of 50, with complete child progress counts.
- Page changes clear selection/edit state. Bulk actions only target selected
  visible rows, not unseen pages. Keyboard focus goes to the page status.
- Export remains independent of browser pages and includes other accessible
  workspaces plus trash. Account/task deletion behavior is unchanged.

## Focused CISO review and response walkthrough

Top threats: information disclosure via stale permissions (medium/high),
incomplete data mistaken for complete data (high/medium), and excessive read/
render work (medium/high). Page-bound membership checks, atomic UI publication,
bounded responses/rendering and a read budget mitigate this release's scope.

Worst-case runtime compromise still exposes all application tenants. User
count, financial impact/ALE and actual MTTD are unknown. The CISO companion
quantification scripts are unavailable; no values are fabricated. Readiness,
restart and error checks are available, but a designated alert destination and
tested on-call remain owner-dependent; logs are not an alerting system.

Desk walkthrough: page 2 fails → keep and label the prior complete list,
explicit retry; membership revoked after page 1 → deny continuation and clear
retained rows; workspace/logout while a read is delayed → discard its result;
faulty release → use the retained P3-aware release, never restore old database
contents over newer writes. The isolated tests exercise these browser/API
scenarios. They are not a human notification drill.

Follow [incident response](INCIDENT-RESPONSE.md), including its draft customer
message, for actual exposure. Regulatory roles and notification duties require
the owner's real business context and legal assessment. No compliance claim,
new vendor, DPA claim, paid service or external backup is introduced.

## Limits and next part of P4

The browser still retains the complete workspace in memory. Server-side
search/filter/sort, aggregate storage quotas, concurrent-load measurements and
client-version conflict UX remain D2 work. Very large workspaces may exceed
the read budget or practical browser memory; this is not unlimited capacity.
Export is still one in-memory JSON document, not a streaming export. The
existing export behavior is verified beyond 2,000 rows, not made memory-bounded.

Promotion requires the full isolated regression suite, a fresh protected local
export, a workers-disabled canary, matching immutable executable/library/assets,
and local/public readiness. Rollback to `941b7c1` preserves P3 trash semantics;
the earlier [pre-P3 rollback warning](TASK-TRASH.md) still applies.

## Verification

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

The pagination fixture creates 2,105 same-timestamp tasks (55 children), one
owned legacy row, separate-workspace and retained-trash sentinels. It checks
exact traversal, typed/bounded inputs, revocation, cutoff, removed cursor and
complete export. Browser checks cover 320px paging, whole-workspace search/
tags/saved views, board, child paging, retry, cancellation and stale responses.
Timing output describes the synthetic loopback run only, not an SLA or a
multi-user capacity benchmark. No mutation suite targets production.

Final pagination run: **16 checks passed**, 2,106 active rows traversed exactly
once in 22 pages; export contained all 2,108 authorized rows including trash
and the second workspace. Across 45 synthetic read samples, p50 was 132 ms,
p95 173 ms, maximum 611 ms (the samples include deliberate error responses
and the complete export). Full browser workspace load at 320px was 4,250 ms.
These measurements are fixture-specific, not a concurrent capacity claim.

Full ReleaseSafe verification passed: **50 unit + 37 smoke + 38 security +
15 trash + 16 pagination + 71 browser + 17 durable-email = 244 checks**.
Zig formatting, JavaScript syntax, diff whitespace, HTML ID uniqueness and
OpenAPI schema-reference checks passed. CI includes both API-only pagination
and its browser checks. Earlier fixture selector failure was corrected by
opening the saved-view panel before interacting with its controls.

Fresh protected local recovery material is under
`/var/backups/taskmanager/20260909-task-pagination`: a 34,243-byte pre-deploy
export and the unchanged private runtime configuration. No migration, new key,
external storage or production mutation test is needed for this release.
Read `/opt/taskmanager/current` and the service journal for actual promotion
state; passing tests alone do not mean a release has been published.
