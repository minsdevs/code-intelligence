# 현재 독립 검토 — 2026-10-03 재시작 복구 후속 후보

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

# 추가 구현 독립 리뷰 기록

2026-10-02. 작성자 자체시험과 별도로 `s1_gate_review`가 현재 코드와 합성 반례를 검토했다. 이 문서는 기획 점수나 제품 전체의 안전성 인증이 아니다. 계획의 고정 루브릭 결과는 [별도 기록](execution-plan-review-2026-10-02.md), 제품 진행은 [현재 상태](execution-status-2026-10-02.md)를 따른다.

## E1 재시도 방어

기존 완료 IMPORT를 건너뛰는 checkpoint retry가 프로젝트의 다른 source를 같은 snapshot에 붙일 수 있었다. `JobService.java:67`의 project lock 안에서 소유권·FAILED 재조회, active writer 확인, `RetrySourceGuard.verify`, CAS queue 변경, step 초기화 순서를 적용했다. dispatch는 transaction commit 뒤에만 수행한다.

| 발견 | 영향·재현 | 수정·최종 판단 |
|---|---|---|
| High / P1 — `.git` 안의 Java source가 검증 밖에서 resolver에 포함됨 | tracked `App.java`를 그대로 두고 `.git/injected/src/main/java/demo/Helper.java`를 추가하면 JavaAnalyzer가 없던 CALLS를 CONFIRMED로 생성. inventory에는 추가 파일이 없었다. | `RetrySourceGuard.java:160`에서 metadata의 `.java`를 대소문자 구분 없이 거부. 실제 resolver 반례 unit과 DB mutation0 시험 포함. 해소. |
| High / P1 — PostgreSQL timestamp parameter에 `Instant` 직접 binding | 정상 source retry에서도 cached JDBC driver가 timestamp를 해석하지 못할 수 있음. | `JobRepository.java:150`에서 UTC OffsetDateTime binding. 실제 DB 정상 retry 포함. 해소. |

최종 독립 리뷰 Critical0/High0. working tree 모든 source 바이트와 Git object OID, metadata redirect·symlink·크기·수 제한을 검증한다. Git index cache/stat flags는 raw source 안전성 판단에 쓰지 않는다. 변경/추가/무시된 파일이나 이후 import 시도가 있으면 명시적 충돌로 거부한다.

Root 전체 backend 428개 실행에서 guard30개·retry DB19개·service2개를 포함해 PASS. 첫 집중 실행의 corrupt-blob fixture는 Mac의 JGit 읽기 전용 객체를 직접 덮어쓰다 실패했고, disposable 객체를 교체해 실제 손상을 주입하도록 수정했다. production guard를 완화하지 않았다.

이 판단은 앱 writer 직렬화와 검증 당시의 source에 한정한다. 악의적 동시 ancestor 교체, 검증 후 임의 filesystem 변경, pack decode hard timeout, immutable encrypted storage는 입증하지 않는다. T02 전체는 미완료다.

## E5 coverage·export

`CoverageService`의 파일 목록 수를 analyzed 성공 수로 표현하던 High/P1을 legacy UNMEASURED/UNKNOWN과 별도 inventoriedFiles로 수정했다. analyzer 상태는 snapshot에 기록된 job step에서 읽으며 현재 설정으로 과거 결과를 재구성하지 않는다. 성공·실패 수가 없으면 null이다. 숫자만 받는 외부 소비자의 갱신이 필요한 계약 수정이다.

독립 리뷰에서 Medium/P1 혼합 snapshot export를 찾았다. export가 A를 선택한 뒤 coverage가 새 current B를 다시 읽었다. `ExportService.java:139`는 captured snapshotId를 사용하도록 수정했으며, 실제 DB pointer를 A→B로 바꾸는 회귀에서 모든 export 내용은 A, 새 coverage 요청은 B임을 확인했다. 존재하지 않던 `areas` 조회도 실제 `project_areas`/`area_technologies` schema에 맞췄다. 최종 해당 범위 Critical0/High0, 지적 Medium 해소. [계약·검증](coverage-honesty.md).

## Docker 근거 경로

Medium/P1: compose의 `build` 경로가 외부/uninventoried 파일을 probe하거나 잘못된 context에도 root Dockerfile을 붙일 수 있었다. `DockerAnalyzer.resolveDockerfile`은 literal relative context와 dockerfile을 정규화한 최종 경로가 inventory에 있을 때만 근거로 사용한다. inline/동적/외부/잘못된 YAML type은 미해결로 둔다. 별도 root fallback은 없다. Dockerfile은 build context 기준으로 해석한다([Compose 공식 계약](https://docs.docker.com/reference/compose-file/build/)).

독립 리뷰가 `build: false/123/[]` 및 비문자열 context/dockerfile을 추가 지적해 7개 반례를 보강했다. 17개 테스트가 전체 backend 실행에 포함되어 통과했고 Medium 해소, scoped Critical0/High0. Docker image build나 임포트한 코드를 실행하지 않았다.

## 개발 runtime staging

Medium/P1: old runtime을 지운 뒤 incoming을 rename하던 실패 창을 lock·복구 marker·previous 보존으로 수정했다. 독립 리뷰의 fsync 경계 시험 부족을 반영했고, 다른 invocation의 marker를 cleanup하지 않도록 identity 검사도 추가했다. 최종 scoped Critical0/High0. desktop45개 중 stage22개 PASS. [정확한 범위·복구 한계](runtime-stage-preservation-2026-10-02.md).

## T00a 검증기

최초 독립 검토는 Critical0, High2, Medium3이었다. 모든 반례는 합성·임시 fixture이며 실제 제품 accuracy/자원 측정은 아니다.

| 발견·우선순위 | 독립 재현 | 수정 뒤 독립 재실행 |
|---|---|---|
| High / P1 — development가 평가 점수를 희석 | 정답 DEVELOPMENT 100개 + 오답 HOLDOUT 1개가 TP100/FP1/FN1, precision .990099, observation PASS | PRODUCT_EVALUATION은 development를 채점에서 제외. 같은 probe TP0/FP1/FN1, precision/recall0, FAIL/exit1. synthetic self-test는 명시적으로 별도 scope. |
| High / P1 — 모순된 abstention과 false-resolved가 통과 | mustNotEmitResolved=false인 UNRESOLVED gold에 올바른 abstention+잘못된 STATIC_RESOLVED와 정답100개를 섞으면 falseResolved0/PASS | oracle guard 요구 및 expected state에서 방어를 유도. unguarded oracle은 ORACLE_ABSTENTION_UNGUARDED, 서로 다른 location state는 CONTRADICTORY_LOCATION_STATE, exit1. |
| Medium / P1 — 없는 입력 파일의 parent가 보호되지 않음 | missing corpus의 input 디렉터리 안에 6개 output artifact 생성 | input parent를 leaf 검증 전에 보호. OUTPUT_OVERLAPS_INPUT/exit1, output 디렉터리 생성0. |
| Medium / P1 — outcome와 fact가 모순 | UNSUPPORTED/bytesRead0 outcome와 STATIC_RESOLVED fact를 함께 승인 | CONTRADICTORY_OUTCOME_STATE/exit1. |
| Medium / P1 — 전체 recall의 잘못된 별칭 | unsupported-positive oracle가 없는데 supported recall을 overallGoldRecall로 재사용 | overallGoldRecall=null, NOT_MEASURED 및 미측정 사유. 별도 oracle 없이 수치를 만들지 않음. |

수정 후 독립 reviewer가 보존한 작은 CLI probe 6개를 재실행했고 최종 **Critical0/High0/Medium0**으로 판정했다. valid control은 observation PASS이지만 exit2, 제품·release는 BLOCKED를 유지했다. reviewer는 구현 파일을 수정하지 않았다. root 자체시험·산출물 기록은 별도 validation 결과에 둔다.

T00a에는 독립 annotation0, 실제 제품 실행 검증0, resource sample0이다. 18개 publicSupported=false, 300 pilot NOT_RUN, G-ACCURACY BLOCKED. 작동하는 계약 검증기가 생긴 것이며 T00 전체 완료 또는 출시 가능 판정은 아니다.

## E3 로컬 가져오기

`LocalSourcePolicy.java:167`의 공통 선택을 fingerprint와 실제 복사에 사용한다.
허용한 동일 바이트만 private staging working tree와 Git blob에 쓰며, source의 Git
config·hook·filter·index를 실행하거나 읽지 않는다. 선택 결과와 inventory의 일치,
실제 읽은 byte 제한, 제외 개수 기록, ordinary publication 실패 때 이전 target 복원을
검증한다. [정확한 정책과 한계](local-ingest-policy.md).

| 발견·우선순위 | 독립 재현·사용자 영향 | 수정·판정 |
|---|---|---|
| High / P1 — metadata의 알려진 비밀 누락 | 본문이 일반 텍스트여도 token 모양의 파일명/디렉터리 또는 branch HEAD가 저장·표시될 수 있음 | `LocalSourcePolicy.pathReason/readBranch`에 같은 알려진 signature 검사. 경로는 제외하고 branch는 unknown. 해소. |
| High / P1 — credential 디렉터리 하위 선택 | `.aws/profile`을 root로 고르면 선택한 leaf만으로 ancestor의 의미를 놓침 | `LocalImportService.validateSource`가 canonical·제출 경로 전체 ancestry를 검사. 해소. |
| High / P1 — ignore regex 지연 | `*a` 20회 뒤 `b`인 규칙과 `a` 100개 파일명이 5초를 넘겨 끝나지 않음. 가져오기/미리보기 작업 점유 | JGit ignore regex 대신 loop 내부 budget 검사가 있는 iterative DP. 매칭 background thread 없음. 해소. |
| Medium / P1 — CR·escape 정책 불일치 | prevalidation과 JGit parser가 다른 줄/escape 해석을 하거나 raw pattern을 로그에 남길 수 있음 | CR/LF/CRLF와 escape를 한 parser로 처리. 지원하지 않는 구문은 고정 문구로 거부. 해소. |
| Medium / P1 — unsafe ignore 파일의 묵시적 생략 | symlink/hardlink/oversize 등 읽을 수 없는 정책을 버리면 사용자가 제외한 파일이 복사될 수 있음 | `.gitignore`의 안전한 해석을 못 하면 inspection 전체 실패. 캐시한 bytes/identity를 copy에도 사용. 해소. |
| High / P1 — Unicode `?` 의미 차이 | Java UTF-16 문자 매칭에서 Git이 제외하는 `한.txt`/`???.txt`, `😀.txt`/`????.txt` 등이 선택됨 | `LocalIgnoreRules.java:37`의 literal code point를 UTF-8 byte token으로 컴파일하고 `:119`에서 filename byte DP. 실제 preview/copy/tree/inventory/blob 부재와 원본 보존 회귀 추가. 해소. |

최종 독립 검토 **Critical0/High0/Medium0**. reviewer는 현재 matcher를 별도로 컴파일해
실제 `git check-ignore`와 **474개**(ASCII342 + Unicode/escaped Unicode/recursive132)를
비교했고 차이·거부0이었다. 원래 Unicode12개 반례도 모두 일치했다. 독립 결과
`fixed-report.json`의 sourceSha256은 `81e5c041f13ebdc0f2bc72a5b2330bc65c08b32e505a5834939157961dd6c04c`이고,
보고서 파일 자체 SHA-256은 `4a397f6e168debd8ca59cf7cacc52792939c70f9fa45a7b384e1eb37636eb1c2`다.
이474개는 unit test 수나 제품 corpus 크기에 더하지 않는다.

Root는 Unicode 수정 전 집중223개를 통과했고, 최종 source의 전체 Java/build572개·실제
source viewer/refresh12개·기존 quality gate를 별도로 재실행해 모두 통과했다. 최종 실행 수는
[현재 상태](execution-status-2026-10-02.md)에 기록한다. `INSPECTION_FAILED` 응답/UI는
용량·파일 검사 실패를 native picker 재승인 문제로 잘못 설명하지 않도록 수정했다.

이 scoped verdict는 T01 native descriptor confinement, E2 expiring one-use 승인과
worker bytes 결합, T02 immutable/encrypted source·pin/GC·crash-safe publication을
해결했다는 뜻이 아니다. 알려지지 않은 임의 비밀의 완전한 탐지나 기존 저장소의 비밀
제거도 보장하지 않는다. 이 항목과 운영 출시 gate는 여전히 미완료다.

## 최종 기록 일치 검토

독립 reviewer가 최종 통합 보고서·상태·검증 JSON을 보존한 실행 산출물과 대조했다.
전체/개별 suite 수,102개 artifact hash/size와141개 수정 source hash가 일치했다.
T00의 `runnerSha256`은 runner 진입 파일 하나가 아닌8개 implementation/schema의
순서 있는 합성 digest다. 현재 바이트로 재계산해 일치를 확인하고 단일 파일 hash와
구별해 기록했다. 코드나 gate를 다시 바꿀 사유는 없었다.

기록 일치 범위의 최종 Critical0/High0/Medium0. 큰 작업16개의0완료/5착수/11대기는
가중 완료율이 아니며, 이 검토 역시 제품 No-Go를 해제하지 않는다.
