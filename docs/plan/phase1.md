# Phase 1 — Repository Intelligence Core 구현 계획

- 개정: PR #8로 merge된 초안(G1~G15 체계)을 본 문서(P1~P11 체계)가 대체한다. 구현·마이그레이션 번호는 본 문서를 따른다.
- 근거: `기획서.md` v1.2 (§6~§10, §12~§13, §15, §18~§19, §21) · Phase 0 완료(main merge)
- 불변 원칙: 사실(fact)은 정적 분석으로만 기록(§10.5) · 모든 감지에 evidence(§9.1) · 분석 결과는 snapshot 귀속(§6.1) · **clone한 코드는 절대 실행하지 않는다**(§18)
- 스택 제약: 기존 스택 유지. 신규 의존성은 기획서 명시분만 — JGit, JavaParser(+symbol-solver), JSqlParser, spring OAuth2 Client/Session, springdoc-openapi, Monaco, @xyflow/react+elkjs, openapi-typescript. GitHub API는 RestClient 직접 호출(전용 클라이언트 라이브러리 금지). Neo4j/Elasticsearch 금지.

---

## 1. 목표 / 범위 / 비범위

**목표:** GitHub 계정을 연결해 repository를 import하면 분석 파이프라인이 자동 실행되고, 감지된 Project Area를 선택한 뒤 Java 백엔드 중심의 구조(그래프·endpoint·entity·feature)와 Git 이력을 UI에서 탐색할 수 있는 상태.

**범위 (기획서 §21 Phase 1 = task 1-1~1-17):**

- 인증: GitHub OAuth 로그인 + PAT 등록, AES-256-GCM 토큰 저장, 세션/CSRF/CORS 재정비(§18 이월 ①②③)
- 파이프라인(§8.1 step 1~9, 13): Import → File Inventory → Language/Framework → Area Detection → Git Metadata → Source Parsing(Java) → Graph Build → API/DB/Infra/CI 추출 → Feature Detection → Finalize(evidence 정리 + snapshot 교체)
- 분석기: JavaAnalyzer(JavaParser+SymbolSolver) + 설정 분석기 5종(BuildFile/SqlMigration/Docker/GithubActions/YamlConfig)
- FE: Import Wizard, Code explorer, Architecture(Backend/System), History, Home + 사이드바 Areas

**비범위 (명시 이월):**

| 항목 | Phase |
|---|---|
| TS/기타 언어 AST(ts-analyzer 사이드카), `frontend_routes` | 2 |
| Cross-domain 매칭(CONSUMES/MAPS_TO/READS_WRITES), Flow detection, Flows UI | 2 |
| Analysis findings, Impact Analysis, era detection, 증분 분석 | 2 |
| Features 화면(트리+상세 UI) — 1-11은 데이터/API까지만 | 2 |
| TerraformAnalyzer(HCL 파싱) — `.tf`는 area 시그널로만 사용 | 2 |
| AI 전부(AIProvider, summaries 생성, pgvector 활용) | 3 |
| Notes / Tasks / 통합 Search, gitleaks CI(공개 전환 시 §18 ⑤) | 4 / 공개 시 |

---

## 2. PR 묶음 설계

11개 PR + 게이트(1-16 → 1-17). 운영 규칙:

- 모든 PR은 CI green + 리뷰 후 merge(§21 Git 전략), main 직접 push 금지.
- 각 PR은 자기 마이그레이션·테스트·골든 스냅샷을 포함해 단독 merge 가능해야 한다.
- fixture 골든 스냅샷 변경이 있는 PR은 리뷰에서 변경 사유를 명시적으로 확인(§19).
- sc 조기 리뷰(권장): P1(토큰·세션), P2(SSRF·clone 경로), P3(파일 서빙)은 merge 전 diff 점검. 1-16은 Phase 말 종합 점검.

| PR | 브랜치 | 포함 task | 의존 | 핵심 산출물 |
|----|--------|-----------|------|------------|
| P1 | `feature/phase1-auth` | 1-1 | — | OAuth+PAT 로그인, 토큰 암호화(V2), 세션/CSRF/CORS |
| P2 | `feature/phase1-import-job` | 1-3, 1-2 | P1 | Job 프레임워크+SSE(V3), project/import/JGit clone |
| P3 | `feature/phase1-inventory-area` | 1-4, 1-5 | P2 | files 인벤토리, AreaDetector 12종(V4), **fixture 4종 도입** |
| P4 | `feature/phase1-import-wizard` | 1-6 | P3 | Import Wizard UI(연결→repo→진행→영역 선택) |
| P5 | `feature/phase1-git-metadata` | 1-7 | P2 | commits/branches/tags/PR 수집(V5), diff API |
| P6 | `feature/phase1-java-analyzer` | 1-8 | P3 | CodeAnalyzer SPI, JavaAnalyzer, graph(V6), graph API |
| P7 | `feature/phase1-config-analyzers` | 1-9 | P6 | 설정 분석기 5종, infra_resources(V7) |
| P8 | `feature/phase1-endpoints-features` | 1-10, 1-11 | P6(P7 권장) | api_endpoints/db_entities/features(V8), architecture 프로젝션 API |
| P9 | `feature/phase1-code-explorer` | 1-12 | P6, P3 | Code 탭(파일트리+Monaco+심볼 패널) |
| P10 | `feature/phase1-arch-view` | 1-13 | P8 | Architecture 탭(React Flow+elkjs) |
| P11 | `feature/phase1-history-home` | 1-14, 1-15 | P5, P3 | History 탭, Home 카드+사이드바 Areas |
| 게이트 | (수정 필요 시 `feature/phase1-security-fixes`) | 1-16 → 1-17 | P1~P11 | sc 점검 리포트 → verify PASS |

**순서/병렬:**

```text
P1 → P2 → P3 ─┬→ P4
              ├→ P5 ──────────────┬→ P11
              └→ P6 → P7 → P8 → P10
                   └───────→ P9
P4~P11 완료 → 1-16(sc) → (수정 PR) → 1-17(verify)
```

---

## 3. DB 마이그레이션 순서 (V2~V8)

V1(기존): `users`, `github_credentials`, `projects`, `snapshots`, `project_area_selections`, `analysis_jobs`, `analysis_job_steps`.

규칙: 마이그레이션 번호는 **merge 순서**로 확정한다(병렬 브랜치는 rebase 시 재번호). 컬럼 상세는 기획서 §6.2 표를 따른다.

| V | PR | 파일명 | 내용 |
|---|----|--------|------|
| V2 | P1 | `V2__github_credentials_encryption.sql` | `github_credentials` 보강: `nonce bytea NOT NULL`, `key_version int NOT NULL DEFAULT 1` (§18 이월 ① — 기존 행 0건 전제, 마이그레이션 주석에 명시) |
| V3 | P2 | `V3__job_checkpoint.sql` | `analysis_job_steps` 보강: `status` CHECK(PENDING/RUNNING/DONE/FAILED/SKIPPED), `attempt int NOT NULL DEFAULT 0` · `analysis_jobs`에 `started_at`, `finished_at timestamptz` |
| V4 | P3 | `V4__inventory_area_evidence.sql` | `files`(UNIQUE(snapshot_id, path)), `project_areas`, `area_technologies`, `evidences`, `evidence_links` |
| V5 | P5 | `V5__git_metadata.sql` | `commits`(UNIQUE(project_id, sha)), `commit_files`, `branches`, `tags`, `pull_requests`(UNIQUE(project_id, number)) |
| V6 | P6 | `V6__code_graph.sql` | `graph_nodes`(UNIQUE(snapshot_id, natural_key)), `graph_edges`(+ (snapshot_id, source_node_id, edge_type) / (snapshot_id, target_node_id, edge_type) 인덱스) |
| V7 | P7 | `V7__infra_resources.sql` | `infra_resources` |
| V8 | P8 | `V8__endpoints_entities_features.sql` | `api_endpoints`, `db_entities`, `features`, `feature_links` |

Phase 2+ 이월 테이블: `frontend_routes`, `flows`/`flow_steps`, `analysis_findings`(2) · `summaries`, `ai_*`(3) · `notes`/`note_references`, `tasks`/`task_goals`/`learning_records`(4).

---

## 4. 공통 규약

**파이프라인 step 구성 (`analysis_job_steps.step_key`):**

| seq | step_key | 도입 PR | 비고 |
|---|---|---|---|
| 1 | IMPORT | P2 | clone/fetch + snapshot(ANALYZING) 생성 |
| 2 | FILE_INVENTORY | P3 | `files` 저장 |
| 3 | LANGUAGE_FRAMEWORK | P3 | 언어 분포·프레임워크 후보 |
| 4 | AREA_DETECTION | P3 | `project_areas` + evidence |
| 5 | GIT_METADATA | P5 | commits/branches/tags/PR |
| 6 | SOURCE_PARSING | P6 | CodeAnalyzer registry 실행(P7에서 분석기 추가 등록) |
| 7 | GRAPH_BUILD | P6 | CONTAINS 정리, area_type 태깅 |
| 8 | EXTRACTION | P7·P8 | infra(P7) / endpoint·entity(P8) 전용 테이블 투영 |
| 9 | FEATURE_DETECTION | P8 | features + links |
| 마지막 | FINALIZE | P2 | snapshot READY + `current_snapshot_id` 원자 교체, orphan evidence 정리(P3~) |

Phase 1에 없는 step(Flow/Cross-domain/Indexing)은 파이프라인 정의에서 제외한다(SKIPPED 기록 불필요). Step 구현체는 자신의 산출물을 `(snapshot_id, natural_key)` 기준 idempotent upsert — 재시도 안전(§8.3).

**API 규약:**

- 모든 `/api/**`는 세션 인증 필수(401), 상태 변경 요청은 CSRF 토큰 필수.
- 분석 결과 조회는 `/api/projects/{projectId}/...` + 선택 파라미터 `?snapshotId=`(기본 current_snapshot, 없으면 404).
- 에러 응답은 Spring ProblemDetail 형식으로 통일. 에러 메시지에 토큰·내부 경로 노출 금지.
- springdoc `/v3/api-docs` → FE `npm run gen:api`(openapi-typescript)로 타입 계약 유지(§19).

---

## 5. Task 상세

### Agent task board

| ID | Agent | Title | Depends | Done when (기획서 §21 그대로) |
|----|-------|-------|---------|------------------------------|
| 1-1 | be | GitHub OAuth 로그인 + 토큰 암호화 저장(+PAT 등록) | — | private repo 목록 조회 성공 |
| 1-2 | be | Repository import + JGit clone + snapshot 생성 | 1-1 | public/private clone 동작 |
| 1-3 | be | 비동기 Job 프레임워크(steps, 체크포인트, SSE 진행) | 1-1 | 실패 step 재시도 동작 |
| 1-4 | be | 파일 인벤토리 + 언어/프레임워크 감지 | 1-2, 1-3 | fixture 골든 테스트 통과 |
| 1-5 | be | Area Detection 엔진 + 12영역 detector + evidence | 1-4 | fixture 4종에서 기대 영역 감지 |
| 1-6 | fe | Import Wizard UI | 1-1~1-5 | 영역 선택이 저장·반영 |
| 1-7 | be | Git metadata 수집(commits/branches/tags/PR) | 1-2, 1-3 | rate limit 백오프 동작 |
| 1-8 | be | CodeAnalyzer SPI + JavaAnalyzer | 1-4 | spring-mini 골든 그래프 일치 |
| 1-9 | be | 설정 분석기(build/yml/Docker/CI/SQL migration) | 1-8 | fixture 추출 결과 일치 |
| 1-10 | be | API endpoint + JPA entity 추출, 레이어 태깅 | 1-8 | endpoint 목록 정확도 검증 |
| 1-11 | be | Feature 기본 추출(경로 prefix+패키지 군집) | 1-10 | fixture에서 기대 feature 생성 |
| 1-12 | fe | Code explorer(파일트리+Monaco+심볼 패널) | 1-4, 1-8 | 노드→코드 라인 이동 동작 |
| 1-13 | fe | Architecture 뷰(React Flow, Backend/System) | 1-10 | 노드 클릭→코드 이동 |
| 1-14 | fe | History 뷰(commit/PR 타임라인, diff) | 1-7 | diff 렌더 정상 |
| 1-15 | fe | Home + 프로젝트 카드 + 사이드바 Areas | 1-5 | 요구 정보 표시 |
| 1-16 | sc | 토큰·clone 경로·파일 서빙 보안 점검 | 1-1~1-15 | 취약점 0 (§18 항목) |
| 1-17 | verify | Phase 1 verify | 전부 | PASS |

---

### 1-1 · be — GitHub OAuth 로그인 + 토큰 암호화 저장 (+PAT 등록) `[P1]`

**상태: 완료** — verify PASS(테스트 30/30), 실 PAT 스모크로 private repo 15건 조회 확인. sc 조기 점검 LOW 4건 중 루프백 바인딩 반영, 3건은 1-16 이월.
**완료 기준:** private repo 목록 조회 성공
**패키지:** `dev.codeintelligence.auth`(사용자·세션·암호화), `dev.codeintelligence.github`(API 클라이언트), `dev.codeintelligence.common.config`

**구현 체크리스트:**

- [ ] 의존성 추가: OAuth2 Client·Spring Session Redis·springdoc-openapi (Boot 4.1 스타터 아티팩트명은 도입 시 공식 문서로 확인 — 위험 R5)
- [ ] `auth/TokenCryptoService` — AES-256-GCM. **기동 시 `TOKEN_ENC_KEY`(base64) 디코드 후 32바이트 검증, 불일치 시 fail-fast**(§18 이월 ①). encrypt마다 `SecureRandom` 12바이트 nonce 신규 생성, `{key_version, nonce, ciphertext}`를 `github_credentials`에 저장
- [ ] `V2__github_credentials_encryption.sql` (§3 표)
- [ ] `SecurityConfig` 개편(§18 이월 ②): STATELESS 제거 → **Spring Session Redis**, `oauth2Login()`(scope: `read:user`, `repo`), **CSRF 재활성화**(CookieCsrfTokenRepository + SPA용 CsrfTokenRequestAttributeHandler), 세션 쿠키 **SameSite=Lax**·HttpOnly(+prod 프로필 Secure), 로그인 성공 시 FE origin으로 redirect
- [ ] CORS(§18 이월 ③): 설정 프로퍼티 `app.cors.allowed-origins`(기본 `http://localhost:5173`) 허용목록만, `allowCredentials=true`와 wildcard 병용 금지
- [ ] `auth/GithubOAuth2UserService` — OAuth 로그인 시 `users` upsert + access token 암호화 저장(kind=OAUTH, scopes 기록)
- [ ] `auth/PatAuthService` — PAT 입력 → GitHub `GET /user`로 유효성 검증 → `users` upsert + 세션 생성 + credential 저장(kind=PAT). **OAuth App 미설정 환경의 1급 로그인 경로**
- [ ] `github/GithubApiClient`(RestClient) — `GET /user`, `GET /user/repos?visibility=all`(페이지네이션), rate limit 헤더(`x-ratelimit-*`) 파싱 골격. base URL은 `github/GithubProperties`로 설정화(테스트 오버라이드용)
- [ ] DTO에 토큰 필드 금지, credential entity `toString` 마스킹, 로그에 토큰 출력 경로 없음을 확인
- [ ] `.env.example` 갱신: `TOKEN_ENC_KEY`·`GITHUB_CLIENT_ID/SECRET` 주석 해제 안내, PAT-only 사용 가능 명시

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/oauth2/authorization/github` | OAuth 로그인 시작(Spring 제공) |
| GET | `/login/oauth2/code/github` | OAuth 콜백(Spring 제공) → FE redirect |
| GET | `/api/auth/me` | → `{ authenticated, login, name, avatarUrl, credentialKind }` |
| POST | `/api/auth/pat` | `{ token }` → 204. 세션 생성 + credential 저장. **응답에 토큰 없음** |
| POST | `/api/auth/logout` | 세션 종료 → 204 |
| GET | `/api/github/repos?page&perPage&q` | 접근 가능 repo 목록(private 포함) — 완료 기준 검증 지점 |

**테스트 체크리스트:**

- [ ] 단위: TokenCryptoService 라운드트립 / 호출마다 nonce 상이 / 32바이트 아닌 키 → 기동 실패 / key_version 저장
- [ ] 단위: MockRestServiceServer — GitHub `/user` 401 → PAT 등록 400, 200 → 세션+credential 저장
- [ ] 통합(Testcontainers): CSRF 토큰 없는 POST → 403, 세션이 Redis에 저장, `/api/auth/me` 401→로그인 후 200
- [ ] 통합: CORS preflight — 허용 origin 통과, 미허용 origin 차단
- [ ] 응답 body·로그 캡처에 토큰 원문 미포함 assert

**보안 유의점:** §18 이월 ①②③이 이 task의 핵심 산출물. scope 최소화, OAuth state는 Spring 기본 사용. sc 조기 리뷰 대상.

---

### 1-2 · be — Repository import + JGit clone + snapshot 생성 `[P2]`

**상태: 완료** — verify PASS(테스트 81/81). 실기동: private(`Min0504/code-intelligence`)·public(`octocat/Hello-World`) clone DONE, HEAD SHA 일치, reanalyze 스냅샷 교체, SSRF/path 400, DELETE 후 clone 제거.
**완료 기준:** public/private clone 동작
**패키지:** `dev.codeintelligence.project`, `dev.codeintelligence.github`

**구현 체크리스트:**

- [ ] 의존성: `org.eclipse.jgit`
- [ ] `project/Project`·`Snapshot` entity + repository. 사용자당 `(repo_owner, repo_name)` 중복 import 방지
- [ ] `github/RepoRef` 입력 검증 — owner/name 정규식 `[A-Za-z0-9_.-]+`(`..` 금지). URL 입력은 `https://github.com/{owner}/{repo}` 형식만 허용, **그 외 호스트 전부 거부(SSRF 방어, §18)**
- [ ] `github/GitCloneService` — JGit clone(이미 있으면 fetch), 인증은 `UsernamePasswordCredentialsProvider("x-access-token", 복호화토큰)`. clone 대상 `${app.data-dir}/repos/{projectId}` — **실경로(canonical path)가 repos 루트 하위인지 검증 후 진행**
- [ ] `common/AppProperties.dataDir` — `DATA_DIR` env, 기본 `~/.code-intelligence`
- [ ] `project/ImportStep`(step_key=IMPORT) — clone → HEAD sha 확인 → `snapshots(ANALYZING)` 생성 → job에 연결
- [ ] `job/FinalizeStep`(파이프라인 마지막) — snapshot READY + `projects.current_snapshot_id` 원자 교체. 실패 시 기존 snapshot 유지(§8.3). snapshot 보존은 최근 2개(설정값), 초과분 파생 데이터 cascade 삭제
- [ ] 재분석(`POST .../reanalyze`) — 기존 clone fetch 후 새 snapshot으로 전체 파이프라인
- [ ] 프로젝트 삭제 시 clone 디렉터리 정리(경로 검증 후 삭제)

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| POST | `/api/projects` | `{ repoOwner, repoName }` → 201 `{ project, jobId }` (import job enqueue) |
| GET | `/api/projects` | 목록(+ currentSnapshot 상태, 최근 job 요약) |
| GET | `/api/projects/{projectId}` | 상세 |
| DELETE | `/api/projects/{projectId}` | 삭제(clone 디렉터리 포함) → 204 |
| POST | `/api/projects/{projectId}/reanalyze` | → `{ jobId }` |

**테스트 체크리스트:**

- [ ] JGit로 temp bare repo 생성 → clone 성공 / 재실행 시 fetch 재사용 (네트워크 불필요)
- [ ] 오염 입력(`../x`, 절대경로, `https://evil.com/...`) → 400
- [ ] canonical path 위반 시나리오 → 예외 + clone 미수행
- [ ] private 인증: CredentialsProvider에 복호화 토큰이 전달되는지 단위 검증(실 GitHub 호출은 수동 스모크)
- [ ] DELETE → 디렉터리 삭제 확인

**보안 유의점:** SSRF allowlist(github.com만)·canonical path 검증이 1-16 점검 대상. clone 코드는 파싱만, 실행 절대 금지. sc 조기 리뷰 대상.

---

### 1-3 · be — 비동기 Job 프레임워크 (steps, 체크포인트, SSE) `[P2]`

**상태: 완료** — 2번째 step 실패→retry→1번째 step 재실행 없음(체크포인트) 테스트 고정. 활성 job 1개(partial unique index), SSE 접속 직후 스냅숏, 재기동 복구. sc LOW 4건은 1-16 이월.
**완료 기준:** 실패 step 재시도 동작
**패키지:** `dev.codeintelligence.job`

**구현 체크리스트:**

- [ ] `V3__job_checkpoint.sql` (§3 표)
- [ ] `job/JobStep` 인터페이스 — `String key(); void run(JobContext ctx);` (JobContext: project, snapshot, clonePath, progress 콜백)
- [ ] `job/Pipeline` — `@Order` 붙은 `JobStep` 빈 목록 주입으로 순서 구성(§4 표). job type: `IMPORT`/`REANALYZE`
- [ ] `job/JobService` — enqueue(프로젝트당 활성 job 1개 제약), 상태 전이는 DB가 소스 오브 트루스(QUEUED→RUNNING→DONE/FAILED/CANCELLED)
- [ ] `job/JobWorker` — `TaskExecutor`(virtual threads, `spring.threads.virtual.enabled=true`) 실행. step 루프: DONE step은 skip(**체크포인트**), 실패 시 step FAILED(+error)·job FAILED·잔여 step PENDING 유지
- [ ] retry — FAILED job의 실패 step부터 재실행, `attempt` 증가. cancel — RUNNING step 완료 후 중단
- [ ] `job/JobProgressPublisher` — step 상태 변경마다 Redis pub/sub `job-progress:{jobId}`에 JSON 발행
- [ ] `job/JobEventsController` — SseEmitter + RedisMessageListenerContainer 구독. **접속 직후 현재 상태 스냅숏 1회 전송**(재연결 복구), 15초 하트비트
- [ ] ArchUnit 기초 규칙 도입(§19): controller→repository 직접 호출 금지, 패키지 순환 금지

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/jobs/{jobId}` | `{ status, error, steps: [{ stepKey, seq, status, progressPct, attempt, error }] }` |
| GET | `/api/projects/{projectId}/jobs?limit` | 최근 job 목록 |
| POST | `/api/jobs/{jobId}/retry` | 실패 step부터 재개 → 202 |
| POST | `/api/jobs/{jobId}/cancel` | → 202 |
| GET | `/api/jobs/{jobId}/events` | SSE(`text/event-stream`) — step 상태 이벤트 |

**테스트 체크리스트:**

- [ ] fake steps 파이프라인: 전체 성공 → job DONE, step 순서·started/finished 기록
- [ ] **2번째 step 실패 → job FAILED → retry → 1번째 step 재실행 없음(체크포인트) → 전체 DONE** ← 완료 기준
- [ ] 동시 enqueue → 프로젝트당 1개 제약 동작
- [ ] SSE 통합(Testcontainers Redis): 구독 → 이벤트 수신, 접속 시 초기 스냅숏 수신
- [ ] cancel 후 상태 CANCELLED

---

### 1-4 · be — 파일 인벤토리 + 언어/프레임워크 감지 `[P3]`

**상태: 완료** — 테스트 137/137. fixture 4종 인벤토리 골든 고정. file-content path traversal 테스트(`../`, `%2e%2e`).
**완료 기준:** fixture 골든 테스트 통과
**패키지:** `dev.codeintelligence.analysis.core`

**구현 체크리스트:**

- [ ] `V4__inventory_area_evidence.sql` (§3 표 — evidence 테이블 포함, 1-5와 공유)
- [ ] `FileInventoryStep`(FILE_INVENTORY) — JGit TreeWalk(HEAD)로 path/size/blob hash 수집, 텍스트 파일만 라인 수 계산, 바이너리 판정(널 바이트+확장자)
- [ ] `LanguageDetector` — 확장자→언어 매핑(java/ts/tsx/js/sql/yml/yaml/tf/md/Dockerfile/gradle/xml 등)
- [ ] `FrameworkDetectionStep`(LANGUAGE_FRAMEWORK) — manifest 경량 파싱: `package.json` dependencies 키, pom/gradle 의존성 문자열 → 프레임워크 후보 목록을 `DetectionContext`로 산출(1-5 입력)
- [ ] 상한 설정: `app.analysis.max-files`(기본 20,000)·`max-file-size`(기본 1MB) — 초과 파일 skip 기록, 초과 시 경고 evidence(§20 위험 1)
- [ ] `FileController` — 트리/콘텐츠/통계 API. **콘텐츠는 clone 디렉터리에서 읽되 canonical path 검증**, 바이너리·상한 초과는 415/413

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/files` | 파일 트리 `[{ path, language, size, lineCount }]` |
| GET | `/api/projects/{projectId}/file-content?path=` | `{ path, language, content }` — 텍스트만 |
| GET | `/api/projects/{projectId}/stats` | 언어 분포·파일 수 |

**테스트 체크리스트:**

- [ ] fixture 4종 인벤토리 골든(파일 수·언어 집계 — §6 표와 일치)
- [ ] 바이너리 제외·대형 파일 skip 동작
- [ ] `file-content` path traversal 거부: `../`, 절대경로, URL 인코딩 변형(`%2e%2e`)
- [ ] LanguageDetector 단위(대표 확장자 전수)

**보안 유의점:** 파일 서빙 API가 §18 Path traversal 표면 — 1-16 핵심 점검 대상. sc 조기 리뷰 대상.

---

### 1-5 · be — Project Area Detection 엔진 + 12영역 detector + evidence `[P3]`

**상태: 완료** — confidence `min(1, Σ weights)`, 자동선택 ≥0.5. spring-mini BACKEND/DATABASE/TESTING, react-mini FRONTEND/TESTING, fullstack-mini BACKEND/FRONTEND/DATABASE/INFRASTRUCTURE/DEVOPS/TESTING, infra-mini INFRASTRUCTURE/DEVOPS. BUILD_TOOLING은 전 fixture <0.5.
**완료 기준:** fixture 4종에서 기대 영역 감지
**패키지:** `dev.codeintelligence.analysis.area`, `dev.codeintelligence.evidence`

**구현 체크리스트:**

- [ ] `AreaType` enum 12종: BACKEND, FRONTEND, MOBILE, DATABASE, INFRASTRUCTURE, DEVOPS, SECURITY, TESTING, AI_ML, DOCUMENTATION, BUILD_TOOLING, OTHER
- [ ] `AreaSignal(areaType, technology, weight, evidenceRef)` record + `AreaDetector` 인터페이스(`List<AreaSignal> detect(DetectionContext ctx)`)
- [ ] detector 12종 구현 — §9.2 규칙표 그대로(예: BackendAreaDetector = spring-boot 의존성 + `src/main/java` + NestJS/Express/Django 의존성). **registry 패턴: Spring 빈 목록 주입, 신규 영역 추가 시 기존 코드 무수정**(§10.1)
- [ ] `AreaDetectionEngine`(AREA_DETECTION step) — 영역별 weight 가중합 → confidence 정규화(0~1, 규칙을 코드 주석+테스트로 문서화). **AI 개입 없음, deterministic**
- [ ] `evidence/Evidence` entity + `EvidenceService` — 모든 signal의 근거를 `evidences`(created_by=STATIC) + `evidence_links`(subject_type=PROJECT_AREA)로 저장
- [ ] `project_areas`/`area_technologies` snapshot 기준 upsert
- [ ] 기본 선택 초기화: confidence ≥ 0.5 → `project_area_selections` 생성. **재분석 시 기존 사용자 선택 보존**
- [ ] `AreaController` — 조회/선택 API

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/areas` | `[{ areaType, confidence, technologies, evidences: [{ filePath, line, excerpt }], selected }]` |
| PUT | `/api/projects/{projectId}/area-selections` | `{ selections: [{ areaType, selected }] }` → 204 (재분석 없이 즉시 반영 §9.3) |

**테스트 체크리스트:**

- [ ] **fixture 4종 골든: 자동선택(≥0.5) 영역 집합 + 기술 목록 + confidence 구간(§6 표)** ← 완료 기준
- [ ] detector 단위: 대표 시그널 파일 존재 시 signal 생성(12종 각 1개 이상)
- [ ] 빈 repo → 영역 0건, 예외 없음
- [ ] 재분석 후 사용자 선택 보존 upsert

---

### 1-6 · fe — Import Wizard UI `[P4]`

**상태: 완료** — RTL 8/8, lint/typecheck/build green. `VITE_*` 시크릿 없음. 실 백엔드 E2E·SSE 프록시 실측은 1-17. `gen:api`는 스크립트만(CI는 핸드 타입).
**완료 기준:** 영역 선택이 저장·반영
**위치:** `frontend/src/features/import/`, `frontend/src/api/`

**구현 체크리스트:**

- [ ] `/import` 라우트 + `ImportWizardPage`(4단계 스텝퍼)
- [ ] Step 1 Connect — `GET /api/auth/me` 확인. 미인증: OAuth 버튼(`/oauth2/authorization/github` 이동) + PAT 입력 폼(`POST /api/auth/pat`)
- [ ] Step 2 Repo — `GET /api/github/repos` 검색·페이지네이션 → 선택 → `POST /api/projects`
- [ ] Step 3 Progress — `GET /api/jobs/{id}` 초기값 + `EventSource('/api/jobs/{id}/events')` 구독 → **step 체크리스트 UI**(§8.2, 요구사항 §32 형태), 실패 시 에러+Retry 버튼(`POST retry`). SSE 재연결 시 GET으로 상태 복구
- [ ] Step 4 Areas — `GET areas` → 영역 카드(confidence bar, 기술 뱃지, 근거 파일 목록 §9.2) → 체크박스(기본 ≥0.5 체크) → `PUT area-selections` → 워크스페이스 이동 ← 완료 기준
- [ ] API 클라이언트 기반: `npm run gen:api`(openapi-typescript, springdoc 스펙) + fetch 래퍼(CSRF 헤더 `X-XSRF-TOKEN` 인터셉터, 401 → Connect 유도, credentials include)
- [ ] Vite dev proxy(`/api`, `/oauth2`, `/login` → 8080) 설정 — SSE 버퍼링 없이 통과 확인

**테스트 체크리스트:**

- [ ] 단계 전환 흐름(RTL) — 인증/미인증 분기
- [ ] EventSource mock → step 상태 갱신 렌더, 실패 → Retry 노출
- [ ] 영역 선택 변경 → PUT payload 검증 ← 완료 기준
- [ ] 401 응답 → Connect step 유도

**보안 유의점:** `VITE_*` 변수에 시크릿 금지(§18 ④ — OAuth client id/secret은 서버에만 존재, FE는 redirect만).

---

### 1-7 · be — Git metadata 수집 (commits/branches/tags/PR) `[P5]`

**완료 기준:** rate limit 백오프 동작
**패키지:** `dev.codeintelligence.history`

**구현 체크리스트:**

- [ ] `V5__git_metadata.sql` (§3 표)
- [ ] `GitMetadataStep`(GIT_METADATA) — JGit RevWalk 전체 커밋(author/message/committed_at/additions/deletions), `commit_files`(DiffFormatter, rename 감지), branches/tags. **API 아닌 clone에서 추출(clone 우선주의 §7.2)**
- [ ] 커밋 수 상한 `app.analysis.max-commits`(기본 10,000) — 초과 시 최신순 절단 + 경고 evidence
- [ ] `PullRequestCollector` — GitHub REST `GET /repos/{o}/{r}/pulls?state=all` 페이지네이션. **프로젝트별 ETag 저장 → 304 시 skip. 403 rate limit(`x-ratelimit-remaining=0`)·`Retry-After` → 지수 백오프, N회 초과 시 step FAILED(retry로 재개)** ← 완료 기준
- [ ] 멱등 upsert: `(project_id, sha)` / `(project_id, number)`
- [ ] `HistoryController` — 타임라인/상세/diff API. diff는 JGit DiffFormatter로 파일 단위 old/new 콘텐츠 반환(Monaco DiffEditor 입력용), 크기 상한 초과 시 413

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/commits?page&branch` | 커밋 타임라인(페이지네이션) |
| GET | `/api/projects/{projectId}/commits/{sha}` | 상세 + 변경 파일 목록 |
| GET | `/api/projects/{projectId}/commits/{sha}/diff?path=` | `{ changeType, oldContent, newContent }` |
| GET | `/api/projects/{projectId}/branches` · `/tags` | 목록 |
| GET | `/api/projects/{projectId}/pulls?state` | PR 목록(제목/상태/author/merged_at/sha) |

**테스트 체크리스트:**

- [ ] JGit temp repo(커밋 4~5, 브랜치/태그 각 1) → 수집 골든(커밋 수·파일 변경·±라인)
- [ ] **MockRestServiceServer: 403 rate limit → 백오프 → 재시도 성공 / Retry-After 존중 / 초과 시 step FAILED** ← 완료 기준
- [ ] ETag 304 → 기존 데이터 유지, 추가 fetch 없음
- [ ] diff API: 없는 sha 404, path 검증, 상한 초과 413

**보안 유의점:** PR body는 신뢰 불가 입력 — FE는 plain text 렌더(Phase 1은 마크다운 렌더 안 함).

---

### 1-8 · be — CodeAnalyzer SPI + JavaAnalyzer `[P6]`

**완료 기준:** spring-mini 골든 그래프 일치
**패키지:** `dev.codeintelligence.analysis.core`(SPI), `dev.codeintelligence.analysis.java`, `dev.codeintelligence.analysis.graph`

**구현 체크리스트:**

- [ ] 의존성: `com.github.javaparser:javaparser-symbol-solver-core`
- [ ] `V6__code_graph.sql` (§3 표)
- [ ] SPI(§10.1): `CodeAnalyzer { boolean supports(FileInventory); AnalysisResult analyze(AnalysisContext); }` — `AnalysisResult`는 nodes/edges/evidences. **registry 패턴(빈 목록 주입), 언어 추가 시 구현체만 추가**
- [ ] `SourceParsingStep`(SOURCE_PARSING) — supports 매칭 분석기 실행. **파일 단위 예외 격리**: 한 파일 파싱 실패는 기록 후 계속, step은 성공
- [ ] natural_key 규약(§8.3 idempotent 기반) 상수화: `file:{path}` / `java:{fqcn}` / `java:{fqcn}#{method(paramTypes)}` / `endpoint:{METHOD}:{path}` / `table:{name}` / `container:{service}` / `ci:{workflow}:{job}`
- [ ] `graph/GraphPersistenceService` — `(snapshot_id, natural_key)` upsert, edge는 양끝 natural_key 해석 후 저장
- [ ] `JavaAnalyzer` — JavaSymbolSolver(소스 루트 + ReflectionTypeSolver). 노드: PACKAGE/CLASS/INTERFACE/ENUM/ANNOTATION/METHOD/FIELD(+라인 범위). edge: IMPORTS/DECLARES/EXTENDS/IMPLEMENTS/ANNOTATED_BY/CALLS/USES_TYPE
- [ ] 호출 해석: SymbolSolver 성공 → CALLS(CONFIRMED). **실패 → 이름 기반 후보 CALLS(POSSIBLE, metadata에 후보 시그니처)**(§10.2)
- [ ] `GraphBuildStep`(GRAPH_BUILD) — DIRECTORY/FILE CONTAINS 체인 정리, 파일 경로 기반 area_type 태깅(예: `src/test` → TESTING)
- [ ] `graph/GraphController` — 노드 조회/관계 API

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/graph/nodes?type&area&q&path` | 노드 검색(페이지네이션) |
| GET | `/api/projects/{projectId}/graph/nodes/{nodeId}` | 상세(+evidence, 파일/라인) |
| GET | `/api/projects/{projectId}/graph/nodes/{nodeId}/relations?direction=in\|out&edgeType&depth=1..2` | callers/callees 등(깊이 제한 §6.3) |

**테스트 체크리스트:**

- [ ] **spring-mini 골든: 노드 타입별 수·natural_key 목록·EXTENDS/CALLS edge 집합 일치** ← 완료 기준
- [ ] Controller→Service CALLS=CONFIRMED, JpaRepository 상속 메서드 호출=POSSIBLE 검증
- [ ] 문법 오류 파일 1개 포함 → 해당 파일만 격리, step 성공
- [ ] 같은 snapshot 재실행 → 중복 0(멱등)
- [ ] relations depth=2 응답 구조

---

### 1-9 · be — 설정 분석기 (build/yml/Docker/CI/SQL) `[P7]`

**완료 기준:** fixture 추출 결과 일치
**패키지:** `dev.codeintelligence.analysis.config`

**구현 체크리스트:**

- [ ] 의존성: `com.github.jsqlparser:jsqlparser` (snakeyaml은 Spring 내장)
- [ ] `V7__infra_resources.sql` (§3 표)
- [ ] `BuildFileAnalyzer` — pom.xml(DOM 파싱)·build.gradle(.kts)(정규식+구조) → 의존성 목록(metadata)·프레임워크 시그널 → CONFIG 노드 + DEPENDS_ON
- [ ] `SqlMigrationAnalyzer` — Flyway/Liquibase 파일 버전순 정렬 → JSqlParser로 CREATE/ALTER TABLE 파싱 → DB_TABLE·MIGRATION 노드 + 최종 스키마 metadata. **파싱 실패 시 파일 수준 MIGRATION 노드로 강등 + evidence 기록**(위험 R8)
- [ ] `DockerAnalyzer` — Dockerfile(FROM/EXPOSE/CMD)·compose(services/ports/depends_on/environment) → **compose 서비스 = CONTAINER 노드**(Dockerfile은 build 참조 시 해당 노드 evidence), depends_on → DEPLOYED_IN edge
- [ ] `GithubActionsAnalyzer` — `.github/workflows/*.yml` 트리거/job/step 요약 → CI_PIPELINE 노드
- [ ] `YamlConfigAnalyzer` — `application*.yml`의 datasource/redis/kafka 설정 → CONFIG 노드 + CONFIGURED_BY evidence
- [ ] `ExtractionStep`(EXTRACTION) 1차 — CONTAINER/CI_PIPELINE 노드 → `infra_resources` 투영
- [ ] `InfraController` — 인프라 리소스 API

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/infra` | `[{ kind(CONTAINER/CI...), name, sourcePath, nodeId }]` |

**테스트 체크리스트:**

- [ ] **fixture 골든: spring-mini(DB_TABLE 1·MIGRATION 2), fullstack-mini(CONTAINER 3 + DEPLOYED_IN + CI_PIPELINE 1), infra-mini(CONTAINER 2·CI_PIPELINE 1)** ← 완료 기준
- [ ] gradle/pom 의존성 추출 단위(버전 표기 변형 포함)
- [ ] 깨진 SQL → 강등 + evidence, step 성공
- [ ] compose depends_on → edge 방향 검증

---

### 1-10 · be — API endpoint + JPA entity 추출, 레이어 태깅 `[P8]`

**완료 기준:** endpoint 목록 정확도 검증
**패키지:** `dev.codeintelligence.analysis.java`(Spring 특화), `dev.codeintelligence.analysis.graph`

**구현 체크리스트:**

- [ ] `V8__endpoints_entities_features.sql` (§3 표 — 1-11과 공유)
- [ ] `SpringEndpointExtractor` — `@RestController`(+`@Controller`+`@ResponseBody`), 클래스 `@RequestMapping` prefix × 메서드 `@Get/Post/Put/Delete/Patch/RequestMapping` → **경로 합성·정규화(경로변수 `{}` 유지)** → API_ENDPOINT 노드 + EXPOSES edge + `api_endpoints` row(http_method, path, handler_key)
- [ ] `JpaEntityExtractor` — `@Entity`/`@Table(name)`(없으면 클래스명 snake_case 기본 전략, 규칙 주석 명시) → DB_ENTITY 노드 + `db_entities` row(source=JPA). migration 테이블과의 MAPS_TO 매칭은 Phase 2(§11.2)
- [ ] `LayerTagger` — `@RestController`→CONTROLLER, `@Service`→SERVICE, `@Repository`/JpaRepository 상속→REPOSITORY, `@Entity`→ENTITY, `@Configuration`→CONFIG를 `graph_nodes.metadata.layer`에 기록
- [ ] `ExtractionStep` 완성 — endpoint/entity 투영 추가
- [ ] `ArchitectureController` — **그래프 프로젝션(저장 없음, §12.2)**: 레이어 그룹핑 + 그룹 간 CALLS 집계. `area=SYSTEM`은 CONTAINER/CI 토폴로지(Phase 1 한정 — cross-domain edge는 Phase 2)

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/endpoints` | `[{ httpMethod, path, handlerKey, nodeId, filePath, line }]` |
| GET | `/api/projects/{projectId}/entities` | `[{ entityName, tableName, nodeId }]` |
| GET | `/api/projects/{projectId}/architecture?area=BACKEND\|SYSTEM` | `{ groups: [{ layer, nodes }], edges: [{ sourceGroup/Node, targetGroup/Node, count }] }` |

**테스트 체크리스트:**

- [ ] **spring-mini 골든: endpoint 5건 메서드/경로 정확 일치** ← 완료 기준
- [ ] 클래스 prefix 합성·경로변수·중복 슬래시 정규화 케이스
- [ ] `@Table` 생략 entity의 snake_case 기본 전략
- [ ] architecture 프로젝션: BACKEND 레이어 그룹 4종 + 집계 edge 수

---

### 1-11 · be — Feature 기본 추출 (경로 prefix + 패키지 군집) `[P8]`

**완료 기준:** fixture에서 기대 feature 생성
**패키지:** `dev.codeintelligence.analysis.feature`

**구현 체크리스트:**

- [ ] `FeatureDetectionStep`(FEATURE_DETECTION) — 시드 군집(§12.1, **전부 정적**): ① endpoint 경로 1세그먼트 prefix(`/auth/*`, `/todos/*`) ② 최상위 패키지/디렉터리 군집
- [ ] 병합 규칙: 두 시드의 노드 중복률 ≥ 임계값(설정, 기본 0.5) → 병합, 이름은 endpoint prefix 우선
- [ ] `FeatureLinkBuilder` — 군집 endpoint → EXPOSES 역추적 → controller → CALLS(depth ≤ 3) → service/repository/entity, role은 API/SERVICE/DATA 부여(UI role은 Phase 2)
- [ ] `features`(detection=STATIC, confidence)·`feature_links` 저장 + evidence 연결
- [ ] `FeatureController` — 조회 API (Features 화면은 Phase 2, API만 노출)

**API 계약:**

| Method | Path | 요청/응답 개요 |
|---|---|---|
| GET | `/api/projects/{projectId}/features` | 트리 `[{ id, name, detection, confidence, children }]` |
| GET | `/api/projects/{projectId}/features/{featureId}` | `{ links: [{ role, nodeId, name, filePath }], evidences }` |

**테스트 체크리스트:**

- [ ] **spring-mini 골든: feature 2건(auth, todos), todos의 links에 Controller/Service/Repository/Entity 포함** ← 완료 기준
- [ ] fullstack-mini: BE 군집 정상(FE 군집은 Phase 2 명시)
- [ ] 병합 규칙 단위(중복률 경계값)

---

### 1-12 · fe — Code explorer (파일트리 + Monaco + 심볼 패널) `[P9]`

**완료 기준:** 노드→코드 라인 이동 동작
**위치:** `frontend/src/features/code/`

**구현 체크리스트:**

- [ ] 의존성: `@monaco-editor/react` — **lazy route chunk로 분리**(번들 영향 최소화)
- [ ] `CodeExplorerPage` — workspaceTabs `code` 탭의 placeholder element 교체, URL 상태 `?path=&line=`
- [ ] `FileTreePanel` — `GET files` → 디렉터리 트리(접기/펼치기, 언어 아이콘)
- [ ] `CodeViewer` — `GET file-content` → Monaco read-only. `?line=` 진입 시 revealLineInCenter + 라인 decoration. 바이너리/상한 초과(413/415)는 안내 UI
- [ ] `SymbolPanel` — 파일 내 심볼(`GET graph/nodes?path=`), 선택 심볼의 callers/callees(`relations` API) 목록. **항목 클릭 → 대상 파일·라인으로 네비게이트** ← 완료 기준
- [ ] `uiContextStore` 확장 — `{ focusedFile, focusedNode }` 유지(§15.3, Phase 3 AI 컨텍스트 대비 저장만)

**테스트 체크리스트:**

- [ ] 트리 렌더·탐색 → 파일 선택 시 content fetch
- [ ] `?path=&line=` 진입 → 해당 위치 표시(Monaco mock)
- [ ] callers 항목 클릭 → URL(path/line) 변경 assert ← 완료 기준
- [ ] 대형/바이너리 파일 안내 상태

---

### 1-13 · fe — Architecture 뷰 (React Flow, Backend/System) `[P10]`

**완료 기준:** 노드 클릭→코드 이동
**위치:** `frontend/src/features/architecture/`

**구현 체크리스트:**

- [ ] 의존성: `@xyflow/react` + `elkjs` — lazy chunk
- [ ] `ArchitecturePage` — workspaceTabs `architecture` 탭 교체. 영역 탭: Backend(레이어 뷰) | System(CONTAINER/CI 토폴로지). **선택 영역(§9.3) 반영 — 미선택 영역 탭 숨김**
- [ ] `GET architecture?area=` → elkjs 레이아웃 계산 → React Flow 노드(레이어 그룹 컨테이너) + edge(집계 count 라벨)
- [ ] **노드 클릭 → code 탭 `?path=&line=` 이동** ← 완료 기준
- [ ] 분석 전/빈 그래프 empty state

**테스트 체크리스트:**

- [ ] projection mock 렌더(그룹·노드 수)
- [ ] 노드 클릭 → 라우팅 assert ← 완료 기준
- [ ] 영역 미선택 시 탭 숨김

---

### 1-14 · fe — History 뷰 (commit/PR 타임라인, diff) `[P11]`

**완료 기준:** diff 렌더 정상
**위치:** `frontend/src/features/history/`

**구현 체크리스트:**

- [ ] `HistoryPage` — workspaceTabs `history` 탭 교체. 좌: 커밋 타임라인(`useInfiniteQuery` 페이지네이션) + PR 탭, 우: 상세
- [ ] `CommitDetail` — 메시지/author/±라인/변경 파일 목록, 파일 클릭 → diff
- [ ] `DiffViewer` — Monaco DiffEditor(1-12에서 도입한 Monaco 재사용). `GET commits/{sha}/diff?path=`의 oldContent/newContent 입력 ← 완료 기준
- [ ] PR 목록: 제목/상태/author/merged_at (body는 plain text)
- [ ] era 타임라인은 Phase 2 비범위 — 탭 설명만 유지

**테스트 체크리스트:**

- [ ] 타임라인 렌더 + 페이지네이션 fetch
- [ ] 커밋 선택 → 상세 렌더
- [ ] diff 응답 mock → DiffEditor 렌더 ← 완료 기준

---

### 1-15 · fe — Home + 프로젝트 카드 + 사이드바 Areas `[P11]`

**완료 기준:** 요구 정보 표시
**위치:** `frontend/src/features/home/`, `frontend/src/app/Sidebar.tsx` (+be 보조: 프로젝트 목록 summary 필드)

**구현 체크리스트:**

- [ ] be 보조 작업: `GET /api/projects` 응답에 카드용 summary 포함 — 선택 영역, 기술 상위 N, snapshot 상태/analyzed_at, 최근 commit(sha/메시지), 최근 PR. task/note 수는 Phase 4 전까지 미표시(§15.2)
- [ ] `HomePage` 개편 — 프로젝트 카드 그리드(§15.2 Home 요구 정보) + Import CTA + 진행 중 job 배지 ← 완료 기준
- [ ] `Sidebar` — 프로젝트 노드 아래 **Areas 체크박스**(요구사항 §11): `GET areas` 표시, 토글 → `PUT area-selections` → **재분석 없이 즉시 반영**(§9.3)
- [ ] `uiContextStore`에 selectedAreas 반영(뷰 필터 공통 소비 준비)
- [ ] workspaceTabs 정리 — Phase 1 실제 범위에 맞게 phase 표기 조정(features 탭은 Phase 2)

**테스트 체크리스트:**

- [ ] 카드 필드(영역/기술/상태/commit) 렌더
- [ ] Areas 토글 → PUT 호출 + 낙관적 갱신
- [ ] 분석 중 프로젝트 상태 표시

---

## 6. Fixture 저장소 명세

위치: `backend/src/test/resources/fixtures/{이름}/` — **일반 디렉터리로 커밋**(nested `.git` 금지). 테스트 헬퍼 `FixtureRepo.create("spring-mini")`가 temp 디렉터리로 복사 후 JGit `init`+commit하여 git 의존 step(clone/metadata)까지 검증한다. Lombok은 전 fixture 미사용(위험 R1). confidence 구간은 설계 가이드이며, 골든 스냅샷의 확정 수치는 구현 시 1회 고정 후 회귀 기준으로 사용한다.

### spring-mini (~13 파일)

| 파일 | 내용 |
|---|---|
| `build.gradle`, `settings.gradle` | spring-boot-starter-web/data-jpa/flyway 의존, postgres driver |
| `src/main/resources/application.yml` | datasource(postgres)+redis 설정 |
| `src/main/resources/db/migration/V1__create_todos.sql` | CREATE TABLE todos |
| `src/main/resources/db/migration/V2__add_todos_done_index.sql` | CREATE INDEX |
| `src/main/java/com/example/todo/TodoApplication.java` | @SpringBootApplication |
| `.../api/TodoController.java` | @RestController @RequestMapping("/todos") — GET /todos, GET /todos/{id}, POST /todos |
| `.../api/AuthController.java` | POST /auth/login, POST /auth/logout |
| `.../service/TodoService.java`, `.../service/AuthService.java` | @Service — repository 호출 |
| `.../repository/TodoRepository.java` | extends JpaRepository<Todo, Long> |
| `.../domain/Todo.java` | @Entity @Table(name = "todos") |
| `src/test/java/com/example/todo/TodoServiceTest.java` | JUnit 5 |

| 기대 영역 | confidence | 기술 | 자동선택 |
|---|---|---|---|
| BACKEND | 0.8~1.0 | Java, Spring Boot | ✓ |
| DATABASE | 0.5~0.9 | Flyway, JPA, PostgreSQL | ✓ |
| TESTING | 0.3~0.7 | JUnit | 구현 시 확정 |
| BUILD_TOOLING | 0.2~0.6 | Gradle | — |

구조 기대(골든): endpoint 5, entity 1(Todo→todos), DB_TABLE 1·MIGRATION 2, CALLS 체인 Controller→Service(CONFIRMED)→Repository(POSSIBLE — JpaRepository 상속 메서드는 소스 미보유), feature 2(auth, todos).

### react-mini (~10 파일)

| 파일 | 내용 |
|---|---|
| `package.json` | react, react-dom, react-router-dom / devDeps: vite, typescript, vitest |
| `index.html`, `vite.config.ts`, `tsconfig.json` | Vite 표준 |
| `src/main.tsx`, `src/App.tsx` | 라우트 2개(/, /todos) |
| `src/pages/HomePage.tsx`, `src/pages/TodosPage.tsx` | TodosPage에 `fetch('/api/todos')` (Phase 2 매칭 대비 시그널) |
| `src/components/TodoItem.tsx`, `src/components/TodoItem.test.tsx` | 컴포넌트+테스트 |

| 기대 영역 | confidence | 기술 | 자동선택 |
|---|---|---|---|
| FRONTEND | 0.8~1.0 | React, TypeScript, Vite | ✓ |
| TESTING | 0.3~0.7 | Vitest | 구현 시 확정 |
| BUILD_TOOLING | 0.2~0.6 | Vite | — |

구조 기대: Phase 1은 FILE 노드만(TS AST는 Phase 2) — 인벤토리·영역 감지 골든 전용.

### fullstack-mini (~25 파일)

구성: spring-mini 파일을 `backend/` 하위로, react-mini 파일을 `frontend/` 하위로 복사 배치(내용 동일) + 루트에 `docker-compose.yml`(postgres/backend/frontend 3서비스, backend→postgres depends_on) + `.github/workflows/ci.yml`.

| 기대 영역 | confidence | 기술 | 자동선택 |
|---|---|---|---|
| BACKEND | 0.8~1.0 | Java, Spring Boot | ✓ |
| FRONTEND | 0.8~1.0 | React, TypeScript, Vite | ✓ |
| DATABASE | 0.5~0.9 | Flyway, JPA, PostgreSQL | ✓ |
| INFRASTRUCTURE | 0.5~0.9 | Docker Compose | ✓ |
| DEVOPS | 0.5~0.9 | GitHub Actions | ✓ |
| TESTING / BUILD_TOOLING | 0.2~0.7 | JUnit, Vitest, Gradle, Vite | 구현 시 확정 |

구조 기대: CONTAINER 3 + DEPLOYED_IN(backend→postgres), CI_PIPELINE 1, endpoint/feature는 spring-mini와 동일 집합.

### infra-mini (~6 파일)

| 파일 | 내용 |
|---|---|
| `Dockerfile` | multi-stage 빌드 스텁 |
| `docker-compose.yml` | app(build: .) + postgres 2서비스 |
| `terraform/main.tf` | aws_s3_bucket 리소스 1개 스텁 — **area 시그널 전용(HCL 파싱은 Phase 2)** |
| `.github/workflows/deploy.yml` | push 트리거 deploy job |
| `scripts/deploy.sh`, `README.md` | 셸 스텁, 문서 1개 |

| 기대 영역 | confidence | 기술 | 자동선택 |
|---|---|---|---|
| INFRASTRUCTURE | 0.7~1.0 | Docker, Docker Compose, Terraform | ✓ |
| DEVOPS | 0.6~1.0 | GitHub Actions | ✓ |
| 기타 영역 | <0.3 또는 미감지 | — | — |

구조 기대: CONTAINER 2(app, postgres — app은 Dockerfile evidence 연결), CI_PIPELINE 1, DEPLOYED_IN 1.

---

## 7. Phase 1 위험과 대응

| # | 위험 | 대응 |
|---|---|---|
| R1 | JavaParser/SymbolSolver 해석 한계(Lombok·제네릭·동적 디스패치) | 미해석 호출은 POSSIBLE로 강등 저장(§10.2), 파일 단위 예외 격리, fixture는 Lombok 배제, 한계를 노드 metadata에 기록 |
| R2 | GitHub rate limit / API 장애 | clone 우선주의로 API 의존 최소화(§7.2), ETag 조건부 요청, 지수 백오프 + `Retry-After` 존중, step 체크포인트로 재개(1-7) |
| R3 | 대형 repo의 clone/파싱 시간·메모리 | 파일 수·파일 크기·커밋 수 상한(설정값), 배치 저장, step 진행률 표시, 초과 시 부분 분석 + 경고 evidence |
| R4 | OAuth App 미설정 환경 | PAT 로그인을 1급 경로로 구현(1-1) — OAuth 없이 Phase 1 전체 검증 가능. `.env.example`에 두 경로 안내 |
| R5 | Spring Boot 4.1 초기 생태계(OAuth2 Client/Session 스타터 명명·호환) | P1 착수 시 최소 스파이크 커밋으로 조기 검증, 비호환 시 대안(세션 수동 구성) 기록 후 진행 |
| R6 | SSE 안정성(프록시 버퍼링, 재연결, 브라우저 연결 수 제한) | 15초 하트비트, 접속 시 상태 스냅숏 즉시 전송, 재연결 시 GET job으로 복구, Vite dev proxy SSE 통과 확인(1-6) |
| R7 | 골든 테스트 취약성(분석기 개선마다 스냅샷 파손) | 의미 단위 집합 비교(노드 key 집합, edge 집합) + confidence는 구간 assert, 스냅샷 갱신은 PR 리뷰에서 사유 확인(§19) |
| R8 | JSqlParser의 PostgreSQL 방언 한계 | 파싱 실패 시 파일 수준 MIGRATION 노드로 강등 + evidence, 골든에 강등 케이스 포함(1-9) |

---

## 8. 게이트

### 1-16 · sc — 토큰·clone 경로·파일 서빙 보안 점검

**Mode:** audit-first — findings를 severity와 함께 리포트, 수정은 별도 PR(`feature/phase1-security-fixes`)로.

**Checklist:**

- [ ] §18 이월 TODO 이행 확인: ① TOKEN_ENC_KEY 32바이트 기동 검증·암호문별 고유 nonce·key_version ② Spring Session Redis + CSRF + SameSite=Lax ③ CORS 허용목록(wildcard+credentials 금지) ④ `VITE_*` 번들 내 시크릿 없음(grep 검증)
- [ ] 토큰 노출 경로 0: API 응답 DTO·로그·에러 메시지·SSE payload 전수 확인
- [ ] SSRF: `github.com` 외 호스트/스킴 import 전부 거부(테스트 존재 확인)
- [ ] Path traversal: `file-content`·diff의 path 파라미터 canonical 검증 + 우회 변형(인코딩, 심볼릭 링크) 시도
- [ ] clone 경로 격리: `${DATA_DIR}/repos/{projectId}` 밖 접근 불가, 삭제 시 경로 재검증
- [ ] 인증/인가: 모든 `/api/**` 401 기본, **프로젝트 소유자 검증(user_id 스코프, IDOR)** — 조회 API 전수
- [ ] clone 코드 비실행 원칙: 빌드/실행 코드 경로 없음 확인(파서만)
- [ ] 신규 public 표면 위협 모델: OAuth 콜백, PAT 등록, SSE, 파일 서빙
- [ ] 의존성 감사: `npm audit` / gradle 의존성 리포트 — critical 0
- [ ] findings를 severity(critical/high/medium/low)로 리포트, critical/high 0이 될 때까지 수정 반복
- [ ] P1 조기 점검(1-1) 이월 LOW 3건 재평가: PAT 등록 rate-limit 부재(GitHub API 대리 호출), springdoc `/v3/api-docs`·swagger 공개 유지 여부, 토큰 로그 미출력의 로그 캡처 테스트 부재(서버 루프백 바인딩은 P1에서 반영 완료)
- [ ] P2 조기 점검(1-2·1-3) 이월 LOW 4건 재평가: retry의 트랜잭션 내 guard 순서, 프로젝트 삭제 TOCTOU 고아 디렉터리 가능성, RepoRef `.` 단독 세그먼트·대소문자 중복 import 하드닝, SSE emitter 잔존 정리
- [ ] P3 조기 점검(1-4·1-5) 이월: evidence excerpt가 설정 파일 앞 80자를 그대로 저장(시크릿 마스킹은 LLM 연동 전/1-16), file-content symlink 탈출 통합 테스트 부재, PUT `/area-selections` IDOR 테스트 부재(코드는 user_id 스코프)

### 1-17 · verify — Phase 1 최종 검증 (DoD)

**Checklist:** (글로벌 verify 하드 스위트 — FE+BE+보안+디버거 증거 기준)

- [ ] §21 Phase 1 완료 기준 전수 재검증: 1-1 private repo 목록 / 1-2 public·private clone / 1-3 실패 step 재시도 / 1-4·1-5 fixture 골든 / 1-6 영역 선택 저장·반영 / 1-7 rate limit 백오프 / 1-8 spring-mini 골든 그래프 / 1-9 fixture 추출 일치 / 1-10 endpoint 정확도 / 1-11 기대 feature / 1-12 노드→코드 이동 / 1-13 노드 클릭→코드 / 1-14 diff 렌더 / 1-15 요구 정보 표시
- [ ] backend: `./gradlew spotlessCheck build` green(단위+Testcontainers 통합+골든 전부)
- [ ] frontend: `npm run lint && npm run typecheck && npm test -- --run && npm run build` green
- [ ] CI green(main 기준), 마이그레이션 V2~V8 순차 적용 + JPA `ddl-auto=validate` 통과 + 재기동 멱등
- [ ] 1-16 findings critical/high 0 확인(리포트 첨부)
- [ ] 수동 E2E(실 GitHub 계정): public·private repo 각 1개 import → Wizard 완주 → 영역 선택 → Code/Architecture/History 탐색 → 재분석 → 의도적 실패 후 retry 복구
- [ ] `.env.example`·README가 실제 기동 절차와 일치(PAT-only 경로 포함)
- [ ] 이월 항목(§1 비범위)이 Phase 2 백로그로 기록됨

---

## 9. 마스터 체크리스트

- [ ] 모든 1-1~1-17 task에 소유자 + 완료 기준(기획서 §21 원문) + 체크리스트 존재
- [ ] 체크박스 없는 task 없음, TBD/placeholder 없음
- [ ] Frontend task는 `fe`만(1-6, 1-12~1-15), Backend task는 `be`만(1-1~1-5, 1-7~1-11) 소유
- [ ] 보안 task는 `sc`(1-16) — 인증·토큰·파일 서빙·공개 표면이 있으므로 필수 게이트
- [ ] debug task: N/A — 그린필드 기능 개발, 활성 버그/실패 없음(발생 시 해당 PR 내에서 debug 에이전트 투입)
- [ ] verify(1-17)가 마지막 게이트 — PASS 전 Phase 2 진입 금지(§20 위험 10)
- [ ] 각 PR이 자기 마이그레이션·테스트 포함, merge 순서 = V 번호 순서

## Handoff

승인 후 P1부터 **task-by-task**로 소유 에이전트(`be`/`fe`/`sc`/`verify`)가 구현한다. ID 건너뛰기 금지, 작업 완료 시 본 문서의 체크박스를 갱신한다.
