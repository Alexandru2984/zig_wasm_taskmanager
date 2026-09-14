# Bounded main workspace view — P4 / D2d

2026-09-15. The signed-in main list and board now read one server page instead
of traversing every task into browser state. Anonymous/WASM behavior stays local.
This changes the main browser collection, not database storage quotas, an entire
browser memory guarantee, or a streaming account-export implementation.

## User workflow

- The main task collection holds at most 50 parents plus one expanded child
  page of at most 50 children. Opening another parent replaces the child page;
  closing, changing filters or changing workspace discards it. Child progress
  comes from scoped server aggregates, not from the visible children alone.
- Search, filters, exact tags, saved views and five sorts run on the server.
  Typing is debounced by 250 ms. Old-filter rows are cleared before loading;
  a failed filter request cannot masquerade as an empty successful result.
- Workspace counters cover all active roots, including completed roots and
  the user's own unattached legacy roots, independently of text/tag filters.
  They exclude children and trash; this intentionally differs from quota usage.
  Board badges explicitly describe the current page, not whole-column totals.
- The list retains its active-before-completed ordering. Title ordering uses
  the server's lowercase Unicode ordering, not browser locale collation. Ties
  use task IDs. The board groups the same bounded page by status.
- The 50 most-used tags are shown. An explicit notice and exact-tag field make
  other tags reachable without downloading an unbounded facet list.
- Previous/Next retain bounded positional tokens, not task payloads. Each root
  or child traversal is capped at 200 browser pages; use narrower filters if an
  operator raises quotas beyond that practical UI bound.
- Unsaved edits require confirmation before page/filter/editor navigation.
  Refresh preserves a dirty editor and its original conditional version. If its
  row has moved out of the page, the prior page stays explicitly stale until
  the draft is resolved; no silent discard or automatic write replay occurs.
- The global finder opens a focused parent/child view directly, including a
  child beyond the first child page. A visible notice and Back to all tasks
  action distinguish that focused view from the workspace list.

Ordinary read failures retain only the previous same-context page with a stale
notice. Denial clears private rows, totals and related state. Root, child and
export requests are aborted/fenced across logout, account/workspace changes,
newer reads and local writes. Counts are unavailable (`—`), not invented zero,
before the first successful view. External writes can make any displayed page
stale; refresh is explicit, not live synchronization.

## API and query controls

`POST /api/tasks/view` is authenticated, read-only, CSRF-protected and no-store.
The JSON body contains `query` (the finder filter vocabulary with a required
workspace and limit 1–50), optional `parent_id`/`focus_id`, `active_first`, and
the visitor's `today`, `tomorrow`, `upcoming` Unix-millisecond boundaries.
Boundaries must increase, fit the supported date range and span at most 10 days.
The UI computes local calendar boundaries, including 23/25-hour days.

The response has `items`, `next_cursor`, `as_of`, `matched`, `counts`, `tags`,
`tags_more` and `children` progress records. Counts/tags cover unfiltered roots;
child requests instead return null counts and empty facets. Focus narrows the
requested roots/children without expanding authorization. Parent reads require
an active, accessible, top-level parent and the same workspace (or own legacy
scope). Foreign legacy and cross-workspace linked children are excluded.

One read transaction checks membership and calculates rows/aggregates together.
The *traversal* is not a snapshot: each page rechecks current membership and
can observe later edits/deletion/restore. `as_of` excludes later creation.
Tokens bind actor, filters, root/child/focus mode, calendar boundaries, sorting
and page size. They are positions, not signed authorization credentials; all
values are bound independently in SQL. Old finder tokens still parse with a
default zero completion bucket; main-view tokens cannot cross into finder or
another hierarchy context.

View/finder/usage share 120 requests/minute/user. View/finder share two active
query slots; busy is 503 with Retry-After 1, quota is 429 with Retry-After 60.
Selected DB scans time out after 2 seconds and the browser aborts after 15
seconds. Scans, sorting and aggregation can still inspect/materialize many DB
rows; this is not constant database memory or distributed abuse protection.

SurrealDB 3.2.4 fixtures verify [record-link traversal](https://surrealdb.com/docs/reference/query-language/language-primitives/record-links)
and [SELECT/group/split semantics](https://surrealdb.com/docs/reference/query-language/statements/select).
In particular, direct SELECT expressions in IF blocks unwrap single-row
arrays; array-valued facets/progress therefore use standalone LET subqueries.
Tag splitting names the source field and excludes empty arrays before grouping.

## Complete CSV, not an accidental page export

Signed-in CSV downloads traverse the existing scoped GET task pages only when
requested. They include all accessible active tasks/children in the selected
workspace plus own legacy tasks, regardless of visible filters, not trash or
other workspaces. No partial file is downloaded after a page error or cancel.
The same button cancels; logout/workspace change/local writes cancel as well.
The UI retains CSV text temporarily, bounded to 64 MiB and 100,000 task records,
not every task object in `state.tasks`. Larger exports require operator help.
The separate JSON account export still has its existing full-document memory
limitations. Neither CSV nor JSON is a frozen snapshot of concurrent edits.

Formula-like leading CSV cells receive a text prefix before delimiter quoting;
fixtures cover `=`, `+`, `-`, `@` and tab-leading content. This is a download
mitigation, not a promise that every spreadsheet's import/re-export rules are
safe. Treat externally supplied spreadsheets as untrusted.

## Focused CISO review and response walkthrough

Top threats: cross-workspace disclosure through hierarchy/cursors (medium/high),
incomplete exports/totals mistaken for complete data (high/medium), resource
exhaustion and stale private browser responses (medium/high). Bound scopes,
response sizes and concurrency; retain explicit unavailable/stale states;
cancel late publication; test complete export and safe draft navigation.
Worst-case runtime compromise still affects all application tenants. User
count, ALE/cost and measured MTTD remain unknown; companion quantification
scripts are unavailable. No invented financial/compliance assurance.

Desk/fixture walkthrough: deny a later page after revocation → clear private
state; refresh while editing → keep draft/version; change workspace during a
read/write → discard old results; fail CSV page 2 → no partial file; delete a
searched parent → refuse focused navigation; empty/single-row aggregates →
stable response types, never an internal-error success substitute. Use the
[incident runbook](INCIDENT-RESPONSE.md) for containment and the unsent message
template. No vendor, paid backup or external notification was added. On-call,
alert delivery, legal roles and contracts remain owner-dependent.

Detection/response gate: `check_health.mjs` fails on unavailable readiness or
metrics, failed mail jobs and pending/processing mail older than 300 seconds.
Promotion also checks service restarts and browser exceptions. These are
operator-run deployment checks, not automatic compromise detection. The
existing five-minute notification target is not measured MTTD; scheduling,
alert routing and the VPS owner's human response remain unverified. No new
subprocessor is introduced, and existing vendor contracts/notification duties
are not certified by this review. Verdict: ship only after the regression,
private local backup, sandboxed canary and matched-artifact gates below; do
not describe this stage as complete disaster recovery or commercial readiness.

## Verification and publication gate

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_MAIN_VIEW=1 RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_VERSIONS=1 RUN_SEARCH=1 RUN_QUOTAS=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
node scripts/mail_ops_test.mjs
```

No migration or private configuration change is required. Before publication:
passing regressions, fresh private local export/config, an immutable matched
executable/library/assets (including `task-view.js`), a disabled-mail/reminder
canary under the service identity, then local/public readiness and browser
checks. Rollback to `80853b0` preserves quotas, versions and trash but removes
the new view endpoint; restore matched assets and reload clients. Never restore
an old DB export over newer writes for a binary-only rollback. Check the actual
active release via `/opt/taskmanager/current`, not just Git HEAD.

## Verification recorded — 2026-09-15

ReleaseSafe: **56 unit + 37 smoke + 16 main-view + 38 security + 15 trash +
16 pagination + 18 version + 19 finder + 71 browser + 17 quota/load +
17 durable-email = 320 regression checks**. The separate private mail-operations
suite passed **9 checks**. After the final member-label response fence and
logout/account-change cleanup, the 37 smoke, 16 main-view and 71 browser checks
were rerun successfully against the final assets. This includes both retained
and delayed private member names, not only task payloads.

The full-run synthetic 2,106-task fixture loaded its first 50-parent browser
page in 2,730 ms at 320px; GET traversal still returned all 2,106 rows across
22 pages. Mixed load: four clients, 1,000 initial tasks, 48 requests in 3,206 ms
(14.97 requests/s), p50 251 ms, p95 387 ms, maximum 414 ms; statuses 200:30,
201:14, 409:2, search-busy 503:2. These are shared-host localhost observations,
not an SLA or maximum supported capacity. Browser checks cover 320/390/768/1440px,
both themes and list/board; mobile/board fixture screenshots were inspected.

Zig formatting/build, JavaScript/shell syntax, HTML IDs and asset hashes,
OpenAPI YAML/local references and diff whitespace were checked. CI runs the
new fixture in both API-only and browser jobs. No dependency was added.

Fresh recovery material is in the root-only
`/var/backups/taskmanager/20260915-main-view`: a 34,495-byte pre-deploy DB export
and runtime-config copy, both mode 0600. Production preflight reported healthy,
zero unexpected service restarts, and runtime DB authentication with root
access denied. The existing unit was unchanged. This backup is local only;
publication still requires the canary and public checks described above.
