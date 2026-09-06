#!/bin/bash
# Smoke Test Script for Zig Task Manager
# Run after any changes to verify basic functionality
# Usage: ./scripts/smoke_test.sh [BASE_URL]

set -u

BASE_URL="${1:-http://127.0.0.1:9000}"
PASS=0
FAIL=0

extra_curl_opts=()
if [ -n "${CURL_RESOLVE:-}" ]; then
    extra_curl_opts+=( --resolve "$CURL_RESOLVE" )
fi

# Cookie jar: session auth survives between requests WITHOUT leaking tokens
# via `ps aux` (the previous script embedded the Bearer token directly in
# every curl argv).
COOKIE_JAR="$(mktemp --tmpdir smoke-cookies.XXXXXX)"
RESPONSE_FILE="$(mktemp --tmpdir smoke-response.XXXXXX)"
trap 'rm -f "$COOKIE_JAR" "$RESPONSE_FILE"' EXIT

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=================================="
echo "  🦎 Zig Task Manager Smoke Test"
echo "=================================="
echo "Base URL: $BASE_URL"
echo ""

curl_opts=( "${extra_curl_opts[@]}" -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" )

# The CSRF cookie is `__Host-csrf_token` over HTTPS. The prefix is a
# browser-enforced guarantee that no other host on the parent domain could have
# set it, and it requires Secure — so a plain-HTTP local run still uses the bare
# name. Accept either.
# Prefer the prefixed cookie explicitly rather than taking whichever line comes
# last: logout expires both spellings, so the jar can still hold a stale bare
# `csrf_token` after a fresh login has set `__Host-csrf_token`.
csrf_token() {
    awk '
        $6 == "__Host-csrf_token" { host_token = $7 }
        $6 == "csrf_token"        { plain_token = $7 }
        END { print (host_token != "" ? host_token : plain_token) }
    ' "$COOKIE_JAR" 2>/dev/null
}

# Helper function
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="${4:-}"
    local expected="$5"

    echo -n "Testing $name... "

    if [ "$method" = "GET" ]; then
        response=$(curl "${curl_opts[@]}" "$BASE_URL$endpoint" 2>&1)
    else
        local csrf
        csrf="$(csrf_token)"
        local csrf_args=()
        if [ -n "$csrf" ]; then
            csrf_args=( -H "X-CSRF-Token: $csrf" )
        fi

        if [ -n "$data" ]; then
            response=$(curl "${curl_opts[@]}" -X "$method" "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                "${csrf_args[@]}" \
                -d "$data" 2>&1)
        else
            response=$(curl "${curl_opts[@]}" -X "$method" "$BASE_URL$endpoint" \
                "${csrf_args[@]}" 2>&1)
        fi
    fi

    if echo "$response" | grep -q "$expected" 2>/dev/null; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASS=$((PASS + 1))
        echo "$response" > "$RESPONSE_FILE"
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "  Expected: $expected"
        echo "  Got: ${response:0:100}..."
        FAIL=$((FAIL + 1))
        return 1
    fi
}

# Helper to check header
test_header() {
    local name="$1"
    local endpoint="$2"
    local header="$3"
    local expected="$4"

    echo -n "Testing $name... "

    response=$(curl "${extra_curl_opts[@]}" -sI "$BASE_URL$endpoint" 2>&1)

    if echo "$response" | grep -qi "$header.*$expected" 2>/dev/null; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASS=$((PASS + 1))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "  Expected header: $header: $expected"
        FAIL=$((FAIL + 1))
        return 1
    fi
}

echo "=== Core Endpoints ==="
test_endpoint "Health Check" "GET" "/api/health" "" "healthy" || true
test_endpoint "Ready Check" "GET" "/api/ready" "" "ready" || true

# Metrics endpoint is now gated behind METRICS_TOKEN — expect 401 without one.
echo -n "Testing Metrics (gated)... "
metrics=$(curl "${extra_curl_opts[@]}" -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/metrics")
if [ "$metrics" = "401" ] || [ "$metrics" = "404" ]; then
    echo -e "${GREEN}✓ PASS${NC} (got $metrics)"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC} (got $metrics, expected 401 or 404)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Static Files ==="
test_endpoint "Index HTML" "GET" "/" "" "DOCTYPE" || true
test_header "Cache-Control (HTML)" "/" "Cache-Control" "no-cache" || true
# Asserting the origin's Cache-Control here would be meaningless: Cloudflare
# rewrites what the browser is told (no-cache becomes max-age=14400), so the
# value seen through the edge is the edge's, not ours.
#
# What actually keeps a returning visitor off a stale bundle is the content
# hash in the asset URL, and that is true at the origin and at the edge alike.
echo -n "Testing assets are cache-busted... "
if curl -s "$BASE_URL/" | grep -qE 'src="/app\.js\?v=[0-9a-f]+"'; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC} (no ?v= stamp on /app.js — run scripts/stamp-assets.sh)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Security Headers ==="
test_header "X-Content-Type-Options" "/" "X-Content-Type-Options" "nosniff" || true
test_header "X-Frame-Options" "/" "X-Frame-Options" "DENY" || true
test_header "Permissions-Policy" "/" "Permissions-Policy" "camera" || true
test_header "CSP no unsafe-inline" "/" "Content-Security-Policy" "script-src 'self'" || true

echo ""
echo "=== Auth Flow ==="
RANDOM_ID=$((RANDOM % 10000))
EMAIL="test${RANDOM_ID}@example.com"
# Generated per run rather than written here. A literal test password is
# indistinguishable from a leaked credential to a secret scanner, and a fresh
# one per run also cannot drift into the common-password blocklist.
PASSWORD="Aa1$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
WRONG_PASSWORD="Zz9$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

echo "Using email: $EMAIL"

# 1. Signup — cookie jar now holds the session cookie.
test_endpoint "Signup" "POST" "/api/auth/signup" \
    "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Test User\"}" "$EMAIL" || true

# 2. Me (Profile) — uses cookie from the jar, no Authorization header.
test_endpoint "Get Profile" "GET" "/api/auth/me" "" "$EMAIL" || true

# 3. Logout clears the cookie.
test_endpoint "Logout (1)" "POST" "/api/auth/logout" "" "logged out" || true

# 4. Login again.
test_endpoint "Login" "POST" "/api/auth/login" \
    "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$EMAIL" || true

echo ""
echo "=== Workspace Operations ==="
test_endpoint "List Workspaces" "GET" "/api/workspaces" "" "Workspace" || true
test_endpoint "Create Workspace Requires Verified Email" "POST" "/api/workspaces" \
    "{\"name\":\"Smoke Workspace\"}" "Email verification required" || true
WORKSPACE_ID=$(grep -o '"id":"[^"]*"' "$RESPONSE_FILE" | cut -d'"' -f4)
if [ -n "$WORKSPACE_ID" ]; then
    echo "Created Workspace ID: $WORKSPACE_ID"
    test_endpoint "List Workspace Members" "GET" "/api/workspaces/$WORKSPACE_ID/members" "" "$EMAIL" || true
    INVITE_EMAIL="invite${RANDOM_ID}@example.com"
    test_endpoint "Create Workspace Invite" "POST" "/api/workspaces/$WORKSPACE_ID/invites" \
        "{\"email\":\"$INVITE_EMAIL\",\"role\":\"viewer\"}" "$INVITE_EMAIL" || true
fi

# 5. Tasks
echo ""
echo "=== Task Operations ==="
test_endpoint "Get Tasks (Empty)" "GET" "/api/tasks" "" "\[\]" || true

echo -n "Testing CSRF required for task writes... "
csrf_status=$(curl "${curl_opts[@]}" -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"Missing CSRF\"}")
if [ "$csrf_status" = "403" ]; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC} (got $csrf_status, expected 403)"
    FAIL=$((FAIL + 1))
fi

TASK_PAYLOAD="{\"title\":\"Smoke Test Task\",\"priority\":\"high\"}"
if [ -n "${WORKSPACE_ID:-}" ]; then
    TASK_PAYLOAD="{\"title\":\"Smoke Test Task\",\"priority\":\"high\",\"workspace_id\":\"$WORKSPACE_ID\"}"
fi
test_endpoint "Create Task" "POST" "/api/tasks" "$TASK_PAYLOAD" "Smoke Test Task" || true
TASK_ID=$(grep -o '"id":"[^"]*"' "$RESPONSE_FILE" | cut -d'"' -f4)

if [ -n "$TASK_ID" ]; then
    echo "Created Task ID: $TASK_ID"

    test_endpoint "Task Priority" "GET" "/api/tasks" "" '"priority":"high"' || true
    test_endpoint "Get Tasks (List)" "GET" "/api/tasks" "" "$TASK_ID" || true

    test_endpoint "Update Task (title, notes, tags)" "PUT" "/api/tasks/$TASK_ID" \
        '{"title":"Renamed Smoke Task","notes":"a note","tags":["smoke","test"]}' \
        "Renamed Smoke Task" || true
    test_endpoint "Update Task keeps untouched fields" "GET" "/api/tasks" "" '"priority":"high"' || true
    test_endpoint "Reject a due date in the past" "PUT" "/api/tasks/$TASK_ID" \
        '{"due_date":"2020-01-01T09:00"}' "future" || true
    test_endpoint "Reject too many tags" "PUT" "/api/tasks/$TASK_ID" \
        '{"tags":["1","2","3","4","5","6","7","8","9","10","11","12","13"]}' "at most 12" || true

    # A conforming client percent-encodes the colon in a record id. The router
    # slices ids out of the raw path, so this only works if the server decodes.
    ENCODED_TASK_ID="${TASK_ID/:/%3A}"
    test_endpoint "Percent-encoded task id" "PUT" "/api/tasks/$ENCODED_TASK_ID" \
        '{"title":"Encoded Id Works"}' "Encoded Id Works" || true

    test_endpoint "Toggle Task (empty body)" "PUT" "/api/tasks/$TASK_ID" "" "true" || true
    test_endpoint "Delete Task" "DELETE" "/api/tasks/$TASK_ID" "" "success" || true
    test_endpoint "Activity Log" "GET" "/api/activity" "" "create_task" || true
fi

# 6. Account, sessions and data
echo ""
echo "=== Account & Data ==="
test_endpoint "List Sessions" "GET" "/api/sessions" "" '"current":true' || true
test_endpoint "Export Data" "GET" "/api/export" "" '"exported_at"' || true
test_endpoint "Delete Account Rejects Wrong Password" "DELETE" "/api/account" \
    "{\"password\":\"$WRONG_PASSWORD\"}" "Incorrect password" || true

echo -n "Testing unauthenticated task read returns 401... "
unauth_status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/tasks")
if [ "$unauth_status" = "401" ]; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC} (got $unauth_status, expected 401)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Method Enforcement ==="
# Signup must reject GET.
echo -n "Testing Signup rejects GET... "
status=$(curl "${extra_curl_opts[@]}" -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/auth/signup")
if [ "$status" = "405" ]; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC} (got $status, expected 405)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Logout ==="
test_endpoint "Logout (2)" "POST" "/api/auth/logout" "" "logged out" || true
# After logout, /me must no longer authenticate.
echo -n "Testing Session Invalidated After Logout... "
resp=$(curl "${curl_opts[@]}" "$BASE_URL/api/auth/me" 2>&1)
if echo "$resp" | grep -q "Not authenticated"; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Got: ${resp:0:100}..."
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Path Security ==="
response=$(curl "${extra_curl_opts[@]}" -s "$BASE_URL/../../etc/passwd" 2>&1)
if echo "$response" | grep -q "403\|404\|Forbidden\|Not Found" 2>/dev/null; then
    echo -e "Testing Path Traversal Block... ${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "Testing Path Traversal Block... ${RED}✗ FAIL${NC}"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=================================="
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo "=================================="

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed!${NC}"
    exit 1
fi
