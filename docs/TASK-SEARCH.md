# Global task finder — P4 / D2b

2026-09-09. **Find tasks** searches the server across currently accessible
workspaces, including subtasks and tasks not loaded in the main browser list.
It adds one-page-at-a-time discovery, not replacement of the main workspace
loader, storage quotas, full-text indexing or a finished capacity programme.

Follow-up D2c adds [logical quotas, usage and a four-client mixed-load fixture](TASK-QUOTAS.md).
Older quota/load follow-ups below are historical; main-view loading replacement,
physical/global storage control and broader capacity profiling remain open.

## Product workflow

The signed-in navigation opens a keyboard-accessible finder. Choose text,
workspace, status, priority, exact tag, assignment (any/me/unassigned), due-date
condition and sort. Submit explicitly; typing does not launch repeated scans.
Results show 50 records per page, workspace/subtask context and a short excerpt.
Previous/Next reads the requested page again; only one result page is retained.
The UI caps navigation at 200 pages and asks for narrower filters at that point.

**View current details** rechecks authorization with the scoped single-task GET
and displays escaped, read-only text. **Open in workspace** asks before
discarding dirty editors, refreshes the selected workspace, locates the parent
and child page, opens the completed section if needed, and focuses the row.
This last action still needs the complete workspace load; a failed load is
reported, never presented as successful navigation. Editing retains the
[conditional-write contract](TASK-VERSIONS.md).

Changed filters, Cancel, close, account/workspace change and task writes abort
or invalidate pending search/preview responses. Errors clear the previous
search page and require explicit retry from the beginning. Search does not
replace workspace counts, child progress, board data or unsaved editor drafts.
Terms, result data and tokens are kept only in tab memory, not browser storage,
URL parameters, activity records or an application search-history service.
Closing the finder clears its form/results. This is not durable search history.

Date-range controls interpret inclusive calendar dates in the visitor's
timezone, then send an exclusive next-midnight boundary (including DST days).
The API also supports completed tasks in a date range; overdue means active
and due before the traversal's fixed `as_of` time. Null due dates sort last.
Titles sort by lowercase Unicode ordering, not locale-specific collation;
priority is high, normal, low. Every sort has an ascending task-ID tie-breaker.

## API and safety limits

`POST /api/tasks/search` is read-only but requires the authenticated session's
`X-CSRF-Token`. JSON body examples and bounds are in [OpenAPI](openapi.yaml).
Using a body keeps private terms and cursor sort values out of ordinary URL
access logs. Application DB error logging no longer copies server error text,
which can contain bound private values. This does not configure third-party
request-body tracing; operators must keep such tracing disabled/redacted.

All query values are bound. Sort/status/assignment vocabularies are allowlists;
no supplied SQL, regex or dynamic field names are evaluated. Search is literal
case-insensitive substring over title, notes and tags; exact-tag filtering is
case-sensitive. No fuzzy, accent-insensitive, stemming or indexed full-text
search is claimed. The operations follow SurrealDB's documented
[string functions](https://surrealdb.com/docs/reference/query-language/functions/database-functions/string)
and [SELECT ordering/timeouts](https://surrealdb.com/docs/reference/query-language/statements/select),
and are tested on the pinned 3.2.4 server rather than assuming newer behavior.

Responses contain at most 100 records (50 by default), `next_cursor` and
`as_of`, with no-store caching. Retain `as_of` with `cursor: null` to revisit
the first page at the same cutoff. Each request rechecks current membership;
explicit denied workspaces fail 403. Own legacy records without a workspace
are included as in the ordinary task API; other people's legacy rows and
retained trash are excluded. Cursor tokens encode the last numeric/text sort
keys and ID, cutoff and a hash binding actor plus filters/sort/limit. They are
not encrypted, signed credentials or evidence of permission. A forged position
cannot expand the independently checked authorization scope. Changed bindings,
malformed/overlong tokens, enums or date bounds fail 400.

Creation cutoff excludes later inserts, but this is **not a snapshot**: edits,
trash/restore and permission changes can move or remove results between pages.
A removed cursor record does not break continuation. Restart Search for current
results; do not infer absence from an earlier traversal during concurrent edits.

Abuse controls: 120 searches/minute/user, separate from write and ordinary-read
budgets; 429 with Retry-After 60. At most two application searches execute at
once; busy requests fail 503 with Retry-After 1. Each DB SELECT carries a 2s
statement timeout; failures remain 503, not empty-success responses. The
browser aborts after 15s. These are process-local controls, not distributed
quotas or a guarantee that a disconnected client immediately cancels DB work.
Substring/filter/sort scans can still inspect/materialize many candidate rows.
Response and concurrency bounds do not prove constant DB memory or large-tenant
capacity. Storage quotas, indexed-query profiling and concurrent load remain
separate follow-up work. The existing full-workspace view and export still
retain their documented memory limitations.

## Focused CISO review and response walkthrough

Top threats: cross-workspace disclosure (medium likelihood/high impact), query
and cursor abuse exhausting resources (medium/high), and private terms or late
results leaking through logs/browser state (medium/high). Per-page authorization,
bound values, validated cursor context, explicit limits, body transport,
redacted DB diagnostics and request-generation fences address this batch.
Worst-case runtime compromise still exposes all application tenants; actual
affected-user count, financial cost/ALE and measured MTTD are unknown.

The companion CISO quantification scripts are unavailable. Existing health,
restart and 5xx checks are deployment signals, not an alert destination. A
sustained 429/503 increase warrants operator investigation; on-call ownership
and tested notification delivery are still owner-dependent. No new vendor,
paid service, external backup, DPA claim or compliance certification is added.
Regulatory duties depend on the owner's actual operation and legal assessment.

Desk walkthrough and isolated fixtures: revoked membership after page 1 →
continuation denied; changed query → token rejected; error on Next → clear
search results and explicitly restart; delayed result after logout/close →
discard; task deleted before preview → scoped GET denies and clears result;
expensive searches → bounded admission and timeouts, no automatic retry loop.
For actual exposure use [incident response](INCIDENT-RESPONSE.md), including
its unsent customer-message template. No real incident or staffed response
exercise was sent or claimed.

## Verification and release gate

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_VERSIONS=1 RUN_SEARCH=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

The finder fixture checks tied sorts, complete keyset traversal, all filters,
scope/CSRF, literal hostile text, removed cursor, permission revocation, request
budget, phone layout, DST, current previews, cross-workspace child navigation,
failure/retry, cancellation and private state cleanup. Fixtures use a separate
loopback database and fake users; no real account writes or SMTP are used.

Finder verification: **19 checks passed**, including browser navigation back
to the first page at the retained cutoff, dirty-editor navigation refusal,
removed-task preview and logout clearing workspace names from the finder.
The 207-task synthetic fixture produced 187 loopback samples: p50 182 ms and
p95 246 ms, including denied/empty requests and the rate-limit exercise. These
numbers are not a concurrent capacity measurement or SLA. The final navigation
CSS was also checked separately at 320/390/1440px, with no horizontal overflow
and Escape returning keyboard focus to the finder button.

Full ReleaseSafe regression run passed: **53 unit + 37 smoke + 38 security +
15 trash + 16 pagination + 18 task-version + 19 finder + 71 browser +
17 durable-email = 284 checks**. Formatting, JavaScript/shell syntax, unique
HTML IDs, asset hashes, OpenAPI references and diff whitespace checks passed.
CI includes the finder API and browser fixtures. Early fixture vocabulary and
first-page revisit failures were corrected before the final complete run.

Protected local pre-deploy recovery material is under
`/var/backups/taskmanager/20260909-task-search`: a 34,495-byte export and the
unchanged private runtime configuration. No off-host service was used.

Promotion requires passing regressions, protected fresh local recovery export,
immutable matched executable/library/assets, a mail/reminder-disabled canary,
and local/public checks. There is **no schema migration**. Rollback to the
version-aware `8bf5dbf` preserves task-write/trash protections but removes the
new search API; reload clients after rollback. Do not restore old DB contents
over newer customer writes. See `/opt/taskmanager/current` and the service
journal for actual active-release evidence; a commit alone is not publication.
