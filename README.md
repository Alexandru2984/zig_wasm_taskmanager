# Zig Task Manager

Production-style task manager built in Zig with a Zap backend, SurrealDB,
WebAssembly frontend, self-hosted SMTP email, hardened authentication, and a
systemd-sandboxed VPS deployment.

![Dashboard Preview](docs/screenshot-dashboard.png)

## Highlights

- Zig backend with [Zap](https://github.com/zigzap/zap) and facil.io.
- Zig-to-WebAssembly frontend module served with static assets.
- SurrealDB persistence for users, sessions, verification tokens, reset tokens,
  workspaces, memberships, and tasks.
- Argon2id password hashing and server-side sessions carried by HttpOnly
  cookies.
- Multi-workspace task tenancy with owner/admin/member/viewer roles, member
  listing, and email invite acceptance.
- Email verification and password reset through SMTP.
- Optional email reminders for overdue incomplete tasks.
- Activity log API for account and task actions.
- Per-route rate limiting, strict CORS, CSP, HSTS, safe static-file serving,
  CSRF protection, and protected metrics.
- Production deployment behind nginx/TLS with a hardened systemd service.

## Portfolio Summary

Built and deployed a production-style task manager in Zig with Zap, SurrealDB,
WASM frontend, Argon2id authentication, HttpOnly session cookies, email
verification/password reset via self-hosted SMTP, optional task reminders,
activity logging, workspace/RBAC foundations, CSRF protection, rate limiting,
CSP/HSTS security headers, systemd sandboxing, health/readiness endpoints, and
protected metrics.

More: [docs/PORTFOLIO.md](docs/PORTFOLIO.md)

## Screenshots

| Login Page | Dashboard |
| --- | --- |
| ![Login](docs/screenshot-login.png) | ![Dashboard](docs/screenshot-dashboard.png) |

## Quick Start

Requirements:

- Zig 0.15.x
- SurrealDB reachable over HTTP
- SMTP credentials for verification/reset email

```bash
git clone <repo-url>
cd taskmanager
cp .env.example .env
zig build run
```

The app defaults to `http://127.0.0.1:9000`.

## Verification

```bash
./scripts/check.sh
```

This runs formatting checks, `zig build`, and `zig build test`.

Smoke tests create a test user and may send verification email, so they are
opt-in:

```bash
RUN_SMOKE=1 ./scripts/check.sh
```

For production-like local testing with Secure cookies, run smoke tests through
the local nginx HTTPS vhost:

```bash
BASE_URL=https://task.micutu.com \
CURL_RESOLVE=task.micutu.com:443:127.0.0.1 \
RUN_SMOKE=1 ./scripts/check.sh
```

## Architecture

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
  |       mailcow / SMTP provider
  v
SurrealDB HTTP API
```

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## API

The OpenAPI document is in [docs/openapi.yaml](docs/openapi.yaml).

Main endpoint groups:

- `/api/auth/*`: signup, login, logout, verification, password reset
- `/api/profile*`: profile and password changes
- `/api/workspaces`: workspace listing, creation, members, and invites
- `/api/tasks*`: task CRUD with priority and due-date metadata
- `/api/activity`: authenticated activity log
- `/api/health`, `/api/ready`, `/api/metrics`: operational endpoints

## Security

Security controls are documented in [SECURITY.md](SECURITY.md).

Current controls include:

- Argon2id password hashing
- server-side sessions with HttpOnly cookies and hashed DB tokens
- double-submit CSRF protection for cookie-authenticated writes
- workspace membership checks for task reads/writes
- reset-token invalidation and session invalidation after password reset/password change
- authenticated email verification with per-user attempt caps
- route-specific rate limiting, including login account throttling and invite throttling
- strict CSP/HSTS/security headers
- SurrealQL variable binding for user input
- path traversal protection for static assets
- SMTP credentials stored only in `.env`; CI secret scanning blocks new leaks
- systemd sandboxing for the deployed process

## Project Structure

```text
src/
  main.zig              routing, CORS, security headers, static serving
  handlers/             auth, profile, task, and system endpoints
  services/             auth and email services
  db/                   SurrealDB repository and HTTP client
  util/                 HTTP helpers, validation, rate limiting, logging
frontend/src/main.zig   WASM frontend module
public/                 HTML, CSS, JS, generated WASM
scripts/check.sh        local verification entry point
scripts/smoke_test.sh   optional API smoke tests
docs/                   deployment, architecture, roadmap, OpenAPI, portfolio
```

## Roadmap

The current roadmap focuses on making the app more useful while keeping the
engineering work visible:

- isolated integration test database
- ongoing secret-scanning review
- workspace member management UI
- task labels
- recurring tasks
- activity export

More: [docs/ROADMAP.md](docs/ROADMAP.md)

## Deployment

The reference deployment runs the release binary under systemd with nginx as
TLS-terminating reverse proxy, SurrealDB on localhost, and SMTP via mailcow.

More: [docs/DEPLOY.md](docs/DEPLOY.md)

## License

MIT
