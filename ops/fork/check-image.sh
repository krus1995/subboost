#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
engine=${CONTAINER_ENGINE:-docker}
if [[ -z ${CONTAINER_ENGINE:-} ]] && ! command -v docker >/dev/null; then engine=podman; fi
if [[ $engine != docker && $engine != podman ]]; then echo 'Use docker or podman' >&2; exit 2; fi
export MSYS_NO_PATHCONV=1
revision=$(git rev-parse HEAD)
version=$(node -p "require('./package.json').version")
suffix=$(node -p "require('node:crypto').randomBytes(8).toString('hex')")
network="subboost-check-$suffix"
image="localhost/subboost-fork-check:$suffix"
db=
app=
network_id=
built=false

cleanup() {
  [[ -z $app ]] || "$engine" rm -fv "$app" >/dev/null || :
  [[ -z $db ]] || "$engine" rm -fv "$db" >/dev/null || :
  [[ -z $network_id ]] || "$engine" network rm "$network" >/dev/null || :
  [[ $built == false ]] || "$engine" rmi "$image" >/dev/null || :
}
trap cleanup EXIT
# actionlint 1.7.12 predates GitHub's queue property. check-rules.mjs checks
# its exact value and location; all other workflow diagnostics remain fatal.
repo_path=$(pwd -P)
if [[ -n ${MSYSTEM:-} ]]; then repo_path=$(pwd -W); fi
"$engine" run --rm --platform linux/amd64 --network none --volume "$repo_path:/repo:ro" --workdir /repo \
  docker.io/rhysd/actionlint@sha256:9d36088643581e728c969f35141f88139fec77280b2be23c1f66f8e40e1025e7 \
  -ignore '^unexpected key "queue" for "concurrency" section' .github/workflows/fork-{ci,build-deploy}.yml
"$engine" build --platform linux/amd64 --file local/Dockerfile \
  --label "org.opencontainers.image.revision=$revision" --build-arg "APP_BUILD_SHA=$revision" \
  --build-arg "APP_RELEASE_VERSION=$version" --build-arg "APP_VERSION=$version+sha.${revision:0:12}" \
  --build-arg "APP_VERSION_TOKEN=${revision:0:12}" --tag "$image" .
built=true
[[ $("$engine" image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "linux/amd64 $revision" ]]
network_id=$("$engine" network create --internal "$network")
db=$("$engine" run -d --network "$network" --network-alias db \
  -e POSTGRES_PASSWORD="$suffix" -e POSTGRES_DB=empty docker.io/library/postgres:16-alpine)
for ((i=0; i<60; i++)); do
  if "$engine" exec "$db" pg_isready -h 127.0.0.1 -U postgres >/dev/null; then break; fi
  sleep 1
done
"$engine" exec "$db" createdb -U postgres upgraded

export ENCRYPTION_KEY="isolated-test-$suffix"
environment=(--network "$network" -e "ENCRYPTION_KEY=$ENCRYPTION_KEY" -e "JWT_SECRET=test-session-$suffix"
  -e "CRON_SECRET=test-cron-$suffix" -e APP_URL=http://localhost:3000 -e HOSTNAME=0.0.0.0)
db_url() { printf 'postgresql://postgres:%s@db:5432/%s' "$suffix" "$1"; }

# Apply only the original migration to create a populated database from an older release.
"$engine" run --rm "${environment[@]}" -e DATABASE_URL="$(db_url upgraded)" "$image" sh -ec '
  for dir in prisma/migrations/*/; do
    case "$dir" in */20260531000000_init/) ;; *) mv "$dir" /tmp/ ;; esac
  done
  exec ../node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'
node ops/fork/seed-upgrade.mjs | "$engine" exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d upgraded

expected_count=$(find local/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l)
for database in empty upgraded; do
  app=$("$engine" run -d "${environment[@]}" -e DATABASE_URL="$(db_url "$database")" "$image")
  for ((i=0; i<150; i++)); do
    if "$engine" exec "$app" node -e 'fetch("http://127.0.0.1:3000/api/health/ready").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' 2>/dev/null; then break; fi
    if [[ $("$engine" inspect --format '{{.State.Running}}' "$app") != true ]]; then break; fi
    sleep 2
  done
  check_http() { "$engine" exec -i "$app" node --input-type=module - "$database" < ops/fork/check-app.mjs; }
  if ! check_http; then
    "$engine" logs --tail 60 "$app" >&2
    exit 1
  fi
  if [[ $database == upgraded ]]; then
    # Change one encrypted field in this disposable database to prove a
    # decryption regression fails the same HTTP check required of the PR.
    sql=("$engine" exec "$db" psql -XAt -v ON_ERROR_STOP=1 -U postgres -d upgraded)
    saved=$("${sql[@]}" -c "SELECT \"encryptedConfig\" FROM \"Subscription\" WHERE id='old-sub'")
    "${sql[@]}" -c "UPDATE \"Subscription\" SET \"encryptedConfig\"='invalid' WHERE id='old-sub'" >/dev/null
    if output=$(check_http 2>&1); then echo 'Corrupt subscription passed HTTP validation' >&2; exit 1; fi
    [[ $output == *'/api/subscriptions/old-sub'* ]]
    printf '%s\n' "UPDATE \"Subscription\" SET \"encryptedConfig\"=:'saved' WHERE id='old-sub';" |
      "$engine" exec -i "$db" psql -X -v ON_ERROR_STOP=1 -v "saved=$saved" -U postgres -d upgraded >/dev/null
    check_http
  fi
  count=$("$engine" exec "$db" psql -XAt -U postgres -d "$database" -c 'SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
  (( count == expected_count ))
  "$engine" rm -fv "$app" >/dev/null
  app=
  printf '%s: all %d migrations and HTTP checks passed\n' "$database" "$count"
done
