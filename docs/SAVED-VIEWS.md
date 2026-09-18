# P6d — private saved views across devices

Scope: this VPS only. No new host, client handoff, billing, vendor or external
backup. A view contains its name, main-list search/filter/exact tag/sort and
list/board layout, not tasks, page cursors, task drafts or finder results.

## User behavior

Open **Saved views**, name the current configuration and choose **Save view**.
Signed-in views belong only to that account in the selected workspace. Every
current member, including viewers, can manage their own views, also while the
workspace is archived. Teammates/admins do not receive other people's search
text. Ownership transfer does not transfer or share personal preferences.

Views load on login/workspace selection; use **Refresh views** on another device
to fetch changes. This is request-based synchronization, not live collaboration,
background polling or an offline write queue. Refresh never applies a view or
discards current task filters/drafts. Selecting a view honors the task draft
confirmation. Relative Today/Upcoming dates use each device's timezone as before.

Save/delete wait for a valid server confirmation. A conflict or uncertain result
locks writes until an explicit refresh; current filters and the entered name
remain available in that context. There is no automatic overwrite/replay.
Requests time out after 20 seconds; aborting/navigating away cannot undo a write
already committed by the server. Late responses cannot publish across workspace
changes/logout, and the previous context's view-name draft is cleared.

Guest views stay in localStorage. Earlier signed-in browser-only views are not
automatically uploaded: **Import device views** confirms the account/workspace
and possible search text. Import merges only that context, preserves opaque IDs,
refuses conflicting duplicate IDs/over-limit/invalid data and leaves device data
unchanged on failure. After confirmed import, only the unchanged source copy is
removed; guest/other-account/other-workspace data is untouched. Re-importing an
identical ID is not a duplicate. Old oversized/invalid views need correction;
they remain in browser storage, not silently truncated or erased. Cloud views
are held only in memory, not cached in localStorage by this feature.

## Contract and bounds

`GET /api/workspaces/{id}/views` returns `{ membership_id, version, items }`.
It checks current membership and scope existence. An empty read is version zero
and creates no DB record. `membership_id` is the caller's own membership record,
not a capability or another member's directory information.

`PUT` replaces the caller's collection using
`{ expected_membership, expected_version, items }`. Authorization never uses a
caller-supplied owner. All item strings use the existing SQL string escaper;
there is no raw query/JSON interpolation. UI labels use text nodes, not HTML.

- At most 12 views, with unique ASCII alphanumeric/underscore/hyphen IDs (1–64).
- Names: 1–48 Unicode codepoints, not ASCII-space-only, at most 192 UTF-8 bytes.
- Search: at most 500 UTF-8 bytes; exact tag: null or at most 128 bytes. No C0/DEL
  control characters. Enumerated filters/sorts/layouts match the main view.
- Whole PUT body: at most 32 KiB. Expected revision: integer 0–9007199254740990.
- Reads share the per-account 120/minute search budget; writes share the
  60/minute task-write budget. Both are process-local, reset on restart and
  return 429 with Retry-After 60 when exhausted. No durable abuse control claim.

Session, CSRF for PUT, typed workspace IDs and private `no-store` still apply.
400 invalid fields; 401 no session; 403 no membership/CSRF; 404 missing workspace
on writes; 405 wrong method; 409 stale revision/membership or concurrent mutation;
429 rate budget; 500 failed/uncertain operation. See [OpenAPI](openapi.yaml).

## Transactions, retention and compatibility

Migration `017_saved_views` adds a schemafull `saved_view_sets` table with one
unique owner/workspace collection. The validated, bounded object array uses a
flexible field so all typed item keys (including nullable exact tags) survive.
GET runs authorization/data reads in one transaction. PUT shares account and
workspace write fences with revocation/account deletion. Empty replacement
advances its revision; it does not reset/delete the versioned collection.
The expected membership ID prevents an old tab replaying after remove/rejoin.

Member removal deletes that person's workspace views in its transaction;
account deletion deletes the account's collections and all collections in its
currently owned workspaces. A cleanup failure rolls back the entire operation.
Account JSON export includes only the caller's current-membership collections
under `saved_views`. Local pre-sync device copies are not server data and cannot
be remotely erased from another browser. Protected DB exports retain the new
table under the existing local backup policy. No task quota reduction, global
disk cap, streaming account export or automatic backup retention was added.

Apply the additive migration with the administrator identity only, after a
fresh protected export and separate restored-copy rehearsal. Serving identity
remains database-scoped; runtime startup requires 017. Publish matched assets
including `saved-views.js`, verify a worker-disabled restricted canary and then
promote only this application. Existing workspaces/preferences are not uploaded,
archived or changed by the migration; the new table starts empty.

**Pre-017 binaries lack view export/deletion hooks.** After view data exists,
do not blindly switch back to `e9eacc9`: use a views-aware fix-forward build or
stop serving while reviewing recovery. Deliberate downgrade needs maintenance,
all writers stopped and a reviewed data-lifecycle plan. Do not automatically
erase views, unarchive workspaces or restore an old DB over newer writes.
The portable compatibility family is 017; earlier families are refused before
upgrade/rollback mutation, not auto-migrated. No fresh-host deployment is claimed.

## CISO review and desk walkthrough — 2026-09-18 (Bucharest)

Top threats: cross-account exposure of personal search text (disclosure,
medium likelihood/high impact); stale-device overwrite or authorization after
revocation (tampering/elevation, medium/high); old-code rollback retaining data
after deletion/export (disclosure/lifecycle failure, medium/high). Account-bound
queries, bounded validation, membership/revision checks, shared transaction
fences and a compatibility gate address those boundaries. Views are personal
preferences, not secrets encrypted from the application or a shared-team feature.

Worst case of runtime/DB compromise remains exposure of all application tenants
and SMTP configuration; a stolen session exposes its own memberships/views.
User counts, financial loss/ALE, measured MTTD and human response time are not
established. The CISO companion quantification scripts are unavailable. No
compliance certification, legal notification deadline or staffed alert is claimed.

Failed requests/readiness/journal checks support investigation, not automatic
compromise detection. Owner remains responder; an external alert route and
response measurement still need the owner's choice. No new vendor, DPA or
subprocessor arrangement is introduced. Use confirmed facts and the existing
[incident communication/runbook](INCIDENT-RESPONSE.md), not invented recipients.

Desk cases: suspicious private-view access → preserve restricted logs, identify
scope/session and revoke it; device conflict/timeout → keep current filters,
refresh and review without automatic replay; removed member → verify API denial
and collection cleanup, including an overlapping write; accidental local import
→ remove only the intended synced views after review, never unrelated local data;
faulty release → preserve the current DB and prefer a 017-aware fix-forward.
These are technical/desk exercises, not a human notification or response drill.

Promotion remains gated on final isolated regression, restored-copy migration,
restricted canary and matched-artifact evidence. Recorded results follow below.

## Verification and pre-promotion evidence — 2026-09-18

426 distinct regression checks passed: 59 ReleaseSafe unit, 37 smoke, 16 main
view, 21 team, 25 ownership, 31 saved-view (19 API / 12 browser), 23 archive,
38 security, 15 trash, 16 pagination, 18 version, 19 search, 71 general browser,
17 quota/load and 20 durable-email checks. Another 9 private mail-operator
checks passed. Repeated targeted/general runs are counted only once.

The final full run is `/tmp/taskmanager-saved-views-full-20260918.log`; the
targeted confirmation is `/tmp/taskmanager-saved-views-second-20260918.log`.
Both reached cleanup after the final suite. Fixtures used disposable loopback
databases and local TLS SMTP, not real accounts or production mail. Tests cover
same-workspace privacy, Unicode/injection-shaped text, 12-view/body/revision
limits, concurrent first saves, remove/rejoin epochs, cleanup rollback, revocation
and account-deletion races, two-device conflicts, opt-in import, ambiguous
committed timeout, duplicate submission, malformed success, late responses and
preserved task drafts. The 320px screenshot was visually inspected; general UI
checks also cover 390/768/1440px with light/dark list/board layouts.

Synthetic loopback search: 187 samples, p50 180ms / p95 213ms. Mixed load:
four clients, 1,000 initial tasks, 48 requests, p95 398ms with expected conflict
and busy responses. These are not production capacity, SLA or MTTD claims.

A fresh 34,940-byte protected DB export and unchanged runtime/unit copies are
retained under `/var/backups/taskmanager/20260918-saved-views-promotion/`
(0700 directory, 0600 files). Its export matches the earlier same-day snapshot.
Restoring it into an authenticated disposable SurrealDB 3.2.4 and running 017
twice preserved all nine existing application tables; the new table stayed empty.
Only the disposable instance was removed; protected exports are retained locally.

The live migration then ran with the administrator identity in migrate-only
mode, workers disabled. Its 017 marker and empty view table were verified;
runtime database authentication works and root access remains denied. Existing
public health stayed healthy; no workspace was archived or preference uploaded.

Immutable executable SHA-256:
`69479f2a9bcec83048f0afd4121b778a77b8f09b4296a6715080f0625bd233a4`.
Restricted canary `taskmanager-canary-views-20260918`, loopback 9320, passed
readiness, four matching stamped assets, CSP, private GET/PUT 401/no-store and
a read-only 390px guest browser check. It had zero restarts and both workers
disabled. Its runtime config was readable, but Docker socket/administrator
config reads and executable writes were denied inside the service namespace.

Zig/JS/shell format/syntax, YAML/OpenAPI references, HTML IDs/asset stamps and
diff whitespace checks passed. Portable family 015/016 fixtures were refused
before lock/image/deployment mutation; no fresh-host installation was made.
CISO verdict: pre-promotion gates passed for this bounded batch. Public cutover
and post-cutover read-only checks follow the commit; rollback restrictions remain.
