# Production deployment

The service uses a dedicated `taskmanager` Unix user, immutable release files
under `/opt/taskmanager/releases`, and a private runtime configuration at
`/etc/taskmanager/runtime.env`. nginx serves the public directory in
`/opt/taskmanager/current`; the app and SurrealDB listen on loopback.

Requirements: Zig 0.15.2, SurrealDB 3.2.4, Node for admin/test tooling, Docker
for the database, and an existing nginx/TLS/Cloudflare configuration. This
guide is specific to the versioned `task.micutu.com` vhost.

Verified installation, 2026-09-07: `/opt/taskmanager/current` points to release
`20260907-973767a`. Protected recovery artifacts are under
`/var/backups/taskmanager/20260907-hardening`. The first rejected canary was
moved to `/opt/taskmanager/failed-canaries` and must not be used for rollback.

## Verify in a separate checkout

Do not edit a checkout directly served by nginx. Use a branch/worktree and
keep production credentials out of it.

```bash
npm ci
./scripts/check.sh
OPTIMIZE=ReleaseSafe RUN_SECURITY=1 RUN_UI=1 ./scripts/integration_test.sh
zig build -j4 -Doptimize=ReleaseSafe
./scripts/stamp-assets.sh
```

Review and commit the source and stamped URLs before promotion. The integration
harness creates its own DB, migrates with root, then serves using a database
EDITOR. It refuses occupied ports and never kills processes by port.

## First-time identity and credentials

Create a system user named `taskmanager` with its own group, no login shell,
no home directory and no sudo/Docker supplementary groups. Install the
versioned unit from `ops/taskmanager.service`.

Keep administrative DB credentials in the existing private operator config.
Take a backup with the source config path and an explicit NEW destination:

```bash
sudo node scripts/db_admin.mjs backup /home/micu/taskmanager/.env /var/backups/taskmanager/RELEASE/pre-deploy.surql
sudo node scripts/db_admin.mjs provision-runtime /home/micu/taskmanager/.env /etc/taskmanager/runtime.env
sudo chown root:taskmanager /etc/taskmanager/runtime.env
sudo chmod 0640 /etc/taskmanager/runtime.env
```

Create the backup parent directory as root mode 0700 and `/etc/taskmanager`
as root:taskmanager mode 0750 first. Provisioning refuses to replace an existing
runtime config/user and checks that root-level database access is denied.
It stores only the scoped DB credential in runtime configuration and preserves
the app/SMTP settings. Use separate config and a deliberate rotation procedure
to replace an existing credential.

Runtime settings: `SURREAL_AUTH_LEVEL=database`, `DB_AUTO_MIGRATE=0`,
`SERVER_THREADS=4`. A system database EDITOR still trusts the application for
tenant authorization; it is not database-enforced row-level isolation.

## Stage, migrate, promote

1. Stage the ReleaseSafe executable as `bin/taskmanager`, its matching
   `libfacil.io.so` as `lib/libfacil.io.so`, and the complete `public/`
   directory under a NEW release directory. Use root ownership and read/execute
   permissions only for the service; directories/static files must also be
   readable by nginx. Link release `.env` to the runtime configuration.
2. Back up the old unit and task vhost privately. Keep the preceding release.
   Run the NEW executable once with `DB_MIGRATE_ONLY=1`, the matching library
   path, and the administrative configuration as its working-directory `.env`.
   This migrates and exits without starting a listener. Never expose the
   administrative config to the serving process.
3. Point `/opt/taskmanager/current` atomically to the prepared release. Install
   `ops/taskmanager.service`, reload systemd, and restart only `taskmanager`.
4. Install the versioned task nginx files, run `nginx -t`, then reload nginx.
   The vhost relies on existing `cloudflare-realip.conf` and
   `cloudflare-origin-guard.conf` plus the shared dotfile/robots snippets.
   Do not replace shared configuration for unrelated applications.
5. Check `/api/ready` locally and through the public domain, verify API
   `Cache-Control: no-store`, secure cookies, CSP, and matching asset hashes.
   Check the process UID/groups and inability to open Docker/admin sockets
   inside its service namespace. Browser mutation tests remain confined to
   the disposable environment.

Migration 011 adds a recurrence marker and aligns board/completion state.
Already-completed recurring tasks are marked to avoid recreating their next
occurrence on an edit. These are additive schema changes: preserve user writes
and prefer a binary rollback over restoring the entire database.

## Backups and recovery

Database exports include personal data, hashes and session records. Keep them
mode 0600 in a root-only directory, with an explicit retention policy. An export
on the same VPS is not off-host disaster recovery.

For a restore drill, start an authenticated disposable database on an unused
loopback port with fresh random credentials. Pass `TEST_DB_USER` and
`TEST_DB_PASS` through the environment to:

```bash
node scripts/db_admin.mjs restore-test SOURCE_ENV http://127.0.0.1:TEST_PORT BACKUP_FILE
```

The helper imports into that server and compares account/task/session counts.
Keep the instance alive only for the drill and destroy its temporary data
afterwards. Prefer a synthetic fixture for repeated development tests.

See [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md) for containment, recovery and
incident communications. Record actual backup/restore and alert-delivery
evidence; a documented procedure alone is not a tested control.
