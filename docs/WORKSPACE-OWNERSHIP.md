# P6b — controlled workspace ownership transfer

This batch stays on the existing VPS. It does not hand off the installation,
move hosts, transfer any real workspace automatically, or introduce an external
backup/provider. Subsequent [P6c archive/unarchive](WORKSPACE-ARCHIVE.md) adds
a shared write policy; ownership transfer requires an active workspace.

## User flow and consequences

The current owner opens Workspace → Members, finds an existing teammate in
the bounded directory, then chooses **Make owner…**. The confirmation shows
the name and exact user ID, requires the owner's current password and explicit
acknowledgment. Names are not unique/verified identities; check the ID.

The recipient must be an existing member with verified email and spare capacity
under `OWNED_WORKSPACE_LIMIT`. A viewer may be chosen deliberately. Transfer
is immediate after confirmation; there is no pending offer or recipient-accept
step. The former owner becomes an **admin**, not a viewer or outsider. The new
owner can remove that administrator, transfer ownership onward, and delete the
workspace by deleting their own account. Only the current owner, with their
own password, can transfer it back. There is no automatic Undo.

Transfer does **not** rewrite task authorship, assignments, versions, membership
IDs, invites or task contents. Deleting the former owner's account still
deletes tasks that account created, even inside the transferred workspace;
tasks authored by others and the workspace itself remain. This existing
account-deletion policy is stated prominently before confirmation. This is
workspace administration, not a complete transfer of authored data or a
commercial/customer handoff.

Closing a form after submission is not cancellation of a server-side transfer.
The UI clears password and acknowledgment immediately, bounds the request to
20 seconds, and suppresses duplicate in-flight submissions for that account
and workspace. On an error/timeout it locks resubmission until explicit review;
close and reopen Workspace to load current roles before making another attempt.
The password is never saved in UI state, browser storage, URLs or activity;
normal transient request memory/browser networking still contains submitted
credentials. Late responses cannot change another account, workspace or a
closed/replaced confirmation panel.

## Contract and authorization

`POST /api/workspaces/{id}/owner`

```json
{ "user_id": "users:existing_member", "password": "current owner password" }
```

Success: `{ workspace_id, owner_id, role: "admin" }`, private `no-store` response.
The role in that response is the caller's new role. Ordinary member/role APIs
still cannot grant, demote or remove an owner. CORS/CSRF/session checks apply.
Target IDs are validated as `users` records, self-transfer is refused, and the
password is bounded to 1–128 bytes. Password verification shares the existing
five-attempt/15-minute per-account budget with password change/account deletion,
not a separate password-guess allowance. This budget is process-local, resets
on restart, and is not durable distributed abuse protection.

Read-time password verification is not enough: the transaction rechecks the
verified password hash, actor verification, current owner role and `owner_id`.
It fails closed if `owner_id` and the sole owner membership do not agree. It
updates the existing account/workspace serialization fields for the actor,
recipient and workspace so account deletion, password rotation, target removal,
other transfers and workspace creation cannot commit stale independent writes.
Recipient verification, membership, quota count, both membership roles and
`owner_id` are checked/changed in that transaction. No automatic retry is used.

Two activity entries, one for each account, commit with the transfer. If either
entry fails, ownership and roles roll back too. Entries contain account ID,
action and workspace ID, never submitted passwords or member emails. Existing
activity export and account deletion apply; this is not an immutable or
indefinitely retained security audit log, nor an email/operator notification.

Errors: malformed/ineligible target or password bounds 400; unauthenticated
401 (the earlier CSRF gate may return 403); bad password/unverified caller or
non-owner 403; missing workspace 404; conflicting state 409; recipient quota
422; shared password-attempt budget 429 with `Retry-After: 900`; underlying
failure 500. Always check current state after an ambiguous response. An old
owner cannot immediately replay a transfer after becoming admin. There is no
idempotency token or global ownership revision: after being explicitly granted
ownership again, a correctly authenticated request can transfer it again.

## CISO review and response walkthrough — 2026-09-16

Top threats: privilege escalation using a stolen session/stale ownership
(medium likelihood/high impact); partial changes or account-deletion races
causing ownerless workspaces/data loss (medium/high); bypassing recipient quotas
or adding a password-guess endpoint (medium/medium). Mitigations are explicit
password confirmation, the shared attempt budget, one atomic transition,
account/workspace conflict fences and quota/negative/browser fixtures.

Worst case: a successful malicious grant controls that workspace's access and
can lead to its deletion; full application compromise still exposes all app
tenants and mail configuration. User counts, financial impact/ALE and observed
MTTD are unknown. Companion risk/compliance scripts are unavailable; no outputs
or financial/compliance assurances are invented.

Detection: account activity allows user review; isolated tests/readiness detect
regressions. Neither is a promise of automatic compromise detection. Operator
alerts and measured human response time still need an owner-selected route.
The VPS owner remains responder. No new vendor/subprocessor or notifications
are introduced; contracts, regulatory roles and notification duties depend on
the actual operation. Use the draft communication in
[INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md), filled only with confirmed facts.

Desk/technical scenarios: suspicious transfer → preserve restricted activity
and logs, check current `owner_id`/roles and sessions, revoke compromised access
and rotate affected credentials through their owner; do not blindly repeat the
request or grant ownership to an unverified support claimant. Failed transfer
→ verify ownership before retrying, with no automatic DB restoration. Account
deletion during transfer → inspect the current owner and authored-data impact
using an isolated restored copy if recovery is necessary. This is a technical
walkthrough, not a staffed notification/on-call exercise.

## Verification and rollout

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_OWNERSHIP=1 RUN_UI=1 scripts/integration_test.sh
```

Mutation fixtures use synthetic accounts, a disposable database, non-production
loopback ports and disabled mail. They cover atomic roles/activity, CSRF/RBAC,
eligibility, password guessing, quota races, account/password/member changes,
authorship cleanup and mobile/private UI state. Record results only after
completion. CI runs API and browser variants without automatic push.

No new schema or runtime setting is required. Stage matching binary, linked
library and stamped assets, then a mail/reminder-disabled canary under the
service identity. Preserve a new protected local export/config and the live
`db29de4` release. A binary-only rollback retains changed owner IDs and roles;
the previous version recognizes these existing fields, though it cannot offer
the transfer UI. Never restore a stale DB over newer writes to undo a binary
release. Do not automatically transfer production data as a deployment test.

Remaining after P6c: saved-view sync, comments/mentions, durable abuse
controls and owner-routed alerts. No off-host recovery or client handoff claim.

### Verification recorded — 2026-09-16

The final isolated ReleaseSafe run completed successfully: 37 smoke, 16
main-view, 21 team, 25 ownership (17 API + 8 browser), 38 security, 15 trash,
16 pagination, 18 task-version, 19 finder, 71 general browser, 17 quota/load
and 17 durable-email checks. Together with the separately repeated **56/56
ReleaseSafe unit tests, 366 regression checks passed**, plus **9 private
mail-operation checks**. CI includes the new suite in API/browser jobs; no
remote CI execution or push is claimed.

Ownership fixtures verify exactly one winning concurrent transfer, rollback
when the second activity write fails, the shared password-attempt budget,
recipient quota races against other transfers/creation, and concurrent member
removal, password change and account deletion. The final browser run additionally
refuses a malformed HTTP-200 success envelope; late results cannot cross a
closed panel, account replacement or logout. The 320px confirmation screenshot
was inspected, with readable wrapped IDs/warnings, password/acknowledgment
requirements and reachable controls. General UI regressions passed at
320/390/768/1440px in both themes and list/board modes.

JavaScript/shell/Zig syntax/format, YAML/local OpenAPI references, unique HTML
IDs, stamped asset hashes and diff whitespace passed. Initial fixture issues
(a missing DELETE Content-Length and the anonymous 401 expectation) were
corrected before the final run; they were not production application changes.
No dependency, schema, runtime configuration or external provider was added.

The 2,106-row pagination fixture traversed 22 pages, with the first bounded
phone page loading in 2,617 ms. Four mixed-load clients with 1,000 initial tasks
completed 48 requests in 5,953 ms: p50 435 ms, p95 844 ms, max 1,161 ms;
statuses 200:30, 201:16, bounded-search-busy 503:2. These are synthetic
localhost observations on a shared host, not an SLA or capacity guarantee.

At 15:04 UTC production was healthy, with zero unexpected restarts; runtime DB
authentication succeeded and root access was denied. The new
`/var/backups/taskmanager/20260916-ownership` contains a 34,495-byte DB export,
runtime config and previous service unit, all root-owned mode 0600 inside a
mode-0700 directory. This is local recovery material only.

Matched immutable artifacts passed a sandboxed canary on loopback port 9319,
under the `taskmanager` identity with mail/reminders disabled. `/api/ready`
succeeded; anonymous workspace reads and ownership POSTs were denied with
`no-store`. The first ad-hoc probe used `/ready`, which correctly returned
404; the corrected documented endpoint passed. Runtime config was readable,
while administrator config, Docker socket and release writes were denied.
No real workspace or user account was mutated in these checks.

Activation requires matching source/artifacts, an atomic release-pointer change,
restart of this app only, then fresh local/public health and asset checks.
Read `/opt/taskmanager/current` for the actual live release: a Git commit alone
is not deployment evidence. CISO verdict: P6b verified for this existing host,
with the explicit authorship, alerting and off-host recovery limitations above.
