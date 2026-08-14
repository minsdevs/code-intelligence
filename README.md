# Code Intelligence

A personal workspace that analyzes an entire GitHub repository, automatically
discovers the technical areas that make up the project (Backend, Frontend,
Database, Infrastructure, DevOps, Security, Testing, AI, …), and lets you
explore its features, architecture, call flows, dependencies, history, design
rationale, and alternatives — with an evidence-grounded, context-aware AI
assistant.

> **Status: Phase 2 — Cross-domain Intelligence (in progress).**
> Phase 1 (import, Java analysis, architecture, history) is on `main`.
> See [기획서.md](./기획서.md) and [docs/plan/phase2.md](./docs/plan/phase2.md).

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
| AI (Phase 3) | Provider-abstracted (OpenAI / Gemini), pgvector embeddings |

## Getting started

Prerequisites: Docker, Node.js ≥ 24, JDK (Gradle auto-provisions the Java 21
toolchain via Foojay).

```bash
cp .env.example .env          # local defaults work out of the box

docker compose up -d          # PostgreSQL (pgvector) + Redis (+ ts-analyzer)

# Optional TypeScript sidecar — http://127.0.0.1:3040
cd analyzers/ts-analyzer && npm ci && npm start

# Backend — http://localhost:8080 (health: /actuator/health)
# Set TS_ANALYZER_BASE_URL=http://127.0.0.1:3040 to enable TS_PARSING
cd backend && ./gradlew bootRun

# Frontend — http://localhost:5173
cd frontend && npm install && npm run dev
```

## Development

```bash
# Backend: format check + tests (Testcontainers; Docker required) + build
cd backend && ./gradlew spotlessCheck build

# Frontend: lint, typecheck, tests, build
cd frontend && npm run lint && npm run typecheck && npm test -- --run && npm run build

# ts-analyzer sidecar
cd analyzers/ts-analyzer && npm ci && npm test && npm run build
```

CI runs the same gates on every pull request.

## Roadmap

| Phase | Scope |
|---|---|
| 0 — Foundation | Scaffold, DB schema, CI, 3-pane workspace shell |
| 1 — Repository Intelligence Core | GitHub OAuth, import & clone, project-area detection, Java AST analysis, code explorer, architecture view, history |
| 2 — Cross-domain Intelligence | TypeScript analyzer, FE↔BE↔DB↔Infra linking, flows, findings, impact analysis |
| 3 — AI | Context-aware assistant, why/alternative analysis, evidence-grounded answers |
| 4 — Learning & Productivity | Notes, tasks, AI learning-task generation, unified search |
| 5 — Advanced | PR review, playground, growth reports, what-if simulator |

Full design: [기획서.md](./기획서.md)

## License

[MIT](./LICENSE)
