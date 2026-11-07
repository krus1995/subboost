#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/python3 -I -B /usr/local/lib/subboost-fork/host.py "$@"
