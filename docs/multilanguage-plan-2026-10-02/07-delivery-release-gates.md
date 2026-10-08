# 단계별 개발 명세·의존관계·출시 게이트

## 1. 실행 책임과 순서

현재 실행은 [11 단계 A–G](11-first-implementation.md)를 따른다. 아래 T00–T15는 장기 확장 계획이며 현재 완료 목록이 아니다. 이미 구현된 source store·암호화·복구 기반은 재사용한다. 맥 앱 완료(F), 서명·공증·정식 배포(G), 수익화 검토를 구분한다. 일반 구현은 Astra high 권장이고 기존 실패/성공 이력은 보존한다.

역할은 BE(backend), DESK(runtime), ANA(adapter), UI, QA(독립 oracle/검증), SEC(보안 검토), REL(패키지 운영)이며 인원이 확보됐다는 뜻은 아니다. 담당이 미지정인 외부 검증은 BLOCKED로 기록한다. 작업 추정은 1인 집중 개발일의 **범위**이며 QA/운영 대기·서명 발급은 포함하지 않아 달력상 출시일로 약속하지 않는다.

의존 DAG: T00→T01/T02→T03→T04/T06; T02+T03→T05; T01+T02→T07/T08; T01–T08→T09→T10. T11/T12는 T05+T10의 계약 기반 위에 진행, T13→T14→T15는 각 adapter 독립 gate. 병렬 개발해도 migration 번호·IR 변경은 한 owner가 직렬 관리한다.

| 작업 | 책임/추정 | 범위·선행 | 수용기준·중단 조건 |
|---|---|---|---|
| T00 검증 계약 | QA+ANA /3–5일 | 고정 rubric·capability manifest·fixture schema·report runner | gold 자동갱신 금지, known-bad fixture가 nonzero, 독립 reviewer 배정; corpus/license 미준비는 BLOCKED |
| T01 안전 snapshot import | BE+DESK+SEC /5–9일 | 공통 exclusion, preview digest, stream budget, picker capability, source store 기본 | C05 전체/bytes±1/race 통과, 원본 변경0·secret sentinel0, old pointer 유지; import 경계 침해 단1건 중단 |
| T02 IR/coverage/evidence migration | BE+ANA /6–10일 | 03 M1–M3, service namespace, edge evidence, immutable source+pin/GC | C06 old/new source·duplicate namespace·counts100%; V19–V21 sentinel/notes/task 유지, legacy UNKNOWN 표시 |
| T03 worker/cancel/fencing | BE+DESK+ANA+SEC /8–14일 | ADR-01 XPC/App Sandbox·상속 Java/Node worker·stdio·job epoch. 격리 prototype를 먼저 검증 | C07/C15 late write0·OS 파일/egress 거부, cancel max10초, active lock until worker exit; sandbox 불가 시 R1 중단, 일반 child fallback0 |
| T04 Java/TS/JS 정확도 | ANA+QA /8–14일 | T02/T03, Spring/Nest/React/cross-domain rule 보정 | C01–04 셀별 metric/negative0 통과; 같은 path/table 임의 merge0, edge 양쪽 evidence100% |
| T05 session/증분/자원 | ANA+BE /6–10일 | T02/T03, chunk transport single project, invalidation/cache | medium/large resource budget, full-vs-increment100%, 501 문맥 유지, config-only 변경 반영; 실패시 old 10MiB 제한 유지 |
| T06 UX·flow·impact | UI+BE+QA /5–8일 | T02/T04, snapshot selector, confidence/coverage/stop card | F1–F7·접근성·사용성 과제, edge tier min, duplicate impact0, truncated 보임; false certainty 단1건 수정 |
| T07 GitHub device OAuth | BE+DESK+SEC /3–6일 | T01/T02, fake OAuth contract→O1 후 실제 App | secret 없는 packaged flow, token-origin 갱신, revoke/expiry/SSO, 선택 private repo 읽기; O1 전 G-OAUTH BLOCKED |
| T08 비용·egress | BE+DESK+SEC+QA /8–13일 | T02, 모든 AI entrypoint gateway/ledger·ADR-02 safety journal/dispatch permit | C13/C16 concurrent reserve/timeout/embed/restore/price stale·crash latch 통과; journal ACK 전 전송0; 실제 유료호출 불필요 |
| T09 패키징·backup/update | DESK+REL+SEC /9–15일 | T01–T08, M4 호환, 목적별 vault·credential-free format3·signed manifest | format2 scrub/3쓰기·복구·key rotation·stage swap, safety 영역 비역행·SBOM/license·external dylib0; O2 없으면 signing 검증 BLOCKED |
| T10 R1 독립 release acceptance | QA+SEC+REL /5–8일 | T00–T09 결과·O1/O2·fresh hardware | G-* 모든 필수 PASS, 8명 UX/실기기/native artifact hash; 실패시 release No-Go |
| T11 Python R2 | ANA+QA /5–9일 | T05/T10, tree bundling/owner cutover | C08 P/S/C 제한/F/X 셀별 metric; regex duplicate0; dynamic unknown 유지 |
| T12 Go R2 | ANA+QA /4–7일 | T05/T10, tree ABI·capability | C09·net/http/Gin, no go list/network, receiver ambiguity unresolved |
| T13 C#/Kotlin R3a | ANA+DESK+QA /10–18일 | R2 계약 안정; exact parser/runtime/license pin | C10 무실행·Roslyn reference pack·PSI packaging; 셀 미달은 미지원 유지 |
| T14 PHP/Ruby R3b | ANA+QA /6–10일 | T13 계약 gate, tree grammar pin | C11 구문·span·동적 DSL 반례, public F는 별도 통과시만 |
| T15 C/C++/Rust/Swift R3c | ANA+DESK+QA /10–18일 | T14, Swift parser worker 번들 검증 | C12 구조만, hooks0·SDK/개발툴 요구0; deep C/F는 범위 밖 |

R0/R1 engineering 작업 합계는66–112 집중 인일이다. [공개18셀의 corpus/독립 annotation](10-r1-public-cells.md)은 별도95–110인일로, **총161–222인일**의 초기 가정이다. T00/T04의 숫자는 runner/adapter/회귀 개발이며 이 별도 수동 annotation 시간을 포함하지 않는다. T00 첫300 annotations pilot 후 실제 생산성으로 갱신한다. 운영 입력·실기기 모집 대기는 별도다. 한 에이전트가 한 turn에 전부 끝낼 것으로 가정하지 않는다. 병렬화할 수 있으나 독립 검토·표본·보안 gate를 생략하지 않는다. T13–T15 착수 전 exact upstream 버전/license/보안 상태와 toolchain 비용을 재검증한다.

위 인일은 **사람 작업량**이며 AI agent 작업시간·토큰·유료 API 비용의 추정이 아니다. R2/R3 전체 corpus 검증 비용은 아직 산정하지 않았으므로 전언어 최종 총일정으로 표현하지 않는다. S1은 이 장기 로드맵에서 source reader·호환·UI/검증의 작은 부분만 먼저 완성하는 것이며 독립적으로 검증/중단 가능하다.

## 2. 감사 잔여 항목 연결

| 감사 ID | 설계의 결정/조치 | 태스크/출시 gate |
|---|---|---|
| B1 OAuth | device App, device-origin refresh, 운영 소유 O1 | T07 / G-OAUTH |
| B2 Nest 문맥·대표 정확도 | whole project 유지·독립 negative/oracle | T04/T05 / G-ACCURACY |
| B3 backup portability/원자성 | same-install 명시, encrypted3·marker·rollback·power loss | T09 / G-RECOVERY |
| B4 cancel race | 기존 CANCELLING/V21 유지, worker 종료/fencing/latency 확대 | T03 / G-JOB |
| B5 대형 payload/memory | bounded session·RSS/cancel·single context | T05 / G-PERF |
| B6 local 비밀·크기 | 공통 제외/실측byte/no-follow/disk budget | T01 / G-IMPORT |
| B7 stale preview | content digest·copy recheck·10분 token | T01 / G-IMPORT |
| B8 coverage | persisted per-file/capability outcome·legacy unmeasured | T02/T06 / G-EVIDENCE |
| B9 개발도구 없는 새 Mac | dependency relocation·서명·notary·fresh machine | T09/T10 / G-NATIVE |
| B10 stage swap | old stage 보존·swap·crash marker | T09 / G-UPDATE |
| B11 IDE 외부열기 | 내부 viewer 기본; 최초 외부 IDE 열기 비활성 | T06 / G-SEC; 이후 허용 scheme/path main bridge 별도 범위 |
| B12 mock E2E/부족한 oracle | real backend·native package·대표 corpus | T00/T04/T10 / G-ACCURACY/G-NATIVE |
| B13 AI strict budget | 모든 API 예약/정산/불명보류·embedding·restore 보호 | T08 / G-COST |
| F11 submodule | gitlink 제외·누락 evidence 유지, 자동 fetch 없음 | T01 / G-IMPORT |
| 추가: source snapshot/edge evidence | immutable bytes+edge subject persistence | T02 / G-EVIDENCE |
| 추가: namespace/impact 중복 | service/schema/topic key·candidate sets·typed traversal | T02/T04/T06 / G-ACCURACY |

## 3. 출시 판정표

아래 표는 **최종 출시 gate**의 판정이다. 개별 구현·개발 Mac의 native/Keychain/백업 시험은 [11 최신 상태](11-first-implementation.md)에 기록되어 있지만, 이를 전체 gate PASS로 자동 복사하지 않는다. NOT RUN은 해당 gate의 필수 검증 전체를 완료하지 않았다는 뜻이다. release manifest의 정확한 app build digest와 capability manifest hash에 결과를 묶는다. 버그 수정 후 영향 gate를 다시 실행한다.

**검증 운영 — 사용자 승인 갱신(2026-10-09):** 최적화 반복 중에는 바뀐 영역의 대상 시험과 실제 변경 경로만 확인한다. 성능이 수렴한 뒤 변경을 묶어 통합 회귀 → 새 xpc-required 후보 → 영향받는 패키지 검증 → medium·large smoke-2를 한 차례 진행한다. 최종 시작·G-PERF 20회는 최종 출시 후보에서 조용한 AC·덮개 열린 기기로 한 번 수행한다. 안전성·복구 경계, 기존 SLO와 독립 수용 기준은 유지한다. 미실행은 NOT RUN, 부하 조건 초과는 INVALID_LOAD로 남기며 이전 후보의 PASS를 복사하지 않는다. 후속 수정이 생기면 영향받은 증거를 다시 확보하고 최종 후보와의 일치 여부를 확인한다.

| Gate | PASS의 증거 | 금지되는 대체 증거 | 현재 |
|---|---|---|---|
| G-IMPORT | C05 및 실제 picker→preview→snapshot, secret/size/race0 | 작은 fixture copy 성공만 | 부분 실행·미통과(2026-10-08 XPhUTE): 승인된 sealed snapshot 검증을 유지한 pack import·RETAIN 경로에서 제품36·import-evidence14 통과. 실제 OS picker 사람 클릭은 NOT RUN. p6 최초 러너 판정 실패는 보존. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 판정](../audit/candidate-p6ygme-2026-10-08.md). |
| G-EVIDENCE | immutable source/edge span/coverage partition/GC/legacy migration100% | inventory count | 부분 실행·미통과(2026-10-08 XPhUTE): 승인 bytes/OID/snapshot·namespace·span bounds를 확인한 import-evidence14 통과. 근거 DELETE 계획·상태 저장 batching의 실제 DB 경계와 Java canonical 비교 확인. 패키지 clean-full canonical·전체 C06/migration 매트릭스 재실행은 NOT RUN, 개수 일치로 대체하지 않음. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 판정](../audit/candidate-p6ygme-2026-10-08.md). |
| G-JOB | 실제 worker/DB cancel·delete·retry·power loss·fencing | UI 취소 버튼만 | 부분 실행·미통과(2026-10-08 XPhUTE): typed 전송 실패 수정 유지, 새 packaged 경합8 통과. 실제 worker/DB 소비 경로는 통합 회귀에 포함. 전원 차단 BLOCKED. 이전 h7hpw4 sleep 중 첫 실패는 보존. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 판정](../audit/candidate-p6ygme-2026-10-08.md). |
| G-ACCURACY | 06 cell thresholds+negative0+blind real-repo review | parser 성공/테스트 총수 | 측정 도구·개발 기준선만(2026-10-08): D1(인터페이스 호출 INFERRED)·D2(call-site span) 수정, 개발 기준선 실패 case 25→15·J-C 후보 일치 4/4. 독립 평가 주석 0건으로 cell 판정 BLOCKED, D3–D9 미해결. [9lVRha 기록](../audit/candidate-9lvrha-2026-10-08.md). 이전: 측정 도구·개발 기준선만(2026-10-07): 독립 평가 주석0건으로 cell 판정 BLOCKED. 개발 자료에서 Java call-site span·abstention 등 실패 기록. [accuracy-baseline](../audit/accuracy-baseline-2026-10-07.md) |
| G-PERF | 05의 지원 크기별20회 p95/full RSS·quota·latency | backend 단일 process RSS | 부분 실행·미통과(2026-10-09 XPhUTE): medium refresh 원시86.848/89.946초로 목표30초 초과. medium 두 번째·large 두 회차는 INVALID_LOAD이며 large 초기528.322/518.041초를 목표600초 PASS로 해석하지 않음. 회차별 부하와 실패를 보존. 후속 러너의 매 실행 직전 quiet admission은 대상30개와 실제 앱으로 확인했지만 진단용 수치는 SLO에 사용하지 않음. packaged clean-full canonical·20회 시리즈 NOT RUN. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 실패](../audit/candidate-p6ygme-2026-10-08.md). |
| G-SEC | 권한·IPC·egress·source execution·credential redaction 독립 검토 High0 및 signed helper C15 OS 거부 증거 | 암호화 라이브러리/별도 JVM 존재 | 내부 검토만(2026-10-08 XPhUTE): xpc-required 보안 탐침 COMPLETE(fuse·node modes·CSP PASS). 인증된 bounded token·보수적 무효화·RETAIN 무결성 경계 유지. 실제 Keychain NOT RUN, Developer ID·signed-helper C15·독립 reviewer BLOCKED. p6 별도 ad-hoc staged 탐침을 새 후보 또는 C15 PASS로 복사하지 않음. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 판정](../audit/candidate-p6ygme-2026-10-08.md). |
| G-COST | fake provider C13/C16, 모든 entrypoint/restore 보수원장·safety journal/latch | 이미 청구된 chat 합산 | 부분 실행·미통과(2026-10-08): 개인정보 기본 마스킹(D4) 수정, 검증 빌드 전용 fake provider로 9lVRha packaged ask(PK-08) 통과, 첫 실행 probe 통과. release 경로는 패키지 실행 미검증(수용된 변형 한계), 독립 검토 미완료. [9lVRha 기록](../audit/candidate-9lvrha-2026-10-08.md). 이전: 부분 실행·미통과(2026-10-07): C13 행69 통과, 연결 URI 비밀번호 노출(High) 수정 후 LA8ZS9 packaged 첫 실행 probe 통과. 개인정보 마스킹 부재(Medium)·shipped fake-provider 경로 없음·독립 검토 미완료. [cost-egress-matrix](../audit/cost-egress-matrix-2026-10-07.md) |
| G-OAUTH | O1 App으로 signed desktop→선택 public/private repo→expiry/refresh/revoke/SSO | mock OAuth/token 존재 | O1 개발 App 등록·설치 완료; 실계정 전체 수명주기/갱신/서명 앱은 미완료 |
| G-RECOVERY | 실제 packaged app format2/3 정상·오류·C16 모든 crash 상태, DB+source hash·notes/task 일치·vault/journal 비역행 | 단독 PostgreSQL rollback | 부분 실행·미통과(2026-10-08 XPhUTE): source vault 공통 경로 변경 후 packaged owner-crash AFTER_SOURCE_RENAME·BEFORE_COMPLETED_CLEANUP 각각6 통과, note/source 복구와 추가 재시작 확인. 전원 손실·전체 복구 매트릭스 재실행 NOT RUN, 실사용 프로필 적용 BLOCKED. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 실패와 판정](../audit/candidate-p6ygme-2026-10-08.md). |
| G-NATIVE | O2 서명/notary/staple, clean macOS matrix, install→local+GitHub→flow→source | 개발 Mac의 기존 .app | BLOCKED O2. 2026-10-07 서명 준비 점검(Mach-O100 inside-out·외부 참조0)과 단일 Mac loader 근사 통과, entitlements 과다(Medium). [native-update-readiness](../audit/native-update-readiness-2026-10-07.md) |
| G-UPDATE | signed manifest/artifact·거짓서명/다운그레이드거부·schema crash→복원 | electron-builder 옵션 존재 | BLOCKED O2(2026-10-08): updater·pre-migration checkpoint·rollback floor 구현(NU-01..03, fixture 키·loopback·실제 PostgreSQL 시험), 출시 키·호스트·Team ID 없어 비활성. C14 U1–U10 BLOCKED. [9lVRha 기록](../audit/candidate-9lvrha-2026-10-08.md). 이전: BLOCKED O2 및 미구현: 제품 updater·migration checkpoint·rollback floor 없음(High). fixture 키 계약 리허설만 통과 |
| G-UX | 01의 사용자 과제7/8, false certainty0, 접근성 | headless API mock2 | 자동 점검만: XPhUTE의 실제 synthetic native 진행 화면·완료 AX 관측. 이번 frontend 변경이 없어 UX190 pilot은 NOT RUN이며 이전 p6의 오류0·대비 위반0(18,278개 검사)을 새 후보 통과로 복사하지 않음. 사용자8명·VoiceOver BLOCKED. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 자동 점검](../audit/candidate-p6ygme-2026-10-08.md). |

release 승인은 필수 gate 전부 PASS+미해결 Critical/High0+공개 지원 셀과 결과 일치. AI를 첫 배포에서 숨겨 내보내기로 결정해도 G-COST 생략은 default OFF만으로 정당화하지 않고 모든 호출 진입점 disabled 증거가 필요하다. GitHub gate 실패를 숨기고 원래 제품으로 출시하지 않는다. local-only 별도 preview는 사용자에게 명시적으로 별도 범위 승인받을 때만 가능하다.

## 4. 위험·결정·중단

| 위험 | 발생 지표 | 대응/책임 |
|---|---|---|
| 복잡한 언어 semantics가 일정 초과 | C cell recall 미달·dependency unresolved 다수 | ANA: P/S 먼저 유지, 지원 깊이 정직하게 공개; 임계치 낮추지 않음 |
| snapshot/source 공간 증가 | quota10GiB/GC pin pressure | BE/UI: retention 설명/사용자 정리, notes pin 자동삭제 금지 |
| bundle/라이선스 부담 | external dylib·Redis license·Swift runtime 재배포 불명 | REL: 릴리스 차단, exact SBOM/라이선스 확인; 필요한 좁은 ADR만 |
| source hashing 시간 과다 | preview SLO 초과 | BE: 취소/stream 개선; weak counts로 보안 regression 금지 |
| 운영 App/서명 입력 지연 | O1/O2 미제공 | 부모: 안전 mock/로컬 범위 구현 계속, 운영 gate BLOCKED |
| 비용 계약 미지원 provider | tokenizer/청구차원/상한 미확인 | BE: 해당 provider OFF, soft limit로 슬쩍 변경 금지 |
| native OS hardening 불충분 | malicious parser/IPC/egress 시험 실패 | SEC: ADR-01 경계 실패로 해당 adapter 실행/출시 차단, XPC prototype 실패 시 ADR 재검토·일반 child 강등 금지 |
| 계획 작성의 가정과 실제 사용자 불일치 | 8명 시험 실패/핵심 repo 미지원 | 제품/QA: UX·지원 우선순위 수정 및 명세 버전 증가 |

기획 HOLD 사유는 중대한 설계 미결정·상충 계약·검증 불가능한 수용기준이다. 아직 구현/실기기 증거가 없다는 사실은 release No-Go이며 명확한 구현/검증 명세가 있으면 기획 착수 자체를 막는 미결정과 구별한다. 운영 입력 O1/O2는 필요한 권한을 대신 얻거나 추측하지 않는다.

## 5. 현재 구현에서 배포 직전까지의 실행 순서

2026-10-05 사용자 요청에 따라 원본 저장소의 기능 브랜치에서 각 단위의 구현·검증·문서 갱신 후 `[skip ci]` commit → push → PR → merge를 수행한다. GitHub Actions, 유료 AI 호출, 정식 서명·공증·배포는 실행하지 않는다. 이미 완료한 개발용 native 빌드·새 프로필 Keychain 검증을 불필요하게 반복하지 않고 변경의 영향을 받는 검증부터 실행한다. 아래 범위는 첫 배포 후보이며 T11–T15 장기 언어 확장까지 자동으로 포함하지 않는다.

| 순서 | 작업과 선행조건 | 배포 판정에 필요한 결과 |
|---|---|---|
| 1 데이터 복구 안정화 | 복원 전 catalog/소유자 확인, 구버전 archive 지원·거부/변환 정책, 복원 중 실패·강제종료·재시작 | 비호환 선택만으로 유지보수·복구필요 상태에 들어가지 않음; 실제 복원은 원본 DB/source·메모·비용원장 비역행, checkpoint 회복. schema V26→V27과 pgvector 버전변환을 구분 |
| 2 실제 GitHub 가져오기 | 1의 사용자 프로필 적용 조건 충족 후 기존 App·설치 재사용 | 실패 project1을 삭제·중복 생성 없이 UI 새 분석하여 GIT_METADATA→FINALIZE/DONE, 최초 실패 증거와 기존 데이터 유지 |
| 3 인증 수명주기 | 실제 연결/해제/재연결/철회, 만료·refresh 저장/갱신/회전, 동시 시도 | 늦은 응답이 폐기한 권한을 복원하지 않음, 앱 재시작·만료·권한변경에 일관된 표시/재인증; private key를 번들에 넣지 않음 |
| 4 분석·작업 신뢰 | 완료/취소 경합·삭제·재시도·worker crash·stale fencing, immutable snapshot, 대표 Java/TS/JS corpus와 독립 검토 | 과거 결과/소스 유지, 미지원·부분·미측정 구분, negative 오연결0 및 공개 지원 셀의 기준 충족; parser 성공 숫자를 정확도로 대체하지 않음 |
| 5 성능·보안·사용성 | 지원 크기별20회 p95/RSS/용량·취소, IPC/파일/egress 경계와 비밀 제외, fake-provider 비용경합, 접근성/사용자 과제 | G-PERF/SEC/COST/UX 기준 충족, 미해결 Critical/High0, 대표성·실행 환경/증거 공개. 유료 호출 없이도 비용 안전 계약 검증 |
| 6 새 설치·업데이트 | 개발 도구 없는 Mac·실제 최소 지원 OS·새 기기, 기존 버전에서 업데이트·다운그레이드거부·중단/rollback | 번들 밖 runtime 의존 없이 local/GitHub→flow→source 실행, 기존 DB/백업/메모 유지. signed artifact 설치/업데이트 부분은 O2 승인 후 별도 검증 |
| 7 배포물·운영 준비 | 정확한 dependency SBOM/라이선스/취약점, 지원 범위/한계·설치/복구 안내, 개인정보/외부전송 설명, 버전/릴리스노트, 개발용 GitHub App의 공개 배포 설치범위·운영 소유 점검 | 실제 배포 파일 해시·지원 선언·검증 결과·문서가 일치하고 배포 주체/도메인/문제 대응 경로 확정. 개발 App 등록·본인 설치 성공을 외부 사용자 설치 가능 증거로 대체하지 않음 |
| 8 출시 최종 판정 | 모든 필수 gate와 독립 검토, 정확한 후보 앱·manifest 고정 | 최종 No-Go/Go를 근거로 기록. Developer ID 서명·공증·staple/Gatekeeper 실검증은 별도 승인/자격 필요하며 실제 공개는 사용자 승인 후 |

1의 **비호환 사전 거부**와 **구 archive 자동 변환**은 다른 기능이다. 사전 거부가 통과해도 구 archive를 새 버전에서 복원할 수 있게 된 것은 아니다. 기존 profile/extension/locale와 교체 조건이 확인되지 않은 상태에서 실계정 DB를 실험 대상으로 쓰지 않는다. 같은 개발 Mac의 단일 PASS로 최소 OS·신규 기기·정식 업데이트를 완료 처리하지 않는다.

현재1단계 중 사전 거부와 후속 정상 복원은 `codex/restore-compatibility-preflight-20261005`의 제품 코드·PG10항목·새 packaged 앱으로 확인했다. 최종 `native-jGteM6`는 비호환 거부 후 UI 재분석·정상 복원·재시작을 통과한 mock-Keychain fixture다. 후속 `codex/restore-interruption-recovery-20261005`는 같은 앱을 변경하지 않고 새 claim에서 실제 source rename ACK 실패→이전92 유지(`native-fbwjDc`), B 완료 후 cleanup 실패→복원91 유지(`native-CRrBPQ`)를 각각 복구와 추가 정상 재시작까지 확인했다. 종료 code0와 실제 shutdown recovery 오류 전달을 구분하며, 상세 결과·한계는 `docs/audit/restore-interruption-2026-10-05.md`를 따른다.

후속 `codex/recovery-guidance-diagnostics-20261005`에서 **복구 상태별 UI 안내 분리**와 **MANIFEST 거부 조건의 고정 코드 분류**를 구현했다. 새 앱 `jXdOYk`의 `native-e5Y4sU`/`native-hnbzah`는 한영 복구 안내·버튼 차단과 두 실패 경로의 복구/추가 정상 재시작을 통과했고, `native-VCIheO`는 비호환 사전 거부/정상 복원/재시작을 통과했다. 최종 desktop236개 및 Settings44개가 통과했다. 과거 MANIFEST 실패의 근본 원인은 여전히 미확정이며 오류 코드 분류 구현을 과거 원인 해결로 기록하지 않는다. 상세 증거는 `docs/audit/recovery-guidance-diagnostics-2026-10-05.md`를 따른다.

후속 비용원장 단위는 `docs/audit/pre-release-cost-recovery-2026-10-05.md`를 따른다.
실제 native 서비스/현재 Node 구성에서100+73=173을 백업·복원 및 STAGED/B_COMPLETED
Node owner SIGKILL 후 같은 거래 재개까지 보존했다. 추가29로202가 된 상태의 동일
프로세스 오류 rollback도 통과했다. native2+3개·오프라인100PASS/1의도적skip이며,
OS Keychain/Electron UI·전원손실/guardian kill·전체 crash matrix가 아니다.
구 archive 자동 변환, 모든 강제종료/비용원장 replay, 기존 사용자 DB·locale 적용은
미완료이므로 G-RECOVERY 전체 상태를 PASS로 바꾸지 않는다. 2/3단계의 구현·합성
검증은 계속하되 실계정 project1에는 기존 데이터 적용·되돌리기 조건 확인 후 접근한다.

### 최신 전체 진행표 / 보고 기준

2026-10-06 후속에서 Docker Desktop 기동과 새 Testcontainers 환경을 확인하고,
기본 backend1639PASS(12명시적opt-in skip), 인증13·유지보수HTTP9, 실제sidecar
accuracy7·golden corpus23, TS222·tree8을 검증했다. 제품소스/오라클/기준치는
변경하지 않았으며 이전 Docker unavailable는 해소됐다. 상세와 새 source/evidence
원장은 [Docker 통합 후속](../audit/docker-integration-2026-10-06.md)을 따른다.
이 수행은 전체3·4·5단계의 검증을 진전시켰으나 정식 출시 No-Go는 유지한다.

이후4단계 [React export 연결 보정](../audit/react-route-binding-2026-10-06.md)은
default/alias의 실제선언 참조와 미해결·충돌 처리, 동일snapshot 재분석 연결철회를
추가했다. 현재 백엔드 기본실행1646PASS/12조건부skip, TS266/266, 실제sidecar+PG11/11,
선택검증도구122/122가 통과했다. Java/TS를 새로 빌드한 후보는 qUMAST다. 기존 독립
oracle와 품질기준은 유지하며, 이 정적 바인딩 범위를 동적 React 전체 지원으로
확대하지 않는다. 현재 작업은4단계 보정 및6단계 후보반영이다.

qUMAST의 실제 `--analysis-only` 실행은 대표 입력·React 연결·보관 소스·재시작13개
기록검사를 통과했다. 다만 일반 통합 실행의 종료 timeout과 대표 입력 구간의 두
실패는 별도 보존했고 원인은 미확정이다. 분석전용 PASS로 backup/restore·safeStorage·
삭제 시나리오를 통과 처리하지 않는다. 다음 실제 앱 작업은 이 일반 시퀀스의 실패
원인 분류이며, 결과와 정확한 source/artifact 해시는
[React 검증 원장](../audit/react-route-binding-validation-2026-10-06.json)을 따른다.

인계 전 checkpoint: 이후 qUMAST 일반시퀀스 `product-RkDN8L`35개 검사·6회 direct app
exit0는 통과했다. 앞선 두 실패의 원인은 아직 미확정이다. 추가 package.json
exports/main을 무시한 src/index 추측 연결을 차단하는 마지막 수정과 TS5개/실제DB1개
반례는 작성했지만, 재검증 요청이 도구 보안확인 단계에서 차단되어 실행하지 못했다.
현재 qUMAST·기존266/11/1646 결과는 이 마지막 수정을 포함하지 않는다. 따라서 이번
4단계 단위는 **마지막 보호 수정 재검증·새 후보 반영·병합 전**으로 유지한다.

그 다음 [최신 후속](../audit/pre-release-continuation-2026-10-06.md)에서 마지막 보호
수정의 TS271·실제sidecar/PG12개를 검증하고, 완료 알림 유실의 서버3개/화면11개
실패를 재현한 뒤 수정했다. 최종 SSE19·backend1665PASS/12명시skip·frontend436·
타입/lint·desktop/검증기212·corpus23이 통과했다. 새 후보 j5EJLB의 일반 native
36개 기록검사와6회 COMPLETE/정상종료가 통과했고 누락 suite는 없다. 종료 오류가
exit0에 가려지지 않도록 진단과 검증을 보강했다. 과거 두 native 실패의 원인까지
확정한 것은 아니다. 위 미검증 checkpoint는 이 후속으로 해소된 과거 상태다.

이후 [실제 Electron 강제종료 복구](../audit/electron-owner-crash-2026-10-06.md)는
같은 j5EJLB를 변경하지 않고 새 합성 프로필2개에서 실행했다. 소스 rename 직후와
복원 완료 후 cleanup 직전의 SIGKILL, 기록된 거래 복구, source92/91·메모 보존,
추가 정상 재시작이 각각6개 점검 PASS다. 최종 합성 회귀79개도 통과했다.
이 결과는1단계의 실제 main-process crash 두 경계를 보완하며, 전원손실·전체C16·
nonzero 비용원장과 retained-source를 결합한 native crash·실사용 DB 적용은 별도다.

그 다음 [JVM 상한·시작 성능 후속](../audit/startup-performance-2026-10-06.md)에서
기존 j5EJLB와 새 XIWb8X의 초기화 후 정상 시작을 각각20회 측정했다. 기존 p95
13.871초/관측idle최대2470048KiB, 새 p95 14.106초/2030576KiB로 두 후보 모두 목표를
넘었다. 새 후보의 최초 불완전 측정(1FAIL/19NOT_RUN)은 별도 보존하며 두20회 시리즈는
배터리 조건이다. 새 후보 기능36개·복구 두 경계 각6개·집중229PASS/1의도적skip을
확인했지만, 별도의 초기MANIFEST 실패는 원인 미확정이다. 성능과 시작 안정성의
출시 수용을 PASS로 바꾸지 않는다.

**8단계 출시 전 최종 판정을 기록했고, 현재는 5단계 성능 원인 분해를 보완하고 있다.
판정은 No-Go이며, 1–7단계의 필수 출시 수용조건이 모두 완료됐다는 뜻은 아니다.**
중단 사이 PR92의 비용원장 복구와 PR93의 인증 갱신·소비자 권한 검증이 병합되었고,
후속 보안 패치·전체 프런트/분석기 회귀·실제 앱 통합·운영 문서 정리를 수행했다.
이전의 ‘1단계에서 진행 중’이라는 보고 위치는 이 후속 수행으로 갱신한다.

최신 후보/원장과 미검증 사유는
[xb6Kxe 시작·유휴 메모리 수용 보고](../audit/startup-acceptance-xb6kxe-2026-10-06.md) 및
[검증 해시 원장](../audit/startup-acceptance-xb6kxe-2026-10-06.json)을 따른다. 이전 tZgvV7의 근거는
[메타데이터 보정·제어 런타임 보고](../audit/startup-resource-follow-up-2026-10-06.md)에 보존한다.
제품 A–E 구현, 개발용 앱의 기능 검증, 정식 출시 수용을 구분하며 미검증 항목을
통과로 세거나 단계 수를 개발 완료율로 환산하지 않는다. 이후 보고에도 전체 수행
위치, 이번 완료 단위, 남은 조건과 다음 작업을 함께 기록한다.

후속 [시작 구간 계측](../audit/startup-phase-breakdown-2026-10-06.md)은 PR99 병합과
같은 tZgvV7의 새 프로필 정상 시작 3회 진단을 완료했다. `69337a4`의 백엔드 세부
계측은 기존 회귀 194개를 통과했으나 여유 공간 6.11GiB가 기존 8GiB 기준에
미달해 새 후보 제작은 미실행이다. 아래 tZgvV7의 native 결과는 그 새 소스를
검증한 결과가 아니며, 두 성능 기준 실패는 그대로다.

이후 [원장 비용 후속](../audit/journal-replay-performance-2026-10-06.md)의 `85f889e`는
POSIX metadata 세 조회의 대기만 병렬화하고 모든 키/잠금 검증을 유지했다.
영향 회귀41·새 동시성4·진단15개가 통과했으며 실제 lease를 쓰는 257기록의
단일 관측은949→784ms다. 새 앱은 공간6.09GiB<8GiB로 미제작이다. 현재 소스의
합성/native lease 결과를 tZgvV7 전체 앱의 성능·복구 수용으로 대체하지 않는다.

이어 [xb6Kxe 수용](../audit/startup-acceptance-xb6kxe-2026-10-06.md)에서 검증된 빌드 사본만
회수해 공간을 확보하고, 측정으로 확인한 시작 작업·유휴 메모리를 줄였다. 정상
PostgreSQL 시작의 약4%를 거부하던 원점 검사(80회 중3회 재현)도 고쳤다. `ecf6344`의
xb6Kxe는 전체 기능36개(omitted없음·6회 COMPLETE/code0), 강제종료 두 경계 각6개,
Electron 내 런타임 검증20회와 20회 성능 게이트(p95 8,380ms, idle 최대1,525,200KiB,
전 회차 AC)를 통과했다. 같은 성능 변경의 mEbIBC는 복원 후 재시작에서 FAIL로 보존하고,
62hLL3 백업 단계 실패의 정확한 원인은 미확정으로 둔다. 독립 리뷰의 P3 수정을 반영한
[1lvULq 후속](../audit/review-follow-up-1lvulq-2026-10-06.md)(`9211e88`)도 기능36개·강제종료 두 경계·
런타임 검증20회·20회 게이트(p95 8,466ms, idle 최대1,519,408KiB)를 통과했다.

2026-10-07에는 출시 gate 단위10개를 각 작업트리에서 실행하고, 조정자가 단위별 핵심
명령을 다시 실행해 확인한 뒤 충돌 없이 병합했다. 병합 후 frontend 타입 검사와 backend
Spotless 결함2건을 고쳤고, frontend449·검증 러너368·backend1,852PASS(환경 경로 1건, 단독
67/67)·events19가 통과했다. desktop은 3,150PASS이며 실패2건은 부하 중 시간 초과(단독 통과)와
main에서도 같은 기존 실패다. 깨끗한 `19300fa`의 [LA8ZS9](../audit/release-gate-units-la8zs9-2026-10-07.md)는
기능36개·강제종료 두 경계·20회 시작 게이트(p95 8,734ms, idle 최대1,513,568KiB)를 통과했고,
펜싱 수정이 들어간 packaged 작업 경합8·비용 첫 실행 probe·UX pilot·고지 포함 SBOM을 확인했다.
각 gate의 행별 결과와 미해결 High는 위 §3 표와 단위 감사를 따르며 완료된 gate는 없다.

| 단계 | 현재 상태 | 완료 근거 또는 남은 조건 |
| --- | --- | --- |
| 1 데이터 복구 안정화 | 1lvULq C16 SIGKILL 경계26/26·journal fault·구 archive 거부 통과, LA8ZS9 두 경계 재통과 / 전체 수용 미완료 | nonzero 비용원장과 보관 소스를 결합한 실제 Electron 강제종료·같은 프로필 복구·추가 재시작 확인(첫 시도 실패1 보존). 전원 손실 NOT RUN, format2 정상 복원 정책·실사용 DB/locale·구버전 binary는 BLOCKED. 남은 Low: 중단 시 복호화 payload 잔존·구 archive 분류·추가 DB 잔존 |
| 2 실제 GitHub 가져오기 | 소비자 권한 검증 구현·회귀 완료 / 실계정 대기 | repo·clone/import·PR metadata에 revision-bound 권한과 결과 게시 검증. 기존 실패 project1의 실제 UI 재분석은 사용자 데이터 적용 조건 충족 후 |
| 3 인증 수명주기 | refresh/CAS 구현·기본 Docker 인증통합 보완 / 실권한 수용 미완료 | 기존 JDBC6과 별도로 실제 Spring HTTP/JPA/Redis 인증13, 유지보수HTTP9 및 기본backend suite 통과. 실제 GitHub refresh/revoke/SSO와 그 전체운영경로 수용은 별도 |
| 4 분석·작업 신뢰 | stale worker fencing(High) 수정·packaged 경합 통과 / 독립 수용 미완료 | worker/DB 경합60·LA8ZS9 packaged8, C05 70/71·C06 사실4,313·migration walk 통과. 실행 중 단계 10초 취소(T03), CONFIG/MIGRATION span·v0 pin·capability coverage, Java call-site span·abstention·interface dispatch 판정 미해결. 독립 주석·blind review는 사람 필요 |
| 5 성능·보안·사용성 | XPhUTE 기능·회귀 완료, refresh 병목 잔여 및 일부 측정 부하 무효 / 최종 수용 미완료 | 전체 회귀6,566 PASS·63 SKIP·실패0 및 tsc PASS. 제품36·경합8·import-evidence14·owner-crash6+6·보안 탐침 COMPLETE, 실제 native 화면·AX 관측. medium refresh 목표 초과 관측과 medium 두 번째·large 두 회차 INVALID_LOAD를 감사·ledger에 보존. 새 quiet admission 대상30개·실제 앱 확인. 최적화 반복은 대상 시험·변경 경로만 수행하고, 수렴 후 통합·새 후보·영향 패키지·smoke-2를 묶는다. 이전 실패는 보존. 시작/G-PERF20회·packaged canonical·UX190·비용 probe·PK-08·SBOM 재생성 NOT RUN; 사람 평가·서명·독립 수용 미완료. [현재 감사](../audit/candidate-xphute-2026-10-08.md), [이전 감사](../audit/candidate-p6ygme-2026-10-08.md). |
| 6 새 설치·업데이트 | LA8ZS9 패키징·기능36개·복구 두 경계 통과, 서명 준비 점검 통과 / 정식 설치·업데이트 미구현·미수용 | `19300fa` 무변경 작업트리에서 ad-hoc Validation 앱 제작. Mach-O100 서명 계획·외부 참조0·단일 Mac loader 근사 통과. 제품 updater·migration checkpoint·rollback floor(High) 미구현, Developer ID·공증·새 기기/최소OS는 사용자 자격·장비 필요 |
| 7 배포물·운영 준비 | 완전 SBOM(미귀속0)·고지 포함 패키징 / 라이선스 의무·운영 조건 잔여 | wFroXK(2026-10-08): CycloneDX 1.5 구성요소348·미귀속0, backend JAR 중첩150·제외 대상0, Dependabot 4건 lockfile 패치([h7hpw4 기록](../audit/candidate-h7hpw4-2026-10-08.md)). 이전: CycloneDX 1.5 구성요소350, LA8ZS9에 Electron/Chromium 라이선스·제3자 고지 포함(원문 없음96→15). Redis·JRE source offer·FFmpeg는 법률 판단, JRE 공급 기록·jmh-core 포함 정리 필요. 2026-10-07 온라인 advisory 재조회 0건(이전 결과 보존). 지원정책·설치/복구 안내·릴리스노트·운영 App 소유는 잔여 |
| **8 출시 최종 판정** | **이번 후보의 No-Go 판정 기록 완료 / 출시 미승인** | 앞선 필수 gate·독립 검토·정식 서명/공증 자격과 최종 공개 승인 전 배포 금지. 미검증을 통과로 바꾸지 않음 |
