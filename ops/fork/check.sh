#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

source_checks() {
  npm ci
  npm run lint
  local coverage_args=()
  # Git for Windows starts a shell per lifecycle test. Bound concurrency to avoid
  # shell startup contention under the existing per-test timeout.
  if [[ -n ${MSYSTEM:-} ]]; then coverage_args=(-- --maxWorkers=2); fi
  npm run test:coverage "${coverage_args[@]}"
  NEXT_TELEMETRY_DISABLED=1 npm run check:local-app
}

rules() {
  local script base
  while IFS= read -r -d '' script; do bash -n "$script"; done < <(find ops/fork -type f -name '*.sh' -print0)
  node ops/fork/check-rules.mjs
  base=${FORK_BASE_SHA:-origin/main}
  if [[ $base == 0000000000000000000000000000000000000000 ]]; then
    base=$(node -p "require('./ops/fork/config.json').upstreamCommit")
  fi
  git rev-parse --verify "$base^{commit}" >/dev/null
  git diff --exit-code --no-renames --diff-filter=MDT "$base" -- local/prisma/migrations
  git merge-base --is-ancestor "$(node -p "require('./ops/fork/config.json').upstreamCommit")" HEAD
  bash ops/fork/test-upstream.sh
  bash ops/fork/test-transfer.sh
}

host_checks() {
  if [[ -n ${MSYSTEM:-} ]]; then
    MSYS_NO_PATHCONV=1 wsl.exe --distribution podman-machine-default --user root --cd "$(pwd -W)" \
      -- env CONTAINER_HOST=unix:///run/podman/podman.sock CONTAINER_ENGINE=podman python3 -B ops/fork/test-host.py
  else
    sudo -H env CONTAINER_ENGINE="${CONTAINER_ENGINE:-docker}" python3 -B ops/fork/test-host.py
  fi
}

case ${1:-all} in
  all) source_checks; rules; bash ops/fork/check-image.sh; host_checks ;;
  source) source_checks ;;
  rules) rules ;;
  image) bash ops/fork/check-image.sh ;;
  host) host_checks ;;
  *) echo 'Usage: bash ops/fork/check.sh [all|source|rules|image|host]' >&2; exit 2 ;;
esac
