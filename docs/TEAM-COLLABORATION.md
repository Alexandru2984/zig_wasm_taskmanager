# P6a — team directory, assignment and workspace rename

Scope: improve the application on the existing VPS. On 2026-09-15 the owner
explicitly deferred handoff/another host. No relocation, commercial packaging,
new vendor, paid service or external backup is part of this batch.

## User workflows

- Every workspace role can open its team directory. Search by display name,
  then use Next teammates for subsequent pages; Search / refresh starts again.
- The directory exposes only display name, role and user ID. IDs distinguish
  duplicate names. Email addresses remain confined to the existing admin-only
  roster/invitation API; membership does not grant access to another workspace.
- Members can assign tasks using the inline editor. Search/pagination replaces
  one page of choices while keeping the selected assignee, even off-page.
  Existing version checks still prevent a stale assignment from overriding a
  membership removal. Viewers have no write controls or new write permission.
- Owners/admins can rename a workspace. A conflicting change preserves the
  local draft and asks for an explicit review; nothing is replayed automatically.
- Task labels use one directory page. A teammate outside it is shown as
  “Assigned teammate”; the editor retains the exact ID and can search their name.
  Display names are not unique or verified identities.

## API and limits

`GET /api/workspaces/{id}/directory?q=NAME&after=users:ID` returns
`{ workspace_id, items: [{ user_id, name, role }], next_cursor }`.
It reads at most 51 matching rows and returns at most 50. A cursor is a validated
user record ID, not authorization. Name substring search is case-insensitive,
limited to 80 UTF-8 bytes, bound as data rather than query text, and does not
search emails. Queries have a two-second data-read timeout and share the
120/minute per-account search/usage budget. Authentication and membership are
checked on every page in the same DB transaction as the projected data read.
All API responses remain `no-store`.

Ordering is by user ID, not name. Membership/profile changes are live: a newly
added earlier ID may require Search / refresh to appear. This is not a stable
roster export or a cross-request snapshot. The legacy admin roster/invitation
endpoints retain their existing response contract, including their historical
unpaged results; the new browser member directory does not use that roster.

`PATCH /api/workspaces/{id}` requires CSRF and
`{ name, expected_name }`. Names use the existing 1–120 byte validation. Current
owner/admin authority, account existence and workspace existence are checked
inside the existing shared authorization write fences. Name comparison and
update commit together. A stale name or write conflict returns 409; invalid
input is 400 and absent authority is 403. Owner, membership and tasks do not
change. This is name equality, not a global workspace revision: changing A→B→A
may again match an expectation of A. It cannot overwrite unrelated fields.
Activity logging remains best-effort and records only actor/action/workspace ID.

Directory, invitation and rename UI responses are fenced by account, workspace
and panel generation. Closing, switching or logging out clears private panel
contents, including the hidden rename expectation. Older searches cannot replace
newer ones. The editor fences lookup responses by its own instance and scope;
lookups never submit the containing task form.

## CISO review — 2026-09-15

Top threats: information disclosure across workspace/account switches (medium
likelihood/high impact); tampering via stale administrator authority or stale
rename/assignment (medium/high); unbounded directory work (medium/medium).
The response projection, bounded pages, generation checks and transaction fences
are the mitigations under test. Worst-case application compromise still exposes
all tenants in its database and its mail configuration; this batch does not
establish DB-enforced tenant isolation. User count, cost/ALE and current MTTD
are not established. Companion risk/compliance scripts are unavailable; no
quantitative assurance is invented.

Detection: isolated negative/concurrency/browser tests and release readiness
checks. These detect regressions, not every live disclosure. Automatic operator
alerts still need an owner-selected destination; the VPS owner is responder.
No new vendor/subprocessor is introduced. Provider contracts, data-controller
roles and notification duties still require the owner's actual arrangement;
no legal/compliance certification or human notification drill is claimed.

Affected-scenario desk walkthrough using [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md):
an exposed team/invite response → preserve restricted evidence, revoke affected
sessions if necessary and identify scope; a forbidden/failed rename → verify
current name and authority before retrying, never replay blindly; a faulty
release → restore the retained matching binary/assets, not an older DB export.
Technical fixtures exercise the corresponding scope changes, failures and
concurrency. They are not a staffed incident exercise.

## Verification and promotion

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_TEAM=1 RUN_UI=1 scripts/integration_test.sh
```

Fixtures create synthetic users/members/tasks in the integration harness's
disposable DB on non-production ports, with mail delivery disabled. The fixture
contains more than two directory pages, negative RBAC/CSRF/input cases,
concurrent renames, injected rollback and permission-revocation races, and
320px browser/draft/private-state checks. CI enables API and browser variants.
Recorded checks and pre-promotion evidence are below.

No migration or runtime configuration change is needed. Publish matching
executable, library, HTML/JS/CSS and stamped URLs together. Take a new protected
local export/config copy before promotion; retain `a4c4485` as the live binary
rollback target. Old code understands renamed workspaces and the existing
schema, but lacks this directory/rename UI. A binary rollback must not restore
the database over newer task or workspace writes.

Subsequent [P6b controlled ownership transfer](WORKSPACE-OWNERSHIP.md) adds a
separate password-confirmed flow; ordinary role/remove controls still cannot
modify the owner. [P6c archive/unarchive](WORKSPACE-ARCHIVE.md) pauses content
writes and new invitations while retaining authorized access management.
Remaining P6/P7: saved-view sync, comments/mentions and notification preferences.
No client handoff is scheduled.

### Verification recorded — 2026-09-15

The full isolated run passed 37 smoke, 16 main-view, 20 initial team, 38
security, 15 trash, 16 pagination, 18 task-version, 19 finder, 71 general
browser, 17 quota/load and 17 durable-email checks. With 56 ReleaseSafe unit
checks this was 340 checks. The final asset run repeated **37 smoke + 16
main-view + 21 team + 71 browser = 145 checks**, including the additional
account-replacement case and a valid delayed minimal-directory payload.
ReleaseSafe unit tests passed again. This is 341 distinct regression checks
across these runs, plus 9 separate private mail-operation checks. CI is
configured, but no remote CI run or push is claimed.

The first browser run caught an off-page assignee being lost when the editor
was rerendered. The corrected editor rebuilds the current draft's selected
option, and the final fixture verifies both rerender and a subsequent search
without losing the assignment or notes. Reopening a rename conflict now reads
fresh server metadata rather than reusing the old switcher name.

Browser fixtures covered 320px team views, literal markup display without
execution, read-only viewer controls, explicit errors/retry, draft retention,
late directory/invite responses, workspace changes, logout and account
replacement. General regressions covered 320/390/768/1440px, light/dark and
list/board. The team mobile screenshot was inspected. JavaScript/shell/Zig
syntax/format, YAML/local OpenAPI references, unique HTML IDs, stamped asset
hashes and diff whitespace were checked. No new dependency was added.

The 2,106-task fixture traversed all rows in 22 pages; its first 50-parent
phone page loaded in 2,296 ms. The mixed-load fixture used four clients and
1,000 tasks: 48 requests in 3,817 ms, p50 316 ms, p95 514 ms, maximum 559 ms;
statuses 200:27, 201:13, 409:3, bounded-search-busy 503:5. These are localhost
observations on a shared host, not an SLA or maximum capacity guarantee.

At the 20:09 UTC preflight production was healthy, with zero unexpected
restarts, and runtime DB authentication succeeded while root access was
denied. `/var/backups/taskmanager/20260915-team` contains a fresh 34,495-byte
export, runtime configuration and previous unit, all root-owned mode 0600 in
a mode-0700 directory. This remains a local backup only. The matched immutable
staging artifacts passed a sandboxed canary on loopback port 9318 under the
`taskmanager` identity, with mail/reminders disabled, readiness successful and
private unauthenticated API reads denied with `no-store`.

The production activation gate remains matching source/artifacts, atomic
release-pointer change, restart of this app only and fresh local/public checks.
Read `/opt/taskmanager/current` for the actual live version; Git HEAD alone is
not deployment evidence. CISO verdict: P6a verified for this existing host,
with the alerting/off-host recovery and remaining-product limitations above.
