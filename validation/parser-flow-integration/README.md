# Synthetic parser flow integration

This opt-in runner verifies the current analyzer HTTP → PostgreSQL job → Redis/SSE path.
It is separate from Gradle, npm's default tests, Electron and the quarantined guardian tests.
It requires explicitly authorized local Docker/loopback access, already cached
`pgvector/pgvector:pg16` and `redis:7-alpine`, an existing JDK 21, the current backend dependency
JAR directory, and the analyzer's already installed locked dependencies. It never installs,
pulls, uploads, opens a browser, uses Keychain or mounts user data.

```sh
node validation/parser-flow-integration/prepare.mjs /absolute/jdk21/home /absolute/backend-dependency-jars
# Use the fresh root printed by prepare, exactly once:
node /private/tmp/ci-parser-flow-EXAMPLE/run.mjs /private/tmp/ci-parser-flow-EXAMPLE
```

`prepare.mjs` snapshots current source, compiles into a new directory, and binds inputs,
artifacts and dependency JARs with SHA-256. It invokes no build/install hooks or annotation
processors. `run.mjs` checks those hashes and claims the directory before starting anything.
Do not reuse old directories or delete `run.claim` to retry; prepare a new directory.

Services use per-run random labels, immutable container IDs, a dedicated bridge, loopback-only
published ports and memory-backed database storage without host mounts. The bridge is not an
egress security boundary. The runner's requests are limited to Docker's socket and loopback.
Cleanup checks ownership before stopping/removing containers and the network. Nest/Tomcat/Redis
close their owned handles. A Java timeout targets only its direct ChildProcess object; there
is no PID lookup, persisted PID, process enumeration, prune or name-pattern kill.

The test imports real production parsing/job/controller/exception/SSE classes but uses a
synthetic principal resolver, pre-inventoried workspace and cancellation latch. It does not
validate production authentication/CSRF/OAuth, import approvals, desktop IPC, secure storage,
the complete Spring Boot application, native packaging or installation. `integration.json`
counts assertions within one runner, not independent JUnit test cases.

Preserve `prepared.json` and `reports/` even on failure. `lifecycle.json` distinguishes assertion
failure from incomplete cleanup. An incomplete cleanup is a blocker: never guess a PID or
touch an unrelated service to make the test pass. Normal successful cleanup removes the
disposable connection settings; source and diagnostic evidence remain in the owned directory.

The 2026-10-03 result and its limits are in
[the audit report](../../docs/audit/parser-http-db-sse-2026-10-03.md).

The later user-reported `TS_PARSING` failure added a shared nullable Nest metadata fixture
and four assertions, for 18 checks in the current runner. See the
[follow-up result](../../docs/audit/ts-parsing-live-app-2026-10-03.md). The original 14-check
report is historical evidence; neither run validates the installed September 29 application.
