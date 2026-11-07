#!/usr/bin/env bash
set -euo pipefail
case ${1:-status} in
  update) exec /usr/local/sbin/subboost-fork-deploy retry-current ;;
  status|doctor) exec /usr/local/sbin/subboost-fork-deploy preflight ;;
  backup|logs) exec /usr/local/sbin/subboost-fork-deploy "$1" ;;
  *) echo 'Usage: subboost {status|doctor|logs|backup|update}' >&2; exit 2 ;;
esac
