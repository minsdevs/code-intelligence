# Docker 통합검증 후속 — 2026-10-06

## 전체 과정에서의 위치

원본 `/Users/minseokchae/Dev/code-intelligence`의 PR94/main `c554549`에서
`codex/docker-integration-20261006`으로 작업했다. 이번 단위는 배포 전8단계 중
**3단계 인증 통합과4·5단계 분석·품질 검증**의 Docker 환경 차단을 해소한다.
이전 후보의 No-Go 전체 판정을 자동으로 Go로 바꾸지 않는다.

설치된 Docker Desktop을 제한시간이 있는 start 명령으로 시작했고 Docker29.6.2
linux/aarch64 응답을 확인했다. 기존21개 컨테이너는 모두 exited였으며 새 검증
전후 ID·상태가 유지됐다. 기존 volume이나 컨테이너 데이터를 열거나 지우지 않았다.
전역 Docker 종료·prune·reset도 하지 않았다. 테스트는 새 PostgreSQL/Redis와
loopback fake GitHub를 사용하며 실제 계정·provider·사용자 DB/profile/키는 쓰지 않는다.

## 실행 경계

`validation/pre-release/run-docker-integration.cjs`는 허용된 로컬 Unix socket을
명시적으로 받고 빈 private Docker config로 실행한다. Test JVM의 HOME/user.home,
임시 경로, XDG/Git 설정과 DATA_DIR를 새 소유 디렉터리로 지정한다. DB·Redis·GitHub
API/clone의 미설정 기본값은 loopback의 닫힌 포트로 고정하고, 테스트의 명시적인
ServiceConnection/DynamicPropertySource만 실제 합성 서비스를 선택한다.

Gradle 본체는 기존 checkout/toolchain/cache를 사용한다. 이것은 hermetic build나
OS 수준 네트워크 sandbox가 아니며, realGithub=false는 검토된 fake/loopback
설정 범위의 의미이지 모든 호스트 네트워크 패킷을 계측했다는 뜻이 아니다.
Testcontainers 재사용은 끄고 Ryuk 정리는 유지했다. 새 컨테이너가 관측됐다는
사실만으로 소유권을 추정해 삭제하는 코드는 없다.

명령은 실제 생성한 ChildProcess만 보유하며 제한시간 후 TERM/KILL·close 관측을
분리한다. 제한시간 뒤 exit0도 성공으로 바꾸지 않는다. 종료 미확정은 실패와 함께
파일을 보존하고, 직접 자식의 종료를 모든 Gradle 자손의 종료 증거로 확대하지 않는다.
실제 성공 실행은 timeout없이 종료됐고 새 Testcontainers 잔여도0이었다.

macOS Unix socket fixture가 긴 evidence 경로 아래에서 실패한 첫 실행을 보존했다.
후속은 원본 아래 새 mode0700 `.citd-*` 임시 부모를 써서 JUnit socket 길이를 줄인다.
제품의 경로·특수파일 차단을 완화하거나 원래 사용자 임시 디렉터리를 사용하지 않는다.

## 최초 전체 시험의 실패와 수정

첫 `backend-X4MhXz`의 Gradle 결과는1649개 중1628PASS·9FAIL·12SKIP이다.
원시 JUnit XML에는 비활성 parameterized method 선언1개가 추가되어1650개/
13SKIP로 표시된다. 실행하지 않은 선언을 실제 테스트 통과 수에 더하지 않는다.

| 실패 | 실제 원인과 조치 |
| --- | --- |
| retired task API1개 | 정상404의 `task-draft` URI에 `sk-`가 들어 있어 단순 부분문자열 키검사가 오탐. 실제 fixture 토큰/민감 필드 부재와404·정확한 URI를 검사하도록 보정 |
| AI retrieval2개 | retained-only로 바뀐 SummaryService에 오래된 자동 chat/embed 기대가 남음. snapshot 소스·cache 재사용, provider 호출0·usage0·xmin 포함 행 불변을 검증. 자동 유료호출을 다시 켜지 않음 |
| fake accuracy3개 | FakeTsAnalyzer가 현재 ImportHit의 `importedName`을 누락. 실제 분석기+DB의 동일 oracle는7/7통과함을 먼저 확인한 뒤 fake의 observed module/local/export binding만 보완. 동명 모듈/없는 import의 negative 회귀 추가 |
| TS step2개 | 새 파일별 outcome 갱신의 JDBC fluent call이 과거 mock에 없어 NPE. update binding을 관측하고501파일 단일 요청, 초과입력 무전송/무persist, 정확한 UNMEASURED 사유와경로까지 추가검증 |
| 특수파일1개 | 검증 runner의 너무 긴 임시 경로로 AF_UNIX 생성 실패. 새 짧은 소유 임시 경로로 해결; 기존 파일보호 테스트 그대로 유지 |

두 golden fixture의 static FakeTsAnalyzer도 @AfterAll에서 닫도록 했다.
**제품 main source, 독립 fixture oracle와 quality-baseline.env는 변경하지 않았다.**
테스트를 삭제하거나 skip으로 바꾸거나 기준치를 낮춰 실패를 숨기지 않았다.

## 실제 실행 결과

모든 상대 실행 경로의 부모는 `validation/local/docker-integration/`이다.

| 실행 | 결과·범위 |
| --- | --- |
| `auth-p0eW4L` | Auth/OAuthEnabled 실제 Spring HTTP·JPA·Redis·fake GitHub13/13PASS |
| `backend-is5DsD` | 기본 backend task1651개 중1639PASS·0FAIL·12명시적 opt-in SKIP. 임의 skip 추가없음 |
| `accuracy-RNllz4` | 제품/오라클 무변경 상태에서 실제 TypeScript sidecar+DB7/7PASS. 초기 fake 실패와 구별 |
| `maintenance-zPtZq9` | 별도 opt-in HTTP/security/CSRF·활성작업·SSE/동기응답 drain9/9PASS. 전체backend에서 skipped였던 클래스를 따로 실행 |
| `tree-SiVMnJ` | 현재 macOS native prebuild를 기본 upstream loader가 선택한 상태에서8/8PASS, typecheck/build exit0 |
| `ts-MEFXJu` | TypeScript 분석기222/222PASS, typecheck/build exit0 |
| `corpus-T8yhB9` | 고정 golden corpus23/23PASS,57개 fixture파일. 기존 기준25개 이상·300초/2097152KiB 유지. timed Gradle33초·789232KiB |
| `accuracy-pocs6J` | 최종 테스트 코드 기준 실제 TypeScript sidecar+DB7/7PASS. 같은 oracle와 제품소스 유지, sidecar exit0 |
| `final-checks-WGjhNO` | 새 runner/process/env/corpus-count 포함 검증도구69/69PASS, 실패·skip0 |

최종 corpus/accuracy 및 검증도구 결과·정확한 source/evidence 해시는
`docker-integration-validation-2026-10-06.json`에 기록한다. 서로 겹치는 선택 시험의
수를 더해 고유 테스트 총수로 표시하지 않는다. GithubCredentialStorePostgresTest의
별도 JDBC6개는 이 기본 backend task에서 opt-in하지 않았으며 PR93의 독립 실행
증거와 구분한다. 기본 task가 제외하는 SnapshotSourceContractIntegrationTest도
실행했다고 주장하지 않는다.

첫 `corpus-RDWo7d`는 실제 Gradle/test가 exit0였지만 새 wrapper가 dependencyInventory의
`entries` 대신 존재하지 않는 `files` 필드를 읽어 최종 집계를 거부했다. 원래 실패
기록을 보존하고 파일/디렉터리/링크 구분 회귀를 추가했다. 측정 누락을0으로 대체하거나
실제 제품 시험 실패로 오분류하지 않는다. timed Gradle RSS/300초 기준은 앱 전체
프로세스 트리·20회 p95 성능 검증과 다르다. 원래 `./quality-gate` shell wrapper를
실행한 것으로 바꾸지 않고, 같은 구성 검사를 보호 runner로 개별 실행한 범위를 기록한다.

## 선택적 tree analyzer의 플랫폼 오류

기존 `tree-sitter/build/Release/tree_sitter_runtime_binding.node`는 Linux aarch64 ELF였고,
upstream node-gyp-build가 정상적인 darwin-arm64 Mach-O prebuild보다 이를 먼저 선택했다.
새 버전을 설치하거나 loader코드를 바꾸지 않고, 원본의 두 hardlink가 같은 소유자/
inode/hash이며 두 경로 모두 해당 build 트리 안에 있음을 확인했다. loader가 보는
top-level alias만 새 evidence quarantine으로 옮겼고 obj.target의 다른 alias와 원래
바이트는 보존했다. 나머지 패키지 prebuild·package/lock·소스는 바꾸지 않았다.

기본 loader로 테스트·typecheck·build가 통과했으며 PREBUILDS_ONLY 강제 설정을 최종
시험에 사용하지 않았다. 첫 single-link-only 검증의 거부(`tree-Xln8d3`)도 별도
기록했다. 이는 로컬 의존성 오염의 복구이지 candidate에 tree sidecar가 새로 포함됐다는
뜻이 아니다. 호스트와 컨테이너의 node_modules/build 결과를 공유하지 않는 것이 필요하다.

## 남은 사항과 후보 영향

Imupzt의 제품 소스/ASAR/JAR/manifest는 이번 테스트 수정의 대상이 아니며 재빌드하지
않았다. 실제 GitHub refresh/revoke/SSO, original-profile 적용, 전체 crash/전원손실,
독립 corpus·20회 전체 성능·사용자 검증, 새 기기/최소OS·정식 서명/공증·운영조건은
여전히 별도 출시 조건이다. Gradle의 반복 loopback handshake 경고도 원인미확정으로
로그에 남겼으며, 시험PASS가 경고원인 해결이라는 뜻은 아니다.

추가 소스 검토에서 **default-export React component의 route 연결 누락 후보(P2)**가
확인됐다. 현재 semantic extractor는 default import의 importedName을 `default`로
기록하지만 mapper는 실제 component 이름과 직접 비교한다. 현재 oracle의 React
fixture는 named import를 사용하므로7/7PASS가 이 경계를 검증하지 않는다. 다음 제품
수정은 실제 export binding 근거와 negative 회귀를 추가하는 범위로 분리하며, 유일한
동명 component를 추측해 연결하거나 기존 정확도 기대를 낮추지 않는다.
