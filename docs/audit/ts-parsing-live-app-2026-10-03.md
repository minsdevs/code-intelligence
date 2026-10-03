# 실사용 TS_PARSING 실패 추적

- 상태: **원인 재현·현재 소스 수정·제한된 회귀 검증 완료**. 실행 중인 구앱에는 미반영.
- 사용자 보고: 9월 29일 v0.1.0 앱에 Code Intelligence 폴더를 넣으면
  `step 'TS_PARSING' failed: ts-analyzer request failed` 표시.
- 영향: 자기 프로젝트 분석이 실패해 구조·요청 흐름 탐색을 완료할 수 없음.
- 심각도/우선순위: **High / P0**. 사용자 지시에 따라 분석 실패를 최우선으로 처리.
- 경계: 현재 열린 앱/DB V20/포트/설치·dist·stage를 변경하거나 재시작하지 않음.
  로그 읽기는 원인 분류에 필요한 정보만 출력하며 토큰·소스·프로젝트 경로를 기록하지 않음.
  원본 프로젝트를 변경해 입력을 축소하지 않고 합성 입력으로 재현했다.

## 원인과 버전 범위

허용된 runtime backend 로그의 최신 실패(2026-10-03T21:49:03.907+09:00)는
`HttpMessageNotReadableException` → `ValueInstantiationException` → `NullPointerException`이며,
JSON `endpoints`의 `TsAnalyzeDtos$EndpointHit.<init>(TsAnalyzeDtos.java:34)`에서 발생했다.
로그 원문·사용자 프로젝트 소스·토큰은 이 문서에 복사하지 않았다. 이 이벤트에서
접속 거부·timeout·용량 초과를 원인으로 확인하지 못했으며, 실제 HTTP status를 추정하지 않는다.

현재 소스의 EndpointHit/SemanticNodeHit/SemanticEdgeHit도 metadata에 `Map.copyOf`를
사용했다. 실제 analyzer는 반환 타입을 알 수 없으면 `responseType: null` 또는
`returnType: null`을 보낸다. `Map.copyOf`는 null 값을 거부하므로 정상적인 미확정 타입이
전체 분석 실패로 바뀐다. **9월 29일 앱만의 문제가 아니며 현재 소스에서도 재현됐다.**

합성 입력은 `backend/src/test/resources/fixtures/ts-nullable-metadata.json`에 보관했다.
실제 AnalyzeService가 `@Controller('audit')`와 반환 타입을 쓰지 않은 `@Get() list(value)`를
분석한 응답이다. 사용자 원본 프로젝트를 읽거나 수정해 만든 fixture가 아니다.

## 이번 수정

- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsAnalyzeDtos.java:17`에서 metadata를
  방어 복사하며 **최상위 null 값만 미확정 필드로 생략**한다. 3개 metadata DTO에 공통 적용했다.
- 불변성·null key 거부를 유지한다. 중첩 parameterTypes의 null 자리와 parameter.type의 null은
  그대로 보존한다. 잘못된 response 배열의 null member를 정상 데이터로 바꾸지 않는다.
- 그래프 draft도 최상위 null을 거부하므로 DTO에서 null을 허용만 하는 우회 대신 실제 graph
  경계까지 검증했다. 타입을 임의 추정하거나 원본 소스에 타입 주석을 덧붙이지 않았다.
- `TsAnalyzeDtosTest.java` 5개 회귀와 기존 standalone HTTP/DB/SSE runner의 4개 점검을 추가했다.

## 검증

| 항목 | 결과 | 범위 |
|---|---|---|
| 수정 전 DTO 회귀 | 3 FAIL / 2 PASS | 실제 응답 fixture에서 동일 EndpointHit NPE 재현; edge와 immutable copy 계약도 실패 |
| 수정 후 DTO 회귀 | **5 PASS / 0 FAIL** | 명시적 Jupiter engine, JDK 21, 격리 classpath; 서버·실제 DB 없음 |
| 현재 Java main 363개 + standalone runner | **컴파일 PASS** | JDK 21, 기존 dependency 164개, annotation processing 없음 |
| 현재 analyzer production 11개 | **strict compile PASS** | 기존 node_modules, install/build hook 미사용 |
| 새 임시 HTTP → DB → Redis/SSE | **18개 점검 PASS** | 기존 14개 + nullable Nest 분석 완료, endpoint metadata, method metadata, 소스 evidence |
| 증거 결합 | PASS | input 411개, artifact 1,152개, dependency 164개 hash drift 0 |
| 정리 | PASS | Java 정상 종료, Nest close, 임시 PG/Redis stop·remove, 전용 network remove |
| 전체 lint/spotless/Gradle build/전체 suite | 미실행 | 이 수정의 제한 검증을 전체 제품 gate로 확대하지 않음 |
| 기존 V20 DB 업그레이드·실사용 폴더 재분석·앱 UI·운영 OAuth·서명 | 미실행 | 현재 구앱과 사용자 상태 보존 |

DTO 증거는 `/private/tmp/ci-null-metadata-1FM4uo/reports/{red,green}.{json,log}`,
통합 증거는 `/private/tmp/ci-parser-flow-mKGBI5/prepared.json`과 `reports/`에 있다.
작은 결과와 SHA를 [마감 검증 manifest](session-closeout-validation-2026-10-03.json)에 보존했다.
18은 단일 standalone runner의 assertion 수이며 독립 JUnit test 수가 아니다.

실행 앱 package는 `0.1.0`, app.asar 수정 시각은 2026-09-29T07:37:29.345Z다.
이번 수정으로 실행 앱이 바뀌지 않았다. 수정된 별도 bundle에서 사용자 흐름을 수용하기 전까지
실사용 해결을 확정하지 않는다. **출시는 Mac/Windows 모두 No-Go**다.

사용자 중단 지시에 따라 이 수정 묶음과 필수 검증까지만 마감했다.
버전 표시·창 크기 UX·Windows 후속 구현 상태는 [마감 보고서](session-closeout-2026-10-03.md),
다음 도구에 전달할 전체 지시는 [인계 프롬프트](next-tool-handoff-prompt-2026-10-03.md)에 있다.
