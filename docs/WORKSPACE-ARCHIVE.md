# P6c — workspace archive and unarchive

Scope: the existing VPS only. No client handoff, new host, paid storage or
external backup. Archive pauses ordinary workspace changes; it is not an
immutable snapshot, legal hold, deletion protection or a storage-saving purge.

## Product behavior

Open Workspace settings and choose **Archive workspace…**. Owners and admins
can archive/unarchive; members and viewers cannot. Confirmation describes the
consequences before the request. Archived spaces remain in the switcher with
an `[Archived]` label and a read-only banner. Reads, search, CSV/account export,
the directory, usage and trash inspection remain available to existing members.

| Operation while archived | Policy |
| --- | --- |
| Create/edit/toggle/delete tasks, subtasks and recurring successors | Refused in the mutation transaction |
| Restore trash | Refused; retained trash remains readable and counted |
| Rename or transfer ownership | Unarchive first |
| Create/accept invitations | Refused; unaccepted invitations are cancelled on archive |
| Change roles, remove members, revoke invitations | Still available to authorized administrators |
| Personal saved views | Current members may read/save their own preferences; not task content |
| Account export/deletion and assignment cleanup | Existing rules continue to apply |
| Reminder discovery and pre-SMTP validation | Skip archived workspaces |
| Delivery bookkeeping after SMTP started | May still advance; in-flight email cannot be recalled |

Archive changes no task titles, authors, assignments, versions, recurrence,
due dates or ownership. All retained tasks/text and owned workspaces still
count toward quotas. Account deletion can still remove owned workspaces and
authored tasks; member removal can still clear assignments and advance task
versions. Own legacy tasks without a workspace are not archived by this action.

All unaccepted workspace invitations, including expired ones, are removed in
the archive transaction. Corresponding pending/processing outbox jobs become
cancelled and their encrypted payload, secret hash and lease are cleared.
Accepted invitations and existing members are preserved. Unarchive does not
restore cancelled invitations: administrators must send new ones deliberately.
Already delivered or in-flight invitation links cannot grant access after
cancellation. Email itself cannot be recalled after sending starts.

Unarchive resumes normal editing and reminder eligibility, including overdue
reminders under the existing policy. It does not reset reminder counters or
produce a recurrence backlog. Reminders still use the existing non-durable
worker, not the transactional account-email outbox; there is no exactly-once
delivery claim or complete multi-worker reminder deduplication.

The UI retains unsaved task drafts in memory and disables their Save button
when an archive is discovered. No draft is saved automatically after unarchive.
A stale tab's writes are rejected by the server and update its read-only state.
Archive requests have a 20-second timeout, a duplicate-submit guard and strict
success-envelope checks. Ambiguous failures/conflicts require closing and
reopening settings to read current state; there is no automatic write replay.
Closing the panel or timing out cannot undo a request already accepted by the
server. Late responses cannot publish into a closed panel or another account.

## API and transaction boundaries

`POST /api/workspaces/{id}/archive`

```json
{ "archived": true, "expected_version": 0 }
```

Returns `{ id, archived, archive_version }`. Use `archived: false` to unarchive.
`GET /api/workspaces` and account export include `archived` and
`archive_version`; legacy values read as false/zero. The lifecycle revision
advances only on archive/unarchive, not every task write. Expected revisions
are integers from 0 through 9007199254740990. A stale revision or request for
the already-current state returns 409, including after an archive/unarchive
cycle. The browser verifies the returned ID, state and exact next revision.

The existing per-account task-write budget (60 attempts/minute) is shared by
archive changes; it is process-local and resets on restart. Session, CSRF,
typed record-ID validation and method enforcement still apply. Errors: 400
invalid input, 401 unauthenticated, 403 insufficient role/CSRF, 404 unavailable
workspace, 405 wrong method, 409 concurrent/stale/no-op change, 429 write budget
with `Retry-After: 60`, 500 failed/uncertain operation. Ordinary content writes
in an archived space return 423 after checking authorization. Private responses
remain `no-store`; an outsider's single-task read remains a non-disclosing 404.

Archive shares account/workspace serialization writes with task mutations,
membership changes, ownership transfer and account deletion. Snapshot reads
alone would not prevent a previously authorized concurrent writer from
committing afterwards. Active-workspace checks run inside protected mutations,
after role checks. The lifecycle update, pending-invite removal, mail cleanup
and activity entry are one transaction: an activity or cleanup failure rolls
back all of them. These entries use the existing per-account activity feed,
not an immutable administrator-wide audit log or automatic security alert.

## Schema, upgrade and rollback

Migration `016_workspace_archive` adds `archived`, `archive_version` and optional
`archived_at` to workspaces. Runtime startup requires that migration; the serving
database identity must never acquire migration rights. No normal runtime setting
needs changing. `REMINDERS_PROCESS_ONCE=1` is an operator/test one-shot mode:
it processes one eligible reminder batch and exits, so do not set it on the
serving service. Tests use only local TLS SMTP fixtures, never production SMTP.

Take a new protected local DB/config export, migrate a separate restored copy
first, then apply the migration using the administrator identity in migrate-only
mode. Stage matching executable, library and stamped assets, and use a restricted
canary with both workers disabled before promoting only this app.

**Do not roll back to a pre-016 binary while any workspace is archived.** The
previous `d5d34db` executable ignores archive state and would re-enable writes
and reminders. Retain it as evidence/pre-activation fallback, not an unconditional
rollback target. After archive use, prefer an archive-aware fix-forward release
or stop serving while recovering. A deliberate return to old code requires a
maintenance window, stopping all writers/workers, verifying no archived spaces
remain and explicit review of the policy change. Do not silently unarchive
customer spaces or restore an old DB over newer writes.

Portable image/helper compatibility is bumped to schema family 016 so tooling
does not mislabel this executable as rollback-compatible with family 015.
Existing family-015 installations are refused, not automatically upgraded.
Other-host packaging and cross-family portable migration remain deferred.

## CISO review and response walkthrough — 2026-09-17

Top threats: stale authorization permits writes after archive (tampering,
medium likelihood/high impact); pending invitations resurrect access or send
after a pause (elevation/disclosure, medium/high); an older rollback binary
silently removes read-only protection (tampering, medium/high). Atomic guards,
monotonic lifecycle revisions, invite cancellation, pre-SMTP checks and the
explicit compatibility gate address these boundaries.

Worst case: a compromised administrator can disrupt a workspace and cancel its
pending invitations; account deletion remains destructive. Full runtime/DB
compromise exposes all application tenants and SMTP configuration. Affected
counts, financial loss/ALE and measured MTTD are unknown. CISO companion scripts
are unavailable; no risk calculation or compliance assurance is invented.

Activity, readiness and regression tests help investigation, not automatic
compromise detection. The VPS owner remains responder; an external alert route
and measured on-call response still require the owner's choice. No new vendor
or subprocessor is introduced. Applicable notification windows, roles and
contractual commitments depend on the actual operation; use only confirmed
facts in the [incident communication template](INCIDENT-RESPONSE.md).

Desk scenarios: mistaken archive → inspect current lifecycle version, unarchive
through the confirmed flow, resend only intended invitations; suspicious archive
→ preserve restricted logs/activity, verify sessions and current roles, revoke
compromised access; failed migration/deployment → preserve current DB, verify
016 and archived counts before choosing an archive-aware recovery; late email
→ distinguish in-flight delivery from an accepted grant and confirm the token
is invalid. This is a technical/desk walkthrough, not a staffed alert or legal
notification exercise. Production activation remains gated on completed tests,
restored-copy migration and canary evidence recorded below.

P6 follow-up: [private saved-view synchronization](SAVED-VIEWS.md). Comments/mentions,
notification preferences, durable abuse controls and off-host recovery remain
separate work, not claims made by this batch.

## Verification and pre-promotion evidence — 2026-09-18 (Bucharest)

393 distinct regression checks passed across the final isolated runs: 57 unit,
37 smoke, 16 main-view, 21 team, 25 ownership, 23 archive (15 API / 8 browser),
38 security, 15 trash, 16 pagination, 18 version, 19 search, 71 general browser,
17 quota/load and 20 durable-email checks. Another 9 private mail-operator
checks passed. Repeated suites are counted once, not as extra coverage.
Tests used disposable loopback databases and local TLS SMTP fixtures, not real
accounts or production email. Mobile archive was inspected at 320px; general
browser coverage includes 320/390/768/1440px and light/dark list/board views.

The first broad run stopped on an old race fixture that demanded account
deletion always win against task creation. The corrected fixture accepts a
verified conflict with intact account/task state, then tests a separate explicit
deletion. The final security run passed 38/38; no automatic production retry was
added. Testing also found that the new reminder one-shot key needed registering
in configuration; a unit check and the final SMTP pause/resume scenario cover it.

Logs: `/tmp/taskmanager-archive-full-20260917.log` (earlier suites and the
fixture failure), `/tmp/taskmanager-archive-final-targeted-20260917.log`
(archive/browser/mail) and `/tmp/taskmanager-archive-final-regressions-20260917.log`
(corrected security and remaining suites). These are local transient evidence,
not a durable monitoring or audit-log service. Synthetic search: 187 samples,
p50 212ms / p95 278ms; mixed load: four clients, 1,000 tasks, 48 requests,
p95 446ms with expected conflict/busy responses. Neither is a capacity/SLA claim.

Fresh protected recovery material is under
`/var/backups/taskmanager/20260918-archive/` (0700 directory, 0600 files).
The 34,495-byte pre-deploy DB export matches the earlier verified snapshot.
It was restored again into an authenticated disposable SurrealDB 3.2.4 instance;
migration 016 and its idempotent rerun preserved all nine application tables,
with existing workspaces active at archive revision zero. Only that disposable
instance was removed; protected backups and the preceding release are retained.

Migration 016 was then applied live in administrator migrate-only mode with
both workers disabled. Runtime remains database-scoped with root access denied;
all existing workspaces were verified active at revision zero. No normal runtime,
proxy, Cloudflare or other application's configuration changed.

The root-owned immutable stage has executable SHA-256
`c02b8d8e0e780b3db1e18b1a709583e899fc5b4b6fe44ce8155f43be23c33d07`.
Restricted canary `taskmanager-canary-archive-20260918` on loopback 9320 passed
readiness, exact stamped assets, CSP, private 401/no-store and a read-only 390px
browser check, with zero restarts and both workers disabled. Runtime config was
readable, but Docker socket, administrator config and executable writes were
denied inside its namespace. An initial loopback-Origin probe correctly hit
CSRF 403; the configured public-Origin probe confirmed the authentication 401.

Zig/JS/shell format/syntax, YAML/OpenAPI references, HTML asset stamps and diff
whitespace checks passed. The portable family-015 refusal was checked before
image selection or mutation; no new-host installation is claimed. CISO verdict:
pre-promotion gates passed for this bounded batch. Public cutover and post-cutover
read-only checks follow the commit; the pre-016 rollback warning still applies.
