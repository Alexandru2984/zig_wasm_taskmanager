# Portfolio Notes

Use this project as a backend/security/deployment project, not as a generic
todo app.

## Short Description

Production-style task manager built in Zig with a Zap backend, SurrealDB,
WebAssembly frontend, hardened auth flows, self-hosted SMTP email, and systemd
sandboxed deployment.

## CV Bullet

Built and deployed a production-style task manager in Zig with Zap, SurrealDB,
WASM frontend, Argon2id authentication, HttpOnly session cookies, email
verification/password reset via self-hosted mailcow SMTP, rate limiting,
CSP/HSTS security headers, systemd sandboxing, health/readiness endpoints, and
protected metrics.

## What To Demo

- Login/signup with HttpOnly cookie sessions.
- Email verification and password reset through `mail.micutu.com`.
- Task CRUD with priorities, due dates, and ownership enforcement.
- Security posture: CSP/HSTS, rate limits, path traversal blocking, protected
  metrics, systemd sandboxing.
- Readiness endpoint showing database connectivity.

## Talking Points

- Why server-side sessions were chosen over browser-stored tokens.
- How rate limits are split by attack surface.
- How SurrealQL variables avoid database injection.
- How deployment hardening limits the blast radius of a compromised process.
- How secret rotation was handled after a scanner alert.

## Next Product Features

1. Priority and labels for task triage.
2. Email reminders for due tasks.
3. Recurring tasks with server-side expansion.
4. Activity log and export for auditability.
