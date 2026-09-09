# Task Manager incident response

Operator: VPS owner. Contact/alert destination must be supplied by the operator;
this document does not claim alert delivery or an external responder exists.

## Suspected account, application or host compromise

1. Record UTC detection time, symptom, affected release and request IDs. Keep
   copies of relevant journal/nginx logs with restricted permissions. Do not
   paste cookies, passwords, reset links or private task contents into tickets.
2. If account compromise is isolated, revoke its sessions through the verified
   account flow. If active data exfiltration or host compromise is suspected,
   stop `taskmanager` and block its vhost while preserving evidence. Consider
   the shared host affected if Docker/root access was possible.
3. Determine whether credentials were exposed: DB/SMTP secrets, session and
   reset tokens, password hashes, other applications' files. Rotate affected
   credentials through their owning services; revoke sessions/reset links.
   Do not blindly rotate unrelated services without identifying dependencies.
4. Preserve the compromised release and configuration privately. Restore a
   known-good release or rebuild on a trusted host. Restore the database only
   after deciding which writes must be recovered; never overwrite the only
   copy of incident evidence.
5. Verify service identity, Docker socket denial, DB scope, `/api/ready`, public
   security/cache headers and isolated regression tests before reopening.
6. Establish affected people/data/time range and assess notification duties
   with the responsible operator and appropriate legal advice. Do not infer
   compliance from a status code or from this runbook.
7. Record timeline, root cause, recovery evidence and corrective actions.

## Operational rollback

For releases supporting migration 014, read [the task-trash rollback caveat](TASK-TRASH.md)
first: pre-P3 binaries would expose retained trash as active tasks. After a trash
write, use a trash-aware build or stop serving and fix forward, not the old
binary unchanged. Do not restore the database over newer customer writes.

Deployment keeps a protected backup of the prior unit/nginx configuration and
a database export. New schema fields are additive; do not restore a database
backup for a binary-only rollback because that would lose newer user writes.
Point `/opt/taskmanager/current` to the preceding release and restart the
service; validate readiness and public HTML. The initial migration from the
old checkout also retains the prior unit as an emergency fallback, but that
fallback restores the old `micu` identity and its security risks.

For the 2026-09-07 first promotion, the private backup directory also retains
the prior static files, executable and matching library. The working checkout
may have newer files after Git synchronization: do not assume it is a complete
old release. Restore the matching artifacts/configuration deliberately and
validate them before reopening. Rejected canaries under `failed-canaries` are
not known-good releases.

## Tabletop checklist

Rehearse: a leaked runtime credential; a faulty release returning 500; loss of
the database. For each, identify who notices, who can isolate the application,
where the backup is, how to restore into a disposable instance, and what
proves recovery. Record actual results in the audit, not just checklist ticks.

### Pre-promotion desk walkthrough — 2026-09-07

- Leaked runtime credential: isolate this app, preserve logs, replace its DB
  and affected SMTP secrets; a database EDITOR still exposes all app tenants.
  Root DB access must be denied by the verification helper. There is no
  established alert destination, so automatic detection is an unresolved gap.
- Faulty release/500s: validate local readiness, restore the previous unit or
  release symlink, restart only this service, then check nginx and public HTML.
  Do not restore the DB over newer writes for a binary-only failure.
- Database loss: the protected export is recoverable on this VPS, and a
  disposable restore was exercised with matching account/task/session counts.
  Loss of the entire VPS remains uncovered until off-host backups exist.

This was a desk review with a technical restore exercise, not a staffed on-call
or notification drill. No incidents were declared or messages sent. The VPS
owner must designate the alert channel and validate human response times.

### P1 affected-scenario walkthrough — 2026-09-07

- Password/session failure: a synthetic session-creation failure leaves the
  existing password, reset token and sessions unchanged. Concurrent changes
  have one winner; a login using a stale verified hash cannot leave a late
  session after rotation. On a real ambiguous response, do not blindly replay
  writes; check authentication/session state and use the recovery flow.
- Invite/member failure: synthetic membership failure leaves the invite
  unconsumed. Revoked invites and demoted issuers cannot grant stale authority.
  A delayed task write conflicts with administrative permission revocation.
  On a real incident, examine scoped membership and invite state privately;
  do not expose invitation tokens in support messages.
- Account-deletion failure: a synthetic deletion failure rolls back account,
  workspace, membership, session and task removal together. A successful
  deletion remains deliberately destructive, not undoable. Stop further
  destructive actions if mistaken deletion is reported; preserve current
  state and assess recovery from a separate restored local export before
  deciding what can safely be reintroduced.

These are disposable technical failure exercises plus an operator desk review,
not production account mutations or a human alert-delivery drill. Before P1
promotion take a new protected local export and preserve release `973767a`.
Migration 012 is additive: binary rollback must not erase newer customer writes,
and it temporarily removes P1's race protections. No off-host recovery exists.

P1b follow-up, 2026-09-08: persistent rotation/restart/rollback was exercised
against a disposable DB before production. The active DB now starts without
bootstrap credentials and its exposed administrator password was rotated.
Recovery configuration and a stopped prior container are retained as described
in [DATABASE-HARDENING.md](DATABASE-HARDENING.md). During recovery never start
both containers against their shared datastore, and never revert to the exposed
password just because an HTTP response was ambiguous.

### Durable mail affected-scenario walkthrough — 2026-09-08

The [durable email runbook](DURABLE-EMAIL.md) records the SMTP outage, wrong-key,
revocation, account-deletion and binary-rollback scenarios. Technical fixtures
exercise retries, leases and transactional deletion; no real email or human
alert-delivery drill is implied. Restore the retained private key on mismatch,
not a newly generated key. A send already accepted by SMTP cannot be recalled;
check endpoint credential validity and communicate duplicate/expired emails
without copying their tokens into logs or tickets.

### Pagination D1 walkthrough — 2026-09-09

Isolated checks cover failure on page 2,
permission revocation between pages, delayed responses after workspace change,
overlapping refreshes and local writes. Keep the prior complete list only on
ordinary load failures; discard it on explicit workspace denial. Do not blindly
replay writes or restore database contents. D1 needs no schema migration and
may roll back to the P3-aware `941b7c1` release; pre-P3 rollback is still unsafe
after trash use. See [pagination evidence and limits](TASK-PAGINATION.md).

## Draft incident communication (do not send automatically)

“On [UTC date/time] we detected [confirmed event]. We have [containment].
The data confirmed affected is [data types/time range]. [Actions required of
users, if any]. Our next update is [time/channel]. Contact [operator].”

Fill with verified facts and have the responsible operator approve recipients,
timing and content. Avoid claiming no impact while investigation is ongoing.
