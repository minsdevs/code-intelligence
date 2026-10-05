# Pre-release integration and release evidence

These runners execute explicit, bounded validation units. A passing unit is not a
release approval. Follow `docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md`
for all eight stages and external acceptance requirements.

## Isolated Docker integration follow-up

The existing local Docker daemon must already be running. These commands do not
start/stop it, prune containers, reuse an application DB or use Docker auth settings.

```sh
node validation/pre-release/run-docker-integration.cjs --suite auth \
  --socket "unix://$HOME/.docker/run/docker.sock"
node validation/pre-release/run-docker-integration.cjs --suite backend \
  --socket "unix://$HOME/.docker/run/docker.sock"
node validation/pre-release/run-docker-integration.cjs --suite maintenance \
  --socket "unix://$HOME/.docker/run/docker.sock"
node validation/pre-release/run-docker-integration.cjs --suite accuracy \
  --socket "unix://$HOME/.docker/run/docker.sock"
node validation/pre-release/run-docker-integration.cjs --suite corpus \
  --socket "unix://$HOME/.docker/run/docker.sock"
```

Only the current user's Docker Desktop Unix socket or `/var/run/docker.sock` is
accepted. Test workers get a fresh home, data and short `.citd-*` temporary root;
all new files are retained under the original checkout. Gradle itself reuses the
existing user cache/configuration, so this is not a hermetic or OS-network-sandboxed
build. Testcontainers creates new PostgreSQL/Redis services and Ryuk cleans them;
the runner only observes preexisting container IDs/states and refuses success when
new containers remain. It never infers ownership from a numeric PID/container diff.

`maintenance` alone enables its reviewed opt-in class. `backend` preserves default
task exclusions and explicit opt-in skips. `accuracy` starts the actual local TS
sidecar; ordinary backend tests may use the fixture fake. `corpus` checks the existing
quality-baseline file and timed-Gradle RSS, not whole-app process-tree p95. Each command
has fresh reports/JUnit; failed results are not overwritten by a successful retry.

See `docs/audit/docker-integration-2026-10-06.md` for the initial failures, fixes,
raw-count caveat and remaining real-account/independent/OS acceptance requirements.
Tests for the new command ownership/environment contracts run with
`node --test validation/pre-release/test/docker-integration.test.cjs`.

## Nonzero cost / restore and owner-crash recovery

```sh
rtk proxy node validation/pre-release/run-cost-recovery.cjs \
  --app '<original-repository>/.native-product-<id>/Code Intelligence Validation.app' \
  --mode normal
rtk proxy node validation/pre-release/run-cost-recovery.cjs \
  --app '<original-repository>/.native-product-<id>/Code Intelligence Validation.app' \
  --mode crash
```

The runner validates the retained app inventory/signature, executes the **current
Node modules** against its unchanged PostgreSQL/Redis/Java/backend binaries, and
compares the specified source and bundle hashes afterward. It creates a new
repository-local `.cif-cost-*` or `.cif-resume-*` profile; no existing user profile or
database connection is accepted. Its HOME, temporary directory, libpq optional
client credentials and JDBC user.home are synthetic. The wrapping keys are fixture
keys, not OS Keychain entries; provider transport is a call-counting rejection stub.

`normal` verifies liabilities 100+73=173 through a real encrypted backup/restore,
then +29=202 through same-process post-health failure/rollback. `crash` kills only
the parent-created **Node owner ChildProcess**, once at STAGED and once after the
real B maintenance completion. The service guardians are not killed; their owner
pipe closure drives owned ProcessHandle shutdown. A new Node owner resumes the
same transaction, preserves 173, and verifies ordinary backend access only after
recovery. Numeric PID observations do not authorize signalling or ownership.

Failure cleanup must prove writer termination before source drain, runtime drain,
B/key close, and TLS cleanup. Failed startup keeps its original managed-process
handle. An unproved stop retains ownership and files. Old crash sockets are not
deleted or adopted: every source-broker lifetime gets a new name.

Reports/logs stay under `validation/local/pre-release-cost/`; synthetic profiles
are private, ignored, and preserved for inspection. Tests do not cover Electron
singleton/UI, actual Keychain, guardian SIGKILL, hostile daemonization, power loss,
all crash boundaries or real-account application. Do not enable the quarantined
guardian-kill test as a substitute for these owner-crash cases.

## GitHub credential-store commit/CAS integration

`node validation/pre-release/run-auth-store.cjs --app '<retained Validation.app>'`
creates a new private `auth-store-*` fixture beneath `validation/local/pre-release-auth`.
The supplied app only provides verified PostgreSQL binaries; its Electron UI is
not launched. The runner uses synthetic TLS/credentials and a unique database,
executes all V1–V27 migrations and the opt-in six-test JDBC transaction/CAS suite,
then verifies PostgreSQL termination and unchanged source/bundle hashes. It never
accepts a user DB URL or existing profile. This is not real GitHub authentication
or an end-to-end Spring/JPA account-connection test.

## Build a reviewed development candidate

```sh
node validation/pre-release/build-candidate.cjs \
  --app '<original-repository>/.native-product-<baseline>/Code Intelligence Validation.app' \
  --build-sequence '<positive-build-sequence-newer-than-baseline>'
```

This uses the original checkout's offline Gradle build and existing user Gradle
cache/configuration, not a hermetic build home. The frontend build uses a private
copy with no `.env` loading. Native/JRE/analyzer supply is reused only after the
baseline inventory/signature check. The current Java classes, migrations, new
static assets and packaged desktop sources are read back. A new app is created;
the baseline is not changed. This is an ad-hoc directory build, never a release,
Developer ID/notarized app, automatic update or existing-profile migration.

`run-product-candidate.cjs --app '<candidate>'` reuses the complete native product
runner on fresh synthetic sources/profiles. Use a clean child environment as in
the recorded validation: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
LANG=C LC_ALL=C node ...`. The runner uses mock Keychain at process creation and
owns each launched ChildProcess. Its representative-source counts/timings are
single-input observations, not an accuracy score or20-run whole-process benchmark.

`run-integrity-diagnostic.cjs --app '<candidate>'` observes bounded read-only
runtime-inventory failures inside one fresh Electron process. It never changes
validator outcomes, runtime bytes or manifest hashes.20 validations in one process
are not20 application restarts or proof that an older intermittent failure is fixed.

## Component inventory and advisory coverage

```sh
node validation/pre-release/inventory-candidate.cjs --offline \
  --app '<absolute-candidate.app>' --output inventory-candidate.json
(cd backend && ./gradlew --offline --no-daemon \
  -I ../validation/pre-release/runtime-inventory.init.gradle \
  candidateRuntimeInventory -PcandidateInventoryOutput=runtime-resolved.json)
node validation/pre-release/scan-candidate-advisories.cjs --online-public-packages \
  --inventory inventory-candidate.json --output advisory-candidate.json \
  --resolved-maven runtime-resolved.json
```

All JSON basenames resolve to new files in `validation/local/pre-release-final`.
The first two commands do not query advisory providers. Static ZIP/ASAR metadata
is bounded and never extracted/executed. Unsupported nested metadata remains
hash-only/NOASSERTION; no permissive parser fallback is used.

The final command explicitly sends dependency names/versions to npm's public
registry or Maven Central for anonymous publication checks, then sends confirmed
coordinates to OSV. Root application packages and declared-private packages are
excluded. A registry request necessarily discloses the proposed coordinate even
if it is not found, so do not use this as a private-package discovery tool. No raw
source, paths, keys, JAR bytes or inventory hashes are sent. When a resolved Maven
list is supplied, both filename and SHA-256 must match; a mismatch never falls back
to POM declarations. Unknown/ambiguous coordinates remain omissions.

A supplied `--resolved-maven` document must have the expected object shape. JSON
`null`, booleans, numbers, arrays and malformed component lists are rejected before
opening an output report or querying a registry. Only omitting the option selects
the explicitly labelled legacy POM-metadata mode; a valid empty resolved list does
not authorize POM fallback either.

The result reports the query time, coordinate/publication checks, omissions and
coverage limits. `NO_MATCHES_IN_QUERIED_COORDINATES` is not a whole-product safety
approval. Runtime/JRE/Electron/Chromium/native supply, bundled browser transitives,
reachability, full dependency graph and redistribution obligations require separate
review. Preserve older matched/failed scans; do not overwrite them with a later0.

## Quality measurement boundaries

`quality-gate` needs a running Docker daemon for its database corpus and fails
before claiming a result when unavailable. Both Gradle invocations are offline.
`quality-metrics.cjs` rejects absent, ambiguous or zero RSS rather than substituting
zero, normalizes macOS bytes versus Linux KiB and preserves the command's failure.
The small native `/usr/bin/time` test exercises measurement parsing only; neither
that test nor a timed Gradle peak is whole-application process-tree RSS acceptance.
