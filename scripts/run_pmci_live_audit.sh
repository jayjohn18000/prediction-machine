#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== PMCI LIVE AUDIT $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo ""

echo "--- Schema ---"
npm run verify:schema

echo ""
echo "--- Smoke ---"
npm run pmci:smoke

echo ""
echo "--- API Port 3001 ---"
lsof -iTCP:3001 -sTCP:LISTEN -n -P 2>/dev/null && echo "PORT_3001_LISTENING" || echo "PORT_3001_NOT_LISTENING"
curl -s --max-time 3 http://localhost:3001/v1/health/slo 2>/dev/null | head -c 300 || echo "API_UNREACHABLE"

echo ""
echo "--- Sports Proposer ---"
npm run pmci:propose:sports 2>&1 | tail -5

echo ""
echo "--- Sports Audit Packet ---"
npm run pmci:audit:sports:packet 2>&1 | tail -10

echo ""
echo "=== AUDIT COMPLETE ==="
