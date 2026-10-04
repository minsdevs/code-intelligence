**언어:** [English](README.md) | 한국어

# Code Intelligence

현재 감사: [2026-10-02 출시 점검 보고서](docs/release-audit-2026-10-02.md).
후속 구현과 검증은 [통합 결과](docs/audit/execution-results-2026-10-02.md),
[현재 실행 상태](docs/audit/execution-status-2026-10-02.md)와
[독립 리뷰 기록](docs/audit/execution-review-2026-10-02.md)을 참조하십시오.
프로덕션 출시는 **No-Go**이며, 아래 과거 RC 기록은 현재 인수 검증을 대신하지 않습니다.
[현재 재시작·출시 감사](docs/audit/restart-recovery-audit-2026-10-03.md)는 인증된 거래 복구,
보존 소스 재구성, 공간·보존 정책, 프로세스 소유권과 native/analyzer 수정을 기록합니다.
과거 복구 관찰과 증거의 한계를 구분하며, 위험한 PID 기반 guardian 시험은 계속 격리합니다.
최종 명령·시험 수·검증 범위·소스 SHA는
[검증 기록](docs/audit/restart-recovery-validation-2026-10-03.json)에 있습니다. 호환하는 독립 실행 번들, 운영 OAuth,
일반 source 소비자 이행, OS 격리, 서명 설치와 대표 정확도 수용은 출시 차단점입니다.
[최신 합성 HTTP→DB→SSE 검증](docs/audit/parser-http-db-sse-2026-10-03.md)은 14개 점검을 통과했고,
추가로 재현한 최상위 함수 호출 누락을 수정해 분석기 165개 테스트가 통과했습니다.
[Windows 준비](docs/audit/windows-readiness-2026-10-03.md)에는 경로·환경 처리와 차단된 x64 NSIS 설정을
추가했습니다. Windows native 보관·runtime·설치 검증은 아직 미완료입니다.
이전 [백업·복원](docs/audit/backup-restore-integration-2026-10-03.md)과
[비용 통합](docs/audit/strict-ai-cost-integration-2026-10-03.md) 기록은 보존합니다.

낯선 로컬 폴더나 GitHub 레포의 주요 구성, 기능 위치, 호출·의존 경로와 근거 소스를
탐색하는 개인용 워크스페이스입니다. 가져오기 미리보기·승인과 분석이 끝나면 개요로
진입하며, 영역 필터는 결과를 확인한 뒤 선택적으로 사용합니다. 핵심 탐색은 AI 없이
동작하고, AI는 승인한 컨텍스트에 대한 설명과 추가 확인을 돕습니다.

학습 관리·성장 리포트·학습 과제 생성은 제품 경로에서 제거했습니다. 분석 메모,
검토 작업과 체크리스트는 유지하며 기존 학습 데이터와 과거 migration은 삭제하지 않습니다.

> **과거 RC 기록 / 내부 테스트.**
> Phase 1–5 기능이 구현되어 있으며, 현재 RC에는 로컬 폴더 가져오기,
> 확인 후 로컬 새로고침, 스냅샷 비교, finding 판정, coverage,
> Markdown/JSON 내보내기, IDE 딥 링크, AI 컨텍스트 미리보기/제외,
> 품질 회귀 게이트가 추가되었습니다. 이러한 RC 변경 사항은
> `rc/feature-freeze-20260824`에 스테이징되어 있으며, 여기서는 `main`에
> 릴리스된 것으로 설명하지 않습니다. 구현 및 검증 기록은
> [ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md)를 참조하십시오.
>
> **릴리스는 여전히** 실제 브라우저 10단계 E2E와 대표 저장소에 대해 승인된
> 정확도/오탐 oracle 때문에 차단되어 있습니다. 사용자 데이터 백업/복원은
> 로컬 macOS runtime에 구현됐으나 안전한 대체 구현 전까지 차단합니다. 로드맵 P2 증분 재분석은 구현되지
> 않았습니다.

이 저장소는 현재 Spring Boot 백엔드와 선택적 analyzer sidecar를 갖춘
브라우저 기반 로컬 워크스페이스와 `desktop/`의 Electron 데스크톱 runtime을
제공합니다. 데스크톱 경로는 backend, analyzer, JRE, PostgreSQL, Redis를
staging하고 OS 보호 저장소에 runtime credential을 보관하는 macOS arm64 RC
surface입니다. 서명/notarization된 프로덕션 배포나 자동 업데이트 채널은
아직 아닙니다.

## 원칙

1. **결정론 우선** — 구조, 관계, 이력은 정적 분석(AST 파서, JGit, 설정 파서)으로
   추출합니다. AI는 해석하고 설명할 뿐이며 사실을 만들어내지 않습니다.
2. **근거 기반** — 모든 AI 주장은 실제 소스 위치, 커밋 또는 PR로 연결되며
   신뢰도(`Confirmed / Likely / Possible / Unknown`)를 포함합니다.
3. **영역 중립** — 먼저 저장소 전체를 분석한 다음 탐색할 영역
   (Backend / Frontend / Database / …)을 선택합니다.

## 기술 스택

| 부분 | 기술 |
|---|---|
| Backend | Java 21, Spring Boot, Spring Security, JPA, Flyway, JGit, JavaParser |
| Data | PostgreSQL 16 + pgvector, Redis 7 |
| Frontend | React 19, TypeScript (strict), Vite, Tailwind CSS v4, TanStack Query, Zustand, React Flow |
| Analyzer sidecar (Phase 2) | NestJS, ts-morph (TypeScript Compiler API), tree-sitter |
| AI (Phase 3) | Provider 추상화(OpenAI / Gemini), pgvector embeddings, 근거 기반 어시스턴트 |
| 분석 보조 | 코드 참조 메모, 검토 작업과 체크리스트, 승인 기반 AI 설명, 통합 검색 |
| Advanced (Phase 5) | PR 리뷰(정적 finding + AI), playground(clone 실행 없음), 정적 what-if |

## 시작하기

사전 요구 사항: `docker compose`가 포함된 Docker, Node.js 24, JDK 21 이상.
PostgreSQL, Redis, Testcontainers 기반 백엔드 검사와 `./quality-gate`를 위해
Docker가 실행 중이어야 합니다. Gradle은 Java 21 toolchain을 사용합니다.

### 권장 로컬 경로

```bash
cp .env.example .env
# Generate a value and set TOKEN_ENC_KEY in .env:
openssl rand -base64 32

./check-local   # checks env, Docker/Compose, Java, Node, and local ports
./start-local   # PostgreSQL + Redis, backend, frontend; optional analyzers when configured
# Open http://localhost:5173
./stop-local
```

브라우저 검증 후 로컬 macOS 데스크톱 runtime을 실행할 수 있습니다. 먼저 릴리스 소유자가
할당한 0 이상의 signed64 십진 문자열을 `CODE_INTELLIGENCE_BUILD_SEQUENCE`로 export해야 합니다.
없거나 잘못된 값이면 빌드·파일 교체 전에 중단합니다. 이 값만으로 서명된 antirollback을 증명하지 않습니다.

```bash
(cd desktop && npm ci && npm run stage && npm start)
```

`desktop/scripts/stage-runtime.mjs`는 현재 macOS arm64를 검증하고
frontend/analyzer/backend를 빌드하며, 로컬 PostgreSQL(pgvector 포함)과 Redis
binary를 요구합니다. `pack:mac`은 로컬 directory package를 생성합니다.
서명, notarization, 새 기기 설치 및 실제 OAuth는 여전히 release blocker입니다.
게시 전 Java 21·arm64·macOS 13.0 대상, 필수 실행 파일/확장 역할과 자체 포함된
라이브러리 참조를 검사합니다. 호환하는 의존성 산출물이 필요하며 현재 호스트의
Homebrew 빌드는 이 검사를 통과하지 못할 수 있습니다.
호스트의 `pgvector` bottle이 선택한 PostgreSQL major와 다르면, 해당
`pg_config`로 빌드한 extension root(`lib/postgresql` 및
`share/postgresql/extension` 포함)를 `PGVECTOR_ROOT`로 지정해야 합니다.
stage는 manifest 완성 뒤 이전 디렉터리를 보존하며 교체합니다. 중단된 트랜잭션은
잠금·복구 marker를 남깁니다. 합성 중단 시험이 서명된 업데이트 복구를 증명하지는 않습니다.

macOS Electron의 기본 app-data 위치는
`~/Library/Application Support/code-intelligence-desktop`입니다
(`desktop` 패키지 이름은 `code-intelligence-desktop`). 현재
`desktop/src/main.cjs` 기준으로 bundled PostgreSQL DB는 `postgres/`, Redis
상태는 `redis/`, backend data와 repositories는 `data/`, 복원 전 recovery
checkpoint는 `recovery/<transaction-UUID>/` 아래에 저장됩니다. Runtime child log는
Electron의 `app.getPath('logs')`를 사용하므로 macOS에서는 app-data 밖의
`~/Library/Logs/code-intelligence-desktop/runtime`에 기록됩니다.
안전 상태는 일반 복원 대상 밖의 `safety/`와 별도 enrollment marker에 둡니다.
암호화 복구 기록은 `backup-maintenance/`에 둡니다. 새로 staging한 protocol3 runtime은
암호화 백업·복원 버튼을 연결하며 이전 bundle은 계속 차단합니다. 아직 내부 검증 범위입니다.
과거 format1/2·다른 설치의 archive는 거부하고, 미완료 거래는 정상 시작을 막습니다.
검증 가능한 PREPARED v2 거래는 다음 시작의 복구 확인에서 같은 거래로 재개합니다.
식별자·내용을 증명할 수 없는 기록이나 임시 파일은 보존하고 정상 시작을 계속 막습니다.

로컬 unsigned directory package를 만들고 직접 실행하는 경로는 다음과
같습니다.

```bash
(cd desktop && npm run stage && npm run pack:mac)
open "desktop/dist/mac-arm64/Code Intelligence.app"
```

이는 `electron-builder --mac dir` 로컬 package를 생성합니다. 이 package는
macOS acceptance를 위해 직접 실행했지만 `/Applications`로 복사하지 않았고,
release·publish·deploy도 수행하지 않았습니다.

`./start-local`은 개발 도우미이며 프로덕션 supervisor가 아닙니다.
`TS_ANALYZER_BASE_URL` 또는 `TREE_ANALYZER_BASE_URL`이 설정된 경우에만
analyzer 컨테이너를 시작합니다. 두 analyzer를 포함한 모든 로컬 인프라를
수동으로 시작하려면 다음을 실행하십시오.

```bash
docker compose up -d

# Backend — http://127.0.0.1:8080 (health: /actuator/health)
(cd backend && ./gradlew bootRun)

# Frontend — http://localhost:5173
(cd frontend && npm ci && npm run dev)
```

AI는 선택 사항입니다. Native GitHub OAuth에는 desktop/backend 실행 시
`GITHUB_NATIVE_CLIENT_ID`가 필요하지만 이것만으로 운영 OAuth가 동작하지는 않습니다.
현재 code 교환은 GitHub가 요구하는 client secret을 생략하므로, 출시 전에
device flow 또는 서버에서 비밀키를 보관하는 교환 방식 선택이 필요합니다. client secret은 desktop binary에
넣지 않으며, PAT login은 secondary 경로로만 지원합니다. 백엔드에는 항상
`TOKEN_ENC_KEY`가 필요합니다. sidecar를
활성화하려면 `TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`과
`TREE_ANALYZER_BASE_URL=http://127.0.0.1:3041`을 설정하십시오.

## 개발

저장소 루트에서 다음 명령을 실행하십시오.

```bash
# Backend: format check + tests (Testcontainers; Docker required) + build
(cd backend && ./gradlew spotlessCheck build)

# Frontend: lint, typecheck, tests, build
(cd frontend && npm ci && npm run lint && npm run typecheck && npm test -- --run && npm run build)

# ts-analyzer sidecar
(cd analyzers/ts-analyzer && npm ci && npm test && npm run typecheck && npm run build)

# tree-sitter sidecar
(cd analyzers/tree-analyzer && npm ci && npm test && npm run typecheck && npm run build)

# Docker-backed golden corpus + analyzer quality/performance thresholds
./quality-gate

# Desktop syntax 및 local macOS staging/package 검사
(cd desktop && npm test && node --check src/main.cjs && node --check src/preload.cjs)
(cd desktop && npm run stage && npm run pack:mac)
```

CI는 모든 pull request에서 backend, frontend, TypeScript analyzer와 tree-sitter
analyzer 게이트를 실행합니다. 백엔드 작업도 `./quality-gate`를 실행하므로
runner에서 Docker를 제공해야 합니다. baseline 변경은
`quality-baseline.env`에 대한 명시적이고 검토된 편집이며,
`QUALITY_BASELINE_UPDATE`는 의도적으로 거부됩니다.

## AI provider, 모델 및 비용

AI는 선택 사항입니다. 정적 분석, 그래프 탐색, 이력과 검색에는 provider가 필요하지
않습니다. Settings에서 명시적으로 저장한 BYOK 키는 암호화해 소유자별로 보관하며
평문을 반환하지 않습니다. 키가 없거나 OFF·재연결 상태이면 환경 키로 자동 전환하지
않습니다. 비용은 키 소유자가 provider에 지불하며 무료 AI 사용량은 포함되지 않습니다.

현재 데스크톱 후보는 로컬 소유자의 Assistant 질의에 고정 모델
`gpt-4o-mini-2024-07-18`을 지원합니다. 키 저장은 provider를 호출하지 않으며 AI는
OFF 상태를 유지합니다. 기본값이 모두 0인 일·월 USD 한도를 지정한 뒤 별도로
활성화해야 합니다. 각 질문은 정확한 마스킹 문맥과 최대 예약액을 검토하고 일회용으로
승인합니다. 금액은 정수 micro-USD로 계산하며, 예약액은 일반적인 비용 추정치가 아닌
전체 입력 상한·제한된 출력 기준입니다. main은 한 번 전송하고 usage와 journal/DB
정산을 기록한 뒤 답변을 반환합니다. 결과가 불명확하면 예약액을 유지하며,
OFF는 새 전송을 막지만 이미 전송한 provider 요청을 취소하지는 않습니다.

다른 데스크톱 provider·embedding·승인되지 않은 보조 호출은 사용할 수 없습니다.
버전이 지정된 가격 계약은 만료 시 전송을 거부합니다. 실제 청구서·유료 호출·서명된
native 격리는 검증하지 않았습니다. [비용 계약과 한계](docs/audit/strict-ai-cost-integration-2026-10-03.md)를
참조하십시오. 브라우저 개발 경로는 OpenAI/Gemini와 기존 `AI_DAILY_TOKEN_LIMIT`
보호 장치를 유지하지만 데스크톱의 금액 계약을 제공하지 않습니다.

## 개인정보와 신뢰 경계

저장소 메타데이터와 정적 분석은 로컬 백엔드와 데이터베이스에서 처리됩니다.
AI 요청은 선택한 기능에 필요한 컨텍스트만 전송할 수 있습니다. 예를 들면 집중된
소스 구간, finding, pull request 텍스트 또는 playground 질문/스니펫입니다.
AI 컨텍스트를 구성하기 전에 secret을 마스킹하지만, 사용자는 provider 요청을
잠재적으로 민감한 소스 코드의 외부 전송으로 간주해야 합니다. provider의 현재
데이터 사용 정책이 환경에 적합하지 않다면 AI provider를 활성화한 상태로 기밀
저장소를 가져오지 마십시오. Playground 스니펫은 텍스트 전용이며 빌드되거나
실행되지 않습니다.

백엔드는 기본적으로 loopback에 바인딩됩니다. 로컬 머신 밖으로 노출하는 경우
해당 배포에 인증, CORS, TLS, secret 관리, 백업, 네트워크 접근 제어를 설정하십시오.
로컬 Docker Compose 설정은 프로덕션 배포가 아닙니다.

## RC 워크플로와 안전 경계

- **로컬 가져오기:** 인증된 사용자는 `/import?path=<URL-encoded-path>`를 열고
  파일 미리보기를 요청하고 일회용 승인을 명시적으로 확인한 뒤 `POST /api/projects/local`을 실행할 수
  있습니다. 자동 가져오기나 브라우저 디렉터리 picker는 없습니다.
  `LOCAL_IMPORT_ALLOWED_ROOTS`는 쉼표로 구분된 allowlist이며, 비어 있으면
  서버 파일시스템 경로를 허용하지 않습니다. 데스크톱 native picker는 렌더러와
  분리된 메인 프로세스 토큰으로 선택한 폴더의 권한을 부여합니다. 새로고침 미리보기와 복사는
  같은 선택·제외·용량 제한과 원본 Git blob hash를 사용합니다. ignore 구문, 제외,
  한계와 남은 파일시스템 race 경계는 [로컬 가져오기 정책](docs/audit/local-ingest-policy.md)을 따릅니다.
- **확인 후 새로고침:** 로컬 프로젝트는 `최신`, `변경됨`, `경로 없음`,
  `권한 재확인 필요` 또는 `검사 실패`를 표시합니다. 처음 가져오기와 새로고침 승인은
  소유 project/기준 snapshot, 원본 root identity, 선택 제한과 실제 파일 바이트에 결합합니다.
  미사용 승인은10분 뒤 만료되며, 소비한 job receipt는 대기 시간을 지나도 유지됩니다.
  worker는 실제 staging 내용을 검증한 뒤 저장소를 교체하고, 입력이 달라지면 새 preview를
  요구합니다. 응답이 불명확하면 confirmation 재전송 없이 원자적 결과 조회로 복구합니다.
  새로고침은 **전체** 분석입니다. native 파일 접근 격리와 불변 소스 보존은 여전히 출시
  blocker이며, [승인 계약](docs/audit/e2-approval-contract-2026-10-02.md)에 한계를 기록했습니다.
- **분석 결정:** Analysis는 목록화한 파일 수와 측정하지 않은 분석 결과·완전성 미확인을
  구분합니다. 로컬 가져오기 제외는 별도의 개수 관측으로 표시합니다. 결정론적 스냅샷 비교와
  사용자별 finding 판정(`NEEDS_REVIEW`, `ACCEPTED`, `FALSE_POSITIVE`,
  `RESOLVED`)을 노출합니다. 숨긴 오탐은 복구할 수 있으며, 규칙/근거가 바뀌면
  다시 검토 상태가 됩니다.
- **재사용과 편집:** 현재 스냅샷 요약은 secret redaction 후 소스 본문 없이
  Markdown 또는 JSON으로 내보냅니다. IDE 링크는 로컬 프로젝트에만 제공되며
  상대 경로를 검증합니다. 설정된 IDE를 열기 전에 commit 불일치를 보고합니다.
- **AI 제어:** 미리보기는 제한된 로컬 문맥과 일치하는 기존 요약만 읽으며 요약 생성이나
  embedding을 호출하지 않습니다. 실제 질문은 추가 문맥을 가져올 수 있습니다.
  제외한 컨텍스트 ID는 서버 측에서 필터링되며, “local data only”는
  frontend가 AI 요청을 보내지 못하게 합니다. 실제 요청이 전송될 때의 provider
  정책을 보장하는 것은 아닙니다.
- **복사 가능한 prompt:** Context Preview는 AI key나 provider 요청 없이
  secret을 마스킹한 prompt를 생성하고 복사할 수 있습니다. 이는 외부 model
  호출이 발생했다는 의미가 아닙니다.
- **재분석 diff:** local refresh는 명시적으로 확인하는 전체 재분석입니다.
  Snapshot comparison에서 feature, flow, finding, node, relation, coverage,
  rename candidate와 regression warning을 비교합니다. 증분 P2 재분석은
  여전히 범위 밖입니다.
- **Desktop recovery:** protocol3 runtime은 Settings에서 암호화 백업을 제공합니다.
  복원은 typed 데이터·검증된 소스를 새 staging에 적재하고 이전 DB/소스를 보존합니다.
  AI OFF를 유지하며 자격증명·세션·폴더 승인을 폐기하고, 쓰기를 차단한 채 정상 기동을
  확인한 뒤 완료합니다. 과거 dump/SQL fallback은 계속 거부합니다. 중단 거래 복구와
  보존 정책은 출시 차단점이며, 유실된 identity·안전 상태를 새 키로 조용히 대체하지
  않습니다. [현재 감사와 한계](docs/audit/backup-restore-integration-2026-10-03.md)를 참조하십시오.
- **AI 연결 상태:** OFF는 저장 키를 삭제하고 provider/model 선택은 보존합니다.
  신규 사용자·OFF·재연결 상태에서 환경 키로 전환하지 않습니다. 데스크톱 키 저장,
  예산 활성화와 개별 질문 승인은 별개입니다. 이미 전송한 요청은 OFF 후에도 완료될
  수 있으며 끝날 때까지 실행 수에 포함됩니다. 로컬 분석과 복사 가능한 미리보기는
  사용할 수 있습니다. 브라우저 개발 경로는 엄격한 금액 상한을 보장하지 않습니다.

### 현재 분석 경계

- TypeScript/NestJS는 프로젝트 문맥을 하나의 요청으로 전달합니다. 최대 20,000파일,
  직렬화된 UTF-8 JSON 10MiB, 개별 파일 1MiB이며 초과하면 명시적으로 실패합니다.
  문맥을 잃는 독립 batch는 사용하지 않습니다. 대형 monorepo 지원 완료를 뜻하지 않습니다.
- 실행 중 취소한 job은 현재 step이 끝날 때까지 `CANCELLING`입니다. 이 동안 재분석과
  삭제를 막으며 이미 완료한 step은 되돌리지 않습니다. Flyway V21이 active-job
  unique index에 이 상태를 포함합니다.
- Git submodule은 제외 개수를 snapshot 근거로 남깁니다. 하위 내용을 자동 가져오기나
  분석하지 않습니다.
- 언어 식별과 의미 분석 지원은 다릅니다. 실제 깊이는
  [언어 지원·후속 기획 인수 문서](docs/planning-handoff-2026-10-02.md)를 참조하십시오.

## RC 검증 기록 (2026-08-24)

현재 스테이징된 RC 구현을 기준으로 기록했습니다.

- Backend: `310`개 테스트 통과, 실패/skip `0`; Docker/Testcontainers를 사용할
  수 있는 상태에서 `spotlessCheck`, compilation, assemble 통과.
- Frontend: lint, typecheck, build 및 `19`개 파일 / `57`개 테스트 통과.
- Analyzer: ts-analyzer `8`개 테스트와 tree-analyzer `7`개 테스트 통과,
  둘 다 typecheck와 build 통과.
- Quality gate: fixture 파일 `54`개, backend `23s`, 최대 RSS `127,616KB`로
  검토된 제한 `300s` / `2,097,152KB` 이내.
- Flyway: sentinel user, project, snapshot, note, task, AI setting, finding 데이터를
  보존하면서 신규 V1→V19와 V17→V18→V19 upgrade 통과.
- 로컬 파이프라인: 소형/중형/현재 저장소 사본에서 적격 파일 `14/14`, `130/130`,
  `646/646` 분석; 가장 큰 실행은 `45.972s`, 관측된 JVM process-tree 최대 RSS는
  `1,541,760KB`.
- 교차 프로젝트 service/library smoke: 확인된 로컬 가져오기, stale-preview
  conflict, 안전한 전체 새로고침, 스냅샷 비교, 정리를 다루는 integration test
  `1`개 통과.

이 수치는 브라우저 E2E, 분석 정확도, 승인된 오탐률, 백업/복원 또는 프로덕션
준비 완료를 주장하지 **않습니다**. RC 기록과 blocker는
[ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md)를 참조하십시오.

## 지원되는 실행 및 릴리스 범위

| 환경 | 상태 |
|---|---|
| 로컬 브라우저 + Spring Boot backend | 지원되는 개발 경로 |
| Docker Compose PostgreSQL/Redis/sidecar | 지원되는 로컬 인프라 |
| macOS arm64 Electron runtime | 로컬 staging/package RC; unsigned/notarized acceptance 대기 |
| Windows 네이티브 설치 프로그램 | x64 NSIS 설정 준비; native 안전 구현/runtime 완료 전 패키징 차단, 설치 미검증 |
| Linux 네이티브 패키지 | 검증하지 않음 |
| 프로덕션 호스팅 배포 | 배포별로 다름; 릴리스 워크플로가 포함되지 않음 |

후속 배포 순서는 Developer ID 서명 → notarization → staple/Gatekeeper 검증
→ fresh-machine backup/restore/OAuth acceptance → release 순서로만 진행합니다.
이번 로컬 검증에는 Developer ID/notary credential과 실제 OAuth credential을
사용할 수 없었고, 사용하지도 않았습니다.

## 문제 해결

- `TOKEN_ENC_KEY` 때문에 Backend 시작이 실패하는 경우:
  `openssl rand -base64 32`로 32-byte base64 키를 생성해 `.env`에 넣으십시오.
- Database 또는 Redis 연결 오류: backend를 시작하기 전에
  `docker compose up -d`를 실행하고 `docker compose ps`를 확인하십시오.
- TypeScript 기능을 사용할 수 없는 경우: `ts-analyzer`를 시작하고
  `TS_ANALYZER_BASE_URL=http://127.0.0.1:3040`을 설정하십시오. Python/Go/Vue/Svelte
  parsing에는 `tree-analyzer`와 해당 base URL도 필요합니다.
- AI가 비활성화된 경우: 지원되는 환경 키를 설정하거나 Settings를 열어 provider
  키를 저장하십시오. 모델 목록과 연결 검사에는 선택한 provider로의 네트워크
  접근이 필요합니다.
- 키를 활성화한 후 AI 요청이 실패하는 경우: 선택한 모델, provider quota,
  outbound 네트워크 정책과 provider의 현재 API 약관을 확인하십시오.

## 로드맵

| Phase | 범위 |
|---|---|
| 0 — Foundation | Scaffold, DB schema, CI, 3-pane workspace shell |
| 1 — Repository Intelligence Core | GitHub OAuth, import & clone, project-area detection, Java AST analysis, code explorer, architecture view, history |
| 2 — Cross-domain Intelligence | TypeScript analyzer, FE↔BE↔DB↔Infra linking, flows, findings, impact analysis |
| 3 — AI | Context-aware assistant, why/alternative analysis, evidence-grounded answers |
| 4 — Analysis support | Notes, analysis tasks, manual verification checklists, unified search |
| 5 — Advanced | PR review, playground, what-if simulator |

이 표는 구현된 phase 범위를 설명하며 현재 RC 릴리스 게이트를 의미하지 않습니다.

전체 설계: [기획서.md](./기획서.md)

## 라이선스

[MIT](./LICENSE)
