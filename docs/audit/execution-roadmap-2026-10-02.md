# S1 이후 전체 제품 실행 명세

작성일 2026-10-02. 이 문서는 사용자 후속 지시로 전체 구현을 재개하기 위한 **추가 실행 명세**다. [v1.1 계획](../multilanguage-plan-2026-10-02/README.md)과 그 검토 기록은 수정하지 않는다. v1.1의 “S1만 착수”는 당시 작업 범위였으며 후속 사용자 지시가 범위를 확대했다. 보안·정확도·제품 범위·수용 문턱은 유지한다.

## 번호와 현재 위치

정식으로 정의된 구현 단계는 S1 및 S1.1–S1.4다. S2는 후보 언급이고 S3 이후 정의는 없다. 아래 T00–T15는 기존 16개 개발 작업이며 R0–R3는 제품 로드맵이다. 이 문서는 가상의 과거 단계나 완료율을 만들지 않는다.

현재 HEAD `ebe3ab1`, branch `codex/e2e-docs-scripts`. 이전 감사 및 S1의 미커밋 변경을 보존한다. 새 기준선은 `/tmp/ci-post-s1-baseline.json`(743개 파일)이다. S1의 12개 고유 계약 시험과 관련 회귀는 [S1 보고서](s1-implementation-2026-10-02.md)에 있으며, 일부 실패 후 표적 재실행을 합산한 결과임을 그대로 유지한다. S1은 소스 열람의 snapshot binding을 검증했지만 T01/T02/T06 전체를 완료하지 않았다.

현재 제품 구조는 Electron main/preload → 인증된 loopback Spring Boot/Java21 → PostgreSQL/Redis, React/Vite, TS/Nest/ts-morph 분석기다. 기존 엔진을 재사용한다. Java 분석은 backend 안에서 수행되고 TS는 HTTP sidecar이며, 계획의 XPC 격리는 아직 없다. 과거에 언급한 다른 스택을 가정하지 않는다.

**현재 제품 출시: No-Go.** 계획 98.5점은 v1.1 기획 점수다. 이 추가 명세는 동일 [루브릭](../multilanguage-plan-2026-10-02/00-rubric-v1.md)으로 별도 검토하며, 95점 이상·미해결 Critical/High 0·중대한 설계 미결정 0을 충족한 작업만 구현 명세가 준비됐다고 판정한다. 개발 검증과 운영 출시 판정은 별개다.

## 전체 순서·완료 조건·의존관계

정확한 제품 계약은 [03](../multilanguage-plan-2026-10-02/03-architecture-contracts.md), [05](../multilanguage-plan-2026-10-02/05-security-performance-operations.md), [06](../multilanguage-plan-2026-10-02/06-benchmarks-validation.md), [07](../multilanguage-plan-2026-10-02/07-delivery-release-gates.md), [18개 공개 셀](../multilanguage-plan-2026-10-02/10-r1-public-cells.md)을 그대로 적용한다. 각 작업은 코드·해당 수용 시험·독립 검토가 있어야 완료다. 다음 표의 미완료는 기능이 전혀 없다는 뜻이 아니라 이 계약 전체를 통과하지 않았다는 뜻이다.

| 작업 | 선행 조건 / 담당 역할 | 최종 완료 조건 | 현재 상태·다음 단위 |
|---|---|---|---|
| T00 검증 계약 | 선행 없음 / QA+분석 | 18셀 manifest, fixture/oracle/관측 계약, 실패 runner, 300 annotation pilot 시간·불일치 측정 및 독립 검토 | 미완료. 먼저 T00a 계약·runner 자체시험; T00b 독립 pilot은 준비물 없으면 BLOCKED |
| T01 안전 가져오기 | T00 / backend+desktop+보안 | 공통 제외, native picker capability, 내용 승인, 실제 byte 예산, immutable source ingest; C05 40공격·한계±1·race, 원본 변경0·비밀0·실패 전 pointer 유지 | 미완료. 미리보기/복사 정책 불일치·count-only 확인 수정 필요 |
| T02 IR·소스·근거 | T00/T01의 ingest 계약 / backend+분석 | M1–M3 additive migration, source/generation binding, namespace·edge evidence·outcome partition100%, pin/GC, C06 15시퀀스·노트/task 보존 | S1 읽기 계약만 완료. 재시도 source 혼동과 즉시 retention 삭제를 우선 방어 |
| T03 격리·취소 | T01/T02 / desktop+backend+보안 | ADR-01 signed XPC+inherited Java/Node+bounded stdio; C07/C15 OS read/write/egress 거부, late write0, 취소≤10초·실제 종료까지 lock | 미완료. 먼저 별도 합성 격리 prototype; O2 전 signed OS 검증 BLOCKED |
| T04 Java/TS/JS 정확도 | T02/T03, T00 corpus / 분석+독립 QA | C01–04의18셀 개별 precision/recall/Wilson/negative0, HTTP4strata, 양쪽 evidence100%; 공개 corpus와 blind holdout | 미완료. 기존 golden 결과는 입력 증거이며 공개 셀 통과가 아님 |
| T05 session·증분·자원 | T02/T03 / 분석+backend | whole-project chunk/session, config/dependency invalidation, full/증분100% 동일, 501문맥·20회 크기별p95/전체 RSS·quota·cancel | 미완료. 현재10MiB/20k TS 한계 유지, 조용한 batching 금지 |
| T06 UX·flow·impact | T02/T04 / UI+QA | F1–F7, legacy/unknown/partial/truncated 표시, min-edge tier, 순환/중복 없는 영향 후보, 접근성·실사용 과제 | S1 snapshot viewer만 완료. inventory=분석완료인 표현 제거 필요 |
| T07 GitHub device OAuth | T01/T02 / backend+desktop+보안 | fake device/error/expiry/refresh 계약 후 O1 실제 App·selected public/private·SSO/revoke·no bundled secret | 미완료. 현재 authorization-code callback과 목표 device flow 구분; O1 운영 검증 BLOCKED |
| T08 AI 비용·egress | T02 / backend+desktop+보안 | 모든 chat/embed/summary 경로 예약·dispatch permit·ADR-02 durable journal, C13/C16 동시성/불명 hold/복원/가격 만료/시간 역행, ACK 전 send0 | 미완료. fake provider만으로 개발 가능; 반환 usage 합계는 strict budget 아님 |
| T09 패키징·복구·업데이트 | T01–T08, M4 / desktop+release+보안 | purpose vault, credential-free format3, legacy2 scrub, restore crash matrix, 최신 safety 보존, SBOM/license/dylib0, signed manual update/antirollback | 미완료. format2만 존재. O2 없는 서명/notary/fresh-machine은 BLOCKED |
| T10 R1 독립 수용 | T00–T09+O1/O2 / 독립 QA+release | 필수12게이트 전부 PASS, 특정 app hash·clean macOS matrix, UX8명 중7명 과제 성공·false certainty0, 미해결 C/H0 | BLOCKED. 모든 개발 게이트 후 실제 사용자·운영 증거 필요 |
| T11 Python R2 | T05/T10 / 분석+QA | C08 FastAPI/Django/SQLAlchemy 한정 셀·tree owner, regex중복0·동적 UNKNOWN, 별도 manifest/표본 | 선행 미충족. parser 존재와 지원 승격 구분 |
| T12 Go R2 | T05/T10 / 분석+QA | C09 net/http/Gin·receiver 반례, tree ABI, go list/network/build 실행0, 별도 셀 gate | 선행 미충족 |
| T13 C#/Kotlin R3a | R2 계약 안정 / 분석+desktop+QA | C10 reference-pack/PSI 정확 버전·라이선스·bundle, source generator/MSBuild/Gradle 실행0, unknown 정직 표시 | 선행 미충족. 실제 upstream 확인 후 구현 |
| T14 PHP/Ruby R3b | T13 계약 gate / 분석+QA | C11 syntax/span·동적 DSL 반례, grammar pin; F는 별도 정확도 승격 | 선행 미충족 |
| T15 C/C++/Rust/Swift R3c | T14 / 분석+desktop+QA | C12 구조 셀만, macro/build.rs/proc-macro/SwiftPM 실행0, 사용자 SDK 설치0, bundle 검증 | 선행 미충족. 깊은 C/F/FFI는 기존 비목표 유지 |

T01/T02의 계약을 병렬 설계하더라도 DB migration·IR는 root 단일 owner가 직렬 관리한다. 개발 병렬화는 파일 ownership을 명시하고 이전 작업이 종료·변경 목록을 반납한 뒤 넘긴다. T07/T08의 pure protocol/fault-test 모듈은 외부 운영 자격증명 없이 준비할 수 있지만 선행 ingest/source 계약 전 제품 통합 완료로 선언하지 않는다.

## 지금 구현할 T00a

목적은 검증기가 결함·미실행·표본 부족을 통과로 바꾸지 못하도록 하는 것이다. 기존 `accuracy-gate`, `quality-gate`, gold와 baseline 문턱은 유지한다. 새 구현은 `validation/t00/**`로 격리하며 Node 표준 라이브러리만 사용한다. manifest는 데이터이고 명령·shell·provider URL 실행 기능을 포함하지 않는다. 원본 source를 실행하거나 수정하지 않는다.

### 입력과 안전 경계

- 입력: corpus manifest, supported-cell manifest, observation bundle, product build SHA-256, offline mode, 새 output 디렉터리. schema/contract major를 명시하며 알 수 없는 major/필드·중복 ID·모순 상태는 실패한다.
- fixture: 고정 ID/version/license/origin/hash, project/scenario/generator family, split, 언어/프레임워크 버전, source path+SHA-256, expected capability/exclusion, gold/negative, review provenance. 경로는 fixture 안의 상대 경로만 허용하고 traversal/absolute/symlink/special file를 거부한다. source 바이트와 `[start,end)` span, UTF-8 경계·namespace를 검증한다.
- evaluator는 corpus를 read-only로 취급한다. output은 source/input과 겹치거나 symlink로 나가는 경로를 거부하고 기존 결과를 덮어쓰지 않는다. 입력/관측 크기·개수는 명시적 상한으로 제한한다. 비밀/원본 텍스트를 stdout·report에 복제하지 않는다.
- T00a는 정적인 합성 개발 fixture를 대상으로 한다. Node의 no-follow open/descriptor stat과 정적 ancestor 검사는 수행하지만 악의적인 동시 ancestor 교체까지 막는 OS confinement으로 주장하지 않는다. 사용자 repository 가져오기의 descriptor-relative 경계는 T01/T03에서 별도 입증한다.
- gold는 adapter 출력에서 자동 생성하지 않는다. review ID/hash/provenance/불일치 해결 상태를 기록한다. 이 형식 검사는 실제 독립 사람의 신원을 인증한 것으로 주장하지 않는다. 모든 pilot authored-by-agent 자료는 synthetic/author-provisional로 표시한다.
- split은 project/scenario/generator family 단위로 분리한다. 같은 family의 변형이 holdout과 개발 양쪽에 있으면 실패한다. 501 반복을 501 독립 프로젝트/시나리오로 세지 않는다.

### 판정과 산출물

- R1의18셀 manifest를 고정하고 공개 지원은 초기 전부 false다. 구현 inventory·파서 성공·작은 synthetic metric으로 자동 true로 변경하지 않는다. 문서의 Java21/TS5.9/React19/Router7/Nest11 등의 주장과 fixture 실제 버전이 다르면 해당 셀 근거로 인정하지 않는다.
- 셀별 TP/FP/FN·duplicate·unmatched·false-resolved·source/span/coverage 계약을 검사한다. candidate set은 ≤5, micro precision/recall와 exact-set accuracy를 따로 계산한다. 분모0은 null/N/A다. annotation review queue가 남으면 FAIL이다.
- **runner contract 결과와 제품 accuracy gate를 별도 필드로 출력한다.** 준비물·표본·독립 검토가 없으면 accuracy는 BLOCKED/NOT_RUN이다. 알려진 나쁜 관측·계약 위반은 FAIL/nonzero다. contract-only self-test 성공은 release PASS가 아니다.
- manifest의 문턱은 P valid-file≥99%/invalid diagnostic100%, S99%/95%, STATIC99%/90% 및 precision Wilson lower≥95%, INFERRED90%/90% 및 exact-set≥85%, false-resolved0으로 고정한다. 제품 build/관측이 없으면 BLOCKED, 주장한 digest가 malformed 또는 상충하면 FAIL이다. caller-provided build digest와 실제 product 실행 검증은 구분한다.
- 실행마다 `report.json`, `junit.xml`, `coverage-partition.json`, `resource-samples.csv`, `evidence-check.json`, `artifact-manifest.json`을 쓴다. 실제 수집하지 않은 resource 값은 빈값/NOT_RUN으로 남긴다. input/output SHA-256·tool versions·build digest·scope를 기록한다. self-referential manifest hash를 만들지 않는다.
- gate mode에서 FAIL=exit1, BLOCKED/NOT_RUN=exit2, 모든 해당 gate PASS일 때만0. 자체시험은 별도 `node --test` 결과로 기록한다. 보고서를 만든다는 이유로 runner exit0이 되지 않게 한다.
- 명시적인 CONTRACT_ONLY 모드만 계약 통과 exit0과 `productEvaluation=NOT_RUN`을 허용한다. output 경로가 위험하거나 이미 존재하면 산출물을 쓰지 않고 정제된 오류 코드로 끝낸다. 여섯 산출물 보장은 안전한 새 output 디렉터리를 확보한 실행에 적용한다.

### T00a 수용 시험

`node --test validation/t00/test/*.test.cjs`와 문서화한 CLI로 검증한다. 최소 known-good 계약, missing observation, 부족 표본/독립성, duplicate FP, false-resolved, source hash/span 변조, coverage 분할 불일치, cross-split leak, unsupported major, unsafe path, output clobber, malformed/oversize 입력, candidate k>5, fixture/version 불일치, evidence 없는 확정, 분모0을 시험한다. known-bad 관측은 runner 실제 exit nonzero를 확인한다. 새 결과에 기존 테스트 수를 합산하지 않는다.

T00b의 300 annotation은 최소 pilot 측정 계획이다. 작성/독립 reviewer 시간을 측정하지 않았다면 작업량 추정을 갱신하지 않는다. 최초18셀 전체 평가 5,400 annotation, 외부 허용 공개 저장소3개/cell, holdout 및 두 독립 검토자는 별도 준비물이다. T00a 완료 후에도 이를 생략하지 않고 T00 전체를 PARTIAL/BLOCKED로 남긴다. 부모에게 필요한 QA 모집/공개 corpus 선택을 명시하면서 독립 가능한 T01/T02 개발은 계속한다.

## 다음 제품 수정의 구체 경계

현재 확인된 결함과 우선순위:

| ID | 심각도·근거 | 사용자 영향 | 수정 단위 / 수용 증거 |
|---|---|---|---|
| E1 | High — `JobService.retry`는 DONE IMPORT를 건너뛰고 `JobWorker`는 project 공용 repo를 사용, inventory는 HEAD 사용 | A 실패→B 가져오기→A 재시도에서 B 분석이 A snapshot에 붙을 수 있음 | 먼저 superseded/unverifiable checkpoint를 fail-closed로 막는 좁은 수정. 원본 manifest workspace 재구성은 T02에서 완료; A/B/retry-A real DB/JGit regression |
| E2 | High — `LocalSourceStatusService.verifyRefresh`의 snapshot+added/modified/deleted 개수 비교 | 같은 개수의 변경을 승인된 소스로 오인 | T01 content-bound expiring one-use token+copy recheck; 동수·동길이 변경/worker 대기 중 변경409 또는 job실패·old pointer 유지 |
| E3 | High — `LocalImportService.fingerprint`와 `copyTree`의 정책/byte 한계 불일치 | preview 밖 바이너리·oversize·nested secret의 저장 위험 | 공통 SourcePolicy+bounded ingest·C05. no-follow/descriptor identity의 Mac 구현을 먼저 입증; check-then-open만으로 race 해결 주장 금지 |
| E4 | High — JavaSourceRoots/다른 readers는 working tree, FinalizeStep은 retention 초과 즉시 cascade | source provenance 및 과거 노트/task 근거 보존 불충분 | T02 manifest-only run workspace+source-key broker+pin/grace/GC. Git OID column 의미 유지, 별도 SHA-256 |
| E5 | High — coverage는 inventory를 analyzed로 보고 broad supported 표기 | 실제 처리 실패·미지원이 완전한 분석처럼 보임 | T02 persisted outcomes+T06 legacy UNMEASURED; T00 capability manifest가 현재 API를 증거로 사용하지 않음 |

E1 좁은 방어는 기존 checkpoint의 재시도를 거부할 수 있다. 응답은 새 미리보기/분석이 필요함을 설명하고, 최신 source로 몰래 재import하여 과거 job ID를 재사용하지 않는다. 소스가 일치하는 checkpoint의 동작은 회귀로 보존한다. 이 수정만으로 immutable encrypted storage가 구현됐다고 하지 않는다.

T01/T02 수직 기능은 승인 manifest→source blob→run workspace→S1 reader까지 연결한 뒤 완료로 본다. 기존 `files.content_hash`는 Git blob OID다. 새 SHA-256와 generation/manifest ID는 별도 필드이고 legacy 사실은 unverified다. purpose-specific K-source는 main safeStorage broker로만 다루고 현재 credential environment key를 재사용하지 않는다. 새 format source와 함께 plaintext `.git`를 계속 보관하면 영구 암호화 완료가 아니다. history/backup과 함께 이행하며 pins/GC가 준비되기 전 자동 destructive cleanup을 활성화하지 않는다. 필요한 schema는 V21 다음 새 migration만 추가하고 원본 V1–V21·노트/task ID/text/reference는 변경하지 않는다.

백업 format1은 설치 identity가 없는 기존 자료다. archive 자체는 보존하되 T09 새 normal restore는 identityless 자료를 거부한다. 별도의 격리 진단·변환 절차를 거치지 않고 최신 사용자 DB에 실행하지 않는다. 현재 legacy reader의 동작 변경은 그 이행 기능·시험과 함께 진행하며 이 문서만으로 이미 차단되었다고 하지 않는다.

Git pack의 작은 전송을 작은 비용으로 오인하지 않는다. 기존512MiB 전송 한계 외에 object별 decompressed bytes·총 object/byte·delta 깊이/시간·worker RSS·취소 한계를 adapter contract에 명시하고 합성 pack에서 검증하기 전 T07 production import는 준비되지 않은 것으로 처리한다. 현재 S1 reader의 bounded source read는 전체 pack ingest 성능 gate를 대체하지 않는다.

## 작업 분담과 검토

- root: 이 추가 명세·통합·현재 상태·DB migration 단일 ownership·회귀/게이트 기록. `.github/workflows` 변경은 root만 한다.
- `s1_frontend_review`: 새 `validation/t00/**`만 담당할 예정. 이름은 이전 세션에서 이어졌으며 UI 파일을 뜻하지 않는다. 시작 전 root가 ownership을 명시한다.
- `s1_backend_review`: E1 좁은 retry guard와 전용 테스트를 담당할 예정. `JobService/JobRepository` 변경 범위를 root와 확정하고 Gradle는 단일 실행한다.
- `s1_gate_review`: 문서/구현의 독립 반례 리뷰, 직접 구현 파일 수정 없음. 구현 작성자 자체시험과 별도 기록한다.

독립 검토자는 고정 루브릭 전체를 원 v1.1+이 addendum에 적용하고 합계·C/H·중대한 미결정·잔여 nonblocking 항목을 따로 보고한다. 점수를 요구치에 맞추지 않으며 미달이면 구체 결함을 고쳐 재검토한다. 후속 구현 결과는 별도 파일에 저장하고 이 문서의 계획 점수를 제품 완료 점수로 바꾸지 않는다.

## 검증과 실제 차단점

영역별 lint/typecheck/unit/integration/build를 변경 후 실행한다. backend Gradle/Testcontainers는 동시 실행하지 않는다. 브라우저는 GUI 사용 중이므로 headless 자체 context만 사용하고 실제 desktop UI 조작은 부모와 시점을 조율한다. 오디오를 건드리지 않는다. 설치된 `.app`/사용자 userData/원본 repository/키체인을 시험 대상으로 교체하지 않는다. DB·파일·provider 시험은 합성 source와 disposable 저장소다.

| 차단점 | 필요한 실제 입력/증거 | 그동안 가능한 작업 |
|---|---|---|
| O1 | 제품 GitHub App 소유·설정·device flow·권한있는 테스트 repository와 사용자 수행 | fake device polling/expiry/revoke/origin 계약, source import hardening |
| O2 | Developer ID/notary·운영 artifact/update 소유 및 별도 승인, clean Mac 시험 | 격리/업데이트 검증기 코드·합성 fail-closed 시험·native dependency inventory |
| QA oracle | 라이선스 고정 corpus와 독립 annotation/review, blind holdout 접근 통제 | T00 계약/self-test·annotation 도구·gold 형식 검증; generated gold의 자기 승인 금지 |
| UX/native | 지원 macOS 실제 깨끗한 기기·8명 과제 수행·GUI 사용 조율 | headless real-backend regression·접근성 자동 검사 |

이 입력은 임의 생성·추정하거나 다른 앱의 권한으로 우회하지 않는다. 공개 배포·commit/push/PR·유료 API·계정/인증서 발급·구매·보안 권한 변경은 하지 않는다. 운영 자료·사용자 프로젝트 source·secret은 보고서에 포함하지 않는다.

원래12개 release gate는 [07](../multilanguage-plan-2026-10-02/07-delivery-release-gates.md)의 수용 조건을 유지한다. 코드가 생겨도 시험이 없으면 NOT_RUN, 외부 준비물이 없으면 BLOCKED, 반례 재현은 FAIL이다. 모든 필수 gate PASS와 미해결 Critical/High0 이전에는 No-Go다. 다음 작업을 승인받기 위한 반복 중단 대신 구현 가능한 작업을 이어가고, 실제 차단점은 부모에게 근거와 필요한 입력만 전달한다.
