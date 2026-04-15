#!/usr/bin/env sh
set -e
case "$PMCI_FLY_ROLE" in
  api) exec node src/api.mjs ;;
  observer) exec node observer.mjs ;;
  *)
    echo "docker-entrypoint: PMCI_FLY_ROLE must be 'api' or 'observer', got: ${PMCI_FLY_ROLE:-empty}" >&2
    exit 1
    ;;
esac
