#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${NATIVE_ACCEPTANCE_CONSENT:-}" == disposable-hosted-os ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${JAVA_HOME:?}"
helper="$(cd "$(dirname "$0")" && pwd)/native-acceptance.cjs"
node -e 'require(process.argv[1]).requireHosted()' "$helper"
artifacts="$RUNNER_TEMP/native-acceptance-artifacts"
mkdir -p "$artifacts"
work="$(mktemp -d "$RUNNER_TEMP/native-compatible-runtime.XXXXXX")"
work="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$work")"
step=source-metadata
printf '{"phase":"native-runtime-provision","status":"RUNNING"}\n' > "$artifacts/provisioning.json"
on_exit() {
  code=$?
  if [[ "$code" != 0 ]]; then
    node - "$helper" "$work" "$step" "$code" "$artifacts/provisioning.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [helper, work, step, code, artifact] = process.argv.slice(2);
const log = path.join(work, 'build-output');
let text = '', logBytes = 0;
if (fs.existsSync(log)) {
  const fd = fs.openSync(log, 'r');
  try {
    logBytes = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(logBytes, 256 * 1024));
    fs.readSync(fd, bytes, 0, bytes.length, logBytes - bytes.length);
    text = bytes.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const sources = {};
for (const name of ['openssl', 'postgres', 'pgvector', 'redis']) {
  const file = path.join(work, name + '-source.json');
  if (!fs.existsSync(file)) continue;
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (/^[0-9]+(?:\.[0-9]+){1,3}$/.test(source.version) && /^[a-f0-9]{64}$/.test(source.sourceSha256))
    sources[name] = { version: source.version, sha256: source.sourceSha256 };
}
fs.writeFileSync(artifact, JSON.stringify({phase: 'native-runtime-provision', status: 'FAIL', step,
  exitCode: Number(code), logBytes, diagnosticsTruncated: logBytes > 256 * 1024, sources,
  diagnostics: require(helper).buildDiagnostics('', text)}, null, 2) + '\n');
NODE
  fi
  # Raw compiler text is private and never uploaded, even after a failed build.
  rm -f "$work/build-output"
  exit "$code"
}
trap on_exit EXIT
quiet() { "$@" > "$work/build-output" 2>&1; }
# Do not install bottles, invoke brew services, or change system prefixes. Homebrew
# verifies each upstream archive; independently bind its bytes to formula metadata.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
brew info --json=v2 openssl@3 postgresql@16 redis pgvector > "$work/formulae.json" 2> "$work/build-output"
for spec in 'openssl@3:openssl' 'postgresql@16:postgres' 'redis:redis' 'pgvector:pgvector'; do
  formula="${spec%%:*}"; name="${spec##*:}"
  step="fetch-$name"
  quiet brew fetch --build-from-source "$formula"
  archive="$(brew --cache --build-from-source "$formula")"
  node - "$work/formulae.json" "$formula" "$archive" "$work/$name-source.json" 2> "$work/build-output" <<'NODE'
const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const [metadata, name, archive, destination] = process.argv.slice(2);
const formula = JSON.parse(fs.readFileSync(metadata, 'utf8')).formulae.find(item => item.name === name);
assert.ok(formula); assert.match(formula.versions.stable, /^[0-9]+(?:\.[0-9]+){1,3}$/);
const sha256 = formula.urls.stable.checksum;
assert.match(sha256, /^[a-f0-9]{64}$/);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), sha256);
if (name === 'postgresql@16') assert.match(formula.versions.stable, /^16\./);
const url = new URL(formula.urls.stable.url);
assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
fs.writeFileSync(destination, JSON.stringify({formula: name, version: formula.versions.stable, sourceUrl: url.href, sourceSha256: sha256}));
NODE
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
step=native-dependency-closure
node - "$helper" "$prefix" > "$work/closure.json" 2> "$work/build-output" <<'NODE'
const helper = require(process.argv[2]); helper.requireHosted();
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
printf 'PG_CONFIG=%s\nREDIS_SERVER=%s\n' "$pg_config" "$redis" >> "$GITHUB_ENV"
node - "$work" "$artifacts/provisioning.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [work, artifact] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(work, name), 'utf8'));
fs.writeFileSync(artifact, JSON.stringify({phase: 'native-runtime-provision', status: 'PASS',
  minimumSystemVersion: '13.0', sourceBuilt: true,
  sources: ['openssl', 'postgres', 'redis', 'pgvector'].map(name => read(name + '-source.json')),
  closure: read('closure.json')}, null, 2) + '\n');
NODE
