# Task trash and original-record undo

Batch C / P3, 2026-09-08. Signed-in tasks now move to workspace trash instead
of being destroyed by DELETE. Open **Task trash** from the account menu, or
use the deletion toast's **Undo** action. Anonymous/offline deletion is unchanged.

## Behavior

- Migration `014_task_trash` adds optional `deleted_at` and `delete_batch`
  fields plus a workspace/trash index. Existing tasks stay active.
- A parent and its currently active, same-workspace children move together
  in one transaction. Children deleted separately retain their own batch.
- Restore updates the original rows: IDs, authorship, creation/update dates,
  notes, tags, assignment, due dates, status and recurrence markers remain.
  Restoring a parent restores children from the same deletion batch, not
  children separately deleted earlier. Restore the parent before a child.
- Owner/admin/member can restore; viewers can read trash but cannot restore.
  Actor/workspace authorization is checked inside the write transaction,
  including concurrent permission revocation. Removed-member assignments are
  cleared even while a task is in trash and are not resurrected by restore.
- Active task reads, edits, parent selection and reminder selection exclude
  deleted rows. Reminders recheck task access immediately before SMTP; an
  email already in flight cannot be recalled. Restore does not reset reminder
  attempts or recurrence markers, and does not generate a new recurrence.
- Export retains trashed tasks with their deletion fields. Account deletion
  still permanently removes the account's authored tasks/owned workspaces,
  including trash. Trash is not account recovery or an off-host backup.
- No automatic purge or permanent-delete button is introduced in this batch.
  Retention lasts until restore or account deletion. A configurable retention/
  purge policy and aggregate storage quotas remain follow-up product work.
- Trash pages are bounded to 100 records, using an opaque task-ID cursor.
  Paging is not a frozen snapshot: concurrent deletion/restoration can change
  the list; Refresh starts a new traversal. The active-task 2,000-row limit is
  still separate P4 work, not solved by trash pagination.
- Undo no longer recreates a lossy task. Failed writes keep visible data;
  duplicate clicks are suppressed, retry is explicit, and stale responses
  after logout/workspace change are discarded. Bulk parent deletion skips
  selected children already covered by that parent.
- Delete returns its batch ID. Undo and panel Restore send that expected batch
  so an old action cannot undo a newer deletion of the same task (409).

## API

- `DELETE /api/tasks/{id}`: move an active task/family to trash; existing CSRF
  and task-write rate limits apply.
- `GET /api/trash?workspace_id=workspaces:...&cursor=tasks:...`: authenticated,
  scoped `{items, next_cursor}`; cursor is optional. Private responses no-store.
- `POST /api/trash/{id}`: restore original task/family; no body required.
  Clients may send `{delete_batch: "64-character lowercase hex"}` to fence
  restoration to a particular deletion, as the UI does.
  Returns 200, or 400 for an already-active/invalid operation, 403 for denied
  access, 404 for a missing row, 409 for conflict/still-deleted parent.

## Safety gate and response walkthrough

The focused CISO review covers cross-workspace restoration (medium/high),
partial family loss or accidental resurrection (medium/high), and retained
data/availability growth (medium/high). Runtime compromise still affects all
app tenants; cost/user counts and MTTD are not quantified. No new vendor,
external backup or legal/compliance claim. Existing operator/alert/commercial
decisions remain in [the execution plan](CLIENT-READY-EXECUTION.md).

Tabletop: mistaken task deletion → restore from the correct workspace and
verify IDs/children; failed cascade → transaction leaves all rows unchanged;
permission loss → refresh membership, do not replay writes automatically;
mistaken account deletion → preserve current state and inspect a separately
restored private export, because ordinary task trash cannot undo it.

**Rollback caveat:** pre-P3 binaries do not understand `deleted_at` and would
display trashed tasks as active. Once any task enters trash, do not serve an
old binary unchanged. Stop serving if necessary and fix forward or prepare a
trash-aware rollback build. Never restore an old DB over newer customer writes.
Before the first trash write, additive migration alone permits the previous
binary as an emergency fallback. This overrides the generic binary-rollback
advice in older deployment evidence.

Before promotion: fresh private local export, separate administrator migration,
matching immutable executable/library/static files, disabled-mail canary and
local/public readiness. No production mutation tests or synthetic SMTP.

## Verification

`RUN_TRASH=1` adds isolated tests for family preservation, metadata, access,
CSRF, invalid IDs, write denial, export, failed delete/restore transactions,
separately deleted children, recurrence, concurrent restore/revocation,
removed assignees and cursor traversal over 205 records. Browser checks add
Undo, reload persistence, retry, 320px layout, keyboard focus and logout cleanup.

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_TRASH=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

The harness uses disposable RocksDB and database EDITOR credentials. It never
targets production ports or real SMTP. CI includes the new trash suite.

Final local ReleaseSafe verification passed: **48 unit + 37 smoke + 38 security
+ 15 trash + 71 browser + 17 email = 226 checks**. Formatting, JavaScript syntax
and diff checks passed. The 33,890-byte private pre-deploy export was restored
to a separate loopback DB; counts matched and migration 014 applied successfully.
No production business records were mutated by those tests. Private recovery
material for this stage is under `/var/backups/taskmanager/20260908-task-trash`.
Production promotion follows the gate above; inspect `/opt/taskmanager/current`
and the taskmanager journal for the actual active release and rollout evidence.
