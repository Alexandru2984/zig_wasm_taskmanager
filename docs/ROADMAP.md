# Roadmap

This roadmap keeps the project useful as an app while making the engineering
work visible for interviews and portfolio review.

## 1. Engineering Maturity

- Maintain `zig build`, `zig build test`, and `./scripts/check.sh` as the
  baseline verification flow.
- Add isolated integration tests with a disposable SurrealDB namespace.
- Add secret scanning to CI.
- Publish an OpenAPI document for the public API.

## 2. Security Posture

- Add lockout/backoff visibility for auth endpoints.
- Add audit events for password resets and login failures.
- Keep deployment hardening documented and reproducible.

## 3. Product Features

- Add labels for task grouping.
- Add recurring tasks with a conservative recurrence model.
- Add JSON/CSV export.

## 4. Demo Readiness

- Keep screenshots current.
- Add demo-mode seed data for local runs.
- Add a one-command local smoke test.
- Keep `docs/PORTFOLIO.md` aligned with the deployed app.
