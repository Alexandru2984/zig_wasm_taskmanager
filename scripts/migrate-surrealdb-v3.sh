#!/usr/bin/env bash
#
# Migrate the task manager's database from SurrealDB 1.x to 3.x.
#
# The two versions are not wire-compatible for this application, so the
# database and the binary have to move together:
#
#   * `UPDATE table:id CONTENT {…}` upserted in 1.x and only updates in 3.x, so
#     a 1.x dump restored into 3.x silently creates nothing and reports success.
#     Every such statement is rewritten to UPSERT.
#   * A bound string is no longer a record id outside `SELECT … FROM $x`. The
#     application binds ids through http_client.rec() instead, which emits
#     type::record().
#   * `DEFINE TABLE x` was a no-op on an existing table in 1.x and is an error
#     in 3.x, so the schema uses IF NOT EXISTS.
#   * Namespaces and databases are no longer created implicitly.
#   * time::from::millis was renamed time::from_millis.
#
# The old container and its data directory are left untouched, so rollback is
# stopping the new container and starting the old one.
#
# Usage: scripts/migrate-surrealdb-v3.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

OLD_CONTAINER="surrealdb-taskmanager"
NEW_CONTAINER="surrealdb-taskmanager-v3"
NEW_IMAGE="surrealdb/surrealdb:v3.2.4"
NEW_DATA_DIR="/var/lib/surrealdb-taskmanager-v3"
BACKUP_DIR="$HOME/backups/taskmanager"
STAMP="$(date +%Y%m%dT%H%M%SZ)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# Read only the keys we need, with a parser rather than `source`. Sourcing .env
# executes it, and values like `SMTP_FROM_NAME=Task Manager` are unquoted, so
# the shell would try to run "Manager".
read_env() {
    python3 -c '
import sys
key = sys.argv[2]
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    if k.strip() == key:
        print(v.strip().strip("\"").strip("\x27"))
        break
' "$ROOT/.env" "$1"
}
SURREAL_URL="$(read_env SURREAL_URL)"
SURREAL_NS="$(read_env SURREAL_NS)"
SURREAL_DB="$(read_env SURREAL_DB)"
SURREAL_USER="$(read_env SURREAL_USER)"
SURREAL_PASS="$(read_env SURREAL_PASS)"
: "${SURREAL_URL:?missing in .env}" "${SURREAL_NS:?missing in .env}" \
  "${SURREAL_DB:?missing in .env}" "${SURREAL_USER:?missing in .env}" \
  "${SURREAL_PASS:?missing in .env}"

PORT="${SURREAL_URL##*:}"
[ -n "$PORT" ] || die "could not read a port out of SURREAL_URL"

sql_old() {
    curl -fsS -u "$SURREAL_USER:$SURREAL_PASS" -H "Accept: application/json" \
        -H "surreal-ns: $SURREAL_NS" -H "surreal-db: $SURREAL_DB" \
        -X POST "$SURREAL_URL/sql" --data-binary "$1"
}
count_rows() {
    curl -fsS -u "$SURREAL_USER:$SURREAL_PASS" -H "Accept: application/json" \
        -H "surreal-ns: $SURREAL_NS" -H "surreal-db: $SURREAL_DB" \
        -X POST "$SURREAL_URL/sql" --data-binary "SELECT count() FROM $1 GROUP ALL;" \
    | python3 -c "import json,sys; r=json.load(sys.stdin)[-1].get('result') or []; print(r[0]['count'] if r else 0)"
}

TABLES=(users tasks workspaces workspace_members workspace_invites sessions activity_events schema_migrations)

say "Recording counts before the move"
mkdir -p "$BACKUP_DIR"
BEFORE="$BACKUP_DIR/counts-before-$STAMP.txt"
for t in "${TABLES[@]}"; do printf '%s %s\n' "$t" "$(count_rows "$t")" | tee -a "$BEFORE"; done

say "Exporting from $(curl -fsS "$SURREAL_URL/version")"
DUMP="$BACKUP_DIR/surreal-pre-v3-$STAMP.surql"
curl -fsS -u "$SURREAL_USER:$SURREAL_PASS" -H "surreal-ns: $SURREAL_NS" -H "surreal-db: $SURREAL_DB" \
    "$SURREAL_URL/export" -o "$DUMP"
chmod 600 "$DUMP"
[ -s "$DUMP" ] || die "export is empty"
echo "wrote $DUMP ($(wc -c < "$DUMP") bytes)"

say "Rewriting UPDATE … CONTENT to UPSERT … CONTENT"
DUMP_V3="$BACKUP_DIR/surreal-for-v3-$STAMP.surql"
sed -E 's/^UPDATE ([A-Za-z_]+:[A-Za-z0-9_]+) CONTENT /UPSERT \1 CONTENT /' "$DUMP" > "$DUMP_V3"
chmod 600 "$DUMP_V3"
echo "rewrote $(grep -c '^UPSERT ' "$DUMP_V3") statements"
[ "$(grep -c '^UPDATE .* CONTENT ' "$DUMP_V3" || true)" = "0" ] || die "some UPDATE … CONTENT statements were not rewritten"

if [ "$DRY_RUN" = "1" ]; then
    say "Dry run: stopping before anything is changed"
    exit 0
fi

say "Stopping the application"
sudo systemctl stop taskmanager

say "Stopping the old database (kept for rollback)"
sudo docker stop "$OLD_CONTAINER" >/dev/null

# `--auth` was removed in SurrealDB 3: authentication is always on, and passing
# the flag makes the server refuse to start.
say "Starting $NEW_IMAGE on port $PORT"
sudo mkdir -p "$NEW_DATA_DIR"
sudo docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
sudo docker run -d --name "$NEW_CONTAINER" --restart unless-stopped --user root \
    -v "$NEW_DATA_DIR:/data" -p "127.0.0.1:$PORT:8000" "$NEW_IMAGE" \
    start --log info --user "$SURREAL_USER" --pass "$SURREAL_PASS" \
    "rocksdb:/data/database.db" >/dev/null

for _ in $(seq 1 30); do
    curl -fsS "$SURREAL_URL/version" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "$SURREAL_URL/version" >/dev/null || die "the new database did not come up"
echo "now running $(curl -fsS "$SURREAL_URL/version")"

say "Creating the namespace and database"
sql_old "DEFINE NAMESPACE IF NOT EXISTS $SURREAL_NS; USE NS $SURREAL_NS; DEFINE DATABASE IF NOT EXISTS $SURREAL_DB;" >/dev/null

say "Importing"
curl -fsS -u "$SURREAL_USER:$SURREAL_PASS" -H "surreal-ns: $SURREAL_NS" -H "surreal-db: $SURREAL_DB" \
    -H "Accept: application/json" -X POST "$SURREAL_URL/import" --data-binary "@$DUMP_V3" \
    > "$BACKUP_DIR/import-result-$STAMP.json"
python3 - "$BACKUP_DIR/import-result-$STAMP.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
bad = [r for r in rows if r.get("status") != "OK"]
print(f"{len(rows)} statements, {len(bad)} errors")
for b in bad[:10]:
    print("  ", str(b.get("result"))[:200])
sys.exit(1 if bad else 0)
PY

say "Comparing row counts"
FAILED=0
while read -r table expected; do
    actual="$(count_rows "$table")"
    if [ "$actual" = "$expected" ]; then
        printf '  %-20s %s\n' "$table" "$actual"
    else
        printf '  \033[0;31m%-20s expected %s, got %s\033[0m\n' "$table" "$expected" "$actual"
        FAILED=1
    fi
done < "$BEFORE"
[ "$FAILED" = "0" ] || die "row counts do not match; the old container is still intact — see the rollback note below"

# The binary and the database have to change together: the 3.x build speaks a
# dialect 1.x rejects, and vice versa. Building here, after the data is verified
# and before the service comes back, keeps the window where they disagree as
# short as the restart itself.
say "Building the application against the migrated schema"
if command -v zig >/dev/null 2>&1; then
    zig build -Doptimize=ReleaseSafe
elif [ -x "$HOME/.local/zig/zig" ]; then
    "$HOME/.local/zig/zig" build -Doptimize=ReleaseSafe
else
    die "zig is not on PATH and ~/.local/zig/zig does not exist"
fi
./scripts/stamp-assets.sh

say "Starting the application"
sudo systemctl start taskmanager
sleep 5
systemctl is-active --quiet taskmanager || die "the application did not start"
curl -fsS "http://127.0.0.1:${PORT_APP:-9000}/api/health" >/dev/null 2>&1 || true

cat <<NOTE

Done. The old database is stopped but intact.

  Roll back:  sudo systemctl stop taskmanager
              sudo docker stop $NEW_CONTAINER
              sudo docker start $OLD_CONTAINER
              git revert <the migration commit> && zig build
              sudo systemctl start taskmanager

  Remove the old container once you are satisfied:
              sudo docker rm $OLD_CONTAINER
              sudo rm -rf /var/lib/surrealdb-taskmanager

NOTE
