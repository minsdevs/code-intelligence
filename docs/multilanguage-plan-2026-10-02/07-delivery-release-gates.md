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

| Gate | PASS의 증거 | 금지되는 대체 증거 | 현재 |
|---|---|---|---|
| G-IMPORT | C05 및 실제 picker→preview→snapshot, secret/size/race0 | 작은 fixture copy 성공만 | NOT RUN |
| G-EVIDENCE | immutable source/edge span/coverage partition/GC/legacy migration100% | inventory count | NOT RUN |
| G-JOB | 실제 worker/DB cancel·delete·retry·power loss·fencing | UI 취소 버튼만 | NOT RUN |
| G-ACCURACY | 06 cell thresholds+negative0+blind real-repo review | parser 성공/테스트 총수 | NOT RUN |
| G-PERF | 05의 지원 크기별20회 p95/full RSS·quota·latency | backend 단일 process RSS | NOT RUN |
| G-SEC | 권한·IPC·egress·source execution·credential redaction 독립 검토 High0 및 signed helper C15 OS 거부 증거 | 암호화 라이브러리/별도 JVM 존재 | NOT RUN |
| G-COST | fake provider C13/C16, 모든 entrypoint/restore 보수원장·safety journal/latch | 이미 청구된 chat 합산 | NOT RUN |
| G-OAUTH | O1 App으로 signed desktop→선택 public/private repo→expiry/refresh/revoke/SSO | mock OAuth/token 존재 | O1 개발 App 등록·설치 완료; 실계정 전체 수명주기/갱신/서명 앱은 미완료 |
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

다음 단위는 **nonzero 비용원장의 중단/재개 검증 범위와 소유 프로세스 종료 경계 확인**, **기존 데이터 적용·되돌리기 조건 정리**다. 안전한 종료 소유권이 검토되지 않은 과거 숫자 PID 기반 시험을 재실행하지 않는다. 구 archive 자동 변환, 모든 강제종료/비용원장 replay, 기존 사용자 DB·locale 적용은 미완료이므로 G-RECOVERY 전체 상태를 PASS로 바꾸지 않는다. 2단계 실계정 project1에는 그 조건을 확인한 후 접근한다.

### 최신 전체 진행표 / 보고 기준

**현재 위치는 배포 전8단계 중1단계이며 1단계 전체 완료 전이다.** 이는 제품 기능 개발의
1/8만 구현됐다는 뜻이 아니다. [11](11-first-implementation.md)의 A–E 제품 경로와
개발용 F 앱 구동 기반은 이미 구현/부분 검증되었고, 아래는 각 배포 준비 단계의
수용 기준 완료 여부다. 이후 작업 보고에도 현재 전체 단계, 이번 완료 단위, 잔여
조건과 다음 작업을 함께 기록한다. 단순 단계 수를 개발 완료율로 환산하지 않는다.

| 단계 | 현재 상태 | 완료 근거 또는 남은 조건 |
| --- | --- | --- |
| **1 데이터 복구 안정화** | **진행 중 / 여러 하위 단위 완료** | 호환성 사전 거부, 정상 복원, 두 I/O 중단 복구/재시작, 상태별 안내·시작 진단 완료. nonzero 원장·전체 crash 경계·구 DB/locale 적용 조건과 최초 시작 실패 원인 검증 잔여 |
| 2 실제 GitHub 가져오기 | 실계정 후속 검증 대기 | 복구 UI/기반 구현과 합성 경로는 존재. 기존 실패 project1의 실제 UI 재분석은1단계 사용자 프로필 적용 조건 이후 |
| 3 인증 수명주기 | 부분 구현 / 전체 수용 미완료 | 연결/해제·만료 표시/세대 방어 등 구현. 실권한 철회·전체 수명주기·자동 refresh/rotation 잔여 |
| 4 분석·작업 신뢰 | 부분 구현·검증 / 확대 수용 미완료 | 개요/탐색/source snapshot/파일 결과 기반 구현. 완료·취소 경합/worker crash 및 대표 corpus/독립 oracle 전체 기준 잔여 |
| 5 성능·보안·사용성 | 통합 수용 미완료 | 한 호스트 부분 측정·경계 시험만으로20회 p95/RSS, 독립 보안/비용 경합·사용자 과제 전체를 대체하지 않음 |
| 6 새 설치·업데이트 | 별도 기기·OS·서명 조건 대기 | 개발 Mac 패키지 구동 검증 존재. 개발도구 없는 새 Mac·실제 최소 OS·signed update/rollback 미완료 |
| 7 배포물·운영 준비 | 최종 정리 미완료 | 정확한 배포 후보의 SBOM/license/취약점·지원 범위·운영 App 공개 설치/대응 기준 확정 필요 |
| 8 출시 최종 판정 | **No-Go / 미완료** | 필수 release gate·독립 검토·정식 서명/공증 자격/승인과 공개 승인 필요 |
