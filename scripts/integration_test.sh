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
CONTAINER_STARTED=0
MAIL_TEST_KEY="$(openssl rand -hex 32)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

cleanup() {
    local status=$?
    say "Cleaning up"
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
    [ -n "$APP_PID" ] && wait "$APP_PID" 2>/dev/null || true
    if [ "$status" != "0" ] && [ -f "$WORKDIR/app.log" ]; then
        echo "--- application log ---"
        tail -40 "$WORKDIR/app.log"
    fi
    if [ "$CONTAINER_STARTED" = 1 ]; then docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true; fi
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT

# Never signal another service by port, including when a caller chooses the
# production port accidentally. Validate before starting any test resource.
for port in "$APP_PORT" "$DB_PORT"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
        echo "invalid test port: $port"; exit 1
    fi
    if ss -H -ltn "sport = :$port" | rg -q .; then
        echo "port $port is already in use; existing process left untouched"; exit 1
    fi
done
if [ "$APP_PORT" = "$DB_PORT" ]; then echo "test ports must differ"; exit 1; fi

say "Starting $DB_IMAGE on port $DB_PORT"
# --user root: the 3.x image's default user cannot create the RocksDB directory
# in a fresh volume. In-memory would be faster, but the point of this test is to
# exercise the same storage engine production uses.
docker run -d --name "$CONTAINER" --user root \
    -p "127.0.0.1:$DB_PORT:8000" "$DB_IMAGE" \
    start --log warn --user itroot --pass itpass rocksdb:/data/it.db >/dev/null
CONTAINER_STARTED=1

for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$DB_PORT/version" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "http://127.0.0.1:$DB_PORT/version" || { echo "database did not start"; exit 1; }
echo

say "Building"
if command -v zig >/dev/null 2>&1; then ZIG=zig; else ZIG="$HOME/.local/zig/zig"; fi
# Build artifacts and static files stay outside the checkout nginx serves.
cp -a "$ROOT/public" "$WORKDIR/public"
cp "$ROOT/scripts/fixtures/startup.env" "$WORKDIR/.env"
"$ZIG" build -j4 -Doptimize="${OPTIMIZE:-Debug}" --prefix "$WORKDIR/build"

say "Starting the application on port $APP_PORT"
# A dedicated working directory: the binary reads ./.env and serves ./public,
# and the real .env must not be picked up.
FACIL_LIBRARY="$(ldd "$WORKDIR/build/bin/taskmanager" | awk '/libfacil.io.so =>/ {print $3}')"
test -f "$FACIL_LIBRARY"
FACIL_DIR="$(dirname "$(realpath "$FACIL_LIBRARY")")"

# Exercise the same separation as production: root applies migrations once;
# the serving process has only a database-scoped EDITOR credential.
( cd "$WORKDIR" && env -i PATH="$PATH" LD_LIBRARY_PATH="$FACIL_DIR" \
    SURREAL_URL="http://127.0.0.1:$DB_PORT" SURREAL_NS=taskmanager_it SURREAL_DB=main \
    SURREAL_USER=itroot SURREAL_PASS=itpass DB_MIGRATE_ONLY=1 \
    "$WORKDIR/build/bin/taskmanager" > "$WORKDIR/app.log" 2>&1 )
curl -fsS -u itroot:itpass -H 'surreal-ns: taskmanager_it' -H 'surreal-db: main' \
    -H 'Accept: application/json' --data-binary \
    'DEFINE USER itapp ON DATABASE PASSWORD "integration-only-app" ROLES EDITOR;' \
    "http://127.0.0.1:$DB_PORT/sql" | node -e '
        let s=""; process.stdin.on("data", x => s+=x); process.stdin.on("end", () => {
            if (JSON.parse(s).some(r => r.status !== "OK")) process.exit(1);
        });'

# Refuse to start on a port something else already owns, rather than failing
# with ListenError and then testing whatever was already there.
if ss -H -ltn "sport = :$APP_PORT" | rg -q .; then
    echo "port $APP_PORT is already in use"
    exit 1
fi
( cd "$WORKDIR" && exec env -i PATH="$PATH" \
    LD_LIBRARY_PATH="$FACIL_DIR" SURREAL_URL="http://127.0.0.1:$DB_PORT" \
    SURREAL_NS=taskmanager_it SURREAL_DB=main SURREAL_USER=itapp SURREAL_PASS=integration-only-app \
    SURREAL_AUTH_LEVEL=database DB_AUTO_MIGRATE=0 \
    MAIL_OUTBOX_KEY="$MAIL_TEST_KEY" MAIL_WORKER_ENABLED="${MAIL_WORKER_ENABLED:-0}" \
    METRICS_TOKEN=integration-only-metrics \
    PORT="$APP_PORT" CORS_ORIGIN="http://127.0.0.1:$APP_PORT" \
    APP_BASE_URL="http://127.0.0.1:$APP_PORT" COOKIE_INSECURE=1 LOG_LEVEL=info \
    SERVER_THREADS=4 "$WORKDIR/build/bin/taskmanager" > "$WORKDIR/app.log" 2>&1 ) &
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

if [ "${RUN_SECURITY:-0}" = 1 ]; then
    say "Security regressions"
    BASE_URL="http://127.0.0.1:$APP_PORT" TEST_DB_URL="http://127.0.0.1:$DB_PORT" \
        node scripts/security_test.mjs
fi
if [ "${RUN_TRASH:-0}" = 1 ]; then
    say "Task trash regressions"
    BASE_URL="http://127.0.0.1:$APP_PORT" TEST_DB_URL="http://127.0.0.1:$DB_PORT" \
        node scripts/trash_test.mjs
fi
if [ "${RUN_PAGINATION:-0}" = 1 ]; then
    say "Task pagination and capacity measurements"
    BASE_URL="http://127.0.0.1:$APP_PORT" TEST_DB_URL="http://127.0.0.1:$DB_PORT" \
        node scripts/pagination_test.mjs
fi
if [ "${RUN_UI:-0}" = 1 ]; then
    say "Browser suite"
    BASE_URL="http://127.0.0.1:$APP_PORT" node scripts/ui_test.mjs
fi
if [ "${RUN_OUTBOX:-0}" = 1 ]; then
    say "Durable email regressions (local TLS SMTP fixture only)"
    BASE_URL="http://127.0.0.1:$APP_PORT" TEST_DB_URL="http://127.0.0.1:$DB_PORT" \
        TEST_WORKDIR="$WORKDIR" TEST_APP_BINARY="$WORKDIR/build/bin/taskmanager" \
        TEST_LIBRARY_DIR="$FACIL_DIR" TEST_MAIL_KEY="$MAIL_TEST_KEY" node scripts/outbox_test.mjs
fi
