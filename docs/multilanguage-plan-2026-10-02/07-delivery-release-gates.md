# 단계별 개발 명세·의존관계·출시 게이트

## 1. 실행 책임과 순서

부모가 **Astra max 모델을 명시하여** 구현을 이어갈 때 사용할 장기 명세다. 이 기획 에이전트는 구현하지 않는다. **다음 한 번의 구현 범위는 [11 S1 근거 소스 안전 열람](11-first-implementation.md)의 좁은 수직 기능**이다. R0+R1 전체18셀을 즉시 완성하라는 지시가 아니다. S1 후 각 작업 묶음의 결과·비용을 부모가 검토한다. R2/R3는 각 이전 gate와 사용자 목표를 재확인한 뒤 진행한다. 동일 workspace의 기존 안전 수정·원본문서를 보존한다.

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

현재 모든 미래 gate는 **NOT RUN 또는 BLOCKED**다. 감사에서 해결한 회귀의 PASS는 참고 입력이며 새 gate PASS로 자동 복사하지 않는다. release manifest의 정확한 app build digest와 capability manifest hash에 결과를 묶는다. 버그 수정 후 영향 gate를 다시 실행한다.

| Gate | PASS의 증거 | 금지되는 대체 증거 | 현재 |
|---|---|---|---|
| G-IMPORT | C05 및 실제 picker→preview→snapshot, secret/size/race0 | 작은 fixture copy 성공만 | NOT RUN |
| G-EVIDENCE | immutable source/edge span/coverage partition/GC/legacy migration100% | inventory count | NOT RUN |
| G-JOB | 실제 worker/DB cancel·delete·retry·power loss·fencing | UI 취소 버튼만 | NOT RUN |
| G-ACCURACY | 06 cell thresholds+negative0+blind real-repo review | parser 성공/테스트 총수 | NOT RUN |
| G-PERF | 05의 지원 크기별20회 p95/full RSS·quota·latency | backend 단일 process RSS | NOT RUN |
| G-SEC | 권한·IPC·egress·source execution·credential redaction 독립 검토 High0 및 signed helper C15 OS 거부 증거 | 암호화 라이브러리/별도 JVM 존재 | NOT RUN |
| G-COST | fake provider C13/C16, 모든 entrypoint/restore 보수원장·safety journal/latch | 이미 청구된 chat 합산 | NOT RUN |
| G-OAUTH | O1 App으로 signed desktop→선택 public/private repo→expiry/refresh/revoke/SSO | mock OAuth/token 존재 | BLOCKED O1 |
| G-RECOVERY | 실제 packaged app format2/3 정상·오류·C16 모든 crash 상태, DB+source hash·notes/task 일치·vault/journal 비역행 | 단독 PostgreSQL rollback | NOT RUN |
| G-NATIVE | O2 서명/notary/staple, clean macOS matrix, install→local+GitHub→flow→source | 개발 Mac의 기존 .app | BLOCKED O2 |
| G-UPDATE | signed manifest/artifact·거짓서명/다운그레이드거부·schema crash→복원 | electron-builder 옵션 존재 | BLOCKED O2 |
| G-UX | 01의 사용자 과제7/8, false certainty0, 접근성 | headless API mock2 | NOT RUN |

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
