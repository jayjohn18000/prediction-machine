#!/usr/bin/env bash
# Daily persisted repo roadmap audit for cron / launchd.
# Loads secrets from optional env files (see state/repo-audit/README.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Cron uses a minimal PATH — Homebrew and common locations first
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:${PATH:-}"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/prediction-machine"
load_env_file() {
  local f="$1"
  if [ -f "$f" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$f"
    set +a
  fi
}

load_env_file "$CONFIG_DIR/audit.env"
load_env_file "$REPO_ROOT/.env.cron.local"

exec npm run audit:repo:daily
