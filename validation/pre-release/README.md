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
node validation/pre-release/run-docker-integration.cjs --suite events \
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
task exclusions and explicit opt-in skips. `events` selects the SSE subscription
and lifecycle tests: real Spring emitters/MVC framing with synthetic job/Redis
inputs, no application DB. `accuracy` starts the actual local TS
sidecar; ordinary backend tests may use the fixture fake. `corpus` checks the existing
quality-baseline file and timed-Gradle RSS, not whole-app process-tree p95. Each command
has fresh reports/JUnit; failed results are not overwritten by a successful retry.

See `docs/audit/docker-integration-2026-10-06.md` for the initial failures, fixes,
raw-count caveat and remaining real-account/independent/OS acceptance requirements.
Tests for the new command ownership/environment contracts run with
`node --test validation/pre-release/test/docker-integration.test.cjs`.

## Frontend source regression tests

```sh
node frontend/node_modules/vitest/vitest.mjs run \
  --config validation/pre-release/frontend-regression.config.mjs
```

This selects every frontend `src/**/*.{test,spec}.{ts,tsx}` test using the shared
DOM configuration, without the application's Vite config, `.env` loading, dev
proxy or entry point. Fetch and XMLHttpRequest need test doubles; the shared
setup rejects an unstubbed call. It is not an OS network sandbox or a real browser
acceptance run. Type checking and lint remain separate required commands.

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
cache/configuration, not a hermetic build home. Frontend and TypeScript analyzer
code use private source/dependency copies with no `.env` loading. The analyzer is
now recompiled; its staged dist is replaced as an exact file set and read back
against the updated runtime manifest. Native/JRE and installed analyzer dependencies
are reused only after baseline inventory/signature and analyzer package/lock
compatibility checks. Current Java classes, migrations, static assets, analyzer
outputs and packaged desktop sources are read back. When the analyzer package or
lock changes, a fresh private production tree is installed from the prefilled
`validation/local/pre-release-cache/npm` cache with offline, ignore-scripts,
omit-dev and no-bin-links options. Empty private npm configurations avoid inherited
credentials. Its package/lock identities and complete regular-file inventory are
checked before replacing the staged analyzer; the old staged tree is preserved.
A failed second rename attempts rollback only while the original parent and old
tree identities match and the destination is absent. It never overwrites a new
destination, and the original failure remains primary. A new app is created;
the baseline is not changed. This is an ad-hoc directory build, never a release,
Developer ID/notarized app, automatic update or existing-profile migration.

The verified-runtime reuse builder now has a separate space policy from full
native provisioning. Full provisioning retains its 8GiB floor. Candidate reuse
measures the actual logical dependency/source/runtime/Electron copy sizes, adds
production-install, Java/static/temp and generated-output allowances plus 2GiB
headroom, and rounds upward to 64MiB. The complete calculation and measured
fingerprints are recorded in the build report; source and dependency copies must
match those fingerprints. At completion, at least 2GiB must still be available.
This is a planning allowance, not reserved disk space, a physical-allocation
prediction or a hard write bound. It can exceed 8GiB for larger inputs. Earlier
candidate reports retain the old fixed-floor decision. Startup, RSS, integrity
and release-acceptance limits are unchanged by this build-policy revision.

`run-product-candidate.cjs --app '<candidate>'` reuses the complete native product
runner on fresh synthetic sources/profiles. Use a clean child environment as in
the recorded validation: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
LANG=C LC_ALL=C node ...`. The runner uses mock Keychain at process creation and
owns each launched ChildProcess. Its representative-source counts/timings are
single-input observations, not an accuracy score or20-run whole-process benchmark.
The current runner imports synthetic React default-export/alias, parameter-shadow
and conflicting package-entry cases through the actual UI, checks exact graph API
targets and retained snapshot source, then verifies the graph after restart.
Older reports cannot be counted as having executed newer assertions. The latest
source/candidate association is in
`docs/audit/pre-release-continuation-2026-10-06.md` and its companion JSON.

The current native driver requires version1 shutdown diagnostics from the app.
After SDK close and natural direct-child exit0, it drains stderr for at most one
second and requires COMPLETE without an earlier FAILED record. SDK failures keep
priority; a reported cleanup failure, incomplete diagnostics, and a pipe-drain
timeout have separate fixed codes. At most32 phase/timing entries per launch are
saved, never raw stderr. Markerless older candidates are unconfirmed under this
driver; their original dated results retain the older driver's scope.

Adding the exact `--analysis-only` option runs only the representative import/
flow/source and React binding scenarios with their restarts. Reports explicitly
list omitted backup/restore, safeStorage roundtrip and delete-persistence suites.
The default command remains the full sequence. The qUMAST analysis-only PASS is
not a replacement for its two retained broad-sequence failures; their causes are
still unconfirmed. A later qUMAST full sequence passed35 checks, separately recorded.
The omission list additionally names initial synthetic import/reanalysis,
historical/current snapshot contracts and the post-restore/delete transition.
The final package-entry guard and job-completion/shutdown changes are included
in j5EJLB, whose own results are recorded separately. Do not advertise analysis-only
mode or an older candidate as full acceptance of newer source changes.

Native step failures keep their fixed `code` and add `errorName` plus a fixed
`signal` (renderer context destroyed, target closed, network, JSON, timeout or
`null`); raw automation messages, paths and page data are still never saved.

Since `cf1f0e0` the startup markers mean: `CACHE_AND_ANALYZER` covers spawning
Redis and the analyzer, and `BACKEND_HEALTH` covers the overlapping readiness of
Redis, the analyzer and the backend. Compare phase durations across that commit
only with this change in mind; total ready time is unaffected by the relabelling.

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

### Warm startup and idle owner-tree RSS

```sh
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node validation/pre-release/run-startup-benchmark.cjs \
  --app '<original-repository>/.native-product-<candidate>/Code Intelligence Validation.app' \
  --warm-startup-20
```

This initializes one fresh private automation profile and then performs20 normal
restarts of that same initialized empty profile. Mock Keychain is explicit; no
existing profile or account is accepted. The initial launch is recorded separately
and is not called a cold-cache benchmark. OS caches are not flushed.

Each measured start waits for the actual home screen and four ready services,
records a three-second idle window and confirms COMPLETE/natural exit0 before
the next start. A PID/PPID-only topology query selects the captured owner's tree;
RSS is then requested only for those numeric PIDs at a 100ms target interval.
No numeric PID grants signal authority. The two queries are not atomic, and new
children between them may be absent from that sample. The initial interval before
SDK child capture is unsampled; the report records it and the actual largest gap,
including the tail from the last sample to stop. Phase is fixed before a read,
so an overlapping startup read cannot be counted as idle. Raw per-process
samples are local CSV, bounded to64MiB for the entire series and2,000 observations
per launch. This is sampled RSS, not a continuous or private-memory measurement.

The fixed assessment requires20 complete measured samples, p95 warm ready≤10s,
every sampled idle peak≤1,572,864KiB and confirmed AC power. The implementation additionally
requires at least20 idle observations and no interval above250ms. Any failed
launch, sampling or cleanup stops the series; remaining rows stay NOT_RUN and
the p95 is not recomputed from only successful runs. SLO failure preserves the
measured values. Battery/unknown power is recorded and cannot certify the AC-power
acceptance condition. AC is observed at the series start and both boundaries of
every run, not continuously between them. Other workload sizes, cold cache, user tasks and the full
performance/release gates are not certified by this command.

`quality-gate` needs a running Docker daemon for its database corpus and fails
before claiming a result when unavailable. Both Gradle invocations are offline.
`quality-metrics.cjs` rejects absent, ambiguous or zero RSS rather than substituting
zero, normalizes macOS bytes versus Linux KiB and preserves the command's failure.
The small native `/usr/bin/time` test exercises measurement parsing only; neither
that test nor a timed Gradle peak is whole-application process-tree RSS acceptance.

## Physical metadata and standalone control runtime

The current candidate and hashes are recorded in
[`startup-resource-follow-up-2026-10-06.md`](../../docs/audit/startup-resource-follow-up-2026-10-06.md).
The optional manifest `controlProtocol: 1` requires both the hashed small control
JAR and its provenance, and requires non-Windows guarded ownership. Legacy bundles
without this marker retain their earlier helper entrypoint. The backend service
and backup-source worker still use the full application JAR.

The offline builder now awaits `verifyControlSourceMembers` before staging and
again after packaging. It includes the existing bounded ZIP, compiled-class,
manifest and dependency checks, then compares every ordinary shaded file and
relocated license with the three exact, hash-bound dependency archives inside
the compiled backend JAR. Missing, additional, renamed, conflicting or changed
members are rejected. No archive is extracted and no cache or registry is queried.
The packaged backend is connected to that compiled input by the existing
non-static-entry readback and candidate JAR hash. The generated manifest is
validated separately; empty directory entries are not source-file comparisons.
This does not establish a complete product SBOM, upstream trust or all license
obligations. Older build reports retain their narrower verification scope.
Existing staged control files are preserved before replacement; the baseline app
is never edited. The source-member regression suite is
`node --test validation/pre-release/test/control-source-members.test.cjs`.

Runtime inventory checks use Electron's `original-fs` native promise APIs for the
physical unpacked runtime tree. This avoids a callback-stat reentry mechanism
reproduced with unchanged synthetic files; no retry or integrity exception is
introduced. Node tests retain injectable filesystem failures in both runtime
modes. The read-only diagnostic runner temporarily observes both promise
namespaces, records bounded fixed metadata only and restores its wrappers.

## Journal replay work and native lease costs

```sh
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node validation/pre-release/run-journal-replay-probe.cjs \
  --app '<original-repository>/.native-product-<candidate>/Code Intelligence Validation.app' \
  --journal-replay-probe
```

This new diagnostic uses the current Node journal/keyring modules and a verified
retained candidate's control JAR/JRE. It creates three fresh synthetic histories
of 1, 65 and 257 records through public journal operations, keeps AI OFF and
reopens each history once. The timed open includes journal lease acquisition,
latch authentication, replay and the appended restart latch. Key API durations
include keyring checks; nested wrapper timings must not be added to them.

The branded native owner-lock provider and its actual ChildProcesses are retained.
Only protocol operation counts and aggregate key API timings are observed; no
key bytes, protocol arguments, journal records or error messages are reported.
Each JVM uses a new synthetic HOME, temporary directory and working directory.
Journal and keyring closure must complete before provider closure, and actual
helper close events are required. A cleanup failure remains FAIL; no observed
numeric PID authorizes signalling. Synthetic files are private and retained under
`validation/local/journal-replay/`.

This is not an Electron launch, application-database test, actual Keychain test,
pure replay CPU measurement or whole-app performance acceptance. It uses only
zero-liability USER_OFF records. The fixture's owner-directory checks add harness
overhead, and one observation per size is not a p95 benchmark. The candidate is
unchanged, no new app is built, and existing release SLOs remain separate.

Since `d9d74cd` replay verifies each key id before its first use and again after
the last record, so the runner expects history-independent counts: six MAC-key
fetches, eight wrapper availability checks and sixteen keyring lease CHECKs per
open. Earlier reports retain their `N+4`/`N+6`/`2(N+6)` counts and runner hashes.
