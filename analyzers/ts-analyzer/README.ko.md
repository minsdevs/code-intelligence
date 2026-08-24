**언어:** [English](README.md) | 한국어

# ts-analyzer sidecar

ts-morph를 사용해 메모리에서 TypeScript/JavaScript를 parsing하고 구조화된 JSON을
Spring backend에 반환하는 stateless NestJS service입니다. backend가 persistence와
graph 구성을 담당합니다. sidecar는 가져온 저장소의 dependency를 설치하거나,
build하거나, 실행하지 않습니다.

## 실행 및 검증

RC/CI baseline에는 Node.js 24를 사용하십시오.

```bash
cd analyzers/ts-analyzer
npm ci
npm test
npm run typecheck
npm run build
npm start              # runs compiled dist/main.js on 127.0.0.1:3040
```

`npm start`를 실행하려면 먼저 build가 성공해야 합니다. 이 package에는 lint
script가 없습니다. 루트의 `docker compose up -d ts-analyzer` 명령은 로컬
container에서 설치, build, 시작을 수행합니다.

## HTTP contract

- `GET /health` → `{ "status": "ok" }`
- `{ "files": [{ "path", "content" }] }`를 사용한 `POST /analyze`
- 기본 bind: `127.0.0.1:3040`; `TS_ANALYZER_HOST`와 `TS_ANALYZER_PORT`로 override.
- Request body 제한: 10 MiB; 파일별 content 제한: 1 MiB; 안전하지 않은 상대
  경로는 거부됩니다.

backend에 `TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`을 설정하십시오. 빈 URL은
Java-only 분석을 실패시키지 않고 이 sidecar를 비활성화합니다. 설정되었지만 사용할
수 없는 sidecar는 analyzer 단계를 실패시켜 job을 다시 시도할 수 있게 합니다.
