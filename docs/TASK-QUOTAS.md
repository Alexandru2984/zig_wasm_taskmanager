# Task quotas and bounded load exercise — P4 / D2c

2026-09-13. This batch adds configurable logical task budgets, current usage
visibility and a small reproducible mixed-load exercise. It does not finish
physical-host storage control, main-view loading replacement, retention policy,
distributed abuse prevention or commercial plan entitlements.

## Limits and semantics

| Operator setting | Default | Accepted range |
| --- | --- | --- |
| `WORKSPACE_TASK_LIMIT` | 10,000 retained task records per workspace | 1–1,000,000 |
| `WORKSPACE_TEXT_BYTES_LIMIT` | 52,428,800 bytes (50 MiB) per workspace | 1–10,737,418,240 |
| `OWNED_WORKSPACE_LIMIT` | 25 workspaces owned by one account | 1–1,000 |

These are deployment-wide defaults, not paid plans or user-controlled request
parameters. Zero, negatives, malformed and out-of-range values fail startup;
there is no implicit unlimited fallback. Configure the same values on every
writer. No database migration or cached accounting counter is introduced.

Task records include parents, children, completed tasks and retained trash.
Logical text is the sum of UTF-8 bytes of title, notes and every tag, without
JSON escaping or separators. Database/index overhead, other tables, WAL,
container storage, logs and backups are not measured or limited by this field.
The implementation exercises SurrealDB's [byte conversion](https://surrealdb.com/docs/reference/query-language/language-primitives/data-types/bytes)
on the pinned 3.2.4 server; the Zig-side delta uses the same UTF-8 byte lengths.
Calculations project row sizes before aggregation (nested aggregation is not
supported by this server).

Every ordinary task create, subtask and recurring successor counts against
its workspace, regardless of author. Unattached legacy tasks are a separate
per-user scope with the same task/text limits; other users' legacy rows never
count against or appear in that person's usage. Automatic attachment to a
personal workspace preserves existing data, even if it creates an overage.
Creating a workspace consumes its owner's workspace budget, including default
initialization; joining somebody else's workspace does not consume that budget.

Existing workspace/actor serialization fences protect quota checks in the
same write transaction, not a racy preflight request. Growth checks read the
post-write aggregate, including any successor; denial rolls back task fields,
version, recurrence marker and successor together. Concurrent requests may
return 409 conflicts instead of 422 quota denial; they are not automatically
replayed. Permissions, CSRF and task If-Match conditions remain authoritative.
Selected aggregate scans carry statement timeouts and fail closed on errors.

Existing overages are grandfathered for retained data, not for further growth.
Non-growing text changes and ordinary completion, assignment, trash/restore,
read and export remain available. Shrinking text is allowed even if usage is
still above the byte budget. Growing one dimension is checked against that
dimension's limit; merely being over the task-count cap does not prevent a
text edit that fits the text cap. A recurrence that would exceed the task or
text quota is refused atomically. To complete without a successor, explicitly
disable recurrence and save completion; nothing silently drops a recurrence.

## User recovery and operator procedure

The **Workspace usage & limits** menu reads current, authorized aggregate
counts for the selected workspace, own legacy scope and own workspace count.
All workspace members may see aggregate usage (including trash count), but no
trashed task contents, other scopes, identities or titles are returned here.
The UI marks 80% usage and reached/exceeded task/text limits, explains retained
trash and physical-storage exclusions, and offers explicit refresh. Closing,
logout, workspace change and task writes invalidate pending usage responses.
Failures clear old figures; zero is not substituted for unavailable usage.
Quota failures are 422 with actionable messages and preserve unsaved editors.

**Trash does not free a task slot.** Restore does not consume another one.
This batch intentionally introduces neither automatic nor manual permanent
purge. Users can shrink active task text or ask the operator to review capacity;
raising a limit is currently an operator configuration action, not an upgrade
purchase. Export is available, but exporting alone also does not free storage.
Do not delete an account as a casual quota workaround. A deliberate scoped
purge/retention workflow remains separate product work.

Before changing limits, inspect scoped usage and actual host free space,
backups and database growth. Preserve the private configuration and local
export, change only the intended quota settings, restart a matching release
and verify readiness/usage. Lowering values never deletes data but may refuse
future growth immediately. All application writers must share the settings;
an old binary or direct database administrator can bypass these application
checks. Runtime compromise still exposes every app tenant.

There is no global limit on all accounts, non-task tables or physical disk,
nor a claim that 10,000 full tasks fit comfortably in every browser. Aggregate
checks can scan many rows and add contention under workspace-wide writes.
The main view and export still retain full datasets in memory. Logical quotas
are defense in depth, not a filesystem quota or an unlimited-capacity promise.

## Focused CISO review and tabletop

Top threats: storage/resource exhaustion (medium likelihood/high impact),
quota bypass through concurrent or recurring creates (medium/high), and data
loss or private usage disclosure through bad quota recovery (medium/high).
Fenced growth checks, UTF-8 accounting, explicit overage preservation, scoped
aggregates and private UI cleanup address this batch. Worst-case runtime
compromise affects all app tenants; affected-user count, ALE/cost and measured
MTTD are unknown. Companion CISO quantification scripts are unavailable.

Deployment monitors readiness/restarts/errors. Quota 422 is a normal policy
outcome, not proof of compromise. Persistent growth/failure or dwindling disk
requires operator investigation; no alert destination or staffed on-call is
invented. Existing [incident response](INCIDENT-RESPONSE.md) provides containment
and an unsent customer-message template. Regulatory duties and contracts still
require the owner's actual business/legal context. No new vendor, paid service,
external backup, DPA assertion or compliance certification is introduced.

Desk walkthrough/isolated fixtures: two members race for the last slot → one
commits; recurring completion exceeds quota → parent and successor roll back;
limits fall below existing usage → preserve data and permit shrink/restore;
trash fills budget → explain retention, no hidden deletion; membership revoked
or account changed while usage loads → deny/discard private results; invalid
configuration → refuse startup and restore the previous private configuration.
This is a technical fixture and desk review, not a staffed notification drill.

## Verification and promotion

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_VERSIONS=1 RUN_SEARCH=1 RUN_QUOTAS=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

The quota fixture starts a separate application with limits of 4 tasks,
500 text bytes and 3 owned workspaces against the disposable test database.
It never targets production ports, accounts or SMTP. The mixed-load exercise
uses the ordinary-limit isolated app, 1,000 initial tasks and four concurrent
synthetic clients making 48 reads/searches/creates. Report successes, expected
conflicts/busy responses and observed latency together, not just successful
request throughput. This sample is not a production capacity or SLA guarantee.

Promotion requires passing regressions, a private pre-deploy export/config,
aggregate-only production preflight, an immutable matched release with a
mail/reminder-disabled canary, and local/public checks. No schema migration.
Rollback to `b93d401` retains version/trash semantics but removes quota
enforcement and usage API; reload browsers and reassess usage before returning
to quota-aware writes. Do not restore an old database over newer writes.
Inspect `/opt/taskmanager/current` and the journal for actual active release.

Final quota fixture: **17 checks passed**, including distinct-task concurrent
byte growth and recurrence byte overflow while task slots still remain.
The full ReleaseSafe run passed **55 unit + 37 smoke + 38 security + 15 trash +
16 pagination + 18 version + 19 finder + 71 browser + 17 quota/load +
17 durable-email = 303 checks**. A separate **9 private mail-operations checks**
also passed. Zig formatting, JavaScript/shell syntax, unique HTML IDs, stamped
asset hashes, OpenAPI YAML/references and diff whitespace were checked.

Observed mixed load: 48 requests in 3,560 ms (13.48 requests/s), p50 287 ms,
p95 457 ms, maximum 480 ms. Outcomes: 30 successful reads/searches, 14 created
tasks, 2 expected write conflicts (409), 2 search-busy responses (503).
Read failures or non-search 503s are not accepted by this fixture. This is a
small synthetic localhost measurement, not an SLA or maximum supported load.

Read-only production preflight on 2026-09-13 returned maximum retained scope
count 1, maximum scope text 15 bytes, maximum owned-workspace count 2; no scope
exceeded the proposed defaults. Only aggregates, not identities or task content,
were printed. Protected recovery material is under
`/var/backups/taskmanager/20260913-task-quotas`: a new 34,495-byte pre-deploy
export and an unchanged private runtime-config copy. No external storage was
used. Actual publication still requires the canary/promotion checks above.
