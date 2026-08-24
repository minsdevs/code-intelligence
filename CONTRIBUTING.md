# Contributing

## Development setup

Follow the prerequisites and local startup steps in [README.md](./README.md).
Changes should remain focused and preserve the repository's deterministic-first,
evidence-grounded analysis model.

## Before opening a pull request

Run the checks for every area you changed. The full local gate is:

```bash
cd backend && ./gradlew spotlessCheck build
cd ../frontend && npm ci && npm run lint && npm run typecheck && npm test -- --run && npm run build
cd ../analyzers/ts-analyzer && npm ci && npm test && npm run typecheck && npm run build
cd ../tree-analyzer && npm ci && npm test && npm run typecheck && npm run build
cd ../.. && ./quality-gate
```

Docker must be running for backend Testcontainers and `./quality-gate`; the
quality gate also checks the reviewed corpus/time/RSS thresholds in
`quality-baseline.env`. Do not update that baseline implicitly or use
`QUALITY_BASELINE_UPDATE`—baseline changes require an explicit reviewed edit.

Run `bash -n start-local stop-local check-local quality-gate` when changing the
local scripts. If Docker, PostgreSQL, Redis, a browser session, or an external
provider is unavailable, state the unverified scope. Unit/API smoke tests do not
count as browser E2E, and result counts do not count as an accuracy oracle.

## Security and privacy

Never commit secrets or real repository contents. Do not add a feature that
executes imported code, generated AI output, or untrusted repository commands
without documenting the threat model and adding explicit human approval.
