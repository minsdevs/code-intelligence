#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${NATIVE_ACCEPTANCE_CONSENT:-}" == disposable-hosted-os ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${JAVA_HOME:?}"
mkdir -p "$RUNNER_TEMP/native-acceptance-artifacts"
printf '{"phase":"native-runtime-provision","status":"RUNNING"}\n' > "$RUNNER_TEMP/native-acceptance-artifacts/provisioning.json"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "{\"phase\":\"native-runtime-provision\",\"status\":\"FAIL\"}\n" > "$RUNNER_TEMP/native-acceptance-artifacts/provisioning.json"; fi' EXIT
# No launchctl/brew services, global trust changes, or installed application writes.
brew install postgresql@16 redis
brew fetch --build-from-source pgvector
pg_config="$(brew --prefix postgresql@16)/bin/pg_config"
redis="$(brew --prefix redis)/bin/redis-server"
"$JAVA_HOME/bin/java" -version 2>&1 | tee "$RUNNER_TEMP/native-acceptance-artifacts/java-version.txt"
"$pg_config" --version | tee "$RUNNER_TEMP/native-acceptance-artifacts/postgres-version.txt"
"$redis" --version | tee "$RUNNER_TEMP/native-acceptance-artifacts/redis-version.txt"
"$JAVA_HOME/bin/java" -version 2>&1 | grep -E 'version "21\.'
"$pg_config" --version | grep -E '^PostgreSQL 16\.'
"$redis" --version | grep -E 'v=(7|8|9)\.'
# Homebrew verifies the formula source SHA256 before this cache path is used.
# Build against the selected PG16 headers rather than a bottle for another major.
vector_source="$(brew --cache --build-from-source pgvector)"
vector_work="$(mktemp -d "$RUNNER_TEMP/native-pgvector.XXXXXX")"
mkdir "$vector_work/source" "$vector_work/install" "$vector_work/overlay"
tar -xf "$vector_source" --strip-components=1 -C "$vector_work/source"
make -C "$vector_work/source" PG_CONFIG="$pg_config" -j2
make -C "$vector_work/source" PG_CONFIG="$pg_config" DESTDIR="$vector_work/install" install
mkdir -p "$vector_work/overlay/lib/postgresql" "$vector_work/overlay/share/postgresql/extension"
cp "$vector_work/install$("$pg_config" --pkglibdir)/vector.dylib" "$vector_work/overlay/lib/postgresql/"
cp "$vector_work/install$("$pg_config" --sharedir)/extension/"vector* "$vector_work/overlay/share/postgresql/extension/"
# Only public tool version metadata is published, not formula/download credentials.
cat "$vector_work/overlay/share/postgresql/extension/vector.control" > "$RUNNER_TEMP/native-acceptance-artifacts/pgvector-control.txt"
printf 'PG_CONFIG=%s\nREDIS_SERVER=%s\nPGVECTOR_ROOT=%s\n' "$pg_config" "$redis" "$vector_work/overlay" >> "$GITHUB_ENV"
printf '{"phase":"native-runtime-provision","status":"PASS"}\n' > "$RUNNER_TEMP/native-acceptance-artifacts/provisioning.json"
