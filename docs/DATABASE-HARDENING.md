# Database bootstrap, rotation and restart

SurrealDB 3.2.4 keeps its root user in the persistent store. The ordinary
Compose file deliberately supplies **no bootstrap credentials**. Authentication
remains enabled. An empty server started without a root user is not a usable
fresh installation: use the bootstrap override only for that first start.

Sources: [persistent root identity](https://surrealdb.com/docs/running/file-backed)
and [ALTER USER](https://surrealdb.com/docs/reference/query-language/statements/alter/user).
Behavior is also exercised against the pinned image by the local drill below.

## New empty installation

1. Create the private `.env` with unique administrator credentials and the
   correct namespace/database. Do not reuse a password from another service.
2. Start with `docker compose -f docker-compose.yml -f docker-compose.bootstrap.yml up -d surrealdb`.
3. Apply schema with the separate administrator configuration. Provision the
   application's database EDITOR configuration; never serve with root.
4. Verify administrative and runtime authentication, then recreate with
   `docker compose -f docker-compose.yml up -d --force-recreate surrealdb`.
5. Verify restart/readiness and that neither container arguments nor container
   environment contains bootstrap credentials. Do not print resolved Compose
   configuration or complete Docker inspection containing secrets.

## Rotate an exposed administrator password

Only for this dedicated local DB. The helper refuses a shared namespace, except
SurrealDB's untouched empty main/main bootstrap namespace. It checks the
configured root identity and preserves its roles/session settings with ALTER.

```
sudo install -d -m 0700 /var/backups/taskmanager/CHOOSE-NEW-PRIVATE-DIRECTORY
sudo node scripts/db_admin.mjs backup /path/to/admin.env /var/backups/taskmanager/CHOOSE-NEW-PRIVATE-DIRECTORY/pre.surql
sudo node scripts/db_admin.mjs rotate-admin /path/to/admin.env /var/backups/taskmanager/CHOOSE-NEW-PRIVATE-DIRECTORY/recovery.env
sudo node scripts/db_admin.mjs verify-admin /path/to/admin.env unused
sudo node scripts/db_admin.mjs verify-runtime /path/to/runtime.env unused
```

Choose an unused directory, not the literal placeholder. The helper saves and
fsyncs a new mode-0600 recovery config **before** rotation, verifies new root
access and old-password denial, then atomically replaces the source config
while preserving its ownership. It does not change the runtime DB password.

If interrupted or an HTTP response is ambiguous, do not rerun rotation with
another candidate. Test the existing private recovery config using verify-admin;
it contains the prepared credential. Never paste it into logs or a ticket.
The password used by clients is rotated; this does not certify that a previously
compromised host is clean or that every historical bearer token was revoked.

For container replacement, preserve exact image, datastore mount and loopback
binding; retain the old stopped container with restart disabled. Stop one
container before starting the other on that volume. On failure, stop the new
container before restarting the retained one; the persisted rotated identity
survives even when old bootstrap values are present. Never restore a database
export automatically during a container-only rollback.

## Disposable verification

`sudo node scripts/db_hardening_test.mjs` uses a private temporary RocksDB store,
random secrets and loopback port 8041. It checks refusal of unrelated namespaces,
credential rotation/recovery permissions, persistent data/root/runtime access,
runtime root denial, startup without secrets and rollback to the original
container. Owned test containers and data are removed afterwards. It never
reads production configuration or changes production containers.

## Production evidence — 2026-09-08

Implementation commit: `e7ee103`. The disposable persistent drill passed,
including shared-namespace refusal, rotation, recovery-file permissions,
old-password denial, restricted runtime access and container rollback.

On the dedicated production DB, `main/main` was confirmed to have no schema,
users or access definitions; the only application namespace is `taskmanager`.
The exposed administrator password was rotated. New admin access worked, old
Basic authentication returned 401, and database EDITOR access still worked
while root access was denied. The original admin configuration was atomically
updated with its existing ownership; runtime credentials were unchanged.

The original image ID, RocksDB bind mount, log volume, bridge network and
loopback port 8010 were preserved. The running replacement container contains
no bootstrap credential arguments or environment variables. The former
container is retained stopped as `surrealdb-taskmanager-v3-before-20260908`,
with automatic restart disabled. Never start it while the replacement uses
the same database directory.

Protected pre/post exports (31,557 bytes each), old container inspection,
previous admin config and new admin recovery config are under
`/var/backups/taskmanager/20260908-db-hardening` (root-only directory; files
mode 0600). No production database export was imported, and no customer data
was deleted. Temporary drill containers/data were removed; source backups
remain recoverable. No external upload occurred.

Local and public `/api/ready` returned ready/connected after the controlled
restart. Application release remained `84d1936`, active with zero automatic
restarts. This closes the specific active startup-secret exposure, not every
possible host compromise or prior administrative bearer-token exposure.
