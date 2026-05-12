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
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure` in production |
| Password reset | Random 256-bit token, stored hashed, 1-hour expiry, token cleared atomically after use |
| Email verification | Authenticated verification, hashed 6-digit code, expiry, per-user attempt cap |
| Rate limiting | Separate buckets for signup, login IP/account, forgot/reset, verification, resend, task writes, and workspace invites |
| Request bodies | 64 KiB JSON body cap |
| Input validation | Email/name/password/task title/date validation before database writes |
| Database access | SurrealQL variable binding helper for user-controlled values; Surreal `ERR` results are treated as failed queries |
| XSS defense | DOM rendering uses `textContent`; strict CSP for HTML responses |
| Static files | realpath-based public-directory containment and sensitive-file deny list |
| Security headers | CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` |
| Email | SMTP via mailcow; secrets stay in `.env`; curl config and payload files are private temp files |
| Workspace invites | Invite tokens are stored hashed, deduplicated while pending, and gated behind verified inviter/recipient emails |
| Metrics | `/api/metrics` disabled unless `METRICS_TOKEN` is configured |
| Deployment | systemd sandboxing, non-root user, no Linux capabilities, private `/tmp`, read-only home/system views |

## Operational Notes

- `.env` is ignored by git and must remain `0600`.
- Rotate SMTP credentials immediately if a scanner reports a concrete leaked
  value. After rotation, verify SMTP auth and restart `taskmanager.service`.
- The public app should remain behind nginx/TLS with `INTERFACE=127.0.0.1`.
- `TRUST_PROXY` should contain only the immediate nginx peer addresses.
- `COOKIE_INSECURE=1` is only for local HTTP development.

## Verification

Run the local safety checks before pushing:

```bash
./scripts/check.sh
```

Run endpoint smoke tests only against a disposable/dev environment unless you
intend to create test accounts and send verification mail:

```bash
RUN_SMOKE=1 ./scripts/check.sh
```

## Known Follow-Ups

- Add integration tests that run against an isolated SurrealDB test database.
- Replace the curl SMTP subprocess with a native SMTP client if the dependency
  tradeoff becomes worthwhile.
