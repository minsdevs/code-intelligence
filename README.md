**Languages:** English | [한국어](README.ko.md)

# Code Intelligence

A personal workspace that analyzes an entire GitHub repository, automatically
discovers the technical areas that make up the project (Backend, Frontend,
Database, Infrastructure, DevOps, Security, Testing, AI, …), and lets you
explore its features, architecture, call flows, dependencies, history, design
rationale, and alternatives — with an evidence-grounded, context-aware AI
assistant.

> **Status: release candidate / internal testing.**
> Phase 1–5 functionality is present, and the current RC adds local-folder
> import, safe local refresh, snapshot comparison, finding judgments, coverage,
> Markdown/JSON export, IDE deep links, AI context preview/exclusion, and a
> quality regression gate. These RC changes are staged on
> `rc/feature-freeze-20260824`; they are not described here as released on
> `main`. See [ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md) for the
> implementation and validation record.
>
> **Release remains blocked** on the real browser 10-step E2E and an approved
> accuracy/false-positive oracle for representative repositories. Desktop
> backup/restore is implemented for the local macOS runtime; roadmap P2
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
checks pass:

```bash
(cd desktop && npm ci && npm run stage && npm start)
```

`desktop/scripts/stage-runtime.mjs` currently verifies macOS arm64, builds the
frontend/analyzer/backend, and requires local PostgreSQL with pgvector and
Redis binaries. `pack:mac` creates a local directory package; signing,
notarization, fresh-machine install, and real OAuth remain release blockers.
When the host `pgvector` bottle targets a different PostgreSQL major, set
`PGVECTOR_ROOT` to a matching build root containing `lib/postgresql` and
`share/postgresql/extension` before staging; the stage is committed atomically
only after its manifest is complete.

On macOS, Electron's default app-data directory is
`~/Library/Application Support/code-intelligence-desktop` (the desktop package
name is `code-intelligence-desktop`). Based on `desktop/src/main.cjs`, the
bundled PostgreSQL database is stored below `postgres/`, Redis state below
`redis/`, backend data and repositories below `data/`, and restore recovery
backups below `recovery/<timestamp>/` within that app-data directory. Runtime
child logs use Electron's `app.getPath('logs')`, so they are written to
`~/Library/Logs/code-intelligence-desktop/runtime` on macOS, outside the app-data
directory. User-selected backup exports remain at the destination chosen in the
backup dialog.

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
desktop/backend launch. The client secret is never placed in the desktop
binary; PAT login is supported as a secondary path. `TOKEN_ENC_KEY` is always
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
(cd desktop && node --check src/main.cjs && node --check src/preload.cjs)
(cd desktop && npm run stage && npm run pack:mac)
```

CI runs the backend, frontend, TypeScript analyzer, and tree-sitter analyzer
gates on every pull request. The backend job also runs `./quality-gate`, so its
runner must provide Docker. Baseline changes are explicit reviewed edits to
`quality-baseline.env`; `QUALITY_BASELINE_UPDATE` is intentionally rejected.

## AI providers, models, and cost

AI is optional. Static repository analysis, graph exploration, history, search,
and the growth report do not require an AI provider. You can either configure a
server-wide environment key (`OPENAI_API_KEY` or `GEMINI_API_KEY`) or enter a
provider key in Settings. Settings keys are encrypted with `TOKEN_ENC_KEY` and
are scoped to the authenticated user; the server does not return the plaintext
key. A provider connection check runs before a key is stored, and the selected
chat model can be changed from Settings. The current providers are OpenAI and
Gemini; embedding models remain environment-configured because the database
vector schema has a fixed dimension.

The project does not include a hosted AI gateway or a free AI allowance. With a
server-wide key, the operator pays provider usage for all users. With BYOK, the
key owner pays the provider directly. Provider pricing, quotas, retention, and
terms change over time, so check the provider's current official pricing and
privacy documentation before production use. `AI_DAILY_TOKEN_LIMIT` is an
application budget guard, not a billing guarantee.

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
  `/import?path=<URL-encoded-path>`, inspect the path, and explicitly confirm
  before `POST /api/projects/local` runs. There is no automatic import or
  browser directory picker. `LOCAL_IMPORT_ALLOWED_ROOTS` is a comma-separated
  allowlist; when empty, the backend user home is the only allowed root.
  Canonical-path, system/secret-directory, and symlink-escape checks apply.
- **Safe refresh:** local projects show `최신`, `변경됨`, `경로 없음`, or
  `권한 재확인 필요`. Refresh requires a preview snapshot plus matching
  added/modified/deleted counts; a source change after preview returns a
  conflict. Refresh remains a safe **full** analysis, not incremental P2 work.
- **Analysis decisions:** Analysis exposes coverage/partial-result information,
  deterministic snapshot comparison, and per-user finding judgments
  (`NEEDS_REVIEW`, `ACCEPTED`, `FALSE_POSITIVE`, `RESOLVED`). Hidden false
  positives remain recoverable; rule/evidence changes return them to review.
- **Reuse and editing:** current-snapshot summaries export as Markdown or JSON
  after secret redaction and without source bodies. IDE links are available
  only for local projects and validate the relative path; commit mismatch is
  reported before opening the configured IDE.
- **AI control:** preview uses the real retrieval path without contacting the
  provider. Excluded context IDs are filtered server-side; “local data only”
  prevents the frontend from sending an AI request. This is not a guarantee
  about provider policy when a request is actually sent.
- **Copyable prompt:** Context Preview can generate a masked, copyable prompt
  without an AI key or provider request. It is a handoff artifact, not a claim
  that an external model was called.
- **Reanalysis diff:** local refresh remains an explicitly confirmed full
  reanalysis. Snapshot comparison shows changed features, flows, findings,
  nodes, relations, coverage, rename candidates, and regression warnings;
  incremental P2 reanalysis is still out of scope.
- **Desktop recovery:** the desktop Settings screen shows runtime status and
  services, restart, backup, and restore. Restore requires a UI confirmation
  and a main-process warning after manifest/hash validation; a recovery backup
  is created only after explicit Restore.

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
| Windows native installer | Not verified |
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
