**언어:** [English](README.md) | 한국어

# Code Intelligence

GitHub 저장소 전체를 분석하여 프로젝트를 구성하는 기술 영역(Backend, Frontend,
Database, Infrastructure, DevOps, Security, Testing, AI, …)을 자동으로 발견하고,
근거 기반의 컨텍스트 인식 AI 어시스턴트와 함께 기능, 아키텍처, 호출 흐름,
의존성, 이력, 설계 근거와 대안을 탐색할 수 있는 개인용 워크스페이스입니다.

> **상태: 릴리스 후보 / 내부 테스트.**
> Phase 1–5 기능이 구현되어 있으며, 현재 RC에는 로컬 폴더 가져오기,
> 안전한 로컬 새로고침, 스냅샷 비교, finding 판정, coverage,
> Markdown/JSON 내보내기, IDE 딥 링크, AI 컨텍스트 미리보기/제외,
> 품질 회귀 게이트가 추가되었습니다. 이러한 RC 변경 사항은
> `rc/feature-freeze-20260824`에 스테이징되어 있으며, 여기서는 `main`에
> 릴리스된 것으로 설명하지 않습니다. 구현 및 검증 기록은
> [ADDITIONAL_FEATURES.md](./ADDITIONAL_FEATURES.md)를 참조하십시오.
>
> **릴리스는 여전히** 실제 브라우저 10단계 E2E와 대표 저장소에 대해 승인된
> 정확도/오탐 oracle 때문에 차단되어 있습니다. 사용자 데이터 백업/복원과
> 로드맵 P2 증분 재분석은 구현되지 않았습니다.

이 저장소는 현재 Spring Boot 백엔드와 선택적 analyzer sidecar를 갖춘
브라우저 기반 로컬 워크스페이스를 제공합니다. 아직 패키징된 네이티브 데스크톱
애플리케이션은 아닙니다. 이 저장소에는 Tauri/Electron 런타임, 설치 프로그램,
자동 업데이트 채널 또는 macOS/Windows/Linux 서명 파이프라인이 없습니다.

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
| Learning (Phase 4) | 코드 참조가 있는 노트, 작업 + AI DRAFT 승인, FTS/`pg_trgm`/vector 하이브리드 검색 |
| Advanced (Phase 5) | PR 리뷰(정적 finding + AI), playground(clone 실행 없음), 성장 보고서, 정적 what-if |

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

AI는 선택 사항입니다. PAT 로그인을 지원하므로 GitHub OAuth 자격 증명도
선택 사항이지만, 백엔드에는 항상 `TOKEN_ENC_KEY`가 필요합니다. sidecar를
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
```

CI는 모든 pull request에서 backend, frontend, TypeScript analyzer와 tree-sitter
analyzer 게이트를 실행합니다. 백엔드 작업도 `./quality-gate`를 실행하므로
runner에서 Docker를 제공해야 합니다. baseline 변경은
`quality-baseline.env`에 대한 명시적이고 검토된 편집이며,
`QUALITY_BASELINE_UPDATE`는 의도적으로 거부됩니다.

## AI provider, 모델 및 비용

AI는 선택 사항입니다. 정적 저장소 분석, 그래프 탐색, 이력, 검색, 성장 보고서는
AI provider가 필요하지 않습니다. 서버 전체 환경 키(`OPENAI_API_KEY` 또는
`GEMINI_API_KEY`)를 설정하거나 Settings에서 provider 키를 입력할 수 있습니다.
Settings 키는 `TOKEN_ENC_KEY`로 암호화되고 인증된 사용자 범위로 제한되며,
서버는 평문 키를 반환하지 않습니다. 키를 저장하기 전에 provider 연결 검사를
실행하고, 선택한 채팅 모델은 Settings에서 변경할 수 있습니다. 현재 provider는
OpenAI와 Gemini입니다. 데이터베이스 vector schema의 차원이 고정되어 있으므로
embedding 모델은 계속 환경 설정으로 관리합니다.

프로젝트에는 호스팅 AI gateway나 무료 AI 허용량이 포함되지 않습니다. 서버 전체
키를 사용하면 운영자가 모든 사용자의 provider 사용량을 지불합니다. BYOK에서는
키 소유자가 provider에 직접 비용을 지불합니다. provider 가격, quota, retention,
약관은 시간이 지나면서 바뀌므로 프로덕션 사용 전에 provider의 최신 공식 가격과
개인정보 문서를 확인하십시오. `AI_DAILY_TOKEN_LIMIT`는 애플리케이션 예산
보호 장치이지 청구 보장이 아닙니다.

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
  경로를 검사한 뒤 `POST /api/projects/local` 실행 전에 명시적으로 확인할 수
  있습니다. 자동 가져오기나 브라우저 디렉터리 picker는 없습니다.
  `LOCAL_IMPORT_ALLOWED_ROOTS`는 쉼표로 구분된 allowlist이며, 비어 있으면
  백엔드 사용자 home만 허용됩니다. 정규 경로, 시스템/secret 디렉터리,
  symlink 이탈 검사가 적용됩니다.
- **안전한 새로고침:** 로컬 프로젝트는 `최신`, `변경됨`, `경로 없음` 또는
  `권한 재확인 필요`를 표시합니다. 새로고침에는 미리보기 스냅샷과 일치하는
  추가/수정/삭제 개수가 필요하며, 미리보기 후 소스가 변경되면 conflict를
  반환합니다. 새로고침은 증분 P2 작업이 아니라 안전한 **전체** 분석입니다.
- **분석 결정:** Analysis는 coverage/부분 결과 정보, 결정론적 스냅샷 비교,
  사용자별 finding 판정(`NEEDS_REVIEW`, `ACCEPTED`, `FALSE_POSITIVE`,
  `RESOLVED`)을 노출합니다. 숨긴 오탐은 복구할 수 있으며, 규칙/근거가 바뀌면
  다시 검토 상태가 됩니다.
- **재사용과 편집:** 현재 스냅샷 요약은 secret redaction 후 소스 본문 없이
  Markdown 또는 JSON으로 내보냅니다. IDE 링크는 로컬 프로젝트에만 제공되며
  상대 경로를 검증합니다. 설정된 IDE를 열기 전에 commit 불일치를 보고합니다.
- **AI 제어:** 미리보기는 provider에 접촉하지 않고 실제 retrieval 경로를
  사용합니다. 제외한 컨텍스트 ID는 서버 측에서 필터링되며, “local data only”는
  frontend가 AI 요청을 보내지 못하게 합니다. 실제 요청이 전송될 때의 provider
  정책을 보장하는 것은 아닙니다.

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
| macOS 네이티브 설치 프로그램 | 구현되지 않음 |
| Windows 네이티브 설치 프로그램 | 구현되지 않음 |
| Linux 네이티브 패키지 | 구현되지 않음 |
| 프로덕션 호스팅 배포 | 배포별로 다름; 릴리스 워크플로가 포함되지 않음 |

따라서 현재 릴리스는 서명된 크로스 플랫폼 데스크톱 배포라고 주장하기 위한 것이
아니라 로컬 평가와 개발에 적합합니다. 향후 데스크톱 릴리스가 프로덕션 준비
완료로 불리려면 네이티브 런타임, OS 자격 증명 통합, 패키징, 서명/notarization,
업데이트 전달, crash 복구, 플랫폼 CI를 추가해야 합니다.

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
| 4 — Learning & Productivity | Notes, tasks, AI learning-task generation, unified search |
| 5 — Advanced | PR review, playground, growth reports, what-if simulator |

이 표는 구현된 phase 범위를 설명하며 현재 RC 릴리스 게이트를 의미하지 않습니다.

전체 설계: [기획서.md](./기획서.md)

## 라이선스

[MIT](./LICENSE)
