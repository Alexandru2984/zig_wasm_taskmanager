# Roadmap

This roadmap keeps the project useful as an app while making the engineering
work visible for interviews and portfolio review.

## 1. Engineering Maturity

- Maintain `zig build`, `zig build test`, and `./scripts/check.sh` as the
  baseline verification flow.
- Extend the integration suite to cover the workspace invitation flow, which
  needs a verified account and so is currently only exercised by hand.
- Keep CI secret scanning enabled and review findings before merging.
- Publish an OpenAPI document for the public API.

## 2. Security Posture

- Give the app a scoped database user instead of root. Largest outstanding
  item now that the server itself is current.
- Check new passwords against Have I Been Pwned's range API rather than the
  short built-in list.
- Add audit events for password resets and login failures.
- Persist rate-limit state so the per-account login budget survives a restart,
  as the nginx zones already do.
- Keep deployment hardening documented and reproducible.

Done: SurrealDB upgraded 1.5.6 -> 3.2.4 with a rehearsed, reversible
migration; workspace RBAC with role changes and member removal; CSRF bound to the
session; `__Host-` cookies; origin restricted to Cloudflare; edge rate limits;
email normalisation; account deletion with re-authentication.

## 3. Product Features

- Add a service worker so the app opens offline.
- Add saved filters, so a search someone runs daily is one click.
- Add per-workspace task templates.

Done: workspace selector and member management UI; invitation accept flow;
task editing with notes, tags, due dates and priorities; search, filters and
sorting; session management; JSON and CSV export; installable web manifest;
Kanban board; subtasks; recurring tasks; task assignment; bulk actions;
keyboard shortcuts.

## 4. Demo Readiness

- Keep screenshots current.
- Add demo-mode seed data for local runs.
- Add a one-command local smoke test.
- Keep `docs/PORTFOLIO.md` aligned with the deployed app.
