# Client-ready implementation — 2026-09-07

Scope: the six batches requested after P1. This is an execution checklist,
not a promise that listed features already exist. It refines
[PRODUCT-IMPLEMENTATION.md](PRODUCT-IMPLEMENTATION.md).

| Batch | Work | Acceptance | State |
| --- | --- | --- | --- |
| A / P1b | Remove DB bootstrap secrets from process arguments, rotate exposed administrator credential, separate bootstrap from ordinary startup | Persistent restart/rollback drill, old credential denied, runtime rights unchanged, live readiness; no customer data restore over newer writes | Complete, production verified 2026-09-08 |
| B / P2 | Encrypted persistent email outbox, atomic enqueue with originating credential/invite changes, bounded leases/retries/expiry, delivery visibility and operator alert hook | Failure and restart/concurrent-worker tests; no plaintext queued tokens in DB export; validity checked immediately before SMTP (in-flight mail cannot be recalled); no actual SMTP in mutation tests | Complete, production source 708f6a6 verified 2026-09-08; external alert destination still owner-dependent |
| C / P3 | Scoped task trash, restore and real undo, coherent parent/child behavior, reminders/export/deletion integration, mobile UI | [226 checks](TASK-TRASH.md), including original IDs/metadata, failed cascades, stale Undo, revocation, recurrence and mobile/keyboard behavior | Complete; no automatic purge or offline trash introduced |
| D / P4 | Bounded pagination and server-side search/filter/sort, quotas, complete export, conflict UX and measured load | [D1](TASK-PAGINATION.md): 2,106 rows across 22 pages, complete export, bounded UI, stale/cancelled/denied reads tested | D1 complete; D2 server-side filters/sort, storage quotas, version-conflict UX and concurrent load still planned |
| E / P6-P7 | Member directory/assignment picker, workspace rename/archive/owner transfer, scoped comments and mentions | Owner invariant; archived workspace writes denied; comments escaped and bounded; minimal member disclosure; mobile/keyboard and RBAC tests | Planned |
| F / P5-P10 | Portable app/DB deployment, separate migration identity, setup/upgrade/recovery docs, configurable identity, operator/user guides, accessibility pass | Disposable fresh install and upgrade; no personal domain required; fixed runtime artifacts; owner confirms licence/support/brand/commercial model | Planned |

Implementation order follows dependencies; each tested sub-batch is committed
separately with the existing author and committer. No coauthor/AI attribution,
no automatic push, no edits to `.claude/`. Production artifacts remain isolated
from the working checkout. No external backup, Drive integration or purchase.

## Decisions needed without blocking shared implementation

- Dedicated client installations versus shared SaaS; no billing integration yet.
- Operator alert destination and sender, product name, support address.
- Commercial licence/rights and actual operator/controller identity. Templates
  must remain explicitly incomplete until those facts are provided.
- No promised uptime, incident cost or compliance certification. Local exports
  do not cover loss of this host.

## CISO gate and response walkthrough

Top threats: administrative credential disclosure/escalation (high impact),
cross-workspace tampering/data loss (high impact), leaked or replayed queued
credentials and unbounded work (high impact). Likelihood and financial impact
cannot be quantified from the available usage data. Worst case is exposure
of all app tenants and SMTP credentials; runtime DB scope is not tenant scope.

Detection: readiness/restart/queue-failure checks during deployment, a proposed
five-minute operator alert target, but no measured MTTD or designated on-call
until the owner selects and tests a destination. Logs alone are not alerting.

Before A: keep a fresh protected local export, persist replacement administrator
credentials privately before rotating, verify old/new authentication, then
restart the same datastore without bootstrap credentials in a disposable drill.
For failure after rotation, use the private recovery config; do not guess a
password or silently restore the exposed password. For container failure,
stop the new container before starting the retained one on the same volume.
Never run two DB instances on that volume or restore stale exports over writes.

Before B/C: rehearse lost lease/SMTP failure, unavailable encryption key,
revoked invite, deleted user and mistaken task deletion. The key must stay
outside the DB and accompany private local recovery material. SMTP delivery
is at-least-once; a crash after send can cause a duplicate. No exactly-once claim.

The existing [incident runbook](INCIDENT-RESPONSE.md) supplies containment and
communication steps. No new vendor is needed for shared implementation;
contracts, notification duties and provider reviews require the owner's actual
commercial arrangement. CISO companion quantification scripts are unavailable;
no fabricated output or notification drill is substituted. Verdict: mitigate,
test and promote one bounded release at a time.
