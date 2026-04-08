#!/bin/bash
LOG=/tmp/pmci-ingest.log
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[$TS] Starting ingestion" >> $LOG
cd ~/prediction-machine
npm run pmci:ingest:politics:universe >> $LOG 2>&1; POL=$?
npm run pmci:ingest:sports >> $LOG 2>&1; SPT=$?
echo "[$TS] politics=$POL sports=$SPT" >> $LOG
if [ $POL -ne 0 ] || [ $SPT -ne 0 ]; then
 echo "ALERT: Ingest failure politics=$POL sports=$SPT. See /tmp/pmci-ingest.log"; exit 1
fi
echo "OK: Ingestion complete politics=$POL sports=$SPT"
