# Portable installation and upgrade — P5a

This is a separate installation path for a new client, not a conversion of the
existing VPS service. It needs no production `.env`, personal domain, global
container name or `/var/lib` bind mount. It does not modify nginx/systemd,
purchase services, configure billing, upload backups or send test email.

Supported: Linux amd64, local Docker Engine **28+**, Compose **2.30+**, Node
**22+**, and an operator allowed to use that Docker daemon. Remote Docker
contexts are refused. The operator needs an existing writable parent directory
for private configuration, sufficient disk space and two unused loopback ports.
Ports 9000/8010 are reserved from this helper to avoid the historical live pair.
ARM, rootless/user-remapped Docker and Windows have not been verified.

## Build and install

Build from the intended checkout. The image contains the ReleaseSafe binary,
the library actually selected by its linker, freshly built WASM and matching
asset stamps. No host compiler or npm dependency is needed at runtime.

```bash
docker build --platform linux/amd64 \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  -t taskmanager:client-v1 .

# Replace this with a NEW absolute path outside the checkout, under an
# existing directory owned by the current operator. Keep it across upgrades.
TASK_INSTALL_DIR=/absolute/operator-owned/taskmanager-client

node scripts/portable.mjs init "$TASK_INSTALL_DIR" client \
  https://tasks.example.com 9320 8030 taskmanager:client-v1
node scripts/portable.mjs install "$TASK_INSTALL_DIR"
node scripts/portable.mjs status "$TASK_INSTALL_DIR"
```

Choose the real public HTTPS origin before installation. For a local-only trial,
use `http://127.0.0.1:9320` instead, with the matching application port. The
helper enables insecure cookies only for a matching localhost HTTP origin;
HTTPS requires secure cookies. Do not put the HTTP trial directly on the internet.

`init` only prepares private files; it refuses an existing directory, occupied
ports, unsafe origins, paths inside its checkout and images without the expected
non-root/schema metadata. `install` creates a uniquely named Compose project
and a fresh named RocksDB volume. It refuses an existing project/volume and
never silently bootstraps an existing store. Files are synchronized to disk
before credentials are used, and state changes use rename plus directory sync.

The installation sequence is:

1. Start the empty DB once with generated bootstrap credentials.
2. Verify its root identity persists, then recreate the DB without those
   credentials in startup arguments or environment.
3. Run the matched image as a one-shot migration process; remove its container.
4. Provision a database EDITOR for serving, verify root access is denied, then
   start the non-root application and require `/api/ready` success.

Both listeners bind to `127.0.0.1`, not the public interface. The DB's localhost
port is for local administration/export; localhost is not isolation from other
processes on this host. Docker Engine 28+ avoids the older same-L2 localhost
publishing caveat documented by [Docker](https://docs.docker.com/engine/network/port-publishing/).

## Private configuration and ownership

The operator directory is mode 0700; its files are mode 0600 and must belong to
the current operator. Symlinked/private files with broader permissions are
refused. The generated project identity prevents an unrelated client project
from being stopped or recreated accidentally.

| File | Purpose | Available to ordinary application? |
| --- | --- | --- |
| `admin.env` | Database administrator, migration and local export | No; migration process only |
| `bootstrap.env` | Initial root bootstrap, retained for recovery | No; initial DB process only |
| `runtime.env` | DB EDITOR, mail encryption key, metrics, public origin and SMTP settings | Yes |
| `state.json` | Current/previous immutable image IDs, phase, project and ports | No; operator state |
| `compose.yaml`, `bootstrap.yaml` | Copy of the reviewed installation definitions | No container mount |

The helper invokes Compose using explicit files/project/environment. It does
not inherit ambient `COMPOSE_*` or `TM_*` overrides, shell-source private files,
put passwords in command arguments, or print expanded Compose/DB responses.
Do **not** run `docker compose config` or paste `docker inspect` output into
support tickets: Compose `env_file` secrets are visible to Docker administrators.
This is not a secret vault, encrypted environment or tenant-scoped DB credential.

The application runs as UID/GID 10001, with a read-only filesystem, no Linux
capabilities, no-new-privileges, a bounded `/tmp`, 1 GiB memory and 128 PIDs.
The DB currently uses UID 0 inside its own restricted container to initialize
the fresh volume; capabilities are dropped, its root filesystem is read-only,
and only its named data volume/tmpfs are writable. This is not a rootless DB
claim. Docker/host administrators remain trusted. JSON logs are rotated locally
at three 10 MiB files per service; database volume/disk growth is not bounded.

## Public proxy, email and origin changes

Configure your own TLS reverse proxy to the chosen application loopback port,
forwarding Host and the real client address. This stage does not install or
replace proxy/vhost certificates, firewall policy or Cloudflare settings.
`TRUST_PROXY` starts empty. If you enable it, determine the actual proxy peer
seen inside this container and trust only that exact controlled address;
do not trust an entire private network. Until configured, IP-based limiting
may group proxied clients under one address. Per-user budgets still apply.

Mail delivery/reminders start disabled. In private `runtime.env`, set the
existing SMTP settings, verify TLS/identity, then deliberately enable
`MAIL_WORKER_ENABLED=1`. Configure reminders separately. Raw Compose env files
do not interpolate `$` in passwords; values are literal, so do not add shell
quotes around them. See [Docker's env_file format](https://docs.docker.com/reference/compose-file/services/#env_file).
Retain the generated `MAIL_OUTBOX_KEY`; regenerating it for an existing DB
refuses startup and cannot decrypt queued messages. Set a new secret through a
reviewed rotation procedure, not by rerunning `init` or editing only one copy.

To review an origin change: stop the application, update `state.json`'s origin
and `runtime.env`'s `APP_BASE_URL`, `CORS_ORIGIN`, `COOKIE_INSECURE` together,
check proxy/TLS configuration and start again. HTTPS requires cookie value 0.
HSTS is an explicit operator setting after HTTPS works. Brand/SEO metadata in
the current static HTML/sitemap still names the original product deployment;
client branding remains P10 work, not a completed white-label feature.

## Upgrade, rollback and maintenance

Build or load a trusted next image locally before requesting an upgrade. The
helper resolves its immutable Docker image ID, so changing a tag later does
not change the selected deployment. Retain the previous image; do not prune it
while it is a rollback target. No registry push or remote deployment occurs.
An image upgrade does not replace the installed Compose/config files; review
manifest changes separately instead of overwriting operator configuration.

```bash
node scripts/portable.mjs backup "$TASK_INSTALL_DIR"
node scripts/portable.mjs upgrade "$TASK_INSTALL_DIR" taskmanager:client-v2
node scripts/portable.mjs status "$TASK_INSTALL_DIR"
# Only when needed, as an explicit operator decision:
node scripts/portable.mjs rollback "$TASK_INSTALL_DIR"
```

Upgrade stops only this application's container, exports the DB locally, records
the old/new image IDs, runs the new migration process and starts the application.
The DB remains running. There is a maintenance window, not a zero-downtime promise.
Migration/startup failure leaves the application stopped and state `failed`;
no old DB export is automatically imported. Rollback starts the recorded prior
image without running an older migration, preserving later tasks and sessions.
A completed rollback clears the previous pointer rather than offering a failed
candidate as the next rollback target. An unavailable previous image must be
reloaded from a trusted retained artifact.

Only images declaring portable format 1 and schema family `017` are accepted.
Existing family-015/016 installations require a separately reviewed upgrade;
this tool intentionally refuses them. Family-016 lacks personal-view export and
deletion hooks; family-015 additionally ignores archive state. Neither is an
unconditional rollback target. This batch does not migrate another host or a
client installation. See [saved-view compatibility](SAVED-VIEWS.md).
This is a compatibility gate, not proof that an arbitrary image is trustworthy.
Cross-family migrations/rollbacks require a new review/helper version. Never
substitute a pre-trash or pre-version binary merely because it starts.
See [task versions](TASK-VERSIONS.md#rollback) and [trash](TASK-TRASH.md).

`stop` retains the DB and all data; `start` recreates only the selected app and
checks readiness. Neither command deletes a volume. All mutating helper commands
take an exclusive operation lock and reread state after acquiring it. A crash
can retain `operation.lock` or `state.next.json`: inspect the recorded PID,
containers and both state files before clearing that exact stale artifact.
Do not run two operators against an installation or edit it during an operation.

An interrupted upgrade in `changing` may use the explicitly recorded compatible
rollback target after inspection. An interrupted initial install in `installing`
requires an operator recovery review; the helper intentionally does not guess
which bootstrap/provision steps completed. Preserve the private directory,
database volume and root identity, inspect migration/user state, and fix forward.
Do not delete the directory/volume and rerun bootstrap over possible customer data.

## Local export and recovery

Exports are streamed to private `.partial` files with a 512 MiB limit and a
120-second request timeout, synchronized, then renamed to `.surql` only after
completion. At least 512 MiB free disk is required. A failed export prevents
upgrade; it may leave a private partial artifact for inspection and the app
stopped. If state is still `ready`, `start` resumes the unchanged image.

The export contains personal data and DB user definitions, not just tasks.
Retain private configuration, especially the mail key, alongside exports and
the matched images. Exports from a running DB are not a guarantee of a frozen
application snapshot. No automatic retention/purge or off-host backup is added.
The same-host directory and Docker volume do not cover complete VPS loss.

The verification fixture restores an export into a **separate empty** database
and checks user/task/session counts against the source. For real recovery,
perform that isolated drill first, compare affected records and migrations,
then choose a deliberate cutover/merge. Never import an old snapshot over newer
customer writes as a routine rollback. The [incident runbook](INCIDENT-RESPONSE.md)
provides containment and an unsent communications template.

## Supply chain, CISO review and verification

Top STRIDE risks: information disclosure through build/config artifacts,
tampering/data loss through wrong-project operations or stale restores, and
denial of service through an invalid upgrade. Worst-case runtime compromise
still exposes all app tenants in its database plus mail secrets; host/Docker
compromise can affect other services. Customer count, cost/ALE and measured
MTTD are unknown; companion financial/compliance scripts remain unavailable.

Detection is explicit readiness, phase/exit status and restricted runtime checks
during operations. Logs alone are not automatic compromise detection. The VPS
owner remains responder; an alert destination/schedule and human response time
are not established. No new paid vendor, notification, DPA or legal/compliance
assurance is introduced. Notification duties depend on actual roles/contracts.

Desk/fixture walkthrough: leaked runtime credential → verify root denial and
rotate through its owner; failed migration/startup → preserve the export/state,
stop serving and explicitly roll back; lost DB → restore into a separate empty
instance and compare counts before considering production cutover. These are
technical/desk exercises, not a staffed incident or notification drill.

The Docker frontend, Debian base and DB image are digest-pinned, and the Zig
0.15.2 archive is checked against the [official download manifest](https://ziglang.org/download/index.json).
Zig dependencies retain their existing commit/content hashes. APT repositories
still update between builds; rebuilding is **not bit-for-bit reproducibility**.
Deployment/rollback reuse the selected image identity. Digest pinning is not a
signature, vulnerability scan or promise of timely patching; review and update
pins deliberately. The build context allow-list excludes private/local files.

```bash
zig build test -j2 -Doptimize=ReleaseSafe --summary all
node scripts/portable_test.mjs taskmanager:client-v1
# Optional: installed Playwright/Chromium is required for browser regressions.
RUN_PORTABLE_UI=1 node scripts/portable_test.mjs taskmanager:client-v1
```

CI builds/loads the image locally and runs the portable fixture without push.
The fixture owns a new temporary project, removes only that project's containers,
volumes/networks and synthetic exports, and leaves other services untouched.
This is P5a: clean-volume Docker installation and recovery tooling. A truly
fresh-machine/operator acceptance drill, automated TLS/proxy packaging,
multi-architecture support and client branding remain open.

### Recorded verification — 2026-09-15

The image built successfully with the checked Zig archive and matching linked
library/assets. **14 portable scenarios passed**, including fresh bootstrap,
runtime/root separation, private-file/operation-lock refusal, real account/task
flows, successful upgrade, later writes retained by rollback, distinct migration
and readiness failures, persistent DB restart and isolated export restoration.
**71 browser checks passed against the Docker image**, including WASM, phone
layouts, editing, trash/Undo and private-state cleanup. **56 ReleaseSafe unit
tests passed**. Final configuration probes separately refused a cookie-security
downgrade and a mismatched administrator endpoint. JavaScript/YAML syntax and
diff whitespace were checked.

The tested image was local `taskmanager-portable:20260915-final`, image ID
`sha256:4ce2361d28f169ffa077f19331582c8ba5538b5c123471de94ef87279cd2d162`.
Its build reference records the pre-commit P5 working tree, not a published
release. The upgrade fixture uses a second image identity with the same binary
and schema; it does not certify arbitrary future schema upgrades.

Fixtures used only newly created Docker projects/volumes, synthetic accounts
and temporary private files. They were removed after verification. No real SMTP,
production accounts, live vhost changes or external backups were used. The
existing systemd deployment stayed on `a4c4485`, healthy with zero unexpected
restarts. This was a clean-volume test on the existing host, not yet a clean-VM
or independent-operator acceptance exercise. CISO verdict: verified P5a tooling;
retain the explicit commercial/TLS/host-recovery limitations above.
