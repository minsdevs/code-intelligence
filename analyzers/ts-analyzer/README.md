**Languages:** English | [한국어](README.ko.md)

# ts-analyzer sidecar

Stateless NestJS service that parses TypeScript/JavaScript in memory with
ts-morph and returns structured JSON to the Spring backend. The backend owns
persistence and graph construction. The sidecar never installs dependencies
from, builds, or executes an imported repository.

## Run and verify

Use Node.js 24 for the RC/CI baseline.

```bash
cd analyzers/ts-analyzer
npm ci
npm test
npm run typecheck
npm run build
npm start              # runs compiled dist/main.js on 127.0.0.1:3040
```

`npm start` requires a successful build first. The package has no lint script.
The root `docker compose up -d ts-analyzer` command installs, builds, and starts
it in a local container.

## HTTP contract

- `GET /health` → `{ "status": "ok" }`
- `POST /analyze` with `{ "files": [{ "path", "content" }] }`
- Default bind: `127.0.0.1:3040`; override with `TS_ANALYZER_HOST` and
  `TS_ANALYZER_PORT`.
- Request body limit: 10 MiB; per-file content limit: 1 MiB; unsafe relative
  paths are rejected.

Configure the backend with
`TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`. A blank URL disables this sidecar
without failing Java-only analysis; a configured but unavailable sidecar makes
the analyzer step fail so the job can be retried.
