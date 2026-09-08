# Durable account email

Batch B / P2, 2026-09-08. Applies to verification codes, password resets and
workspace invitations. Optional task reminders still use their existing
task-based attempt tracking; they are not part of this outbox.

## Guarantees and limits

- User creation, credential replacement or invitation creation and encrypted
  enqueue commit in one database transaction. Failed enqueue cannot leave a
  new credential or invitation without its job. The entire signup/session/
  default-workspace workflow remains several transactions.
- XChaCha20-Poly1305 authenticates encrypted payloads with random nonces and a
  32-byte key from `MAIL_OUTBOX_KEY`. The DB stores a domain-separated key
  fingerprint, not the key. Missing/invalid/different keys refuse serving and
  worker startup before consuming jobs. This protects a DB-only export from
  revealing queued plaintext, not a compromised application/host with the key.
  Existing authentication hashes remain sensitive, especially short codes.
- A worker claims one job with a random 120-second lease. Concurrent claims
  conflict; completion is fenced by that lease token. A fresh process can
  reclaim an expired lease. Five claims maximum; SMTP has a 30-second timeout;
  retries wait 30, 120, 480 and 1,800 seconds.
- Before SMTP, current expiry, credential hash, account existence, invite
  state and issuer membership are rechecked. Revocations after that check
  cannot recall an email already in flight; the endpoint still validates the
  credential/grant when used. No exactly-once or never-after-revocation claim.
- SMTP is **at-least-once**: a crash or lost DB response after SMTP acceptance
  can produce a duplicate. `delivered` means acceptance by SMTP, not delivery
  to an inbox. STARTTLS certificate verification is mandatory. No insecure
  TLS fallback; `SMTP_CA_FILE` is only for a deliberately trusted private CA.
- Encrypted payload and its job hash are erased on terminal status. Terminal
  metadata is removed seven days after creation, during worker maintenance.
  Expiry cleanup avoids beginning a send with less than 35 seconds remaining.
  Cleanup pauses if the worker is disabled or unavailable.
- At most 5,000 pending/processing jobs; a shared transaction guard protects
  the capacity check against concurrent enqueues. Signup/invite/resend failures
  use explicit errors; forgot-password keeps its uniform public response.
  No claim of a measured delivery-time SLA or high-volume capacity.
- Profile → Email delivery shows the latest 100 own metadata records. Account
  export includes all retained own delivery metadata, not tokens/ciphertext.
  Account deletion removes owned jobs and jobs for invitations it deletes.

## Upgrade and private recovery

1. Test with a disposable DB and local TLS SMTP fixture. Take a fresh protected
   database export before production migration; retain the previous release.
2. Provision a key into the **runtime** config with a new private recovery path:

   ```bash
   sudo node scripts/provision_mail_key.mjs /etc/taskmanager/runtime.env /var/backups/taskmanager/RELEASE/runtime-with-mail-key.env
   ```

   Create the backup directory root-only mode 0700 first. The helper accepts
   runtime mode 0640, writes/fsyncs a mode-0600 recovery file before atomic
   replacement, preserves ownership/mode and refuses duplicate/invalid key
   definitions, symlinks and an existing recovery file. It does not print
   credentials or rotate an existing valid key.
3. Apply additive migration `013_mail_outbox` using the new executable with
   `DB_MIGRATE_ONLY=1` and the separate administrator configuration. Serving
   remains database EDITOR with `DB_AUTO_MIGRATE=0`.
4. Canary the matching executable/library/static release on a spare loopback
   port with `MAIL_WORKER_ENABLED=0` and `TASK_REMINDERS_ENABLED=0`. Startup
   registers or verifies the key fingerprint. Verify private key access only
   through the runtime config, readiness and protected metrics.
5. Promote the immutable release, enable the ordinary mail worker (default 1),
   restart the app and verify local/public readiness and queue metrics. Do not
   send synthetic emails or create test accounts in production.

Retain the **same key with the DB recovery material**. An old DB snapshot may
contain live encrypted jobs; never restore it over newer customer writes.
Restore drills use an isolated DB, disabled workers and the snapshot's key.
Losing the key makes those payloads unrecoverable: users must request fresh
credentials after an explicit recovery decision. Do not remove the fingerprint
or generate replacement keys to bypass a startup mismatch. Planned rekeying/
re-encryption is not implemented; preserve the original key across upgrades.

A binary rollback does not need a DB restore. The preceding release ignores
the new tables and uses the old volatile queue; pending durable jobs wait for
a compatible worker and can expire meanwhile. Do not run incompatible workers
or erase the key during rollback. The previous release also lacks this batch's
delivery controls. Follow [incident response](INCIDENT-RESPONSE.md).

## Monitoring hook, not a configured alert service

`/api/metrics` remains protected by `METRICS_TOKEN`. It now reports
`mail_outbox_jobs{status="..."}` and `mail_outbox_oldest_seconds{status="..."}`.
No email addresses, tokens, record IDs or SMTP response bodies are metrics.

```bash
sudo node scripts/check_health.mjs /etc/taskmanager/runtime.env http://127.0.0.1:9000
```

The helper emits bounded JSON and exits nonzero for readiness failure, missing
metrics, failed jobs, or a pending/processing age above five minutes. It refuses
unrelated destinations and redirects before forwarding credentials. Terminal
failed rows keep the failure signal active until retention cleanup; there is
no operator acknowledgement UI yet. Configure a real recipient, scheduler and
response owner before claiming alert delivery. None are invented or activated
by this batch; the owner has not selected a destination.

## Verification

```bash
zig fmt --check src
zig build test -j2 -Doptimize=ReleaseSafe --summary all
node scripts/mail_ops_test.mjs
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh
```

The outbox fixture uses only loopback, synthetic identities and a locally
generated TLS certificate. It tests SMTP failure, trusted/untrusted TLS,
concurrent processes, lease recovery, expired/revoked/demoted invitations,
authenticated ciphertext, absent/wrong key, bounded attempts, transactional
rollback, replacement reset tokens, capacity and private metrics/export.
Security tests also check account-deletion rollback and outbox cleanup.
Browser tests cover delivery visibility/error/retry, logout cleanup and 320px
layout. Private helper tests cover permissions, retained keys, safe recovery
paths, missing metrics, backlog/failure detection and destination restrictions.

Local final verification passed on 2026-09-08: **48 ReleaseSafe unit, 37 smoke,
38 security, 63 browser, 17 durable-email and 9 private-operation checks
(212 total)**. Syntax, formatting and diff checks passed. CI definitions now
run durable-email/helper tests and reuse the scoped-EDITOR harness for browser
tests; remote CI has not been run or claimed, and nothing was pushed.

A fresh protected 31,557-byte pre-deploy export was restored to a disposable
loopback DB. Users/tasks/session counts matched and migration 013 applied
successfully to that restored snapshot with no SMTP configured. The temporary
container was removed; no production data was imported or overwritten.

## CISO gate and tabletop

Top risks: credential disclosure/tampering (medium likelihood/high impact),
lost/duplicate recovery messages (medium/high), queue exhaustion (medium/high).
Full runtime compromise exposes all app tenants plus SMTP/key material; no
per-tenant DB credential or quantified incident cost/user count is claimed.

Desk review plus isolated exercises: SMTP outage → preserve pending ciphertext,
inspect safe metrics, repair SMTP and allow bounded retry; key mismatch → stop
startup and restore the original private config, never consume jobs with a
guessed key; revoked invitation → cancel before dispatch, endpoint rechecks if
revoked during SMTP; account deletion → atomically remove its mail; failed
release → restore the known-good binary without overwriting newer DB writes.

Detection rules above exist, but the five-minute threshold is not measured
MTTD and no on-call/notification drill exists. The existing incident communication
draft requires verified facts and operator-approved recipients. No new vendor,
external backup or purchase. Existing VPS/Cloudflare/SMTP provider contracts,
subprocessor duties and applicable legal notification deadlines need the actual
commercial arrangement; no compliance certification or fixed legal deadline is
asserted. CISO quantification companion scripts are unavailable, so no financial
output is fabricated. Verdict: mitigate, test and canary before promotion.

Production evidence is recorded separately after promotion. Batches C–F remain
in [the execution plan](CLIENT-READY-EXECUTION.md); this is not the finished
commercial-product claim.
