#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
# Use only throwaway repositories. Redirection also covers spawned git commands.
export GIT_CONFIG_GLOBAL="$tmp/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global user.name 'SubBoost CI'
git config --global user.email 'ci@subboost.invalid'
git config --global protocol.file.allow always
git config --global commit.gpgSign false
git config --global core.autocrlf false
mkdir "$tmp/seed"
cd "$tmp/seed"
git init -q -b main
mkdir -p ops/fork
cp "$repo/ops/fork/config.json" ops/fork/
echo 'shared' > policy
git add . && git commit -qm baseline && git tag -a initial -m initial
base=$(git rev-parse HEAD)
git clone -q --bare . "$tmp/fork.git"
git clone -q --bare . "$tmp/up.git"
git config --global url."$tmp/fork.git".insteadOf https://github.com/krus1995/subboost.git
git config --global url."$tmp/up.git".insteadOf https://github.com/SubBoost/subboost.git
git clone -q https://github.com/krus1995/subboost.git "$tmp/task"
git -C "$tmp/task" remote add upstream https://github.com/SubBoost/subboost.git
sync() { (cd "$tmp/task" && bash "$repo/ops/fork/sync-upstream.sh" "$@"); }
# The merger must keep both histories, even when one side can fast-forward.
sync initial | grep -Fx no-op
echo upstream > upstream.txt
git add . && git commit -qm clean && git tag -a clean -m clean
clean=$(git rev-parse HEAD)
git push -q "$tmp/up.git" HEAD:main refs/tags/clean
sync clean > "$tmp/result"
merged=$(git -C "$tmp/task" rev-parse HEAD)
[[ "$(git -C "$tmp/task" rev-parse HEAD^1)" == "$base" && "$(git -C "$tmp/task" rev-parse HEAD^2)" == "$clean" ]]
sync clean >> "$tmp/result"
[[ "$(git -C "$tmp/task" rev-parse HEAD)" == "$merged" ]]
git -C "$tmp/task" push -q origin "HEAD:sync/upstream-${clean:0:12}"
git -C "$tmp/task" switch -q main
git -C "$tmp/task" branch -q -D "sync/upstream-${clean:0:12}"
sync clean >> "$tmp/result"
[[ "$(git -C "$tmp/task" rev-parse HEAD)" == "$merged" ]]
# Arrange a real conflict between upstream and fork on top of their common merge.
echo upstream > policy
git add policy && git commit -qm 'upstream policy' && git tag -a conflict -m conflict
target=$(git rev-parse HEAD)
git push -q "$tmp/up.git" HEAD:main refs/tags/conflict
cd "$tmp/task"
git switch -q main && git merge -q --ff-only "$merged"
echo fork > policy
git add policy && git commit -qm 'fork policy' && git push -q origin main
fork_tip=$(git rev-parse HEAD)
if sync conflict; then echo 'Expected a conflict' >&2; exit 1; fi
[[ "$(git rev-parse MERGE_HEAD)" == "$target" ]]
git ls-files --unmerged -- policy | grep -q .
printf 'fork\nupstream\n' > policy
git add policy && git commit -qm 'preserve both policies'
sync conflict >> "$tmp/result"
git merge-base --is-ancestor "$fork_tip" HEAD
git merge-base --is-ancestor "$target" HEAD
git push -q origin HEAD:main
sync "$target" | grep -Fx no-op
# Non-tag namespaces are mutable by default in git fetch. Detect tag reuse.
git -C "$tmp/seed" tag -fa clean -m moved "$target" >/dev/null
git -C "$tmp/seed" push -q --force "$tmp/up.git" refs/tags/clean
if sync clean > "$tmp/moved" 2>&1; then echo 'Accepted a moved tag' >&2; exit 1; fi
grep -F 'Upstream tag moved' "$tmp/moved" >/dev/null
echo 'Upstream no-op, clean merge, local/remote resume, conflict resolution and retag checks passed.'
