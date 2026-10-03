# 재시작 복구·소스·배포 준비 감사 — 2026-10-03

**후속 정적 차단:** `desktop/test/managed-process.test.cjs`의 실제 guardian 시험에서
숫자 PID 기반 조회·신호·정리와 자식 프로세스 실행 본문을 제거하고, 환경 변수로도
활성화할 수 없는 명시적 skip으로 교체했다. 이후 별도로 허용된 읽기 검토·구문 검사와
해당 파일의 모의 시험만 수행했다: **구문 검사 exit 0, 12 PASS / 실패 0 / native 1 SKIP**.
아래 기존 통합 시험 수와 검증 JSON의 SHA는 **패치 전 후보의 이력**이다. 현재 수정본의
검증은 문서 말미의 제한된 후속 검증에 한하며 실프로세스 시험 재개 허가를 뜻하지 않는다.

**순수 파서 후속 수정:** [별도 보고서](parser-gaps-2026-10-03.md)에 5개 공백의 수정,
수정 전 23개 실패 재현, 최종 선택 테스트 **152 PASS / 0 FAIL / 0 SKIP** 및 제한된 타입
검사 통과를 기록했다. 제품 `.mts/.cts` 수집과 구문 오류 HTTP/UI 전달은 남아 있다.
아래 108개 analyzer/34-of-39 holdout 및 통합 결과는 당시 후보의 이력이며 재실행 수치가 아니다.

**수집·진단 연결 후속:** [추가 보고서](parser-flow-2026-10-03.md)에 `.mts/.cts` 수집,
구문 오류의 400/failureCode/UI 안내와 같은 snapshot 재시도 차단 코드를 기록했다.
선택한 parser·서비스 직접 호출 **156 PASS**, 화면 모의 **10 PASS**, 제한 타입 검사 통과.
Java/DB/실제 HTTP·SSE·설치 앱은 실행하지 않았으며 소스 연결을 실제 동작 완료로 판정하지 않는다.

**추가 승인 후 Java 단위 검증:** [격리 Java 보고서](parser-java-unit-2026-10-03.md)에
JDK 21 main 363개·선택 test/helper 5개 컴파일 및 **35 PASS / 0 FAIL / 0 SKIP**를 기록했다.
제품 코드 수정은 필요 없었다. 실제 HTTP/SSE/DB/native/설치 앱과 전체 Gradle build는 미실행이다.

**후속 임시 서비스 승인 후 실제 연결 검증:** [HTTP→DB→SSE 보고서](parser-http-db-sse-2026-10-03.md)에
실제 Nest HTTP·PostgreSQL·Redis/SSE의 **14개 점검 PASS**와 모든 소유 서비스의 정리를 기록했다.
최상위 함수 호출 누락을 추가로 수정해 분석기 **165 PASS**다. 실제 auth/로컬 import/UI/설치 앱은
이 제한 시험 밖이다. [Windows 준비 보고서](windows-readiness-2026-10-03.md)에 경로·환경 처리,
gated NSIS 설정, **28개 플랫폼 모형 + 2개 기존 main 회귀 PASS** 및 미완료 native 기준을 분리했다.
Mac/Windows 출시 판정은 **No-Go 유지**다. 이전 결과·실패 증거를 소급해 바꾸지 않는다.

**출시 판정은 No-Go다.** 중단된 백업·복원 거래의 재시작, 보존 소스의 재구성,
공간·보존 정책과 협력하는 자식 프로세스의 종료 소유권을 구현했다. 실제 DB와
프로세스 검증을 진행했지만, 운영 OAuth, 호환 가능한 독립 실행 번들, 서명 설치,
일반 source consumer 이행과 제품 정확도 수용은 별도 출시 차단점이다.

이 보고서는 [이전 백업·복원 후보](backup-restore-integration-2026-10-03.md)의 후속이다.
이전 보고서와 실패 증거를 구분하며, guardian 시험 자료 재사용 사고는 아래에 공개한다.
최종 명령·종료 코드·JUnit 집계·소스와 증거 SHA는
[검증 기록](restart-recovery-validation-2026-10-03.json)에 있다.

## 실제 환경과 구조

저장소 접근은 정상이다. 작업 위치는 `/Users/minseokchae/Dev/code-intelligence`,
branch는 `codex/e2e-docs-scripts`, HEAD는
`ebe3ab135ce6dbaa454b29db6e5ab5c678557070`이다. 기존 dirty tree에 범위가 명확한
수정을 더했으며 reset·commit·push·PR·게시·배포를 하지 않았다.

Electron main/preload가 loopback Spring Boot/Java 21, PostgreSQL 16/pgvector,
Redis와 NestJS/TypeScript analyzer를 소유한다. UI는 React/Vite다. 제품 DB는
Flyway V1–V25, 복원 대상 밖 `userData/safety`에는 purpose keyring과 append-only
비용 원장 B가 있다. 보존 소스 vault/broker 모듈과 일반 main의 source 수집 연결은
서로 다른 상태이며, 모듈이 있다는 이유로 연결 완료로 계산하지 않았다.

최종 사용자 목표는 개발 도구 없이 설치·실행, 로컬 폴더 선택 또는 GitHub 연결,
화면→API→서비스→데이터와 변경 영향 탐색 및 해당 snapshot의 소스 근거 확인이다.
개발용 빌드나 개별 parser 성공만으로 이 전체 흐름을 수용하지 않는다.

## 구현과 재현된 발견

| 발견 / 심각도 / 우선순위 | 근거와 사용자 영향 | 수정·검증 범위 |
|---|---|---|
| 중단 거래 재개 부재 — High/P1 | `desktop/src/backup-runtime.cjs`, `main.cjs`: pending marker가 남으면 정상 시작을 막지만 제품 복구 절차가 없었음 | 기존 거래 UUID·입력 hash·DB OID·소스/검증 디렉터리 inode에 결합한 recovery-only 시작. 실제 health 동안 공개 API 503, 검증된 완료 후 별도 정상 재개 |
| 프로세스 종료·잠금 소유권 — High/P1 | `main.cjs:493`, 독립 H1 RED: 종료가 겹치면 child가 끝나기 전에 map에서 없어져 B 잠금이 먼저 닫힐 수 있었음 | 동일 child의 종료 Promise 공유, 종료 확인까지 소유권 유지. Java guardian과 FileChannel lease 연결. 독립 H1 2/2 PASS |
| 의도적 종료 뒤 자동 재시작 — Medium/P1 | `main.cjs:226`, 기존 runtime 회귀가 종료 소유권 수정 뒤 FAIL: 정상 종료를 예기치 않은 종료로 판단 | 진행 중 stop Promise로 의도를 구분. 원래 H1 2/2와 별도 의도적/동시/비정상 종료 4/4 독립 PASS. 기존 runtime assertion을 낮추지 않음 |
| 재시도 평문 잔류 — Medium/P1 | 독립 M1 RED: 실패한 이전 복구의 BACKUP 2개/RESTORE 3개 payload가 다음 성공 뒤 남음 | `backup-recovery-records.cjs`의 인증된 scratch ledger와 `backup-runtime.cjs` 전체 사전 검증 후 삭제. 현재 시도뿐 아니라 등록된 이전 시도를 정리. 변조·미등록 항목은 보존하며 완료 거부 |
| 오래된 완료 기록 수용 — Medium/P1 | 독립 M2 RED: 과거 B/PG 영수증이 최신 완료 이력 대신 수용됨 | 네 경계에서 최신 완료 영수증과 대조. 같은 활성 거래의 완료 직후 crash만 별도 허용. runtime 독립 M1/M2 4/4 PASS |
| 원래 DB 복구 후 local path 잔류 — Medium/P1 | 실제 STAGED SIGKILL에서 `backup-runtime-crash-owner.cjs:140` 실패. `IdeOpenService.java:49`는 저장된 local path를 picker 승인과 별도로 사용 | `backup-product-state.cjs:132,356`이 승인/credential 폐기와 같은 transaction에서 외부 local path도 비우고 0건 readback 후 COMMIT. 원래 DB OID·내부 clone·소스 bytes 보존. unit 117/117 및 실제 두 경계 2/2 PASS, 별도 읽기 리뷰 회귀 발견 0 |
| 보존 소스 백업 누락/시간 재구성 — High/P1, Medium/P1 | `backup-source-selection.cjs`, Java source worker: 분석 제외 파일·retained-only snapshot 및 없어진 작업 디렉터리를 포함해야 함. null commit-time roundtrip은 첫 Java gate 1 FAIL | 전체 immutable manifest의 raw bytes/Git OID를 검증하며 원래 commit/tree를 재구성. JGit lazy parse 전에 buffer를 지우던 결함 수정. Java 111/111 및 실제 JAR worker 79/79 PASS |
| GC 재개·원래 source mode — High/P1 | 독립 SPACE RED: 재시작 OFF로 B head가 이동해 GC 검증 실패; 정상 0755 source checkpoint를 잘못 거부 | GC barrier의 최신 B→PG 반영과 main-owned source directory 검증 구분. 동일 4개 probe가 수정 전 3 FAIL → 수정 후 4 PASS |
| 실제 비용 자료 반영 뒤 공간 초과 — Medium/P1 | 독립 SPACE RED: 최초 측정 뒤 finance seed가 11GiB 증가해도 publish 가능 | live DB/typed export/source/native bundle 실측·사전 admission, payload write 전 계량, 최종 stage DB/source 재측정. 완료 영수증과 inode/OID가 확인된 옛 checkpoint만 수거 |
| 네이티브 게시 gate 부재 — High/P1 | 현재 보존 번들: Java 26.0.2, PG/Redis 203개 minOS 26, Homebrew 외부 load 80개. package floor 13.0/Gradle Java21과 불일치 | Java21·arm64·macOS13·닫힌 dylib 의존성·basename 충돌·symlink 정책을 publish 전에 검증. 실제 호환 번들 제작/서명 성공을 뜻하지 않음 |
| staging 복사 대상 탈출 — High/P1 | 독립 전체 stage-script 합성 재현: 외부 `pkglibdir`의 `../..`가 incoming 밖 기존 runtime을 덮어쓴 뒤 최종 gate가 실패 | `stage-runtime.mjs:205` 및 복사·mkdir·chmod 직전 containment/identity/link 검사. PG bin/lib/pkglib/share를 함께 포함하는 공통 root 사용. 기존 사용자 stage는 재현에 사용하지 않음 |
| 필수 native 실행 파일·라이브러리 타입 누락 — Medium/P1 3건 | 독립 전체 stage 합성 재현에서 ELF PG/Redis·pgvector를 게시하고 Java MH_DYLIB 또는 dylib 의존성의 MH_EXECUTE도 허용 | `native-runtime-policy.cjs:117,168,279`에 실행 역할 9개, 필수 모듈 5개, 모든 native library suffix와 PG control/설치 SQL 경로 검사. 저자 최종 179/179 PASS. 합성 바이너리는 실행하지 않음 |
| 네이티브 검사 자체의 호환성 오거부 — Medium/P1 | 실제 보존 Mac 관측에 초안 적용 시 `.dylib`/MH_BUNDLE 169개와 PG 모듈 2개 오거부. pg_trgm은 default 1.6 직행 SQL 없이 1.3→1.6 설치 | 일반 library/PG 모듈은 BUNDLE 또는 DYLIB, JRE와 LC_LOAD_DYLIB 대상은 DYLIB. 유계 base→upgrade SQL 경로 허용. 실제 236개 관측·JRE release·PG metadata 대조에서 역할 관련 오거부 0. ABI/실행 성공을 뜻하지 않음 |
| 잘못된 CONFIRMED 분석 대상/경로 — Medium/P1 | fresh synthetic holdout: 동일 class/method 이름, 다른 tsconfig alias, 동적 Nest route, 무관한 `setGlobalPrefix`, import 없는 class/function fallback | 선언 identity·가장 가까운 config·실제 import binding만 사용. 미해결·다중 앱 경로는 UNKNOWN. 단위 108/108, 독립 semantic 17/18(기존 this.method 누락 1개 유지), 실제 TS→Java→PG corpus 7/7 PASS |
| HTTP 호출 이름·동적 method 오탐 — Medium/P1 | fresh holdout: 로컬 fetch/notaxios 및 동적 method가 확정 GET으로 나옴 | `ts-extractor.ts:470`: 실제 fetch/axios binding을 확인하고 동적 method는 UNKNOWN. 독립 HTTP 9/9와 실제 Java method/confidence 계약 10개 검증 PASS |
| 중복 간선·별칭 경로 탐색 비용 — Medium/P2 | 동일 synthetic dense 10k 입력 39.774초, 작은 별칭 DAG 4.472초 | 간선 Set과 분석 scope 내 origin memo로 첫 간선 내용·순서를 보존하며 중복 탐색 제거. dense 2.792초·DAG 약 225ms. 단일 합성 측정이며 제품 SLO는 미검증 |

`BACKUP_RUNTIME_RECOVERY_REQUIRED`는 unknown 자료를 삭제하거나 성공으로 추정하는
대신 정상 backend 시작을 막는다. 새 PREPARED v2의 정확한 입력·identity가 없는 옛
v1/불완전 거래, 찢어진 기록, 쓰기 후 등록 ACK 전에 죽어 소유권을 증명할 수 없는
payload는 자동 복구 완료 대상이 아니다. 보존 후 별도 조사해야 한다.

## 현재 검증 기록

아래는 최종 소스와 대조한 결과다. 범위가 겹치는 테스트 수는 더하지 않는다.

| 검증 | 실행 결과 | 범위/한계 |
|---|---|---|
| Backend 전체 | **1337/1337 PASS**, 109 suites, skip 0; spotlessCheck PASS | `CI_BACKUP_MAINTENANCE_PG=1`, 격리 Testcontainers/실제 DB 포함. Java 후속 변경 없음 |
| 최종 backend build·source 사용자 흐름 | **12/12 PASS**, skip 0; spotlessCheck/build PASS | 실제 PG/backend와 새 headless Chromium context. 707개 source pre/post drift 0, JAR hash도 실제 복구 시험 후보와 동일 |
| Java backup helper | 첫 107 중 1 FAIL → 수정 후보 **111/111 PASS**, bootJar PASS | lazy JGit commit-time 결함의 RED 보존. 위 전체에 포함 |
| Packaged source worker | **79/79 PASS**, skip 0 | 실제 새 JAR, retained raw bytes/null-time 재수출·소유 scratch SIGKILL. 실제 사용자 source 없음 |
| 실제 임시 PostgreSQL typed export/load/cost/retention | **138/138 PASS**, skip 0 | 자체 Docker container 생성·정리. 사용자의 DB에 연결하지 않음 |
| 실제 runtime backup/restore/rollback | 최종 **3/3 PASS**(상위 1+하위 2), skip 0 | 실제 PG/Redis/JAR. 후속 로컬 권한 수정 뒤 새 fixture에서 재실행 |
| 실제 Node owner SIGKILL | 최종 **2/2 PASS**, skip 0 | STAGED→VERIFIED_PREVIOUS, B_COMPLETED→VERIFIED_RESTORED. child/PG descendant/lease 종료, 비용 의무 173 유지, 키/소스 identity 보존, credentials/path 폐기, 정상 HTTP200·provider0·teardown 확인. 첫 1 PASS/1 FAIL 및 진단 STAGED 1 FAIL은 보존 |
| recovery runtime | **98/98 PASS**, skip 0 | 정상 기존 51개 보존. latest receipt·scratch·GC·capacity 합성 회귀. 13개 pre/post hash 동일 |
| scratch 기록 | 저자 **203/203 PASS**, 별도 타인 읽기 리뷰 C/H/M 발견 0 | 256개 상한·fsync/replay·receipt 불변. 리뷰를 새 실행으로 세지 않음 |
| Frontend | **293/293 PASS**, 30 files; lint/typecheck/build PASS | Vite IIFE name/큰 chunk 경고. 설치 Electron/OAuth 수용 아님 |
| Desktop 전체 / 최신 main | **2520 PASS / 실패 0 / skip 8**, 총 2528, exit 0 | 실제 JAR source worker·Java guardian 포함. 76개 source/test pre/post drift 0. 실제 PG opt-in은 아래처럼 별도 실행 |
| Analyzer | **108/108 PASS**, typecheck/build PASS; 동일 holdout **23/39 → 34/39** | 남은 5개 실패를 유지. 39검사는 모집단 정확도/제품 recall 분모 아님 |
| 실제 analyzer 통합 | **7/7 PASS**, 2 suites, skip 0 | 최종 TS sidecar→Java→PG miniature corpus. 16개 입력 drift 0. 대표 전체 제품 수용 아님 |
| bounded analyzer 성능 | **6/6** child 정상 종료·cutoff 0, size 거부 **3/3**; dense 10k **39.774 → 2.792초**, 표본 peak **523.75MiB** | 동일 1.97MB 입력·70k node/edge·50k unresolved, cold child 1회. 전체 제품/PG graph/p95/SLO 아님 |
| Native gate | 저자 **179/179 PASS**; 실제 native 236개 bytes 변화 0 | Apple 도구 응답은 합성. 별도 실제 관측·PG control/SQL은 정확한 최종 validator로 읽기 대조. 최종 독립 결과는 아래 기록 |

Desktop의 skip 8개는 실제 PG adapter, maintenance, DB swap, retention, typed load,
owner SIGKILL 두 경계, runtime 복원 시험이다. 이 중 backup PG 경로는 별도 138개,
owner crash는 2개, 실제 runtime은 하위 시나리오 2개를 실행했다. AI PG adapter의
단독 opt-in은 이 단계에서 다시 실행하지 않았다. Node runtime 보고의 3개는
상위 1개와 하위 2개이며 JUnit testcase 수는 2개다.

최초 desktop 전체는 2503개 중 실패 7개였다. 비동기 spawn 계약에 맞지 않는 기존
fixture 6건과 아래 guardian fixture 재사용을 수정했다. 다음 집중 실행이 드러낸
실제 의도적 종료 재시작 버그도 고쳤다. 두 번째 전체는 2517 PASS/skip 8이지만
동시에 native 파일 4개가 바뀌어 최종 근거에서 제외했다. 세 번째 위 결과만
소스 drift 0인 최종 전체 gate다.

최종 native 독립 재현은 **28/28 PASS**, 검토 범위 내 C/H/M 0/0/0이다.
거부 23건에서 이전 runtime을 보존했고 정상 5건은 게시 후 이전본을 남겼다.
7개 검토 파일의 pre/post SHA가 동일하다. `/tmp/ci-native-macos-independent-01xby3qm/`
의 `final-review.json`과 `run.log`를 따른다. 실제 native 236개의 메타데이터 대조는
작성자 실행이며 이 독립 검토자가 재실행한 것으로 세지 않는다. 정적 경로 검사는
적대적인 동일 사용자 ancestor 교체에 대한 OS 격리 증명이 아니다.

초기 RED, 진단 실패, 권한 제한에 의한 미실행과 최종 PASS를 각각 보존한다.
실행한 Node는 26.5.0이다. backend toolchain은 Java21이며 실제 packaged helper/
crash 시험은 보존된 JRE26을 이 Mac에서 실행했다. 배포 계약 Java21/macOS13이나
문서의 Node24·지원 OS 전체 행렬을 통과한 것은 아니다. 운영 키·실계정·유료
provider 호출·사용자 브라우저 세션은 사용하지 않았다.

## 핵심 사용자 흐름의 수용 범위

| 사용자 목표 | 현재 근거와 남은 범위 |
|---|---|
| 개발 도구 없이 설치·실행 | 독립 native gate가 현재 번들을 거부. 깨끗한 Mac 설치·서명·업데이트 미검증 |
| GitHub 로그인·권한 있는 저장소 가져오기 | callback·token 코드와 경계 검사 감사. 실제 운영 앱 등록·로그인·private repo·만료 갱신 미실행 |
| 로그인 없이 로컬 폴더 선택 | 승인·manifest·worker·재시도 회귀 포함. 설치 Electron의 전체 picker→분석 UX 수용은 미실행 |
| 원본 근거와 snapshot 전환 | 실제 backend/PG/headless 화면 12개 PASS. 일반 encrypted retained source 수집 연결은 별도 미완료 |
| 화면→API→서비스→데이터·변경 영향 | miniature 통합 7개와 synthetic holdout 34/39. 대표 corpus·직관적 마인드맵 사용자 과제·대규모 UI 지연 미검증 |
| 백업·복원·중단 후 재개 | 실제 PG/Redis/JAR 및 owner SIGKILL 두 경계 PASS. Electron singleton·모든 power-loss 경계·실제 Keychain 이전은 미검증 |

## 남은 출시 차단점과 필요한 결정

| 심각도 / 우선순위 | 근거 | 사용자 영향 / 다음 작업 |
|---|---|---|
| High/P1 — 독립 실행 번들 | 실제 보존 native 관측과 위 gate, `desktop/package.json` macOS13/Java21 계약 | 호환하는 완전한 재배치 가능 JRE·PG·Redis를 제공해야 함. OS floor를 조용히 높이거나 호스트 Homebrew를 제품 의존성으로 인정하지 않음 |
| High/P1 — 운영 OAuth | `GithubNativeOAuthService.java:78,176,263`: client secret 없는 code exchange, 만료/refresh 모델 부재; 실제 등록/권한 flow 미실행 | GitHub App/OAuth App 및 device flow/서버 exchange 선택·등록 후 callback, 권한, 만료·취소·private repo 수용 필요 |
| High/P1 — 일반 source 소비자 이행 | `ImportStep.java:102`, `SourceStoreProperties.java:10`, main에 일반 source broker 시작 연결 없음 | backup의 retained 재구성 성공과 일반 설치의 immutable encrypted ingest를 구분. 기존 Git/history/IDE 사용자 데이터 이행과 bootstrap 권한 계약 필요 |
| High/P1 — native 권한 격리 | guardian/FileLock은 협력하는 children의 crash ownership을 검증 | 파일·네트워크 접근을 OS가 거부하는 sandbox, helper 자체 SIGKILL 및 적대적 daemonization 증명은 아님 |
| High/P1 — 서명·설치·업데이트 | 보존 app의 deep strict 서명 검사 실패, native 모두 ad-hoc; 운영 credentials 없음 | Developer ID/notary/Gatekeeper, 지원 OS의 개발 도구 없는 새 Mac 설치, 실제 safeStorage 업그레이드·signed rollback·SBOM/license 수용 필요 |
| High/P1 — 제품 정확도 | 작은 holdout와 parser 수준 시험, 독립 리뷰/남은 누락 | React→Nest→data 전체 graph/근거·변경 영향의 대표 corpus, 독립 annotation과 사용자 과제 수용 필요 |
| Medium/P2 — 공간·복구의 범위 | write 전 계량과 단계별 DB 측정; 전체 Electron/옛 installer/updater 예산 없음 | OS disk reservation이 아니며 단일 PG load 중 일시 초과 가능. 등록 전 partial scratch·전체 power-loss/disk-loss matrix는 미검증 |
| Medium/P2 — 대규모 성능/지원 문법 | 옛 holdout의 5개 공백과 수집·진단 연결 코드를 수정. [격리 Java 컴파일/단위](parser-java-unit-2026-10-03.md)는 통과했으나 실제 HTTP/SSE/DB 연결 미검증 | 취소·동시성·연속 분석·제품 process-tree RSS/대형 대표 저장소와 UI 탐색 지연을 별도 수용해야 함 |

GitHub 공식 문서의 authorization-code exchange는 `client_secret`을 요구하며 PKCE는
추가 검증이다. 따라서 앱에 secret을 넣어 해결하지 않았다. 실제 앱 유형에 맞는 flow와
운영 구성을 결정해야 한다. [OAuth App 공식 문서](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[GitHub App 사용자 token 문서](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

## 보존과 증거

이 단계 시작의 `/tmp/ci-backup-resume-baseline-2026-10-03.json`은 962개 파일을
기록한다. 여섯 baseline의 파일 누락은 0, 동결한 기획 20개 및 실행 명세 1개의
변화는 0이다. 기존 dirty tree를 보존하고 필요한 파일만 더 수정했다. HEAD도
그대로다. [검증 기록](restart-recovery-validation-2026-10-03.json)은 소스·산출물
hash, 명령·exit·JUnit 집계와 baseline 대조를 담는다. 저자 검증, 독립 실행,
읽기 검토를 구분하며 좁은 수정의 C/H/M 0을 전체 제품 위험 0으로 해석하지 않는다.

실제 사용자 DB·프로젝트·Keychain·설치 앱을 검증에 사용하지 않았다. 테스트용
`/tmp` 디렉터리와 테스트 실행이 만든 child/container를 사용했다. 기존 stage와
packaged app은 읽기 감사만 했다. 현재 보고서·증거 목록의 `/tmp` 원본은 이 Mac의
세션 로컬 산출물이며 영구 보관이나 외부 업로드를 했다는 뜻은 아니다.

### 시험 증거 재사용 사고와 수정

첫 desktop 전체 실행의 guardian 시험이 과거 작성자 시험 디렉터리를 재사용했다.
고정 이름의 합성 state/log/evidence 일부를 덮어쓰거나 이어 썼고, 오래된 PID를 읽어
검증이 실패했다. 사용자 프로젝트나 설치 앱 데이터가 아니지만 **과거 guardian
evidence.json의 원래 hash는 더 이상 보존됐다고 주장하지 않는다.** 해당 파일을
과거 성공의 근거로 재인용하지 않는다.

`managed-process.test.cjs`를 매 실행 새 private 임시 디렉터리를 쓰고, PID가 현재
launch와 일치해야 채택하도록 수정했다. config/compiled classpath만 읽기 재사용한다.
실패 후 기록된 fixture PID는 모두 종료 상태였으며 추가 signal을 보내지 않았다.
수정 후 guardian 포함 집중 210/210과 최종 전체 회귀가 통과했다. 원본 테스트 bytes의
보조 자료는 첫 전체 직전 SHA와 일치하도록 패치를 역적용해 재구성한 것이며, 사전에
복사해 둔 원본이라고 표현하지 않는다. 사고와 보정 내역은
`/tmp/ci-backup-resume-guardian-reuse-disclosure-2026-10-03.json` 및 별도 독립 종료
리뷰에 기록했다. 그 외 이전 RED·진단·superseded 결과를 삭제하거나 성공으로 바꾸지 않았다.

### 숫자 PID 정리 경로의 정적 차단

후속 읽기 검토에서 fresh directory와 PID 일치만으로는 프로세스 수명을 식별할 수
없음을 확인했다. 이전 시험의 `alive(pid)` 조회, helper에 대한 직접 숫자 PID 신호,
`tracked` 전체의 SIGKILL 정리는 종료된 PID의 재사용과 확인/신호 사이 경합을 배제하지
못했다. 실제 다른 프로세스가 영향을 받았다고 재현한 결과는 없으며, 과거 실행의
무영향을 소급 보장하지 않는다. AX crash의 귀속 또한 이 정적 결함으로 판단하지 않는다.

이후 사용자가 AX crash는 별도 `fix second` 세션 건이라고 확인했으므로, 이 작업의
추가 귀속 조사는 종료했다. 이 확인은 숫자 PID 정리 결함의 차단을 취소하거나
프로세스 실행·조회·신호·Accessibility·테스트·빌드의 보류를 해제하는 근거가 아니다.

이번 패치는 해당 시험의 실행 본문을 제거했다. 재사용 설정 파일 읽기, PID 기록 채택,
Java/Node launch, main/helper 강제 종료, 임의 PID 정리 및 evidence 덮어쓰기가 이 시험에
남지 않는다. `CI_GUARDIAN_TEST_CONFIG`가 설정돼도 skip은 유지된다. skip이 잘못 제거되어도
남은 callback은 즉시 실패하며 프로세스를 만들지 않는다. 기존 모의 프로토콜 시험과
제품 코드는 변경하지 않았다. 이전 `/tmp` 증거와 검증 JSON도 수정하지 않았다.

후속 설계의 종료 권한은 현재 직접 생성하여 보유한 child handle과 그 실행에 결합된
control channel에서만 얻어야 한다. 기록 파일의 PID는 진단 자료일 뿐 종료 권한으로
채택하지 않는다. 종료를 확인하면 소유 목록에서 제거하고, helper 상실 시 숫자 PID
fallback을 사용하지 않는다. helper를 강제로 종료하는 시나리오는 그 이후에도 대상의
수명을 소유하고 정리할 별도 경계가 검토되기 전까지 복구하지 않는다. 이러한 경계를
구현·검증했다고 주장하는 패치는 아니다.

최초 차단 패치 시점에는 patch 적용과 변경 내용의 정적 대조만 수행했다. 구문 검사, 모의 unit,
Java guardian 통합, main/helper SIGKILL, 실제 DB/runtime 복구, 전체 Desktop 회귀와
빌드는 그 시점에 새로 실행하지 않았다. 뒤의 제한된 허용 외 다른 프로세스 시험은 보류다.

후속 명시적 지시로 아래 두 명령만 허용됐다. 먼저 시험 파일 전체와 유일한 저장소
의존 모듈 `desktop/src/managed-process.cjs` 전체를 읽었다. 나머지 require는 Node
builtin이다. 테스트의 모든 factory 호출은 EventEmitter/PassThrough 기반 launcher
또는 호출되면 실패하는 모의 함수를 주입한다. 모듈 로드 시 생성되는 기본 실제 launcher
함수는 이 테스트에서 호출하지 않는다. `owner.kill()`은 모의 stdin에 STOP 프레임을 쓰며,
helper kill mock은 호출 시 실패한다. native case는 환경 변수와 무관하게 skip이다.

```sh
node --check desktop/test/managed-process.test.cjs
env -u CI_GUARDIAN_TEST_CONFIG node --test desktop/test/managed-process.test.cjs
```

두 명령 모두 exit 0이다. 시험 결과는 총 13개, **12 PASS / 실패 0 / cancelled 0 /
native 1 SKIP**, 보고된 duration 84.327666ms다. 시험 이름에 SIGKILL이 포함된 PASS도
모의 close 이벤트 검증이며 OS 신호 실행이 아니다. 결과는 대화의 도구 출력에 남았고,
별도 JUnit/로그 파일이나 새 전체 후보 SHA 기록은 만들지 않았다.

허용한 실행 범위는 Node 자체·해당 test runner와 모의 프로토콜 회귀뿐이다. 실제
Java/PG/Redis, 프로세스 열거·임의 PID 신호, Accessibility, 실제 runtime/DB 복구,
전체 Desktop suite와 build는 실행하지 않았다. 이전 fixture도 사용하지 않았다.
이 결과는 실제 guardian의 종료 소유권·격리 검증을 대신하지 않는다. 실프로세스 종료
시험의 재개 명령은 정리 경계가 검토·확정되기 전에는 제시하거나 실행하지 않는다.
