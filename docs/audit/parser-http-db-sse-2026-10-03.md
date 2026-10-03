# 실제 parser HTTP → DB → SSE 검증

승인된 합성 데이터·전용 임시 서비스 범위에서 **14개 연결 점검이 통과**했다.
이 과정에서 최상위 함수 사이의 호출 누락을 재현해 수정했다. **제품 출시는 No-Go 유지**다.
Windows 후속 상태는 [별도 보고서](windows-readiness-2026-10-03.md), 정확한 소스·명령·로그
결합은 [검증 manifest](parser-http-windows-validation-2026-10-03.json)에 기록한다.

## 발견과 수정

| 발견 | 근거 / 영향 | 우선순위와 처리 |
|---|---|---|
| 최상위 함수에서 호출 연결 누락 — High | `semantic-extractor.ts:289` 이전에는 class method만 호출을 순회했다. `export function service(){return 42} export function api(){return service()}`에서 두 함수 node는 나오지만 CALLS가 없었다. 실제 DB 시험에서 graph edge가 없어 실패했다. 요청 흐름과 변경 영향이 빠진다. | P1, 수정. 기존 symbol/import 선언 검증을 공유해 `.ts/.mts/.cts`와 import alias를 처리한다. shadow된 값, 중첩 callback/function/object method 호출은 바깥 함수에 잘못 귀속하지 않는다. |
| 실제 연결 증거 부족 — Medium | 이전 156개 parser/service 직접 호출 및 Java 35개 단위 검증은 실제 HTTP status handler, PostgreSQL 저장, Redis/SSE 전달을 실행하지 않았다. | P1 검증 공백 해소. 이번 14개 점검 범위에 한함. |

회귀 테스트는 수정 전 **4 FAIL / 161 PASS**, 수정 후 **165 PASS / 0 FAIL**이다.
단순히 통합 시험의 기대값을 낮추지 않고 같은 합성 입력으로 수정 후 실제 DB 시험을 통과했다.
closure·동적 호출 전체 해석이나 대표 프로젝트 정확도 수용까지 확장한 결과는 아니다.

## 실행 범위와 소유권

- 호스트 Mac arm64에서 Node 26.5.0, JDK 21.0.12+8 실행. DB/Redis는 Docker의 Linux arm64
  캐시 이미지 `pgvector/pgvector:pg16`, `redis:7-alpine`을 digest로 고정했다. 새 이미지 다운로드 없음.
- 실행마다 새 임시 디렉터리, 랜덤 소유 label, 컨테이너 ID, 전용 네트워크 사용. DB/Redis 저장소는
  tmpfs이며 사용자 디렉터리 mount가 없다. 게시 포트는 실제 inspect 결과 `127.0.0.1`만 허용했다.
- `NestFactory.create(AppModule)`의 서버 핸들과 실제 `AnalyzeController/AnalyzeService`를 사용했다.
  Java는 실제 `TsAnalyzerClient`, `TsParsingStep`, `JobRepository/Worker/Service`,
  `JobController/JobEventsController`, `ApiExceptionHandler`, `JobProgressPublisher/JobSseBroadcaster`를 사용했다.
- Java web container는 독립 Tomcat/Spring MVC 구성이다. 합성 principal resolver와 사전 inventory/
  snapshot/workspace, 취소 시점 gate는 시험 어댑터다. **production SecurityConfig/CSRF/OAuth,
  전체 Spring Boot bootstrap, 실제 로컬 import/preview 승인 흐름은 이 시험에 포함하지 않았다.**
- Flyway는 빈 전용 DB에 V1–V25를 적용했다. 기존 사용자 DB 업그레이드·복원 검증은 아니다.
- 생성·중단·삭제는 이번 실행 메모리의 container ID와 소유 label을 재확인한 Docker lifecycle API,
  `app.close()`, `Tomcat.stop()/destroy()`, Redis close 및 직접 생성한 Java child 핸들로만 처리했다.
  PID를 기록·조회·신호 대상으로 쓰는 코드는 없다. Java 정상 exit 0, signal null이다.
- 최종 run의 Nest close, Java close, DB/Redis stop+remove, network remove가 모두 기록됐다.
  연결 설정의 합성 비밀번호 파일도 제거됐다. guardian 시험·AX·실제 DB·Keychain·설치 앱·브라우저는 사용하지 않았다.
- 전용 bridge는 강제 외부 통신 차단 경계가 아니다. 시험 코드는 loopback/Docker socket만 사용하며
  외부 API 호출·업로드·유료 사용을 하지 않았다.

기본 sandbox에서는 Docker socket과 loopback listen에 EPERM이 났다. 서버 생성 전에 중단했고,
승인된 시험 범위의 정식 권한 검토를 거쳐 loopback 열기/같은 핸들 닫기와 캐시 이미지 확인을 통과한 뒤 실행했다.
`ps` 거부를 재시도하거나 우회하지 않았다.

## 최종 결과

| 검증 | 결과 |
|---|---|
| 현재 Java main 363개 + standalone runner 1개, JDK 21 컴파일 | PASS. Gradle build/hook 미사용, 캐시된 dependency 164개 hash 확인 |
| 현재 TypeScript production source 11개 strict compile | PASS. npm install/build hook 미사용, 기존 dist 미변경 |
| parser·HTTP boundary·service 회귀 | 165 PASS, 0 FAIL |
| 실제 연결 점검 | 아래 14개 모두 PASS |
| 최종 입력과 현재 소스 결합 | 410개 입력 drift 0, 보관된 소스/컴파일 artifact 1,151개 drift 0 |
| 서비스 정리 | PASS. 최종 및 실패한 두 run 모두 생성한 자원 제거 확인 |
| 전체 lint/Gradle build/전체 unit/기존 데이터 migration | 미실행 |
| 실제 UI, 운영 OAuth, native guardian/OS 격리, 서명·설치·업데이트 | 미실행 |

연결 점검 14개는 하나의 제한된 standalone 실행 안의 assertion 집계다.

1. 빈 DB에 25개 migration 적용.
2. 실제 analyzer HTTP 400 → 안전한 failure code/location 저장.
3. DB, GET, live Redis SSE의 실패 code/message 일치.
4. 구문 오류 때 부분 graph가 저장되지 않음.
5. retry HTTP 409 + `TS_SYNTAX_ERROR`, job/step checkpoint 변경 없음.
6. 다른 합성 principal의 GET/SSE/retry가 404.
7. SSE 재연결은 DB의 terminal 실패를 복원한 뒤 종료.
8. 수정된 `.mts` 새 job의 graph 저장, 이전 FAILED job 유지.
9. 수정된 `.cts` 새 job의 graph 저장, 이전 FAILED job 유지.
10. 일반 transient 실패는 HTTP retry 202.
11. 일반 retry가 두 번째 attempt에 완료.
12. 실행 중 job의 HTTP cancel 202.
13. CANCELLING 동안 project active exclusivity 유지.
14. 뒤늦은 syntax failure가 CANCELLED를 덮어쓰지 않고 active 상태도 해제.

## 실패 이력과 증거 보관

| 실행 | 결과와 후속 |
|---|---|
| `/private/tmp/ci-http-db-sse-DOwdK2` | 첫 javac argument file의 wildcard classpath가 확장되지 않아 compiler 실패. 명시적 dependency 목록으로 수정해 컴파일 통과. 첫 서비스 실행은 internal network의 loopback port 확인 실패로 중단; 생성한 PostgreSQL·network 삭제 확인. Java integration 미시작. |
| `/private/tmp/ci-http-db-sse-13UN7z` | 별도 bridge와 새 DB 사용. 문법 오류 전달 등 7개 점검 통과 후 정상 함수 CALLS 누락을 재현해 8번째 점검 실패. 서버/두 container/network 모두 정리. 이 디렉터리에 parser RED/GREEN, Windows 28개 및 main 2개 모형 시험 로그도 보관. |
| `/private/tmp/ci-parser-flow-ilf8wo` | 수정 후 새 snapshot으로 재컴파일, 새 DB/서버에서 14개 모두 통과. lifecycle 전체 정리 통과. `prepared.json`, `reports/integration.json`, `reports/lifecycle.json`, 컴파일·실행 로그 보관. |

실패 자료를 덮어쓰거나 기존 PID 기록을 재사용하지 않았다. 재실행용
[`validation/parser-flow-integration`](../../validation/parser-flow-integration/README.md)은 새 디렉터리만 준비하고,
hash를 검증하며, 이미 사용한 디렉터리는 `run.claim`으로 실행 전에 거부한다.

기존 사용자 변경, branch/HEAD, 동결 계획 문서 21개 및 guardian 격리 파일을 보존했다.
이전 parser/Java/native 보고서는 당시 실행 범위의 역사적 기록으로 유지한다.
