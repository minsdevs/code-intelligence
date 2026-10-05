# Pre-release integration and release evidence

These runners execute explicit, bounded validation units. A passing unit is not a
release approval. Follow `docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md`
for all eight stages and external acceptance requirements.

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
