#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

repo=krus1995/subboost
sha=${GITHUB_SHA:?}
transfer_id="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
[[ $GITHUB_REPOSITORY == "$repo" && $GITHUB_REF == refs/heads/main && $sha =~ ^[0-9a-f]{40}$ ]]
[[ $transfer_id =~ ^[1-9][0-9]*-[1-9][0-9]*$ && $BUILD_RUN_ID =~ ^[1-9][0-9]*$ ]]
[[ $DEPLOY_USER == root && $DEPLOY_PORT =~ ^[1-9][0-9]{0,4}$ && $DEPLOY_PORT -le 65535 ]]
[[ -n $DEPLOY_PATH && $PRODUCTION_URL == https://subboost.krus1987.kdns.fr && -n $SSHPASS && -n $DEPLOY_KNOWN_HOSTS ]]
node -e 'process.exit(require("node:net").isIP(process.argv[1]) ? 0 : 1)' "$DEPLOY_HOST"

cd "${1:?usage: transfer-release.sh ARTIFACT_DIRECTORY}"
for file in SHA256SUMS image.tar.gz release.json; do [[ -f $file && ! -L $file ]]; done
checksums=$(sha256sum image.tar.gz release.json)
cmp -s <(printf '%s\n' "$checksums") SHA256SUMS || { echo 'Invalid artifact checksums.' >&2; exit 1; }
archive=${checksums%% *}
image=$(jq -er --arg repo "$repo" --arg sha "$sha" --arg digest "$archive" \
  --arg run "https://github.com/$repo/actions/runs/$BUILD_RUN_ID" '
  select(.schemaVersion == 1 and .repository == $repo and .sourceSha == $sha and
    .platform == "linux/amd64" and .imageReference == ("subboost-fork:" + $sha) and
    .archiveSha256 == $digest and .workflowRunUrl == $run)
  | .imageId | select(test("^sha256:[0-9a-f]{64}$"))' release.json)
bytes=$(stat -c %s image.tar.gz)

known=$(mktemp "$RUNNER_TEMP/subboost-known-hosts.XXXXXXXX")
trap 'rm -f "$known"' EXIT
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$known"
opts=(-F /dev/null -o BatchMode=no -o PreferredAuthentications=password -o PasswordAuthentication=yes
      -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=yes
      -o "UserKnownHostsFile=$known" -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no
      -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=3)
peer="root@$DEPLOY_HOST"
scp_peer=$peer
if [[ $DEPLOY_HOST == *:* ]]; then scp_peer="root@[$DEPLOY_HOST]"; fi
wrapper=/usr/local/sbin/subboost-fork-deploy
deadline=$((SECONDS + 5400))

# A dropped connection may mean the request reached systemd. Retrying a wrapper
# call uses the same release and transfer identities.
remote() {
  local attempt rc reply
  for attempt in 1 2 3 4; do
    if reply=$(sshpass -e ssh "${opts[@]}" -p "$DEPLOY_PORT" "$peer" "$@"); then rc=0; else rc=$?; fi
    if [[ $rc != 255 || $attempt == 4 ]]; then
      printf '%s\n' "$reply"
      return "$rc"
    fi
    sleep 5
  done
}

current_main() {
  local tip
  tip=$(gh api "repos/$repo/git/ref/heads/main" --jq '.object.sha')
  [[ $tip =~ ^[0-9a-f]{40}$ ]] || { echo 'Cannot establish the current main commit.' >&2; exit 1; }
  if [[ $tip != "$sha" ]]; then
    echo "superseded: $sha (main is $tip)" | tee -a "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
}

wait_for_release() {
  local target=$1 receipt phase
  while ((SECONDS < deadline)); do
    receipt=$(remote "$wrapper" status "$target")
    phase=$(jq -er '.phase' <<< "$receipt")
    case "$phase" in
      ACTIVE)
        if [[ $target == "$sha" ]]; then
          jq -e --arg sha "$sha" --arg image "$image" --arg digest "$archive" \
            '.sourceSha == $sha and .imageId == $image and .archiveSha256 == $digest' <<< "$receipt" >/dev/null
          echo "ACTIVE $sha · $image · archive $archive" | tee -a "$GITHUB_STEP_SUMMARY"
        fi
        return 0 ;;
      SUPERSEDED)
        echo "superseded: $target" | tee -a "$GITHUB_STEP_SUMMARY"
        return 0 ;;
      QUEUED|PREPARED|BACKED_UP|CANDIDATE_RUNNING|ACTIVATING) sleep 10 ;;
      *) echo "Deployment $target reported $phase." >&2; return 1 ;;
    esac
  done
  echo "Receipt timeout. Query $wrapper status $target on the host." >&2
  return 1
}

current_main
[[ $(remote id -u) == 0 ]]
prepared=$(remote "$wrapper" prepare "$sha" "$transfer_id" "$bytes" "$archive" "$image")
jq -e --arg dir "$DEPLOY_PATH" '.deployPath == $dir and (.upload | type == "boolean")' <<< "$prepared" >/dev/null
if [[ $(jq -r .upload <<< "$prepared") == true ]]; then
  dest="/var/lib/subboost-fork/incoming/$sha.$transfer_id.partial/"
  sshpass -e scp "${opts[@]}" -P "$DEPLOY_PORT" image.tar.gz release.json SHA256SUMS "$scp_peer:$dest"
fi

while ((SECONDS < deadline)); do
  current_main
  if reply=$(remote "$wrapper" submit "$sha" "$transfer_id" "$archive" "$image"); then
    wait_for_release "$sha"
    exit 0
  else
    rc=$?
  fi
  if [[ $rc != 75 ]]; then echo "Release submission exited $rc." >&2; exit "$rc"; fi
  busy=$(jq -er '.busy | select(test("^[0-9a-f]{40}$"))' <<< "$reply")
  echo "Host is processing $busy; following its receipt."
  wait_for_release "$busy"
done
echo "Timed out waiting to submit $sha." >&2
exit 1
