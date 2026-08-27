#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# validate.sh — Validate perf-metrics plugin source files
#
# This plugin lives directly inside this repo (no separate "deploy" copy
# step into ~/.pi-web/plugins/perf-metrics anymore — that concept went away
# once the plugin's source moved in-repo). The backend proxy is likewise no
# longer started by this script; it will run as a docker-compose service
# (separate piece of work). This script is a read-only check:
#   1. Verifies the plugin source files (in this script's own directory)
#      exist, are non-empty, and are syntactically valid.
#   2. If a backend proxy happens to already be listening on port 3457, it
#      exercises the health endpoint, Prometheus query proxy, and CORS
#      headers. If nothing is listening, those checks are reported as
#      skipped/informational rather than failures — this script never
#      starts a backend process itself.
#   3. Writes a summary to validation-results.md.
#
# Usage:
#   ./validate.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"
BACKEND_PORT=3457
PROMETHEUS_URL="${PI_PERF_PROMETHEUS_URL:-http://172.18.0.1:9090}"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Results collection
RESULTS=()
ERRORS=()
SKIPPED=()
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() {
  RESULTS+=("✅ PASS: $1")
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  RESULTS+=("❌ FAIL: $1")
  FAIL_COUNT=$((FAIL_COUNT + 1))
  ERRORS+=("$1")
}

skip() {
  RESULTS+=("⏭️  SKIP: $1")
  SKIP_COUNT=$((SKIP_COUNT + 1))
  SKIPPED+=("$1")
}

info() {
  echo -e "${YELLOW}[INFO]${NC} $1"
}

# =============================================================================
# Step 1: Plugin source file checks
# =============================================================================
echo "========================================="
echo "  Step 1: Checking plugin source files"
echo "========================================="

for f in package.json pi-web-plugin.js perf-metrics-panel.js uPlot.iife.min.js uPlot.min.css assets/icon.svg; do
  if [[ -f "$PLUGIN_DIR/$f" ]]; then
    ACTUAL_SIZE=$(wc -c < "$PLUGIN_DIR/$f" | tr -d ' ')
    if [[ $ACTUAL_SIZE -gt 0 ]]; then
      pass "File exists and non-empty: $f ($ACTUAL_SIZE bytes)"
    else
      fail "File exists but is empty: $f"
    fi
  else
    fail "File missing: $f"
  fi
done

# =============================================================================
# Step 2: Plugin file validity
# =============================================================================
echo ""
echo "========================================="
echo "  Step 2: Validating plugin file syntax"
echo "========================================="

echo -n "  package.json validity... "
if node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/package.json','utf8'))" 2>/dev/null; then
  pass "package.json is valid JSON"
else
  fail "package.json is not valid JSON"
fi

echo -n "  pi-web-plugin.js syntax... "
if node -c "$PLUGIN_DIR/pi-web-plugin.js" 2>/dev/null; then
  pass "pi-web-plugin.js syntax valid"
else
  fail "pi-web-plugin.js has syntax errors"
fi

echo -n "  perf-metrics-panel.js syntax... "
if node -c "$PLUGIN_DIR/perf-metrics-panel.js" 2>/dev/null; then
  pass "perf-metrics-panel.js syntax valid"
else
  fail "perf-metrics-panel.js has syntax errors"
fi

# =============================================================================
# Step 3: Backend proxy checks (read-only, best-effort)
# =============================================================================
echo ""
echo "========================================="
echo "  Step 3: Backend proxy checks (read-only)"
echo "========================================="

HEALTH_RESP=""
QUERY_RESP=""

if curl -sf "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
  info "Backend proxy detected on port $BACKEND_PORT"

  # 3a: Health endpoint
  echo -n "  Health endpoint... "
  HEALTH_RESP=$(curl -sf "http://localhost:$BACKEND_PORT/health" 2>&1)
  if [[ $? -eq 0 ]]; then
    HEALTH_STATUS=$(echo "$HEALTH_RESP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status)" 2>/dev/null || echo "unknown")
    if [[ "$HEALTH_STATUS" == "ok" ]]; then
      pass "Health endpoint: status=ok"
    else
      fail "Health endpoint: status=$HEALTH_STATUS"
    fi
    info "  Health response: $HEALTH_RESP"
  else
    fail "Health endpoint unreachable"
  fi

  # 3b: Prometheus query proxy
  echo -n "  Prometheus query proxy... "
  QUERY_RESP=$(curl -sf "http://localhost:$BACKEND_PORT/api/query?query=node_amdgpu_busy_percent" 2>&1)
  if [[ $? -eq 0 ]]; then
    if echo "$QUERY_RESP" | node -e "process.exit(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status ? 0 : 1)" 2>/dev/null; then
      pass "Query endpoint returned valid Prometheus response"
    else
      # Some Prometheus errors are expected (metric may not exist)
      if [[ ${#QUERY_RESP} -gt 0 ]]; then
        pass "Query endpoint returned response (metric may not exist)"
        info "  Query response (truncated): $(echo "$QUERY_RESP" | head -c 200)"
      else
        fail "Query endpoint returned empty response"
      fi
    fi
  else
    # Check if Prometheus is accessible at all
    PROM_DIRECT=$(curl -sf "$PROMETHEUS_URL/api/v1/query?query=up" 2>&1)
    if [[ $? -eq 0 ]]; then
      fail "Query endpoint: Prometheus returned error for node_amdgpu_busy_percent"
      info "  Query response: $(echo "$QUERY_RESP" | head -c 200)"
    else
      fail "Query endpoint: Prometheus ($PROMETHEUS_URL) unreachable"
      info "  Direct Prometheus error: $PROM_DIRECT"
    fi
  fi

  # 3c: CORS headers
  echo -n "  CORS headers... "
  CORS_HEADERS=$(curl -s -H 'Origin: http://localhost:8504' -I "http://localhost:$BACKEND_PORT/health" 2>&1)
  if echo "$CORS_HEADERS" | grep -qi "access-control-allow-origin"; then
    pass "CORS headers present"
    info "  Access-Control-Allow-Origin: $(echo "$CORS_HEADERS" | grep -i 'access-control-allow-origin' | tr -d '\r')"
  else
    fail "CORS headers missing"
  fi
else
  info "No backend proxy listening on port $BACKEND_PORT — this script no longer starts one."
  info "(Backend process management is moving to a docker-compose service, set up separately.)"
  skip "Health endpoint (no backend running on port $BACKEND_PORT)"
  skip "Prometheus query proxy (no backend running on port $BACKEND_PORT)"
  skip "CORS headers (no backend running on port $BACKEND_PORT)"
fi

# =============================================================================
# Step 4: Write validation results
# =============================================================================
echo ""
echo "========================================="
echo "  Step 4: Writing validation results"
echo "========================================="

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
VALIDATION_FILE="$SCRIPT_DIR/validation-results.md"

{
  echo "# Performance Metrics Plugin — Validation Results"
  echo ""
  echo "**Timestamp:** $TIMESTAMP"
  echo "**Backend Port (if running):** $BACKEND_PORT"
  echo "**Prometheus URL:** $PROMETHEUS_URL"
  echo "**Plugin Source Directory:** $PLUGIN_DIR"
  echo ""
  echo "## Summary"
  echo ""
  echo "- ✅ Passed: $PASS_COUNT"
  echo "- ❌ Failed: $FAIL_COUNT"
  echo "- ⏭️  Skipped: $SKIP_COUNT"
  echo "- Total checks: $((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))"
  echo ""
  echo "## Detailed Results"
  echo ""
  for result in "${RESULTS[@]}"; do
    echo "- $result"
  done
  echo ""
  if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo "## Errors"
    echo ""
    for err in "${ERRORS[@]}"; do
      echo "- $err"
    done
    echo ""
  fi
  if [[ -n "$HEALTH_RESP" ]]; then
    echo "## Backend Health Response"
    echo ""
    echo '```json'
    echo "$HEALTH_RESP"
    echo '```'
    echo ""
  fi
  if [[ -n "$QUERY_RESP" ]]; then
    echo "## Query Response"
    echo ""
    echo '```json'
    echo "$QUERY_RESP" | head -20
    echo '```'
    echo ""
  fi
  echo "## Next Steps"
  echo ""
  if [[ $FAIL_COUNT -eq 0 && $SKIP_COUNT -eq 0 ]]; then
    echo "All validations passed. The plugin is ready for use in the PI WEB browser at http://127.0.0.1:8504"
  elif [[ $FAIL_COUNT -eq 0 ]]; then
    echo "All non-skipped validations passed. Backend proxy checks were skipped because no proxy was running on port $BACKEND_PORT — start the backend (or the docker-compose service, once available) and re-run to exercise those checks."
  else
    echo "Some validations failed. Review the errors above and re-run the script."
  fi
  echo ""
} > "$VALIDATION_FILE"

info "Validation results written to: $VALIDATION_FILE"

# Print summary
echo ""
echo "========================================="
echo "  VALIDATION COMPLETE"
echo "========================================="
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
else
  echo -e "  ${GREEN}Failed: 0${NC}"
fi
echo -e "  ${YELLOW}Skipped: $SKIP_COUNT${NC}"
echo ""

# Exit with appropriate code
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
else
  exit 0
fi
