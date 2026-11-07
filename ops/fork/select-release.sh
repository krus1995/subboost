#!/usr/bin/env bash
set -euo pipefail

# A deploy retry reads the original push run, even if its deploy job failed.
repo=krus1995/subboost
sha=${GITHUB_SHA:?}
[[ $GITHUB_REPOSITORY == "$repo" && $GITHUB_REF == refs/heads/main && $sha =~ ^[0-9a-f]{40}$ ]]
name="subboost-fork-$sha"
api="repos/$repo/actions"
if [[ $GITHUB_EVENT_NAME == workflow_dispatch ]]; then
  [[ ${BUILD_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || { echo 'A numeric build_run_id is required.' >&2; exit 1; }
  runs=$BUILD_RUN_ID
else
  [[ $GITHUB_EVENT_NAME == push ]]
  runs=$(gh api --paginate "$api/workflows/fork-build-deploy.yml/runs?event=push&branch=main&head_sha=$sha&per_page=100" \
    --jq '.workflow_runs[].id')
fi

for id in $runs; do
  gh api "$api/runs/$id" | jq -e --arg repo "$repo" --arg sha "$sha" '
    .event == "push" and .path == ".github/workflows/fork-build-deploy.yml" and
    .head_branch == "main" and .head_sha == $sha and .head_repository.full_name == $repo' >/dev/null
  artifact=$(gh api "$api/runs/$id/artifacts?name=$name" | jq -er '
    if .total_count == 0 then "missing"
    elif .total_count == 1 and .artifacts[0].expired == false then .artifacts[0].id
    else error("Artifact expired or ambiguous") end')
  if [[ $artifact != missing ]]; then
    [[ $artifact =~ ^[1-9][0-9]*$ ]]
    echo "artifact_id=$artifact" >> "$GITHUB_OUTPUT"
    echo "run_id=$id" >> "$GITHUB_OUTPUT"
    exit 0
  fi
done
[[ $GITHUB_EVENT_NAME == push ]] || { echo 'The original run has no retained image archive.' >&2; exit 1; }
echo "run_id=$GITHUB_RUN_ID" >> "$GITHUB_OUTPUT"
