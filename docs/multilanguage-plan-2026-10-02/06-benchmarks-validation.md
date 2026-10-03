# Fixture·정확도 지표·검증 실행 명세

## 1. 현재 증거와 앞으로 만들 증거

[2026-10-02 감사](../release-audit-2026-10-02.md)의 backend352/frontend64/desktop23/TS11/tree7/headless2 통과를 기준선으로 보존한다. 이번 기획 작업에서 재실행한 결과는 아니다. tree7은 native binding 조건부, headless2는 API mock이다. 501파일 Nest의 prefix/call과 PostgreSQL rollback은 실제 합성 검증이지만 모든 언어·native 제품의 정확도 표본으로 확대하지 않는다.

기존 [accuracy-gate](../../accuracy-gate)·[SemanticOracleTest](../../backend/src/test/java/dev/codeintelligence/analysis/accuracy/SemanticOracleTest.java)·[FixtureAccuracyTest](../../backend/src/test/java/dev/codeintelligence/analysis/accuracy/FixtureAccuracyTest.java)를 확장한다. 현재 gate는 TS local sidecar+DB를 쓰고 Docker는 **개발 시험 환경**에 필요하다. 설치 사용자에게 Docker를 요구한다는 뜻이 아니다.

## 2. Corpus와 annotation 계약

단위는 파일 수가 아니라 **gold symbol/span/callsite/relationship/abstention case**. framework 버전×capability×지원 패턴을 cell로 나눈다. 새로운 언어는 P/S부터 공개하면 C/F/X cell을 PASS로 채우지 않는다.

| Corpus ID | 내용/크기 목표 | 독립 oracle와 반례 | 최초 단계 |
|---|---|---|---|
| C01 java-spring | 기존 spring-mini 확장, 12개 기능 시나리오 | overload/import alias, inherited/composed mapping, profile·headers·media, ambiguous DI, reflection, JPA schema/복수 DB | R1 |
| C02 ts-nest-react | 기존 mini+501 합성+분리 module 12시나리오 | prefix가 먼 파일, tsconfig paths/reexport, dynamic module/URL/wrapper, JSX 동일 이름, JS receiver 미해결 | R1 |
| C03 mixed-http | React→Spring/Nest, 12시나리오 | 동일 method/path의 서비스2개, origin 미상, proxy prefix, URL case/query/media, 잘못된 method | R1 |
| C04 data-event | entity/schema·broker·topic 10시나리오 | `users` 다른 datasource, 같은 topic 다른 broker, 추정 ORM 이름, raw SQL 동적 문자열 | R1 |
| C05 import-secrets | 합성 파일트리 최소40 공격 cases | nested keys/PEM, 같은 개수 변경, symlink race/hardlink/FIFO, invalid UTF8/NFC, bytes±1, sparse/binary | R0 |
| C06 evidence-history | 15 변경 시퀀스 | old snapshot vs working tree, same-line calls, CRLF/Unicode/BOM, SFC offset, rename/delete/GC/pin | R0/R2 SFC |
| C07 increment-cancel | 20 변경/중단 시퀀스 | config/lockfile-only 변경, late worker 결과, process kill, corrupt cache, full-vs-increment 동등 | R0/T05 |
| C08 python | FastAPI/Django/SQLAlchemy 12시나리오 | APIRouter include prefix, URL include, alias/shadowed decorator, monkeypatch, import cycle | R2 |
| C09 go | net/http/Gin 12시나리오 | package/receiver/alias, ServeMux method/wildcard, group prefix, interface/cgo 미해결 | R2 |
| C10 csharp-kotlin | 언어당 10시나리오 | Roslyn ref miss, source generator/MSBuild hook, Kotlin extension/Java boundary/Gradle hook | R3a |
| C11 php-ruby | 언어당 10시나리오 | magic method/metaprogramming, route DSL 동적 값, heredoc/string와 코드 혼동 | R3b |
| C12 native | C/C++/Rust/Swift 언어당 10시나리오 | macro branch/header/compile command flags, build.rs/proc macro, Swift macro/SDK 없음 | R3c |
| C13 cost-egress | 최소30 fake provider cases | concurrent reserve, timeout-before/after-send, usage 없음, embedding, DB fail, retry, restore budget, clock 역행 | R0/R1 |
| C14 packaged-recovery | 05 지원 OS 각 fresh machine | Keychain/dialog/no-toolchain, import→graph→source→backup→update 실패→복구 | R1 |

각 공개 cell 최소 gold positives200, negative/ambiguous100, 독립 프로젝트3개, 서로 다른 시나리오10개. parser syntax/span은 언어별 파일50개 이상. 동일 generator의 501 반복은 부하 fixture 하나이며 정확도 분모를 501배로 부풀리지 않는다. 세부 rule이 표본을 충족 못하면 “실험/미검증”이며 확정 승격을 막는다.

Corpus의 60% 개발/20% 고정 validation/20% 블라인드 holdout 분리는 **프로젝트/시나리오 단위**로 한다. 위 최소 표본수는 공개 게이트의 validation+holdout 평가분 합계이며 holdout에도 각 cell positive50/negative25 이상 필요하다. 템플릿 변형이 서로 다른 split에 새지 않도록 generator family ID를 공유한다.

직접 작성한 합성 fixture와 재배포 가능한 공식 tutorial에서 최소 예제를 구성하고 저작권/라이선스 명시. 실제 사용성을 위해 유지관리 공개 repo 3개/cell의 허용된 고정 commit 부분집합을 QA가 선정·라이선스/hash 고정한다(다운로드는 다음 구현 단계 권한 범위에서; 이번 작업은 수행하지 않음). 외부 real-repo corpus가 준비되기 전에는 synthetics PASS여도 G-ACCURACY는 미완료다. 사용자 private repo는 별도 동의 없이는 corpus/외부 전송 금지.

## 3. 정답 형식과 독립성

미래 fixture tree: `fixtures/<id>/source`, `fixture.json`, `gold.json`, `negatives.json`, `review.json`. source는 read-only 복사로 분석한다. manifest는 fixture ID/version/license/source origin+commit/hash, 언어/프레임워크 버전, split/generator family, expected capabilities/exclusions를 갖는다. lockfile은 입력 데이터이며 설치 스크립트를 실행하지 않는다.

gold 항목에는 stable caseId, module/service namespace, relation kind, source/target semantic key+원본 byte span, expected resolution state, allowed alternatives, rationale(언어/프레임워크 규칙), reviewer IDs를 넣는다. negative에는 `mustNotEmitResolved`, expected unresolved reason을 기록한다. exact result graph에서 자동 생성한 gold를 그대로 승인하지 않는다.

예시(설계용, 아직 fixture 파일 아님):

```json
{
  "caseId": "same-path-two-services",
  "capability": "HTTP_CONSUMES",
  "input": {"method": "GET", "path": "/users", "originKnown": false},
  "expected": {"state": "INFERRED", "candidateServices": ["admin", "public"]},
  "mustNotEmitResolved": true,
  "reason": "Path equality does not identify a service."
}
```

QA annotation 담당과 adapter 구현 담당을 분리한다. 2명이 independently gold를 작성하고 불일치는 제3 검토자가 원본/공식 규칙으로 adjudicate한다. fixture 변경은 원인·이전 gold·새 gold·reviewer 서명+hash를 남기며 accuracy gate 실행 중 자동 업데이트 금지. 태스크 T00이 이 manifest/validator/report format부터 구현한다. 기획 작성자의 자체검토는 corpus 독립 annotation을 대신하지 않는다.

## 4. 지표 정의와 승격 문턱

최초 required cell 목록과 annotation 총량은 [10 R1 공개 셀](10-r1-public-cells.md)을 따른다. 문서의 planned version 전체 조합을 한 평균으로 묶지 않는다.

match key는 (module/service, relation kind, source declaration/callsite span, target semantic key)이며 candidate set 평가는 exact-set과 recall@k(k≤5)를 분리한다. 같은 정답을 여러 번 출력하면 첫 건만 TP, 나머지는 duplicate FP. gold 범위 밖 사실은 자동 오탐 처리하지 말고 annotation review queue로 보내되 검증 전 공개 metric에서 unmatched로 보고한다. annotation queue 미처리 상태는 gate FAIL이다.

precision=TP/(TP+FP), recall=TP/(TP+FN). 출력0은 precision N/A이고 recall0(positive 존재 시); abstain으로 높은 precision만 얻어 통과할 수 없다. supported patterns recall과 **전체 gold recall(unsupported 포함)** 둘 다 보고한다. overall macro 평균과 cell별 결과를 보이되 release는 각 cell 문턱을 만족해야 한다.

후보 집합 지표의 평가 단위는 **한 callsite에서 제안한 target set**이다. case i의 gold 허용 target set을 G_i, 최대5개의 predicted set을 P_i라 하면 TP_i=|G_i∩P_i|, FP_i=|P_i−G_i|, FN_i=|G_i−P_i|. candidate-set precision=ΣTP/(ΣTP+ΣFP), recall@5=ΣTP/(ΣTP+ΣFN)이며 case별 macro precision/recall도 병기한다. exact-set accuracy=일치(P_i=G_i) case수/전체case수. gold가 empty인 negative에서 빈 prediction은 exact-set 성공이지만 TP를 늘리지 않고, 거짓 후보는 FP다. N/A precision case를 만점으로 평균내지 않는다.

예: G={A}, P={A,B,C,D,E} → TP1/FP4/FN0, precision20%·recall@5 100%·exact-set0. G={A,B}, P={A} → TP1/FP0/FN1, precision100%·recall@5 50%·exact-set0. k>5 후보를 보낸 결과는 계약 위반 FAIL이며 상위5로 몰래 잘라 채점하지 않는다. 공개 INFERRED gate는 micro precision/recall 각각90% 외에 **exact-set accuracy≥85%**도 요구한다. 이 추가 지표는 기존 임계치 완화가 아니다.

| 측정 | 각 공개 cell의 최소 문턱 | 실패 처리 |
|---|---|---|
| P 구문 처리 | valid supported file 성공≥99%; invalid input에는 diagnostic100% | 해당 grammar 지원 제한/수정 |
| S 심볼 | precision≥99%, recall≥95% | S 정식 승격 보류 |
| STATIC_RESOLVED C/F/X | precision≥99%, recall≥90%(지원 패턴), precision Wilson95% lower≥95% | 정적확정 cell 비활성화 |
| INFERRED 후보 | candidate-set precision≥90%, gold target recall@5≥90% | 후보 rule 숨김/수정; 확정으로 승격 금지 |
| negative/ambiguous | 반드시 미확정이어야 하는 case의 false-resolved=0 | 단1건도 correctness blocker |
| 소스 근거 | 모든 공개 fact의 hash/span/namespace 검증100%, AI nonexistent evidence0 | hard FAIL |
| coverage | file/capability counts가 manifest partition과100% 일치 | hard FAIL |
| 증분 | canonical graph+evidence+outcome full와100% 일치(시간/순서 ID 정규화) | 증분 비활성, full fallback |
| crash/cancel | partial current publish0, late epoch write0, orphan lock0 | hard FAIL |
| 비밀/egress | 금지 sentinel 저장/전송/로그0, unauthorized request0 | hard FAIL |

Wilson 계산: p=TP/n, z=1.96, lower=(p+z²/(2n)-z*sqrt(p(1-p)/n+z²/(4n²)))/(1+z²/n). sample n와 FP/FN 절대수도 보고한다. 소표본에서 100%를 일반 정확도로 해석하지 않는다. q quality score와 empirical precision을 별 필드로 보고한다. 핵심 추정/동적 사례를 unsupported로 바꾸어 분모를 줄이려면 제품 지원표 변경 검토를 먼저 받는다.

정확도 confidence vs coverage는 분리한다. error-free parser가 호출을 놓칠 수 있고, 일부 동적 runtime 경로는 정적 oracle의 의도된 UNKNOWN이다. 데이터 lineage/실행 경로 완전성 metric을 이 정적 관계 metric으로 대체하지 않는다.

## 5. 실행 계층과 증거 산출

1. 기존 unit/API/DB/migration gate를 유지한다. 추가 계약 validator→adapter golden→real local worker+DB integration→metamorphic/increment→security fault injection 순서.
2. metamorphic: 식별자 rename/파일 순서 재배치/CRLF/동등 alias가 기대 graph를 보존하는지, method/origin/profile만 바꾸면 해당 edge가 사라지는지 확인한다.
3. real-backend UI E2E는 API mock 없이 disposable DB/source store 사용. native acceptance는 실제 packaged binary에서 OS picker/Keychain/child 실행/설치까지 별도 수행한다.
4. 성능은 fixture hash·hardware/OS·build digest·active background state·cold/warm을 기록. 각 크기 20 runs, p95=정렬 후 ceil(0.95*n) 순위, peak process-tree RSS는100ms sampling. timeout/OOM도 실패 sample로 분모 유지. 작은 corpus RSS를 전체 성능으로 보고하지 않는다.
5. fault injection은 예약 전후/send 전후, copy/fsync/rename, restore SQL commit, source swap, update migration, worker result publish 각 경계에 crash를 주입한다. 실제 installed 사용자 데이터 대신 격리 시험용 userData만 사용한다.

6. C15 `os-isolation-probe`: 실제 signed XPC/Java/Node 및 probe child에서 approved bytes는 읽되 전달되지 않은 사용자 dummy file/앱 vault/다른 project 원본 읽기·쓰기, TCP/UDP/DNS 직접 egress가 **OS 거부**되는지 확인한다. 외부 실제 자료를 사용하지 않고 격리 사용자 계정의 sentinel과 테스트 endpoint를 쓴다. network dispatcher 로그에 호출이 없다는 것만으로 PASS 금지. helper 초기화 실패/entitlement 제거/서명 변조에서 production adapter가 안 뜨고 일반 child fallback이0이어야 한다.
7. C16 `restore-safety-journal`: 05 §7 state machine 각 경계 crash, latest DISPATCHED→old DB restore, key rotation→old backup restore, journal torn-tail/corrupt/missing, old binary incompatible major, antirollback 역행을 시험한다. latch가 남은 상태의 AI dispatch0, request UUID 재전송0, source/backup old/new key 모두 필요한 만큼 보존, token sentinel이 export/staging restore에0인지 검증한다.

T00이 구현할 새 runner의 입력: corpus manifest path, supported-cell manifest, product build digest, offline flag, output directory. 출력: `report.json`(cell counts/metrics/threshold/result), `junit.xml`, `coverage-partition.json`, `resource-samples.csv`, `evidence-check.json`, `artifact-manifest.json`(input/output SHA-256, tool versions). 정확도/비밀/계약 위반은 nonzero exit; SKIP·준비물없음은 PASS가 아닌 BLOCKED. 이 runner/명령은 현재 저장소에 아직 없다.

기존 실행 기반(향후 구현 검증용, 이번 기획에서 실행하지 않음): `./accuracy-gate`, `./quality-gate`, `npm --prefix desktop test`, `node docs/audit/reproduce-ts-batch-boundary.cjs`, `node docs/audit/verify-backup-postgres.cjs`. 수정 범위에 맞춰 회귀를 실행하고 이전 통과 숫자를 새 gate의 결과로 복사하지 않는다.
