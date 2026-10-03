# 출시 감사 — 2026-10-02

**판정: No-Go (일반 사용자 대상 프로덕션 출시).** 내부 RC 검증은 계속할 수 있다. 빌드와 작은 fixture의 성공이 실제 GitHub OAuth, 새 Mac 설치, 대형 NestJS 저장소의 정확도, 안전한 재해 복구를 증명하지 않는다.

이 문서는 최초 감사와 F1–F12의 실행 기록이다. 이후 S1·T00a 및 E1/E3/E5 수정의 최신 결과는 [전체 실행 상태](audit/execution-status-2026-10-02.md)와 [독립 재검토](audit/execution-review-2026-10-02.md)를 따른다. 아래 미해결 표와 테스트 수를 후속 코드의 최종 상태로 복사하지 않는다.

## 기준과 작업 범위

- 실제 경로: 사용자 Mac의 `code-intelligence` 저장소. 시작 브랜치 `codex/e2e-docs-scripts`, 시작 HEAD `ebe3ab1`.
- 시작 시 추적 파일의 변경은 없었다. 기존 `desktop/dist`, `desktop/node_modules`, `desktop/stage`, `frontend/test-results`는 보존했다. 해당 산출물을 `.gitignore`에 추가했으며 삭제하지 않았다.
- 상위 경로와 저장소에서 `AGENTS.md`, `.agents/skills`를 발견하지 못했다. README, CI, 패키지 스크립트, 현재 소스와 테스트를 기준으로 했다. `.env` 내용이나 사용자 저장소 데이터는 보고서에 사용하지 않았다.
- 과거 RC 숫자와 기존 패키지는 역사적 기록으로만 취급했다. 현재 변경을 기존 `.app`에 다시 스테이징하지 않았다.
- GUI 공유 작업을 방해하지 않았다. 브라우저 검증은 별도 headless Playwright 프로세스만 사용했다. 커밋, 푸시, PR, 게시, 배포, 유료 API 호출을 수행하지 않았다.

## 확인한 실제 구조

`Electron main/preload → loopback Spring Boot API → PostgreSQL 16/pgvector + Redis`, React 19/Vite 화면, NestJS/ts-morph 분석 sidecar로 구성된다. Java 21 toolchain과 Flyway V1–V21을 사용한다. tree-sitter sidecar는 저장소에 있지만 데스크톱 staging/startup에는 포함되지 않는다.

Electron은 JRE, 백엔드 JAR, PostgreSQL, Redis, TypeScript 분석기를 함께 실행한다. OS `safeStorage`에는 로컬 identity, DB 비밀번호, 토큰 암호화 키와 승인 경로가 저장된다. GitHub 토큰 및 사용자 AI 키는 백엔드에서 암호화된다. 분석 대상 소스를 빌드하거나 실행하는 경로는 확인하지 못했다. `ProcessBuilder`/shell 실행은 런타임 바이너리와 관리 작업에 집중되어 있다.

정규 경로 검사, 소유자별 프로젝트 접근, CSRF, CORS, Electron sandbox/context isolation, 외부 URL allowlist, 근거 링크, 신뢰도 분류, snapshot 비교, job 재시도는 존재한다. 그러나 아래 경계와 정확도 문제 때문에 이를 완성된 배포 제품으로 판정할 수 없다.

## 구현한 수정 — 1차 감사

F1–F7은 최초 감사 수정이다. 후속 승인에 따른 F8–F12를 아래에 구분했다.

심각도 High는 출시 전 해결 필수, Medium은 안정성/개발 품질 문제다. 우선순위 P1은 이번 수정 또는 다음 출시 게이트, P2는 그 후 개선이다. 행의 줄 번호는 수정 후 소스 기준이다.

| ID / 심각도 / 우선순위 | 근거 및 사용자 영향 | 수정·검증 |
|---|---|---|
| F1 High / P1 | `SecurityConfig.java:110`, `desktop/src/main.cjs`의 navigation header 주입. 기존에는 첫 문서에만 desktop token이 붙고 script/style/worker는 인증에서 401을 받음. 초기 화면이 뜨지 않을 수 있음. | 앱의 공개 정적 경로 GET만 허용. `/api/projects`는 계속 401. `AuthIntegrationTest.bundledAssetsArePublicButProjectDataStillRequiresAuthentication`가 수정 전 실패, 수정 후 통과. |
| F2 High / P1 | `DesktopPathAuthorizationController.java:32`. 기존에는 LOCAL principal이면 임의 경로 승인 가능. 렌더러가 가진 일반 API token으로 native picker의 경계를 우회할 수 있었음. | 별도 `DESKTOP_PATH_TOKEN`을 main→backend에만 전달. 상수 시간 비교, 누락/잘못된 값 거부. 일반 token 단독/잘못된 main token=403, main token 단독=401, 양쪽 일치=200을 실제 HTTP/DB 통합 테스트로 확인. preload configuration에 main token이 없음을 추가 검증. |
| F3 High / P1 | `desktop/src/main.cjs:165,390,436`. 기존 `stopChild('backend')`의 exit가 자동 재시작을 예약함. 복원 중 서비스 중복 시작 가능. 종료 타이머도 남고 취소한 restart handle이 다음 복구를 막음. | 의도적 종료와 비정상 종료 구분, spawn error 처리, 종료 확인 전 재기동 방지, 타이머 정리. 수정 전 관련 회귀 테스트 실패 → 수정 후 통과. |
| F4 High / P1 | `desktop/src/main.cjs:26,446,552`. 백업/복원/재시작이 동시에 실행될 수 있고, 백업 중 DB snapshot과 repository 복사가 달라질 수 있었음. 복원 SQL 실패 시 일부만 적용될 수 있었음. | 관리 작업 직렬화, 백업/복원 중 backend pause, 실패해도 backend 재개, `pg_restore --single-transaction`. 후속 F10에서 두 저장소의 실패 복구를 구현했다. 프로세스 crash의 완전한 원자성은 보장하지 않으며 marker로 재기동을 차단한다. |
| F5 High / P1 | `desktop/src/main.cjs:360`. 백엔드는 임의 포트인데 native OAuth redirect 기본값은 8080. 승인 callback이 잘못된 서버로 감. | 실제 `runtime.apiBaseUrl`의 callback URI를 주입. 회귀 테스트 통과. OAuth 전체의 운영 호환성은 B1로 남음. |
| F6 High / P1 | `SecretMask.java:12–18`. PEM의 BEGIN 표지만 지우고 본문을 남겼으며, JSON key의 따옴표와 공백이 있는 credential 문자열을 충분히 마스킹하지 않았음. AI context/복사용 prompt/근거에 비밀이 남을 위험. | PEM 전체 및 잘린 블록, JSON/YAML quoted value와 escaped quote를 마스킹. 합성 문자열 회귀 테스트 2개가 수정 전 실패, 수정 후 통과. 임의 비밀 탐지나 header 없는 PEM 중간 조각까지 보장하지는 않음. |
| F7 Medium / P2 | desktop 회귀 테스트가 없고 생성 산출물이 untracked로 대량 노출됨. README는 빈 local allowlist가 home을 허용한다고 잘못 설명. | Node 기반 desktop 테스트 최초 11개(후속 포함 23개)와 CI job 추가, 산출물 ignore, 영문/국문 README의 권한·OAuth·refresh 계약 및 출시 상태 정정. |

수정 파일과 회귀 근거:

- [desktop main](../desktop/src/main.cjs), [desktop 테스트](../desktop/test/runtime.test.cjs)
- [SecurityConfig](../backend/src/main/java/dev/codeintelligence/common/config/SecurityConfig.java), [폴더 권한 controller](../backend/src/main/java/dev/codeintelligence/project/DesktopPathAuthorizationController.java)
- [AuthIntegrationTest](../backend/src/test/java/dev/codeintelligence/AuthIntegrationTest.java), [SecretMask](../backend/src/main/java/dev/codeintelligence/evidence/SecretMask.java), [SecretMaskTest](../backend/src/test/java/dev/codeintelligence/evidence/SecretMaskTest.java)
- [V19→V20→V21 migration 테스트](../backend/src/test/java/dev/codeintelligence/migration/DesktopIdentityMigrationTest.java)

## 후속 승인으로 구현한 수정

| ID / 심각도 / 우선순위 | 재현·영향 | 수정 및 검증 |
|---|---|---|
| F8 High / P1 (B2, B5) | 독립 500파일 batch가 서로 다른 ts-morph Project를 생성. 합성 501파일에서 global prefix가 `/api/users`→`/users`로 손실. | `TsParsingStep.java:75`, `TsRequestBudget.java:7`, `analyze.service.ts`: 프로젝트당 단일 요청, 읽는 중 실제 UTF-8 JSON 예산 10MiB/20,000파일 제한. 초과하면 명시적 실패하며 조용히 분할하지 않는다. 501파일 실제 Nest HTTP에서 prefix와 controller→service CALLS 통과. 요청 escaping/Unicode/한도 검증 포함. |
| F9 High / P1 (B4) | cancel이 즉시 unique index를 풀어 기존 writer와 새 분석·삭제가 겹침. retry CAS 실패 전 step 초기화도 가능. | `JobRepository.java:161`, `JobWorker.java:76`, `JobService.java:48,71`, V21: CANCELLING을 active index에 포함, worker finally 후 CANCELLED. enqueue/retry/delete는 프로젝트 row lock 공유. retry CAS 성공 후만 step 초기화. startup 중단 취소 정리, UI 취소 버튼·SSE 수명 반영. 실제 DB/API 409와 migration, 종료·실패·재시작 회귀 통과. 실행 중 step은 끝까지 수행하며 취소가 완료한 작업을 되돌리지는 않는다. |
| F10 High / P1 (B3) | DB만 hash, 저장소 미검증·stale tree 잔류·복원 중 실패 때 불일치. | `desktop/src/backup.cjs:56,83,112`, `main.cjs:447,662`: format2 DB+모든 파일 SHA-256, 설치 identity 일치, symlink/special file 거부. 선택 자료를 staging 후 재검증, recovery backup→repo swap→transactional SQL. commit 후 오류도 이전 DB/repo로 rollback. rollback 실패/crash marker는 backend 재개·다음 실행을 차단하고 복구 파일 보존. 실제 PostgreSQL 실패 주입 및 정상 복원 통과. |
| F11 High / P1 | `FileInventoryScanner.java:38` 수정 전 gitlink가 가리키는 다른 저장소 commit을 부모 object DB에서 열어 MissingObjectException. | 없는 SHA를 가진 실제 JGit index/commit fixture에서 실패 재현 후 통과. gitlink를 열기 전에 제외하고 `FileInventoryStep.java:78`에 미분석 submodule 개수 근거 기록. 하위 저장소를 자동 다운로드/분석하지 않는다. |
| F12 High / P1 (B13 일부) | provider가 응답한 뒤 evidence 검증/answer 저장 실패 시 사용량 누락. 요약·task chat은 예산/집계 경로가 아예 없음. | `AiUsageService.java:21`, 여섯 chat 호출 경로: 반환 usage를 검증·파싱·저장 전에 별도 autocommit으로 기록. 외부 transaction은 suspend하여 rollback 영향 분리. 요약/task도 같은 사전 soft guard와 집계 적용. 모의 provider 응답 뒤 검증/저장 실패 2건 재현 후 통과, caller rollback·요약 cache·task 집계 검증 추가. 동시 예약·embedding 집계는 B13으로 남음. |

추가 회귀 소스: [TS budget/단일 요청 테스트](../backend/src/test/java/dev/codeintelligence/analysis/ts/), [취소 및 retry](../backend/src/test/java/dev/codeintelligence/job/), [backup 11개 테스트](../desktop/test/backup.test.cjs), [AI 실패 후 집계](../backend/src/test/java/dev/codeintelligence/ai/AiAskApiIntegrationTest.java), [submodule fixture](../backend/src/test/java/dev/codeintelligence/analysis/core/FileInventoryScannerTest.java).

새 backup 계약은 **같은 설치의 신뢰하는 backup**이다. format2는 다른 설치를 거부하며 identity/암호화 키를 export하지 않는다. format1은 기존 DB hash만 검증할 수 있어 native 확인창에서 repository/identity 검증 부재를 명시한다. 비어 있는 repositories도 기존 파일을 지운 상태로 복원한다. hash는 악의적 SQL의 진위 보증이 아니다. crash marker가 있으면 자동 복구하지 않고 멈추므로 오프라인 복구 절차/UX는 여전히 필요하다.

## 발견별 현재 상태 및 남은 출시 blocker

| ID / 심각도 / 우선순위 | 파일·근거 | 사용자 영향과 필요한 조치 |
|---|---|---|
| B1 High / P1 | `GithubNativeOAuthService.java:78–82,174–179,263`: code 교환에 `client_secret` 없음. OAuth App의 repo scope 요청도 없고 만료/refresh 응답을 저장하지 않음. | client ID 설정만으로 정상 로그인/비공개 repo 접근을 보장할 수 없다. GitHub App과 OAuth App 중 제품 선택 및 실제 등록 설정이 필요. **공개 client의 device flow** 또는 **서버에 secret을 보관하는 교환 서비스**를 선택하고 취소·거부·만료·재연결·private repository 인수 검증을 수행해야 한다. secret을 앱에 넣는 수정은 하지 않았다. |
| B2 High / P1 — 제한 범위 내 해결 | F8, `TsParsingStep.java:75`, [501파일 실제 HTTP 재현](audit/reproduce-ts-batch-boundary.cjs). | 500 경계 문맥 손실은 수정. 10MiB/20,000파일을 넘는 프로젝트는 지원 확장 설계가 필요하며 현재 명시적 실패한다. 대형 repo 지원 완료로 해석하면 안 된다. |
| B3 High / P1 — 부분 해결 | F10, `desktop/src/backup.cjs:112`, [실 PostgreSQL 복구 검증](audit/verify-backup-postgres.cjs). | 같은 설치의 예외 발생 rollback·hash·symlink·빈 tree는 수정. portable identity/key 복구, 전원 중단 뒤 오프라인 복구 UX, 실제 native 복원 후 backend health/세션·캐시 일관성은 미검증. unsigned SQL backup은 신뢰하는 자료만 사용해야 한다. |
| B4 High / P1 — 해결 | F9, V21 및 JobFramework/ProjectJobApi/JobServiceRetry 테스트. | 실제 step 종료 전 신규 실행/삭제를 막는다. 취소 지연은 현재 step 실행 시간에 의존하므로 대형 repo 지연 측정은 남음. |
| B5 High / P1 — 부분 해결 | F8, `TsRequestBudget.java:7`. | HTTP 413 이전에 실제 JSON byte budget으로 명시적 중단하고 소스 누적 크기를 제한한다. 단일 프로젝트 ts-morph 메모리 배수·대형 파일/monorepo 처리·전체 process-tree RSS와 취소 지연 검증은 남음. |
| B6 High / P1 | `LocalImportService.java:186,204`: 개수 50,000 제한은 있지만 copy 단계에는 byte/파일 크기 제한 없음. BLOCKED_DIRS에는 `.ssh/.aws/.gnupg/.config`가 없고 secret-root 검사는 선택한 root만 확인. | 큰 바이너리 때문에 disk/RAM을 소모할 수 있고, home/상위 폴더 선택 시 nested credential 디렉터리를 복사할 수 있다. 원본은 수정하지 않지만 로컬 snapshot/backup 범위가 과도해진다. preview/copy/inventory의 공통 제외 규칙·총 byte budget·선택 범위 UX가 필요. |
| B7 Medium / P1 | `LocalSourceStatusService.java:60–79`: snapshot ID와 added/modified/deleted **개수**만 비교. | 한 파일을 계속 수정하거나 변경 대상만 바꾸면 preview 후 내용이 달라도 승인 통과. 현재 문서의 강한 “소스 변경 감지” 표현은 수정했다. source digest/preview token을 API와 UI에 추가하고 copy 시점까지 결합해야 함. |
| B8 High / P1 | `CoverageService.java:127–145`에서 inventory count를 analyzed로 그대로 쓰고 parsing failure 조회 결과를 반영하지 않음. analyzer active도 구성 유무 기반. | disabled/실패/부분 분석에서 화면이 완전한 분석으로 오해될 수 있음. 저장된 analyzer별 실제 처리 결과와 snapshot 당시 상태로 coverage를 계산해야 한다. 정확도/불확실성 표시는 이 제품의 핵심 출시 조건. |
| B9 High / P1 | `desktop/scripts/stage-runtime.mjs:68–85`는 dylib를 복사하지만 install name을 재작성하지 않음. 기존 staged postgres/redis의 `otool -L`에 `/opt/homebrew/...`가 남아 있음. `main.cjs`는 DYLD_LIBRARY_PATH fallback에 의존. `desktop/package.json`은 mac arm64 로컬 bundle 위주. | Homebrew 없는 새 Mac, 서명된 hardened runtime, notarization/Gatekeeper 실행을 확인하지 못함. 이 정적 증거만으로 새 Mac 실행 실패를 확정하지는 않지만 “개발 도구 불필요”를 증명하지도 못함. 독립된 runtime dependency/signing 검증과 깨끗한 기기 인수 테스트 필수. 서명/업데이트/rollback 배포 채널도 미검증. |
| B10 Medium / P2 | `stage-runtime.mjs:221–222`: 기존 stage 삭제 후 새 디렉터리 rename. | 그 사이 중단되면 기존 유효 stage도 잃는다. README의 원자 교체 주장을 정정. 이전 stage 보존→swap→검증→정리 방식 필요. 기존 stage는 이번 감사에서 건드리지 않음. |
| B11 Medium / P2 | `OpenInIdeButton.tsx`의 `window.location.href = response.uri`, `main.cjs:644`는 다른 origin navigation을 차단하고 external allowlist는 GitHub HTTPS만 허용. `IdeOpenService.java:61–69`는 lexical containment만 검사. | 데스크톱 IDE 링크 동작이 보장되지 않으며 symlink 경계도 추가 검증 필요. 검증된 IDE scheme/path만 처리하는 별도 main bridge를 설계해야 함. 앱 내부 source viewer와는 별도 문제. |
| B12 High / P1 | `frontend/e2e/import.spec.ts` 전체 API mock; accuracy oracle는 spring-mini/react-mini/fullstack-mini 위주. | 브라우저 2개 테스트 통과는 실제 backend/desktop의 로그인 없이 가져오기, native dialog, 흐름·근거 탐색, 복원 성공을 증명하지 않음. NestJS+React 대표 repo oracle와 실제 packaged desktop 수용 테스트가 필요. |
| B13 High / P1 — 일부 수정, 남은 상한 문제 | `AiUsageService.java:30`은 이미 기록된 총량 조회 후 호출하며 예약/출력 한도가 없다. `SummaryService.java:63,98,125` embedding 응답은 usage 정보를 반환하지 않는다. | 동시 요청은 같은 잔액을 보고 모두 통과할 수 있고, 단일 응답도 남은 한도를 초과할 수 있다. 반환 chat 집계 누락은 F12로 수정했지만 provider timeout/과금 후 응답 손실·집계 DB 장애·embedding은 여전히 미집계 가능. 엄격한 한도는 request 예약/정산·최대 출력·provider별 usage 계약·불확실 결제 처리 정책을 함께 설계해야 한다. 실제 유료 호출 없이 코드·모의 provider만 검증. |

B1의 외부 계약은 현재 [GitHub OAuth App 공식 문서](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)의 code exchange 필수 parameter 및 scope 설명, [GitHub App user access token 공식 문서](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)를 확인했다. PKCE를 보내는 것만으로 client secret 요구가 사라진다는 근거는 없다. 실제 운영 자격증명으로 교환을 시도하지 않았다.

F8/F10 독립 재현은 합성 자료와 임시 Docker DB만 사용한다. GitHub/AI/사용자 저장소 접근이 없다:

```sh
npm --prefix analyzers/ts-analyzer run build
node docs/audit/reproduce-ts-batch-boundary.cjs
node docs/audit/verify-backup-postgres.cjs
```

현재 501파일 결과는 `endpoints: ["/api/users"]`, `controllerServiceCall: true`, `PASS`이다. 수정 전에는 `/users`로 손실되어 exit 1이었다. PostgreSQL 검증은 local cached `pgvector/pgvector:pg16` 이미지가 필요하며 자체 생성한 container/임시 자료만 정리한다.

## 실행한 검증

| 검증 | 결과 | 의미/한계 |
|---|---|---|
| Frontend lint, typecheck, unit, build, typecheck:e2e | **통과**: 21 files / 64 tests | Vite IIFE name 및 큰 chunk 경고 존재. 제품 UI 인수 검증과 구분. |
| Backend `--offline spotlessCheck build` + 수정 후 전체 재검증 | **통과**: 80 suites / 352 tests, 실패·error·skip 0 | 실 Docker/Testcontainers. 최종 전체 실행은 `spotlessApply spotlessCheck build`. 반복 Gradle connection handshake warning이 있었지만 완료와 XML 결과 모두 통과. |
| V19→V20→V21 migration 검증 | **통과**: 전체 suite에 포함 1 test | 실제 PostgreSQL에서 기존 GitHub 사용자·프로젝트 보존, 기본 GITHUB identity, nullable github_id를 가진 LOCAL 계정 생성 확인. CANCELLING unique index와 다음 작업 충돌/해제도 확인. 새 스키마 초기화는 전체 integration에서도 수행. 모든 옛 버전/대규모 사용자 DB 조합을 보장하지 않음. |
| TS analyzer test/typecheck/build | **통과**: 11 tests | 작은 NestJS semantic 및 501파일/10MiB 경계 fixture 포함. |
| Tree analyzer test/typecheck/build | **조건부 통과**: 7 tests | 처음에는 Linux용 node_modules 때문에 native binding 실패. 이미 설치된 동일 버전 rolldown 1.2.4 macOS binding을 로컬 복사하고 `PREBUILDS_ONLY=1`로 bundled macOS prebuild를 사용. lock/source 변경 없음. `npm install --offline` 복구 시도는 cache 부족으로 실패. |
| `PREBUILDS_ONLY=1 ./quality-gate` | **통과** | 최종 소스로 실제 local TS sidecar + DB accuracy 7 tests; corpus 55 files, backend 28s, 측정 RSS 127,584 KiB. 실제 대형 앱의 전체 process-tree 최고 RSS로 해석하면 안 됨. |
| Desktop `npm test`, main/preload syntax | **통과**: 23 tests | main VM 테스트 12개, 실제 임시 filesystem backup 테스트 11개. main의 OS/native 경계는 stub. 실제 Electron/safeStorage/native dialog/서비스 실행 검증 아님. |
| Headless Playwright | **통과**: 2 tests | import/area selection, 실패 job retry. API mock 사용. 사용자 브라우저나 foreground UI 제어 없음. |
| 정적 asset HTTP 회귀 | **실패 재현 → 수정 후 통과** | 401 문제를 실제 Spring Security와 DB 환경에서 검증. API 인증 유지 확인. |
| 비밀 마스킹 회귀 | **2개 실패 재현 → 수정 후 통과** | 합성 PEM/JSON/YAML만 사용. 외부 AI 호출 없음. |
| 합성 501-file NestJS | **실패 재현 → 수정 후 실제 HTTP 통과** | global prefix와 controller→service CALLS 검증. |
| PostgreSQL + repository 복구 | **통과** | 실제 dump/restore, commit 후 오류 주입, 양쪽 rollback 및 정상 복원, recovery backup hash. native 앱 UI 검증은 아님. |
| Git submodule/AI 집계 | **3개 실패 재현 → 수정 후 통과** | 없는 gitlink object, AI validation 및 answer 저장 실패 뒤 usage 보존. 외부 API 없음. |
| `git diff --check` | **통과** | 기존 변경 reset/delete 없음. |
| 변경 후 desktop stage/package 실행 | **미실행** | 기존 산출물을 보존. 기존 `.app`는 현재 패치를 반영하지 않음. |
| 실제 GitHub OAuth/운영 권한/만료 갱신 | **미검증** | 운영 등록·자격증명·제품 flow 선택 필요. |
| 새 Mac 설치, 서명/notarization/Gatekeeper, update/rollback | **미검증** | 현재 머신의 개발 도구 존재로 독립 실행을 증명할 수 없음. |
| 설치된 앱의 native backup/restore, folder picker, 전체 사용자 흐름 | **미검증** | 합성 PostgreSQL 시험과 구분. 현재 설치 데이터에 영향을 주는 실험은 하지 않음. |

검증 환경 Node는 `v26.5.0 arm64`; README/CI의 목표 Node 24와 다르다. CI는 수정된 테스트를 아직 원격에서 실행하지 않았다. 테스트 산출물과 임시 로그는 로컬에만 있다.

## 출시 전 다음 순서

1. OAuth flow·앱 등록 유형, 같은 설치/portable backup 범위, 우선 배포 OS, 엄격한 AI 한도 정책을 결정한다. 기존 아키텍처를 전면 재작성하지 않았다.
2. B6/B8을 먼저 해결한다. 파일 가져오기 제외·용량·권한 경계와 실제 분석/실패/추론 coverage를 믿을 수 있어야 한다. preview digest(B7), 대형 repo budget 확장(B5), AI 예약/정산(B13)을 이어 검증한다.
3. 대표 NestJS+React monorepo oracle에서 화면→endpoint→service→data 근거, 오탐/누락, 취소 후 재분석/삭제를 검증한다. 이 범위 밖 언어의 support depth는 별도 [후속 기획 인수 문서](planning-handoff-2026-10-02.md)에 정리했다. 다국어 확대를 이번 변경에 구현하지 않았다.
4. 별도 RC를 새로 스테이징하여 개발 도구 없는 Mac에서 signed/notarized 설치→local import→GitHub private import→마인드맵/흐름/근거→업데이트/복구 수용 시험을 수행한다. 현재 `.app`와 기존 stage는 그대로이므로 수정 반영 버전이 아니다.

일반 배포는 **No-Go**다. 최초 F1–F7, 후속 F8–F12는 로컬 코드에 반영했고 커밋/배포하지 않았다. 단계별 발견을 수정한 것과 제품 전체가 검증된 것을 구분해야 한다.
