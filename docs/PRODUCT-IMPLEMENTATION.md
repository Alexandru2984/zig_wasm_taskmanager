# Product implementation plan — 2026-09-07

Baseline: b89fe81. This plan supersedes the ordering of the remaining items in
DELIVERY-PLAN.md; the earlier audit and verification evidence remain valid.
Completed means implemented, tested and committed, not merely listed here.

## Decisions and boundaries

- External backup is explicitly deferred at the owner's request. Do not connect
  Google Drive, buy storage or upload customer data. Retain protected local
  exports and recovery procedures. Loss of this VPS remains an uncovered risk.
- Start with the foundation shared by dedicated-client installations and SaaS.
  The owner chooses the primary commercial model before billing/provider work.
- Do not rewrite the working stack merely to change frameworks. Preserve API
  compatibility where practical; document intentional contract changes.
- Work in an isolated checkout and disposable database. Never run mutation
  suites with production accounts or production SMTP. Preserve `.claude/`.
- Commit each verified batch with the existing Git author/committer, without
  additional attribution or coauthor trailers. No automatic remote push.
- No invented business identity, licence ownership, contractual promises,
  privacy terms, support address, notification recipients or payment keys.

## Ordered implementation batches

| Batch | Scope | Completion evidence | Status |
| --- | --- | --- | --- |
| P0 | Version this plan; correct misleading setup/security claims | Documentation matches code and deferred items are explicit | Complete |
| P1 | Atomic password changes/session revocation, account deletion and invite consumption; transaction-bound authorization for role/member/task mutations | [181 passing checks, promotion and limitations](PRODUCT-P1-VERIFICATION.md), including real DB rollback/concurrency cases | Complete; inherited by later releases |
| P1b | Remove DB administrative credentials from startup arguments; review bootstrap/rotation and local process visibility | [Verified rotation, persistent restart and production checks](DATABASE-HARDENING.md) | Complete, 2026-09-08 |
| P2 | Persistent transactional email outbox; bounded jobs, retry/backoff, claims/leases, expiry, delivery state and operational visibility | [212 passing checks, key/SMTP/lease/rollback drills and promotion evidence](DURABLE-EMAIL.md); validity checked before SMTP, not a guarantee that in-flight messages can be recalled | Complete; delivered in 708f6a6; external alert recipient pending |
| P3 | Real task trash/restore, parent-child consistency and scoped undo UI | [226 checks](TASK-TRASH.md): IDs/metadata preserved, stale Undo fenced, concurrent permission changes denied, mobile/keyboard coverage | Complete; automatic purge/retention policy and offline trash not introduced |
| P4 | Pagination, server-side search/filter/sort, resource quotas and load measurements | [D1 pagination](TASK-PAGINATION.md): 2,106 rows, complete export and bounded browser pages; measured sequential read latency | D1 complete; server-side filtering/sorting, storage quotas, version-conflict UX and concurrent capacity measurements remain D2 |
| P5 | Portable installation and upgrade: generic config, full app/DB stack, migration identity, readiness, matched libraries, pinned artifacts and rollback | Fresh-host installation using only published instructions; upgrade and recovery rehearsal; no personal domain or production secrets required | Planned |
| P6 | Team lifecycle: minimal member directory, assignment picker, rename/archive workspace, owner transfer and per-workspace saved-view sync | Owner invariant, scoped profiles, archive write prevention, multi-device and authorization tests | Planned |
| P7 | Team workflows: comments, mentions, notification preferences, templates and onboarding with optional synthetic examples | Sanitization, quotas, tenant isolation, accessible notification controls; a new user completes the core flow unaided | Planned |
| P8 | CSV/JSON import preview and validation; agenda/calendar, date presets and timezone policy | Bounded import, duplicate strategy, preview before writes, partial-failure recovery, DST/calendar and mobile checks | Planned |
| P9 | Account/operational hardening: uniform registration flow, MFA/passkeys/recovery, durable abuse controls, security events and alerts | Revocation/replay/recovery tests; explicit event retention; alert delivery to an owner-selected destination | Planned |
| P10 | Product packaging: branding, demo, coherent versions/changelog, user/operator guides, support boundaries, licence/dependency inventory and privacy data map | Owner confirms commercial terms, rights and contact details; no unsupported compliance or uptime claims | Planned |
| P11 | Pilot with measured acceptance, then SaaS billing if selected: plans, entitlements, cancellation and payment failures | Pilot feedback, operating costs, signed-off limits; payment sandbox replay/webhook tests before real payments | Awaiting commercial choices |

Each batch may be split into smaller verified commits. Dependencies override
marketing order: persisted secrets in P2 need a key/recovery policy; P3 affects
export/reminders/account cleanup; P4 changes browser loading/filtering; ownership
transfer must share P1's authorization and account-deletion safeguards.

## Production promotion gate

1. Unit/format checks and isolated smoke/security/browser suites pass.
2. Schema change, compatibility and rollback impact are reviewed. Take a NEW
   protected local export before migrations; do not overwrite older backups.
3. Rehearse affected incident scenarios using INCIDENT-RESPONSE.md. A source
   change or a passing health endpoint alone is not recovery evidence.
4. Stage an immutable release, test with the dedicated runtime identity and
   disabled reminder delivery on a separate loopback port, then promote.
5. Verify readiness, scoped DB rights, process restrictions, public assets and
   cache/security headers. Only this application's service/config is in scope.
6. Record actual test totals, commit/release and residual gaps. Restore a DB
   backup only by deliberate operator decision, never as an automatic rollback
   that could erase new customer writes.

## CISO review of this plan

Top threats: cross-tenant tampering through stale authorization; account
takeover through credential races or leaked notification tokens; availability
and data loss from destructive operations, unbounded work and single-host loss.
Worst-case runtime compromise still exposes all tenants in the application DB
and its mail credentials. Customer count, impact cost and annualized loss are
not established; no financial risk estimates are invented.

Use transactions plus shared authorization write conflicts where separate
snapshot reads would otherwise permit write skew. Fail closed on ambiguous
mutations; do not silently replay writes. New tables containing personal data
must join export/deletion/retention and backup review.

Detection target: notify the named operator within five minutes of sustained
errors, restart loops, outbox failures or backup failure. This is a target, not
an implemented control: the alert destination still needs the owner's choice.
The existing incident runbook and desk walkthrough are the starting point;
rehearse queue loss, credential replay and mistaken deletion as those features
change. No new vendor is introduced by the shared foundation. Regulatory roles,
contracts and notification duties require the actual commercial arrangement;
the repository is not proof of compliance. Verdict: mitigate and verify each
batch before promotion; no claim of complete disaster recovery while external
backup is deferred.

## Definition of a sale-ready pilot

A person other than the author can install, configure, use, update and recover
the agreed deployment. A new team can join, assign and complete real work;
mistakes and transient failures have honest, recoverable outcomes. Supported
capacity, security limitations, support responsibilities and data handling are
written down and accepted. Pilot feedback precedes broad public subscriptions.
