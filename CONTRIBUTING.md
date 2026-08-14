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
```

If Docker, PostgreSQL, Redis, or an external provider is unavailable, state the
unverified scope in the pull request. Do not report environment-dependent tests
as passing when they were not run.

## Security and privacy

Never commit secrets or real repository contents. Do not add a feature that
executes imported code, generated AI output, or untrusted repository commands
without documenting the threat model and adding explicit human approval.
