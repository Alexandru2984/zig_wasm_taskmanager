#!/bin/bash
# Smoke Test Script for Zig Task Manager
# Run after any changes to verify basic functionality
# Usage: ./scripts/smoke_test.sh [BASE_URL]

set -u

BASE_URL="${1:-http://127.0.0.1:9000}"
PASS=0
FAIL=0

# Cookie jar: session auth survives between requests WITHOUT leaking tokens
# via `ps aux` (the previous script embedded the Bearer token directly in
# every curl argv).
COOKIE_JAR="$(mktemp --tmpdir smoke-cookies.XXXXXX)"
trap 'rm -f "$COOKIE_JAR" /tmp/last_response.json' EXIT

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=================================="
echo "  🦎 Zig Task Manager Smoke Test"
echo "=================================="
echo "Base URL: $BASE_URL"
echo ""

curl_opts=( -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" )

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
        if [ -n "$data" ]; then
            response=$(curl "${curl_opts[@]}" -X "$method" "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                -d "$data" 2>&1)
        else
            response=$(curl "${curl_opts[@]}" -X "$method" "$BASE_URL$endpoint" 2>&1)
        fi
    fi

    if echo "$response" | grep -q "$expected" 2>/dev/null; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASS=$((PASS + 1))
        echo "$response" > /tmp/last_response.json
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

    response=$(curl -sI "$BASE_URL$endpoint" 2>&1)

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
metrics=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/metrics")
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
test_header "Cache-Control (JS)" "/app.js" "Cache-Control" "max-age=3600" || true

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
PASSWORD="Password123!"

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

# 5. Tasks
echo ""
echo "=== Task Operations ==="
test_endpoint "Get Tasks (Empty)" "GET" "/api/tasks" "" "\[\]" || true

test_endpoint "Create Task" "POST" "/api/tasks" \
    "{\"title\":\"Smoke Test Task\"}" "Smoke Test Task" || true
TASK_ID=$(cat /tmp/last_response.json | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -n "$TASK_ID" ]; then
    echo "Created Task ID: $TASK_ID"

    test_endpoint "Get Tasks (List)" "GET" "/api/tasks" "" "$TASK_ID" || true
    test_endpoint "Toggle Task" "PUT" "/api/tasks/$TASK_ID" "" "true" || true
    test_endpoint "Delete Task" "DELETE" "/api/tasks/$TASK_ID" "" "success" || true
fi

echo ""
echo "=== Method Enforcement ==="
# Signup must reject GET.
echo -n "Testing Signup rejects GET... "
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/auth/signup")
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
response=$(curl -s "$BASE_URL/../../etc/passwd" 2>&1)
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
