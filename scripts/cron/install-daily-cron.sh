#!/usr/bin/env bash
# Idempotently install a user crontab entry for audit:repo:daily.
# Usage: ./scripts/cron/install-daily-cron.sh
# Optional: MINUTE=45 HOUR=7 ./scripts/cron/install-daily-cron.sh  (default 30 6 UTC)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/cron/run-repo-roadmap-audit-daily.sh"
LOG_FILE="$REPO_ROOT/state/repo-audit/cron.log"
MARKER_LINE="# prediction-machine: audit:repo:daily"

MINUTE="${MINUTE:-30}"
HOUR="${HOUR:-6}"

if [ ! -x "$RUNNER" ]; then
  chmod +x "$RUNNER" 2>/dev/null || true
fi

CRON_LINE="$MINUTE $HOUR * * * $RUNNER >> $LOG_FILE 2>&1"

TMP="$(mktemp)"
{
  crontab -l 2>/dev/null | grep -vF "$MARKER_LINE" | grep -v 'run-repo-roadmap-audit-daily.sh' || true
  echo "$MARKER_LINE"
  echo "$CRON_LINE"
} >"$TMP"
crontab "$TMP"
rm -f "$TMP"

echo "Installed daily cron: minute=$MINUTE hour=$HOUR (server local time)"
echo "  $MARKER_LINE"
echo "  $CRON_LINE"
echo "Log: $LOG_FILE"
echo "Secrets: ~/.config/prediction-machine/audit.env or $REPO_ROOT/.env.cron.local (DATABASE_URL, optional PMCI_WIKI_ROOT)"
