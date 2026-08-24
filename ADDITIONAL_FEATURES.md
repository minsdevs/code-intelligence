# Code Intelligence 추가 기능 로드맵

작성 기준일: 2026-08-24

> **현재 RC 상태 (2026-08-24):** 이 문서의 후보 설명과 실행 기록은 당시
> 의사결정·검증 이력을 보존한다. 현재 작업 기준은
> `rc/feature-freeze-20260824`의 staged RC이며, P0/P1 구현은 기능 동결 상태다.
> 현행 사용자 실행·구성 안내는 [README.md](./README.md), 보안 경계는
> [SECURITY.md](./SECURITY.md), 기여 gate는 [CONTRIBUTING.md](./CONTRIBUTING.md)를
> 우선한다. 실제 브라우저 10단계 E2E와 승인된 정확도/오탐률 oracle은
> 미완료 release blocker다. P2 변경분 재분석과 사용자 데이터 백업·복원은
> 구현하지 않았다. 아래의 `main`/개별 agent/검증 환경 표기는 역사적 실행
> 기록이며 현재 branch 또는 release 승인을 뜻하지 않는다.

## 문서 목적과 결정 기준

이 문서는 아이디어 목록이 아니라 실제 구현 순서를 정하기 위한 프로젝트별 로드맵이다. 실제 코드와 현재 동작을 확인한 뒤 다음 기준으로 후보를 걸러냈다.

1. 이미 구현된 기능은 다시 제안하지 않는다.
2. 자주 겪는 문제를 해결하거나 잘못된 조작을 막는 기능을 먼저 만든다.
3. 프로젝트의 정체성을 흐리는 기능은 제외한다.
4. 기존 기능과 자연스럽게 연결되는 기능을 우선한다.
5. 구현 비용이 큰 기능은 실제 필요를 측정할 수 있을 때만 P2로 둔다.

- **P0**: 다음 개발 주기에 먼저 해야 하는 기능 또는 안전성 개선
- **P1**: P0 이후 실제 사용성을 크게 높이는 기능
- **P2**: 조건이 맞을 때만 만들거나 데이터 확인 후 결정할 기능

## 검증된 현재 범위

GitHub·로컬 폴더 가져오기, 안전한 로컬 전체 새로고침, Snapshot 비교, finding 판정, coverage/export/IDE 연결, AI 전송 미리보기·제외, 비동기 분석 진행·재시도·취소, 영역·기능·구조·흐름·코드·히스토리·영향 분석, 메모·작업·PR 리뷰·AI 질문이 구현되어 있다. 사용자별 AI 공급자·모델 설정, API 키 암호화·마스킹, 근거 검증도 이미 있으므로 새 기능으로 다시 제안하지 않는다. 다만 구현 완료는 release 승인과 같지 않으며, 위 RC blocker는 계속 남아 있다.

## 후보 판단

| 후보 | 판정 | 이유 |
| --- | --- | --- |
| 로컬 폴더 가져오기 | P0 채택 | GitHub 인증 없이 현재 작업물을 분석하고 다른 로컬 도구와 연결하는 기반이다. |
| 분석 신뢰도 표시 | P0 채택·범위 확대 | 개별 confidence만이 아니라 전체 분석 범위, 누락, 부분 실패를 보여 주도록 구체화한다. |
| 설치·초기 설정 개선 | P0 채택 | 여러 구성 요소를 직접 준비해야 하는 현재 진입 장벽이 크다. |
| IDE 바로 열기 | P1 채택 | 웹 IDE를 만들지 않고 분석에서 수정으로 자연스럽게 연결한다. |
| AI 외부 전송 범위 표시 | P1 채택 | 기존 보안 기능을 사용자가 확인하고 통제할 수 있게 한다. |
| 분석 결과 내보내기 | P1 채택 | 온보딩과 리뷰에서 현재 결과를 재사용할 수 있다. |
| 변경분 재분석 | P2 조건부 채택 | 효과는 크지만 관계 병합 위험이 있어 성능 측정 뒤 결정한다. |

현재 제품은 GitHub 저장소를 가져와 프로젝트 구조와 코드 흐름을 이해하는 데 필요한 화면을 폭넓게 제공한다. 다음 단계의 핵심은 기능 수를 늘리는 것이 아니라 **로컬 프로젝트 접근성**, **분석 결과의 신뢰도**, **설치와 첫 실행의 난이도**를 개선하는 것이다.

## 로컬 작업 폴더 가져오기

**분류**
P0

**종류**
신규

**현재 문제**
현재 가져오기 흐름은 GitHub 저장소와 GitHub 인증을 전제로 한다. 아직 원격 저장소에 올리지 않은 프로젝트, 사내 Git 서버 프로젝트, 수정 중인 로컬 작업 내용은 바로 분석하기 어렵다.

**추가/변경할 기능**
사용자가 허용한 로컬 루트 아래에서 프로젝트 폴더를 선택해 읽기 전용으로 분석한다. Git 저장소라면 브랜치와 커밋 정보를 함께 기록하고, 커밋되지 않은 변경이 있으면 “로컬 작업 상태”라고 표시한다. 허용된 루트 밖의 경로, 심볼릭 링크로 빠져나가는 경로, 시스템·비밀 폴더는 차단한다.

**사용 예시**
사용자가 아직 GitHub에 올리지 않은 과제 폴더를 선택한다. Code Intelligence가 현재 파일을 분석하고 기능, 구조, 흐름을 보여 준다.

**왜 필요한가**
코드 이해 도구를 쓰기 위해 먼저 원격 저장소와 토큰을 준비해야 하는 불필요한 장벽을 없앤다. dev-cockpit이 발견한 프로젝트와 연결하려면 로컬 경로 입력도 필요하다.

**현재 기능과 연결**
기존 Project, Snapshot, 분석 Job과 결과 화면을 그대로 사용하고, GitHub 복제 단계만 “로컬 폴더 읽기” 방식으로 추가한다.

**구현 난이도**
높음

**예상 효과**
매우 높음

**채택 이유**
지원 가능한 프로젝트 범위를 가장 크게 넓히고, 다른 두 도구와 연결할 기반도 만든다. 단, 로컬 파일 접근 경계 검증을 함께 구현해야 하므로 P0 안에서도 충분한 보안 검토가 필요하다.

**상태:** ✅ 완료

구현 결과: `POST /api/projects/local` API 엔드포인트 추가. `LocalImportService`가 경로 검증(시스템/비밀 폴더 차단, 심볼릭 링크 탈출 방지, 허용된 로컬 루트 강제)과 파일 복사를 담당. `LocalImportProperties`로 `app.local-import.allowed-roots` 설정 지원(미설정 시 사용자 홈 디렉터리를 기본 허용 루트로 사용). Git 저장소이면 브랜치·커밋 SHA 기록, 커밋되지 않은 변경 감지. `ImportStep`이 `source_type=LOCAL`인 프로젝트를 자동 분기. DB 마이그레이션 V18 추가(`local_path`, `source_type` 컬럼). 프론트엔드 `createLocalProject` API 함수 추가. `/import?path=<encoded>` URL 라우트: `ImportWizardPage`가 `useSearchParams`로 `?path=` 파라미터를 읽어 `LocalImportConfirm` 컴포넌트에서 경로를 표시·확인받은 후에만 `POST /api/projects/local` 호출 (자동 import 없음, 사용자 확인 필수). backend allowed-root 오류는 error alert로 그대로 표시.

검증:
```
cd backend && ./gradlew compileJava             # BUILD SUCCESSFUL
cd backend && ./gradlew test --tests "*.LocalImportServiceTest"  # 10 tests passed
cd backend && ./gradlew test --tests "*.ArchitectureTest"        # 3 tests passed
cd frontend && npx tsc --noEmit                 # pass
cd frontend && npx vitest run                   # 54 tests passed
cd frontend && npx vite build                   # build successful
```

## 분석 범위·누락·부분 실패 보고서

**분류**
P0

**종류**
기존 개선

**현재 문제**
분석 작업의 단계별 성공 여부와 개별 결과의 신뢰도는 볼 수 있지만, 프로젝트 전체에서 무엇을 읽었고 무엇을 놓쳤는지 한눈에 판단하기 어렵다. 결과가 적을 때 실제로 기능이 적은 것인지, 지원하지 않는 언어·분석기 실패·파일 제외 때문인지 구분하기 어렵다.

**추가/변경할 기능**
분석 완료 화면에 다음을 표시한다.

- 발견한 파일 수와 실제 분석한 파일 수
- 언어별 분석 성공·건너뜀·실패 수
- 제외된 폴더와 제외 이유
- 분석기별 상태와 실패 원인
- 기능·흐름·관계 결과가 부분 결과인지 여부
- 다시 분석하면 해결될 항목과 현재 지원하지 않는 항목

**사용 예시**
분석 결과에 흐름이 한 개만 나온 경우, 사용자는 “Python 분석기가 꺼져서 40개 파일이 건너뛰어짐”을 확인하고 설정을 고친 뒤 다시 분석한다.

**왜 필요한가**
코드 분석 결과는 많아 보이는 것보다 믿을 수 있는지가 더 중요하다. 누락 이유를 모르면 잘못된 결과를 완전한 분석으로 오해할 수 있다.

**현재 기능과 연결**
기존 Job Step, 파일 목록, 분석기 응답, Snapshot과 개별 confidence 정보를 프로젝트 단위 요약으로 묶는다.

**구현 난이도**
보통

**예상 효과**
매우 높음

**채택 이유**
현재 분석 기능 전체의 신뢰도를 한 번에 높이는 개선이다. 새로운 분석 알고리즘을 추가하는 것보다 우선 가치가 크다.

**상태:** ✅ 완료

구현 결과: `GET /api/projects/{projectId}/coverage` API 엔드포인트 추가. 파일 범위(발견/분석/건너뜀), 언어별 분석 현황, 제외 폴더, 분석기별 상태(활성/비활성/실패), 부분 결과 여부, 재시도 가능 항목, 미지원 항목을 JSON으로 반환. `CoverageService.getReport()`가 프로젝트 소유권 확인과 스냅샷 조회를 담당(아키텍처 규칙 준수: Controller→Service→Repository). 프론트엔드 AnalysisPage에 CoveragePanel 컴포넌트 추가.

검증:
```
cd backend && ./gradlew compileJava             # BUILD SUCCESSFUL
cd backend && ./gradlew test --tests "*.CoverageServiceTest"  # 3 tests passed
cd backend && ./gradlew test --tests "*.ArchitectureTest"     # 3 tests passed
cd frontend && npx tsc --noEmit                 # pass (0 errors)
cd frontend && npx vitest run                   # 52 tests passed
```

## 한 번에 실행하는 로컬 시작 도구와 사전 점검

**분류**
P0

**종류**
기존 개선

**현재 문제**
데이터베이스, Redis, 분석기, 백엔드, 프런트엔드를 각각 준비해야 해 첫 실행이 어렵다. 환경 변수나 포트가 잘못되면 사용자는 어느 구성 요소가 문제인지 찾기 어렵고, 인증 전 화면에서 단순한 Unauthorized 오류를 만날 수 있다.

**추가/변경할 기능**
개발·로컬 사용용 단일 시작 명령을 제공한다. 시작 전에 필수 환경 변수, Docker, Java·Node 버전, 포트 충돌, 데이터베이스·Redis·분석기 연결을 확인한다. 실패하면 해결 명령까지 보여 주고, 브라우저에서는 인증되지 않은 사용자를 연결 화면으로 안내한다.

**사용 예시**
사용자가 `./start-local` 한 번만 실행한다. 8080번 포트가 이미 사용 중이면 시작 전에 사용 프로세스와 변경 방법을 보여 주고 나머지 구성 요소는 실행하지 않는다.

**왜 필요한가**
기능이 많아도 설치와 재실행이 번거로우면 일상 도구가 되기 어렵다. 특히 초보자는 구성 요소 이름보다 “무엇을 고쳐야 하는지”가 필요하다.

**현재 기능과 연결**
기존 Docker Compose 서비스, 백엔드 상태 확인, 분석기 상태와 프런트엔드 환경 설정을 하나의 시작 흐름으로 묶는다.

**구현 난이도**
보통

**예상 효과**
매우 높음

**채택 이유**
현재 구현된 모든 기능의 진입 장벽을 낮춘다. 새 분석 기능 하나보다 실제 사용 빈도에 더 큰 영향을 준다.

**상태:** ✅ 완료

구현 결과: `./start-local` (단일 시작), `./stop-local` (종료), `./check-local` (사전 점검 전용) 세 스크립트 추가. 점검 항목: .env/TOKEN_ENC_KEY, Docker 데몬, Java 21+, Node.js 18+, 포트 충돌(8080/5432/6379/5173). 실패 시 해결 명령 표시, 모든 점검 통과 시에만 서비스 시작. Ctrl+C로 전체 종료.

검증:
```
bash -n start-local && bash -n stop-local && bash -n check-local  # 문법 검사 통과
./check-local   # Java 26 ✅, Node.js 26 ✅, .env ✅, TOKEN_ENC_KEY ✅, ports ✅
                # Docker 미실행만 FAIL (외부 조건)
```

## IDE에서 해당 코드 바로 열기

**분류**
P1

**종류**
신규

**현재 문제**
분석 결과에서 파일과 줄 번호를 찾을 수 있지만, 실제 수정은 IDE에서 해야 한다. 사용자가 파일 경로와 줄 번호를 다시 찾아야 한다.

**추가/변경할 기능**
코드 위치, 흐름 단계, 분석 근거 옆에 “IDE에서 열기”를 추가한다. VS Code, Cursor, IntelliJ 계열 중 사용자가 선택한 앱을 열고 정확한 파일과 줄로 이동한다. 로컬 작업 폴더와 분석 스냅샷의 커밋이 다르면 경고한다.

**사용 예시**
영향 분석에서 `PaymentService` 84번째 줄을 확인한 뒤 “Cursor에서 열기”를 눌러 바로 수정한다.

**왜 필요한가**
Code Intelligence는 코드를 이해하는 도구로 남으면서도 실제 수정 작업까지 이어지는 마지막 수동 단계를 줄일 수 있다.

**현재 기능과 연결**
기존 파일·줄 근거와 코드 탐색 위치를 사용한다. 로컬 폴더 가져오기에서 만든 경로 연결 정보를 재사용한다.

**구현 난이도**
보통

**예상 효과**
높음

**채택 이유**
구현 범위가 비교적 작고 분석에서 수정으로 넘어가는 흐름을 크게 단축한다. 웹 IDE를 만드는 것보다 목적에 잘 맞는다.

**상태:** ✅ 완료

구현 결과: `POST /api/projects/{projectId}/ide/open` API 엔드포인트 추가. `IdeOpenService`가 VS Code/Cursor/IntelliJ/WebStorm URI 생성, 상대 경로 검증(traversal 차단, project root 탈출 방지), snapshot commit과 현재 HEAD 불일치 경고를 담당. LOCAL source_type 프로젝트만 지원(GITHUB은 400 반환). `IdeOpenController`가 사용자 인증과 요청 전달. 프론트엔드 `OpenInIdeButton` 컴포넌트 추가(IDE 선택 드롭다운, commit mismatch 경고 표시).

검증:
```
cd backend && ./gradlew compileJava             # BUILD SUCCESSFUL
cd backend && ./gradlew test --tests "*.IdeOpenServiceTest"    # 8 tests passed
cd backend && ./gradlew test --tests "*.ArchitectureTest"      # 3 tests passed
cd frontend && npx tsc --noEmit                 # pass (0 errors)
cd frontend && npx vitest run                   # 52 tests passed
```

## AI 전송 범위·예상 비용 미리보기

**분류**
P1

**종류**
기존 개선

**현재 문제**
사용자별 AI 공급자와 모델, API 키 보호, 근거 검증은 구현되어 있다. 하지만 질문을 보내기 직전에 어떤 파일·근거가 외부 AI로 전달되는지와 예상 토큰·비용을 사용자가 확인하기 어렵다.

**추가/변경할 기능**
AI 전송 전에 선택된 파일·코드 구간·메모·분석 근거, 마스킹된 항목, 예상 입력·출력 토큰과 대략적인 비용을 보여 준다. 사용자가 특정 근거를 제외하거나 “이번 질문은 로컬 데이터만 사용”을 선택할 수 있게 한다.

**사용 예시**
사내 프로젝트에 질문하기 전에 `.env`는 제외되었고 세 개 소스 파일의 일부만 전송된다는 내용을 확인한 뒤 요청을 승인한다.

**왜 필요한가**
AI 기능에서 중요한 것은 기능 추가보다 사용자가 외부 전송 범위를 이해하고 통제하는 것이다. 비용이 큰 모델을 실수로 반복 호출하는 것도 막는다.

**현재 기능과 연결**
기존 Context Retrieval, Secret Mask, Evidence Validation, AI 사용량 기록과 모델 설정을 요청 전 확인 화면으로 연결한다.

**구현 난이도**
보통

**예상 효과**
높음

**채택 이유**
이미 갖춘 보안 기능을 사용자가 체감할 수 있게 만들며, 신뢰와 비용 통제를 동시에 개선한다.

**상태:** ✅ 완료

구현 결과: `POST /api/projects/{projectId}/ai/preview` API 엔드포인트 추가. `AiPreviewService`가 실제 `ContextRetrievalService.retrieveStructured()`와 동일한 경로를 재사용하여 외부 요청 없이(local-only) 전송 범위를 미리 보여줌. 항목별 타입/레이블/크기/마스킹 여부, 토큰·비용 추정(OpenAI/Gemini별), 마스킹된 비밀 수, 파일 참조 목록 반환. 각 context item에 deterministic ID(type:sha256(content)[:12]) 부여 — 동일 입력이면 순서 변경·재호출에도 같은 ID 반환. 프론트엔드 AiPanel에 👁 Preview 버튼 추가 — 클릭 시 context items(ID 포함), 토큰/비용 추정, 마스킹 수 렌더링. "Local data only" 체크박스 활성화 시 외부 AI API 호출을 프론트엔드에서 완전 차단(테스트 증명). 개별 context item 제외 UI 제공(체크박스) → 제외 선택이 `excludedContextIds` 필드로 ask 요청에 전달됨. 백엔드 `AssistantController.AskBody`에 optional `excludedContextIds` 필드 추가(기존 호환 유지). `ContextRetrievalService.retrieveWithExclusions()`가 해당 ID의 블록을 서버사이드에서 필터링하여 provider payload에 절대 포함시키지 않음. `AssistantServiceExclusionTest` unit test가 Docker 없이 ArgumentCaptor로 (1) excluded ID가 ContextRetrievalService에 정확히 전달되고 (2) AIProvider.chat()에 전달된 prompt에 제외된 content가 없으며 포함된 content는 있음을 증명. `AiExclusionIntegrationTest`는 Testcontainers(Docker 필요) 기반 end-to-end 보완 테스트로, Docker 미가용 환경에서는 실행 불가.

검증:
```
cd backend && ./gradlew compileJava compileTestJava  # BUILD SUCCESSFUL
cd backend && ./gradlew test --tests "*.AssistantServiceExclusionTest"  # 4 tests passed (Docker 불필요)
cd backend && ./gradlew test --tests "*.AiPreviewServiceTest"  # 6 tests passed
cd backend && ./gradlew test --tests "*.ArchitectureTest"      # 3 tests passed
cd frontend && npx tsc --noEmit                 # pass (0 errors)
cd frontend && npx vitest run                   # 54 tests passed (including exclusion propagation test)
cd frontend && npx vite build                   # build successful
```

## 공유 가능한 분석 요약 내보내기

**분류**
P1

**종류**
신규

**현재 문제**
구조, 기능, 흐름, 주요 발견을 화면에서 각각 볼 수 있지만 팀원에게 프로젝트 전체 요약을 전달하려면 사용자가 직접 다시 정리해야 한다.

**추가/변경할 기능**
현재 스냅샷의 분석 날짜·커밋, 주요 영역, 핵심 기능, 대표 흐름, 위험 발견, 분석 범위와 근거 링크를 Markdown 또는 JSON으로 내보낸다. 비밀값과 전체 소스 코드는 포함하지 않고, 항목별 원본 화면 링크를 넣는다.

**사용 예시**
새 팀원에게 “결제 프로젝트 이해 요약.md”를 전달해 먼저 큰 구조를 읽게 하고, 자세한 근거는 Code Intelligence에서 열게 한다.

**왜 필요한가**
분석 결과가 제품 안에서만 보이면 온보딩, 리뷰, 인수인계에 재사용하기 어렵다.

**현재 기능과 연결**
기존 Architecture, Features, Flows, Findings, Growth와 새 분석 범위 보고서를 한 문서로 조합한다.

**구현 난이도**
보통

**예상 효과**
높음

**채택 이유**
새 분석 엔진 없이 현재 결과의 활용 범위를 넓힐 수 있다. 전체 소스 내보내기가 아니라 요약과 근거 링크에 제한한다.

**상태:** ✅ 완료

구현 결과: `GET /api/projects/{projectId}/export?format=markdown|json` API 엔드포인트 추가. `ExportService`(export 패키지)가 스냅샷 날짜·commit·영역·기능·흐름·위험 발견·coverage를 Markdown 또는 JSON으로 조합. 모든 텍스트에 `SecretMask.redact()` 적용, 소스 코드 미포함, `Content-Disposition: attachment` 강제. 내부 링크(`/projects/{id}/features/{id}`) 포함. 프론트엔드 `ExportButton` 컴포넌트(Markdown/JSON 선택 드롭다운) 추가, authenticated fetch + blob download 구현.

검증:
```
cd backend && ./gradlew compileJava             # BUILD SUCCESSFUL
cd backend && ./gradlew test --tests "*.ExportServiceTest"     # 6 tests passed
cd backend && ./gradlew test --tests "*.ArchitectureTest"      # 3 tests passed
cd frontend && npx tsc --noEmit                 # pass (0 errors)
cd frontend && npx vitest run                   # 52 tests passed
```

## 변경된 부분만 다시 분석

**분류**
P2

**종류**
기존 개선

**현재 문제**
작은 수정 뒤에도 전체 분석을 다시 수행하면 큰 프로젝트에서 시간이 오래 걸리고 분석기 자원을 반복 사용한다.

**추가/변경할 기능**
이전 스냅샷과 현재 Git 상태의 차이를 계산해 변경 파일과 영향을 받는 주변 관계만 다시 분석한다. 결과를 합치는 동안 이전 완성 스냅샷은 계속 보여 주고, 실패하면 새 스냅샷을 게시하지 않는다.

**사용 예시**
컨트롤러 두 파일만 수정한 뒤 빠른 재분석을 실행해 관련 흐름과 영향 분석만 갱신한다.

**왜 필요한가**
분석 대기 시간이 실제로 길어지는 대형 프로젝트에서는 재사용 빈도를 크게 높일 수 있다.

**현재 기능과 연결**
기존 Snapshot, Git 변경 정보, 분석 Job과 그래프 관계를 활용한다.

**구현 난이도**
높음

**예상 효과**
높음

**채택 이유**
효과는 크지만 오래된 관계를 잘못 남기는 위험이 있다. 먼저 전체 분석 시간과 변경 규모를 측정한 뒤, 대형 프로젝트에서 기준 시간을 넘을 때만 구현한다.

**상태:** ⏸ 보류
사유: (1) 전체 분석 시간 임계값·변경 규모 기준이 코드·설정 어디에도 정의되어 있지 않음 — `AnalysisProperties`에 `maxFiles`, `featureMergeThreshold`만 존재하고, 분석 소요 시간 기준(예: "N초 초과 시 incremental")은 미구현. (2) `GraphPersistenceService.persist()`가 단일 스냅샷 단위로 전체 upsert하는 구조이므로, 이전 스냅샷 관계를 선택적으로 재사용·병합하는 로직이 없고, 부분 병합 시 stale edge 잔류 위험에 대한 검증 토대(비교 테스트·golden 데이터)도 부재. (3) 대형 프로젝트(1만+ 파일) 분석 시간 실측 데이터 없음 — 테스트 fixture는 소규모(spring-mini, react-mini 등)로 성능 병목 재현 불가.

## Code Intelligence에서 만들지 않을 기능

- **브라우저 안의 전체 IDE·터미널·빌드 실행기**: 기존 IDE보다 부족한 복제품이 되기 쉽고, 코드 이해 도구의 범위를 크게 벗어난다.
- **AI가 승인 없이 코드를 자동 수정하고 배포하는 기능**: 현재의 분석·근거 확인 목적과 맞지 않고 로컬 파일 및 배포 권한 위험이 커진다.
- **일반적인 팀 채팅·이슈 관리**: GitHub와 기존 협업 도구로 충분하다. 분석 결과 링크와 내보내기만 제공하는 편이 낫다.
- **근거 없는 AI 코드 검색을 별도 추가**: 현재 검색, 그래프, 근거 기반 AI 질문과 겹친다. 정확도와 분석 범위 표시를 먼저 개선해야 한다.

---

# 프로젝트 내부 구현 순서

1. **분석 범위·누락·부분 실패 보고서**: 현재 결과를 믿을 수 있는지 먼저 판단하게 한다.
2. **한 번에 실행하는 로컬 시작 도구와 사전 점검**: 이미 구현된 기능의 진입 장벽을 낮춘다.
3. **로컬 작업 폴더 가져오기**: 지원 범위를 넓히고 로컬 경로 기반 기능의 토대를 만든다.
4. **IDE에서 해당 코드 바로 열기**: 로컬 경로를 이용해 분석에서 수정으로 연결한다.
5. **AI 전송 범위·예상 비용 미리보기**: 외부 전송과 비용을 사용자가 통제하게 한다.
6. **공유 가능한 분석 요약 내보내기**: 분석 결과를 팀에서 재사용하게 한다.
7. **변경된 부분만 다시 분석**: 대형 프로젝트의 실제 분석 시간이 기준을 넘을 때만 진행한다.

# 최종 우선순위 표

| 순위 | 기능 | 우선순위 | 난이도 | 효과 | 추천 여부 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 분석 범위·누락·부분 실패 보고서 | P0 | 보통 | 매우 높음 | 추천 |
| 2 | 한 번에 실행하는 로컬 시작 도구와 사전 점검 | P0 | 보통 | 매우 높음 | 추천 |
| 3 | 로컬 작업 폴더 가져오기 | P0 | 높음 | 매우 높음 | 추천 |
| 4 | IDE에서 해당 코드 바로 열기 | P1 | 보통 | 높음 | 추천 |
| 5 | AI 전송 범위·예상 비용 미리보기 | P1 | 보통 | 높음 | 추천 |
| 6 | 공유 가능한 분석 요약 내보내기 | P1 | 보통 | 높음 | 추천 |
| 7 | 변경된 부분만 다시 분석 | P2 | 높음 | 높음 | 성능 측정 후 결정 |

## 결론

새 분석 화면을 더 늘리기보다 분석 결과의 신뢰도와 실행 접근성을 먼저 개선해야 한다. 그 다음 로컬 프로젝트와 IDE를 연결하고, AI 투명성과 결과 재사용을 높이는 순서가 적절하다. 브라우저 IDE나 자동 코드 수정·배포 기능은 만들지 않는다.

---

# 구현 이후 다음 단계 로드맵 (2026-08-24 재점검)

## 기존 단계 종료 판정

기존 P0·P1 항목은 실제 API, 화면, 보안 검증과 테스트로 연결되어 있다. 변경분 재분석은 구현 실패가 아니라 측정 기준과 안전한 병합 근거가 없어 의도적으로 보류된 상태다. 다음 기능을 시작하기 전에 현재 작업 트리를 하나의 검증 가능한 기준선으로 고정해야 한다.

현재 재검증 결과:

- 로컬 가져오기, coverage, IDE 열기, AI 미리보기·제외, export 관련 backend 집중 테스트 성공
- backend ArchitectureTest 성공
- frontend 19개 파일, 54개 테스트 성공
- frontend typecheck 성공
- Docker가 필요한 전체 통합 흐름과 실제 브라우저 E2E는 별도 검증 필요

## 기능 개발 전 선행 과정

1. Docker를 포함한 전체 로컬 환경에서 `로컬 가져오기 → 분석 → coverage → AI 제외 전송 → export → 재분석` 흐름을 한 번에 검증한다.
2. 작은 fixture가 아닌 실제 규모가 다른 저장소를 최소 세 종류 골라 분석 시간, 메모리, 누락, 오탐을 기록한다.
3. 현재 DB를 보존한 재시작, 빈 DB의 첫 설치, 프로젝트 삭제 후 clone·snapshot 정리를 각각 확인한다.
4. 위 결과를 릴리스 기준선으로 저장한 뒤에만 다음 P0 기능을 시작한다.

## 로컬 소스 최신 상태 표시와 안전한 새로고침

**분류**
P0

**종류**
기존 개선

**현재 문제**
로컬 프로젝트를 다시 분석하면 현재 폴더를 새 snapshot으로 가져오지만, 분석 화면을 열었을 때 디스크의 코드가 마지막 snapshot보다 바뀌었는지 먼저 알 수 없다. 사용자는 오래된 분석 결과를 최신 결과로 오해할 수 있다.

**추가/변경할 기능**
프로젝트 카드와 workspace 상단에 `최신`, `변경됨`, `경로 없음`, `권한 재확인 필요` 상태를 표시한다. Git 프로젝트는 HEAD와 working tree 상태를, 비 Git 프로젝트는 제한된 파일 메타데이터 지문을 비교한다. 새로고침 전에 추가·수정·삭제 파일 수와 예상 전체 분석 여부를 보여 주고 사용자가 승인해야 재분석한다. 상시 파일 감시는 기본값으로 사용하지 않는다.

**사용 예시**
어제 분석한 로컬 API 프로젝트를 열었을 때 “12개 파일 변경됨”을 확인하고, 변경 목록을 미리 본 뒤 새 분석을 시작한다.

**왜 필요한가**
로컬 폴더 가져오기가 생긴 뒤 가장 먼저 발생하는 신뢰 문제는 분석 결과와 현재 코드의 시간 차이다.

**현재 기능과 연결**
기존 `local_path`, Snapshot commit, dirty 상태 감지, reanalyze Job과 allowed-root 검증을 재사용한다.

**완료 조건**
경로가 이동했거나 권한 범위를 벗어난 경우 자동 접근하지 않고 재승인을 요구해야 한다. 상태 확인은 소스 내용을 DB에 추가 저장하지 않아야 하며, 변경이 없는 프로젝트에는 재분석을 권하지 않아야 한다.

**구현 난이도**
보통

**예상 효과**
매우 높음

**채택 이유**
새 분석 기능보다 현재 결과가 최신인지 알려 주는 것이 사용자 판단에 더 직접적인 영향을 준다.

## 분석 Snapshot 비교와 변경 요약

**분류**
P0

**종류**
신규

**현재 문제**
Git 커밋의 파일 diff는 볼 수 있지만, 두 분석 snapshot 사이에 기능·흐름·구조·finding이 어떻게 달라졌는지는 볼 수 없다. 재분석 결과가 좋아졌는지 나빠졌는지 판단하기 어렵다.

**추가/변경할 기능**
두 snapshot을 선택해 다음 변화를 비교한다.

- 추가·삭제·변경된 기능과 흐름
- 새로 생기거나 해결된 finding
- 주요 구조 노드와 관계 변화
- coverage와 분석기 상태 변화
- 결과 수가 급감하거나 신뢰도가 낮아진 회귀 경고

비교는 표시 이름이 아니라 기존 natural key와 근거를 우선 사용하고, 이름 변경은 가능하면 삭제·추가가 아닌 rename 후보로 표시한다.

**사용 예시**
리팩터링 전후 snapshot을 비교해 API 흐름 두 개가 사라진 것이 실제 삭제인지 분석 누락인지 coverage와 함께 확인한다.

**왜 필요한가**
재분석의 가치는 새 결과를 만드는 데서 끝나지 않고 무엇이 달라졌는지 설명할 때 생긴다.

**현재 기능과 연결**
기존 Snapshot 보존, Features, Flows, Architecture, Findings, Coverage와 Git commit 정보를 읽기 전용 비교 서비스로 묶는다.

**완료 조건**
동일 snapshot 비교는 빈 변경으로 나와야 하고, 재실행해도 순서와 결과가 같아야 한다. 비교 생성 실패가 현재 snapshot을 바꾸거나 삭제해서는 안 된다.

**구현 난이도**
높음

**예상 효과**
매우 높음

**채택 이유**
현재 축적되는 snapshot을 사용자가 실제 의사결정에 활용하게 만드는 가장 중요한 다음 기능이다.

## Finding 판정·숨김·재검토 흐름

**분류**
P1

**종류**
기존 개선

**현재 문제**
finding과 근거는 볼 수 있지만 사용자가 `확인 필요`, `수용`, `오탐`, `해결됨`으로 판정하거나 같은 오탐을 다음 snapshot에서 계속 숨길 수 없다.

**추가/변경할 기능**
finding에 판정 상태, 짧은 사유, 판정자, 시각을 기록한다. 오탐 숨김은 rule ID와 안정적인 대상 key를 기준으로 다음 snapshot에 적용하되, 근거 또는 rule 버전이 달라지면 자동으로 `재검토 필요`로 되돌린다. 기본 목록에서는 숨겨도 필터로 언제든 복원할 수 있게 한다.

**사용 예시**
의도적으로 외부에서 호출되는 orphan route를 오탐으로 표시한다. 다음 분석에서 같은 근거면 숨김이 유지되고, route 경로가 바뀌면 다시 검토 대상으로 나타난다.

**왜 필요한가**
분석 결과를 반복 사용할수록 오탐을 매번 다시 판단하는 비용이 커진다. 사용자 판정은 실제 분석 품질을 측정할 데이터이기도 하다.

**현재 기능과 연결**
기존 Finding natural key, evidence, task draft, Notes와 Snapshot을 연결한다.

**완료 조건**
원본 finding 데이터는 수정하지 않고 별도 사용자 판정으로 보존해야 한다. 사용자별 권한이 분리되어야 하며, 모든 숨김은 되돌릴 수 있어야 한다.

**구현 난이도**
보통

**예상 효과**
높음

**채택 이유**
새 rule을 늘리지 않고도 기존 결과의 실용성과 평가 가능성을 높인다.

## 실제 저장소 분석 품질·성능 회귀 게이트

**분류**
P1

**종류**
기존 개선

**현재 문제**
mini fixture와 golden test는 풍부하지만 대형·다중 언어 저장소에서 정확도와 성능이 이전 버전보다 나빠졌는지 자동으로 판단하는 기준은 부족하다. 변경분 재분석을 안전하게 결정할 실측 자료도 없다.

**추가/변경할 기능**
크기와 언어 구성이 다른 재현 가능한 평가 corpus를 만들고 분석 시간·최대 메모리·coverage·기대 기능/흐름 검출률·사용자 판정 오탐률·비정상 결과 급감을 버전별로 비교한다. private 저장소의 소스나 결과는 외부로 업로드하지 않고, CI에는 공개·합성 fixture와 집계 수치만 사용한다.

**사용 예시**
분석기 변경 PR에서 흐름 검출 수가 기준선보다 30% 감소하면 테스트는 통과했더라도 품질 회귀로 차단한다.

**왜 필요한가**
분석 도구는 화면이 정상 렌더링되는 것만으로 품질을 증명할 수 없다. 이 자료가 있어야 변경분 분석의 구현 여부도 합리적으로 결정할 수 있다.

**현재 기능과 연결**
기존 golden test, Coverage report, Job 시간, Snapshot 비교와 Finding 판정 데이터를 평가 입력으로 사용한다.

**완료 조건**
기준선 갱신은 명시적 승인 없이는 불가능해야 한다. 성능과 정확도 임계값을 분리하고, 단순 결과 개수만으로 성공을 판단하지 않아야 한다.

**구현 난이도**
높음

**예상 효과**
높음

**채택 이유**
다음 분석 기능을 빠르게 추가하는 것보다 기존 분석이 퇴행하지 않도록 만드는 단계가 먼저다.

## 사용자 데이터 백업과 복원

**분류**
P2

**종류**
신규

**현재 문제**
분석 요약은 내보낼 수 있지만 Notes, Tasks, finding 판정, 프로젝트 연결 설정을 새 설치로 복원할 수는 없다.

**추가/변경할 기능**
사용자별 메타데이터를 버전이 있는 백업 파일로 내보내고 복원 전 변경 내용을 미리 보여 준다. 소스 clone, 원문 코드, AI API key와 암호화 키는 기본 백업에서 제외한다. 프로젝트는 local path 또는 remote URL로 다시 연결하고 충돌 항목은 사용자가 선택한다.

**사용 예시**
Mac을 교체한 뒤 백업을 가져와 프로젝트 목록과 Notes·Tasks를 복원하고, 로컬 경로만 새 위치에 다시 연결한다.

**왜 필요한가**
분석 결과보다 사용자가 직접 작성한 메모와 판정은 다시 만들기 어렵다.

**현재 기능과 연결**
기존 project export와 Project, Notes, Tasks, Finding 판정 저장소를 별도의 복원 가능한 형식으로 확장한다.

**완료 조건**
복원은 dry-run과 취소를 지원해야 하며, API key를 평문으로 포함해서는 안 된다. 더 높은 schema 버전의 백업은 안전하게 거부해야 한다.

**구현 난이도**
높음

**예상 효과**
보통

**채택 이유**
장기 사용에는 필요하지만 snapshot 비교와 결과 신뢰성보다 먼저 만들 기능은 아니다.

## 다음 단계에서 만들지 않을 기능

- **상시 파일 감시 후 자동 전체 분석**: 저장 중인 불완전한 코드로 분석이 반복되고 CPU 사용과 snapshot 잡음이 커진다.
- **분석 정확도 측정 전에 언어를 계속 추가하는 것**: 지원 개수보다 기존 언어의 누락과 오탐을 먼저 수치화해야 한다.
- **사용자가 분석 그래프 원본을 직접 수정하는 기능**: 실제 코드 근거와 사용자 의견이 섞여 결과 신뢰도가 떨어진다. 판정·메모를 별도 계층으로 둔다.
- **백업을 명목으로 API key와 소스 clone을 통째로 내보내는 기능**: 복구 편의보다 유출 위험이 크다.

## 다음 단계 구현 순서

1. 전체 로컬 E2E와 실제 저장소 기준선 측정
2. 로컬 소스 최신 상태 표시와 안전한 새로고침
3. 분석 Snapshot 비교와 변경 요약
4. Finding 판정·숨김·재검토 흐름
5. 실제 저장소 분석 품질·성능 회귀 게이트
6. 측정 결과가 기준을 넘을 때만 기존 변경분 재분석 재검토
7. 사용자 데이터 백업과 복원

| 순위 | 기능 | 우선순위 | 난이도 | 효과 | 추천 여부 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 로컬 소스 최신 상태 표시와 안전한 새로고침 | P0 | 보통 | 매우 높음 | 추천 |
| 2 | 분석 Snapshot 비교와 변경 요약 | P0 | 높음 | 매우 높음 | 추천 |
| 3 | Finding 판정·숨김·재검토 흐름 | P1 | 보통 | 높음 | 추천 |
| 4 | 실제 저장소 분석 품질·성능 회귀 게이트 | P1 | 높음 | 높음 | 추천 |
| 5 | 사용자 데이터 백업과 복원 | P2 | 높음 | 보통 | 장기 사용 전 추천 |

---

# 구현 실행 기록 (2026-08-24 Agent A)

## 선행 과정과 기준선 상태

**상태:** ⚠️ 비 Docker 기준선만 완료, 전체 로컬 E2E 외부 제약으로 미완료

- 최초 `git status --short`에서 기존 P0/P1 구현 관련 수정 19개와 다수 untracked 파일을 확인했으며 reset/checkout/clean/commit/push/PR 없이 그대로 보존·확장했다.
- 저장소 내부와 중첩 경로에 `AGENTS.md`는 없었다. 이 문서 전체와 `# 구현 이후 다음 단계 로드맵` 이후 범위를 읽고 그 확정 항목만 구현했다.
- `./check-local` 실측: `.env`, `TOKEN_ENC_KEY`, Java 26, Node.js 26, 8080/5432/6379/5173 포트는 통과. Docker CLI는 있으나 daemon이 실행 중이지 않아 실패했다.
- 따라서 PostgreSQL·Redis·sidecar를 포함한 `로컬 가져오기 → 분석 → coverage → AI 제외 전송 → export → 재분석`, 현재 DB 보존 재시작, 빈 DB 첫 설치, 프로젝트 삭제 후 clone/snapshot 정리는 실행하지 못했다. 이를 성공으로 간주하지 않는다.
- 재현 corpus 실측: `backend/src/test/resources/fixtures` 54개 파일(fullstack-mini 25, spring-mini 13, react-mini 10, infra-mini 6), 주요 구성 Java 16, TSX 12, YAML 6, SQL/JSON/Gradle 각 4. 실제 규모가 다른 저장소 3종의 DB 기반 분석 시간·RSS·누락·오탐 실측은 Docker 부재로 확보하지 못했다.

## P0 — 로컬 소스 최신 상태 표시와 안전한 새로고침

**상태:** ✅ 구현 및 비 Docker 검증 완료 / ⚠️ 전체 pipeline·브라우저 검증 남음

**실제 구현 결과**

- `GET /api/projects/{projectId}/local-source-status`가 현재 로컬 파일과 마지막 snapshot의 `files.content_hash`를 Git blob hash 기준으로 비교해 `UP_TO_DATE`, `CHANGED`, `PATH_MISSING`, `REAUTHORIZATION_REQUIRED`, `NO_SNAPSHOT`을 반환한다.
- 변경 파일을 A/M/D 경로와 추가·수정·삭제 개수로 미리 보여 주며, 변경이 있을 때만 전체 재분석을 제안한다. 상시 파일 감시는 추가하지 않았다.
- 로컬 재분석은 snapshot ID와 A/M/D 개수를 승인 payload로 받아 서버에서 즉시 다시 계산한다. 미리보기 이후 변경되었거나 변경이 없거나 경로가 안전하지 않으면 HTTP 409로 enqueue 전에 거부한다. GitHub 프로젝트의 기존 재분석 호환은 유지한다.
- 프로젝트 카드와 workspace 상단에 최신/변경됨/경로 없음/권한 재확인 필요 상태, 변경 목록, 명시적 재분석 버튼을 연결했다.
- 기존 local copy가 `.git`을 제외해 inventory analyzer가 읽지 못하고 삭제 파일을 clone에 남길 수 있던 문제를 함께 수정했다. allowed-root 아래 staging에 완전 복사하고 Git snapshot commit을 만든 뒤 target을 교체하므로 삭제 파일이 남지 않는다.

**주요 변경 파일**

- `backend/.../project/LocalImportService.java`, `LocalSourceStatusService.java`, `LocalRefreshConflictException.java`
- `backend/.../project/ProjectController.java`, `ProjectService.java`, `ProjectResponse.java`
- `frontend/src/features/projects/LocalSourceStatus.tsx`, `HomePage.tsx`, `ProjectWorkspacePage.tsx`
- `frontend/src/api/projects.ts`, `types.ts`

**보안 처리**

- 기존 allowed-root, realpath, 시스템·비밀 디렉터리 차단을 유지했고 오류 응답에 allowed-root 실제 목록을 노출하지 않는다.
- source/target symlink는 따라가지 않고, target과 staging은 data repos root 밖으로 나갈 수 없다.
- 상태 지문은 분석 대상 파일의 hash만 메모리에서 계산하며 원문 코드를 DB에 추가 저장하지 않는다. binary, max-file-size, max-files 기준은 inventory와 맞췄다.
- 사용자 소유권 검증 후에만 상태 조회·재분석 승인이 가능하다.

**실행 테스트/결과**

- `LocalImportServiceTest`, `LocalSourceStatusServiceTest` 포함 집중 backend 테스트 통과.
- local smoke 범위에서 폴더 가져오기 → stale 파일 삭제 → Git snapshot HEAD 생성 → `FileInventoryScanner`가 새 파일 inventory 생성까지 통과.
- frontend 프로젝트 카드 상태 테스트 및 전체 57개 테스트 통과.

**남은 외부 검증**

- Docker 환경의 실제 API import/job/finalize/reanalyze와 브라우저에서 승인 modal·진행 상태를 검증해야 한다.

## P0 — 분석 Snapshot 비교와 변경 요약

**상태:** ✅ 구현 및 비 Docker 검증 완료 / ⚠️ PostgreSQL 통합 검증 남음

**실제 구현 결과**

- `GET /api/projects/{projectId}/snapshots`와 `/snapshots/compare?baseSnapshotId=&targetSnapshotId=`를 추가했다.
- 기능은 feature key와 연결 natural key, 흐름은 kind/name과 단계 natural key, finding은 category/대상 key/근거, 구조는 graph natural key와 source-edge-target key를 우선해 추가·삭제·변경을 결정적으로 비교한다.
- feature 연결 natural key가 동일한 삭제/추가 쌍은 rename candidate로 별도 표시한다.
- snapshot별 coverage와 analyzer job 상태를 비교하고 기능·흐름·구조 노드가 30% 넘게 급감하거나 target이 partial이면 회귀 경고를 표시한다.
- 동일 snapshot 비교는 빈 변경을 반환한다. 서비스는 read-only이고 비교 실패 경로에서 project.current_snapshot_id나 snapshot 데이터를 갱신·삭제하지 않는다. 기존 `FinalizeStep`의 transaction promotion 불변식도 유지한다.
- Analysis 화면에 snapshot 선택, 기능·흐름·finding·node·relationship A/M/D, coverage 변화, rename 후보와 회귀 경고를 연결했다.

**주요 변경 파일**

- `backend/src/main/java/dev/codeintelligence/analysis/compare/*`
- `backend/.../analysis/coverage/CoverageService.java`
- `frontend/src/features/analysis/SnapshotComparisonPanel.tsx`
- `frontend/src/api/snapshots.ts`, `types.ts`

**보안 처리**

- 두 snapshot 모두 요청 사용자가 소유한 동일 프로젝트에 속하는지 검증한다.
- 비교 API는 source 원문을 반환하지 않고 key, 이름, 개수, coverage만 반환한다.

**실행 테스트/결과**

- `SnapshotComparisonServiceTest`: 동일 snapshot 빈 결과·재실행 결정성·사용자 소유권 분리 통과.
- frontend 비교 UI 테스트에서 category 변화, coverage, 회귀 경고 렌더링 통과.
- `ArchitectureTest` 3개 통과.

**남은 외부 검증**

- V18/V19가 적용된 실제 PostgreSQL에서 서로 다른 두 snapshot의 SQL aggregate 결과와 대형 graph 응답 시간을 확인해야 한다.

## P1 — Finding 판정·숨김·재검토 흐름

**상태:** ✅ 구현 및 비 Docker 검증 완료 / ⚠️ DB migration 통합 검증 남음

**실제 구현 결과**

- V19 `finding_judgments`를 추가해 원본 `analysis_findings`와 사용자 판정을 분리했다. 판정 상태는 `NEEDS_REVIEW`, `ACCEPTED`, `FALSE_POSITIVE`, `RESOLVED`이며 짧은 사유, 판정 사용자, 시각, rule ID/version, evidence fingerprint를 저장한다.
- stable target key로 다음 snapshot의 동일 finding에 판정을 적용하되 rule version 또는 정렬된 근거 fingerprint가 달라지면 자동 `NEEDS_REVIEW`로 표시하고 다시 노출한다.
- 기본 목록은 유효한 `FALSE_POSITIVE`만 숨기며 `includeHidden=true` 필터와 UI checkbox로 언제든 복원한다. 복원 후 다른 판정으로 변경할 수 있다.
- `PUT /api/projects/{projectId}/findings/{findingId}/judgment`와 Analysis 화면의 판정/사유 UI를 끝까지 연결했다.

**주요 변경 파일**

- `backend/src/main/resources/db/migration/V19__finding_judgments.sql`
- `backend/.../analysis/finding/FindingService.java`, `FindingController.java`, `InvalidFindingJudgmentException.java`
- `frontend/src/features/analysis/FindingJudgmentEditor.tsx`, `AnalysisPage.tsx`
- `frontend/src/api/analysis.ts`, `types.ts`

**보안 처리**

- 판정 unique key에 `user_id`, `project_id`를 함께 사용하고 모든 조회·쓰기 전에 프로젝트 소유권을 검증한다.
- 원본 finding status/detail/evidence를 수정하지 않는다. 사유는 500자로 제한한다.

**실행 테스트/결과**

- `FindingServiceJudgmentTest`: 잘못된 상태, 500자 초과 사유, 타 사용자 접근 차단 통과.
- frontend에서 오탐 PUT 전달과 숨긴 오탐 재표시 query 테스트 통과.

**남은 외부 검증**

- 실제 PostgreSQL에서 V19 migrate, snapshot 간 판정 승계, rule/evidence 변경 재검토 SQL 흐름을 검증해야 한다.

## P1 — 실제 저장소 분석 품질·성능 회귀 게이트

**상태:** ✅ 게이트 구현·스크립트 문법 및 실패 안전성 검증 완료 / ⚠️ Docker 기반 기준선 실행 미완료

**실제 구현 결과**

- `./quality-gate`와 versioned `quality-baseline.env`를 추가했다. 4종 corpus 최소 파일 수, backend golden 정확도 테스트, backend elapsed/RSS 임계값, 두 analyzer test/typecheck/build를 분리 검증한다.
- `QUALITY_BASELINE_UPDATE`를 통한 자동 갱신을 거부하며 기준선은 명시적인 파일 변경과 검토로만 바뀐다.
- CI backend job에 품질·성능 gate를 연결했다. private source/result를 업로드하거나 외부 전송하지 않는다.

**주요 변경 파일**

- `quality-gate`, `quality-baseline.env`, `.github/workflows/ci.yml`

**보안 처리**

- 공개·합성 fixture와 집계 시간/RSS만 사용한다. private 저장소, source 원문, API key를 외부로 보내지 않는다.

**실행 테스트/결과**

- `bash -n quality-gate` 통과.
- 현재 실행은 `[FAIL] Docker daemon is required for the database-backed quality corpus`로 의도대로 실패했으며 이를 gate 성공으로 표시하지 않는다.
- corpus 파일 수는 54로 `MIN_CORPUS_FILES=25` 조건을 충족했다. 실제 backend 시간/RSS 기준선은 Docker 부재로 측정되지 않았다.
- tree-analyzer: 7 tests, typecheck, build 통과. ts-analyzer: 8 tests, typecheck, build 통과.

**남은 외부 검증**

- Docker가 실행되는 동일 호스트/CI에서 golden corpus의 300초/2GiB 기준 통과 여부를 기록하고, 실제 규모 3종 저장소의 별도 승인 기준선을 추가해야 한다.

## P2 — 변경분 재분석 재검토

**상태:** ⏸ 보류 유지

**실측 보류 근거**

- Docker 부재로 실제 규모 3종의 전체 분석 시간, peak RSS, 변경 비율, stale relationship 위험을 측정하지 못했다.
- 현재 재현 corpus는 54개 파일의 mini fixture뿐이며 대형 저장소 채택 판단 자료로 사용할 수 없다.
- `quality-gate`는 향후 측정 수단을 제공하지만 이번 실행에서 backend 시간/RSS 기준선을 만들지 못했다.
- 따라서 변경 파일과 영향 관계만 병합하는 구현은 시작하지 않았다. 현재 재분석 전 A/M/D 표시는 구현했지만 재분석 자체는 안전한 전체 분석만 수행한다.

## P2 — 사용자 데이터 백업과 복원

**상태:** ⏸ 보류

**보류 근거**

- 문서 순서상 snapshot 비교·판정·품질 기준선의 Docker 통합 검증과 장기 사용 필요 측정이 먼저이며 이번 환경에서 완료되지 않았다.
- API key·암호화 키·source clone·원문 코드를 제외한 schema, dry-run, conflict preview, 상위 schema 거부를 모두 검증할 DB 환경이 없어 빈 API/TODO로 만들지 않았다.

## 최종 검증 누적

- backend `./gradlew spotlessCheck`: 통과.
- backend 집중 24 tests(`LocalImportService`, `LocalSourceStatusService`, `SnapshotComparisonService`, `FindingServiceJudgment`, `ArchitectureTest`): 통과.
- backend `./gradlew spotlessCheck build`: assemble/compile/spotless 통과 후 전체 308 tests 중 Docker/Testcontainers context 105개 실패. root cause는 `DockerClientProviderStrategy`; 구현 결함 성공으로 간주하지 않음.
- frontend `npm run lint`: 통과.
- frontend `npm run typecheck`: 통과.
- frontend `npm test -- --run`: 19 files, 57 tests 통과.
- frontend `npm run build`: 통과. Monaco/worker chunk size warning은 남음.
- tree-analyzer: 7 tests + typecheck + build 통과.
- ts-analyzer: 8 tests + typecheck + build 통과.
- `git diff --check`: 통과.
- 실제 브라우저 E2E: Browser 도구/세션 부재로 미실행. 성공으로 간주하지 않음.
- commit, push, PR은 수행하지 않았다.

---

# 기능 동결 및 릴리스 후보 단계 (다음 작업)

## 결정

현재 P0·P1 기능 구현은 종료한다. Docker 전체 pipeline, DB migration, 브라우저 E2E와 실제 저장소 기준선이 통과하기 전에는 신규 기능, 분석 언어, 자동 감시, 변경분 재분석과 백업·복원을 추가하지 않는다. 독립 코드 감사 통과는 실제 런타임 검증을 대신하지 않는다.

## 1. 현재 변경 보존과 검토 가능한 기준선 만들기

- 현재 작업 트리를 전용 release-candidate 브랜치에 보존한다.
- 로컬 가져오기·새로고침, Snapshot 비교, Finding 판정, 품질 gate를 검토 가능한 기능 단위 커밋으로 나눈다.
- 커밋 전 untracked migration·test·script·frontend 파일이 빠지지 않았는지 확인한다.
- 각 커밋에서 secret, 로컬 절대 경로, 실제 사용자 데이터와 생성물이 포함되지 않았는지 확인한다.
- push와 PR은 전체 release gate 통과 뒤에만 수행한다.

## 2. Docker 전체 Pipeline 검증

- 기존 사용자 volume을 삭제하거나 재사용하지 않고 별도의 Compose project와 임시 volume을 사용한다.
- PostgreSQL, Redis, tree analyzer, TS analyzer, backend, frontend를 실제 설정으로 시작한다.
- 전체 backend 308 tests에서 Testcontainers 의존 테스트까지 모두 통과시킨다.
- `quality-gate`의 backend 시간·RSS 기준선을 실제 Docker 환경에서 기록한다.
- 테스트 종료 후 임시 container·network·volume만 정리하고 기존 데이터는 건드리지 않는다.

## 3. DB Migration 검증

- 빈 DB에서 최초 migration부터 V19까지 적용한다.
- V17 상태의 별도 fixture DB를 V18·V19로 순차 upgrade한다.
- 기존 Project, Snapshot, Note, Task, AI 설정을 보존하는지 확인한다.
- Snapshot 판정 승계와 rule/evidence 변경 시 재검토가 실제 PostgreSQL에서 동작하는지 확인한다.
- 실패 migration이 발생하면 복구 방법과 데이터 영향 범위를 기록한다.

## 4. 실제 브라우저 E2E

다음 흐름을 브라우저에서 순서대로 검증한다.

1. 인증과 로컬 프로젝트 경로 확인
2. 로컬 가져오기와 분석 완료
3. 코드 변경 후 stale 및 A/M/D preview
4. 안전한 전체 새로고침
5. 두 Snapshot의 기능·흐름·구조·Finding·Coverage 비교
6. Finding 오탐 숨김·복원·재검토
7. AI context preview와 항목 제외
8. Markdown·JSON export
9. IDE 열기
10. 프로젝트 삭제와 clone·snapshot 정리

브라우저 console error, 실패 network 요청, raw Unauthorized 화면과 깨진 empty/loading/error 상태가 없어야 한다.

## 5. 실제 저장소 품질·성능 기준선

- 작은 단일 언어, 중간 규모 full-stack, 대형 다중 언어 저장소 세 종류를 사용한다.
- 파일 수, 분석 시간, peak RSS, Coverage, 기능·흐름·Finding 수와 확인된 오탐을 기록한다.
- 결과 급감과 메모리·시간 초과를 release 차단 조건으로 만든다.
- private source와 분석 원문을 CI artifact나 외부 서버에 업로드하지 않는다.
- 이 결과가 있어야 변경분 재분석을 다시 검토할 수 있다.

## 6. 세 프로젝트 통합 Smoke Test

- dev-cockpit에서 프로젝트를 Code Intelligence로 연다.
- `/import?path=`에서 자동 import하지 않고 사용자 확인을 요구하는지 확인한다.
- 코드 변경 후 stale 표시, 새로고침과 Snapshot 비교까지 검증한다.
- dev-finder가 연 파일과 Code Intelligence의 파일·줄 위치가 같은 로컬 프로젝트를 가리키는지 확인한다.

## 릴리스 승인 기준

- 전체 backend·frontend·analyzer gate 통과
- V18·V19 fresh/upgrade migration 통과
- 실제 브라우저 E2E 통과
- 실제 저장소 세 종류 기준선 통과
- 기존 DB와 사용자 데이터 복구 경로 확인
- 중대한 보안·권한·경로 오류 0건

하나라도 충족하지 못하면 상태는 **내부 테스트 가능 / 프로덕션 배포 보류**로 유지한다.

## 기능 재개 조건

- **변경분 재분석**: 대형 저장소 전체 분석이 반복적으로 허용 시간을 넘고 Snapshot 관계 병합 회귀 테스트가 준비된 경우
- **사용자 데이터 백업·복원**: 실제 DB migration과 장기 사용 중 Notes·Tasks 복구 필요가 확인된 경우
- 그 전에는 신규 기능보다 발견된 회귀와 설치·복구 문제만 수정한다.


## RC 실제 검증 기록 (2026-08-24 Agent RC)

### 기준선과 격리

- 저장소 내부에 `AGENTS.md`가 존재하지 않았다(`glob **/AGENTS.md` 결과 0개). 따라서 읽을 수 없는 이유를 명시하고 `ADDITIONAL_FEATURES.md` 전체 및 이 RC 섹션만 기준으로 작업했다.
- 시작 기준선: branch `main`, `HEAD 0a547c0f704fb66d66f07822995320eb6e0cad75`, upstream `origin/main`, ahead/behind `+0/-0`. 다수의 기존 tracked/untracked 변경은 사용자 작업으로 간주해 reset, checkout, stash, clean, 삭제 없이 보존했다.
- 도구: Docker 29.6.2 / Compose v5.3.1 / Java host 26.0.2(Gradle toolchain Java 21.0.12) / Node 26.5.0 / npm 11.17.0 / Python 3.14.6. 호스트 `psql`, `redis-cli`는 없어서 격리 컨테이너 내부 client를 사용했다.
- Docker Desktop daemon을 시작한 뒤 기존 컨테이너·volume·network를 읽기 전용으로 inventory했다. 검증 project는 `ci-rc-20260824-155318`, host ports는 PostgreSQL 55432, Redis 56379, TS analyzer 53040, tree analyzer 53041을 사용했다. volume `ci-rc-20260824-155318_postgres-data`와 project network만 만들었다.
- 실제 명령 예시:
  ```bash
  docker compose -p ci-rc-20260824-155318 \
    -f /tmp/codeintel-rc-20260824-155318/compose.yml up -d
  docker compose -p ci-rc-20260824-155318 \
    -f /tmp/codeintel-rc-20260824-155318/compose.yml down -v --remove-orphans
  ```
- 종료 시 위 project의 container 4개, network 1개, volume 1개가 모두 제거된 것을 확인했다. 기존 `code-intelligence_postgres-data`, `code-intelligence_default`, 기존 중지 container 4개는 그대로 남았다. 외부로 source, 결과, credential을 전송하지 않았다.

### Backend·frontend·analyzer gate

- 최초 실제 전체 실행:
  ```bash
  cd backend
  ./gradlew --no-daemon --console=plain --rerun-tasks \
    test spotlessCheck compileJava compileTestJava assemble
  ```
  결과는 문서의 308개가 아니라 당시 현재 소스 기준 309 tests였다. `301 pass / 8 fail / 0 skip`. 8개 모두 `ProjectJobApiIntegrationTest`였고 원문 공통 오류는 `step 'LOCAL_IMPORT' failed: project has no local path configured`; SSE는 `Expected size: 16 but was: 17`이었다.
- 실제 결함 1 수정: pipeline에 등록하지 않는다는 주석과 달리 `LocalImportStep`에 `@Component`가 있어 모든 GitHub job의 마지막 step으로 등록되었다. 기존 `ImportStep`이 LOCAL/GITHUB 분기를 이미 처리하므로 `LocalImportStep`의 bean 등록만 제거했다. targeted `ProjectJobApiIntegrationTest`는 `13/13 pass`.
- 실제 결함 2 수정: macOS에서 source는 `/tmp`를 `/private/tmp`로 canonicalize하지만 configured allowed root는 lexical `/tmp`로 비교해 합법 경로를 거부했다. allowed root도 `toRealPath()`로 canonicalize하고 해석 실패는 권한을 주지 않는 fail-closed 처리로 수정했다. symlink allowed-root 회귀 테스트를 추가했고 `LocalImportServiceTest` 전체가 통과했다.
- 최종 전체 실행은 추가된 회귀 테스트를 포함해 `310 pass / 0 fail / 0 error / 0 skip`, XML suite 72개였다. `spotlessCheck`, `compileJava`, `compileTestJava`, `assemble` 모두 `BUILD SUCCESSFUL`.
- 실행 중 Gradle stderr에 `Did not receive connection preamble within 10s` 경고가 반복됐지만 Testcontainers PostgreSQL/Redis가 실제 기동됐고 최종 test/build에는 fail/skip이 없었다. 향후 Gradle/JDK 조합의 worker handshake 경고 원인은 별도 관찰 대상이다.
- 최종 품질 gate:
  ```bash
  ./quality-gate
  ```
  `PASS`, corpus 54 files, backend 23s(기준 300s), max RSS 127,616KB(기준 2,097,152KB). TS analyzer `8/8`, tree analyzer `7/7`; 각 typecheck/build 통과.
- frontend:
  ```bash
  cd frontend
  npm run lint
  npm run typecheck
  npm test -- --run
  npm run build
  ```
  lint/typecheck/build 통과, `19 files / 57 tests pass / 0 fail / 0 skip`. Monaco/worker chunk 500kB 초과와 IIFE name 경고는 남았으나 build 실패는 아니다.

### 실제 Compose·fresh install·upgrade migration

- 격리 Compose에서 PostgreSQL/Redis는 Docker health `healthy`, 두 analyzer는 `/health` HTTP 200 `{"status":"ok"}`. backend를 같은 격리 dependency에 연결했을 때 `/actuator/health` HTTP 200 `UP`.
- 빈 `codeintel_rc` DB: Flyway가 `Successfully validated 19 migrations`, V1부터 V19까지 `Successfully applied 19 migrations ... now at version v19`. `flyway_schema_history` 19행 모두 `success=true`; `projects.local_path`, `projects.source_type`, `finding_judgments` 존재 확인.
- 별도 `codeintel_upgrade` DB: 실제 backend를 `--spring.flyway.target=17`로 실행해 17/17 migration을 만든 뒤 V17 schema에 User, Project, Snapshot, Note, Task, AI setting, Finding/evidence sentinel을 삽입했다. 일반 backend 재실행에서 원문 순서는 `Current version ... 17` → `18 - local folder import` → `19 - finding judgments` → `now at version v19`였다.
- V19 후 sentinel은 user 1, project 1(`source_type=GITHUB`, `local_path=NULL`), original snapshot 1, note 1, task 1, AI setting 1, finding 1로 모두 보존됐다. 재시작 후 schema V19 up-to-date, 두 snapshot, judgment 1 및 모든 sentinel 보존을 재확인했다.
- 임시 test source를 Gradle init script로만 주입해 실제 V19 PostgreSQL의 `FindingService`를 호출했다. 동일 stable key/evidence의 다음 snapshot에는 `FALSE_POSITIVE`와 hidden 상태가 승계됐고, `rule_version` 또는 evidence가 바뀌면 `NEEDS_REVIEW`, hidden=false로 복귀했다(`1 pass / 0 fail`). 저장소에는 검증용 test를 추가하지 않았다.
- 재현 핵심:
  ```bash
  # fresh
  DB_URL=jdbc:postgresql://127.0.0.1:55432/codeintel_rc \
  DB_USERNAME=codeintel_rc DB_PASSWORD='<temporary-password>' \
  TOKEN_ENC_KEY='<base64-32-byte-key>' REDIS_HOST=127.0.0.1 REDIS_PORT=56379 \
  java -jar backend/build/libs/backend-0.0.1-SNAPSHOT.jar

  # V17 fixture schema
  # 같은 환경에서 별도 빈 DB를 지정하고 다음 인자를 추가
  java -jar backend/build/libs/backend-0.0.1-SNAPSHOT.jar \
    --spring.flyway.target=17 --spring.jpa.hibernate.ddl-auto=none
  # V17 sentinel 삽입 후 target 인자 없이 재시작해 V18→V19 적용
  ```

### 실제 로컬 pipeline·stale refresh·Snapshot 비교

- 외부 clone 없이 현재 로컬 공개 코드만 임시 Git corpus로 복사했다. secret/generated 경로(`.env`, `.git`, `.idea`, `.freebuff`, node_modules, dist, build, `.gradle`)는 제외했다.
- 실제 `ProjectService.createFromLocal` → 비동기 전체 job → Coverage/feature/flow/finding/graph 집계를 실행했다. 시간은 project enqueue부터 DONE/집계까지, RSS는 Gradle launcher와 descendant JVM process tree를 200ms 간격으로 합산한 관측 peak다. analyzer 수치는 각 실행 직후 Docker RSS이며 analyzer peak는 아니다.

| corpus | source files | discovered/analyzed | elapsed | JVM process-tree peak RSS | feature/flow/finding | graph node/edge | partial/skip | 판정 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| small `tree-analyzer` | 14 | 14/14 | 1.370s | 1,406,560KB | 0/0/0 | 15/21 | false, 0/0/0 | 시간·RSS 통과, 정확도 oracle 없음 |
| medium `frontend` | 130 | 130/130 | 4.044s | 1,066,432KB | 8/3/8 | 247/377 | false, 0/0/0 | 시간·RSS 통과, 정확도 수동 검토 필요 |
| large current repository | 651(복사본), 646 분석 대상 | 646/646 | 45.972s | 1,541,760KB | 11/92/11 | 6,826/33,479 | false, 0/0/0 | 시간·RSS 통과, 정확도 수동 검토 필요 |

- analyzer 실행 직후 RSS: TS 약 191.6MiB → 289.8MiB → 339.1MiB, tree 약 212.1~212.2MiB. 세 분석 모두 300s 및 JVM 2GiB 참고 기준 안이지만 이 기준은 기존 golden gate용이며 실제 저장소 승인 임계값으로 공식 채택된 값은 아니다.
- 대표 결과는 frontend feature에 `router`, `sidebar`, `aipanel`, large flow에 실제 backend `GET/DELETE /api/...`가 포함됐다. 다만 frontend/large finding 대부분이 `ORPHAN_ROUTE`, feature에 `*.test` 이름도 포함돼 있어 사람의 true/false-positive 판정 없이 정확도 통과로 간주하지 않는다. 승인된 expected oracle/오탐률 기준이 없어 **정확도 release gate는 미완료**다.
- small corpus 파일 1개 추가 후 실제 서버 서비스로 stale preview를 확인했다: `CHANGED`, `A src/rc-change.ts`, added=1. preview count를 승인 payload로 넘겨 전체 reanalysis DONE, snapshot `1→4`, discovered files `14→15`, snapshot compare warning 0. 기능/흐름/finding 변화는 0이었다.
- 대형 분석 45.972s로 현재 300s 참고 한도를 넘지 않았고 관계 선택 병합 회귀 oracle도 없다. 따라서 변경분 재분석은 구현하지 않고 보류를 유지한다. 백업·복원도 장기 사용 필요와 복원 schema 승인 근거가 없으므로 구현하지 않았다.

### 브라우저·외부 통합 검증과 최종 판정

- 실제 full stack 비브라우저 smoke: backend+Vite+격리 DB/Redis/analyzer를 실행해 backend health 200 UP, frontend `/` 200(`Code Intelligence`), `/import?path=...` 200, frontend proxy `/api/auth/me` 200(`authenticated:false`)를 확인했다.
- **실제 브라우저 E2E는 미실행/미통과**. 이 세션에는 `browser_*`/Playwright 도구가 제공되지 않아 import 확인 UI, finding 숨김·복원, AI preview/exclusion, export, IDE open, console error, network failure, loading/empty/error state를 실제 브라우저로 조작·판정할 수 없었다. 재현: Browser Mode를 활성화하고 backend 8080/frontend 5173 및 격리 dependency를 기동한 뒤 RC 4번의 10단계를 순서대로 수행한다.
- dev-cockpit/dev-finder 통합 smoke는 “이 저장소와 검증 임시 디렉터리만 다룬다”는 범위 제한 때문에 다른 project를 읽거나 실행하지 않았다. 사람이 세 저장소를 함께 기동해 `/import?path=` 확인, stale/refresh/compare, 동일 파일·line 연결을 검증해야 한다.
- 기존 DB의 migration 보존은 검증했지만 실제 사용자 백업 생성→복원→복구 훈련은 기능 자체가 보류라 실행하지 못했다.
- 판정: **로컬 내부 테스트 가능**, backend/frontend/analyzer 및 migration gate는 통과. 그러나 실제 브라우저 E2E, 실제 저장소 정확도 oracle/오탐률 승인, 세 프로젝트 통합 smoke, 사용자 백업·복구 경로가 미완료이므로 **RC 승인 및 프로덕션 배포 보류**.
- 최종 `git diff --check`는 통과했다. 이번에 수정한 Java source/test의 untracked whitespace check도 clean이었다. `ADDITIONAL_FEATURES.md` 전체를 `/dev/null`과 비교하면 기존 본문의 Markdown hard-break용 trailing spaces가 보고되지만 이번 RC 추가 93줄에는 새 trailing whitespace가 없다.
- dirty worktree가 기존 사용자 변경과 이번 결함 수정 및 roadmap 기록을 함께 포함하고 소유권을 완전히 분리할 수 없어 branch 생성과 commit을 하지 않았다. 최종 branch/HEAD는 `main` / `0a547c0f704fb66d66f07822995320eb6e0cad75`, upstream 대비 local commit 0개다. push, PR, 배포도 수행하지 않았다.
- 검증 종료 후 전용 Docker resource뿐 아니라 full-stack smoke가 남긴 backend/Vite child PID도 정확한 PID로 종료했다. 55432/56379/53040/53041/58080~58083/8080/5173 validation port에 listener가 없음을 재확인했다.

## 세 프로젝트 통합 Smoke 직접 실행 (2026-08-24, main agent)

- 격리 fixture의 canonical project path는 `/private/tmp/kiro-cross-rc-20260824/root/cross-web`였다. clean-installed dev-finder가 이 절대 경로에서 `src/main.ts:1`의 `kiro-cross-project-marker`를 찾았고, dev-cockpit이 같은 경로를 3개 발견 프로젝트 중 정확히 선택했다.
- dev-cockpit의 실제 Tauri `AppHandle` 기반 임시 harness가 저장소 library API를 호출했다. preset preflight, 소유 process group 실행, health-ready, `http://127.0.0.1:43991/` open과 실제 브라우저 `GET /`, stop 및 listener 정리가 통과했다. Android fixture는 Android Studio, iOS fixture는 `Cross.xcworkspace` 우선 Xcode로 실제 `open` 성공했으며 mobile localhost 후보는 0개였다.
- 기존 Docker volume을 생성·재사용·삭제하지 않도록 PostgreSQL data는 tmpfs를 사용했다. 고유 Compose project `ci-cross-20260824-01`에서 PostgreSQL, Redis, TS/tree analyzer가 모두 healthy인 동안 임시 JUnit source를 Gradle init script로만 주입했다.
- `CrossProjectIntegrationValidationTest`: **1 test / 1 pass / 0 fail / 0 skip**, 6.225s. 같은 canonical path import 후 DB `projects.local_path`와 `files.path='src/main.ts'`를 확인했다. `src/main.ts` 수정 preview 뒤 `src/after-preview.ts`를 추가해 오래된 snapshot+A/M/D 승인 payload가 `LocalRefreshConflictException`으로 거부되는 것을 확인했다. 새 preview `added=1, modified=1`로 안전한 전체 재분석을 실행해 snapshot `1→2`, discovered files `3→4`, comparison warning 0을 확인했다.
- refresh 뒤 clean-installed dev-finder `--changed --project <same-absolute-path>`가 `src/main.ts=unstaged`, `src/after-preview.ts=untracked`를 같은 repo path로 반환했다.
- 종료 확인: 통합 Compose container 0, network 0, named volume 0, validation listener 0. 기존 Docker resource와 사용자 데이터는 건드리지 않았다.
- 직접 실행 명령의 핵심은 `./gradlew --no-daemon --console=plain -I /private/tmp/kiro-cross-rc-20260824/codeintel.init.gradle test --tests dev.codeintelligence.project.CrossProjectIntegrationValidationTest`였다. Gradle의 기존 connection-preamble 경고는 재현됐지만 JUnit XML은 `tests=1, failures=0, errors=0, skipped=0`였고 `BUILD SUCCESSFUL`이었다.
- 이 통합 smoke는 service/library API와 실제 외부 `open` 동작을 검증한 것이며 Code Intelligence 화면을 클릭한 브라우저 E2E는 아니다. 인증·import 확인 화면·finding UI·AI preview/export/IDE 버튼·console/network 상태를 포함한 실제 브라우저 10단계 gate는 계속 **미검증/RC 차단**이다.
