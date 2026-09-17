# Zig Task Manager

Production-style task manager built in Zig with a Zap backend, SurrealDB,
WebAssembly frontend, self-hosted SMTP email, hardened authentication, and a
systemd-sandboxed VPS deployment.

![Dashboard Preview](docs/screenshot-dashboard.png)

## Highlights

- Zig backend with [Zap](https://github.com/zigzap/zap) and facil.io.
- Zig-to-WebAssembly module that owns the anonymous/offline task state, mirrored
  to `localStorage` for persistence across reloads.
- Accessible, responsive UI with light and dark themes: focus-trapped modals,
  keyboard-navigable menus, `aria-live` announcements, and reduced-motion support.
- SurrealDB persistence for users, sessions, verification tokens, reset tokens,
  workspaces, memberships, and tasks.
- Argon2id password hashing and server-side sessions carried by HttpOnly
  cookies.
- Full task editing: title, notes, tags, priority, due date, assignee and
  recurrence, edited inline; plus search across titles/notes/tags, filters
  (active, done, overdue, high priority) and five sort orders.
- Server-paged list/board: at most 50 parents and one 50-child page in the main
  task collection, with global workspace counters and server search/filter/sort.
  Exact-tag filtering reaches beyond the top 50 facets; drafts survive failed
  refreshes. See [bounded main view](docs/TASK-VIEW.md).
- A Kanban board alongside the list, with drag-and-drop on pointer devices and
  arrow buttons everywhere else.
- Subtasks, which are ordinary tasks with a parent, so they inherit editing,
  tags, due dates and the workspace permission model.
- Recurring tasks (daily, weekly, monthly); completing one creates the next.
- Selection mode with bulk complete, reopen and delete.
- Workspace task trash and real Undo preserving original task/subtask IDs and
  metadata. Signed-in deletion is recoverable; account deletion is not.
- Conditional task edits/deletion and two-tab conflict recovery: retain an
  unsaved draft, review the current record, then choose which fields to keep.
  [Task versions](docs/TASK-VERSIONS.md) document the required `If-Match` contract.
- Global server-side task finder with filtered/sorted pages across accessible
  workspaces, independent of the main view's loaded page.
- Transactional task/text and owned-workspace quotas, plus an accessible
  usage panel. Trash remains counted; existing data is preserved when limits
  are lowered. These are [logical budgets](docs/TASK-QUOTAS.md), not disk quotas.
- Keyboard shortcuts and complete, cancellable workspace CSV export, independent
  of the visible page, with formula-leading cell mitigation and no partial
  download after an error. Browser export has an explicit size budget.
- Multi-workspace task tenancy with owner/admin/member/viewer roles and email
  invite acceptance. [Team directory and assignment](docs/TEAM-COLLABORATION.md)
  are available to ordinary members without exposing emails, with bounded name
  search/pages, plus owner/admin workspace renaming with conflict protection.
- [Controlled ownership transfer](docs/WORKSPACE-OWNERSHIP.md) to an existing
  verified teammate, with current-password confirmation, atomic roles/activity
  and quota/conflict protection. Former owners become admins; task authorship
  and account-deletion rules do not change.
- [Workspace archive/unarchive](docs/WORKSPACE-ARCHIVE.md): retained read-only
  tasks, paused reminders, cancelled pending invitations and conflict-safe
  reactivation. Access management and account-deletion rules still apply.
- Email verification, password reset and invitations through an encrypted,
  transactional email outbox, with bounded retries and per-account delivery status.
  Signup still reveals existing addresses; timing equivalence is not established.
- Optional email reminders before task deadlines.
- Activity log for account and task actions, with a UI to read it.
- Session management: see where you are signed in and revoke a device.
- JSON data export and account deletion, both reachable from the app.
- Per-route rate limiting, strict CORS, CSP, HSTS, safe static-file serving,
  CSRF protection, and protected metrics.
- Portable app/DB installation with private credential generation, separate
  migration identity, image-pinned upgrades and rollback preserving later writes.
  The existing VPS database-only Compose path remains separate.
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

| Dashboard | Login | Mobile |
| --- | --- | --- |
| ![Dashboard](docs/screenshot-dashboard.png) | ![Login](docs/screenshot-login.png) | ![Mobile](docs/screenshot-mobile.png) |

## Quick Start

### New client installation

Use the [portable installation guide](docs/PORTABLE-INSTALL.md): build the image,
prepare a new private directory outside the checkout, and run the installer.
It deploys both app and database on chosen loopback ports with a database-scoped
runtime identity. Upgrade, local export, rollback and interrupted-operation
recovery are documented there. TLS/proxy configuration remains operator-owned;
this is not yet a fully automated white-label installer.

### Existing VPS database-only path

The versioned Compose file runs the database only. Configure `.env` first,
then start it and run the app from source as described below:

```bash
cp .env.example .env
chmod 600 .env
# Private recovery directory outside the repository; keep the generated key.
install -d -m 700 ../taskmanager-private-recovery
node scripts/provision_mail_key.mjs .env ../taskmanager-private-recovery/mail-runtime.env
# Set a strong SURREAL_PASS and SURREAL_URL=http://127.0.0.1:8010 in .env.
# New empty database only (omit the bootstrap override for an existing store):
docker compose -f docker-compose.yml -f docker-compose.bootstrap.yml up -d surrealdb
# After initialization, recreate without bootstrap credentials; see
# docs/DATABASE-HARDENING.md for the complete bootstrap/runtime separation.
```

The source-run app serves `http://127.0.0.1:9000`. For local HTTP only, set
`COOKIE_INSECURE=1` and `CORS_ORIGIN=http://127.0.0.1:9000`. The standalone
Dockerfile builds the app image; the root Compose file remains DB-only.
The separate portable stack above deploys both services without these VPS paths.

### From source

Requirements:

- Zig 0.15.x
- SurrealDB reachable over HTTP
- SMTP credentials for verification/reset email (optional for local use)
- Node 22+ for private configuration and test helpers; curl and OpenSSL for SMTP/tests

```bash
git clone <repo-url>
cd taskmanager
cp .env.example .env   # or provide configuration through the environment
# Configure DB settings and provision MAIL_OUTBOX_KEY using the steps above.
zig build run
```

The app defaults to `http://127.0.0.1:9000`. Recognized configuration keys can be
overridden by process environment variables of the same name.
`MAIL_OUTBOX_KEY` is required even when local SMTP is not configured. Keep it
outside the DB and retain it across upgrades; a different key refuses startup.
See [durable email operations](docs/DURABLE-EMAIL.md) before upgrading an existing install.

## Verification

```bash
./scripts/check.sh            # formatting, build, unit tests
./scripts/integration_test.sh # API against a throwaway SurrealDB
npm ci
node scripts/mail_ops_test.mjs
RUN_MAIN_VIEW=1 RUN_SECURITY=1 RUN_TRASH=1 RUN_PAGINATION=1 RUN_VERSIONS=1 RUN_SEARCH=1 RUN_QUOTAS=1 RUN_UI=1 RUN_OUTBOX=1 ./scripts/integration_test.sh # isolated full suite
```

CI covers formatting/unit, API, browser and portable Docker installation tests.
For the portable image locally, run `node scripts/portable_test.mjs IMAGE`;
add `RUN_PORTABLE_UI=1` to exercise the browser suite against that image too.

`integration_test.sh` starts a real SurrealDB in Docker, builds and runs the
application against it, and drives the API through the smoke suite. It is not
redundant with the unit tests: every incompatibility found while moving the
database from SurrealDB 1.x to 3.x — a bound string no longer being a record
id, `DEFINE TABLE` rejecting a table that exists, a renamed time function —
compiles cleanly and passes every unit test. Only talking to a real database
catches them. The script also fails if the schema had to be retried, because a
schema statement the server rejects still leaves a process answering
`/api/health`, so liveness alone would call a broken deploy healthy.

`ui_test.mjs` covers what an HTTP-level suite cannot: that the WebAssembly
module loads and owns the signed-out task list, that a task titled
`<script>alert(1)</script>` renders as text and creates no script element,
that no viewport scrolls sideways, and that the task checkbox — 22px of paint
over a 44px hit area — is still hit when tapped 16px outside its visible box.

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
- `/api/workspaces`: workspace listing and creation; members (list, change
  role, remove) and invitations (create, list, revoke, accept)
- `GET /api/workspaces/{id}/usage`: authorized task/trash/text usage and
  operator-configured limits; quota-denied writes return 422
- `/api/tasks*`: task CRUD with priority, due date, notes, tags, board status,
  recurrence, assignee and parent; `PUT` applies a partial update, or toggles
  completion when the body is empty; use `GET /api/tasks?page=1` and follow
  `next_cursor` with `as_of` for complete reads
- `GET /api/tasks/{id}`: read an authorized active task and ETag; `PUT` and
  `DELETE` require that exact tag in `If-Match` (missing: 428; stale: 412)
- `/api/sessions*`: list and revoke sessions
- `/api/email-deliveries`: latest 100 own delivery records, with no payloads or tokens
- `/api/trash*`: scoped deleted-task pages and original-record restoration
- `/api/export`: everything the account holds, as one JSON document
- `/api/account`: delete the account, re-authenticating first
- `/api/activity`: authenticated activity log
- `/api/health`, `/api/ready`, `/api/metrics`: operational endpoints

## Security

Security controls are documented in [SECURITY.md](SECURITY.md).

Current controls include:

- Argon2id password hashing
- server-side sessions with HttpOnly cookies and hashed DB tokens
- CSRF tokens bound to the session they were issued with; cookie-authenticated
  writes still require the token when a Bearer header is also supplied
- `__Host-` cookie prefixes, which the browser refuses unless the cookie is
  Secure, Path=/ and has no Domain, making it unsettable by sibling subdomains
- workspace membership checks for task reads/writes
- reset-token invalidation and session invalidation after password reset/password change
- authenticated email verification with per-user attempt caps
- background email dispatch; no guarantee of account-enumeration timing equivalence
- route-specific rate limiting; the per-account login limit counts only failed attempts, and password changes are throttled
- nginx `limit_req` zones in front of the in-process limiters, which survive a restart
- the origin answers only Cloudflare edge addresses, so the WAF cannot be skipped by finding the server's IP
- email addresses normalised to lowercase, so one mailbox cannot hold two accounts
- account deletion requires the password again, not merely a live session
- strict CSP/HSTS/security headers
- SurrealQL variable binding for user input, unit-tested for injection escaping
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
frontend/src/main.zig   WASM module backing anonymous tasks
public/                 HTML, CSS, JS, SVG favicon, generated WASM
scripts/check.sh        local verification entry point
scripts/smoke_test.sh   optional API smoke tests
docs/                   deployment, architecture, roadmap, OpenAPI, portfolio
Dockerfile              multi-stage build (Zig builder + slim runtime)
docker-compose.yml      SurrealDB service (app deployed separately)
```

## Roadmap

Signed-in **Find tasks** provides [global server search](docs/TASK-SEARCH.md)
with status, priority, assignment, tag and due-date filters, five sorts and
bounded pages. Includes subtasks and other accessible workspaces; previews
recheck current access. This is separate from the main workspace's local
filters/counts and does not yet replace its complete-workspace loading.

Current audit and delivery plan: [security audit](docs/AUDIT-2026-09-06.md),
[product implementation](docs/PRODUCT-IMPLEMENTATION.md),
[prioritized stages](docs/DELIVERY-PLAN.md), [incident response](docs/INCIDENT-RESPONSE.md).

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
