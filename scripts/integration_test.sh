#!/usr/bin/env bash
#
# End-to-end test against a real SurrealDB: start a throwaway database, build
# and run the application against it, exercise the API with the smoke suite,
# then tear everything down.
#
# Lives in a script rather than in workflow YAML so it can be run locally,
# which is the only way the sequencing gets debugged without pushing commits.
#
# Ports default away from the production pair (9000/8010) so this is safe to
# run on the deployment host.
#
#   scripts/integration_test.sh
#   APP_PORT=9300 DB_PORT=8030 scripts/integration_test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_PORT="${APP_PORT:-9200}"
DB_PORT="${DB_PORT:-8020}"
DB_IMAGE="${DB_IMAGE:-surrealdb/surrealdb:v3.2.4}"
CONTAINER="taskmanager-it-$$"
WORKDIR="$(mktemp -d)"
APP_PID=""

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Kill whatever is listening on a port. The application is started in a
# subshell so `$!` is the subshell, not the binary, and killing the subshell
# leaves the server running and holding the port — which then makes the next
# run fail with ListenError and serve a stale build.
kill_port() {
    local port="$1" pids
    pids="$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' \
            | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
}

cleanup() {
    local status=$?
    say "Cleaning up"
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
    kill_port "$APP_PORT"
    if [ "$status" != "0" ] && [ -f "$WORKDIR/app.log" ]; then
        echo "--- application log ---"
        tail -40 "$WORKDIR/app.log"
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT

say "Starting $DB_IMAGE on port $DB_PORT"
# --user root: the 3.x image's default user cannot create the RocksDB directory
# in a fresh volume. In-memory would be faster, but the point of this test is to
# exercise the same storage engine production uses.
docker run -d --name "$CONTAINER" --user root \
    -p "127.0.0.1:$DB_PORT:8000" "$DB_IMAGE" \
    start --log warn --user itroot --pass itpass rocksdb:/data/it.db >/dev/null

for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$DB_PORT/version" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "http://127.0.0.1:$DB_PORT/version" || { echo "database did not start"; exit 1; }
echo

say "Building"
if command -v zig >/dev/null 2>&1; then ZIG=zig; else ZIG="$HOME/.local/zig/zig"; fi
"$ZIG" build

say "Starting the application on port $APP_PORT"
# A dedicated working directory: the binary reads ./.env and serves ./public,
# and the real .env must not be picked up.
ln -s "$ROOT/public" "$WORKDIR/public"
cat > "$WORKDIR/.env" <<ENV
SURREAL_URL=http://127.0.0.1:$DB_PORT
SURREAL_NS=taskmanager_it
SURREAL_DB=main
SURREAL_USER=itroot
SURREAL_PASS=itpass
PORT=$APP_PORT
INTERFACE=127.0.0.1
CORS_ORIGIN=http://localhost:$APP_PORT
APP_BASE_URL=http://127.0.0.1:$APP_PORT
COOKIE_INSECURE=1
LOG_LEVEL=info
ENV

FACIL_DIR="$(dirname "$(find "$ROOT/.zig-cache" -name 'libfacil.io.so' | head -1)")"

# Refuse to start on a port something else already owns, rather than failing
# with ListenError and then testing whatever was already there.
if ss -tln 2>/dev/null | grep -q ":$APP_PORT "; then
    echo "port $APP_PORT is already in use"
    exit 1
fi
( cd "$WORKDIR" && LD_LIBRARY_PATH="$FACIL_DIR" "$ROOT/zig-out/bin/taskmanager" > "$WORKDIR/app.log" 2>&1 ) &
APP_PID=$!

for _ in $(seq 1 45); do
    curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null || { echo "application did not start"; exit 1; }

# A clean boot must not have retried the schema. Catching this here is the
# point: a schema statement the database version rejects still leaves a
# serving process, so health alone would call a broken deploy healthy.
if grep -q "DB not ready" "$WORKDIR/app.log"; then
    echo "schema initialisation retried — the schema is not valid for $DB_IMAGE"
    grep -m5 "SurrealDB query error" "$WORKDIR/app.log" || true
    exit 1
fi
echo "application is up and the schema initialised cleanly"

say "Readiness"
curl -fsS "http://127.0.0.1:$APP_PORT/api/ready" | tee /dev/stderr | grep -q '"status":"ready"'
echo

say "Smoke suite"
RUN_SMOKE=1 ./scripts/smoke_test.sh "http://127.0.0.1:$APP_PORT"
