# Phase 1 실행 계획 — Repository Intelligence Core

- 문서: `docs/plan/phase1.md`
- 기준 문서: `기획서.md` v1.2 (승인됨, 2026-08-14) — §6~§10, §12~§13, §15, §18~§19, §21
- 상태: 확정 (2026-08-14) — G1(1-1)·G2(1-3)부터 착수

**Goal:** GitHub 저장소를 import하면 영역 감지 → 사용자 선택 → Java/설정 정적 분석 → 그래프/endpoint/entity/feature 추출 → Code·Architecture·History·Home UI 탐색까지 한 사이클이 실제 저장소에서 동작한다 (기획서 §21 Phase 1, task 1-1~1-17).

**Architecture:** 모든 분석 결과는 snapshot(commit SHA)에 귀속되고(§6.1), 파이프라인은 `analysis_jobs`/`analysis_job_steps`를 소스 오브 트루스로 하는 step 단위 상태 머신으로 실행된다(§8). 사실(fact)은 파서 산출물로만 기록하며 Phase 1에는 AI 레이어가 없다(§10.5).

**Tech stack / 제약:**

- Backend: Spring Boot **4.1.0** (Framework 7 / Security 7), Gradle 9.7, Java 21. 아웃바운드 HTTP는 **RestClient만** 사용(RestTemplate 모듈 없음). OAuth2 스타터는 Boot 4 명명인 `spring-boot-starter-security-oauth2-client`(+`-test`).
- 테스트: 기술별 test 스타터 + `@Import(TestcontainersConfiguration.class)` + `@ServiceConnection`, HTTP 검증은 `RestTestClient` (Phase 0 패턴 유지).
- Frontend: React 19, Vite 8, TS strict, Tailwind 4, TanStack Query(서버 상태), Zustand(UI 상태), react-router 7. API 타입은 openapi-typescript 생성(§4.3, §19).
- 신규 백엔드 의존성(Phase 1): JGit, JavaParser(+SymbolSolver), JSqlParser, SnakeYAML(Boot 포함), springdoc-openapi 3.x(`springdoc-openapi-starter-webmvc-api`, Boot 4 호환 라인), `spring-session-data-redis`, ArchUnit(test).
- 신규 프런트 의존성(Phase 1): `monaco-editor`+`@monaco-editor/react`(1-12), `@xyflow/react`+`elkjs`(1-13), devDeps `openapi-typescript`, `msw`(1-6). 그 외 추가 금지.

**Out of scope (Phase 2+로 명시 이월):**

- TypeScript/기타 언어 AST 분석(ts-analyzer 사이드카), `frontend_routes` 채우기 — 테이블만 생성
- Cross-domain 연결(CONSUMES/MAPS_TO/DEPLOYED_IN 매칭 §11), Flow detection/UI, Analysis findings, Impact Analysis
- Era detection 타임라인(§13), 증분 분석, GraphQL 배치 조회·ETag 캐시(§7.2의 최적화 항목 — Phase 1은 full fetch + 백오프로 충족)
- AI 전체(§14), Notes/Tasks/Search, Terraform HCL 파싱(area 시그널로만 사용)

---

## 1. 개요

### 1.1 Phase 1 목표

기획서 §21 Phase 1 표의 1-1~1-17을 완료한다. 사용자 시나리오 기준:

1. PAT 등록(또는 GitHub OAuth 로그인) → 접근 가능한 repo 목록 조회
2. repo 선택 → import job 시작 → clone → snapshot 생성 → step 체크리스트 실시간 진행 표시
3. 파일 인벤토리 → 영역 감지(12종 + evidence) → 영역 카드에서 선택 저장
4. Java/설정 분석 → graph_nodes/edges, api_endpoints, db_entities, infra_resources, features 생성
5. Code(파일트리+Monaco+심볼), Architecture(React Flow), History(commit/PR/diff), Home(프로젝트 카드) 탐색

### 1.2 완료 정의 (Phase 1 DoD)

- [ ] fixture 4종(spring-mini/react-mini/fullstack-mini/infra-mini) 골든 테스트 전부 green
- [ ] 실제 GitHub public repo 1개 + private repo 1개(PAT 경로)로 import→탐색 수동 스모크 통과
- [ ] main의 CI(backend `spotlessCheck build`, frontend lint+typecheck+test+build) green
- [ ] §18 Phase 1 보안 TODO ①~④ 이행 + 1-16 감사에서 Critical/High 0
- [ ] 1-17 verify 게이트(§7) PASS — 통과 전 Phase 2 진입 금지

### 1.3 외부 의존성 (사용자 준비 항목)

| 항목 | 필요 시점 | 비고 |
|---|---|---|
| **GitHub OAuth App** client id/secret | 1-1의 OAuth 경로 수동 확인 시 | callback: `http://localhost:8080/login/oauth2/code/github`. **없어도 1-1의 PAT 경로·이후 전체 task는 동작해야 한다** (OAuth 미설정 시 앱 기동/CI에 영향 0) |
| GitHub PAT (repo scope) | 1-1 완료 기준 확인 시 | private repo 목록 조회/clone 수동 검증용 |
| `TOKEN_ENC_KEY` | 1-1부터 로컬 실행 시 | `openssl rand -base64 32`. 테스트는 고정 테스트 키 사용 |

### 1.4 선행 조건 (Phase 1 착수 전)

- [x] **P0. Phase 0 산출물 커밋/병합** — 완료. PR #1(`feature/phase0-foundation`)이 CI green으로 main에 병합됨 (2026-08-14, merge `08234e6`).
- [ ] P1. `spotless` 대상에서 fixture 제외 규칙 합의(1-4에서 적용) — 현재 `target("src/**/*.java")`가 `src/test/resources/fixtures/**`의 Java 파일까지 포맷팅해 골든 라인 번호를 깨뜨린다.

### 1.5 Agent task board

| ID | Agent | Title | Depends on | Done when |
|----|-------|-------|------------|-----------|
| 1-1 | be | GitHub OAuth 로그인 + PAT 등록 + 토큰 암호화 저장 | — (외부: OAuth App은 선택) | PAT/OAuth로 private repo 목록 조회 성공, 토큰 GCM 암호화(고유 nonce, key_version) |
| 1-2 | be | Repository import + JGit clone + snapshot 생성 | 1-1, 1-3 | fixture git repo·실 repo(public/private) clone + snapshot 생성 |
| 1-3 | be | 비동기 Job 프레임워크(steps, 체크포인트, SSE) | — | 실패 step부터 재시도 동작, SSE로 진행 수신 |
| 1-4 | be | 파일 인벤토리 + 언어 감지 + 파일 서빙 API | 1-2 | fixture 골든 통과, path traversal 원천 차단 |
| 1-5 | be | Area Detection 엔진 + 12영역 detector + evidence | 1-4 | fixture 4종에서 기대 영역·confidence 감지 |
| 1-6 | fe | Import Wizard UI + openapi-typescript 파이프라인 | 1-1, 1-3, 1-5 | 인증→repo 선택→진행 체크리스트→영역 선택 저장·반영 |
| 1-7 | be | Git metadata 수집(commits/branches/tags/PR) | 1-2, 1-3 | fixture 골든 + rate limit 백오프 동작 |
| 1-8 | be | CodeAnalyzer SPI + JavaAnalyzer + 그래프 API | 1-4 | spring-mini 골든 그래프 일치 |
| 1-9 | be | 설정 분석기(build/yml/Docker/CI/SQL) | 1-8 | fixture 추출 결과 일치 |
| 1-10 | be | API endpoint + JPA entity 추출 + 레이어 태깅 + Architecture 프로젝션 API | 1-8 | spring-mini endpoint 3건 정확, projection 응답 검증 |
| 1-11 | be | Feature 기본 추출(prefix+패키지 군집) | 1-10 | spring-mini에서 기대 feature+links 생성 |
| 1-12 | fe | Code explorer(트리+Monaco+심볼 패널) | 1-4, 1-6, 1-8 | 심볼/노드→코드 라인 이동 동작 |
| 1-13 | fe | Architecture 뷰(React Flow, Backend/System) | 1-10, 1-12 | 노드 클릭→코드 이동 |
| 1-14 | fe | History 뷰(commit/PR 타임라인, diff) | 1-6, 1-7 | diff 렌더 정상 |
| 1-15 | fe | Home 카드 + 사이드바 Areas + Features 최소 탭 | 1-5, 1-6, 1-7, 1-11 | 카드 정보 표시, Areas 토글 반영, Features 목록 표시 |
| 1-16 | sc | 토큰·clone·파일 서빙·세션 보안 감사 | 1-1~1-15 | §18 체크리스트 취약점 0 (Critical/High) |
| 1-17 | verify | Phase 1 최종 검증 | 전부 | §7 체크리스트 전부 PASS |

> 정밀화 메모: 기획서 §21 표에 없는 백엔드 표면 3개를 소유 task에 귀속시켰다 — 파일트리/파일내용 API→**1-4**, 그래프/심볼 조회 API→**1-8**, Architecture 프로젝션 API→**1-10**. 또 워크스페이스 기본 탭이 Features(현 라우터의 index redirect)이므로 **읽기 전용 Features 최소 탭을 1-15에 포함**한다(§15.2의 Phase 1 단면; 상세 화면은 Phase 2).

---

## 2. PR 그룹핑 (기획서 §21 Git 전략 / 요구사항 §38)

원칙: 그룹마다 독립 feature 브랜치, PR 단위로 CI green 유지, **마이그레이션 포함 PR은 반드시 V 버전 오름차순으로 병합**(Flyway out-of-order 미사용). 병렬 개발은 허용하되 병합은 아래 순서를 따른다.

| 순서 | 브랜치 | 포함 task | 마이그레이션 | 선행 조건(병합 기준) |
|---|---|---|---|---|
| G0 | `feature/phase0-foundation` | (선행) Phase 0 산출물 커밋 | V1(기존) | — |
| G1 | `feature/phase1-github-auth` | 1-1 | V2 | G0 |
| G2 | `feature/phase1-job-framework` | 1-3 | — | G0 (G1과 병렬 개발 가능) |
| G3 | `feature/phase1-import-inventory` | 1-2, 1-4 | V3 | G1, G2 |
| G4 | `feature/phase1-area-detection` | 1-5 | V4 | G3 |
| G5 | `feature/phase1-import-wizard` | 1-6 | — | G4 (openapi-typescript 파이프라인 도입 PR) |
| G6 | `feature/phase1-git-metadata` | 1-7 | V5 | G3, **V4(G4) 이후 병합** |
| G7 | `feature/phase1-java-analyzer` | 1-8 | V6 | G3, V5 이후 병합 |
| G8 | `feature/phase1-config-analyzers` | 1-9 | V7 | G7 |
| G9 | `feature/phase1-spring-extraction` | 1-10 | V8 | G7, V7 이후 병합 |
| G10 | `feature/phase1-feature-detection` | 1-11 | V9 | G9 |
| G11 | `feature/phase1-code-explorer` | 1-12 | — | G5, G7 (G8~G10과 병렬 가능) |
| G12 | `feature/phase1-architecture-view` | 1-13 | — | G9, G11 |
| G13 | `feature/phase1-history-view` | 1-14 | — | G5, G6 (G7~G12와 병렬 가능) |
| G14 | `feature/phase1-home-dashboard` | 1-15 | — | G4, G6, G10 |
| G15 | `feature/phase1-security-audit` | 1-16 | (수정 발생 시 해당 브랜치) | G1~G14 전부 |
| — | (브랜치 없음, main 기준) | 1-17 verify | — | G15 |

병렬 트랙 요약: **백엔드 분석 트랙**(G6→G7→G8→G9→G10)과 **프런트 트랙**(G5→G11/G13→G12→G14)은 G4 병합 이후 상당 부분 병렬 진행 가능하다. 각 task 완료 시 절차는 기획서 §21 고정: status/diff 확인 → 테스트 → commit → push → PR → CI green → merge → 로컬 동기화 → 원격 브랜치 삭제.

---

## 3. DB 마이그레이션 시퀀스

버전은 본 계획에서 **사전 할당**한다(병렬 브랜치 간 충돌 방지). 모든 컬럼은 §6.2 기준, V1 컨벤션(bigserial PK, `text` enum + CHECK, timestamptz, FK ON DELETE CASCADE)을 따른다. 재실행 멱등성(§8.3)을 위한 UNIQUE 제약을 반드시 포함한다.

| 버전 | task(PR) | 테이블/변경 |
|---|---|---|
| V2 | 1-1 (G1) | `github_credentials`에 `key_version int NOT NULL DEFAULT 1` 추가. GCM nonce는 별도 컬럼이 아니라 암호문 포맷(`base64(nonce ‖ ciphertext+tag)`)에 암호화 건마다 고유하게 포함 — §18 TODO ① 충족 |
| V3 | 1-4 (G3) | `files` |
| V4 | 1-5 (G4) | `evidences`, `evidence_links`, `project_areas`, `area_technologies` |
| V5 | 1-7 (G6) | `commits`, `commit_files`, `branches`, `tags`, `pull_requests` |
| V6 | 1-8 (G7) | `graph_nodes`, `graph_edges` |
| V7 | 1-9 (G8) | `infra_resources` |
| V8 | 1-10 (G9) | `api_endpoints`, `db_entities`, `frontend_routes`(Phase 2에서 채움 — 스키마만 선반영해 §6.2와 일치) |
| V9 | 1-11 (G10) | `features`, `feature_links` |

컬럼 상세:

**V3 — files**

```sql
files (
  id bigserial PK,
  snapshot_id bigint NOT NULL REFERENCES snapshots ON DELETE CASCADE,
  path text NOT NULL,
  language text,                 -- LanguageRegistry 값, 미판별 시 NULL
  size bigint NOT NULL,
  line_count int,                -- binary면 NULL
  content_hash text NOT NULL,    -- git blob OID(SHA-1) 재사용
  UNIQUE (snapshot_id, path)
)
-- INDEX (snapshot_id), INDEX (snapshot_id, language)
```

**V4 — evidence / area**

```sql
evidences (
  id bigserial PK,
  project_id bigint NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('FILE_LINE','COMMIT','PR','ISSUE','CONFIG','DEPENDENCY','URL')),
  file_path text, line_start int, line_end int,
  commit_sha text, pr_number int, url text,
  excerpt text,
  created_by text NOT NULL CHECK (created_by IN ('STATIC','AI')),  -- Phase 1은 STATIC만
  created_at timestamptz NOT NULL DEFAULT now()
)
evidence_links (
  id bigserial PK,
  evidence_id bigint NOT NULL REFERENCES evidences ON DELETE CASCADE,
  subject_type text NOT NULL,    -- 'AREA','FEATURE','NODE','FINDING',... (Phase 1: AREA/NODE/FEATURE)
  subject_id bigint NOT NULL,
  UNIQUE (evidence_id, subject_type, subject_id)
)
project_areas (
  id bigserial PK,
  snapshot_id bigint NOT NULL REFERENCES snapshots ON DELETE CASCADE,
  area_type text NOT NULL,       -- 12종 enum (§9.2), CHECK 제약
  confidence numeric(3,2) NOT NULL,  -- 0.00~1.00 (graph_edges의 3등급 enum과 다름에 주의)
  summary text,
  UNIQUE (snapshot_id, area_type)
)
area_technologies (
  id bigserial PK,
  area_id bigint NOT NULL REFERENCES project_areas ON DELETE CASCADE,
  name text NOT NULL, version text,
  UNIQUE (area_id, name)
)
```

**V5 — git 원본 데이터** (AI 생성물과 분리 저장 원칙 §7.2)

```sql
commits (
  id bigserial PK,
  project_id bigint NOT NULL REFERENCES projects ON DELETE CASCADE,
  sha text NOT NULL, author text, message text,
  committed_at timestamptz NOT NULL,
  additions int, deletions int,
  UNIQUE (project_id, sha)
)
commit_files (
  id bigserial PK,
  commit_id bigint NOT NULL REFERENCES commits ON DELETE CASCADE,
  path text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('ADD','MODIFY','DELETE','RENAME','COPY'))
)
branches ( id, project_id FK, name text NOT NULL, head_sha text NOT NULL, UNIQUE (project_id, name) )
tags     ( id, project_id FK, name text NOT NULL, head_sha text NOT NULL, UNIQUE (project_id, name) )
pull_requests (
  id bigserial PK,
  project_id bigint NOT NULL REFERENCES projects ON DELETE CASCADE,
  number int NOT NULL, title text, body text,
  state text NOT NULL,           -- OPEN/CLOSED/MERGED
  author text, merged_at timestamptz, head_sha text, base_sha text,
  UNIQUE (project_id, number)
)
-- INDEX commits (project_id, committed_at DESC), commit_files (commit_id)
```

**V6 — 통합 그래프**

```sql
graph_nodes (
  id bigserial PK,
  snapshot_id bigint NOT NULL REFERENCES snapshots ON DELETE CASCADE,
  node_type text NOT NULL,       -- §6.2 node_type enum (CHECK 없이 text — 확장 가능 enum)
  natural_key text NOT NULL,     -- 안정 식별자 (1-8에서 규칙 문서화), 멱등 upsert 키
  name text NOT NULL,
  file_id bigint REFERENCES files ON DELETE SET NULL,
  line_start int, line_end int,
  area_type text,                -- §9.3 뷰 필터링용 태그
  metadata jsonb,
  UNIQUE (snapshot_id, natural_key)
)
graph_edges (
  id bigserial PK,
  snapshot_id bigint NOT NULL REFERENCES snapshots ON DELETE CASCADE,
  source_node_id bigint NOT NULL REFERENCES graph_nodes ON DELETE CASCADE,
  target_node_id bigint NOT NULL REFERENCES graph_nodes ON DELETE CASCADE,
  edge_type text NOT NULL,       -- §6.2 edge_type enum
  confidence text NOT NULL DEFAULT 'CONFIRMED' CHECK (confidence IN ('CONFIRMED','LIKELY','POSSIBLE')),
  metadata jsonb,
  UNIQUE (snapshot_id, source_node_id, target_node_id, edge_type)
)
-- INDEX edges (snapshot_id, source_node_id), (snapshot_id, target_node_id), nodes (snapshot_id, node_type)
```

**V7 — infra_resources**

```sql
infra_resources (
  id bigserial PK,
  node_id bigint NOT NULL UNIQUE REFERENCES graph_nodes ON DELETE CASCADE,
  kind text NOT NULL,            -- CONTAINER/CLOUD/CI/...
  name text NOT NULL,
  source_path text NOT NULL
)
```

**V8 — endpoint / entity / route 전용 조회 테이블**

```sql
api_endpoints (
  id bigserial PK,
  node_id bigint NOT NULL UNIQUE REFERENCES graph_nodes ON DELETE CASCADE,
  http_method text NOT NULL,
  path text NOT NULL,            -- path variable 정규화형 (/api/orders/{id})
  handler_key text NOT NULL      -- 핸들러 메서드의 natural_key
)
frontend_routes (
  id bigserial PK,
  node_id bigint NOT NULL UNIQUE REFERENCES graph_nodes ON DELETE CASCADE,
  path text NOT NULL,
  component_key text             -- Phase 2(ts-analyzer)에서 채움
)
db_entities (
  id bigserial PK,
  node_id bigint NOT NULL UNIQUE REFERENCES graph_nodes ON DELETE CASCADE,
  entity_name text NOT NULL,
  table_name text NOT NULL,
  source text NOT NULL CHECK (source IN ('JPA','MIGRATION'))
)
```

**V9 — feature**

```sql
features (
  id bigserial PK,
  snapshot_id bigint NOT NULL REFERENCES snapshots ON DELETE CASCADE,
  name text NOT NULL, description text,
  parent_id bigint REFERENCES features ON DELETE CASCADE,
  detection text NOT NULL CHECK (detection IN ('STATIC','AI_ASSISTED')),  -- Phase 1은 STATIC만
  confidence numeric(3,2) NOT NULL,
  UNIQUE (snapshot_id, name, parent_id)
)
feature_links (
  id bigserial PK,
  feature_id bigint NOT NULL REFERENCES features ON DELETE CASCADE,
  node_id bigint NOT NULL REFERENCES graph_nodes ON DELETE CASCADE,
  role text NOT NULL,            -- UI/API/SERVICE/DATA/INFRA
  UNIQUE (feature_id, node_id, role)
)
```

Phase 1에서 만들지 않는 §6.2 테이블(참고): `flows`, `flow_steps`, `analysis_findings`(Phase 2), `summaries`, `ai_*`(Phase 3), `notes`, `note_references`, `tasks`, `task_goals`, `learning_records`(Phase 4).

---

## 4. Task별 실행 계획

### 1-1 · be — GitHub OAuth 로그인 + PAT 등록 + 토큰 암호화 저장

**목표 / 완료 기준:** PAT 또는 OAuth로 인증한 사용자가 자신의 private repo 목록을 조회할 수 있다. 토큰은 AES-256-GCM(건별 고유 nonce, key_version)으로만 저장되고 로그/응답에 노출되지 않는다. **OAuth App 자격증명이 없어도 앱 기동·PAT 경로·CI가 전부 정상**이다.

**구현 체크리스트:**
- [ ] 의존성: `spring-boot-starter-security-oauth2-client`(+test), `org.springframework.session:spring-session-data-redis`(BOM 관리)
- [ ] `V2__github_credentials_key_version.sql` — §3 참조
- [ ] `auth` 패키지: `TokenCryptoService` — AES-256-GCM, 12바이트 랜덤 nonce/건, 출력 포맷 `base64(nonce‖ct‖tag)` + `key_version` 저장; `TokenEncKeyProperties` — 시작 시 base64 디코드 32바이트 검증 실패 시 fail-fast (§18 TODO ①)
- [ ] `users`/`github_credentials` JPA 엔티티 + upsert 서비스 (`toString`에서 토큰 제외, 응답 DTO에 토큰 필드 자체가 없음)
- [ ] OAuth: `application.yml`에 github registration(scope `read:user`,`repo`; client-id/secret은 env `GITHUB_CLIENT_ID/SECRET`), 로그인 성공 핸들러에서 users+credentials(kind=OAUTH) upsert 후 FE origin으로 redirect. client-id 미설정 시 OAuth 자동구성이 비활성되어도 기동에 지장 없음을 테스트로 고정
- [ ] PAT: `POST /api/auth/pat` — RestClient로 GitHub `/user` 검증 → users+credentials(kind=PAT) upsert → 세션 생성 (비로그인 상태에서 호출 가능해야 함)
- [ ] `github` 패키지: `GithubApiClient`(RestClient 단일 빌더, base `https://api.github.com`, Bearer 토큰 주입, User-Agent) + `GET /api/github/repos?query&page`(affiliation=owner,collaborator,organization_member)
- [ ] `AuthController`: `GET /api/auth/session`(permitAll, `{ authenticated, oauthEnabled, user? }`), `POST /api/auth/logout`
- [ ] SecurityConfig 개편(§18 TODO ②③): STATELESS 해제 → Spring Session Redis, CSRF 재활성화(`CookieCsrfTokenRepository.withHttpOnlyFalse()` + SPA 핸들러), 세션 쿠키 SameSite=Lax, CORS는 설정값 `app.cors.allowed-origins`(기본 `http://localhost:5173`) allow-list + credentials — wildcard 금지
- [ ] springdoc `springdoc-openapi-starter-webmvc-api` 추가, `/v3/api-docs` permitAll (openapi 파이프라인 기반, 1-6에서 소비)
- [ ] ArchUnit 베이스라인 테스트 도입(§19): controller→repository 직접 참조 금지, 패키지 경계(`common`은 도메인 패키지 참조 금지)

**테스트 체크리스트:**
- [ ] 단위: 암호화 라운드트립, 같은 평문 2회 암호화 시 nonce/암호문 상이, 변조 시 복호화 실패, 키 길이 오류 시 기동 실패
- [ ] 통합: PAT 등록(MockRestServiceServer로 `/user` 200/401) → 세션 발급 → `/api/github/repos` 조회(모의 응답 매핑 검증)
- [ ] 통합: CSRF 없는 POST 403, CORS preflight 허용/차단, 비인가 요청 401 유지
- [ ] 통합: `GITHUB_CLIENT_ID` 미설정 컨텍스트 기동 성공 + `/api/auth/session`의 `oauthEnabled=false`
- [ ] DB에 저장된 값이 평문 토큰과 불일치(암호문) 확인

**선행:** 없음 (외부: OAuth App은 수동 검증 시에만). **위험:** Boot 4에서 OAuth2 autoconfig 패키지 이동(`org.springframework.boot.security.oauth2.*`) — 마이그레이션 가이드 기준으로 import 작성. 세션 전환으로 기존 Phase 0 보안 테스트 깨짐 → 같은 PR에서 테스트 갱신.

### 1-2 · be — Repository import + JGit clone + snapshot 생성

**목표 / 완료 기준:** `POST /api/projects`로 owner/repo를 등록하면 IMPORT job이 clone → HEAD SHA로 snapshot을 생성한다. public/private(저장 토큰) 모두 동작하고, 재분석 시 fetch 재사용 + 새 snapshot 생성 + 성공 시에만 `current_snapshot` 원자 교체(§8.3).

**구현 체크리스트:**
- [ ] 의존성: `org.eclipse.jgit`(최신 안정)
- [ ] `github.CloneService`: `Git.cloneRepository()`/기존 clone은 fetch, 자격증명 `UsernamePasswordCredentialsProvider("x-access-token", token)`, 위치 `${app.data-dir}/repos/{projectId}`(기본 `~/.code-intelligence`), `app.import.clone-depth` 옵션(§7.2)
- [ ] SSRF 차단(§18): URL 직접 입력 없음 — `owner`/`repo`를 `^[A-Za-z0-9_.-]{1,100}$` 검증 후 서버가 `https://github.com/{owner}/{repo}.git` 구성
- [ ] `project` 패키지: `ProjectService`/`ProjectController` — 생성/목록/상세/삭제(clone 디렉터리 정리), **모든 조회·변경에 소유자(user_id) 검증** (IDOR 방지)
- [ ] IMPORT job 정의(1-3 프레임워크 위): step `CLONE` → `CREATE_SNAPSHOT`(HEAD sha, status=ANALYZING) → 이후 step은 1-4~1-11에서 순차 등록
- [ ] `POST /api/projects/{id}/reanalyze`: 새 snapshot + 전체 파이프라인, 완료 시 `current_snapshot` 교체·이전 결과 유지, 실패 시 snapshot FAILED
- [ ] 파이프라인 전 step 완료 시 snapshot READY 전환 로직(마지막 step에서 수행)

**테스트 체크리스트:**
- [ ] 통합: fixture 디렉터리로 만든 로컬 git repo(§6의 `FixtureRepo` 헬퍼) import → clone 디렉터리 존재 + snapshot sha 일치
- [ ] 단위: owner/repo 검증 거부 케이스(`../`, URL, 공백), 토큰 선택 로직(PAT/OAuth)
- [ ] 통합: 재분석 중 실패 유도 → 기존 snapshot·current_snapshot 유지 확인
- [ ] 통합: 타 사용자 project 접근 404/403

**선행:** 1-1, 1-3. **위험:** 대형 repo clone 시간 — depth 옵션 + Job 진행 표시로 대응(§20 #1). 실 GitHub 대상 테스트는 CI 제외(수동 스모크).

### 1-3 · be — 비동기 Job 프레임워크

**목표 / 완료 기준:** `analysis_jobs`/`analysis_job_steps`(V1 기존 테이블)를 소스 오브 트루스로 하는 step 상태 머신이 동작한다. 실패한 step부터 재시도되고(성공 step 스킵), 진행 상황이 Redis pub/sub → SSE로 프런트에 전달된다(§8.2~8.3).

**구현 체크리스트:**
- [ ] `job` 패키지: `JobType`(IMPORT/REANALYZE), `StepExecutor` 인터페이스(`stepKey()`, `run(StepContext)` — **멱등 계약**: 재실행 시 upsert), `StepRegistry`(JobType별 순서 리스트 — 1-2~1-11이 여기 등록), `JobRunner`
- [ ] 실행: `spring.threads.virtual.enabled=true` + 전용 `TaskExecutor`, 동일 project 동시 job 1개 제한(QUEUED 직렬화)
- [ ] 상태 전이: QUEUED→RUNNING→DONE/FAILED/CANCELLED; step별 progress_pct/started_at/finished_at/error 기록; 기동 시 잔존 RUNNING job → FAILED("interrupted") 복구
- [ ] `POST .../jobs/{jobId}/retry` — FAILED job의 실패 step부터 재실행
- [ ] 진행 이벤트: Redis pub/sub 채널 `job:{jobId}` publish → `GET .../jobs/{jobId}/events` SSE(SseEmitter, 15s heartbeat). FE 폴링 fallback용 `GET .../jobs/{jobId}`(job+steps)
- [ ] 예외 격리: step 예외 → 해당 step FAILED + job FAILED, error 메시지 저장(스택은 로그만)

**테스트 체크리스트:**
- [ ] 통합(Testcontainers redis): fake step 3개(성공/실패/미도달) → 상태·seq 검증 → retry → 실패 step부터 재개, 성공 step의 `run()` 미호출 확인
- [ ] 통합: SSE 구독 중 이벤트 수신(RestTestClient 스트림 or 직접 emitter 검증)
- [ ] 단위: 기동 복구, 동시 실행 제한

**선행:** 없음. **위험:** SSE 커넥션 수명/프록시 — heartbeat + FE 폴링 fallback으로 이중화.

### 1-4 · be — 파일 인벤토리 + 언어 감지 + 파일 서빙 API

**목표 / 완료 기준:** snapshot commit 기준으로 `files`가 채워지고(경로/언어/크기/라인/해시), fixture 골든 테스트가 통과한다. 파일트리·파일내용 API가 git object에서 직접 서빙되어 path traversal이 원천 차단된다.

**구현 체크리스트:**
- [ ] `analysis.core`: `FileInventoryStep` — JGit `TreeWalk`를 snapshot commit에 고정(작업트리 아님 — 결정적), `content_hash`=git blob OID 재사용, binary 감지(널바이트), line_count 계산
- [ ] `LanguageRegistry`: 확장자→언어 매핑(java/ts/tsx/js/sql/yml/yaml/xml/gradle/kts/tf/dockerfile/md/json/html/css …), 언어 분포 집계 API 제공(§8.1 step 3의 "언어 분포"; 프레임워크 후보 감지는 1-5 detector가 manifest를 직접 읽는 것으로 통합 — 별도 저장 없음)
- [ ] 상한(§20 #1): `app.analysis.max-files`(기본 20000), `app.analysis.max-file-size`(기본 1MB) — 초과 파일 skip + CONFIG evidence로 경고 기록
- [ ] API: `GET /api/projects/{id}/tree?path=`(디렉터리 1-depth, 폴더 lazy 로딩용), `GET /api/projects/{id}/file?path=`(내용+언어; git object 조회이므로 파일시스템 경로 미사용, 경로는 인벤토리 존재 여부로 검증, 크기 상한 초과 시 413)
- [ ] `build.gradle.kts` spotless에 `targetExclude("src/test/resources/**")` 추가 (fixture 보호 — §1.4 P1)
- [ ] fixture 4종 + `FixtureRepo` 테스트 헬퍼 작성(§6 명세 — 고정 PersonIdent/타임스탬프로 커밋해 SHA 결정적)

**테스트 체크리스트:**
- [ ] 골든: spring-mini 인벤토리(파일 수/언어 분포/특정 파일 line_count·hash), react-mini 언어 분포(TypeScript 최다)
- [ ] 단위: binary 감지, 상한 초과 skip+경고 evidence
- [ ] 통합: `file?path=` 존재하지 않는 경로 404, `../`·절대경로·인코딩 우회 시도 전부 404(인벤토리 키 검증), 멱등 재실행 시 중복 row 없음

**선행:** 1-2. **위험:** 대형 repo 인벤토리 시간 — TreeWalk 스트리밍 + 배치 insert.

### 1-5 · be — Project Area Detection 엔진 + 12영역 detector + evidence

**목표 / 완료 기준:** fixture 4종 각각에서 기대 영역이 기대 confidence 이상으로 감지되고, 모든 감지에 클릭 가능한 evidence(파일/의존성)가 연결된다. confidence ≥ 0.5 영역이 `project_area_selections`에 기본 선택으로 반영된다(§9.1).

**구현 체크리스트:**
- [ ] `analysis.area`: `AreaType` enum 12종(BACKEND, FRONTEND, MOBILE, DATABASE, INFRASTRUCTURE, DEVOPS, SECURITY, TESTING, AI_ML, DOCUMENTATION, BUILD_TOOLING, OTHER), `AreaSignal(area, technology, evidence, weight)`, `AreaDetector` SPI + registry(§9.1 — 구현체 추가만으로 확장, 요구사항 §31)
- [ ] 12개 detector를 §9.2 시그널 표대로 구현 — manifest 파싱(package.json JSON, build.gradle/pom 문자열·XML 스캔), 경로 글롭(`src/main/java`, `**/migration/**`, `Dockerfile`, `.github/workflows/*.yml` …), 어노테이션 시그널은 Phase 1에선 파일 내용 정규식 수준(정밀 AST 반영은 1-8 이후 개선 여지)
- [ ] confidence 계산: detector별 가중 시그널 합산 → `min(1.0, Σweight)` — 가중치 표를 코드와 함께 문서화(주석), fixture 골든으로 회귀 고정
- [ ] `evidence` 패키지: `Evidence`/`EvidenceLink` 엔티티+서비스(V4), 영역별 시그널을 evidence(kind=FILE_LINE/CONFIG/DEPENDENCY)로 영속화 + `evidence_links(subject_type='AREA')`
- [ ] `AreaDetectionStep` 등록(IMPORT 파이프라인 step 4). 기본 선택 반영은 **최초 분석 시에만** upsert(사용자 수정 보존), OTHER는 자동 선택 제외
- [ ] API: `GET /api/projects/{id}/areas`(confidence, summary, technologies, 관련 파일 수, evidence 목록), `GET/PUT /api/projects/{id}/area-selections`

**테스트 체크리스트:**
- [ ] 단위: detector별 대표 시그널 케이스(§9.2 행마다 최소 1개)
- [ ] 골든: fixture 4종 기대 영역/최소 confidence/기대 기술(§6 명세 표와 일치)
- [ ] 통합: evidence의 file_path가 실제 `files`에 존재, 재분석 시 사용자 선택 보존
- [ ] 경계: 빈 repo → OTHER만 또는 영역 0개, 예외 없이 완료

**선행:** 1-4. **위험:** 가중치 튜닝 오탐 — fixture 골든 + 실 repo 스모크에서 임계 0.5 기준 검수, 가중치는 상수로 한곳에 모아 조정 용이하게.

### 1-6 · fe — Import Wizard UI + openapi-typescript 파이프라인

**목표 / 완료 기준:** 인증(OAuth 버튼/PAT 입력) → repo 검색·선택 → import 진행(step 체크리스트, 요구사항 §32 형태) → 영역 카드(confidence/기술/파일 수/근거) → 선택 저장까지 위저드가 동작하고, 저장된 선택이 서버에 반영된다. FE API 호출은 전부 생성 타입 기반이다.

**구현 체크리스트:**
- [ ] **openapi-typescript 파이프라인(도입 시점: 본 PR)**: backend `OpenApiSpecExportTest`가 `/v3/api-docs` 응답을 `backend/build/openapi.json`으로 저장 → Gradle `syncOpenApiSpec`(Copy task)가 `docs/api/openapi.json`으로 복사(커밋 대상) → FE `npm run generate:api`(openapi-typescript)로 `frontend/src/api/schema.d.ts` 생성(커밋 대상) → CI에 재생성 후 `git diff --exit-code` 검사 추가
- [ ] `src/api/client.ts`: 생성된 `paths` 타입을 쓰는 얇은 fetch 래퍼(런타임 의존성 추가 없음) — `credentials` 포함, mutation 시 `XSRF-TOKEN` 쿠키 → `X-XSRF-TOKEN` 헤더, 401 공통 처리
- [ ] Vite dev proxy: `/api`, `/oauth2`, `/login` → `http://localhost:8080` (쿠키 same-origin 단순화)
- [ ] 위저드(`features/import/`): ① `GET /api/auth/session`으로 인증 상태 분기 — OAuth 버튼(`oauthEnabled`일 때만) + PAT 입력 폼 ② repo 검색/선택(`GET /api/github/repos`) ③ `POST /api/projects` → SSE(`.../events`) 구독 step 체크리스트, 실패 시 에러+재시도 버튼(`POST .../retry`), SSE 불가 시 TanStack Query 폴링 fallback ④ 완료 시 영역 카드 그리드 + 체크박스(기본값=서버 선택) → `PUT /api/projects/{id}/area-selections` → 워크스페이스 이동
- [ ] 영역 카드: confidence 배지, 기술 칩, 관련 파일 수, 근거 목록(파일 경로 — Code 탭 딥링크는 1-12 이후 활성)
- [ ] ProjectsPage의 `demo-project` 임시 링크 제거, Import 시작 버튼으로 대체
- [ ] devDeps: `openapi-typescript`, `msw`

**테스트 체크리스트:**
- [ ] Vitest+RTL(+msw): 위저드 스텝 전환, PAT 폼 제출/에러, job step 체크리스트 렌더(진행/실패/재시도), 영역 선택 저장 mutation
- [ ] 타입: 생성 `schema.d.ts` 기준 client 래퍼 타입 검사(typecheck로 보장)
- [ ] CI: 스펙-타입 동기화 검사 job 동작 확인

**선행:** 1-1, 1-3, 1-5. **위험:** SSE와 프록시 호환 — 폴링 fallback 필수. OAuth 리다이렉트 흐름은 로컬 수동 검증(OAuth App 있을 때).

### 1-7 · be — Git metadata 수집 (commits/branches/tags/PR)

**목표 / 완료 기준:** JGit으로 commit/branch/tag가, GitHub API로 PR이 수집·연결되고(V5), fixture 골든과 rate limit 백오프 테스트가 통과한다(§7.2, §13).

**구현 체크리스트:**
- [ ] `history` 패키지: `GitMetadataStep` — RevWalk로 commit(author/message/committed_at), 부모와의 DiffFormatter로 additions/deletions·commit_files(change_type A/M/D/R/C; merge commit은 첫 부모 기준), branches/tags upsert. 상한 `app.analysis.max-commits`(기본 5000, 초과 시 최신 N + 경고 evidence)
- [ ] PR 수집: `GithubApiClient`에 PR 목록(REST, state=all, per_page=100, 페이지네이션) — GraphQL 배치·ETag 캐시는 Phase 2 이월(§7.2의 최적화 항목; Phase 1은 full fetch)
- [ ] Rate limit 백오프: RestClient 응답의 403/429 + `X-RateLimit-Remaining`/`Retry-After`/`X-RateLimit-Reset` 해석 → 지수 백오프+지터 재시도(최대 횟수 설정), 소진 시 step FAILED로 남겨 Job 재개(§8.3)와 연결. 백오프 정책은 Clock 주입으로 테스트 가능하게
- [ ] API: `GET .../commits?cursor&branch`(페이지네이션), `GET .../commits/{sha}`(+commit_files), `GET .../commits/{sha}/diff?path=`(JGit 즉석 unified diff — §13 "당시 뷰"의 Phase 1 단면), `GET .../branches`, `GET .../tags`, `GET .../pull-requests?state=`
- [ ] PR 없음/토큰 없음(public) 경로: PR step은 경고와 함께 skip 가능(실패 아님)

**테스트 체크리스트:**
- [ ] 골든: `FixtureRepo`로 만든 3-commit + 1-branch + 1-tag 저장소 → 커밋 수/변경 파일/추가·삭제 라인 수 일치(고정 타임스탬프로 결정적)
- [ ] 통합: MockRestServiceServer — PR JSON 2페이지 페이지네이션 매핑, 403(rate limit) → 백오프 후 성공, 연속 실패 → step FAILED
- [ ] 통합: diff API가 기대 unified diff 반환, 존재하지 않는 sha 404

**선행:** 1-2, 1-3. **위험:** 대형 히스토리의 additions/deletions 계산 비용 — max-commits 상한 + diff 계산은 RenameDetection 끄고 수행.

### 1-8 · be — CodeAnalyzer SPI + JavaAnalyzer + 그래프 조회 API

**목표 / 완료 기준:** spring-mini 골든 그래프(노드/edge 타입별 카운트 + 핵심 관계)와 일치한다. 미해석 호출은 POSSIBLE confidence로 저장된다(§10.2). 심볼/관계 조회 API가 1-12를 지원한다.

**구현 체크리스트:**
- [ ] 의존성: `com.github.javaparser:javaparser-symbol-solver-core`(최신 안정)
- [ ] `analysis.core`: `CodeAnalyzer` SPI(`supports(FileInventory)`, `analyze(AnalysisContext): AnalysisResult(nodes/edges/evidences)`) + registry(§10.1), `SourceParsingStep`+`GraphBuildStep`(파이프라인 step 6~7 — analyzer 실행 → `(snapshot_id, natural_key)` 멱등 upsert → edge 해석)
- [ ] **natural_key 규칙 문서화**(코드 상수+주석): `file:{path}`, `pkg:{fqn}`, `type:{fqn}`, `method:{fqn}#{name}({erasedParams})`, `field:{fqn}#{name}`, `endpoint:{METHOD} {path}`, `table:{name}`, `entity:{fqn}`, `container:{composePath}:{service}`, `ci:{workflowPath}`
- [ ] `analysis.java.JavaAnalyzer`: CombinedTypeSolver(Reflection + 소스 루트별 JavaParserTypeSolver 자동 탐색) — 추출: PACKAGE/CLASS/INTERFACE/ENUM/ANNOTATION/FIELD/METHOD 노드(라인 범위), IMPORTS/DECLARES/CONTAINS/EXTENDS/IMPLEMENTS/ANNOTATED_BY edge, 메서드 호출 그래프 — 해석 성공 CALLS(CONFIRMED), 실패 시 이름 기반 후보 CALLS(POSSIBLE, metadata에 후보 fqn)
- [ ] 파일 단위 예외 격리 + 파서 타임아웃(파일당) — 실패 파일은 evidence 경고로 기록하고 계속(§20 #3)
- [ ] 노드 `area_type` 태깅: Phase 1은 Java 소스=BACKEND, test 경로=TESTING 수준의 규칙 기반(§9.3 필터 동작에 필요)
- [ ] API: `GET .../symbols?path=`(파일의 노드 목록), `GET .../nodes/{nodeId}`(상세+evidence), `GET .../nodes/{nodeId}/relations?direction=in|out&types=CALLS,...`(1-depth; recursive CTE 확장은 Phase 2)

**테스트 체크리스트:**
- [ ] 골든: spring-mini — 타입별 노드 카운트, 지정 관계 존재(OrderController.list→OrderService.findAll CALLS CONFIRMED 등), 라인 범위 정확, 외부 타입(JpaRepository) EXTENDS는 이름 기반 저장
- [ ] 단위: natural_key 생성기(오버로드 메서드 구분), 미해석 호출 POSSIBLE 케이스
- [ ] 통합: step 2회 실행 시 노드/edge 수 불변(멱등), 파싱 불가 Java 파일 1개 섞여도 step 성공
- [ ] ArchUnit: `analysis.java`는 `analysis.core` SPI를 통해서만 노출(파이프라인이 구현체 직접 참조 금지)

**선행:** 1-4. **위험:** SymbolSolver 해석률(§20 #3 — 동적 호출/Lombok) — Lombok 정밀 보정은 하지 않고 known limitation으로 문서화, 미해석은 POSSIBLE 저장으로 데이터 손실 방지.

### 1-9 · be — 설정/인프라 분석기 (build/yml/Docker/CI/SQL)

**목표 / 완료 기준:** fixture에서 의존성/스키마/컨테이너/CI 추출 결과가 골든과 일치한다(§10.3). infra_resources(V7)가 채워진다.

**구현 체크리스트:**
- [ ] 의존성: `com.github.jsqlparser:jsqlparser`(최신 안정)
- [ ] `analysis.config` 패키지, 전부 `CodeAnalyzer` 구현체로 registry 등록:
  - [ ] `BuildFileAnalyzer`: pom.xml(XML DOM)·build.gradle(.kts)(구조적 정규식) → DEPENDENCY evidence + 프레임워크 확정(spring-boot 등) + area_technologies 버전 보강
  - [ ] `SqlMigrationAnalyzer`: Flyway 파일명 순 정렬 → JSqlParser로 CREATE/ALTER 파싱 → DB_TABLE 노드(최종 스키마) + MIGRATION 노드 + 변천 evidence, `db_entities(source='MIGRATION')` 행
  - [ ] `DockerAnalyzer`: Dockerfile 명령(FROM/EXPOSE/CMD) + compose 서비스/포트/depends_on/환경변수(SnakeYAML) → CONTAINER 노드 + `infra_resources(kind='CONTAINER')`, 서비스 간 depends_on은 DEPENDS_ON edge
  - [ ] `GithubActionsAnalyzer`: workflow 트리거/job/step → CI_PIPELINE 노드 + `infra_resources(kind='CI')`
  - [ ] `YamlConfigAnalyzer`: application.yml의 datasource/redis/kafka 설정 → CONFIG 노드 + CONFIGURED_BY evidence(cross-domain edge 연결은 Phase 2 §11.3)
- [ ] 각 분석기 산출 노드에 area_type 태깅(INFRASTRUCTURE/DEVOPS/DATABASE)

**테스트 체크리스트:**
- [ ] 단위: 분석기별 파싱 케이스(잘못된 YAML/SQL은 경고 후 skip — step 실패 금지)
- [ ] 골든: infra-mini(CONTAINER 2, CI_PIPELINE 1), fullstack-mini(CONTAINER 3 + DEPENDS_ON, CI 1, pom 의존성), spring-mini(DB_TABLE `orders` 1, MIGRATION 1, gradle 의존성 목록)
- [ ] 통합: 멱등 재실행

**선행:** 1-8. **위험:** build.gradle 자유 문법 — 정규식 스캔의 한계는 evidence excerpt로 투명화, 미검출은 감지 실패일 뿐 오류 아님.

### 1-10 · be — API endpoint + JPA entity 추출 + 레이어 태깅 + Architecture 프로젝션 API

**목표 / 완료 기준:** spring-mini에서 endpoint 3건(메서드/경로 정확), entity→table 매핑 1건, 레이어 태그가 골든과 일치한다. Architecture 프로젝션 API(§12.2)가 1-13이 소비할 응답을 반환한다.

**구현 체크리스트:**
- [ ] `analysis.java.SpringExtractor`(JavaAnalyzer 후처리): `@RestController`/`@Controller`+`@RequestMapping`·`@Get/Post/Put/Delete/PatchMapping` → class-level+method-level 경로 결합, path variable `{id}` 정규화 → API_ENDPOINT 노드 + `api_endpoints`(handler_key=메서드 natural_key) + EXPOSES edge(controller method→endpoint)
- [ ] `@Entity`/`@Table` → DB_ENTITY 노드 + `db_entities(source='JPA')` — table_name은 `@Table(name)` 우선, 없으면 camel→snake(Hibernate 기본 물리 전략). MAPS_TO edge(↔migration 테이블)는 Phase 2 §11.2
- [ ] 레이어 태깅: `@RestController→CONTROLLER`, `@Service→SERVICE`, `@Repository`(+ Spring Data 인터페이스)`→REPOSITORY`, `@Entity→ENTITY`, `@Configuration→CONFIG` — `graph_nodes.metadata.layer`
- [ ] API: `GET .../endpoints`(목록), `GET .../architecture?view=backend|system&areas=` — backend: 레이어 그룹(스윔레인) + 그룹 간 집계 edge(CALLS 수), system: CONTAINER/CI/CONFIG 등 인프라 노드 + Java 모듈 집계(별도 저장 없는 프로젝션 §12.2), `areas` 파라미터로 area_type 필터(§9.3)
- [ ] V8 마이그레이션(api_endpoints/db_entities/frontend_routes)

**테스트 체크리스트:**
- [ ] 골든: spring-mini — `GET /api/orders`, `GET /api/orders/{id}`, `POST /api/orders` 3건 정확, `Order→orders` 매핑, 레이어별 노드 수(CONTROLLER 1/SERVICE 1/REPOSITORY 1/ENTITY 1/CONFIG 1)
- [ ] 단위: 경로 결합 규칙(클래스 base 없음/있음, 후행 슬래시), path variable 정규화, snake_case 변환
- [ ] 통합: projection 응답 구조(그룹/노드/edge 집계 수), areas 필터 동작

**선행:** 1-8 (병합은 V7 이후). **위험:** RequestMapping 변형(consumes, 배열 경로) — 배열 경로는 endpoint 복수 생성, 그 외 속성 무시(문서화).

### 1-11 · be — Feature 기본 추출 (경로 prefix + 패키지 군집)

**목표 / 완료 기준:** spring-mini에서 기대 feature("Orders")와 links(API/SERVICE/DATA 역할)가 생성된다(§12.1의 정적 1~2단계; AI 라벨링은 Phase 3).

**구현 체크리스트:**
- [ ] `analysis.feature.FeatureDetectionStep`: 시드 군집 — endpoint 경로의 첫 유효 세그먼트(`/api` 등 공통 prefix 제거 후) 그룹핑, endpoint 없는 컨트롤러/서비스는 패키지 단위 군집으로 보완
- [ ] 군집별 그래프 탐색: EXPOSES 역방향 handler → CALLS 1~2 hop → SERVICE/REPOSITORY/ENTITY 노드 수집 → `feature_links(role=API/SERVICE/DATA)` (UI role은 Phase 2)
- [ ] 이름: 세그먼트 capitalize("orders"→"Orders"), detection=STATIC, confidence: prefix 군집 0.8 / 패키지 보완 군집 0.6 (상수로 관리)
- [ ] API: `GET /api/projects/{id}/features` — 트리(parent_id) + links(노드 요약 포함)
- [ ] V9 마이그레이션

**테스트 체크리스트:**
- [ ] 골든: spring-mini — feature 1개 "Orders", links ≥ 4(endpoint 3 or 대표 API 노드 + service + repository + entity)
- [ ] 단위: prefix 정규화(중첩 경로 `/api/v1/...`), 빈 endpoint repo에서 패키지 군집 fallback
- [ ] 통합: 멱등 재실행, fullstack-mini에서 Users feature 생성

**선행:** 1-10. **위험:** 군집 품질(작은 repo에서 과분할) — Phase 1은 최소 규칙으로 고정하고 병합/분리 개선은 Phase 2~3(AI 제안)로.

### 1-12 · fe — Code explorer (파일 트리 + Monaco + 심볼 패널)

**목표 / 완료 기준:** 파일 트리 탐색 → Monaco(read-only) 뷰어 → 심볼 패널의 callers/callees 클릭 시 해당 파일·라인으로 이동한다. `?path=&line=` 딥링크가 동작한다(1-13/1-15가 재사용).

**구현 체크리스트:**
- [ ] deps: `monaco-editor`, `@monaco-editor/react` — dynamic import로 코드 스플리팅
- [ ] `features/code/`: `CodePage`(3분할: 트리/뷰어/심볼 패널), workspaceTabs의 code 탭을 실제 페이지로 교체
- [ ] 파일 트리: `GET .../tree?path=` 폴더 lazy 로딩, 언어 아이콘, 현재 파일 하이라이트
- [ ] 뷰어: read-only, 언어 하이라이트(files.language 매핑), `line` 파라미터로 revealLine + line decoration(Evidence 하이라이트의 기반)
- [ ] 심볼 패널: `GET .../symbols?path=`로 현재 파일 심볼 목록, 심볼 선택 시 `GET .../nodes/{id}/relations`로 callers/callees/extends 렌더 — 각 항목 클릭 → 대상 노드의 file/line 딥링크 이동
- [ ] URL 상태: `/projects/:id/code?path=...&line=...` — 외부(위저드 evidence, Architecture 노드, Features 링크)에서 진입하는 공용 딥링크 유틸 제공
- [ ] 대용량/binary 파일: 서버 413/binary 응답 시 안내 UI

**테스트 체크리스트:**
- [ ] Vitest+RTL(+msw): 트리 lazy 로딩/탐색, 심볼 패널 렌더·클릭 네비게이션(라우터 검증), 딥링크 파싱 유틸 단위 테스트
- [ ] Monaco는 얇은 래퍼로 감싸고 테스트에서 mock (jsdom 비호환)

**선행:** 1-4, 1-6(클라이언트), 1-8. **위험:** Monaco 번들 크기 — lazy chunk 분리, 초기 로드 측정.

### 1-13 · fe — Architecture 뷰 (React Flow, Backend/System)

**목표 / 완료 기준:** Backend 뷰(레이어 스윔레인)와 System 뷰(인프라 포함)가 렌더되고, 노드 클릭 시 Code 탭 해당 위치로 이동한다. 사이드바 영역 선택 변경이 재분석 없이 즉시 필터로 반영된다(§9.3, §12.2).

**구현 체크리스트:**
- [ ] deps: `@xyflow/react`, `elkjs`(layered 자동 배치 — 웹워커 실행)
- [ ] `features/architecture/`: projection API(`GET .../architecture?view=&areas=`) 소비 → ELK 레이아웃 → React Flow 노드/edge 렌더
- [ ] Backend 뷰: Controller/Service/Repository/Entity/Config 레이어 그룹, edge에 집계 호출 수 라벨; System 뷰: CONTAINER/CI/CONFIG + 코드 모듈 상위 노드
- [ ] 노드 클릭 → 1-12 딥링크(`file`/`line`) 이동; endpoint 노드는 메서드/경로 툴팁
- [ ] 영역 선택(`area-selections`)을 쿼리 파라미터로 반영 — 선택 해제된 영역 노드 제외
- [ ] edge confidence(POSSIBLE 점선 등)·edge_type별 스타일 규칙

**테스트 체크리스트:**
- [ ] 단위: projection 응답 → ELK 입력 그래프 변환 함수(노드/edge/그룹 매핑)
- [ ] RTL: 노드 클릭 → 네비게이션 호출, 영역 필터 변경 시 쿼리 재요청(msw)
- [ ] React Flow 캔버스 자체는 스모크 렌더 수준(레이아웃 결과 픽셀 검증 안 함)

**선행:** 1-10, 1-12. **위험:** elkjs 레이아웃 시간(큰 그래프) — 뷰별 노드 상한 + 그룹 접기(Phase 1은 상한 경고만).

### 1-14 · fe — History 뷰 (commit/PR 타임라인, diff)

**목표 / 완료 기준:** commit 타임라인(브랜치 필터, 페이지네이션)과 commit 상세(변경 파일 목록), 파일별 diff 렌더가 정상 동작한다. PR 목록이 표시된다.

**구현 체크리스트:**
- [ ] `features/history/`: 타임라인 리스트(무한 스크롤 — TanStack Query `useInfiniteQuery` + cursor), branch/tag 셀렉터
- [ ] commit 상세: 메시지/author/시각/± 라인, 변경 파일 리스트(change_type 배지) → 파일 클릭 시 `GET .../commits/{sha}/diff?path=` 결과를 **Monaco DiffEditor**(1-12의 lazy 래퍼 재사용, 추가 의존성 없음)로 렌더
- [ ] PR 탭: `GET .../pull-requests?state=` 목록(제목/상태/author/merged_at, GitHub 링크)
- [ ] Era 타임라인은 Phase 2 명시(§13) — 탭 내 자리만 두지 않고 생략
- [ ] workspaceTabs의 history 탭을 실제 페이지로 교체

**테스트 체크리스트:**
- [ ] RTL(+msw): 타임라인 페이지네이션(cursor 연속 호출), commit 상세 렌더, change_type 표시
- [ ] diff 래퍼: unified diff 파싱 → DiffEditor 입력 변환 단위 테스트(에디터는 mock)

**선행:** 1-6, 1-7. **위험:** 거대 diff — 서버 크기 상한 + "GitHub에서 보기" 폴백 링크.

### 1-15 · fe — Home 프로젝트 카드 + 사이드바 Areas + Features 최소 탭

**목표 / 완료 기준:** Home에 §15.2 카드(감지 영역, 기술, 최근 분석 상태, 최근 commit, PR 수 — task/note 수는 Phase 4라 미표시)가 뜨고, 사이드바 프로젝트 아래 Areas 체크박스 토글이 서버 저장·뷰 필터로 즉시 반영된다. Features 탭에 읽기 전용 feature 트리가 표시된다.

**구현 체크리스트:**
- [ ] `GET /api/projects` 확장 응답 소비(카드 데이터) — HomePage/ProjectsPage의 EmptyState를 실 카드 그리드로 교체(빈 상태는 유지 + Import 유도)
- [ ] 카드: 분석 상태 배지(ANALYZING 진행 표시/READY/FAILED), 영역 칩(선택된 것 강조), 기술 요약, 마지막 commit 메시지/시각, PR 수 — 클릭 → 워크스페이스
- [ ] 사이드바(§15.1): 현재 프로젝트명 실데이터, Areas 체크박스 목록(`GET/PUT area-selections`) — 토글 시 TanStack Query 무효화로 Architecture/Features 즉시 반영(§9.3)
- [ ] Features 최소 탭(`features/features/`): `GET .../features` 트리 + 선택 시 링크된 노드 목록(role 배지) → Code 딥링크. 기획서 §21 표에 없는 항목의 **정밀화**: 워크스페이스 기본 탭(index redirect)이 features이므로 빈 placeholder를 남기지 않기 위한 최소 구현. 상세 화면(§15.2 Features)은 Phase 2
- [ ] 사이드바 하단 버전 문구 `Phase 0` → 동적/갱신

**테스트 체크리스트:**
- [ ] RTL(+msw): 카드 상태별 렌더(ANALYZING/READY/FAILED), 빈 목록 상태, Areas 토글 → PUT 호출 + 쿼리 무효화, Features 트리 렌더·딥링크
- [ ] 기존 `AppLayout.test.tsx`/`workspace.test.tsx` 회귀 통과(필요 시 갱신)

**선행:** 1-5, 1-6, 1-7, 1-11. **위험:** 없음(조합 작업). N/A — debug task 불요.

### 1-16 · sc — 보안 점검 (토큰·clone 경로·파일 서빙·세션)

**Owner agent:** `sc` / **Mode:** audit-first — Critical/High는 즉시 수정 PR(`feature/phase1-security-audit`), Medium 이하는 findings 기록.

**목표 / 완료 기준:** §18 위험 표 + Phase 1 이월 TODO ①~④ 전 항목 검증, Critical/High 0.

**Checklist:**
- [ ] 신규 진입점 위협 모델링: auth(PAT/OAuth), projects/import, jobs SSE, 파일 서빙, github proxy API
- [ ] 토큰: GCM nonce 건별 고유(코드+DB 표본 확인), key_version 저장, `TOKEN_ENC_KEY` 검증 fail-fast, 로그/응답/에러 메시지에 토큰·암호문 미노출(로그 grep 감사)
- [ ] 세션/CSRF(§18 TODO ②): Spring Session Redis 동작, CSRF 토큰 강제(모든 mutation), SameSite 쿠키, 세션 고정 보호(로그인 시 재발급)
- [ ] CORS(§18 TODO ③): allow-list만, credentials+wildcard 병용 없음
- [ ] SSRF: clone URL이 서버 구성인지(사용자 입력 URL 없음), owner/name 검증 우회 시도
- [ ] Path traversal: 파일 API가 git object 서빙인지 확인, `../`·인코딩·심링크 우회 시도 → 전부 404
- [ ] IDOR: 전 프로젝트-스코프 엔드포인트에서 타 사용자 리소스 접근 차단(권한 매트릭스 표본 테스트)
- [ ] clone 코드 미실행 원칙: 파서 외 어떤 경로에서도 repo 파일 실행/평가 없음(코드 리뷰)
- [ ] FE: `VITE_*`에 시크릿 없음(§18 TODO ④), 토큰이 localStorage 등 클라이언트 저장소에 없음
- [ ] 의존성: Dependabot 동작 + 신규 의존성(JGit/JavaParser/JSqlParser/monaco/xyflow) 알려진 취약점 확인
- [ ] `/v3/api-docs` 공개 노출의 위험 평가(개인 도구 전제) — 필요 시 프로파일 게이트 권고
- [ ] findings를 severity와 evidence(file:line)로 리포트, Critical/High 0 확인

**선행:** 1-1~1-15. (§18 TODO ⑤ 공개 전환 항목은 오픈소스 공개 시점 게이트로 이월 기록)

### 1-17 · verify — Phase 1 최종 검증

**Owner agent:** `verify` — §7 검증 계획 체크리스트 전체를 수행한다. FE+BE+보안+디버거 증거 기반 하드 게이트. 전 항목 PASS 전 Phase 2 진입 금지. 세부 항목은 §7.

**debug task 부재 사유:** N/A — 그린필드 신규 기능 Phase로 현재 활성 버그/실패 테스트 없음. 구현 중 재현 가능한 실패 발생 시 해당 PR 그룹 안에서 `debug` 에이전트를 즉석 투입한다.

---

## 5. REST API 초안 (Phase 1)

공통: 인증 필요(세션 쿠키), 예외는 명시. 조회 API는 기본 current snapshot, `?snapshotId=` 옵션. 에러는 RFC 7807(problem+json). openapi-typescript 파이프라인은 **G5(1-6)에서 도입**되며, 이후 모든 API 변경 PR은 `docs/api/openapi.json`+`schema.d.ts` 재생성 커밋이 CI로 강제된다(springdoc은 G1에서 백엔드에 선탑재).

**Auth (1-1)**

| 메서드/경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/auth/session` (permitAll) | — | `{ authenticated, oauthEnabled, user?: { login, name, avatarUrl } }` |
| `GET /oauth2/authorization/github` | — | 302 (Spring 표준 OAuth 시작) |
| `POST /api/auth/pat` (permitAll+CSRF) | `{ token }` | 204 / 400(검증 실패) |
| `POST /api/auth/logout` | — | 204 |

**GitHub (1-1)**

| `GET /api/github/repos?query&page` | — | `[{ owner, name, private, defaultBranch, description, pushedAt }]` |
|---|---|---|

**Projects / Import (1-2)**

| 메서드/경로 | 요청 | 응답 |
|---|---|---|
| `POST /api/projects` | `{ owner, repo }` | `{ project, jobId }` |
| `GET /api/projects` | — | 카드용 확장: `[{ id, name, repoOwner, repoName, defaultBranch, snapshotStatus, areas[], technologies[], lastCommit{sha,message,at}, prCount, lastJob{id,status} }]` (areas는 G4, lastCommit/prCount는 G6 병합 후 채워짐 — 그 전엔 null) |
| `GET /api/projects/{id}` | — | 상세 |
| `DELETE /api/projects/{id}` | — | 204 (clone 정리) |
| `POST /api/projects/{id}/reanalyze` | — | `{ jobId }` |

**Jobs (1-3)**

| `GET /api/projects/{id}/jobs/{jobId}` | job + steps(status, progressPct, error) |
|---|---|
| `GET /api/projects/{id}/jobs/{jobId}/events` | SSE: step 상태/진행 이벤트, 15s heartbeat |
| `POST /api/projects/{id}/jobs/{jobId}/retry` | 실패 step부터 재실행 → 202 |

**Areas (1-5)**

| `GET /api/projects/{id}/areas` | `[{ areaType, confidence, summary, technologies[{name,version}], fileCount, evidences[{kind,filePath,lineStart,excerpt}] }]` |
|---|---|
| `GET /api/projects/{id}/area-selections` | `[{ areaType, selected }]` |
| `PUT /api/projects/{id}/area-selections` | 동일 형태 배열 → 204 |

**Code / Graph (1-4, 1-8, 1-10, 1-11)**

| 메서드/경로 | 응답 |
|---|---|
| `GET /api/projects/{id}/tree?path=` | 1-depth `[{ name, path, type: FILE|DIR, language?, size? }]` |
| `GET /api/projects/{id}/file?path=` | `{ path, language, lineCount, content }` / 413(크기 초과) / binary 표시 |
| `GET /api/projects/{id}/symbols?path=` | 파일 내 노드 `[{ nodeId, nodeType, name, lineStart, lineEnd, metadata }]` |
| `GET /api/projects/{id}/nodes/{nodeId}` | 노드 상세 + evidences |
| `GET /api/projects/{id}/nodes/{nodeId}/relations?direction=in|out&types=` | `[{ edge{type,confidence}, node{...} }]` (1-depth) |
| `GET /api/projects/{id}/endpoints` | `[{ httpMethod, path, handlerKey, nodeId }]` |
| `GET /api/projects/{id}/architecture?view=backend|system&areas=` | `{ groups[{key,label}], nodes[{nodeId,name,group,fileRef}], edges[{source,target,type,count}] }` |
| `GET /api/projects/{id}/features` | `[{ id, name, confidence, detection, children[], links[{role, node{...}}] }]` |

**History (1-7)**

| 메서드/경로 | 응답 |
|---|---|
| `GET /api/projects/{id}/commits?cursor&branch` | `{ items[{sha,author,message,committedAt,additions,deletions}], nextCursor }` |
| `GET /api/projects/{id}/commits/{sha}` | 상세 + `files[{path,changeType}]` |
| `GET /api/projects/{id}/commits/{sha}/diff?path=` | `{ path, unifiedDiff }` |
| `GET /api/projects/{id}/branches` / `/tags` | `[{ name, headSha }]` |
| `GET /api/projects/{id}/pull-requests?state=` | `[{ number, title, state, author, mergedAt, headSha, baseSha }]` |

---

## 6. Fixture 저장소 명세 (`backend/src/test/resources/fixtures/`)

공통 규약: 테스트 헬퍼 `FixtureRepo.init(tempDir, name)`이 fixture 디렉터리를 임시 git 저장소로 초기화한다 — 고정 `PersonIdent`(이름/이메일/타임스탬프)로 커밋해 **SHA가 결정적**이다. spring-mini는 3-commit 히스토리(1-7 골든용: init → feature 추가 → tag `v0.1`, 브랜치 `feature/x` 1개), 나머지는 1-commit. spotless는 `src/test/resources/**` 제외(1-4).

### 6.1 spring-mini — Java/Spring 분석의 중심 골든

```text
spring-mini/
├── build.gradle                # spring-boot plugin, starter-webmvc, data-jpa, postgresql
├── settings.gradle
├── src/main/java/com/example/shop/
│   ├── ShopApplication.java            # @SpringBootApplication
│   ├── common/AppConfig.java           # @Configuration
│   └── order/
│       ├── OrderController.java        # @RestController @RequestMapping("/api/orders")
│       │                               #   GET "" → list(), GET "/{id}" → detail(), POST "" → create()
│       ├── OrderService.java           # @Service — 메서드 3개, 각각 repository 호출
│       ├── OrderRepository.java        # interface extends JpaRepository<Order, Long>
│       └── Order.java                  # @Entity @Table(name = "orders") — 필드 3개
├── src/main/resources/
│   ├── application.yml                 # datasource(postgres) + data.redis 설정
│   └── db/migration/V1__init.sql      # CREATE TABLE orders (...)
└── src/test/java/com/example/shop/order/OrderServiceTest.java
```

| 검증 대상 | 기대 결과 (골든) |
|---|---|
| 1-4 인벤토리 | Java 7, SQL 1, YAML 1, Gradle 2 — 주 언어 Java; 특정 파일 line_count/hash 고정 |
| 1-5 영역 | BACKEND ≥ 0.8 (spring-boot 의존성+`src/main/java`+`@RestController`), DATABASE ≥ 0.5 (migration+`@Entity`), TESTING ≥ 0.5, BUILD_TOOLING 감지; FRONTEND/INFRASTRUCTURE 미감지. 각 영역 evidence ≥ 2 |
| 1-7 히스토리 | commit 3(각 additions/deletions 고정값), branch 2(main, feature/x), tag 1(v0.1), commit_files change_type 일치 |
| 1-8 그래프 | CLASS 5 + INTERFACE 1 + 테스트 CLASS 1, PACKAGE 3(shop/common/order), METHOD ≥ 7; CALLS CONFIRMED 6(controller→service 3, service→repository 3), JpaRepository EXTENDS(이름 기반), ANNOTATED_BY ≥ 6, 노드 라인 범위 정확 |
| 1-9 설정 | DB_TABLE 노드 1(orders) + MIGRATION 노드 1, gradle 의존성 ≥ 3 + spring-boot 프레임워크 확정, application.yml → CONFIG 노드 + datasource/redis evidence |
| 1-10 추출 | endpoints 3(`GET /api/orders`, `GET /api/orders/{id}`, `POST /api/orders`), db_entities 1(Order→orders, JPA), layer: CONTROLLER 1/SERVICE 1/REPOSITORY 1/ENTITY 1/CONFIG 1 |
| 1-11 feature | feature 1 "Orders"(confidence 0.8), links: API 3(또는 집계 1)+SERVICE 1+DATA 2(repository, entity) |

### 6.2 react-mini — 비-Java repo의 영역 감지·인벤토리 (Phase 1은 TS AST 없음)

```text
react-mini/
├── package.json          # deps: react, react-dom, react-router-dom / devDeps: vite, typescript, vitest
├── vite.config.ts
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── pages/HomePage.tsx
    ├── components/Button.tsx
    └── App.test.tsx
```

| 검증 대상 | 기대 결과 |
|---|---|
| 1-4 | TypeScript(tsx 포함) 최다, 파일 9 |
| 1-5 | FRONTEND ≥ 0.8 (react 의존성+tsx+index.html+vite), TESTING ≥ 0.5 (vitest+`*.test.tsx`), BUILD_TOOLING 감지; BACKEND/DATABASE 미감지 |
| 1-8~1-11 | graph 심볼 노드 0(TS 미지원 — FILE/DIRECTORY 수준만), endpoints 0, features 0 — **분석이 실패 없이 완주**하는 것 자체가 검증(§20 #7 강등 동작) |

### 6.3 fullstack-mini — 다영역 공존 + compose/CI 추출

```text
fullstack-mini/
├── README.md
├── docker-compose.yml    # services: api(build ./backend, depends_on postgres), web(./frontend), postgres(image)
├── .github/workflows/ci.yml
├── backend/
│   ├── pom.xml           # spring-boot-starter-webmvc, data-jpa (Maven 파서 커버)
│   └── src/main/java/com/example/api/
│       ├── ApiApplication.java
│       ├── UserController.java   # @RestController: GET /api/users
│       └── User.java             # @Entity
└── frontend/
    ├── package.json      # react
    └── src/App.tsx
```

| 검증 대상 | 기대 결과 |
|---|---|
| 1-5 | BACKEND, FRONTEND, DATABASE(@Entity 시그널), INFRASTRUCTURE(compose), DEVOPS(workflow) 5개 영역 모두 ≥ 0.5; 모노레포에서 영역별 evidence가 올바른 하위 경로를 가리킴 |
| 1-9 | CONTAINER 노드 3(api/web/postgres) + `infra_resources` 3, api→postgres DEPENDS_ON edge, CI_PIPELINE 1, pom.xml 의존성 추출(Maven 경로 커버) |
| 1-10 | endpoints 1(`GET /api/users`), db_entities 1(User→users — @Table 없음 → snake 규칙) |
| 1-11 | feature 1 "Users" |

### 6.4 infra-mini — 코드 없는 인프라 전용 repo

```text
infra-mini/
├── Dockerfile
├── docker-compose.yml    # services: app(build .), redis(image)
├── .github/workflows/deploy.yml
├── k8s/deployment.yaml
└── main.tf               # Phase 1: area 시그널로만 사용(HCL 파싱은 Phase 2)
```

| 검증 대상 | 기대 결과 |
|---|---|
| 1-5 | INFRASTRUCTURE ≥ 0.8 (Dockerfile+compose+k8s+tf), DEVOPS ≥ 0.5 (workflow); BACKEND/FRONTEND/TESTING 미감지 |
| 1-9 | CONTAINER 2(app/redis) + Dockerfile evidence, CI_PIPELINE 1(deploy.yml — 트리거 metadata) |
| 전체 | endpoint/entity/feature 0으로 파이프라인 완주(빈 결과 안전성) |

골든 비교 방식(§19): 스냅샷 JSON 통파일 비교 대신 **구조화 기대값 assert**(타입별 카운트 + 핵심 관계/필드 명시 비교, 라인 번호 포함)로 작성해 회귀 시 진단이 즉시 되게 한다. 분석 결과 스키마 변경 PR은 fixture 기대값 갱신을 리뷰에서 명시 확인(§19 마지막 문단).

---

## 7. 검증 계획 — 1-17 verify 게이트

`verify` 에이전트가 main 기준으로 수행. 글로벌 verify 하드 스위트(FE+BE+보안+디버거 증거) 기준. **전 항목 증거(명령 출력/스크린샷/DB 조회) 첨부** 필수.

**빌드/테스트 (자동)**
- [ ] `backend: ./gradlew spotlessCheck build` green — 단위+통합(Testcontainers)+골든+ArchUnit 전부 포함
- [ ] `frontend: npm run lint && npm run typecheck && npm test -- --run && npm run build` green
- [ ] CI(main)에서 동일 결과 + openapi 스펙-타입 동기화 검사 통과
- [ ] fixture 4종 골든 스위트 존재·통과 (spring-mini/react-mini/fullstack-mini/infra-mini)
- [ ] Flyway V1~V9 clean DB 적용 성공 + JPA `ddl-auto: validate` 통과

**기능 E2E (수동 스모크, 증거 첨부)**
- [ ] PAT 등록 → private repo 목록 → import → job step 체크리스트 실시간 진행 → READY
- [ ] public repo(본 저장소 등) import 동작 (토큰 유무 무관 경로)
- [ ] 영역 카드 + evidence 표시 → 선택 저장 → 사이드바 Areas 반영 → 토글 시 Architecture 필터 즉시 변경(재분석 없음)
- [ ] Code: 트리 → 파일 → 심볼 → callers/callees 클릭 → 파일·라인 이동
- [ ] Architecture: Backend/System 뷰 렌더 → 노드 클릭 → 코드 이동
- [ ] History: 타임라인 페이지네이션 → commit 상세 → diff 렌더, PR 목록
- [ ] Home: 카드에 영역/기술/분석 상태/최근 commit/PR 수 표시
- [ ] Features 탭: 트리 + 링크 → Code 딥링크
- [ ] 실패 복구: step 실패 유도(예: 네트워크 차단) → FAILED 표시 → retry로 실패 step부터 재개; 재분석 실패 시 기존 snapshot 결과 유지

**보안 (1-16 리포트 대조)**
- [ ] 1-16 findings Critical/High 0, Medium 이하 처리 방침 기록
- [ ] §18 Phase 1 TODO ①(GCM nonce/key_version/키 검증) ②(세션/CSRF) ③(CORS allow-list) ④(VITE_* 시크릿 금지) 각각 증거로 확인
- [ ] DB의 encrypted_token이 평문 아님 표본 확인, 로그 파일 토큰 grep 무결

**문서/정리**
- [ ] README 갱신: 로컬 실행 절차(compose+backend+frontend), OAuth App 설정 가이드(외부 의존성), `TOKEN_ENC_KEY` 생성
- [ ] `.env.example` 갱신(Phase 1 변수 활성화)
- [ ] 원격 feature 브랜치 정리, 본 계획서의 체크박스 최신화

**게이트 판정:** 전 항목 PASS → Phase 1 종료 선언, Phase 2 계획 수립 가능. 하나라도 FAIL → 해당 owner에게 반환, 재검증.

---

## Master checklist

- [ ] 모든 1-1~1-17에 단일 owner + 완료 기준 존재 (§1.5)
- [ ] 모든 task에 체크박스 체크리스트 존재 (§4)
- [ ] FE task는 `fe`(1-6, 1-12~1-15), BE task는 `be`(1-1~1-5, 1-7~1-11)만 소유
- [ ] 보안 task `sc` 존재(1-16 — 인증/토큰/파일 서빙 민감 표면)
- [ ] debug task: N/A — 그린필드, 활성 버그 없음(발생 시 PR 그룹 내 즉석 투입)
- [ ] verify(1-17)가 마지막 게이트로 "done"을 통제
- [ ] placeholder 없음 — 마이그레이션 컬럼/엔드포인트/fixture 기대값까지 확정

## Handoff

승인 후 §2의 병합 순서대로 **task 단위로** 해당 owner 에이전트(`be`/`fe`/`sc`/`verify`)에 위임한다. ID 건너뛰기 금지, 완료 시 본 문서 체크박스 갱신. 선행 조건 P0(Phase 0 커밋/병합)을 가장 먼저 처리한다.
