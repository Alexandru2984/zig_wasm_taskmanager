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
