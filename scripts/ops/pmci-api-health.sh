#!/bin/bash
LOG=/tmp/pmci-api-health.log
PORT=3001
API_KEY=$(grep -E '^PMCI_API_KEY=' ~/prediction-machine/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESP=$(curl -sf --max-time 10 -H "x-pmci-api-key: $API_KEY" "http://localhost:$PORT/v1/health/slo" 2>/dev/null)
EXIT=$?
if [ $EXIT -ne 0 ] || [ -z "$RESP" ]; then
 echo "[$TS] FAIL: unreachable" >> $LOG
 echo "ALERT: PMCI API /v1/health/slo unreachable on port $PORT"; exit 1
fi
echo "[$TS] $RESP" >> $LOG
FAILS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('checks',d.get('slo',d)); f=[k for k,v in (c if isinstance(c,dict) else {}).items() if isinstance(v,dict) and v.get('status')=='fail']; print(','.join(f) if f else '')" 2>/dev/null)
if [ -n "$FAILS" ]; then echo "ALERT: SLO failures: $FAILS"; exit 1; fi
echo "OK: All SLO checks passing"
