# Phase 2 — Cross-domain Intelligence 구현 계획

> **역사 문서:** 이 계획과 체크박스는 해당 Phase 구현 당시의 범위·검증
> 기록이다. 현재 RC release 상태로 해석하지 않는다. 현행 안내는
> [README](../../README.md), RC 검증·blocker는
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

- 근거: `기획서.md` v1.2 (§4.2, §6.2, §8.1 step 10–11, §10.3–10.4, §11–13, §21) · Phase 1 완료(main, PR #20)
- 불변 원칙: 사실은 정적 분석만(§10.5) · evidence 필수(§9.1) · snapshot 귀속 · **clone한 코드는 절대 실행하지 않는다**(§18). ts-morph/JavaParser는 parse-only.
- 스택 제약: 기존 스택 유지. 신규는 기획서 명시분 — NestJS + ts-morph sidecar, tree-sitter fallback(사이드카). Neo4j/Elasticsearch/AI 금지.

---

## 1. 목표 / 범위 / 비범위

**목표:** TypeScript/JavaScript를 사이드카로 파싱하고, FE↔BE↔DB↔Infra/Event를 confidence와 함께 연결한 뒤 Flow·Findings·Impact·Frontend architecture·era를 UI에서 탐색할 수 있는 상태.

**범위 (기획서 §21 Phase 2 = task 2-1~2-13):**

- `analyzers/ts-analyzer` NestJS 무상태 REST. Backend가 결과 저장.
- FE: component/hook/store, React Router 라우트 → `frontend_routes`, fetch/axios → API_CALL 메타데이터
- FE↔BE CONSUMES (CONFIRMED / LIKELY / POSSIBLE)
- BE↔DB MAPS_TO, Repository→entity→table READS_WRITES
- BE↔Infra CONFIGURED_BY, Kafka PUBLISHES/SUBSCRIBES
- Flow detection (`flows` / `flow_steps`) + Flows UI
- Analysis findings + Impact Analysis(역방향 CTE 기본 깊이 5) + UI
- Features 탭 UI, Architecture FRONTEND 프로젝션, System 뷰 cross-domain edge, History era
- `TerraformAnalyzer`(HCL 리소스 블록)
- sc 게이트 후 verify. Dependabot critical/high = 0

**비범위:**

| 항목 | Phase |
|---|---|
| AI 전부(summaries, pgvector 질의) | 3 |
| 증분 분석(diff 재파싱) | 2 후반 optional — **초기엔 전체 재분석** |
| Notes / Tasks / 통합 Search | 4 |
| 사용자 확인으로 CONSUMES confidence 수정 UI | 최소: 표시만. 수정 POST는 시간 되면 포함 |

---

## 2. PR 묶음

| PR | 브랜치 | 포함 task | 핵심 산출물 |
|----|--------|-----------|------------|
| P1 | `feature/phase2-ts-analyzer` | 2-1, 2-2 | sidecar + CI + compose, V9, `TS_PARSING`, `frontend_routes` |
| P2 | `feature/phase2-cross-domain` | 2-3, 2-4, 2-5, 2-10 | CROSS_DOMAIN, V10 flows, V11 findings, Impact API, Kafka, Terraform |
| P3 | `feature/phase2-ui` | 2-6~2-9, 2-11 | Features/Flows/Analysis/Impact UI, FRONTEND arch, era timeline |
| 게이트 | `feature/phase2-security-fixes` (필요 시) | 2-12 → 2-13 | sc 리포트 → verify PASS |

```text
P1 → P2 → P3 → 2-12(sc) → (수정 PR) → 2-13(verify)
```

운영: CI green 후 merge. fixture 골든 변경은 PR에 사유 명시. `app.ts-analyzer.base-url` 공백이면 TS_PARSING은 **빈 DONE**(Java-only import 실패 금지). URL이 있는데 sidecar 다운이면 step 실패(재시도 가능).

---

## 3. 파이프라인 (추가 step)

| ORDER | step_key | 위치 |
|------|----------|------|
| 750 | TS_PARSING | GRAPH_BUILD 700 다음 (FILE 노드 존재 후 CONTAINS 연결) |
| 850 | CROSS_DOMAIN | EXTRACTION 800 다음 |
| 920 | FLOW_DETECTION | FEATURE_DETECTION 900 다음 |
| 940 | FINDING_DETECTION | FLOW_DETECTION 다음 |

FEATURE_DETECTION은 FE 라우트 prefix 시드 + UI role 링크를 확장한다.

---

## 4. DB (V9~V11)

| V | PR | 파일 | 내용 |
|---|----|------|------|
| V9 | P1 | `V9__frontend_routes.sql` | `frontend_routes(node_id, path, component_key)` UNIQUE(node_id), UNIQUE(snapshot_id, path) |
| V10 | P2 | `V10__flows.sql` | `flows`, `flow_steps` |
| V11 | P2 | `V11__analysis_findings.sql` | `analysis_findings` + evidence_links subject FINDING/FLOW |

---

## 5. 사이드카 계약

`POST /analyze` `{ files: [{ path, content }] }` →

```json
{
  "routes": [{ "path": "/todos", "component": "TodosPage", "filePath": "src/App.tsx", "lineStart": 10, "lineEnd": 10 }],
  "components": [{ "name": "TodoItem", "kind": "COMPONENT", "filePath": "src/components/TodoItem.tsx", "lineStart": 1, "lineEnd": 3 }],
  "hooks": [],
  "stores": [],
  "apiCalls": [{ "method": "GET", "url": "/api/todos", "filePath": "src/pages/TodosPage.tsx", "lineStart": 4, "owner": "TodosPage" }],
  "imports": [{ "fromPath": "src/pages/TodosPage.tsx", "toPath": "src/components/TodoItem.tsx", "imported": "TodoItem" }],
  "symbols": []
}
```

`GET /health` `{ "status": "ok" }`. 바인드 기본 `127.0.0.1:3040`. 요청 본문 10MB. path에 `..` 거부. **사용자 앱 npm/실행 금지** — in-memory ts-morph만.

Backend `app.ts-analyzer.base-url`: 공백=disabled. 설정 시 host는 loopback 또는 `ts-analyzer`만 허용(SSRF).

Backend 테스트는 in-process Fake HTTP(`FakeTsAnalyzer`). Sidecar npm 테스트가 fixture **파일 텍스트**를 ts-morph로 검증.

---

## 6. 매칭 규칙 (§11)

1. `POST /auth/login` = `POST /auth/login` → CONFIRMED
2. `/users/${id}` ↔ `/users/{id}` (세그먼트 정규화) → LIKELY
3. suffix-only (`/todos` vs `/api/todos`) → POSSIBLE

MAPS_TO: JPA `@Table` / entityName → `table:{name}` (대소문자 무시).
READS_WRITES: `layer=REPOSITORY` → 관련 entity → table.
Kafka: `@KafkaListener` / `KafkaTemplate.send` 토픽 문자열 → QUEUE_TOPIC + PUBLISHES/SUBSCRIBES.

---

## 7. Task 체크리스트

### 2-1 ts-analyzer sidecar — be

- [x] `analyzers/ts-analyzer` NestJS + ts-morph, `POST /analyze`, `GET /health`
- [x] React Router `<Route path>` / PascalCase 컴포넌트 / `use*` hook / zustand `create(` / fetch·axios
- [x] 상대 import 그래프. generic extractor(`.py`/`.go` 함수·클래스·import, tree-sitter 문법 없이 휴리스틱; 네이티브 바인딩은 CI 부담으로 후속)
- [x] vitest: react-mini / fullstack-mini frontend 텍스트
- [x] CI job + compose service + Dockerfile. clone 코드 실행 없음

### 2-2 TS_PARSING + V9 — be

- [x] `TsAnalyzerProperties`, `TsAnalyzerClient`, allowlist URL
- [x] `TsParsingStep` ORDER 750: URL 공백 → 빈 DONE. URL 설정+다운 → 실패
- [x] NaturalKeys `route:` / `component:` / `hook:` / `store:` / `topic:`
- [x] EXTRACTION이 `frontend_routes` 프로젝션
- [x] FakeTsAnalyzer + react-mini 골든: FE_ROUTE 2, TodoItem COMPONENT, GET `/api/todos` 메타데이터
- [x] `ProjectJobApiIntegrationTest` step 목록 갱신

### 2-3 Cross-domain — be

- [x] `CrossDomainStep` CONSUMES/MAPS_TO/READS_WRITES (+ CONFIGURED_BY 보강)
- [x] `KafkaEventExtractor` (JavaParser, SOURCE_PARSING에 포함)
- [x] fullstack-mini: CONSUMES GET `/api/todos` 또는 suffix POSSIBLE; MAPS_TO Todo↔todos
- [x] 단위 테스트: exact / `{id}` / suffix

### 2-4 Flow detection — be

- [x] V10 `flows`/`flow_steps`
- [x] Backend: endpoint → CALLS DFS(깊이 제한)
- [x] FE_BE: route → component → CONSUMES → backend flow
- [x] INFRA/EVENT: DEPLOYED_IN, PUBLISHES/SUBSCRIBES
- [x] `GET /api/projects/{id}/flows`, `GET .../flows/{flowId}` (소유권 검사)

### 2-5 Findings + Impact — be

- [x] V11 `analysis_findings`
- [x] 정적 룰: unmatched API call, entity without MAPS_TO, FE route without CONSUMES
- [x] `GET /api/projects/{id}/findings` (severity 필터)
- [x] `GET /api/projects/{id}/impact?nodeId=&depth=` reverse CTE 기본 5, 위험도
- [x] finding/flow evidence_links. IDOR: 타 유저 project 404

### 2-6 Features UI — fe

- [x] Features 탭: 트리 + 상세(links/evidence), Code로 이동
- [x] `workspaceTabs.features.phase = 1` (구현됨). fetch 테스트

### 2-7 Flows UI — fe

- [x] kind 필터, step 리스트, source location → Code

### 2-8 Analysis + Impact UI — fe

- [x] findings 테이블(severity·area·evidence)
- [x] Impact: 노드 검색/선택, depth, 역방향 의존 + risk

### 2-9 FRONTEND architecture — be+fe

- [x] `architecture?area=FRONTEND` Page/Component/State/API Client
- [x] SYSTEM에 FE_ROUTE/API_ENDPOINT/DB_TABLE + CONSUMES/MAPS_TO
- [x] Architecture 탭 Frontend 토글 (FRONTEND area 선택 시)

### 2-10 TerraformAnalyzer — be

- [x] `.tf` `resource "type" "name"` → CLOUD_RESOURCE, infra_resources 프로젝션
- [x] infra-mini 골든: `aws_s3_bucket.data`

### 2-11 Era timeline — be+fe

- [x] manifest(pom.xml, package.json, docker-compose, build.gradle, *.tf) 변경 commit → era
- [x] `GET /api/projects/{id}/eras`
- [x] History 탭 era 타임라인. AI 설명 없음

### 2-12 sc — sc

- [x] sidecar SSRF, 본문 크기, path traversal
- [x] 신규 API IDOR
- [x] Dependabot C/H=0
- [x] `docs/plan/phase2-security-audit.md`

### 2-13 verify — verify

- [x] `./gradlew spotlessCheck build` PASS (PR #22)
- [x] frontend lint/typecheck/test/build PASS
- [x] sidecar `npm test` + `npm run build` PASS (PR #21)
- [ ] CI green on merge (this PR)
- [x] **Phase 3 시작 금지**

---

## 8. 골든 / fixture

| fixture | 기대 |
|---|---|
| react-mini | FE_ROUTE `/`, `/todos`; COMPONENT `TodoItem`; apiCall GET `/api/todos` |
| fullstack-mini | 위 + CONSUMES vs `GET /todos` 또는 `/api/todos` suffix; MAPS_TO Todo↔todos |
| infra-mini | CLOUD_RESOURCE `aws_s3_bucket.data` |
| spring-mini | TS_PARSING no-op(사이드카 꺼진 테스트) 또는 TS 파일 없음 → 빈 DONE |

---

## 9. 보안 메모 (구현 시 고정)

- sidecar URL은 설정만. 사용자 입력으로 base-url 지정 금지.
- analyze path는 상대경로, `..` 거부. content 파일당 `app.analysis.max-file-size`.
- 신규 GET은 기존과 같이 `findByIdAndUserId`.
- RestClient 타임아웃. 사이드카는 루프백 바인드(compose에선 서비스명).
