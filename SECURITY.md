# Security

This project is run as a production-style Zig web application: the backend,
session model, deployment unit, and email flow are designed to be defensible on
a public VPS.

## Threat Model

Primary assets:

- user accounts and password hashes
- session tokens
- password-reset and email-verification tokens
- task data
- SMTP and database credentials

Primary attacker capabilities:

- unauthenticated internet traffic through nginx
- authenticated users attempting to access other users' tasks
- brute-force attempts against login, verification, and reset flows
- malicious task/profile input intended to trigger XSS or database injection
- accidental secret exposure through git, logs, or process arguments

## Implemented Controls

| Area | Control |
| --- | --- |
| Passwords | Argon2id with per-user random salt |
| Sessions | Server-side SurrealDB sessions, 7-day expiry, hashed session tokens, HttpOnly cookie transport |
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure`, and the `__Host-` prefix in production, which the browser refuses unless the cookie is Secure, Path=/ and carries no Domain — making it unsettable by any other host on the parent domain |
| Password reset | Random 256-bit token, stored hashed, 1-hour expiry; conditional consumption, password update and session revocation in one transaction |
| Email verification | Authenticated verification, hashed 6-digit code, expiry, per-user attempt cap |
| Account enumeration | Generic login/reset errors; signup still reveals an existing address. Timing equivalence is not established |
| Rate limiting | Separate buckets for signup, login IP/account, forgot/reset, verification, resend, task writes, password changes, and workspace invites; the per-account login bucket counts only failed attempts |
| CSRF | Session-bound token hash; the submitted header is required for cookie-authenticated writes even when a Bearer header is also supplied; browser Origin and JSON content type checked |
| Request bodies | 64 KiB JSON body cap, enforced at nginx as well as in the app |
| Passwords | Rejected if they appear in a common-password list or are a single repeated character or a straight run, in addition to the length and composition rules |
| Path parameters | Percent-decoded before use, with a malformed escape rejected rather than passed through altered |
| Error handling | Any error escaping a handler is answered as 500; previously it produced HTTP 200 with an empty body, which a client reads as success |
| Input validation | Email/name/password/task title/date validation before database writes |
| Record references | Bound `RecordId` rejects ranges; task routes and repository require the `tasks:` table; parent links and assignees are workspace-validated |
| Database access | SurrealQL variable binding helper for user-controlled values (unit-tested for quote/control-byte escaping; unsupported bind types are rejected at compile time); Surreal `ERR` results are treated as failed queries |
| Password change | Re-authenticates the current password, rejects reuse, invalidates other sessions, and is rate-limited |
| XSS defense | DOM rendering uses `textContent`; strict CSP for HTML responses |
| Static files | realpath-based public-directory containment and sensitive-file deny list |
| Security headers | One authoritative set emitted by nginx — CSP (no `unsafe-inline` for script or style), HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP, CORP — covering responses the app never produces, such as a 502 during a restart |
| Origin exposure | The origin answers only to Cloudflare edge addresses and loopback; a direct request to the server's own address is refused, so the WAF and rate limiting cannot be skipped by finding the origin IP |
| Rate limiting (edge) | nginx `limit_req` zones in front of the app's own limiters, keyed on the real visitor address and surviving a restart, which the in-process buckets do not |
| Email addresses | Normalized to lowercase before storage and lookup, so one mailbox cannot hold two accounts and a rate-limit bucket cannot be reset by changing capitalisation |
| Account deletion | Requires the password again and performs related-record cleanup; atomicity and concurrent membership changes need further review |
| Email | SMTP via mailcow; secrets stay in `.env`; curl config and payload files are private temp files |
| Workspace invites | Invite tokens are stored hashed, deduplicated while pending, and gated behind verified inviter/recipient emails |
| Metrics | `/api/metrics` disabled unless `METRICS_TOKEN` is configured |
| Deployment | Versioned dedicated `taskmanager` identity, inaccessible home/admin sockets, read-only releases, no capabilities, private `/tmp` and memory/task limits; see audit for live verification |
| Database identity | Database-scoped runtime EDITOR with migrations performed separately using administrative credentials |
| Cache and failures | API `no-store`; no automatic SQL write replay; schema failures refuse startup and task-list failures return an error |
| Recurrence | Task completion and one-time successor creation share a version-checked transaction |

## Known Limitations

- A database EDITOR is scoped to one database, not one tenant. Authorization
  remains application-enforced; a compromised runtime can access all accounts
  and tasks in that database. SMTP secrets are also readable by the service.
- Some permission checks, invitation acceptance and account/password changes
  span separate statements. Concurrent membership revocation and partial
  failures need more transaction coverage. Signup enumeration remains open.
- Bind variables are emitted as `LET $x = "…"` prefixes with hand-written
  escaping rather than a native parameter protocol, because SurrealDB's HTTP
  `/sql` endpoint takes no separate variables. The escaper is unit-tested and
  was probed against the live database — bare table names, record ranges and
  quote-breakout attempts all fail closed — but it remains a hand-rolled
  escaper in front of a database.
- The embedded common-password blocklist contains 21,493 truncated SHA-256
  entries. It is not an exhaustive or continuously refreshed breach database;
  corpus provenance/update policy, passkeys/MFA and recovery codes remain work.
- Rate-limit state inside the application lives in process memory. The nginx
  zones in front of it cover a restart; the per-account login budget does not.
- Durable email, quotas/pagination, tested alert delivery and encrypted off-host
  backups remain operational priorities. A same-host export is not disaster
  recovery. See the dated audit and delivery plan for the full backlog.

## Operational Notes

- The administrative `.env` is ignored by git and remains `0600`. Production
  runtime config is root:taskmanager `0640` under a `0750` private directory;
  root owns release files and the service cannot modify them.
- Rotate SMTP credentials immediately if a scanner reports a concrete leaked
  value. After rotation, verify SMTP auth and restart `taskmanager.service`.
- The public app should remain behind nginx/TLS with `INTERFACE=127.0.0.1`.
- `TRUST_PROXY` should contain only the immediate nginx peer addresses.
- `COOKIE_INSECURE=1` is only for local HTTP development.
- Configuration can come from a private `.env` file or from process environment
  variables (the latter override the file), so secrets never need to enter the
  container image.
- The Zap/facil.io response-header map has a practical cap on how many headers a
  single response can carry. The application sends the core set (CSP, HSTS,
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`); cross-origin isolation headers such as
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` are added at the
  nginx layer in production.

## Verification

Run the local safety checks before pushing:

```bash
./scripts/check.sh
```

Run endpoint smoke tests only against a disposable/dev environment unless you
intend to create test accounts and send verification mail:

```bash
RUN_SECURITY=1 RUN_UI=1 ./scripts/integration_test.sh
```

## Known Follow-Ups

- Expand the isolated integration suite with permission-revocation races,
  invite replay, quota enforcement and browser accessibility checks.
- Replace the curl SMTP subprocess with a native SMTP client if the dependency
  tradeoff becomes worthwhile.
- The 6-digit email verification code is stored as an unsalted SHA-256 digest.
  This is acceptable given the code is single-use, expires in 10 minutes, and is
  rate-limited per user and per IP; a keyed digest would be the next step if the
  threat model tightens.
