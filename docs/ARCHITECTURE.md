# Architecture

Task Manager is a small production-style web app built around a Zig backend,
SurrealDB persistence, and static frontend assets served by the same process.

## Runtime Shape

```text
Browser
  |
  | HTTPS
  v
Cloudflare / nginx
  |
  | HTTP on 127.0.0.1:9000
  v
Zig + Zap server
  |        \
  |         \ SMTP 587
  |          v
  |       mailcow
  v
SurrealDB HTTP API on localhost
```

## Backend

- `src/main.zig` owns routing, CORS, security headers, static serving, and API
  dispatch.
- `src/handlers/*` contains endpoint behavior for auth, profile, tasks, and
  system checks.
- `src/services/auth.zig` handles password hashing, verification, reset tokens,
  and verification codes.
- `src/services/email.zig` builds MIME messages and sends them through SMTP.
- `src/db/surreal.zig` exposes repository-style functions for users, tasks, and
  sessions.
- `src/db/http_client.zig` performs SurrealDB HTTP requests and binds variables
  into SurrealQL safely.

## Frontend

- `public/index.html`, `public/style.css`, and `public/app.js` provide the
  shipped UI.
- `frontend/src/main.zig` builds the WASM module installed as
  `public/app.wasm`.
- Auth uses an HttpOnly cookie; JavaScript never stores session tokens.

## Data Model

Core tables:

- `users`: email, Argon2id password hash, profile name, verification/reset
  fields.
- `sessions`: opaque session token, `users` record reference, expiry timestamp.
- `tasks`: `users` record reference, title, priority, completion state,
  creation time, optional due date.

Planned task extensions:

- labels
- reminder timestamp and sent marker
- recurrence rule
- activity log events

## Operational Model

The reference VPS deployment runs:

- nginx for TLS termination and reverse proxying
- systemd for process supervision and sandboxing
- SurrealDB in Docker bound to localhost
- mailcow as the local SMTP provider

The service exposes:

- `/api/health`: process liveness
- `/api/ready`: database/config readiness
- `/api/metrics`: protected metrics, enabled only with `METRICS_TOKEN`
