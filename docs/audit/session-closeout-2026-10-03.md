# 현재 수정 묶음 마감 보고서

사용자의 최신 지시인 “현재 진행 중인 작업까지만 마무리하고 다른 툴용 프롬프트 제공”을
반영했다. TS_PARSING null metadata 수정과 필요한 검증만 완료했으며 새 후속 구현은 중단했다.
**Mac 및 Windows 일반 사용자 출시 판정은 No-Go**다.

## 저장소와 현재 앱

- 경로: `/Users/minseokchae/Dev/code-intelligence`
- branch: `codex/e2e-docs-scripts`
- HEAD: `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`
- 대량의 기존 수정·미추적 파일이 있는 dirty worktree다. 이번 변경은 미커밋이며 이전 작업과
  섞여 있다. `git diff` 전체를 이번 변경으로 간주하거나 초기화하면 안 된다.
- 현재 구조는 Electron main/preload → loopback Java/Spring Boot backend + PostgreSQL 16/
  pgvector + Redis + NestJS/TypeScript analyzer, React/Vite UI다. 앱 설치만으로 사용 가능한
  독립 native bundle이 목표이며 개발용 Docker가 최종 사용자 의존성이 되는 것은 아니다.
- 부모 스레드에 따르면 별도 실행 담당이 `desktop/dist/mac-arm64/Code Intelligence.app`을
  열었고 서비스 4개 ready, DB V20 상태다. 이 상태는 부모 보고이며 이번 감사가 직접 DB에
  접속해 확인한 것이 아니다. app.asar의 package version `0.1.0`과 9월 29일 수정 시각은
  읽기 전용으로 확인했다. 현재 source의 V1–V25 및 10월 3일 수정은 이 구앱에 반영되지 않았다.

## 사용자 보고 3건과 조치

| 항목 / 심각도 / 우선순위 | 근거와 사용자 영향 | 마감 상태 |
|---|---|---|
| TS_PARSING 분석 실패 / High / P0 | 기존 로그의 EndpointHit 생성자 NPE, 현재 코드에서도 실제 analyzer nullable metadata로 재현. 정상 NestJS 메서드가 포함된 프로젝트 분석이 중단됨 | **현재 소스 수정 + 단위 5개 + 실제 연결 18개 점검 PASS**. 구앱과 사용자 실제 폴더의 재분석은 미실행. [상세](ts-parsing-live-app-2026-10-03.md) |
| UI 버전 0.0.0 / Medium / P1 | `frontend/src/app/Sidebar.tsx:161`의 `v0.0.0` 하드코딩. frontend package도 0.0.0, desktop package/구앱은 0.1.0. main runtime config `main.cjs:834`와 preload/typed bridge에는 app version이 없음. 설치 버전을 오인하게 함 | **원인 확인, 미수정**. Electron `app.getVersion()`에서 신뢰되는 IPC/preload를 통해 UI로 전달하고 브라우저 fallback 출처를 구분하는 방안만 인계 |
| 창 크기·UI UX / Medium / P1 후보 | `main.cjs:881` 1440×960, 최소 980×700. sidebar 240px, AI 기본 340px(최대 560), Flows list 352px 고정. 최소 창에서 detail 공간 부족 가능 | **정적 위험 확인, 실제 브라우저 재현·수정 미실행**. 수치 합계는 가설 근거이며 overflow가 실제 재현됐다고 판정하지 않음 |

P0 수정 파일은 `TsAnalyzeDtos.java`, `TsAnalyzeDtosTest.java`, 합성 fixture
`ts-nullable-metadata.json`이다. `validation/parser-flow-integration/prepare.mjs`와
`ParserFlowIntegration.java`는 공유 fixture를 snapshot하고 실제 HTTP 응답·graph JSON·evidence를
검증하도록 확장했다. unknown 타입을 임의로 채우거나 사용자 프로젝트를 바꾸지 않았다.

## 이번 마감의 검증과 한계

- DTO: RED 3 FAIL / 2 PASS → GREEN 5 PASS. 초기 시험 소스의 wildcard List assertion compile
  오류를 수정한 뒤 RED를 실행했으며 그 최초 compiler 로그도 보존했다.
- JDK 21 main 363개 + runner 1개 컴파일, analyzer production 11개 strict compile PASS.
- 실제 Nest HTTP → 임시 PostgreSQL → Redis/SSE 18개 assertion PASS. nullable Nest endpoint와
  method의 unknown metadata 보존, linked source evidence, 실패·재시도·취소 회귀를 확인했다.
- 빈 DB의 V1–V25 적용이다. 실제 사용자 DB V20 업그레이드 시험이 아니다. 합성 principal,
  사전 inventory, test workspace를 쓰므로 production SecurityConfig/CSRF/OAuth/로컬 import
  승인 및 전체 Spring Boot startup 검증을 대신하지 않는다.
- 411개 input, 1,152개 snapshot/compiled artifact, 164개 dependency hash drift 0.
  동결 문서 21개와 격리된 guardian 시험 파일 hash도 유지했다. `git diff --check` PASS.
- 마지막 Java는 exit 0/signal null로 종료했고 Nest, 임시 PG/Redis, 전용 network 정리 PASS.
  실사용 포트·DB·Keychain·설치 앱·stage/dist와 사용자 브라우저는 변경하지 않았다.
- 이번 마감에서 전체 lint/spotless/Gradle build/전체 suite, UI 화면 수용, native guardian,
  새 설치물·운영 OAuth·Windows OS·서명·업데이트는 실행하지 않았다.

이전 묶음의 parser 165 PASS와 Windows 플랫폼 모형 28 PASS + main 모형 2 PASS는
[이전 보고서](parser-http-db-sse-2026-10-03.md)와
[Windows 보고서](windows-readiness-2026-10-03.md)의 해당 source 당시 결과다.
이번에 다시 실행한 숫자로 합산하지 않는다. 이전 전체 suite 수치도 현재 candidate의 전체 통과로
복사하지 않는다. 위험 숫자 PID guardian 시험 자료 재사용 사고와 격리는
`restart-recovery-audit-2026-10-03.md` 말미에 기록되어 있다.

## 남은 출시 차단점과 다음 순서

1. **공통 P1 UI/버전**: 실제 설치 버전 출처를 연결하고, 소유한 별도 브라우저·합성 데이터에서
   980×700/1280×800/1440×960, 긴 이름, 패널 확장/축소, 진행·실패·재시도·근거 이동을 재현한다.
   현재 작업에서는 agent-browser CLI가 없음을 확인했고 브라우저를 실행하지 않았다.
   기본 Vite proxy는 127.0.0.1:8080이므로 실사용 backend로 연결되는 preview를 열지 말 것.
2. **공통 High/P1 제품 안전·수용**: 운영 GitHub 인증 방식·등록·토큰 만료/갱신/권한 취소,
   일반 source 소비자의 immutable/encrypted source 이행, 적대적 OS 파일/프로세스 격리,
   대표 NestJS+React 요청 흐름·변경 영향 정확도, 대규모 성능과 복구 행렬을 검증해야 한다.
   부분 모듈의 성공을 전체 연결 완료로 바꾸지 않는다.
3. **독립 Mac bundle High/P1**: 현재 stage JRE 26.0.2와 Java 21 계약, package macOS 13과
   동결 PRD의 14 validation floor가 어긋난다. 호환 JRE/PG/Redis와 전이 라이브러리의 독립
   공급, 서명·notarization·깨끗한 OS 설치·업데이트·rollback·데이터 보존 수용이 필요하다.
   구앱/stage manifest에는 최신 buildSequence/backupProtocol/ownershipProtocol이 없으므로
   기존 stage를 현재 main에 섞거나 gate를 우회해 앱을 열지 않는다.
4. **Windows High/P1, Mac 유지**: 경로·환경·실행 파일 조회 및 차단된 x64 NSIS 설정만 준비했다.
   NTFS ACL/reparse-point/원자적 교체·durability, Windows 잠금/소유 handle/Job Object,
   DPAPI 보관 경계, JRE 21·PostgreSQL·확장·전이 DLL native bundle은 미완료다.
   POSIX/getuid/O_NOFOLLOW 조건을 삭제해서 지원으로 선언하지 않는다.
5. **구조 선택**: desktop profile의 Redis session/event 의존을 단일 backend에 맞게 분리하고
   서버 profile은 Redis를 유지하는 방향을 권고한다. 대안은 Windows 호환 Redis의 적법한
   재배포이며 라이선스·비용·버전 검증이 먼저다. 둘 다 미구현·미승인 제품 선택이다.
   최종 사용자에게 WSL/Docker를 요구하는 것은 제품 목표에 맞지 않는다.
6. **양 OS 인수**: 공통 blocker → Windows native 구현/독립 bundle → 깨끗한 Mac 및 실제
   Windows 설치·로컬/권한 있는 GitHub import·마인드맵·근거·복구·업데이트 순서로 진행한다.
   Windows runner는 제공·확인되지 않았다. VM 구매·OS 설치·외부 CI 업로드는 수행하지 않았다.

이 보고서는 새로운 플랫폼/라이선스 조사를 완료한 문서가 아니다. Windows 공급·OS 지원·법적
조건은 다음 도구가 최신 공식 문서로 재확인해야 한다. 초기 선택지는 이전 Windows 보고서에
출처와 함께 있다.

## 인계와 보존

전체 독립 프롬프트는 [next-tool-handoff-prompt-2026-10-03.md](next-tool-handoff-prompt-2026-10-03.md),
현재 source와 실행 근거의 SHA 및 작은 결과 원본은
[session-closeout-validation-2026-10-03.json](session-closeout-validation-2026-10-03.json)에 있다.
임시 artifact가 사라지면 manifest의 결과만 남으며 전체 원본을 재검증했다고 주장할 수 없다.

이후 구현·새 시험은 시작하지 않는다. 승인 없는 commit/push/PR/배포/유료 호출/외부 업로드를
하지 않았고, reset·원복·기존 변경 삭제도 하지 않았다. 부모 스레드로의 별도 메시지 전송은
호출 가능한 도구가 없어 수행하지 않았으며 이 최종 응답은 플랫폼이 부모에 알린다.
