#!/usr/bin/env bash
set -euo pipefail
if [[ -n ${MSYSTEM:-} ]]; then
  # Preserve the Linux host paths in JSON and use LF with native Windows jq.
  jq() { MSYS2_ARG_CONV_EXCL='*' command jq --binary "$@"; }
  export -f jq
fi

# Simulate GitHub and the host to exercise the runner without production credentials.
scripts=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
mkdir bin artifact
export PATH="$tmp/bin:$PATH" RUNNER_TEMP="$tmp" GITHUB_REPOSITORY=krus1995/subboost GITHUB_REF=refs/heads/main
export GITHUB_SHA=1111111111111111111111111111111111111111 GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 BUILD_RUN_ID=90
export GITHUB_STEP_SUMMARY="$tmp/summary" GITHUB_OUTPUT="$tmp/outputs" TEST_LOG="$tmp/ssh.log"
export DEPLOY_HOST=192.0.2.1 DEPLOY_PORT=22 DEPLOY_USER=root DEPLOY_PATH=/opt/subboost
export DEPLOY_KNOWN_HOSTS=test SSHPASS=test PRODUCTION_URL=https://subboost.krus1987.kdns.fr
export BUSY_SHA=2222222222222222222222222222222222222222
printf archive > artifact/image.tar.gz
archive=$(sha256sum artifact/image.tar.gz | cut -d' ' -f1)
image=sha256:$archive
export IMAGE=$image ARCHIVE=$archive
jq -n --arg sha "$GITHUB_SHA" --arg image "$IMAGE" --arg digest "$ARCHIVE" '
  {schemaVersion:1, repository:"krus1995/subboost", platform:"linux/amd64",sourceSha:$sha,
   imageReference:("subboost-fork:"+$sha),imageId:$image,archiveSha256:$digest,
   workflowRunUrl:"https://github.com/krus1995/subboost/actions/runs/90"}' > artifact/release.json
(cd artifact && sha256sum image.tar.gz release.json > SHA256SUMS)

cat > bin/gh <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *git/ref/heads/main*) echo "${TEST_TIP:-$GITHUB_SHA}" ;;
  *actions/runs/90/artifacts*) echo '{"total_count":1,"artifacts":[{"id":123,"expired":false}]}' ;;
  *actions/runs/90) jq -n --arg sha "${TEST_BUILD_SHA:-$GITHUB_SHA}" '
    {event:"push",path:".github/workflows/fork-build-deploy.yml",head_branch:"main",head_sha:$sha,
    head_repository:{full_name:"krus1995/subboost"}}' ;;
  *) exit 1 ;;
esac
EOF
cat > bin/sshpass <<'EOF'
#!/usr/bin/env bash
set -eu
[[ $1 == -e && $* == *StrictHostKeyChecking=yes* ]]
if [[ $2 == scp ]]; then echo upload >> "$TEST_LOG"; exit 0; fi
while [[ $1 != root@192.0.2.1 ]]; do shift; done
shift
if [[ $1 == id ]]; then echo 0; exit 0; fi
[[ $1 == /usr/local/sbin/subboost-fork-deploy ]]
shift
echo "$*" >> "$TEST_LOG"
case "$1" in
  prepare) echo '{"upload":true,"deployPath":"/opt/subboost"}' ;;
  submit)
    if [[ $(grep -c '^submit ' "$TEST_LOG") == 1 ]]; then
      jq -n --arg busy "$BUSY_SHA" '{busy:$busy}'; exit 75
    fi
    if [[ $(grep -c '^submit ' "$TEST_LOG") == 2 ]]; then echo 'interrupted'; exit 255; fi ;;
  status)
    jq -n --arg sha "$2" --arg image "$IMAGE" --arg archive "$ARCHIVE" \
      '{phase:"ACTIVE",sourceSha:$sha,imageId:$image,archiveSha256:$archive}' ;;
  *) exit 1 ;;
esac
EOF
# Skip reconnect backoff in this isolated test.
printf '#!/usr/bin/env bash\nexit 0\n' > bin/sleep
chmod +x bin/*
export GITHUB_EVENT_NAME=workflow_dispatch
bash "$scripts/select-release.sh"
grep -qx 'artifact_id=123' "$GITHUB_OUTPUT"
if TEST_BUILD_SHA=$BUSY_SHA bash "$scripts/select-release.sh"; then exit 1; fi

TEST_TIP=$BUSY_SHA bash "$scripts/transfer-release.sh" artifact
[[ ! -e $TEST_LOG ]]
echo altered >> artifact/image.tar.gz
if bash "$scripts/transfer-release.sh" artifact; then exit 1; fi
[[ ! -e $TEST_LOG ]]
printf archive > artifact/image.tar.gz
bash "$scripts/transfer-release.sh" artifact
[[ $(grep -cx upload "$TEST_LOG") == 1 && $(grep -c '^submit ' "$TEST_LOG") == 3 ]]
[[ $(sort -u "$TEST_LOG" | grep -c '^submit ') == 1 ]]
grep -qx "status $BUSY_SHA" "$TEST_LOG"
grep -qx "status $GITHUB_SHA" "$TEST_LOG"
grep -q "^ACTIVE $GITHUB_SHA" "$GITHUB_STEP_SUMMARY"
echo 'Artifact retry, wrong SHA, stale main, modified archive, busy host and reconnect checks passed.'
