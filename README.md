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
