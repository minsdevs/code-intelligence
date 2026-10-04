**Languages:** English | [한국어](README.ko.md)

# Code Intelligence

Current audit: [2026-10-02 release assessment](docs/release-audit-2026-10-02.md).
Follow-up implementation and verification: [integrated results](docs/audit/execution-results-2026-10-02.md),
[current execution status](docs/audit/execution-status-2026-10-02.md), and
[independent review findings](docs/audit/execution-review-2026-10-02.md).
The production release verdict is **No-Go**; the historical RC records below are not current acceptance evidence.
The [current restart/release audit](docs/audit/restart-recovery-audit-2026-10-03.md) covers
authenticated transaction recovery, retained-source reconstruction, capacity/retention,
process ownership and native/analyzer fixes, including historical recovery observations and their evidence limits.
The unsafe PID-based guardian test remains quarantined.
Final commands, test counts, scope limits and source hashes are in the [validation record](docs/audit/restart-recovery-validation-2026-10-03.json).
Compatible standalone runtimes, operational OAuth, source-consumer migration, OS isolation,
signed installation and representative accuracy acceptance remain release blockers.
The [latest synthetic HTTP→DB→SSE verification](docs/audit/parser-http-db-sse-2026-10-03.md)
passed 14 checks and exposed a top-level function call gap, now fixed with 165 analyzer tests passing.
[Windows preparation](docs/audit/windows-readiness-2026-10-03.md) adds path/environment handling and
gated x64 NSIS configuration. Windows native storage/runtime and installation remain blocked and unverified.
The earlier [backup/restore](docs/audit/backup-restore-integration-2026-10-03.md) and
[cost integration](docs/audit/strict-ai-cost-integration-2026-10-03.md) records are preserved.

A personal workspace that analyzes an entire GitHub repository, automatically
discovers the technical areas that make up the project (Backend, Frontend,
Database, Infrastructure, DevOps, Security, Testing, AI, …), and lets you
explore its features, architecture, call flows, dependencies, history, design
rationale, and alternatives — with an evidence-grounded, context-aware AI
assistant.

> **Historical RC record / internal testing.**
> Phase 1–5 functionality is present, and the current RC adds local-folder
> import, confirmed local refresh, snapshot comparison, finding judgments, coverage,
> Markdown/JSON export, IDE deep links, AI context preview/exclusion, and a
> quality regression gate. These RC changes are staged on
> `rc/feature-freeze-20260824`; they are not described here as released on
> `main`. See [ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md) for the
> implementation and validation record.
>
> **Release remains blocked** on the real browser 10-step E2E and an approved
> accuracy/false-positive oracle for representative repositories. Desktop
> backup/restore was implemented for the local macOS runtime and is now blocked pending safe replacement; roadmap P2
> incremental reanalysis is not implemented.

This repository currently ships a browser-based local workspace with a Spring
Boot backend and optional analyzer sidecars, plus an Electron desktop runtime
under `desktop/`. The desktop path is a local macOS arm64 RC surface: it stages
the backend, analyzer, JRE, PostgreSQL, and Redis, keeps runtime credentials in
OS-protected storage, and exposes only the allowlisted renderer bridge. It is
not a signed/notarized production distribution or an auto-update channel.

## Principles

1. **Deterministic first** — structure, relationships, and history are
   extracted by static analysis (AST parsers, JGit, config parsers). The AI
   only interprets and explains; it never invents facts.
2. **Evidence-based** — every AI claim links to real source locations,
   commits, or PRs, and carries a confidence level
   (`Confirmed / Likely / Possible / Unknown`).
3. **Area-neutral** — the whole repository is analyzed first; you choose
   which areas (Backend / Frontend / Database / …) to explore.

## Stack

| Part | Tech |
|---|---|
| Backend | Java 21, Spring Boot, Spring Security, JPA, Flyway, JGit, JavaParser |
| Data | PostgreSQL 16 + pgvector, Redis 7 |
| Frontend | React 19, TypeScript (strict), Vite, Tailwind CSS v4, TanStack Query, Zustand, React Flow |
| Analyzer sidecar (Phase 2) | NestJS, ts-morph (TypeScript Compiler API), tree-sitter |
| AI (Phase 3) | Provider-abstracted (OpenAI / Gemini), pgvector embeddings, evidence-grounded assistant |
| Learning (Phase 4) | Notes with code refs, tasks + AI DRAFT approval, FTS/`pg_trgm`/vector hybrid search |
| Advanced (Phase 5) | PR review (static findings + AI), playground (no clone execution), growth reports, static what-if |

## Getting started

Prerequisites: Docker with `docker compose`, Node.js 24, and JDK 21 or newer.
Docker must be running for PostgreSQL, Redis, Testcontainers-backed backend
checks, and `./quality-gate`. Gradle uses the Java 21 toolchain.

### Recommended local path

```bash
cp .env.example .env
# Generate a value and set TOKEN_ENC_KEY in .env:
openssl rand -base64 32

./check-local   # checks env, Docker/Compose, Java, Node, and local ports
./start-local   # PostgreSQL + Redis, backend, frontend; optional analyzers when configured
# Open http://localhost:5173
./stop-local
```

For the local macOS desktop runtime, use a staged bundle after the browser
checks pass. The release owner must first export `CODE_INTELLIGENCE_BUILD_SEQUENCE` as an
assigned nonnegative signed64 decimal string. Staging refuses a missing or invalid value
before building or replacing files; the value alone is not signed antirollback proof.

```bash
(cd desktop && npm ci && npm run stage && npm start)
```

`desktop/scripts/stage-runtime.mjs` currently verifies macOS arm64, builds the
frontend/analyzer/backend, and requires local PostgreSQL with pgvector and
Redis binaries. `pack:mac` creates a local directory package; signing,
notarization, fresh-machine install, and real OAuth remain release blockers.
Staging checks Java 21, arm64, macOS 13.0 deployment targets, required executable/extension
roles and self-contained library references before publication. Compatible dependency artifacts
are required; existing host Homebrew builds may fail these checks.
When the host `pgvector` bottle targets a different PostgreSQL major, set
`PGVECTOR_ROOT` to a matching build root containing `lib/postgresql` and
`share/postgresql/extension` before staging; the previous stage is replaced after the new manifest is
complete. The previous stage is retained; an interrupted transaction leaves a lock/recovery
marker for inspection. Synthetic crash-path tests do not certify signed update recovery.

For isolated desktop validation, prepare a **new** private parent directory and a
separate runtime directory, then run this preparation-only command with canonical
absolute paths (on macOS, resolve `/tmp` and `/var` aliases first):

```bash
node desktop/scripts/prepare-isolated-run.cjs \
  --isolated-run-parent "$ISOLATED_PARENT" \
  --isolated-runtime-root "$ISOLATED_RUNTIME"
```

The parent must be owned by the current user with mode `0700`; the runtime directory
must be owned by that user and must not be group/world-writable. Preparation creates
fresh private userData, sessionData, logs, temporary, crash, home and output paths.
It rejects symlinks, claimed run reuse and overlap with this checkout's stage/dist
and the conventional app-data location. It does not inspect runtime contents,
build a bundle, change staging outputs, start services or access credentials.
Success reports `PREPARED_BLOCKED` and `launchAllowed: false`; the JSON is diagnostic
and cannot resume or authorize a run. Existing runs are never reused or removed.

Electron recognizes the same flags before its single-instance lock, also checks its
actual userData/sessionData and packaged resources, and exits before initialization.
Launch remains blocked by `CREDENTIAL_STORE_UNVERIFIED` and
`SERVICE_ENDPOINT_OWNERSHIP_UNPROVEN`: changing paths does not isolate the macOS
Keychain, and a free port or health response does not prove service ownership.
There is no environment-variable bypass. These filesystem checks are not an OS
sandbox against concurrent changes by the same user. Native Windows validation is
pending; this POSIX preparation path refuses Windows. Full desktop flow validation
still requires a separately approved credential-store boundary and authenticated
connections to owned services.

Independent code builds use a clean committed source snapshot and their own writable
work copy, dependency copies, HOME, temporary directories and caches:

```bash
node desktop/scripts/build-isolated.cjs \
  --source-root "$SOURCE_CHECKOUT" --build-parent "$ISOLATED_BUILD_PARENT"
# Include the backend using explicitly selected existing JDK 21 and Gradle inputs:
node desktop/scripts/build-isolated.cjs \
  --source-root "$SOURCE_CHECKOUT" --build-parent "$ISOLATED_BUILD_PARENT" \
  --java-home "$JDK21_HOME" --gradle-distribution "$GRADLE_DISTRIBUTION" \
  --gradle-modules-cache "$GRADLE_MODULES_CACHE"
```

The parent must be an existing canonical private `0700` directory outside the source
checkout and app-data roots. Every invocation creates a new claimed run; failed runs
are retained. Only allowlisted files from a clean tracked Git HEAD enter the source
snapshot; local `.env`, npm configuration, untracked files and prior build outputs
are excluded. Installed node dependencies are copied with bounded reads, internal
relative links only, and byte checks; they are never linked back to the original.
This reuses local dependencies without proving their lockfile provenance or supply-chain
integrity. Build commands receive a fixed tool PATH and explicit private environment.

The default command compiles frontend/analyzer code and creates a **desktop source
ASAR**, with byte-verified readback. The three optional backend inputs are required
together: an existing JDK 21, the distribution matching the committed Gradle wrapper,
and its `modules-2` cache directory. Gradle uses private copies, excludes lock files
and user initialization/configuration, and runs offline without automatic toolchain
downloads. JAR frontend assets and migrations are verified in a separate Node process.
The commands retain JSON results and logs under the new run's output directory. They
do not stage a native runtime, produce an installable application, start services,
access OS credential storage, sign, notarize or publish. Offline dependency resolution
and path checks are not an OS network/process sandbox. Native packaging and desktop
acceptance remain required before release; Windows execution is unverified.

The analyzer also supports an explicitly configured authenticated HTTPS connection.
On the analyzer, set all of `TS_ANALYZER_TLS_CERT_FILE`, `TS_ANALYZER_TLS_KEY_FILE`
and `TS_ANALYZER_AUTH_TOKEN`. The certificate/key must be canonical absolute paths
to owned regular files; the private key must have no group/other permissions. Bind
`TS_ANALYZER_HOST` to `127.0.0.1` or `::1`. On the backend, set
`TS_ANALYZER_BASE_URL` to that HTTPS loopback origin with its explicit port,
`TS_ANALYZER_TLS_CERT_SHA256` to the SHA-256 fingerprint of the DER leaf certificate,
and the same `TS_ANALYZER_AUTH_TOKEN` (64 hexadecimal characters).

The backend checks the exact certificate, validity and IP subject alternative name
before sending the caller token or source; it does not use a proxy, follow redirects
or fall back to HTTP. The analyzer authenticates before parsing request JSON.
Incomplete TLS configuration is rejected, including HTTPS without a pin. Development
HTTP remains available for the browser development profile when no TLS settings are
supplied. Electron startup now generates separate launch-scoped loopback certificates
for PostgreSQL, Redis, the analyzer and the backend in an owned private directory;
it never changes the system trust store. PostgreSQL requires SCRAM over verify-full TLS,
Redis requires a launch password over TLS, and analyzer/backend requests require the
current capability after peer authentication. Backend health and static resources are
not authentication exceptions. Session and CSRF cookies are Secure in the desktop profile.
Certificates are regenerated on each full application launch and are valid for one year;
they are removed only after owned children stop. They are never long-term OS trust anchors.

External GitHub redirects use a separate, narrowly bounded HTTP loopback callback;
only validated callback parameters are forwarded to the pinned HTTPS backend. That
bridge is not a generic HTTP API listener and does not solve the OAuth provider limitation below.

Windows runtime IO is restricted to retained fixed-NTFS roots. `WI1` identities bind the
volume and file ID; `WS1` states also include size, actual allocation size, last-write and
change timestamps. Writes use bounded chunks, full-state preconditions, file flush and
readback. Protected SID/DACL checks reject reparse points and hardlinks. Directory
rename/unlink is not claimed power-loss durable.
Retained directory and ancestor pins request list access so share-delete exclusion applies;
canonical DOS paths use internal extended-length paths without accepting device paths on
the wire. A write commit finalizes actual NTFS allocation and timestamps through the same retained
writer before acknowledging its state; closing cannot change that token. No-op append
preserves the previous state, and empty/shorter inactive-slot writes truncate the old suffix.
Safety state and folder grants use authenticated retained storage; missing/torn slots or
enrollment markers require recovery.
The native boundary suite exercises real Java21 Unicode socket paths through UTF-8 bootstrap,
full-size source frames, FIN/EOF and capability/epoch refusal. Guardian-death acceptance waits
on pre-retained query/synchronization process handles, not PID-existence polling. Passing these
boundaries alone does not attest Electron credential-store restart or full product acceptance.
The standalone Electron credential probe uses normal `app.quit()` shutdown: an immediate
`app.exit()` from Electron44's ready callback can bypass the Local State commit. This
restart proof does not attest crash or power-loss durability. Native Electron operations
and shutdown have bounded waits; primary failures are saved before cleanup, and forced
termination of the SDK-owned launcher can never pass clean-shutdown acceptance.

Main owns the encrypted source vault and private source broker. Java receives one bounded
version2 JSON+EOF bootstrap for both AI and source capabilities, never environment fallback.
Backup quiescence closes backend/analyzer, drains the broker and closes the vault before
source export/swap. Failed drain retains safety ownership and prevents ordinary exit.
Source enrollment has its own immutable authenticated marker, independent of paid-AI
fresh-install eligibility; missing source keys or markers are never silently regenerated.
Existing local data does not grant a new paid-AI enrollment exemption.

The Windows supply pins PostgreSQL 16.10, pgvector 0.8.1, Temurin21 and self-contained
Microsoft Garnet 2.2.0 built from source with pinned .NET dependencies. The framework-
dependent official Garnet executable is not shipped. PE architecture/import closure,
checksums, provenance and notices are verified before native helper execution. Windows
release packaging remains blocked pending reviewed native product evidence, signed
installer/update, clean interactive Windows11, power-loss and provider/license gates.

The native-acceptance.yml workflow runs on fresh hosted machines, on trusted same-repository
PRs and explicit manual dispatch. It exercises normal Electron startup rather than
bypassing isolated-launch guards. Windows requires a fresh standard-user token, verified
loaded profile and CurrentUser DPAPI before native NTFS/AF_UNIX/backup/TLS checks,
Garnet Spring Session/Lua/pub-sub compatibility and the complete unsigned product flow.
Its build selects an installed x64 MSVC/Windows SDK after a compile/link/run probe
under that same token, then pins the installation and versions for the helper and
pgvector. CMake uses explicit NMake/compiler/SDK paths; the runner's PATH and developer
environment are not inherited.
Native checks may not pass by skipping. Artifacts separate unsigned product results from
signed release acceptance; raw runtime logs and credential stores are never exported.
The macOS runner builds PostgreSQL 16, OpenSSL, Redis TLS and pgvector from
Homebrew-checksummed sources in private prefixes with a macOS 13.0 deployment target,
instead of repackaging newer-OS bottles or relaxing the native publication policy.
Only Redis's shipped `redis-server` target is built; upstream development module tests
are not part of the runtime closure. This avoids their raw-linker/compiler-flag mismatch
without weakening the deployment target, TLS or relocation checks.
Mach-O staging follows actual dynamic-library load commands, not LC_ID_DYLIB install
identities. A real dependency edge to different-content bytes still fails the digest
collision guard, and publication still requires a closed relocated dependency graph.
Temurin21 JNI libraries rely on the already loaded HotSpot VM rather than declaring its
server directory in every RPATH. Fresh JRE staging rewrites only their verified JVM load
edges to the contained loader-relative lib/server/libjvm.dylib and ad-hoc signs changed
images; it does not relax per-object closure or modify the source JDK. This is relocation,
not Developer ID signing or release acceptance.
Source URLs/hashes and relocated native closure hashes are retained in `provisioning.json`.
Staging failures export bounded compiler/policy IDs and validated public source locations.
Before an unsuccessful transaction removes its incoming stage, verified Mach-O closure
failures retain only staged-relative objects, token-relative load edges and contained RPATH
directories. Windows test failures retain fixed error/phase enums and public source locations,
not assertion values or messages. Raw build/runtime logs and credentials remain private.
Source copying excludes build outputs only at package roots, preserving real source packages
such as analysis/coverage.
Current local transport proof covers real PostgreSQL 16 and Redis TLS/authentication,
wrong-peer/plaintext rejection, HTTPS pinning, token rotation and callback refusal. Hosted
whole-app results, signed installation, real OAuth and provider approval remain separate gates.

The real native backup fixture now covers pinned Spring HTTPS, authenticated Redis,
PostgreSQL verify-full TLS, encrypted backup/restore, and an injected post-health failure
that rolls back product data while preserving the OFF credentials and unresolved safety seal.
All three cases passed; its OS key wrapper remains explicitly synthetic.
Archive failures preserve the original integrity/source-change rejection while attempting
every owned-resource close. A cleanup-only failure still prevents success acknowledgement;
cleanup errors do not turn a failed operation into success or replace its primary cause.
A separate cold clone of the real V20 database migrated through actual Flyway to V26;
existing-table row counts were preserved, and a cold V20 restore reproduced all data digests.
All 1,602 original DB files retained their bytes, sizes and permissions. This is not a signed-app upgrade.

The explicit macOS integration fixture below compiles private copies of the actual
Java client and Nest analyzer using existing dependencies, generates short-lived
self-signed test certificates and a test token in a new private run, and checks
their connection using synthetic source only. It starts no Electron, PostgreSQL or
Redis and does not register certificates with system trust. Run it only when that
test credential generation is authorized; it retains its private artifacts and
failure evidence and never reuses an earlier run.

```bash
node validation/analyzer-transport-integration/run.cjs \
  --build-parent "$PRIVATE_FRESH_PARENT" --java-home "$JDK21_HOME" \
  --gradle-modules-cache "$GRADLE_MODULES_CACHE"
```

On macOS, Electron's default app-data directory is
`~/Library/Application Support/code-intelligence-desktop` (the desktop package
name is `code-intelligence-desktop`). Based on `desktop/src/main.cjs`, the
bundled PostgreSQL database is stored below `postgres/`, Redis state below
`redis/`, backend data and repositories below `data/`, and restore recovery
checkpoints below `recovery/<transaction-UUID>/` within that app-data directory. Runtime
child logs use Electron's `app.getPath('logs')`, so they are written to
`~/Library/Logs/code-intelligence-desktop/runtime` on macOS, outside the app-data
directory. Main-owned safety state is outside the restorable data roots under `safety/`,
with a separate enrollment marker. Encrypted maintenance records live under `backup-maintenance/`.
Newly staged protocol3 runtimes connect the encrypted backup/restore buttons; older bundles keep
them disabled. These are internal validation paths, not release acceptance. Legacy format1/2 and
different-installation archives are rejected. Interrupted transactions block normal startup.
On Windows, product state is below `private/` inside Electron's user-data profile, with
protected inheritable DACLs on product workspaces and private child logs. TLS files,
source state and short private IPC directories are main-owned; cleanup is authorized
by retained identity and occurs only after proven service/source termination.

To create and directly run the local unsigned directory package:

```bash
(cd desktop && npm run stage && npm run pack:mac)
open "desktop/dist/mac-arm64/Code Intelligence.app"
```

This produces a local `electron-builder --mac dir` package. The package was
directly launched for macOS acceptance, but it was not copied to
`/Applications`; no release, publishing, or deployment was performed.

`./start-local` is a development helper, not a production supervisor. It starts
the analyzer containers only when `TS_ANALYZER_BASE_URL` or
`TREE_ANALYZER_BASE_URL` is configured. To start all local infrastructure
manually, including both analyzers:

```bash
docker compose up -d

# Backend — http://127.0.0.1:8080 (health: /actuator/health)
(cd backend && ./gradlew bootRun)

# Frontend — http://localhost:5173
(cd frontend && npm ci && npm run dev)
```

AI is optional. Native GitHub OAuth requires `GITHUB_NATIVE_CLIENT_ID` at
desktop/backend launch, but a client ID alone does not make the current native
OAuth flow production-ready. The authorization-code exchange currently omits the
client secret required by GitHub; select a supported device flow or a hosted
secret-bearing exchange before release. Never package a client secret in the
desktop binary. PAT login is supported as a secondary path. `TOKEN_ENC_KEY` is always
required by the backend. Set
`TS_ANALYZER_BASE_URL=http://127.0.0.1:3040` and
`TREE_ANALYZER_BASE_URL=http://127.0.0.1:3041` to enable the sidecars.

## Development

Run these commands from the repository root:

```bash
# Backend: format check + tests (Testcontainers; Docker required) + build
(cd backend && ./gradlew spotlessCheck build)

# Frontend: lint, typecheck, tests, build
(cd frontend && npm ci && npm run lint && npm run typecheck && npm test -- --run && npm run build)

# ts-analyzer sidecar
(cd analyzers/ts-analyzer && npm ci && npm test && npm run typecheck && npm run build)

# tree-sitter sidecar
(cd analyzers/tree-analyzer && npm ci && npm test && npm run typecheck && npm run build)

# Docker-backed golden corpus + analyzer quality/performance thresholds
./quality-gate

# Desktop syntax and local macOS staging/package checks
(cd desktop && npm test && node --check src/main.cjs && node --check src/preload.cjs)
(cd desktop && npm run stage && npm run pack:mac)
```

CI runs the backend, frontend, TypeScript analyzer, and tree-sitter analyzer
gates on every pull request. The backend job also runs `./quality-gate`, so its
runner must provide Docker. Baseline changes are explicit reviewed edits to
`quality-baseline.env`; `QUALITY_BASELINE_UPDATE` is intentionally rejected.

The desktop backup-state lifecycle regression can be run independently with
`node --test desktop/test/backup-product-state.test.cjs`. It uses fresh private
filesystem fixtures and synthetic child processes, not a real database. Tests wait
for explicit SQL-write phases rather than counting event-loop turns; shutdown
checks hold the child open until they have verified that work and close remain
pending. This focused check does not enable native guardian or product acceptance.

### Dependency security validation (2026-10-04)

Frontend and analyzer lockfiles use Vitest/mocker 4.1.11. The reviewed security
patches also select DOMPurify 3.4.16, brace-expansion 5.0.12, multer 2.4.0 and
qs 6.16.0 where applicable; unrelated versions remain unchanged. The two backend
analysis-only fixture manifests pin Vitest 4.1.11 without installing the fixtures
or adding lockfiles. Fresh isolated frontend/TS/tree dependency audits reported
zero vulnerabilities; that is not a repository-wide or release acceptance claim.

Desktop build tooling still includes http-cache-semantics 4.2.0 through
app-builder-lib → @electron/get 3.1.0 → got → cacheable-request.
GHSA-ch52-4w7c-c8xp still reports no patched version. The newly published 4.3.0 was
also exercised directly: a security-zeroed shared response containing Set-Cookie was
returned to a second-user request with max-stale. Therefore a version bump alone is
not accepted as remediation and the production lock remains unchanged.
The chain is development-only. Two actual downloads through the locked @electron/get
GotDownloader, with different synthetic user cookies and max-stale, made two origin
requests and returned distinct fresh artifacts: default download caching did not expose
the policy bug in that scenario. This does not prove every configured build path safe.
No alert suppression or unsupported claim of a repository-wide clean audit is made.

The patched frontend production build was exercised in an owned Chrome instance
at 980×700, 1280×800 and 1440×900. [Results and seven screenshots](validation/ui-layout/2026-10-04/results.json)
record responsive controls, explicit-snapshot source rendering, and refusal to
substitute current source for unknown evidence. APIs were synthetic and GET-only;
no backend proxy, external request or page error was observed. The browser and
static server were closed. This is not native Electron, live analysis/DB,
Keychain, Windows, signing or installation acceptance; release remains **No-Go**.

## AI providers, models, and cost

AI is optional. Static analysis, graph exploration, history and search work without
a provider. Explicit BYOK credentials in Settings are encrypted and scoped to their
owner; plaintext keys are not returned. Missing credentials or OFF/reconnect states
never opt a user in through an environment key. The key owner pays the provider;
the project includes no hosted AI allowance.

The desktop candidate supports the local owner's Assistant Q&A using the pinned
`gpt-4o-mini-2024-07-18` model. Saving a key performs no provider call and leaves
desktop AI off. Set daily/monthly USD limits (both default to zero), then explicitly
activate the budget. Each question needs a fresh review and one-use approval for
its exact masked context and maximum reservation. Amounts use integer micro-USD;
the conservative reservation uses the full input bound and capped output, not an
estimate of typical charges. Main sends once and records usage plus journal/DB
settlement before returning an answer. Unknown outcomes retain their reservation;
OFF prevents new sends but does not cancel an already issued provider request.

Other desktop providers, embeddings and unapproved helper calls remain unavailable.
The versioned price contract expires and fails closed; actual provider invoices,
paid requests and signed native confinement have not been validated. See the
[cost contract and limitations](docs/audit/strict-ai-cost-integration-2026-10-03.md).
The browser development path retains OpenAI/Gemini support and the soft
`AI_DAILY_TOKEN_LIMIT` guard; it does not provide the desktop monetary contract.

## Privacy and trust boundaries

Repository metadata and static analysis are processed by the local backend and
database. AI requests may send only the context required by the selected
feature, such as focused source windows, findings, pull-request text, or a
playground question/snippet. Secrets are masked before AI context construction,
but users should still treat provider requests as external transmission of
potentially sensitive source code. Do not import confidential repositories with
an AI provider enabled unless the provider's current data-use policy is
acceptable for your environment. Playground snippets are text-only and are
never built or executed.

The backend binds to loopback by default. If you expose it beyond the local
machine, configure authentication, CORS, TLS, secret management, backups, and
network access controls for that deployment; the local Docker Compose setup is
not a production deployment.

## RC workflows and safety boundaries

- **Local import:** an authenticated user can open
  `/import?path=<URL-encoded-path>`, request a bounded file preview, and explicitly confirm
  its one-use approval before `POST /api/projects/local` runs. There is no automatic import or
  browser directory picker. `LOCAL_IMPORT_ALLOWED_ROOTS` is a comma-separated
  allowlist; when empty, no server filesystem roots are granted. The desktop
  native picker grants selected folders through a separate main-process-only
  capability. Refresh fingerprinting and copy share bounded selection, exclusions, and raw Git
  blob hashes. See the [local ingest policy](docs/audit/local-ingest-policy.md)
  for ignore syntax, limits, exclusions, and the remaining filesystem race boundary.
- **Confirmed refresh:** local projects show `최신`, `변경됨`, `경로 없음`,
  `권한 재확인 필요`, or `검사 실패`. Initial import and refresh bind approval to the
  owned project/base snapshot, root identity, selection limits and actual file bytes.
  Unconsumed approvals expire after ten minutes; a consumed job receipt survives queue
  delays. The worker verifies staged bytes before replacing the repository. Changed input
  requires a new preview. Uncertain responses use an atomic outcome lookup without
  resending confirmation. Refresh performs a **full** analysis. Native filesystem
  confinement and immutable retained source remain release blockers; see the
  [approval contract](docs/audit/e2-approval-contract-2026-10-02.md).
- **Analysis decisions:** Analysis distinguishes inventory counts from unmeasured
  analysis outcomes and unknown completeness. Local ingest exclusions are a
  separate count-only observation. It also exposes
  deterministic snapshot comparison, and per-user finding judgments
  (`NEEDS_REVIEW`, `ACCEPTED`, `FALSE_POSITIVE`, `RESOLVED`). Hidden false
  positives remain recoverable; rule/evidence changes return them to review.
- **Reuse and editing:** current-snapshot summaries export as Markdown or JSON
  after secret redaction and without source bodies. IDE links are available
  only for local projects and validate the relative path; commit mismatch is
  reported before opening the configured IDE.
- **AI control:** preview reads bounded local context and existing matching summaries
  without generating summaries or embeddings. Normal ask may retrieve additional context.
  Excluded context IDs are filtered server-side; “local data only”
  prevents the frontend from sending an AI request. This is not a guarantee
  about provider policy when a request is actually sent.
- **Copyable prompt:** Context Preview can generate a masked, copyable prompt
  without an AI key or provider request. It is a handoff artifact, not a claim
  that an external model was called.
- **Reanalysis diff:** local refresh remains an explicitly confirmed full
  reanalysis. Snapshot comparison shows changed features, flows, findings,
  nodes, relations, coverage, rename candidates, and regression warnings;
  incremental P2 reanalysis is still out of scope.
- **Desktop recovery:** Protocol3 runtimes offer encrypted backups from Settings. Restore loads
  reviewed typed data and verified source objects into fresh staging, preserves prior DB/source
  images, keeps AI OFF and clears credentials, sessions and folder grants. Runtime health is
  checked behind a write barrier before completion. The unsafe legacy dump/SQL fallback remains
  unavailable. Interrupted-transaction recovery and storage retention remain release blockers;
  missing identity or safety state never silently creates replacement keys. See the
  [current audit and limits](docs/audit/backup-restore-integration-2026-10-03.md).
- **AI connection state:** OFF deletes the stored credential while preserving provider/model
  preferences. New users and OFF/reconnect states never use an environment key.
  Desktop key storage, budget activation and approval of each question are separate
  actions. An issued request can finish after OFF and stays counted while pending.
  Local analysis and copyable context previews remain available. The browser development
  path still does not provide a strict monetary budget guarantee.

### Current analysis boundaries

- TypeScript/NestJS project context is sent as one request, limited to 20,000 files
  and 10 MiB of serialized UTF-8 JSON (1 MiB per file). Larger inputs fail explicitly;
  independent partial batches are not used. This is not a large-monorepo guarantee.
- A running cancelled job stays `CANCELLING` until its current step exits. Reanalysis
  and deletion remain blocked during that interval; cancellation does not undo a
  completed step. Flyway V21 keeps this state in the active-job uniqueness constraint.
- Git submodule entries are excluded and recorded as snapshot evidence; submodule
  contents are not fetched or analyzed automatically.
- Language recognition does not imply full semantic support. See the current
  [language support and planning handoff](docs/planning-handoff-2026-10-02.md).

## RC validation record (2026-08-24)

Recorded against the current staged RC implementation:

- Backend: `310` tests passed, `0` failed/skipped; `spotlessCheck`, compilation,
  and assemble passed with Docker/Testcontainers available.
- Frontend: lint, typecheck, build, and `19` files / `57` tests passed.
- Analyzers: ts-analyzer `8` tests and tree-analyzer `7` tests passed, with
  typecheck and build for both.
- Quality gate: `54` fixture files, backend `23s`, maximum RSS `127,616KB`
  against the reviewed `300s` / `2,097,152KB` limits.
- Flyway: fresh V1→V19 and V17→V18→V19 upgrade passed with sentinel user,
  project, snapshot, note, task, AI setting, and finding data preserved.
- Local pipeline: small/medium/current-repository copies analyzed `14/14`,
  `130/130`, and `646/646` eligible files; the largest run took `45.972s` with
  `1,541,760KB` observed JVM process-tree peak RSS.
- Cross-project service/library smoke: `1` integration test passed for confirmed
  local import, stale-preview conflict, safe full refresh, snapshot comparison,
  and cleanup.

These numbers do **not** claim browser E2E, analysis accuracy, approved
false-positive rates, backup/restore, or production readiness. See the RC record
and blockers in [ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md).

## Supported execution and release scope

| Environment | Status |
|---|---|
| Local browser + Spring Boot backend | Supported development path |
| Docker Compose PostgreSQL/Redis/sidecars | Supported local infrastructure |
| macOS arm64 Electron runtime | Local staged/package RC; unsigned/notarized acceptance pending |
| Windows native installer | x64 NSIS configuration prepared; packaging blocked pending native safety/runtime work; not verified |
| Linux native package | Not verified |
| Production hosted deployment | Deployment-specific; no release workflow is included |

The only follow-up deployment sequence is: Developer ID signing → notarization
→ staple/Gatekeeper validation → fresh-machine backup/restore/OAuth acceptance
→ release. Developer ID/notary credentials and real OAuth credentials were not
available or used for this local verification.

## Troubleshooting

- Backend startup fails on `TOKEN_ENC_KEY`: create a 32-byte base64 key with
  `openssl rand -base64 32`, then put it in `.env`.
- Database or Redis connection errors: run `docker compose up -d` and check
  `docker compose ps` before starting the backend.
- TypeScript features are unavailable: start `ts-analyzer` and set
  `TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`. Python/Go/Vue/Svelte parsing
  additionally requires `tree-analyzer` and its base URL.
- AI is disabled: configure a supported environment key or open Settings and
  save a provider key. Model lists and connection checks require network access
  to the selected provider.
- AI requests fail after enabling a key: verify the selected model, provider
  quota, outbound network policy, and the provider's current API terms.

## Roadmap

| Phase | Scope |
|---|---|
| 0 — Foundation | Scaffold, DB schema, CI, 3-pane workspace shell |
| 1 — Repository Intelligence Core | GitHub OAuth, import & clone, project-area detection, Java AST analysis, code explorer, architecture view, history |
| 2 — Cross-domain Intelligence | TypeScript analyzer, FE↔BE↔DB↔Infra linking, flows, findings, impact analysis |
| 3 — AI | Context-aware assistant, why/alternative analysis, evidence-grounded answers |
| 4 — Learning & Productivity | Notes, tasks, AI learning-task generation, unified search |
| 5 — Advanced | PR review, playground, growth reports, what-if simulator |

This table describes implemented phase scope, not the current RC release gate.

Full design: [기획서.md](./기획서.md)

## License

[MIT](./LICENSE)
