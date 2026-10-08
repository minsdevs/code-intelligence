# W16 Java/source 증분 분석 단위 감사 — 2026-10-08

## 범위와 구현

- 기준 `6ddeefb`, 브랜치 `release/w16-java-incremental-20261008`. 기준 후보 감사: `candidate-h7hpw4-2026-10-08.md`(원본 저장소 읽기 전용 참조).
- `JavaAnalyzer`: 파일별 타입/멤버/호출 단계의 불변 이벤트를 재사용한다. 전체 프로젝트 타입, 상속, concrete method, 이름별 후보, placeholder 존재 및 앞선 파일의 resolver 상태를 유지한다. 선언·설정·모듈·경로·미분류 의존성 변경은 보수적으로 전체 관련 단계의 재계산을 유발한다. 삭제/rename은 현 inventory만 재구성한다.
- 키는 실제 bytes SHA-256, project ID, 상대 경로, inventory 및 선언/solver 환경으로 구성한다. snapshot ID, 임시 workspace 절대 경로, mtime, `.git`은 정체성이 아니다. 프로세스 수명 캐시이므로 바이너리/grammar/rule 변경 후 새 프로세스에는 재사용 데이터가 없다. symlink/알 수 없는 파일 종류/읽기 실패는 캐시를 우회하고, 파싱 실패가 있으면 전체 입력 키까지 의존성에 포함한다.
- 메서드/생성자 body, 명시적 타입 필드의 일반 initializer, 주석은 외부 선언 키에서 분리했다. inferred/anonymous field initializer는 보수적으로 유지한다. 일반 JS/TS 소스 bytes만 바뀌어도 Java 전역 무효화가 일어나던 문제를 제거했다. 설정과 미분류 파일은 계속 포함한다. fixture 상수 이름이나 수치에 따른 분기는 없다.
- 프로젝트 간 phase 재사용을 차단한다. 같은 메서드 후보를 재등록하는 no-op은 resolver 상태를 바꾸지 않는다. 취소된 실행은 마지막 완료 세대를 대체하지 않는다.
- retained AST는 없다. 기존 bounded ParseAhead 및 solver 제한을 유지한다. 후속 medium 실측에 따라 Java phase+완료 결과 합산256MiB, framework16MiB, config16MiB의 고정 보수적 heap 추정 상한을 적용했다(아래 후속 절). 초기 구현은 phase64MiB/완료 결과64MiB였다. 개수4096 제한은 제거했다. 상한 초과는 재계산이며 중간/외부 디스크 캐시는 만들지 않는다. 큰 프로젝트의 모든 파일이 항상 상한 안에 들어간다고 주장하지 않는다.
- `JavaFrameworkAnalyzer`가 JPA/Kafka/Layer/Spring 추출기를 한 단기 AST에 적용한다. 기존 네 별도 Spring bean을 제거하고 실제 standalone 분석 API는 독립 oracle/기존 단위 테스트에 사용한다. visitor가 AST를 바꾸지 않으며 analyzer-major 순서 및 Kafka 첫 topic 규칙을 유지한다. 명시적 Java phase 3회 + framework parse 1회로 cold 추출 중복을 줄인다.
- `SourceParsingStep` 실제 실행 경로에서 fingerprint를 한 번 공유한다. 기존 job-thread Java 실행, helper-thread 병렬 실행, merge 순서 및 파일별 격리를 보존한다. `AnalysisContext`의 네 필드와 생성자 계약은 바꾸지 않았다.
- 비Java 설정 분석기는 BuildFile/Docker/GithubActions/Kubernetes/Serverless/SqlMigration/Terraform/Vercel/YamlConfig 9종의 완전한 동일 입력 결과만 재사용한다. 미등록 분석기는 재사용하지 않는다. TS/tree 분석기 및 import/source-vault/transport/SQL inventory는 변경하지 않았다.
- JavaSourceRoots의 package 탐색은 전체 파일 bytes 대신 최대 4096 bytes만 읽는다. 토큰 제거 최적화는 callee 위치/중복 identity 회귀를 일으켜 폐기했으며 원래 토큰 보존을 유지한다.

## RED → GREEN과 증거

모든 증거는 `validation/local/w16-java-incremental/`에 보존했다. 명령의 cwd는 할당 작업트리이며, Gradle 앞에 공통 `wait-quiet.sh`를 실행했다. 아래 명령의 `backend` 진입 후 실행 부분은 그대로다.

```sh
caffeinate -i ./gradlew --offline cleanTest test \
  --tests dev.codeintelligence.analysis.java.JavaMixedWorkloadIncrementalTest
```

- `mixed-red.log/xml`: 3개 중 3실패. 일반 initializer/JS 수정은 3 대신 5 parse, 4097파일 경계는 0 대신 3 parse. 실제 workload 생성 1건은 `/var` 실경로 선행조건 오류였으며 제품 RED로 계산하지 않는다.
- fixture 실경로 정규화 후 정확한 별도 RED 명령:

```sh
caffeinate -i ./gradlew --offline cleanTest test \
  --tests dev.codeintelligence.analysis.java.JavaMixedWorkloadIncrementalTest.actualMixedWorkloadOnePercentMutationMatchesIndependentFull
```

- `mixed-red-2.log/xml`: 1개/1실패. 변경 Java 4개에서 기대 12 대신 896 phase parse. 독립 full과 결과는 같았지만 과도한 무효화가 입증됐다.
- 일반 의존성 분리/개수 cap 제거 후 최초 명령으로 `mixed-green.log/xml`: 3개/3통과.
- 앞선 단위 증거도 삭제하지 않았다: `red-1.log`→`green-1.log`(완료 결과 재사용), `red-2.log`→`green-2d.log`(파일 phase 재사용), `red-3.log`→`green-3.log`(실제 bean 단일 framework parse), `red-4b.log`→`green-4b.log`(실제 SourceParsingStep config 재사용). `red-4.log/green-4.log`는 graph가 없는 Docker-only fixture 오류이며 유효한 제품 RED가 아니다. `green-2.log/green-2b.log`의 실패도 보존했다.
- `pipeline-smoke-1/2/3.log/xml`은 Git fixture/미완료 job fixture 및 프로젝트 간 무효화/no-op resolver context 문제를 각각 드러냈다. 실제 FinalizeStep을 실행하도록 fixture를 고치고 프로젝트 격리 및 no-op 상태 갱신을 수정했다. `pipeline-smoke-4.log/xml`은 2개/2통과다.

초기 299862e까지의 최종 명령:

```sh
DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" caffeinate -i \
./gradlew --offline cleanTest test \
  --tests 'dev.codeintelligence.analysis.java.*' \
  --tests dev.codeintelligence.analysis.graph.SourceParsingReuseTest \
  --tests dev.codeintelligence.analysis.graph.SourceParsingConcurrencyTest \
  --tests dev.codeintelligence.analysis.graph.SourceResultCacheTest \
  --tests dev.codeintelligence.analysis.graph.SpringMiniGraphGoldenTest
```

**55개 통과, 실패/오류/skip 0.** `final-targeted.log`, `final-test-results/TEST-*.xml`. 변경 Java 파일만 지정한 Spotless 실행은 `format.log`에 보존했고 임시 Gradle init script는 제거했다.

검증 행렬은 body/same-size callee, 필드 initializer/주석, 메서드·타입 signature, dependency 삭제, module rename, unresolved→resolved, duplicate identity, overload, hierarchy, config/module-info, 파싱 실패 복구, 전역 unresolved 후보, 취소, 작은 byte budget fallback, symlink, 4097파일 경계, 서로 다른 workspace 경로와 `.git` metadata를 포함한다. canonical graph/evidence/outcomes를 독립 `new JavaAnalyzer(0)` 또는 독립 framework/config 분석과 비교했다. 기존 1200파일 live-heap 회귀도 통과했다.

## 실제 경로 smoke 관측

Spring 제품 bean, 임시 Git 저장소, 격리 Postgres/Redis, FileInventoryStep → SourceParsingStep → GraphBuildStep → FinalizeStep을 실행했다. 같은 project를 다른 workspace/snapshot으로 갱신하고 DB의 node/edge/evidence/outcome 및 실패 집계를 independent clean-full pipeline과 비교했다. 실제 사용자 app/profile/credential은 사용하지 않았다.

| 합성 Java | bytes | cold ms | unchanged ms | changed ms | independent full ms | unchanged phase parse | changed phase parse / 재사용 phase |
|---|---:|---:|---:|---:|---:|---:|---:|
| 96파일 | 585,580 | 1,417 | 510 | 776 | 1,535 | 0 | 3 / 285 |
| 512파일 | 3,124,004 | 10,348 | 5,547 | 8,246 | 8,906 | 0 | 3 / 1,533 |

두 행 모두 persisted canonical equality=true. retained phase 추정은 각각 10,488,964 / 56,277,596 bytes다. 시간은 SourceParsingStep 관측치이며 timing assertion/통과 gate가 아니다. `parserInvocations`는 JavaAnalyzer의 명시적 세 단계 parse 계측이며 symbol solver 내부 로드는 포함하지 않는다. framework parse는 별도 계측한다.

수정하지 않은 `validation/pre-release/workload-fixture.cjs`의 실제 생성기/1% mutation도 실행했다: 1000파일, 2,097,152 bytes, Java 446파일, 전체 변경 10파일 중 Java 4파일. **Java 12 phase parse / 1326 phase 재사용**, framework 4 parse, retained phase 18,310,366 bytes. 독립 full graph/evidence/outcomes와 같았다. 증거: `final-test-results/TEST-dev.codeintelligence.analysis.java.JavaMixedWorkloadIncrementalTest.xml`.

## NOT RUN 및 공유 문서 제안

- 새 packaged candidate 생성/실행, 실제 packaged refresh, large ≤600초, medium refresh ≤30초, 20회 timing gates, 전체 회귀, signing/notarization/Actions/push/merge는 **NOT RUN**. 위 512파일 합성 smoke는 공식 large workload gate가 아니다. packaged cold/refresh 성능 판정은 통합 후보에서 coordinator가 수행해야 한다.
- 공유 문서 제안: “Java/source 분석은 프로세스 수명 내 실제 bytes와 프로젝트·상대경로·선언·설정·의존성 정체성으로 결과를 재사용한다. 변경 파일을 다시 파싱하고, 구조/미분류 의존성 변경과 캐시 상한 초과는 안전하게 재계산한다. Java framework 추출기는 AST를 공유하되 장기 보관하지 않는다. 증분/독립 full의 canonical graph·evidence·outcome 동등성을 단위 및 실제 DB pipeline에서 검증했으며, packaged timing gate의 통과 여부는 별도 후보 증거로만 판정한다.”

구현 커밋: `d2094b2`, `6535d33`, `d0e6ddc`, `bb37392`, `f13cd3d` (모두 `[skip ci]`).


## 후속: 실제 medium 보관량과 대기 취소

이 절은 299862e 이후 후속 변경/증거다. 앞의 55개 및 초기 smoke 수치는 당시 실행 그대로 보존한다.

### 계상 및 고정 예산

- 공식 생성기의 medium(10,000파일/50MiB, Java 4,496파일)을 throwaway probe로 진단했다. 제품 경로 밖의 진단이며 package/timing gate가 아니다.
- 기존 64MiB phase 예산: 796파일 보관, cold 13,488 parse/38,803ms. 1% 변경 100파일 중 Java 17파일인데 11,112 parse/2,376 재사용/30,879ms였다. 증거: medium-probe-baseline.log/xml. 이 초기 probe의 heapUsed에는 inspection 임시 할당이 섞였으므로 정확한 live-heap 비교에는 사용하지 않는다.
- probe에서만 512MiB로 전체 보관을 관측했다(제품 설정 아님). 중복 계상 377,638,166 bytes 대 identity별 보수 추정 165,250,008 bytes. inspection 전 GC후 heap은 139,584,640 bytes(기준 23,030,728), RSS 1,241,488KiB. 증거: medium-probe-representation.log/xml. 압축률도 메모리 내에서 조사했지만 제품 직렬화/압축 계층은 도입하지 않았다.
- 실제 수정은 공유 객체의 identity 중복 계상만 제거하고 **Java phase+완료 결과 합산 256MiB**를 고정 상한으로 둔다. 완료 결과는 phase 보관 후 남은 예산 안에서만 보관한다. framework/config의 각16MiB 상한은 유지한다. 서로 다른 객체가 값만 같다고 계상을 생략하지 않는다.
- 계상은 payload만이 아니다. 파일별 기본512 bytes, blob/선언/context/key 문자열, tape96 bytes와 이벤트 배열 참조8 bytes/항목, event64 bytes, 선언 method96 bytes를 포함한다. graph record 고정 overhead, map96+64 bytes/entry, collection48+8 bytes/항목, 문자열48+2 bytes/문자도 포함한다. 공유 identity 제거 범위는 단일 retained 파일/결과다. 파일 사이 또는 phase/완료 결과 사이의 공유는 여전히 중복 계상하므로 보수적이다. 계산용 IdentityHashMap은 임시이며 장기 보관하지 않는다.
- 정상 제품 기본 생성자/256MiB에서 모든 4,496 Java파일을 보관했다. cold retained 추정184,032,312 bytes; 변경 후184,764,648 bytes. Java17 변경→**51 parse/13,437 재사용/1,604ms**, framework17 parse/4,479 재사용. 변경 후 inspection 전 GC후 heap148,455,440 bytes, RSS1,251,360KiB. Java와 framework 모두 독립 full graph/evidence/outcomes equality=true. 증거: medium-probe-bounded.log/xml. 이는 lock 추가 전 예산 수정의 진단이며 공식 RSS/30초 gate 판정이 아니다.

Probe 명령(cwd backend):

~~~sh
caffeinate -i ./gradlew --offline \
  --init-script ../validation/local/w16-java-incremental/medium-probe.gradle \
  cleanTest test --tests dev.codeintelligence.analysis.java.MediumReuseProbeTest
~~~

init script는 test JVM에 -Xmx2g와 -XX:+UseSerialGC를 설정했다. probe/source/임시 init script는 완료 후 제거했고 결과 원문은 남겼다.

공유 계상 RED/GREEN 명령:

~~~sh
caffeinate -i ./gradlew --offline cleanTest test \
  --tests dev.codeintelligence.analysis.java.JavaCacheAccountingTest
~~~

cache-accounting-red.log/xml: 1개/1실패(동일 참조와 별도 객체의 계상이 모두236 bytes). 수정 후 cache-accounting-green.log 및 cache-accounting-green-results/: 계상1 + 기존 증분19 + 혼합3 =23개 통과. 작은 예산 fallback/취소/독립 full 동등성을 유지했다.

### 첫 parser를 기다리는 job의 취소

- JavaAnalyzer/JavaFrameworkAnalyzer의 메서드 전체 monitor를 ReentrantLock.lockInterruptibly로 교체했다. 취소 시 interrupt 상태를 복원하고 기존 JobCancelledException으로 종료한다. 캐시 lookup/계산/게시의 직렬성과 마지막 완료 세대는 유지한다. cacheStats도 동일 잠금을 사용한다.
- SourceResultCache는 analyzer 실행 및 weight 계산을 monitor 밖에서 수행한다. 안에는 최대9종의 짧은 lookup/교체만 있어 같은 긴 analyzer 대기 문제가 없다. 해당 코드는 변경하지 않았다.
- 결정적 회귀는 실제 ParseAhead worker의 source 접근을 latch로 막고, 두 번째 virtual-thread job이 제품 analyze overload에 진입해 대기한 뒤 interrupt한다. 첫 parser를 풀기 **전에** 두 번째 job이 JobCancelledException+interrupt 보존으로 끝나야 한다. 그 뒤 첫 parser를 풀어 최초 작업 성공, independent full equality, 완료 결과 재사용의 동등성을 확인한다. 잠금 필드/monitor reflection 단언은 없다.

~~~sh
caffeinate -i ./gradlew --offline cleanTest test \
  --tests dev.codeintelligence.analysis.java.JavaAnalysisCancellationTest
~~~

queued-cancel-red.log/xml: 2개/2실패(첫 parser가 해제되기 전 두 번째 job 종료를 기다리다 TimeoutException). queued-cancel-green.log/xml: 2개 통과. 대기 진입 이후 interrupt하도록 동기화를 강화한 최종 결과에도 두 분석기 모두 아래 순서를 기록했다:

~~~text
cancelledBeforeParserRelease=true interruptPreserved=true firstSucceeded=true equality=true
~~~

### 후속 최종 결과

앞의 최종 Gradle 명령과 같은 소유 슬라이스 selector를 --offline cleanTest로 실행했다. **58개 통과, 실패/오류/skip 0**. evidence: followup-final-targeted.log, followup-final-results/TEST-*.xml. 96/512파일 실제 DB pipeline equality와 실제 혼합 fixture1% equality도 재통과했다. 변경된 5개 Java 파일만 FileCollection으로 지정해 서식을 적용했다(followup-format.log). JavaIncrementalTest.java는 수정하지 않았다.

NOT RUN은 앞 절과 같다. 특히 medium 진단의 Java 분석 시간/RSS만으로 packaged refresh30초 또는 공식 totalRSS4GiB 통과를 주장하지 않는다. 사용자 승인 대기 중에는 유한 시험 종료와 증거 보존만 수행했고, 재개 승인 뒤 대기 취소 수정을 완료했다.


## 통합 전체 회귀의 숨김 입력 시험 정리

- int 전체 backend 회귀에서 과거 `RetrySourceGuardTest.sourceHiddenInGitMetadataWouldChangeResolvedCallsAndIsRejected`가 실패했다. 이 시험은 `.git/injected`의 Java 소스가 CONFIRMED CALLS를 추가해야 한다는 취약 동작을 필수 전제로 삼았다. 새 source-root 탐색은 Git 메타데이터를 제외하므로 실제 출력에는 DECLARES만 남았다. 원본 실패는 `docker-integration/backend-jl6yBm`에 보존한다.
- 그 취약 동작 전제 시험을 삭제했다. 기존 숨김 Java/JAVA 재시도 거부 2건은 유지한다. 별도로 Java 증분 시험에 승인된 그래프의 cold·warm 불변성을 추가했다: 정상 App/메서드 노드가 있는 상태에서 숨김 Helper를 넣어도 두 분석 결과 전체가 바뀌지 않아야 한다.
- 통합 담당의 실제 private-home Gradle 재실행: RetrySourceGuardTest + JavaIncrementalTest **49/49 통과**, 실패/skip 0. `validation/local/followup-main-verification/source-boundary`. 제품 소스나 거부 정책은 이 정리에서 바꾸지 않았다.

