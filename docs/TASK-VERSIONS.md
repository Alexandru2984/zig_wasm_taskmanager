# Task versions and conflict recovery — D2a / P4

2026-09-09. This closes stale-task overwrite/replay within the application's
task APIs. It is not completion of P4's server-side search, quotas or capacity
work, and it does not add offline synchronization or an edit-history service.

## Contract and compatibility

- Migration `015_task_versions` adds a server-controlled integer `version`.
  Existing records without the field are read as version 0. Values are bounded
  to JavaScript's exact integer range; clients cannot assign this field.
- Lists, task responses and export include the counter. `GET /api/tasks/{id}`
  returns one active, authorized task and a strong ETag such as `"v3"`.
  Create and update responses also include the current tag. Responses remain
  private/no-store; viewers may read, but cannot modify. Missing, trashed and
  inaccessible records have the same 404 on this new read endpoint.
- Both `PUT` (including bodyless toggle) and `DELETE` **require `If-Match`**.
  Missing is 428; malformed, weak, wildcard or multiple tags are rejected with
  400; an obsolete task version is 412. Transaction collisions can still be
  409. Read current state and explicitly reconcile; do not replay blindly.
- The version comparison and increment happen inside the same authorization-
  fenced write transaction. Client preconditions do not replace membership,
  role, record-scope or CSRF checks. A cursor/ETag is not an access credential.
- Task edits, deletion/restoration, assignment cleanup, account-deletion link
  cleanup, legacy workspace attachment and reminder updates advance affected
  counters. A delete/restore cycle cannot make an older form current again.
  Original business fields and timestamps still survive ordinary trash/restore.
- Parent DELETE conditions the requested parent row, not a snapshot of every
  child. It still atomically trashes currently active same-workspace children.
  Child-only edits/creation do not change the parent's representation/version.
- Restore retains the existing deletion-batch guard. It only restores original
  records and advances versions; it is not a way to upload stale task fields.

This deliberately changes the write contract: old browser tabs and external API
clients without the header cannot write until refreshed/upgraded. There is no
unsafe fallback. The concurrency use of If-Match/412 follows
[HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match), with
the application's stricter requirement for a single exact version tag.

## User workflow

1. Open the inline editor. Its base version and draft are kept in tab memory.
2. If a different tab/user changes the task, Save is refused and the editor
   keeps the unsaved fields. Save stays disabled until explicit reconciliation.
3. **Review current version** reads only that record. Failed reads can be
   retried without losing the draft. Remote text is rendered as text, not HTML.
4. **Use current version** replaces the editor, while **Keep my edited fields**
   overlays only the fields changed from the original draft onto the reviewed
   version. Untouched fields retain the other user's changes.
5. Neither choice writes to the server. Review and press Save. Another edit
   in the meantime causes another conflict instead of an overwrite.

Checkbox/board writes are explicit state changes and carry the loaded version.
Stale checkbox/deletion actions keep the list and offer a read-only refresh,
not an automatic retry. Duplicate in-flight writes to the same task are
suppressed in the tab. Bulk actions report partial success/failure and stop
issuing further requests if the account/workspace changes.

Drafts survive ordinary re-renders/refreshes. They are not written to browser
storage, the DB, logs or export. Cancel/Escape discards the current draft;
workspace switching asks before discarding dirty drafts; logout/account change
clears them. Closing/reloading a dirty tab uses the browser's unsaved-change
warning, where supported. This is not crash recovery or durable autosave.
Keyboard focus returns to the conflict/status or editor, and review content is
bounded and scrollable on a 320px phone.

## Rollback

The schema addition is data-compatible with `f42b3bd`, but that binary ignores
preconditions and does not advance task versions. Its use removes the new
overwrite protection; do not treat it as a security-equivalent rollback.
Prefer a version-aware fix-forward build. If an old binary must serve writes,
re-enable the new one only under controlled maintenance: stop old writers,
advance **all** retained task versions using the private administrator identity,
then require clients to read current records. Do not reset counters to zero or
reuse earlier tags. Coordinate this explicitly; it is not an automatic startup
migration or a reason to overwrite the database with an old export.

Pre-P3 binaries additionally ignore trash semantics and remain unsafe after
trash use. Keep matched executable/library/assets/configuration and follow
[incident response](INCIDENT-RESPONSE.md). Old static assets with new write
rules fail closed; matched deployment and a browser reload resolve that.

## Focused CISO review and tabletop

Top threats: tampering/data loss via stale writes (high likelihood/high impact),
information disclosure through conflict previews (medium/high), and unsafe
automatic retry or rollback (medium/high). Transaction-bound versions, scoped
single-record reads, escaped previews and explicit user reconciliation mitigate
this batch. Runtime compromise can still affect all app tenants; affected-user
count, financial loss/ALE and measured MTTD are unknown, not fabricated.

Detection: 409/412 are ordinary conflict signals, not proof of compromise.
Operational readiness/restarts/5xx remain deployment checks. A sustained spike
in failed writes warrants operator investigation, but no alert recipient or
tested on-call is configured; logs alone are not alerting. CISO companion
quantification scripts are unavailable. No new vendor, external storage or
paid service is introduced. Regulatory roles, contracts and notification duties
still require the owner's real commercial context and legal assessment.

Tabletop and isolated fixtures: two old forms → one save wins; failed review →
draft stays; repeated intervening edits → every stale save fails; old deletion
after Undo → version mismatch; membership removal → current authorization and
assignment cleanup prevail; write-response loss → inspect current task before
another action; rollback → preserve new writes and invalidate old tags under
maintenance if an old writer ran. No real incident notice or human response
drill was sent. The existing runbook has a draft customer communication.

## Verification

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_VERSIONS=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

Passed: **51 unit + 37 smoke + 38 security + 15 trash + 16 pagination +
18 task-version + 71 browser + 17 email = 263 checks**. New cases include
real concurrent same-version writes, failed transaction rollback, stale
edit/delete/toggle, delete/restore version changes, assignment removal, export,
two-tab reconciliation, a second intervening edit, partial bulk failure, phone
layout, preview escaping, keyboard focus and private draft cleanup.

Private pre-deploy recovery material is under
`/var/backups/taskmanager/20260909-task-versions`: a 34,243-byte local export
and the unchanged private runtime configuration. Promotion requires the
restored-copy migration drill, administrative schema-only migration, disabled-
worker canary and local/public checks. No production account mutations or
real SMTP are used for tests. Inspect `/opt/taskmanager/current` and the service
journal for actual active-release evidence; tests alone do not publish a build.

The private export was restored into a separate loopback RocksDB instance;
account/task/session counts matched. Migration 015 then passed against that
restored namespace/database using the matching library and schema-only startup.
The temporary instance and its owned volumes were removed. No old export was
imported into production, and existing business task data was not rewritten.
