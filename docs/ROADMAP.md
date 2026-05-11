# Roadmap

This roadmap keeps the project useful as an app while making the engineering
work visible for interviews and portfolio review.

## 1. Engineering Maturity

- Maintain `zig build`, `zig build test`, and `./scripts/check.sh` as the
  baseline verification flow.
- Add isolated integration tests with a disposable SurrealDB namespace.
- Add CI with build, tests, formatting, and secret scanning.
- Publish an OpenAPI document for the public API.

## 2. Security Posture

- Add explicit CSRF tokens for state-changing requests.
- Add lockout/backoff visibility for auth endpoints.
- Add audit events for password changes, password resets, and login failures.
- Keep deployment hardening documented and reproducible.

## 3. Product Features

- Add labels for task grouping.
- Add email reminders for due tasks.
- Add recurring tasks with a conservative recurrence model.
- Add activity history per task.
- Add JSON/CSV export.

## 4. Demo Readiness

- Keep screenshots current.
- Add demo-mode seed data for local runs.
- Add a one-command local smoke test.
- Keep `docs/PORTFOLIO.md` aligned with the deployed app.
