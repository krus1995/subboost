#!/usr/bin/env bash
set -euo pipefail

# Called from a clean checkout of the verified main commit.
out=${1:?usage: build-release.sh OUTPUT_DIRECTORY}
repo=krus1995/subboost
sha=${GITHUB_SHA:?}
[[ $GITHUB_REPOSITORY == "$repo" && $GITHUB_REF == refs/heads/main ]]
[[ $sha =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD) == "$sha" ]]
[[ $GITHUB_RUN_ID =~ ^[1-9][0-9]*$ ]]
git diff --quiet HEAD
[[ -z $(git ls-files --others --exclude-standard) ]]
mkdir -p "$out"
[[ -z $(ls -A "$out") ]]

tag=$(jq -er '.upstreamTag' ops/fork/config.json)
upstream=$(jq -er '.upstreamCommit' ops/fork/config.json)
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && $upstream =~ ^[0-9a-f]{40}$ ]]
git fetch --no-tags https://github.com/SubBoost/subboost.git "refs/tags/$tag"
[[ $(git rev-parse --verify 'FETCH_HEAD^{commit}') == "$upstream" ]]
git merge-base --is-ancestor "$upstream" "$sha"
gh api "repos/SubBoost/subboost/releases/tags/$tag" |
  jq -e --arg tag "$tag" '.tag_name == $tag and .draft == false and .prerelease == false' >/dev/null

package=$(jq -er '.version' package.json)
[[ $package =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
version="$package+sha.${sha:0:12}"
image="subboost-fork:$sha"
docker build --platform linux/amd64 --file local/Dockerfile \
  --label "org.opencontainers.image.revision=$sha" \
  --label "org.opencontainers.image.source=https://github.com/$repo" \
  --build-arg "APP_BUILD_SHA=$sha" --build-arg "APP_RELEASE_VERSION=$package" \
  --build-arg "APP_VERSION=$version" --build-arg "APP_VERSION_TOKEN=$version" \
  --tag "$image" .

image_id=$(docker image inspect "$image" | jq -er --arg sha "$sha" --arg repo "$repo" '
  .[0] | select(.Architecture == "amd64" and .Os == "linux"
    and .Config.Labels["org.opencontainers.image.revision"] == $sha
    and .Config.Labels["org.opencontainers.image.source"] == ("https://github.com/" + $repo))
  | .Id | select(test("^sha256:[0-9a-f]{64}$"))')
migrations=$(cd local/prisma/migrations &&
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)
docker save "$image" | gzip -n -1 > "$out/image.tar.gz"
cd "$out"
archive=$(sha256sum image.tar.gz | cut -d' ' -f1)
jq -n --arg repo "$repo" --arg sha "$sha" --arg tag "$tag" --arg upstream "$upstream" \
  --arg image "$image" --arg imageId "$image_id" --arg archive "$archive" \
  --arg migrations "$migrations" --arg run "https://github.com/$repo/actions/runs/$GITHUB_RUN_ID" \
  '{schemaVersion:1,repository:$repo,sourceSha:$sha,upstreamTag:$tag,upstreamCommit:$upstream,
    platform:"linux/amd64",imageReference:$image,imageId:$imageId,archiveSha256:$archive,
    migrationTreeSha256:$migrations,workflowRunUrl:$run}' > release.json
sha256sum image.tar.gz release.json > SHA256SUMS
sha256sum --strict -c SHA256SUMS
{
  echo '### Verified release archive'
  echo
  echo '```json'
  cat release.json
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:?}"
