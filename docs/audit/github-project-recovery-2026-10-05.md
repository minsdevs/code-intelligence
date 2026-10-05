# GitHub 실패 프로젝트 복구 — 2026-10-05

정식 배포 준비는 **미완료**다. 구현, 모의 API 시험, 실제 DB/브라우저 시험, 실제 설치 앱과 실계정 결과를 구분한다.

**최신 작업 위치:** 원본 `/Users/minseokchae/Dev/code-intelligence`(CoS `/code-intelligence`). 복구 기능은 커밋 `4689176`, PR #85, 병합 `7fb5ea0`으로 반영됐다. 사용자는 기능별 commit/push/PR/merge와 불필요한 생성 파일 정리를 명시했으며 이전 한도 2% 조건은 폐기했다. 아래 독립 clone 경로와 미커밋 상태는 당시 기록이다. clone은 원본 반영·해시 검증 후 삭제했고 검증 기록은 원본 `validation/local/`에 보존했다.

## 작업 기준

사용자의 후속 지시: **Orca `main-2` 작업공간을 사용하지 않고 GitHub 커밋·PR, Markdown과 사용자 프롬프트를 기준으로 작업한다.** 이에 GitHub `minsdevs/code-intelligence`에서 독립 clone을 만들었다.

- 현재 작업본: `/Users/minseokchae/Dev/code-intelligence/.cos-pre-release-recovery-20261005`
- CoS 경로: `/code-intelligence/.cos-pre-release-recovery-20261005`
- 작업 브랜치: `codex/github-project-recovery-20261005`
- 기준: `a3522903f69444f45bea57405e3a80919cb55064`, PR #84 병합. GitHub에서 `MERGED`, `2026-10-04T20:21:51Z`를 확인했다.
- PR #84의 준비 브랜치 끝은 `279fb69`다. `26238ef`, `9b2deb3`, `eb380a3` 및 최신 인계가 병합돼 있다.

바깥 원본 저장소의 추적 파일은 수정하지 않았다. 그 아래 새 독립 clone 디렉터리가 추가된 것은 원본 작업트리의 기존 파일을 변경한 것과 구분한다. 기존 Orca 작업공간, 실제 설치 앱/DB/profile/Keychain, 개인 키 파일과 기존 산출물은 변경하지 않았다. 기존 stage와 명시적으로 확인한 도구/라이브러리 일부는 검증용 사본의 입력으로 읽기만 사용했다.

## 구현

GitHub 프로젝트 화면에 **새 분석 시작**과 상태 확인을 추가했다. 기존 `POST /api/projects/{id}/reanalyze`를 사용하며 project ID와 소유권을 유지한다. 삭제·중복 가져오기·checkpoint 검증 우회는 하지 않는다. 서버의 프로젝트 잠금과 활성 작업 unique 제약을 계속 사용한다.

목록/홈은 최신 job의 FAILED/CANCELLED/QUEUED/RUNNING/CANCELLING/DONE을 반영한다. 완료 snapshot이 없다는 이유만으로 ANALYZING으로 표시하던 오류를 제거했다. 중복 import는 소유 프로젝트 목록에서 같은 GitHub 저장소를 확인한 경우에만 기존 프로젝트 이동 링크를 제공하며, 검색/페이지 갱신으로 안내가 사라지지 않는다.

checkpoint `RETRY_SOURCE_UNVERIFIED`는 기존 작업 재시도를 중단하고 새 분석 경로를 안내한다. 시작 전 서버 조회, UI 중복 클릭 차단, 응답 유실 후 조회 재조정, POST 이전 CSRF 준비 실패의 구분, 같은 job ID의 다른 창 재시도 재구독, 정상 SSE EOF 뒤 조회를 보완했다. 실제 POST 결과가 불명확하면 자동 재전송하지 않는다.

`FinalizeStep`의 legacy 보관 개수 제한은 READY snapshot에만 적용한다. 기존에는 반복 재분석이 실패 snapshot과 연결 job/step을 cascade 삭제할 수 있었다. 완료 결과의 개수 제한은 유지하면서 실패/취소 시도의 진단 행은 남긴다. 이 보존 정책은 실패 데이터가 자동 정리된다는 뜻이 아니며, 별도의 명시적 정리 UX는 이번 범위에 없다. JUnit에 실패→세 차례 새 분석→완료 결과 2개/원래 실패 증거 유지 검증을 추가했다.

API/DB schema와 migration을 추가하거나 변경하지 않았다. V27 및 정확한 V26 백업 호환 계약을 그대로 유지한다. 이번 수정만으로 기존 백업 시험 전체를 새로 통과했다고 주장하지 않는다.

## 검증 기록

원시 기록은 작업본의 `validation/local/github-recovery-20261005/`에 보존한다. 해당 디렉터리의 바이너리, DB, 브라우저 프로필, 의존성은 커밋하지 않는다.

| 범위 | 실제 결과 | 근거/제한 |
|---|---|---|
| 첫 프런트엔드 전체 | 35파일, 352개 PASS | `frontend-regression.json`; 후속 수정 전 결과 |
| 독립 정적 검토 | 4건 발견 후 수정 | 미전송 CSRF 오류, 같은 ID 재시도, SSE EOF, 중복 안내 유지 |
| 검토 반영 첫 시험 | 37개 중 2개 FAIL | `review-regression.json`; 조건문을 잘못된 컴포넌트에 적용한 오류. 타입 검사도 실패했고 위치 수정 |
| 검토 반영 재개 | 타입 검사와 37개 PASS | `review-resume.json`; 위 실패 보고서를 덮어쓰지 않음 |
| 검토 수정 후 프런트엔드 전체 | 36파일, 357개 PASS | `frontend-final.json`; 중간 결과로 보존 |
| 최종 프런트엔드 전체 | 38파일, 370개 PASS | `frontend-closeout.json`; 진행 응답 경합·앱 내부 복구 이동 시험 추가. 타입 검사도 통과 |
| 내부 링크·응답 경합 검토 | 수정 전 2건 재현 FAIL, 수정 후 58개 PASS | 내부 문서 이동으로 인한 404와 늦은 retry/cancel GET의 상태 역행을 수정. `frontend-reviewed-final.json`에서도 전체 38파일/370개 PASS, 최종 frontend build·bootJar PASS |
| 백엔드 컴파일/패키징 | Java/test 전체 컴파일, bootJar, Spotless 검사 PASS | 개인 JDK21과 명시적 Gradle 배포본/의존성을 복사한 전용 cache 사용 |
| 백엔드 선택 시험 | 18개 PASS, 2개 환경 실패 | `backend-first-summary.json` 및 원본 XML; 두 Testcontainers 시험은 Docker 미실행으로 실패. 전체 PASS가 아님 |
| GitHub·메타데이터 집중 단위 시험 | 17개 PASS, 실패/오류 0 | `backend-focused-final.json`; GithubApiClientTest 12, GitMetadataPermissionTest 3, GitMetadataScannerTest 2. Spotless 검사도 통과. 위 Docker 실패를 덮어쓰지 않음 |
| 새 보존 JUnit 통합 시험 | 컴파일 확인, Docker 실행 미완료 | 별도 실제 DB 검증과 구분 |
| 실제 DB/브라우저 | 30개 확인 PASS, 배포 runtime 검증 1개 SKIP | `real-2026-10-05T08-14-38-665Z-yyvzKU/report.json`; GitHub만 합성 HTTP/local bare fixture, 애플리케이션 API는 실제 |
| 실제 사용자 GitHub project 1 | 이번 수정으로 완료 여부 미검증 | 기존 실제 계정의 토큰/프로필을 수집·복제하지 않음 |

초기 프런트 타입 검사 nullable 오류와 npm 설정 중복에 따른 첫 stage 실패도 로컬 실행 기록으로 남겼다. 실패 후 성공을 처음부터 한 번에 통과한 것으로 합치지 않는다.

### 실제 DB·브라우저 복구 결과

첫 실행 `real-2026-10-05T08-12-36-962Z-tELcs9`는 PG/Redis/Spring 준비와 UI 로그인까지 통과했지만 검증 스크립트의 exact `Branch` label 선택자가 맞지 않아 FAIL이었다. 실제 화면에는 main 브랜치가 선택 가능한 상태였다. 해당 보고서·화면·서비스 종료 결과를 보존했다. 선택자를 실제 combobox에 맞추고 새 실행을 수행했다. 두 실행의 JAR/프런트엔드 fingerprint도 각각 기록하며 동일 빌드의 단순 재개로 합치지 않는다.

후속 실행 `real-2026-10-05T08-14-38-665Z-yyvzKU`는 **PASS**다. 실제 Spring JAR, PostgreSQL/pgvector, Redis, Chromium과 프런트엔드를 사용했다. 앱 API 응답을 mock하지 않았으며 GitHub만 loopback HTTP 및 로컬 bare 저장소로 대체했다. 이 시험의 project 1은 `fixture/recovery`이며 사용자의 기존 `minsdevs/code-intelligence` project 1이 아니다.

1. UI 가져오기의 일반 GitHub 403은 `GIT_METADATA` 70%에서 job 1을 FAILED로 만들었다. current snapshot은 게시되지 않았다.
2. 소유 합성 소스를 변경하고 UI에서 이전 작업 재시도를 누르면 실제 `409 / RETRY_SOURCE_UNVERIFIED`가 반환됐다. 첫 실패 job/step/snapshot은 바뀌지 않았다.
3. 선택 PR 권한 부족 403으로 조건을 바꾸고 기존 프로젝트 화면의 **새 분석 시작**을 한 번 눌렀다. 같은 project 1에 job 2가 생성되어 `GIT_METADATA`와 `FINALIZE`를 포함한 분석이 DONE, snapshot 2가 READY가 됐다. PR 미수집 경고 evidence도 남았다.
4. 다시 새 분석해 job 3이 DONE이 된 뒤에도 첫 job 1/실패 step/snapshot 1은 보존됐다. 최종 snapshot 3은 READY다. 두 번의 새 분석은 각각 POST 1회였고 전체 DELETE 요청은 0회였다.

`first-failure.json`, `after-blocked-retry.json`, `after-recovery.json`, `after-second-analysis.json` 및 `980×700`/`1280×800` 화면을 보존했다. 복구 완료 화면을 직접 열어 확인했다. 검증 종료 후 소유 Chromium·Spring·PG·Redis·HTTP 서버의 종료 결과가 모두 PASS이며 앱/서비스를 실행 상태로 남기지 않았다. 인증 없는 fixture 요청은 401로 거부했고 인가된 테스트 요청과 분리해 기록했다.

배포 runtime 검증 SKIP은 `standalone-test-not-distributable` 서비스 입력을 사용했기 때문이다. 이 PASS를 native 앱/실계정/OAuth/minimum OS/설치 업데이트의 PASS로 승격하지 않는다. 새 보존 JUnit의 Testcontainers 실행도 별도로 남아 있다.

### 별도 보존 개수·실제 내부 라우팅 검증

`validation/github-recovery/verify.cjs`는 위 `real-pipeline.cjs`와 별도 실행 기록을 남긴다. 모든 실행은 새 전용 DB/Redis와 합성 GitHub 응답/로컬 bare 저장소를 사용한다. 사용자 프로필·자격증명을 읽지 않는다. 첫 `api-faT5EM/result.json`은 검증용 PostgreSQL 복사 경로가 평탄화되어 host의 없는 vector.control을 찾는 준비 단계 FAIL이었다. 복사본에 컴파일된 Cellar/opt 상대 구조를 유지한 뒤 `api-XtGfYA/result.json`은 API 단계 9개 확인 PASS였다. 첫 실패 기록은 보존했다.

최종 `browser-l94ivS/result.json`은 **12개 확인 PASS**다. 실제 JAR가 제공하는 프런트엔드와 API, PostgreSQL 16/pgvector, Redis, Chromium을 사용했다. 초기 실패·중복 import 거부·변경된 checkpoint의 409를 확인한 뒤 실제 내부 링크와 **새 분석 시작** 버튼으로 같은 `octocat/recovery-fixture` 프로젝트를 세 차례 새로 분석했다. 각 job은 GIT_METADATA와 FINALIZE를 통과하여 DONE으로 끝났다. 첫 실패 job/step과 메모는 유지됐고, 완료 legacy snapshot은 설정대로 2개만 남았다. 마지막 snapshot은 4/READY였다. 이전 실패의 미완성 snapshot 1/ANALYZING은 진단 기록이며 활성 worker가 남았다는 뜻이 아니다. 화면은 최신 FAILED/DONE job을 기준으로 상태를 표시한다.

`initial-failed-job.json`, `fresh-analysis-1.json`~`fresh-analysis-3.json`, 실패/완료 화면을 별도로 보존한다. 1280×900 완료 화면을 직접 확인했다. `cleanupComplete=true`와 각 소유 backend/Redis/PostgreSQL 종료를 확인했으며 새 Chromium도 닫았다. 이 시험은 실제 사용자의 project 1이나 packaged Electron 앱의 성공 증거가 아니다. 재실행 방법은 `validation/github-recovery/README.md`, 보고서 요약·해시는 `github-project-recovery-validation-2026-10-05.json`에 있다.

## 새 앱 빌드에서 확인한 별도 차단 사항

바깥 저장소의 기존 `desktop/stage/runtime`는 build sequence가 없고 최신 링크/인벤토리 계약에도 맞지 않아 현재 runtime manifest 검증에서 거부됐다. 원본은 수정하지 않았고 전체를 검증된 앱 런타임으로 재사용하지 않았다.

새 stage는 현재 Homebrew PostgreSQL 16.15와 연관 라이브러리의 Mach-O `minos 26.0` 때문에 저장소의 최소 macOS 13.0 정책에 거부됐다(`stage-resume.log`, `MINIMUM_OS_EXCEEDED`). 현재 Mac 확인용 별도 소스 사본의 metadata를 26.0으로 표시한 시도도 고정 정책의 `DECLARED_MINIMUM_CHANGED`로 거부됐다(`host-stage-first.log`). 저장소의 13.0 설정과 정책 검사는 변경하지 않았다. 차단된 stage를 앱으로 실행하거나 배포하지 않았다.

따라서 실제 PostgreSQL 시험은 **standalone 서비스 시험 입력**을 별도 사본으로 준비한다. `host-services/service-inputs.json`은 `scope=standalone-test-not-distributable`이며 배포 runtime manifest나 앱 빌드 성공 증거가 아니다. 현재 호스트에서 서비스가 실행돼도 macOS 13.0 지원, native .app 실행, Developer ID, 공증, 새 기기 설치·업데이트 통과를 뜻하지 않는다.

## 실계정과 남은 순서

기존 App `Code Intelligence Dev minsdevs`, App ID `5189413`, 공개 Client ID `Iv23licOyolwwPyDe1JY`, 설치 `167934276`은 변경하지 않았다. 전체 저장소 읽기 선택을 유지하며 private key를 수집하거나 번들에 넣지 않는다. 이전 인계의 실제 로그인 성공 및 GIT_METADATA 실패 기록은 그대로 남는다. 기본 Validation 프로필과 과거 격리 claim을 같은 것으로 추정하지 않는다.

다음 우선순위는 적합한 native runtime 입력 확보와 기존 실패 실계정 프로젝트의 UI 재분석 완료 확인이다. 이후 연결/해제/재연결/철회, 자동 refresh/rotation, 완료·취소 경합/강제 실패, 최소 OS·새 설치/업데이트를 분리해서 수행한다. 토큰 자동 갱신은 아직 구현하지 않았다.

당시에는 잔여 한도 2% 조건을 관측하지 못해 원격 발행을 보류했다. 이후 사용자가 이 조건을 폐기하고 기능별 반영을 지시했으므로 현재는 원본 브랜치에서 주요 기능 완성마다 commit/push/PR/merge를 수행한다. Actions, 유료 AI, 정식 서명·공증·배포 금지는 유지한다.

초기 검증 직후에는 독립 clone의 미커밋 상태였고 원본은 변경되지 않았다. 이후 원본 브랜치로 반영했으며 PR #85가 병합됐다. 불필요한 clone·캐시·합성 DB/프로필은 사용자의 정리 요청으로 삭제했고, 실패/성공 보고서·로그·화면은 원본의 Git 제외 경로 `validation/local/`에 유지했다. 보고서 속 과거 절대 경로는 출처 기록이며 현재 실행 경로가 아니다.

### 후속 런타임 준비

같은 날 후속 지시로 기존 macOS13 소스 빌더를 재사용하여 입력 버전·해시 고정과
디스크 사전 검사를 추가했다. 집중64개 시험이 통과했고 실제 사전 검사는 여유
약1.17GiB로 차단됐다. 새 native 앱 빌드는 아직 실행하지 않았다. pgvector0.8.7
변경 시 기존 DB·V26/V27 backup extension catalog의 호환 확인도 필요하다.
이전 복구 증거는 유지하며 최신 실행 경계는
[런타임 소스 준비 기록](macos-runtime-supply-2026-10-05.md)을 따른다.
