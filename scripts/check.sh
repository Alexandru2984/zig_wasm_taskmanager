#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Checking formatting"
zig fmt --check build.zig src frontend/src

echo "==> Building"
zig build

echo "==> Running unit tests"
zig build test

if [[ "${RUN_SMOKE:-0}" == "1" ]]; then
  echo "==> Running smoke tests"
  ./scripts/smoke_test.sh "${BASE_URL:-http://127.0.0.1:9000}"
else
  echo "==> Skipping smoke tests (set RUN_SMOKE=1 to enable)"
fi
