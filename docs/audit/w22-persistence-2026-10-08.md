# w22 — 근거 교체의 PostgreSQL 계획 병목

- 공개 기준 `6ddeefb`(PR #110), 진단 후보 `p6yGme`, 후보 product source `f0b983f`, baseline `tZgvV7`.
- 통합 작업트리 calm-meadow, 브랜치 `release/gate-followup-20261008`.
- 증거는 이 작업트리의 `validation/local/w22-persistence/`에 보존한다.

## 재현과 최소 변경

실제 SOURCE_PARSING 경로의 JFR에서 warm 근거 교체 DELETE의 긴 PostgreSQL 응답 대기가 관측됐다. 실제 Spring 서비스와 PostgreSQL로, 빈 대상 집합에서 준비한 계획을 유지한 뒤 기존 근거 120,000개를 보존하면서 대상 subject 40,000개를 교체하는 시나리오를 재현했다.

`red-evidence`는 2개 중 1개 실패다. 삭제 구간이 **50,191ms**로 기존 lookup 성능 시험과 같은 8,000ms 예산을 초과했다. 503개 subject의 빈 replacement·새 근거·비대상 subject/종류/프로젝트 보존 시험은 이때도 통과했다.

`EvidenceService.replaceLinkedAll`의 비어 있지 않은 삭제 루프에만 기존 `CustomPlans.run`을 적용했다. SQL·500개 배치·근거 삽입·link 계약은 그대로다. caller의 `plan_cache_mode`를 되돌리며, 전역 PostgreSQL 설정·prepared statement·새 index/migration은 변경하지 않는다.

## 실제 검증

`green-evidence-retry`의 실제 PostgreSQL 대상 **6/6 PASS, 실패/skip 0**:

- `EvidenceReplacementPlanTest`: 2/2. 삭제 예산 통과, 호출자의 `force_generic_plan` 복원, 기존 근거 보존 및 503개 배치 경계 확인. 예산 시나리오 전체 JUnit 시간은 2.310초다. 이는 준비/확인을 포함한 시험 시간이며 삭제 구간의 별도 정밀 측정값으로 쓰지 않는다.
- `GraphPersistenceLookupPlanTest`: 1/1.
- `GraphPersistenceRoundTripTest`: 1/1.
- `GraphIdentityGuardTest`: 2/2.

원본 XML, `verify.log`, `quiet.jsonl`, `main-verification-totals.json`을 함께 보존한다. 실행은 native lock + caffeinate와 load1<4/mdworker≤6의 30초 간격 3회 admission 뒤, `cleanTest test`로 수행했다.

```sh
bash validation/local/w22-persistence/run-target.sh green-evidence-retry \
  --tests dev.codeintelligence.evidence.EvidenceReplacementPlanTest \
  --tests dev.codeintelligence.analysis.graph.GraphPersistenceLookupPlanTest \
  --tests dev.codeintelligence.analysis.graph.GraphPersistenceRoundTripTest \
  --tests dev.codeintelligence.analysis.core.GraphIdentityGuardTest
```

재실행에는 새 증거 label을 사용한다. 앞선 `green-evidence` 시도는 외부 runner의 300초 deadline으로 quiet admission에서 종료했으며 **Gradle/시험 NOT_RUN**이다. `runner-timeout.json`과 부하 로그를 보존했다. 종료된 PID와 정확히 일치하는 holder, 빈 나머지 lock 디렉터리를 확인한 뒤 그 stale lock만 회수했다.

이 검증은 새 패키지의 G-PERF 통과를 뜻하지 않는다. p6의 목표 미달 기록은 유지하며, 추가 변경이 포함된 패키지 회귀·medium/large smoke는 별도 후보로 검증한다. 최종 20회·실제 Keychain·서명/공증·실계정은 NOT_RUN이다.
