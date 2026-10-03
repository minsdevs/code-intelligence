사용자 Mac의 Code Intelligence 작업을 이어서 감사·수정·검증해 주세요. 아래는 이전 도구가 현재 수정 묶음만 마감하고 남긴 인계입니다. 과거 계획보다 실제 현재 코드를 기준으로 판단하고, 안전하고 범위가 명확한 수정을 구현하세요. 대규모 구조 전환이나 운영·라이선스 선택은 근거와 선택지를 먼저 제시하세요.

1. 목표와 작업 위치

- 저장소: `/Users/minseokchae/Dev/code-intelligence`
- 확인된 branch: `codex/e2e-docs-scripts`
- 확인된 HEAD: `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`
- 대량의 기존 미커밋·미추적 변경이 있습니다. 여러 이전 작업의 결과가 섞여 있으므로 전체 diff를 이번 작업의 변경으로 간주하지 마세요. 최신 변경을 덮어쓰거나 원복하지 말고, 시작 시 상태와 수정 대상 파일의 내용을 다시 확인하세요. 같은 파일을 수정 중인 다른 작업이 있으면 충돌을 피하세요.
- 경로에 접근할 수 없다면 정확한 차단점을 보고하고 다른 저장소를 추측하지 마세요.
- 제품 목표는 개발 도구 설치 없이 앱만 설치·실행하고, 로그인 없이 로컬 폴더를 선택하거나 GitHub 인증으로 권한 있는 저장소를 가져와, 직관적 마인드맵·화면→API→서비스→데이터 흐름·변경 영향·원본 소스 근거를 탐색하는 도구입니다. 주요 대상은 NestJS/TypeScript와 React/TypeScript이며 Mac 지원을 유지하면서 Windows도 지원해야 합니다.
- 현재 구현은 Electron main/preload, loopback Java/Spring Boot backend, PostgreSQL 16/pgvector, Redis, NestJS/TypeScript analyzer, React/Vite UI입니다. 이전에 언급된 다른 스택을 사실로 가정하거나 전면 재작성하지 마세요.

2. 먼저 읽을 지침과 문서

저장소와 상위 경로의 AGENTS.md, 관련 .agents/skills, 실행·테스트 지침을 다시 확인하세요. 이전 확인 때 적용할 로컬 AGENTS.md/SKILL.md는 발견되지 않았지만 현재 상태를 우선하세요. Mac의 memory_summary.md가 필요하면 역사적 참고로만 사용하세요.

우선 읽을 파일은 다음과 같습니다. 아래 경로는 저장소 기준입니다.

- `docs/audit/session-closeout-2026-10-03.md`: 최신 마감 범위, 미해결 항목, 출시 판정.
- `docs/audit/session-closeout-validation-2026-10-03.json`: 현재 수정·검증 source hash, 결과, artifact hash, 보존 상태.
- `docs/audit/ts-parsing-live-app-2026-10-03.md`: 사용자 실사용 TS_PARSING 실패의 원인과 이번 수정.
- `validation/parser-flow-integration/README.md`: 제한된 합성 HTTP/DB/SSE 시험 방법과 정리 규칙.
- `docs/audit/windows-readiness-2026-10-03.md`: 이전 Windows 경로·환경·차단된 packaging 준비와 미완료 native 기준.
- `docs/audit/app-launch-handoff-2026-10-03.md`: 구앱과 현재 소스, live 상태의 구분.
- `docs/audit/parser-http-db-sse-2026-10-03.md`, `parser-http-windows-validation-2026-10-03.json`: 이전 함수 호출 수정·14개 통합 점검의 역사적 증거.
- `docs/audit/restart-recovery-audit-2026-10-03.md`: 큰 감사 이력, 남은 공통 blocker, 위험 guardian 시험의 증거 재사용 사고와 격리 경위. 이전 전체 test 수치를 현재 candidate가 통과한 것으로 복사하지 마세요.

동결된 `docs/multilanguage-plan-2026-10-02/**` 20개와 `docs/audit/execution-roadmap-2026-10-02.md` 1개는 수정하지 마세요. 사용자 추가 Windows 요청은 유효하며, 이 동결 문서가 Windows 작업을 거부하는 근거는 아닙니다. 변경된 결정은 별도 후속 문서에 기록하세요.

3. 현재 열어 둔 구앱과 수정 코드의 차이

- 별도 실행 담당이 `desktop/dist/mac-arm64/Code Intelligence.app`을 열었다고 부모 스레드가 보고했습니다. 보고 당시 서비스 4개 ready, 실제 DB는 V20입니다. 이전 감사가 그 DB에 직접 접속해 검증한 결과는 아닙니다.
- 읽기 전용 확인한 app.asar package version은 0.1.0, 수정 시각은 2026-09-29T07:37:29.345Z입니다. 지금 worktree의 10월 3일 수정과 V21–V25가 반영된 앱이 아닙니다.
- 실행 중 앱, 실제 DB, 점유 포트, Keychain, 설치 앱, `desktop/stage`와 `desktop/dist`를 변경·재시작·교체·migration하지 마세요. 최신 코드를 이 구앱에 부분 복사하지 마세요.
- 현재 main은 userData와 credential 저장소를 사용합니다. 검증하지 않은 DATA_DIR/브라우저 플래그만으로 실제 데이터와 Keychain이 격리됐다고 가정하지 마세요. 기존 stage에는 최신 buildSequence/backupProtocol/ownershipProtocol이 없어 현재 main과 호환된다고 볼 수 없습니다.

4. 사용자 실사용 문제와 지금의 해결 상태

가. P0 TS_PARSING 실패: 현재 소스 수정과 제한 검증 완료, 구앱 미반영.

사용자는 구앱에서 Code Intelligence 폴더를 가져올 때 `step 'TS_PARSING' failed: ts-analyzer request failed`를 봤습니다. 허용된 로그의 원인 chain은 EndpointHit DTO 생성 중 NPE였습니다. 현재 소스에도 metadata의 `Map.copyOf`가 남아 있어 실제 analyzer가 unknown 타입으로 보낸 `responseType: null`/`returnType: null`을 거부했습니다. 단순 접속 실패나 구버전만의 문제로 분류하면 안 됩니다.

이번 변경:

- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsAnalyzeDtos.java`: EndpointHit/SemanticNodeHit/SemanticEdgeHit metadata의 최상위 null만 unknown 필드로 생략하고 불변 복사합니다. nested parameterTypes의 null 자리와 parameter.type null, null key/잘못된 배열 member 거부는 유지합니다.
- `backend/src/test/java/dev/codeintelligence/analysis/ts/TsAnalyzeDtosTest.java`: 5개 회귀.
- `backend/src/test/resources/fixtures/ts-nullable-metadata.json`: 실제 AnalyzeService에서 생성한 합성 Nest controller 입력·응답. 사용자 프로젝트 소스가 아닙니다.
- `validation/parser-flow-integration/prepare.mjs`, `ParserFlowIntegration.java`: 이 fixture의 실제 HTTP → graph 저장 → source evidence → job SSE 검증 추가.

검증은 수정 전 3 FAIL/2 PASS, 수정 후 5 PASS입니다. 새 snapshot에서 Java main 363개+runner 1개 컴파일, analyzer production 11개 strict compile, 새 임시 PG/Redis와 실제 Nest HTTP의 18개 assertion이 통과했습니다. V1–V25를 빈 DB에 적용한 시험이며 실제 V20 사용자 DB upgrade는 아닙니다. 합성 identity·사전 inventory를 사용하므로 production auth/CSRF/OAuth/로컬 import 승인/전체 Spring Boot bootstrap 시험도 아닙니다.

증거는 `/private/tmp/ci-null-metadata-1FM4uo/reports/`와 `/private/tmp/ci-parser-flow-mKGBI5/{prepared.json,reports/}`에 있습니다. 작은 결과와 SHA는 마감 validation JSON에도 있습니다. 해당 통합 실행의 Java는 exit 0, Nest는 close, PG/Redis 및 network는 소유권 확인 후 제거됐습니다. 임시 연결 비밀번호 파일도 제거했습니다. 오래된 임시 artifact가 사라졌다면 재검증 불가라고 표시하고 기존 증거를 재작성하지 마세요.

나. P1 버전 0.0.0: 원인 확인, 미수정.

`frontend/src/app/Sidebar.tsx:161`이 `v0.0.0`을 하드코딩하고 frontend package도 0.0.0입니다. desktop package와 구앱은 0.1.0입니다. `desktop/src/main.cjs:834` runtime config와 preload/typed bridge에는 app version이 없습니다. 권고는 실제 Electron `app.getVersion()`을 기존 신뢰 IPC→preload→타입 계약→UI로 전달하고 브라우저 개발 빌드의 fallback 출처도 명확히 하는 것입니다. 단순히 또 다른 문자열로 하드코딩하지 마세요. 구현·회귀 및 runtime/package/UI 일치 확인은 다음 작업입니다.

다. P1 창 크기·UI UX: 정적 위험 확인, 화면 재현·수정 미실행.

`desktop/src/main.cjs:881`은 1440×960, 최소 980×700입니다. sidebar는 240px, AI 패널 기본 340px/최대 560px, Flows list는 352px 고정입니다. 최소 창에서 detail 공간 부족 가능성이 있지만 실제 overflow를 브라우저로 재현한 상태는 아닙니다. AppLayout, AiPanel, FlowsPage, CodeExplorerPage와 project tabs를 조사하고, 실제 문제를 재현한 후 범위가 명확한 수정만 하세요. 크기별 가독성, 가로/세로 스크롤, 패널 열기·닫기·resize, 버튼 접근, 긴 이름, 키보드 조작, 진행·실패·재시도·소스 근거 이동을 확인하세요. 큰 UI 재설계는 별도 제품 선택입니다.

5. Mac과 Windows의 다음 순서 및 출시 차단점

현재 양 OS 모두 출시 No-Go입니다. 빌드 성공으로 바꾸지 마세요. 다음 순서는 공통 사용자 흐름/안전 문제 → Windows 구현과 독립 native bundle → 깨끗한 Mac 및 실제 Windows의 인수 시험입니다.

- 이전 묶음에서 `desktop/src/runtime-platform.cjs`와 main 연결로 Windows 경로 공격 입력 거부, native .exe 조회, OS 환경 allowlist, DLL PATH를 준비했고, x64 NSIS 사용자 단위/서명 필수 설정을 추가했습니다. Windows 준비 gate와 beforePack은 미완료 조건에서 실패하도록 닫혀 있습니다. 이전 Mac 모형 시험 28+2 PASS는 Windows 실기기 결과가 아닙니다.
- Windows 저장소/잠금은 NTFS ACL, reparse point, durable/atomic replace, open-handle/FileLock 계약과 소유 process handle/Job Object, DPAPI와 Keychain의 다른 보호 범위를 설계·검증해야 합니다. getuid/POSIX/O_NOFOLLOW 조건을 삭제하거나 평문 fallback으로 gate를 통과시키지 마세요.
- Redis는 desktop profile의 session/event 의존을 단일 backend에 맞게 분리하고 서버 profile은 유지하는 방향이 권고입니다. 대안은 Windows 호환 Redis runtime의 적법한 재배포입니다. 둘 다 구현·제품 선택이 완료되지 않았습니다. 실제 SecurityConfig/session/OAuth와 JobProgressPublisher/SSE의 계약부터 읽고 결정안을 제시하세요. 최종 사용자에게 WSL/Docker 설치를 요구하는 방식은 목표에 맞지 않습니다.
- OS별 JRE 21, PostgreSQL/pgvector/pg_trgm, 전이 라이브러리를 독립 공급해야 합니다. 현재 Mac stage의 JRE는 26.0.2이며 Java 21 계약과 맞지 않습니다. package macOS 13과 동결 PRD의 14 validation floor 차이도 정리해야 합니다. Windows 공급물·재배포 권리·비용·최신 OS 지원은 공식 문서로 확인하고 추측하지 마세요.
- 운영 GitHub 인증 방식/등록, callback/권한/토큰 만료·갱신·취소, 일반 source consumer의 immutable/encrypted source 이행, native OS 격리, 대표 NestJS+React 화면→서비스→data 정확도·변경 영향 근거, 대규모 성능·취소·동시성·복구가 남아 있습니다.
- Mac Developer ID/notarization/Gatekeeper와 Windows 서명·설치·업데이트·rollback·데이터 보존 수용은 미검증입니다. Windows runner는 제공·확인되지 않았습니다. VM 구매, OS 설치, 보안 설정 변경, 외부 CI 업로드는 승인 없이 하지 마세요.

6. 반드시 지킬 실행 경계

- `git reset`, 기존 변경 삭제, checkout 원복, commit/push/PR/게시/배포는 승인되지 않았습니다. 새 자격증명·지속 접근·유료 호출·외부 업로드도 하지 마세요. 사용자 소스·비밀을 로그나 보고서에 노출하지 마세요.
- `desktop/test/managed-process.test.cjs`의 native guardian 시험은 위험 숫자 PID 조회·신호·cleanup 본문을 제거하고 무조건 skip으로 격리했습니다. 현재 보존 SHA는 `228f5b34f68937cde55f3162e35653851b778f0ab7d05b71b3f7effa0956ae15`입니다. 전체 desktop suite나 opt-in/native crash 시험을 무심코 실행하거나 이 격리를 해제하지 마세요.
- `ps`, AX, 기존/저장된/임의 숫자 PID 조회·신호 전송·pattern kill을 하지 마세요. 앞서 거부된 동작을 다른 도구나 우회 환경으로 실행하지 마세요. 권한 차단 시 정식 승인 절차 또는 안전한 대안을 사용하고, 차단 결과를 숨기지 마세요.
- 자원 정리는 이번 실행이 직접 만든 핸들 또는 메모리에 보유한 불변 container ID+랜덤 소유 label을 검증한 경우에만 하세요. 실패 evidence와 run.claim을 지우고 같은 run을 재사용하지 마세요. guardian 과거 증거가 재사용으로 훼손된 이력이 있으므로 그 원본이 보존됐다고 주장하지 마세요.
- 앱 UI가 필요하면 사용자 Mac 브라우저의 다른 작업과 충돌을 먼저 확인하세요. 기존 브라우저/CDP/앱 창 대신 별도 소유 browser context와 합성/mock 데이터를 우선하세요. agent-browser CLI는 이전 확인 때 없었습니다. 기본 Vite 설정은 env를 읽고 127.0.0.1:8080으로 proxy하므로 무심코 dev server를 열어 live backend에 연결하지 마세요.
- 전체 Gradle build, stage, dist, npm start가 무엇을 실행·덮어쓰는지 먼저 읽으세요. 기존 앱을 보존하면서 필요한 좁은 compile/test를 실행하세요. 테스트 권한이 필요한 경우 해당 도구의 sandbox 승인 절차를 따르고 거부를 우회하지 마세요.

7. 확인된 재검증 방법

작업 위치에서 먼저 `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git diff --check`를 실행해 현재 상태를 확인하세요. 이 인계 이후 source가 바뀌었을 수 있으므로 마감 validation JSON의 hash와 구분하세요.

아래 prepare 명령은 실제 실행해 Java/TS compile이 통과했습니다. 두 입력 디렉터리는 기존 JDK/캐시이므로 존재·내용을 확인하고, 없으면 자동 설치나 다른 경로 추측을 하지 마세요.

```sh
node validation/parser-flow-integration/prepare.mjs \
  '/Users/minseokchae/.gradle/jdks/eclipse_adoptium-21-aarch64-os_x.2/jdk-21.0.12+8/Contents/Home' \
  /tmp/ci-java-unit-EPAyKn/deps
```

prepare는 새 `/private/tmp/ci-parser-flow-*` root를 JSON으로 출력합니다. README와 새로 복사된 run.mjs를 검토하고 필요한 Docker/loopback 권한이 허용된 뒤, 그 새 root에 대해서만 `node <새 root>/run.mjs <새 root>` 형식으로 한 번 실행하세요. 실제 확인된 이전 명령은 `node /private/tmp/ci-parser-flow-mKGBI5/run.mjs /private/tmp/ci-parser-flow-mKGBI5`였지만, **그 디렉터리는 이미 사용했으므로 재실행 대상이 아닙니다.** run.claim을 삭제하지 마세요.

이 runner는 캐시된 `pgvector/pgvector:pg16`/`redis:7-alpine`만 쓰고 pull/build하지 않습니다. 전용 label, loopback-only 포트, host mount 없는 tmpfs DB를 만들고 이번 실행 소유 자원만 정리합니다. 전용 bridge는 강제 egress 격리를 증명하지 않습니다. `reports/integration.json`, `lifecycle.json`, compile 로그와 prepared hash를 보존하고 정리 실패도 실패로 보고하세요.

DTO 단위 5개는 일반 Gradle 전체 실행이 아니라 임시 명시적 Jupiter launcher로 검증했습니다. 임시 runner와 로그를 확인하거나 범위를 검토한 새 격리 시험을 준비하세요. 전체 test/build/formatter가 통과했다고 추정하지 마세요. 과거의 더 큰 suite 숫자를 합산하지 마세요.

8. 결과 보고

초기에 실제 저장소 접근·현재 변경·구앱 충돌 경계를 간결히 보고하세요. 각 발견에는 심각도, 파일·라인 또는 재현 근거, 사용자 영향, 수정 우선순위를 적으세요. 진행 중에는 확인한 사실과 아직 가설인 점을 구분하세요. 안전한 버그는 코드·회귀·관련 문서까지 수정하고 가능한 검증을 완료하세요. 마지막에는 이번 변경, PASS/FAIL/미실행, 실행 앱에 반영됐는지, 남은 blocker와 Mac/Windows Go/No-Go 근거를 제공하세요. 현재 앱이나 데이터에 손대지 않은 제한 검증을 실사용 수용 완료로 표현하지 마세요.
