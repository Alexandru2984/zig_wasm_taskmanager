# P1 — transactional account and authorization safety

Date: 2026-09-07. Scope: the first implementation batch in
[the product plan](PRODUCT-IMPLEMENTATION.md), not a complete pentest or a
claim that all planned product features have shipped.

## Implemented controls

- Password change conditionally replaces the verified password hash, clears
  reset credentials, revokes existing sessions and creates its replacement
  session in one transaction. Only a committed change sets the new cookie.
- Login rechecks the verified hash while creating a session. A concurrent
  credential rotation cannot leave a session issued from the stale hash.
- Invitation consumption and membership creation commit together. Verified
  recipient email, expiry, non-consumption, existing membership and the
  issuer's current administrative role are checked in that transaction.
- Task, invitation and membership mutations recheck authorization within the
  write transaction. Shared actor/workspace revision writes make overlapping
  revocation/deletion conflict instead of relying only on earlier snapshots.
- Workspace and owner membership creation are atomic. First-login workspace
  initialization rechecks membership and attaches legacy tasks atomically.
  A failed initialization attempts to remove the undelivered new session.
- Account deletion checks the same password hash that was verified and
  deletes dependent records atomically. It clears assignments to the departing
  user and detaches surviving other-author children from deleted parents.
- Removing a workspace member clears their assignments and pending invitations
  they issued in that workspace. Owner membership remains protected.
- Dead unscoped task/invite/member write helpers were removed. Classified
  permission, missing-resource and conflict failures have explicit HTTP errors;
  arbitrary SQL is never automatically replayed after ambiguous failure.

## Compatibility and residual risk

Migration `012_authorization_fences` adds internal integer revision fields to
users and workspaces. Serving startup requires this migration. Apply it once
with the separate administrative credential; the runtime remains database
EDITOR with automatic migrations disabled.

The revision fields are deliberately coarse: simultaneous writes sharing an
actor or workspace can return **409**, including otherwise independent task
edits. Clients must refresh and decide whether to retry; blind retries of
toggles, creates or other ambiguous operations are unsafe. Capacity and conflict
rate under team load still require P4 measurements.

Account deletion retains the existing policy: it deletes the user's authored
tasks and all workspaces they own, including those workspaces' shared tasks.
It is not trash or ownership transfer. Users must still confirm this destructive
action; recoverable task deletion and owner transfer are separate P3/P6 work.

The complete signup/email/session/default-workspace workflow is not one atomic
transaction. Mail is still an in-memory queue and activity logging remains
best-effort. P2/P7/P9 must address delivery, onboarding recovery and security
event durability. Database EDITOR compromise still exposes all application
tenants; these application checks are not per-tenant DB credentials.

Separate host finding: the existing SurrealDB container starts with an
administrative credential in its command-line arguments. The command-line
file was confirmed readable by unrelated local UID `nobody` without printing
its contents in that check. Application process restrictions do not protect
other local services from this host-wide disclosure. P1b must remove the
startup argument exposure and evaluate credential rotation; do not improvise
a DB restart without verifying persistent identity, volume and rollback.

## Verification procedure

```
zig fmt --check src
zig build test -Doptimize=ReleaseSafe --summary all
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_UI=1 ./scripts/integration_test.sh
node --check scripts/security_test.mjs
git diff --check
```

The harness runs a disposable SurrealDB 3.2.4 RocksDB instance on loopback,
applies migrations as its fixture administrator and serves requests with a
database EDITOR identity. Synthetic credentials are generated at runtime;
production ports, accounts and SMTP are not used. Injected database events
exercise rollback and delayed concurrent writes. SLEEP is deliberately not
used: SurrealDB denies it to EDITOR, which would test permissions rather than
the intended write conflict. Bounded hashing delays only synthetic rows.

The overlap test for account deletion allows both valid commit orders: an
earlier task creation must be removed by deletion, or a later conflicting
creation must abort. It asserts the final absence of orphan data rather than
assuming password verification always finishes before the delayed task write.

ReleaseSafe verification passed: **47 unit + 37 smoke + 38 security + 59 browser
checks (181 total)**. Formatting, JavaScript syntax and diff whitespace checks
also passed. Browser coverage includes the existing mobile/responsive flows;
P1 itself changes backend behavior, not visual design. Production promotion
evidence will be recorded separately after canary verification.

## CISO review

- Top threats (qualitative assessment): stale authorization/tampering and
  privilege escalation (medium likelihood, high impact); stale credential
  session issuance/spoofing (medium/high); partial destructive writes/data loss
  (medium/high). Information disclosure remains possible under runtime
  compromise. Non-durable activity logs limit repudiation controls; coarse
  conflicts and unbounded workloads remain availability concerns.
- Blast radius: all application accounts, tasks, memberships and authentication
  records, plus runtime mail credentials if the process is compromised. User
  count, incident cost and annualized loss were not established; no invented
  financial estimate or claim of tenant-level DB isolation.
- Detection: five-minute alerting is a target only. Named recipient, delivery
  and measured response time are unresolved. This rollout is manually checked
  for readiness, errors and restart loops; that is not an on-call system.
- Response: affected scenarios rehearsed in [the runbook](INCIDENT-RESPONSE.md).
  Rollback keeps the previous executable/static/library release without
  restoring the DB over newer writes. Old binaries lack P1's protections.
- Regulatory/vendor scope: no new vendor or data export integration. Commercial
  controller/processor roles, applicable notification duties, contracts and
  provider reviews need owner confirmation; no compliance conclusion is made.
- Verdict: promote only after the test, backup, canary and verification gates.
  External backup is deferred by the owner; losing the VPS remains uncovered.
