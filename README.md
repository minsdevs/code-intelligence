# Code Intelligence

A personal workspace that analyzes an entire GitHub repository, automatically
discovers the technical areas that make up the project (Backend, Frontend,
Database, Infrastructure, DevOps, Security, Testing, AI, …), and lets you
explore its features, architecture, call flows, dependencies, history, design
rationale, and alternatives — with an evidence-grounded, context-aware AI
assistant.

> **Status: Phase 5 — Advanced (complete).**
> Phase 1 (import, Java analysis, architecture, history), Phase 2
> (TypeScript sidecar, FE↔BE matching, flows, findings, impact, era),
> Phase 3 (provider-abstracted assistant, summaries + pgvector, evidence-grounded
> Why/Alternative answers), Phase 4 (notes, tasks, AI learning-task drafts,
> unified search), and Phase 5 (PR review, playground, growth reports,
> static what-if) are on `main`.
> See [기획서.md](./기획서.md) and [docs/plan/phase5.md](./docs/plan/phase5.md).

This repository currently ships a browser-based local workspace with a Spring
Boot backend and optional analyzer sidecars. It is not yet a packaged native
desktop application: there is no Tauri/Electron runtime, installer, auto-update
channel, or macOS/Windows/Linux signing pipeline in this repository.

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

Prerequisites: Docker, Node.js ≥ 24, JDK (Gradle auto-provisions the Java 21
toolchain via Foojay).

```bash
cp .env.example .env          # local defaults work out of the box
                              # optional: OPENAI_API_KEY or GEMINI_API_KEY (the Settings UI also supports encrypted BYOK)

docker compose up -d          # PostgreSQL + Redis + both analyzer sidecars

# Optional sidecar URLs when running them outside Docker:
# TypeScript — http://127.0.0.1:3040
cd analyzers/ts-analyzer && npm ci && npm start

# tree-sitter (Python/Go/Vue/Svelte) — http://127.0.0.1:3041
cd ../tree-analyzer && npm ci && npm start

# Backend — http://localhost:8080 (health: /actuator/health)
# Set TS_ANALYZER_BASE_URL and TREE_ANALYZER_BASE_URL to enable sidecar parsing
cd backend && ./gradlew bootRun

# Frontend — http://localhost:5173
cd frontend && npm install && npm run dev
# For a backend on another local port:
# VITE_BACKEND_URL=http://127.0.0.1:18080 npm run dev
```

## Development

```bash
# Backend: format check + tests (Testcontainers; Docker required) + build
cd backend && ./gradlew spotlessCheck build

# Frontend: lint, typecheck, tests, build
cd frontend && npm run lint && npm run typecheck && npm test -- --run && npm run build

# ts-analyzer sidecar
cd analyzers/ts-analyzer && npm ci && npm test && npm run build

# tree-sitter sidecar
cd analyzers/tree-analyzer && npm ci && npm test && npm run build
```

CI runs the backend, frontend, TypeScript analyzer, and tree-sitter analyzer
gates on every pull request.

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

## Supported execution and release scope

| Environment | Status |
|---|---|
| Local browser + Spring Boot backend | Supported development path |
| Docker Compose PostgreSQL/Redis/sidecars | Supported local infrastructure |
| macOS native installer | Not implemented |
| Windows native installer | Not implemented |
| Linux native package | Not implemented |
| Production hosted deployment | Deployment-specific; no release workflow is included |

The current release is therefore suitable for local evaluation and development,
not for claiming a signed cross-platform desktop distribution. A future desktop
release must add a native runtime, OS credential integration, packaging,
signing/notarization, update delivery, crash recovery, and platform CI before it
can be called production-ready.

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
| 4 — Learning & Productivity | Notes, tasks, AI learning-task generation, unified search **(done)** |
| 5 — Advanced | PR review, playground, growth reports, what-if simulator **(done)** |

Full design: [기획서.md](./기획서.md)

## License

[MIT](./LICENSE)
