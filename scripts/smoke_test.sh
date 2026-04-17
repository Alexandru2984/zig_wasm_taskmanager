#!/bin/bash
# Smoke Test Script for Zig Task Manager
# Run after any changes to verify basic functionality
# Usage: ./scripts/smoke_test.sh [BASE_URL]

BASE_URL="${1:-http://127.0.0.1:9000}"
PASS=0
FAIL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=================================="
echo "  🦎 Zig Task Manager Smoke Test"
echo "=================================="
echo "Base URL: $BASE_URL"
echo ""

# Helper function
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected="$5"
    local token="$6"
    
    echo -n "Testing $name... "
    
    local auth_header=""
    if [ ! -z "$token" ]; then
        auth_header="-H \"Authorization: Bearer $token\""
    fi
    
    if [ "$method" = "GET" ]; then
        if [ ! -z "$token" ]; then
            response=$(curl -s -H "Authorization: Bearer $token" "$BASE_URL$endpoint" 2>&1)
        else
            response=$(curl -s "$BASE_URL$endpoint" 2>&1)
        fi
    else
        if [ ! -z "$token" ]; then
            response=$(curl -s -X "$method" "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $token" \
                -d "$data" 2>&1)
        else
            response=$(curl -s -X "$method" "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                -d "$data" 2>&1)
        fi
    fi
    
    if echo "$response" | grep -q "$expected" 2>/dev/null; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASS=$((PASS + 1))
        # Return response for extraction if needed
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
test_endpoint "Metrics" "GET" "/api/metrics" "" "app_uptime_seconds" || true

echo ""
echo "=== Static Files ==="
test_endpoint "Index HTML" "GET" "/" "" "DOCTYPE" || true
test_header "Cache-Control (HTML)" "/" "Cache-Control" "no-cache" || true
test_header "Cache-Control (JS)" "/app.js" "Cache-Control" "max-age=3600" || true

echo ""
echo "=== Security Headers ==="
test_header "X-Content-Type-Options" "/" "X-Content-Type-Options" "nosniff" || true
test_header "X-Frame-Options" "/" "X-Frame-Options" "SAMEORIGIN" || true

echo ""
echo "=== Auth Flow ==="
# Generate random email
RANDOM_ID=$((RANDOM % 10000))
EMAIL="test${RANDOM_ID}@example.com"
PASSWORD="Password123!"

echo "Using email: $EMAIL"

# 1. Signup
test_endpoint "Signup" "POST" "/api/auth/signup" \
    "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Test User\"}" "token"
TOKEN=$(cat /tmp/last_response.json | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo -e "${RED}Failed to get token from signup${NC}"
else
    echo -e "${GREEN}Got token: ${TOKEN:0:10}...${NC}"
fi

# 2. Me (Profile)
test_endpoint "Get Profile" "GET" "/api/auth/me" "" "$EMAIL" "$TOKEN" || true

# 3. Login
test_endpoint "Login" "POST" "/api/auth/login" \
    "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "token" || true
NEW_TOKEN=$(cat /tmp/last_response.json | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# 4. Tasks
echo ""
echo "=== Task Operations ==="
test_endpoint "Get Tasks (Empty)" "GET" "/api/tasks" "" "\[\]" "$NEW_TOKEN" || true

test_endpoint "Create Task" "POST" "/api/tasks" \
    "{\"title\":\"Smoke Test Task\"}" "Smoke Test Task" "$NEW_TOKEN" || true
TASK_ID=$(cat /tmp/last_response.json | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ ! -z "$TASK_ID" ]; then
    echo "Created Task ID: $TASK_ID"
    
    test_endpoint "Get Tasks (List)" "GET" "/api/tasks" "" "$TASK_ID" "$NEW_TOKEN" || true
    
    test_endpoint "Toggle Task" "PUT" "/api/tasks/$TASK_ID" "" "true" "$NEW_TOKEN" || true
    
    test_endpoint "Delete Task" "DELETE" "/api/tasks/$TASK_ID" "" "success" "$NEW_TOKEN" || true
fi

echo ""
echo "=== Path Security ==="
# Test path traversal protection
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
