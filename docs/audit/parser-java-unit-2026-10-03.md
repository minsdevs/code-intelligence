# Java 컴파일·선택 단위 테스트 재개 — 2026-10-03

사용자가 추가 승인한 격리 Java 검증을 수행했다. **JDK 21 본문 363개 소스 컴파일,
선택 테스트/helper 5개 소스 컴파일, 지정한 JUnit 35개가 모두 통과했다.** 제품 코드의
컴파일/단위 실패는 없었으며 제품 소스를 추가 수정할 필요가 없었다.

**출시 No-Go는 유지한다.** 실제 HTTP/SSE/DB 연결, native/guardian, 설치 앱·서명·업데이트는
이번에도 실행하지 않았다. 아래 결과는 Gradle 전체 build나 전체 backend suite 통과가 아니다.

## 사전 검토와 격리

- `backend/build.gradle.kts`, `settings.gradle.kts`, wrapper 설정과 선택 테스트/helper 전체를
  읽었다. Gradle에는 `snapshotSourceTest`의 프런트엔드 build 의존성과 `accuracyTest`의
  실제 sidecar 요구가 있다. 기본 테스트 classpath에도 Testcontainers/ArchUnit이 포함된다.
- 이번에는 새 `/tmp/ci-java-unit-EPAyKn/`에 소스·의존성·클래스·보고서·home/tmp를 분리했다.
  격리 단위는 임시 디렉터리·독립 JVM과 mock이며 OS sandbox의 격리 성능 검증은 포함하지 않는다.
  wrapper/Gradle task/plugin/init hook, toolchain 다운로드, package 설치, 외부 서비스 연결은 실행하지 않았다.
- 로컬 캐시의 Eclipse Adoptium **21.0.12+8 / aarch64** JDK를 절대 경로로 지정했다.
  `javac --release 21 -parameters -proc:none`으로 현재 main 전체 363개를 사본에서 컴파일했다.
  annotation processor와 기존 앱 클래스 재사용은 없다.
- 의존성은 기존 `backend/build/libs/backend-0.0.1-SNAPSHOT.jar`의 `BOOT-INF/lib` 및 로컬 Gradle
  cache의 정확한 테스트 버전에서 임시 디렉터리로 복사했다. Boot BOM 4.1.0에 맞춘
  JUnit 6.0.3, Mockito 5.23.0, Byte Buddy 1.18.10, AssertJ 3.27.7을 사용했다.
  기존 bootJar는 **dependency의 출처**이며 application entrypoint/classes를 실행하거나 재사용하지 않았다.
  Gradle 의존성 해석·패키징/리소스 결합 검증을 대체하는 것은 아니다.
- 테스트 JVM은 빈 환경(`env -i`)과 전용 home/tmp, 최대 heap 512 MiB를 사용했다.
  `-XX:+DisableAttachMechanism`을 켰다. Mockito는 subclass mock maker와 reflection member
  accessor로 고정하고, 실제 선택된 구현을 결과 JSON에 기록했다. 외부 JVM attach helper가 필요한
  inline mocking을 사용하지 않았다.
- JUnit은 Jupiter 엔진 하나와 클래스 selector 4개만 등록했다. 엔진·session/discovery/test listener·
  post-discovery filter 자동 등록과 extension 자동 탐색, 병렬 실행을 끄고 Spring context는 시작하지 않았다.
- runtime test resource는 합성 `ts-syntax-error.json`과 Mockito 설정 2개뿐이다. 실제 application
  설정/사용자 DB/Keychain/설치 앱은 가져오지 않았다. `TsParsingStepTest`의 파일은 JUnit `@TempDir`
  아래에서만 생성됐으며 종료 후 전용 tmp 디렉터리는 비어 있었다.
- mock 대상에 final class/method 실행이 필요한지와 static 초기화를 읽기 검토했다. Repository/JDBC,
  graph persistence, worker/publisher/source guard는 mock이다. `TestJobContext.running()`의 DB
  helper는 호출하지 않고 순수 생성자만 사용한다.

## 결과

| 단계 | 결과 | 근거 (`/tmp/ci-java-unit-EPAyKn/`) |
|---|---|---|
| main 363개 Java 컴파일 | **PASS**, exit 0 | `reports/compile-main.log` — 기존 deprecated API 사용 안내만 발생 |
| 테스트 4개 + TestJobContext 컴파일 | **PASS**, exit 0 | `reports/compile-tests.log` |
| 전용 JUnit runner 컴파일 | **PASS**, exit 0 | `reports/compile-runner.log` |
| 최초 실행기 확인 | FAIL, exit 1, **JUnit 실행 전** | `reports/junit-run.log`, `reports/FocusedTests-initial.java` |
| 실행기 수정/재컴파일 | **PASS**, exit 0 | `reports/compile-runner-canonical.log` |
| 지정 JUnit 실행 | **35 PASS / 0 FAIL / 0 SKIP / 0 ABORT**, exit 0 | `reports/junit-final.json`, `reports/junit-final.log`; 687 ms |

최초 실패는 제품 단위 실패나 권한 거부가 아니다. macOS에서 `/tmp`가 `/private/tmp`로
정규화되어 실행기의 문자 prefix 검사가 Mockito 설정을 거부했다. `Path.toRealPath()`로
**동일한 소유 설정 파일인지** 비교하도록 실행기만 수정했다. 검사 대상을 넓히거나
다른 설정을 허용하지 않았으며 실패 로그와 수정 전 실행기 소스를 보존했다.

| 선택 클래스 | 실행 수 | 확인한 범위 |
|---|---:|---|
| `LanguageDetectorTest` | 26 | 기존 확장자와 `.mts/.cts`, 대문자, declaration module 분류 |
| `TsParsingStepTest` | 3 | null language inventory의 module 확장자, 합성 501-file 단일 요청, byte budget 거부. JDBC/sidecar/persistence는 mock |
| `TsSyntaxInputExceptionTest` | 3 | 공유 sidecar fixture→안전한 job 메시지, 잘못된/중복/큰 JSON 거부, 위험 경로·임의 메시지 노출 방지 |
| `JobServiceRetryTest` | 3 | syntax failure의 409 코드와 재시도 차단, 경쟁 상태 재확인. source guard/worker/DB는 mock |

새 요청 전후와 컴파일한 사본을 비교했다. **363 main + 5 test/helper + 1 fixture = 369개 입력의
현재 저장소 SHA drift 0**이다. 기존 main/test/build 산출물을 덮어쓰지 않았다. guardian 격리
시험 파일과 이전 flow 검증 JSON도 baseline SHA와 동일하다. branch와 HEAD는
`codex/e2e-docs-scripts` / `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`으로 유지했다.

정확한 명령, 소스·JDK·dependency·컴파일 산출물·보고서의 SHA-256과 최초 실패 이력은
[검증 manifest](parser-java-unit-validation-2026-10-03.json)에 기록한다. 전용 runner와
`prepare.mjs`도 해당 scratch에 보존했다. 상위 보고서의 이전 미실행 결과를 덮어쓰지 않고
추가 승인 후의 별도 검증으로 기록했다.

## 이번에 확인하지 않은 것과 다음 필요 범위

- **HTTP:** `TsAnalyzerClient`의 실제 400 수신/본문 제한/error handler 전달은 컴파일만 확인했다.
  decoder 단위 통과가 실제 REST client 연결 성공을 뜻하지 않는다.
- **DB/SSE:** job 실패 코드 저장·복원, GET/SSE serialization, 취소와 실패의 경쟁, 수정된
  source로 새 snapshot을 만드는 실제 흐름은 미실행이다. 다음 기능 검증은 합성 소스와
  전용 임시 서비스/DB를 사용하는 별도 승인 범위가 필요하다.
- **native/install:** guardian 강제 종료·PID 조회/신호·AX·실제 데이터 복원·설치 앱 변경은
  실행하지 않았다. 위험 PID 시험 격리는 계속 유지한다. 새 권한 거부·우회 시도도 없었다.
- **빌드/출시:** Gradle 전체 build/formatter, 패키지 resource 구성, 지원 OS의 깨끗한 Mac 설치,
  서명/notarization/업데이트, 운영 OAuth와 대표 제품 corpus/성능/UX 수용은 미실행이다.
  OAuth 운영 flow, 독립 JRE/PG/Redis 배포 기준과 서명 운영 결정은 여전히 남아 있다.

승인된 Java 컴파일·단위 검증은 완료했다. **No-Go 유지**이며 실제 연결·배포 준비의 완료로
확대 해석하지 않는다.
