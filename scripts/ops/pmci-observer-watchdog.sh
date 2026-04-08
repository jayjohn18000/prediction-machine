#!/bin/bash
LOG=/tmp/pmci-observer-watchdog.log
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PIDS=$(pgrep -f 'node observer.mjs' 2>/dev/null)
if [ -z "$PIDS" ]; then
 cd ~/prediction-machine && nohup node observer.mjs >> /tmp/observer.log 2>&1 &
 NEW_PID=$!
 echo "[$TS] RESTARTED PID=$NEW_PID" >> $LOG
 echo "ALERT: Observer dead — restarted PID=$NEW_PID"
else
 echo "[$TS] OK PIDs=$PIDS" >> $LOG
 echo "OK: Observer running PIDs=$PIDS"
fi
