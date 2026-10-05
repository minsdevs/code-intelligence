#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
: "${JAVA_HOME:?}"
helper="$(cd "$(dirname "$0")" && pwd)/native-acceptance.cjs"
context_helper="$(dirname "$helper")/native-acceptance-context.cjs"
source_helper="$(dirname "$helper")/macos-runtime-supply.cjs"
temp_root="$(node - "$context_helper" "$source_helper" <<'NODE'
const helper = require(process.argv[2]);
const context = helper.requireExecutionContext();
if (context.kind === 'github-hosted' && !require('node:path').isAbsolute(process.env.GITHUB_ENV || '')) throw new Error('GITHUB_ENV_REQUIRED');
require(process.argv[3]).requireCapacity(context.tempRoot);
helper.claimExecution(context, 'provision'); helper.prepareArtifacts(context);
console.log(context.tempRoot);
NODE
)"
artifacts="$temp_root/native-acceptance-artifacts"
work="$(mktemp -d "$temp_root/native-compatible-runtime.XXXXXX")"
work="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$work")"
step=source-metadata
node - "$context_helper" "$artifacts/provisioning.json" <<'NODE'
const helper = require(process.argv[2]);
require('node:fs').writeFileSync(process.argv[3], JSON.stringify({ phase: 'native-runtime-provision',
  status: 'RUNNING', executionContext: helper.requireExecutionContext().evidence }) + '\n', { mode: 0o600 });
NODE
on_exit() {
  code=$?
  if [[ "$code" != 0 ]]; then
    node - "$helper" "$work" "$step" "$code" "$artifacts/provisioning.json" <<'NODE'
const [helper, work, step, exitCode, artifact] = process.argv.slice(2);
require(helper).recordProvisioningFailure({ work, step, exitCode, artifact });
NODE
  fi
  # Raw compiler text is private and never uploaded, even after a failed build.
  rm -f "$work/build-output"
  exit "$code"
}
trap on_exit EXIT
quiet() { "$@" > "$work/build-output" 2>&1; }
# Locked upstream archives are verified before extraction. No Homebrew cache,
# formula update, bottle installation or system prefix is used for source supply.
for name in openssl postgres redis pgvector; do
  step="fetch-$name"
  archive="$(node "$source_helper" --fetch "$name" "$work" 2> "$work/build-output")"
  mkdir "$work/$name-source"
  quiet tar -xf "$archive" --strip-components=1 -C "$work/$name-source"
done
# Keep compiler/tool discovery away from Homebrew's optional dylibs. PostgreSQL
# uses system zlib, no ICU/readline/LDAP/GSSAPI, and our private OpenSSL only.
export MACOSX_DEPLOYMENT_TARGET=13.0
export CC=/usr/bin/clang CXX=/usr/bin/clang++
export CFLAGS='-O2 -mmacosx-version-min=13.0' CXXFLAGS='-O2 -mmacosx-version-min=13.0'
export LDFLAGS='-mmacosx-version-min=13.0 -Wl,-headerpad_max_install_names'
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH PKG_CONFIG_PATH CPPFLAGS
export PKG_CONFIG_LIBDIR="$work/empty-pkgconfig"
mkdir "$PKG_CONFIG_LIBDIR"
prefix="$work/prefix"
mkdir "$prefix"
step=openssl-configure
cd "$work/openssl-source"
quiet /usr/bin/perl ./Configure darwin64-arm64-cc --prefix="$prefix/openssl" --openssldir="$prefix/openssl/ssl" --libdir=lib shared no-tests no-module
step=openssl-build
quiet /usr/bin/make -j2
quiet /usr/bin/make install_sw
step=postgres-configure
cd "$work/postgres-source"
quiet ./configure --prefix="$prefix/postgres" --with-openssl --without-icu --without-readline --without-ldap --without-gssapi \
  --with-includes="$prefix/openssl/include" --with-libraries="$prefix/openssl/lib"
step=postgres-build
quiet /usr/bin/make -j2
quiet /usr/bin/make install
quiet /usr/bin/make -C contrib/pg_trgm -j2
quiet /usr/bin/make -C contrib/pg_trgm install
pg_config="$prefix/postgres/bin/pg_config"
step=pgvector-build
quiet /usr/bin/make -C "$work/pgvector-source" PG_CONFIG="$pg_config" OPTFLAGS= -j2
quiet /usr/bin/make -C "$work/pgvector-source" PG_CONFIG="$pg_config" install
step=redis-build
# Build the shipped target, not upstream all: all also links test modules using
# raw Darwin ld, which cannot accept our compiler-driver deployment/header flags.
quiet /usr/bin/make -C "$work/redis-source/src" -j2 redis-server BUILD_TLS=yes MALLOC=libc \
  USE_SYSTEMD=no WITH_SYSTEMD=no OPENSSL_PREFIX="$prefix/openssl" \
  REDIS_CFLAGS="$CFLAGS" REDIS_LDFLAGS="$LDFLAGS"
# Only the Redis server is shipped; no system install or background service.
mkdir -p "$prefix/redis/bin"
cp "$work/redis-source/src/redis-server" "$prefix/redis/bin/redis-server"
redis="$prefix/redis/bin/redis-server"
step=source-notices
notices="$("$pg_config" --sharedir)/code-intelligence-notices"
mkdir "$notices"
node - "$source_helper" "$work" "$notices" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [helper, work, notices] = process.argv.slice(2);
const supply = require(path.join(path.dirname(helper), 'macos-runtime-supply.json'));
require(helper).validateSupply(supply);
for (const item of supply.sources) {
  fs.copyFileSync(path.join(work, item.id + '-source', item.licenseFile),
    path.join(notices, item.id + '-' + item.version + '-' + item.licenseFile), fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(path.dirname(helper), 'macos-runtime-supply.json'),
  path.join(notices, 'source-lock.json'), fs.constants.COPYFILE_EXCL);
NODE
step=native-dependency-closure
node - "$helper" "$prefix" "$context_helper" > "$work/closure.json" 2> "$work/build-output" <<'NODE'
const helper = require(process.argv[2]); require(process.argv[4]).requireExecutionContext();
console.log(JSON.stringify(helper.relocateMacLibraries(process.argv[3])));
NODE
step=runtime-versions
"$JAVA_HOME/bin/java" -version 2>&1 | tee "$artifacts/java-version.txt"
"$pg_config" --version | tee "$artifacts/postgres-version.txt"
"$redis" --version | tee "$artifacts/redis-version.txt"
"$JAVA_HOME/bin/java" -version 2>&1 | grep -E 'version "21\.'
"$pg_config" --version | grep -E '^PostgreSQL 16\.'
"$redis" --version | grep -E 'v=(7|8|9)\.'
cat "$("$pg_config" --sharedir)/extension/vector.control" > "$artifacts/pgvector-control.txt"
node - "$context_helper" "$pg_config" "$redis" <<'NODE'
const helper = require(process.argv[2]), context = helper.requireExecutionContext();
helper.writeRuntimeEnvironment(context, { PG_CONFIG: process.argv[3], REDIS_SERVER: process.argv[4],
  CODE_INTELLIGENCE_BUILD_SEQUENCE: context.buildSequence });
NODE
node - "$work" "$artifacts/provisioning.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [work, artifact] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(work, name), 'utf8'));
fs.writeFileSync(artifact, JSON.stringify({phase: 'native-runtime-provision', status: 'PASS',
  executionContext: JSON.parse(fs.readFileSync(artifact, 'utf8')).executionContext,
  minimumSystemVersion: '13.0', sourceBuilt: true,
  sources: ['openssl', 'postgres', 'redis', 'pgvector'].map(name => read(name + '-source.json')),
  closure: read('closure.json')}, null, 2) + '\n');
NODE
