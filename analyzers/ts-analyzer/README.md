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

For the focused parser-only gate using already installed dependencies:

```bash
env -u NODE_OPTIONS -u NAPI_RS_NATIVE_LIBRARY_PATH -u NAPI_RS_FORCE_WASI -u NAPI_RS_WASI_FLAVOR \
  node node_modules/vitest/vitest.mjs run --config vitest.parser.config.mjs --configLoader native
```

This selects only the extractor, semantic and HTTP-boundary unit tests. It uses one
Node worker thread, no server listener, browser, watch mode, dotenv loading or setup
hooks. Inputs are synthetic strings or fixed repository fixtures; imported application
code is not executed. The inspected Mac runner uses its installed Rolldown library
inside the Node process. It does not start the app, guardian, Java or a database.

`--config vitest.syntax-api.config.mjs` additionally selects direct `AnalyzeService`
tests for request validation and the syntax-error response. It still does not start an
HTTP server. The frontend's separate `vitest.progress.config.mjs` uses an isolated DOM,
mocked job APIs and blocked fetch/XHR calls to verify recovery guidance.

## HTTP contract

- `GET /health` → `{ "status": "ok" }`
- `POST /analyze` with `{ "files": [{ "path", "content" }] }`
- Default bind: `127.0.0.1:3040`; override with `TS_ANALYZER_HOST` and
  `TS_ANALYZER_PORT`.
- One project context per request, at most 20,000 files and 10 MiB of serialized
  UTF-8 JSON; per-file content limit: 1 MiB. Unsafe relative paths are rejected.
  The backend enforces this byte budget while collecting sources. Oversized projects
  fail explicitly instead of being split into independent projects that lose imports,
  dependency injection, and global route prefixes.
- Regression: `node ../../docs/audit/reproduce-ts-batch-boundary.cjs` after build
  checks a synthetic 501-file NestJS project through the real HTTP endpoint.

Configure the backend with
`TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`. A blank URL disables this sidecar
without failing Java-only analysis; a configured but unavailable sidecar makes
the analyzer step fail so the job can be retried.

## Resolution boundaries

Class/method and function links require declaration or import evidence. Path aliases use
the importing file's nearest configuration scope; ambiguous configuration stays unresolved.
Nest routes with unsupported dynamic paths or global prefixes carry unresolved diagnostics.
Multiple Nest applications require module-specific resolution before their prefixes can be
assigned to controllers. Controller/method paths can follow same-file, earlier top-level
`const` literal aliases (up to 64 steps). Mutable, imported, forward, cyclic and computed
values stay unresolved; no evaluation or execution is performed.

Direct instance `this.method()` calls and arrow functions with the same lexical `this`
require a single own method declaration. Inherited, static, dynamic, shadowed and ambiguous
targets remain unresolved. Nested regular functions/objects/classes cannot borrow the
enclosing method's receiver. Confirmed edges describe static declaration evidence, not
runtime dispatch or proof against arbitrary prototype/property mutation.

React `Route` aliases and namespace access require value-import evidence from
`react-router` or `react-router-dom`. Local components, unrelated modules, type-only imports
and shadowed imports do not count as router declarations. `.mts`/`.cts` inputs are parsed;
explicit `.mjs`/`.cjs` specifiers resolve to supplied TypeScript sources first. Extensionless
module resolution and framework file-route extension policies are separate concerns.
Backend inventory language detection and the input filter include `.mts`/`.cts`. A later
[isolated Java gate](../../docs/audit/parser-java-unit-2026-10-03.md) compiled the current Java
sources with JDK 21 and passed 35 selected unit cases. Actual HTTP/DB integration remains unverified.

Any TypeScript/JavaScript syntax error rejects the entire extraction with `ParserSyntaxError`,
including when a malformed bootstrap could change otherwise valid files' routes. The error
contains at most 100 diagnostics (file, code, 1-based line/column) plus the total count, without
source snippets or compiler message text. Missing types/imports alone are not syntax errors.
The success response schema is unchanged. `AnalyzeService` converts the error into a
400 `BadRequestException` with code `TS_SYNTAX_ERROR`, `retryable: false`, diagnostics and
the total count. Direct service tests verify this shape; real HTTP integration is unverified.
The Java client now has a bounded response decoder which passes a safe first-location/count
summary through existing job `error`/`failureCode` fields. The progress UI explains source
repair and a new analysis, instead of retrying the same snapshot. The decoder and retry guard
have passed isolated Java unit tests; actual HTTP/DB/SSE execution remains unverified. See the
[flow follow-up](../../docs/audit/parser-flow-2026-10-03.md) and the later Java gate above.

HTTP extraction recognizes unshadowed global `fetch` and explicit Axios default-import
bindings. An unknown fetch method is reported as the string `UNKNOWN`, preserving uncertainty
through the backend instead of creating a GET relationship. Custom clients and complex aliases
may remain unrecognized. See the
[focused parser audit](../../docs/audit/parser-gaps-2026-10-03.md) for the current tests and
the remaining product integration boundaries. These tests do not establish production
accuracy, representative repository performance or desktop release readiness.
