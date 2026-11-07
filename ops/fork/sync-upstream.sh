#!/usr/bin/env bash
# Run in a dedicated, clean worktree. A conflict leaves the merge in progress.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
(( $# <= 1 )) || { echo 'Usage: sync-upstream.sh [tag|full-commit]' >&2; exit 2; }
config() { node -p "require('./ops/fork/config.json').$1"; }
fork=$(config repository)
upstream=$(config upstreamRepository)
main=$(config branch)
verify_remote() {
  case "$(git config --get "remote.$1.url")" in
    "https://github.com/$2"|"https://github.com/$2.git"|"git@github.com:$2.git") ;;
    *) echo "Check remote $1 against $2 first" >&2; exit 1 ;;
  esac
}
verify_remote origin "$fork"
verify_remote upstream "$upstream"
ref=${1:-}
if [[ -z "$ref" ]]; then
  ref=$(gh api "repos/$upstream/releases/latest" --jq 'select(.draft == false and .prerelease == false) | .tag_name')
  [[ -n "$ref" ]] || { echo 'No stable release found' >&2; exit 1; }
fi
git fetch --no-tags origin "refs/heads/$main:refs/remotes/origin/$main"
base=$(git rev-parse --verify "refs/remotes/origin/$main^{commit}")
if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  git fetch --no-tags upstream "$ref"
  target=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
else
  [[ "$ref" != -* ]] && git check-ref-format "refs/tags/$ref" || { echo 'Invalid tag' >&2; exit 2; }
  # A moved published tag needs investigation. Keep the first observed tag object.
  git fetch --no-tags upstream "refs/tags/$ref"
  tag_object=$(git rev-parse --verify FETCH_HEAD)
  if git show-ref --verify --quiet "refs/upstream-tags/$ref"; then
    [[ "$(git rev-parse "refs/upstream-tags/$ref")" == "$tag_object" ]] || { echo "Upstream tag moved: $ref" >&2; exit 1; }
  else
    git update-ref "refs/upstream-tags/$ref" "$tag_object" 0000000000000000000000000000000000000000
  fi
  target=$(git rev-parse --verify "refs/upstream-tags/$ref^{commit}")
fi
branch="sync/upstream-${target:0:12}"
printf 'B=%s\nU=%s\nref=%s\nbranch=%s\n' "$base" "$target" "$ref" "$branch"
ancestor() {
  local code
  git merge-base --is-ancestor "$1" "$2" && return 0
  code=$?
  (( code == 1 )) || exit "$code"
  return 1
}
if ancestor "$target" "$base"; then echo 'no-op'; exit 0; fi
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  echo 'Resume the merge in this worktree with git status' >&2
  exit 1
fi
[[ -z "$(git status --porcelain)" ]] || { echo 'Use a clean task worktree' >&2; exit 1; }
# An existing PR may have been opened from another workstation.
if git ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null; then
  git fetch --no-tags origin "refs/heads/$branch:refs/remotes/origin/$branch"
  remote_tip=$(git rev-parse "refs/remotes/origin/$branch")
else
  code=$?
  (( code == 2 )) || exit "$code"
  remote_tip=''
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git switch "$branch"
  if [[ -n "$remote_tip" ]] && ! ancestor "$remote_tip" HEAD; then
    git merge --ff-only "$remote_tip"
  fi
else
  git switch --no-track -c "$branch" "${remote_tip:-$base}"
fi
if ! ancestor "$base" HEAD; then git merge --no-ff --no-edit "$base"; fi
if ! ancestor "$target" HEAD; then git merge --no-ff --no-edit "$target"; fi
git merge-base --is-ancestor "$base" HEAD
git merge-base --is-ancestor "$target" HEAD
printf 'candidate=%s\n' "$(git rev-parse HEAD)"
