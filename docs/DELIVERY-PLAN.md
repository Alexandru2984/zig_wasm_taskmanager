# Delivery plan — 2026-09-06

The current execution order is [PRODUCT-IMPLEMENTATION.md](PRODUCT-IMPLEMENTATION.md).
External backup is deferred by the owner as of 2026-09-07; it is not counted as
implemented or a prerequisite for starting the remaining development batches.

Baseline and risks: [audit](AUDIT-2026-09-06.md). Each completed stage is
verified and committed separately, using the existing repository identity and
no coauthor trailers. Production promotion follows isolated tests and a
documented rollback. Backlog entries are not claims of shipped functionality.

Status on 2026-09-07: stages 1–4 are implemented and promoted (application
release `973767a`), with 46 unit, 37 smoke, 23 security and 59 browser checks.
Production runs with the dedicated Unix/DB identities. Stage 3's backup drill
was local only; alert routing and off-host recovery remain stage 8 work.
See the audit for the canary-discovered startup fixes and residual risks.

Update: product batch P1 is now promoted as `84d1936` with 181 passing checks;
see [the P1 verification record](PRODUCT-P1-VERIFICATION.md). The urgent next
batch is P1b (DB administrative credential exposure in process arguments), then
the remaining product batches. External backup remains explicitly deferred.

| Stage | Deliverables | Acceptance |
| --- | --- | --- |
| 1. Safe verification | Owned test PIDs/ports/temp files; isolated DB; audit and regression suite | Occupied ports untouched; regressions reproduce old behavior |
| 2. Security and consistency | CSRF credential precedence; atomic reset/revocation; tenant-safe parent/assignee validation; idempotent recurrence; cache policy; fail-closed DB handling | Negative and concurrency tests pass against a real temporary DB |
| 3. Production isolation | Dedicated Unix identity, no Docker/sudo groups; private release/env; resource limits; scoped DB runtime user; migration identity; backup/runbook/rollback | Permission checks, healthy public/local endpoints, recoverable previous release |
| 4. Mobile and daily workflow | Today/Upcoming, saved views, persistent preferences, responsive toolbar/composer/cards, useful empty/error states | 320/390/768/1440px, light/dark, board/list/editor, keyboard/touch checks |
| 5. Collaboration | Workspace lifecycle, member directory, comments, mentions, watchers, project sections, templates, dependencies | Tenant-scoped RBAC and content/notification limits |
| 6. Planning | Calendar/week view, date presets, custom recurrence, estimates, time tracking, milestones, trash/restore, import | Timezone/DST tests; import preview, caps, duplicate policy and rollback |
| 7. Offline and accessibility | Public-shell service worker, IndexedDB queue, conflict UI, explicit local import, localization, accessibility and performance profiling | Reconnect/logout cannot mix accounts or duplicate tasks; screen-reader/zoom review |
| 8. Account security and operations | Passkeys/MFA/recovery codes, uniform registration flow, durable mail, alerts, encrypted off-host backup, scoped API tokens/webhooks | Recovery/revocation/replay tests, restore drill and tested alert routing |

## Immediate implementation priorities

- Reproduce mixed-cookie/Bearer CSRF, reset replay, cross-workspace parentage,
  outsider assignment and repeated recurrence with disposable accounts.
- Cover owner/admin/member/viewer/outsider behavior, malformed IDs, stored XSS,
  missing cookies and revoked sessions.
- Keep board completion consistent on create/update/toggle; rearm edited
  reminders; include all newer task fields in JSON export.
- Surface database failures and refuse startup after schema failure; stop
  automatic replay of ambiguous writes.
- Keep nginx-served files untouched while preparing fixes in a separate checkout.
- Version and rehearse incident response; separate observed controls from
  unknown alerting, contractual and regulatory details.
- Track npm lockfile, correct deployment instructions, review dependency pins.

## Product backlog details

Daily workflow: Today and Upcoming filters, named saved searches by account and
workspace, persistent sort/view, scope counts, keyboard access, long-title
wrapping, mobile safe areas, retryable errors and screenshots.

Collaboration: rename/archive workspaces, ownership transfer, member-visible
assignment picker with minimal profile disclosure, comments/mentions/watchers,
workspace activity, projects/sections, templates/checklists, dependencies,
custom board columns, accessible ordering, invite resend/delivery status and
notification preferences.

Planning: agenda/calendar/week views, due-date presets, snooze, timezone-aware
recurrence with an explicit catch-up policy, estimates, optional time tracking,
workload summary, priority matrix, goals/milestones, undo, archive/trash with
retention, selective export and validated CSV/JSON import.

Offline and accessibility: public shell service worker without private-response
caching by default, anonymous metadata parity, explicit local-to-account import,
IndexedDB sync with account isolation/logout cleanup, conflict resolution,
screen reader/contrast/zoom/reduced motion review, Romanian/English copy,
per-user timezone, pagination, indexes and performance profiling.

Operations: authentication security events, durable rate limits and email
outbox, privacy-limited CSP reporting, tested alerts to a named operator,
encrypted off-host backups and restore exercises, retention, uptime objectives,
scoped API tokens and signed webhooks after replay and quota controls exist.

Stages 5–8 are a prioritized backlog. Each feature needs a bounded design,
implementation, verification and commit before production promotion.
