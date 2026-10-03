# Desktop 요청 승인·비용 정산 통합 — 2026-10-03

**제품 출시 판정은 No-Go다.** 이번 후보는 desktop AI를 일괄 차단하던 이전 단계에서
실제 일회용 요청 승인 → main 전송 → usage → journal/PostgreSQL 정산까지 연결했다.
아래 검증은 실제 코드와 격리된 로컬 실행의 근거이며, 유료 provider나 서명된 설치 앱의
운영 수용을 뜻하지 않는다. 독립 검토의 발견을 수정하고 최종 전체 회귀·빌드·source
사용자 흐름 검증을 완료했다.

저장소는 `/Users/minseokchae/Dev/code-intelligence`, branch `codex/e2e-docs-scripts`,
HEAD `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`이다. 기존 작업 트리에서 변경을 보존했다.
실제 구조는 Electron main/preload → loopback Spring Boot/Java 21 → PostgreSQL/pgvector,
Redis, React/Vite UI와 NestJS/TypeScript 분석 sidecar다. Flyway는 V1–V25다.
전면 재작성이나 다른 저장소로의 대체는 하지 않았다.

## 구현된 사용자 흐름과 계약

1. 로컬 분석·미리보기·프롬프트 복사는 AI 키 없이 사용할 수 있다. Desktop 키 저장은
   암호화 저장만 수행하며 provider 연결 검사를 호출하지 않고 main을 OFF로 둔다.
2. 일·월 한도는 정수 micro-USD 문자열이며 기본값은 0이다. 한도 저장과 활성화는 별개다.
   활성화 승인은 소유자·설치 ID·main epoch·journal 위치·설정/정책 revision에 묶인
   5분 일회용 토큰이다. 새 조회가 이전 토큰을 대체하고 재시작은 승인을 복원하지 않는다.
3. 현재 지원은 로컬 설치 소유자의 Assistant Q&A와 고정 모델
   `gpt-4o-mini-2024-07-18`이다. 정확한 질문·snapshot·문맥·제외·소유권·설정과
   마스킹된 전송 본문을 RequestPlan에 묶는다. 원래 질문도 해시로 구분한다.
   최대 비용·출력·가격 버전·만료를 표시한 뒤 별도 확인을 받아야 한다.
4. main이 실제 전송 바이트를 보유한다. backend는 환경 변수/argv/renderer에 공개되지
   않는 자식 stdin bootstrap으로 private UDS capability를 받는다. bounded framing,
   엄격한 JSON/UTF-8, call ID, epoch와 EOF를 확인하며 재시도하지 않는다.
5. gate 행 잠금 아래 예약을 먼저 커밋한다. main이 별도 psql 어댑터로 읽은 커밋 상태와
   승인·본문·설정·가격을 대조하고 journal intent를 영속화한다. 최종 OFF 검사 후
   한 번 전송한다. 최대 2개 pending 요청과 일·월 한도를 함께 검사한다.
6. 관측 usage → 변경 불가 evidence → journal 정산 → PG 반영·재확인 후에만 답변을
   반환한다. 답변 파싱/저장 실패가 정산을 되돌리지 않는다. 응답 유실·알 수 없는 usage는
   전액 보류하며 자동 환불·재전송하지 않는다. 모든 날짜의 미정산 보류액을 현재 한도에
   포함한다. 재시작·재조정은 A/B의 의무 합집합과 보수적 최대값을 사용한다.

입력 상한 128000은 실제 token 추정치가 아닌 provider의 전체 context ceiling이다.
현재 출력 cap은 2048이며 캐시 할인을 예약액에 적용하지 않고 10% 여유를 더한다.
현재 한 요청의 최대 예약액은 **22472 micro-USD ($0.022472)**다. 합성 응답의
input 100(그중 cached 40), output 50은 **42 micro-USD**로 정산됨을 실제 DB로 검증했다.
숫자·캐시·usage 차원이 없거나 모순되면 0으로 간주하지 않는다.

가격은 2026-10-03 확인한 input/cached/output $0.15/$0.075/$0.60 per million 계약이다.
계약은 30일 뒤 만료되며 자동 갱신·모델 alias fallback이 없다.
[공식 모델·가격·상한](https://developers.openai.com/api/docs/models/gpt-4o-mini)과
[공식 completion/usage 계약](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)을 기준으로 고정했다.
이 앱 밖에서 같은 키로 발생한 비용이나 provider 청구서 전체에 대한 상한 보장은 아니다.

OFF는 새로운 전송과 과거 활성화 승인을 막는다. 이미 발행된 요청을 취소했다고 표시하지
않으며 끝날 때까지 activeRequests에 포함하고 정산한다. main 종료는 실제 자식 종료를
확인한 뒤 gateway/journal/keyring을 닫는다. 재시작은 OFF다. 다른 desktop provider,
embedding, summary/task/playground 등의 별도 helper는 metadata provider에서 거부된다.
브라우저 개발 경로는 기존 soft token guard이며 이 금액 계약의 적용 대상이 아니다.

## 발견, 사용자 영향과 수정

| 심각도 / 우선순위 | 파일·재현 근거와 영향 | 수정 및 검증 |
|---|---|---|
| High / P0 | `AiSafetyPolicy`, `AiUsageService`, 이전 main: 실제 승인·영속 비용 예약 경로가 없어 desktop AI를 차단해야 했음 | V25 ledger, private gateway/psql, UI 승인·예산 연결. 실제 HTTP→Java→Node→journal/PG 12개 통과. 지원 외 경로는 계속 거부 |
| High / P1 | `AiRequestPlanService`, `AssistantService`: 서로 다른 secret 질문이 같은 마스킹 본문으로 합쳐져 승인 재사용 가능, USER 메시지에 원문 비밀 저장. 초기 73개 중 2개 RED | 원래 질문 해시 추가, 저장 질문 마스킹. 해당 73개 GREEN 및 후속 전체 gate 대상 |
| Medium / P1 | `AiRequestPlanService:172` 이후 공통 조립: conversation 소유권 검사가 과금 뒤에 있어 잘못된 대화로도 비용 발생 가능 | 준비와 소비 전에 소유권·project·존재 검사. 삭제/타인/다른 project 회귀와 provider 호출 0 확인 |
| Medium / P1 | `AiRequestPlanService:106`, `AiRequestPlanStore:95`: quote 실패 시 전달되지 않은 토큰이 사용자 32개 슬롯을 점유 | 정확한 issued token 폐기. 40번 quote 실패 후 정상 준비 성공 회귀 포함 38개 HTTP 통과 |
| Medium / P1 | `AiCostLedger` nullable 숫자 읽기: null unboxing으로 신규 gate 등 실제 PG 6개 실패 | nullable 변환 보정, ACK idempotency 보강. 실제 임시 DB 63개 통과 |
| Medium / P1 | `ai-egress.cjs` activate, `ai-desktop-gateway.cjs:111`: OFF가 조회/조정 중 발생하면 오래된 활성화가 성공 반환 | wrapper/control/core generation과 journal cursor 확인. 2개 RED 뒤 91개 core, 45개 private gateway 통과 |
| Medium / P1 | `safety-lifecycle.cjs:225`: 첫 budget 조회 전 정상 종료 시 메모리의 fresh origin을 잃어 새 설치가 영구 legacy로 취급됨 | v2 marker에 원래 eligibility를 인증해 같은 publication에 저장. v1은 보수적으로 유지, PG 기존 사용량 검사 유지. 변조/다른 설치/B 유실/재시작 회귀 |
| Medium / P1 | `AiSettingsService:232`, `ai-desktop-gateway.cjs:101`: 새 gateway 호출이 기존 backend counter를 우회해 OFF 중 0 표시 | main EXECUTE 수명 동안 집계, Java DTO가 읽음. 실제 UDS 1→OFF 1→정산 0 확인; 해당 Java DTO 필드는 정적 연결 확인 |
| High / P1 | `main.cjs:180` 부근: 살아 있는 child의 error를 exit로 취급하고 stdin 실패 처리의 kill 예외가 빠져나갈 수 있음 | exit 확인 전 소유권 유지, 예외 처리·OFF. 실제 main 코드 VM 최초 14개 중 2개 RED → GREEN |
| Medium / P1 | `main.cjs:424`: bootstrap 실패로 recovery가 됐는데 health가 OK이면 마지막 ready=true로 덮어씀 | 매 시작 단계/health 이후 안전 상태 재확인. 16개 중 1개 RED → 16/16 GREEN |
| High / P1 요구 간극 | `ai-https-transport.cjs`: 고정 TLS host만으로 private/reserved DNS 결과를 막지 못함 | 전체 DNS 응답 검증 후 주소 고정, 재조회·redirect·retry 0. 추가 DNS 99개 포함 model/transport 281개 통과. 실제 유출 재현이나 OS 격리 증거는 아님 |
| Medium / P1 | `AiPanel.tsx`: project 변경 뒤 늦은 preview/copy 결과가 새 화면에 섞이는 M1 | project/request scope 확인 및 기존 15개 회귀. 로컬 preview는 외부 호출 없이 유지 |
| Medium / P1 | 신규 budget UI의 실제 `configured=true`+OFF 계약 및 요청 후 READY 캐시 | 실제 계약의 RED 10개 재현 뒤 수정. 성공한 READY 조회만 준비/확인 허용, plan 실패·ask 모든 결과 뒤 budget/status/settings 재조회. 전체 293개 통과, 독립 재검토에서 해결 |

## 최종 검증

Backend·frontend·desktop 전체 회귀와 최종 빌드·source 흐름 실행이 통과했다.
Focused 통과 수는 전체 실행에 포함될 수 있으므로 합산해 제품 완료율로 쓰지 않는다.

| 검증 | 결과 / 범위 |
|---|---|
| Backend formatter, 전체 test | **1138/1138 PASS**, 102 suites, failure/error/skip 0. 1차 1개 실패는 무효 대화 사전 거부와 충돌한 옛 저장 실패 fixture. 실제 PG write failure로 바꾼 집중 12개와 전체 재검증 통과 |
| 실제 desktop 승인·과금 흐름 | **12/12 PASS**. 실제 Spring HTTP/CSRF, Java approvals/ledger, private UDS, Node gateway/lifecycle/keyring/journal, 실제 psql·임시 PG. OS wrapper와 마지막 provider 응답만 합성 |
| RequestPlan HTTP / 승인 저장소 | **38/38**, budget approval **45/45**, ledger **63/63**, Java private client **76/76** PASS |
| Frontend | **293/293 PASS**, 30 files, lint/typecheck PASS. 수정 대상 156개는 전체에 포함. 초기 282개 후보가 놓친 UI M1/M2를 RED 10개로 재현한 뒤 보정 |
| Desktop 전체 | **1081 PASS / 0 FAIL / 1 SKIP**, 총 1082. skip은 별도 실제 PG opt-in suite이며 아래 실제 PG 12개로 별도 검증. 1차 10개 기존 VM/marker fixture 실패는 단언을 보존해 수정, 집중 119개 및 전체 통과 |
| main/core/private gateway | **16/16**, **91/91**, **45/45** PASS. 합성 OS/전송을 명시한 실제 모듈·VM·소켓 검증 |
| model/HTTPS | **281/281 PASS**, 주입 DNS/HTTPS/시간 검증. 실제 외부 DNS/HTTPS 호출 0 |
| psql 어댑터 | **53 leaf PASS** = 41 단위 + 12 실제 임시 PG; Node 집계는 parent 포함 54. skip 0. 전체 default suite의 opt-in skip과 구분 |
| V25 live catalog | **8/8 PASS**, 25 migrations / 52 tables / 439 columns. 기존 V1–V24 pin 유지. 실제 백업/복원 흐름은 아님 |
| source 실제 사용자 흐름 | **12/12 PASS**. 실제 backend/임시 PG, 별도 headless Chromium의 code/feature/note 탐색·snapshot 경합·권한/소스 일치. 사용자 브라우저/설치 Electron 아님 |
| Build / TS analyzer | 최종 TypeScript/Vite·Java build **PASS**. 바로 앞 전체 backend gate를 재사용해 `build snapshotSourceTest -x test` 실행. TS analyzer **11/11**, typecheck/build PASS |

실패 이력도 보존한다. Bridge 초기 18개 실패는 `/tmp` alias와 canonical fixture 경로 충돌,
Java client 초기 5개 실패는 child stdout EOF fixture, 첫 compile 실패는 기존 test 생성자
인자 누락이었다. 생산 guard를 완화하지 않았다. Ledger/승인/main의 위 RED는 실제 수정
동기와 별도로 남긴다. 로그·XML·소스 해시는 [기계 판독 기록](strict-ai-cost-validation-2026-10-03.json)에 기록했다.

독립 backend/main 검토는 해당 26개 파일과 회귀 근거 안에서 미해결 C/H/M이 없다고 판단했다.
UI 독립 재검토도 M1/M2 해결과 추가 C/H/M 없음으로 마감했다. 모듈/VM 테스트를 설치
Electron·OS Keychain·전원 장애 수용으로 계산하지 않는다.

731개 backend/frontend/desktop/analyzer 소스·테스트의 영역별 최종 기준 해시와 검증 후
해시가 일치한다. 698·857·797개 각 재개 기준 파일 누락 0, 동결 기획 20개와 실행 명세
1개 변경 0이다. `git diff --check`도 통과했다. Gradle loopback handshake/폐기 예정 기능,
Vite IIFE 이름·큰 bundle, analyzer Vitest 설정 로더 경고는 성공 실행에도 남아 있다.
성능 수용을 대신하지 않는다.

독립 검토 원본은 `/tmp/ci-ai-main-integration-independent-review-2026-10-03.md`와
`/tmp/ci-ai-budget-ui-independent-review-2026-10-03.md`이며 범위·미검증 항목·파일 SHA를
인접 JSON과 최종 검증 기록에 보존했다.

## 남은 출시 차단점과 선택지

| 심각도 / 우선순위 | 현재 근거, 영향 및 필요한 작업 |
|---|---|
| High / P0 — 안전한 백업·복원 | `desktop/src/main.cjs:626,631`은 기존 dump/SQL 경로를 계속 차단. typed PG codec·일관 export·격리 loader·source pin/key·A/B 의무 merge 필요. 전체 설치 소유자 대 현재 소유자, 완전 source 대 명시적 metadata export는 [기존 설계 선택지](t09-export-design-2026-10-03.md)대로 제품 결정 필요 |
| High / P1 — source·native 권한 경계 | `SourceStoreProperties` 기본 비활성 및 `HistoryService:145,265`, `IdeOpenService`의 원본/shared Git 의존. source vault/broker 모듈만 켜지 말고 소비자를 함께 이행해야 함. backend도 DB/암호화 설정에 접근하므로 private UDS만으로 프로세스 침해 방어가 완성되지 않음 |
| High / P1 — 운영 OAuth·설치·업데이트 | `GithubNativeOAuthService`, `desktop/package.json`, entitlements/CI는 구성·코드일 뿐. 운영 앱 등록·callback·권한·만료/취소, 개발 도구 없는 새 Mac, 실제 safeStorage/업그레이드, 서명/notary/Gatekeeper/update/rollback 검증 없음 |
| High / P1 — 실제 AI 운영·복구 | 현재 가격/모델은 제한된 고정 계약. 실제 provider usage/청구 검증, 서명된 egress 격리와 강제 종료/전원 장애는 미검증. legacy 불명 의무는 해제하지 않으며 부분 초기화/원장 유실은 recovery 필요. 임의 초기화·보류액 삭제로 해결하지 않음 |
| High / P1 — 정확도·대규모 성능 | 작은 fixture와 source UI 회귀는 독립 NestJS+React holdout의 화면→API→서비스→데이터, 변경 영향·근거 정확도, 큰 저장소 자원 예산을 입증하지 않음. 대표 데이터 annotation·사용자 과제·성능 기준 필요 |

실제 사용자 프로젝트 데이터·비밀·Keychain·설치 앱·사용자 브라우저는 사용하지 않았다.
별도 headless 검증은 임시 backend/DB 전용이다. reset·기존 변경 삭제·커밋·push·PR·외부
업로드·유료 호출·게시·배포·지속 접근 생성은 하지 않았다. 초기 문서/파일 보존과 최종
source hash 일치는 기계 판독 기록에서 확인한다.
