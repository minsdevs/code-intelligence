# ts-analyzer sidecar

Stateless NestJS service that parses TypeScript/JavaScript with ts-morph and
returns structured JSON. The backend stores graph nodes; this process never
writes a database and never executes analyzed code.

```bash
cd analyzers/ts-analyzer
npm ci
npm test
npm run build
npm start   # 127.0.0.1:3040
```

- `GET /health` → `{ "status": "ok" }`
- `POST /analyze` `{ "files": [{ "path", "content" }] }`

Bind `TS_ANALYZER_HOST` / `TS_ANALYZER_PORT` to override. Default host is
loopback. Request body cap is 10 MiB; each file is 1 MiB.
