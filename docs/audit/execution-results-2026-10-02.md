# 현재 구현·검증 결과 — 2026-10-03 재시작 복구 후속 후보

**출시 No-Go 유지.** 인증된 동일 거래 재개, retained 소스 재구성, 공간·보존과
프로세스 종료 소유권을 구현했다. 실제 PG·Redis·JAR owner SIGKILL 두 경계가 통과했다.
현재 상세 발견·수정·검증 한계는 [재시작 복구 감사](restart-recovery-audit-2026-10-03.md)를 따른다.
최종 backend 1337/1337, frontend 293/293, analyzer 108/108 및 실제 TS→Java→PG 7/7을 통과했다.
Desktop 전체는 2520 PASS/실패 0/별도 PG opt-in skip 8이며 76개 파일 drift 0이다.
Native 독립 28/28을 포함한 최종 명령·범위·실패 이력·SHA는
[기계 판독 검증 기록](restart-recovery-validation-2026-10-03.json)에 있다.

호환 runtime·운영 OAuth·일반 source consumer 이행·OS 격리·서명 설치와 대표
정확도 수용은 남아 있다. 아래 수치와 미연결 목록은 각 시점의 이력으로 보존한다.

## 이전 후보 기록

# 후속 구현·출시 준비도 통합 결과

2026-10-02. **일반 사용자 프로덕션 출시: No-Go.** 안전하게 분리할 수 있는 결함은
코드·회귀·문서까지 수정했고 현재 통합 검증을 통과했다. 제품 전체 구현과 운영 수용은
완료되지 않았다. [기계 판독 검증](execution-validation-2026-10-02.json),
[독립 반례 리뷰](execution-review-2026-10-02.md), [전체 작업 상태](execution-status-2026-10-02.md).

## 현재 구현과 보존

실제 코드는 Electron main/preload → 인증된 loopback Spring Boot/Java21 →
PostgreSQL/Redis, React/Vite UI, TypeScript/Nest/ts-morph sidecar다. Java 분석은 backend
프로세스 안에서 수행한다. tree analyzer는 개발 검증 대상이지만 현재 desktop bundle의
공개 언어 지원을 뜻하지 않는다. 스택 전환이나 전면 재작성은 하지 않았다.

branch `codex/e2e-docs-scripts`, HEAD `ebe3ab1`의 미커밋 상태에서 작업했다. 파일 ownership을
나누어 작성자와 독립 reviewer를 분리했고 Java gate는 직렬 실행했다. 마지막 확인에서
S1 이후 기준743파일의 삭제0, 기존 다언어 기획20파일의 hash 변경0이다. 검토된 실행
명세 hash도 유지했다. 설치된 앱·userData·사용자 프로젝트 원본을 교체하거나 reset,
commit/push/PR·배포·자격증명 발급·유료 호출을 하지 않았다. 사용자 GUI 브라우저와
오디오는 사용하지 않았고, 화면 시험은 독립 headless context에서 실행했다.

## 반영한 변경

| 범위 | 결과와 사용자 영향 | 근거 |
|---|---|---|
| S1 소스 열람 | 프로젝트·snapshot·Git blob에 결합된 원본과 근거 위치. stale/legacy/잘못된 권한은 현재 working tree로 대체하지 않음. UI cache/Monaco model도 snapshot별 분리 | `analysis/core/SnapshotBlobReader.java:37`, `FileService.java`, [S1 기록](s1-implementation-2026-10-02.md), 최종 실제 backend/화면12개 |
| E1 checkpoint retry | A 실패→B import→A retry가 B의 소스를 A 결과에 쓰는 경로를 거부. project lock·owned FAILED 재조회·source 검증·CAS·commit 후 dispatch. 정상 동일 source retry 보존 | `job/JobService.java:67`, `RetrySourceGuard.java:102`, guard30·DB19·service2 회귀 |
| E3 local ingest | fingerprint/copy에 같은 제한·제외 정책. 허용 raw bytes만 working tree/Git/inventory에 일치. 알려진 credential path/content·unsafe ignore·binary·link 등을 처리하고 실제 읽은 byte 예산 적용. 일반 publication 실패 시 이전 target 복원 시도 | `project/LocalSourcePolicy.java:167`, `LocalImportService.java:222`, `LocalIgnoreRules.java:119`, [정책](local-ingest-policy.md), 독립 High4/Medium2 해소 |
| E3 진단·상태 | snapshot에 bounded count-only 제외 기록. malformed/conflicting 기록은 unavailable. 검사 실패를 picker 재승인 문제로 잘못 설명하지 않음 | `CoverageService.java`, `LocalSourceStatusService.java:116`, coverage43·status5 및 frontend 회귀 |
| E5 coverage/export | inventory 수를 분석 성공으로 표시하지 않고 성공·실패·완전성을 미측정으로 유지. analyzer 상태는 과거 job 기록 사용. export는 한 snapshot에 결합 | [coverage 계약](coverage-honesty.md), export6·comparison2 포함 |
| Docker 근거 | inventory의 유효한 상대 build context/dockerfile만 연결. 외부/동적/잘못된 값에 임의 root Dockerfile을 붙이지 않음 | `analysis/config/DockerAnalyzer.java`, 17개 회귀 |
| 개발 runtime stage | old stage 선삭제 제거. exclusive lock·unique incoming/previous·복구 marker·fsync와 실패 경계 보강 | `desktop/scripts/runtime-stage.cjs`, [정확한 범위](runtime-stage-preservation-2026-10-02.md), stage22개 |
| T00a 검증 계약 | 고정18셀·엄격한 입력/span/hash/outcome 검사·평가/development 분리·known-bad nonzero·산출물 hash. 합성 self-test가 제품 통과로 바뀌지 않음 | [runner](../../validation/t00/README.md), 104개 자체시험, 독립 High2/Medium3 해소 |

backend 경로의 기준은 `backend/src/main/java/dev/codeintelligence/`다. 초기 F1–F12의
인증/IPC/callback·취소 writer·비밀 마스킹·TS 문맥·backup·반환 chat usage 수정은
[최초 감사](../release-audit-2026-10-02.md)에 구분되어 있으며 현재 전체 회귀에 포함된다.
정확한 반례와 심각도·우선순위는 독립 리뷰에 기록했다.

## 실행한 검증

| 명령·범위 | 결과 | 해석의 한계 |
|---|---|---|
| `./backend/gradlew --offline -p backend spotlessApply spotlessCheck build` | **PASS 572/572**, 85 suites; failure/error/skip0 | snapshot source 전용 gate는 별도 |
| `./backend/gradlew --offline -p backend snapshotSourceTest` | **PASS 12/12**, Java/TS ×6그룹, 한 번의 최종 실행 | 실제 Spring/DB/headless UI; packaged native·OAuth 아님 |
| frontend lint/typecheck/test/build | **PASS 120/120**, 24파일 | React/JSDOM 회귀; 이 수를 browser E2E로 세지 않음 |
| desktop `npm test` 및 stage syntax | **PASS 45/45**, stage22 포함 | 임시 filesystem·process fault/VM; 설치된 앱 실행 아님 |
| T00a `node --test validation/t00/test/*.test.cjs` 및11 CJS syntax | **PASS 104/104**; CLI exit0/2/2/1 확인 | 독립 annotation0·실제 product execution0, accuracy BLOCKED |
| `PREBUILDS_ONLY=1 ./quality-gate` | **PASS**, accuracy7·golden23·TS11·tree7; 두 analyzer typecheck/build PASS | 기존 작은55파일 corpus. backend25초/RSS127440KB는 전체 process-tree 성능이 아님 |
| E3 reviewer의 실제 Git 비교 | **474/474 일치**, scoped Critical0/High0/Medium0 | 지원하는 ignore subset의 별도 differential probe |
| 보존·문서 | `git diff --check` PASS, 기준파일 삭제0, 기획20파일 hash 동일 | 변경된 코드의 기능 검증과 별도 |

기존 quality baseline·oracle·문턱을 낮추거나 자동 갱신하지 않았다. 최종 test572개와
golden23개는 범위가 겹치므로 합산하지 않는다. 로컬 Node26.5.0/macOS arm64에서 실행했고
CI의 Node24/Linux 실행은 아직 안 했다. frontend의 기존 Vite IIFE-name/large-chunk
경고와 Gradle 연결 preamble 경고는 남았지만 명령 exit0과 JUnit 결과를 확인했다.

진행 중 실패도 보존했다. E1의 첫112개 집중 실행은 disposable Git 객체의 read-only
fixture 준비 오류1개가 있었고 fixture를 수정했다. E3 첫 실행은 test helper가 설치
JGit에 없는 API를 호출해 compile 실패; ObjectReader API로 수정한 뒤223개를 통과했다.
독립 리뷰에서 추가 Unicode ignore 반례를 고친 뒤 위572개 전체를 다시 실행했다.
과거 S1의 부분 재실행을 최종 단일 실행 결과로 포장하지 않았다.

## 남은 출시 blocker와 우선순위

| 심각도·우선순위 | 현재 근거·사용자 영향 | 필요한 다음 단위 |
|---|---|---|
| High / P1 — E2 승인된 내용 미결합 | `LocalSourceStatusService.java:40,61`은 snapshot과 변경 개수 비교. 같은 개수의 내용 변경·queue 대기 중 변경을 승인에 결합하지 못함 | T01의 만료·일회용 내용 승인과 T02 ingest manifest/worker 재검증을 한 수직 기능으로 구현 |
| High / P1 — T01/T03 실제 격리·취소 | `LocalSourcePolicy`는 pathname 전후 검사와 leaf NOFOLLOW; Mac JDK `SecureDirectoryStream=false`. `JobWorker.java:87`은 현재 step 안에서 hard cancel을 보장하지 않음 | descriptor-relative native 경계·signed XPC/App Sandbox·worker epoch/실제 종료; race/OS read-write-egress/cancel 수용 |
| High / P1 — E4/T02 provenance·history | `JavaSourceRoots.java:29`의 working tree 순회, `LocalImportService.java:276`의 두 rename, `FinalizeStep.java:50`의 retention 즉시 삭제(기본2). 실패/refresh/GC 뒤 과거 근거 유지 부족 | immutable encrypted source/generation·workspace binding·pin/grace/GC·DB/FS 복구. 기존 Git OID와 새 SHA256를 혼용하지 않음 |
| High / P1 — T02/T04/T06 정확도·정직한 지원 | persisted per-file/per-capability outcomes 없음. T00a는 all18 publicSupported=false, synthetic10 cases·독립 annotation0 | licensed corpus·300 annotation pilot·독립 reviewer2명·18셀 evaluation5400 및 blind holdout; flow/impact/coverage 실제 수용 |
| High / P1 — T05 대형 저장소 | `TsRequestBudget.java:8`의20,000파일/10MiB 단일 project 제한. 기존501 문맥 수정은 session/증분/full RSS 입증이 아님 | project session/chunk·config invalidation·full/증분 동등성·크기별20회 p95·전체 process-tree RSS/취소 |
| High / P1 — T07 운영 GitHub 로그인 | `auth/GithubNativeOAuthService.java:77,174`은 현재 authorization-code 경로. 목표 GitHub App device flow 및 selected private/SSO/revoke 운영 검증 미완료 | fake protocol 개발 후 제품 App 설정(O1)과 실제 권한있는 저장소로 인수; bundled secret로 우회하지 않음 |
| High / P1 — T08 엄격 비용·egress | `ai/AiUsageService.java:20`은 반환 usage 기록, `SummaryService.java:63,98,125`는 embedding. 동시 예약·timeout 불명 과금·durable dispatch journal 없음 | 모든 entrypoint 예약/정산·불명 hold·journal ACK·restore 비역행. fake provider로 개발, 실제 유료 호출 불필요 |
| High / P1 — T09/T10 배포·복구 | `desktop/src/backup.cjs:64`는 format1/2, stage dylib는 host 의존 확인이 남음. 실제 서명/notary/clean Mac·update·전원 중단 복구 미검증 | purpose vault/format3·legacy 이행·signed update/rollback·SBOM/license/relocation·O2/실기기 수용 |
| Medium / P2 — 외부 IDE·전체 UX | 최초 감사 B11의 desktop 외부 IDE bridge는 미해결. 실제8명 사용자 과제와 전체 packaged flow 미실행 | 계획의 내부 source viewer 우선 정책 적용과 실제 UX/native gate; 후속 IDE bridge는 검증된 scheme/path만 허용 |

위 구현 과제는 단순히 계정만 연결하면 끝나는 운영 blocker가 아니다. 별도 구현이
필요하다. 외부 입력이 필요한 것은 제품 GitHub App(O1), Developer ID/notary·artifact
소유와 clean Mac(O2), 라이선스 고정 공개 corpus·독립 annotation/reviewer, 사용자8명의
수용 시험이다. 자격증명·인증서를 생성하거나 권한을 바꾸지 않았다.

전체 T00–T15의 **16개 중 전체 수용 완료0, 관련 구현 착수5, 미착수/선행 대기11**이다.
이는 기존 기능이 없다는 뜻이 아니며 가중 완료율도 아니다. 기획98.0점과 제품 진행률을
혼동하지 않는다. 좁은 S1/T00a/E1/E3/E5 등의 통과를 필수12개 출시 gate의 전체 PASS로
승격하지 않는다. 운영·보안·정확도·복구·실사용 증거가 남아 있으므로 출시 No-Go를 유지한다.
