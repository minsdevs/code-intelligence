# w24 — refresh의 route 연결 정리

- 공개 기준: `6ddeefb`(PR #110), 인계 당시 후보 `h7hpw4`.
- 이번 실측 기준: `KOwFxr`, product source `a04fa4d`, baseline `tZgvV7`, `xpc-required`.
- 통합 브랜치: `release/gate-followup-20261008`; 유닛 시작 HEAD `cec85e9`.
- 증거: `validation/local/w24-ts-refresh/` 및 `workload-performance/run-w1k0wK/`.
- **유닛 정확성·호출 수 검증과 새 후보 2ogirS의 회귀·영향 패키지 검증은 통과했다. 성능 진단은 진행 중이며 medium refresh 30초 달성은 아직 판정하지 않는다.** KOwFxr의 목표 미달과 최종 20회 NOT RUN은 유지한다.

## 실제 패키지 관측

`profile1/virtual-stack-facts.json`은 소유권을 확인한 KOwFxr backend의 virtual-thread dump 102개를 원본 hash와 함께 연결한다. observer 오류는 없고 실행 종료·후보 불변을 확인했다. 초기 분석 140,909ms, refresh 79,490ms는 **계측한 smoke-1 진단**이며 출시 SLO 증거가 아니다.

refresh job의 35개 표본 중 TS 단계의 `GraphPersistenceService` route 정리 SQL 대기 9개, 첫 TS analyze 응답 대기 5개를 관측했다. IMPORT에는 source retain 응답 대기 3개가 있었다. **표본 개수는 각 구간의 wall time이 아니다.** `SourceStoreClient.ready`는 selector 대기이며 metadata 재읽기 함수가 아니다. SOURCE_PARSING에서도 저장 SQL 대기를 관측했으므로 전체 재파싱이 원인이라고 단정하지 않는다.

## 변경

명시적인 `componentResolution`을 반환한 route의 기존 연결을 한 행씩 삭제하던 경로를 최대 500개 ID씩 묶었다. 같은 natural key는 한 번만 대상으로 잡고, 마지막 미완성 묶음도 새 edge 삽입 전에 처리한다. 기존 `CustomPlans`를 사용해 현재 키 목록으로 계획하고 호출자의 transaction-local 설정을 복원한다.

다음 경계는 유지한다.

- 현재 snapshot의 outgoing `CONTAINS → COMPONENT`, `CONSUMES → API_ENDPOINT`만 교체한다.
- UNRESOLVED도 이전 binding을 지우지만 marker 없는 draft와 이번 결과에 없는 route는 유지한다.
- 다른 snapshot, incoming FILE provenance, 다른 target type과 edge type은 지우지 않는다.
- 새 binding은 모든 정리 뒤 같은 트랜잭션에서 삽입한다. ambiguous 처리와 evidence 정책은 바꾸지 않는다.

공개 API·protocol·migration·index·보안 cap·source 검증은 변경하지 않았다. 기존 SQL의 generic plan이 전체 지연의 원인이라고 확정한 것은 아니며, 관측된 행별 반복을 제거하고 기존 bounded-lookup 규약을 적용한 변경이다.

## 실패 먼저 및 영향 범위 검증

| 증거 | 실제 결과 |
| --- | --- |
| `route-red/junit/test` | 1 FAIL. 정확한 edge 내용·snapshot 격리·설정 복원 assertion 뒤, JDBC 실행 1,219회가 `<100` 한도를 초과 |
| `route-green/junit/test` | 1 FAIL, 같은 1,219회. 편집 적용 실패 후 기존 제품으로 실행된 기록이며 이름과 달리 green이 아님 |
| `route-green2/junit/test` | 적용 후 같은 시험 1 PASS |
| `graph-target/test-totals.json` | GraphPersistenceRoundTrip·LookupPlan·GraphApi·GraphIdentityGuard 13/13 PASS, 실패·skip 0 |
| `route-accuracy/accuracyTest-totals.json` | 실제 loopback TS analyzer와 PostgreSQL의 React route binding 5/5 PASS, 실패·skip 0 |

새 영구 시험은 1,200개 route, duplicate draft, 마지막 묶음, 다른 snapshot, marker 없는 route, unresolved 제거, 새 component/API binding 및 incoming·다른 종류의 edge 보존을 정확한 전체 edge 목록으로 확인한다. 카운터는 JDBC execute 호출이며 네트워크 왕복 수가 아니다. 단일 통과 시험은 13개 영향 범위 시험에 포함되므로 중복 합산하지 않는다.

최초 로컬 러너가 추가로 복사한 `test-results/`에는 이전 build의 XML이 있다. 이번 결과 집계에는 격리 init script가 직접 쓴 `junit/`와 `*-totals.json`만 사용했다. 잘못 복사된 자료와 두 실패, Gradle loopback handshake 경고는 삭제하거나 통과로 바꾸지 않았다. 이후 러너의 오래된 결과 복사는 제거했다.

## 실제 제품 저장 서비스 smoke

KOwFxr 실행에서 보존한 **합성 전용** profile의 marker·runtime·backend PID·후보 및 원본 결과 hash를 대조했다. 멈춘 PostgreSQL 디렉터리를 각각 별도 COW 복제하여 기존 `GraphPersistenceProbe.java`로 변경 전후의 실제 제품 클래스를 실행했다. 설치 앱·실사용 profile·Keychain·자격증명은 사용하지 않았다.

`native-jdbc-old-baseline/result.json`, `native-jdbc-new-batched/result.json` 모두 `DIAGNOSTIC_COMPLETE`다. file ID를 경로로, edge endpoint를 natural key로 정규화한 전체 내용이 원본·변경 전·변경 후에 일치했다.

| 전체 canonical 내용 | 행 수 | SHA-256 |
| --- | ---: | --- |
| nodes | 182,214 | `39fde290f209eebdfc3cdb809d7d491692736a6161f0719ea3e7924c41f338f7` |
| edges | 317,483 | `996dff64e0aec386fde53d722fb6bd4496946e109fdeda7138a79f9002af6df1` |

각 실행에서 rollback, 원본 snapshot·디렉터리 inventory 불변, source postmaster 부재와 복제 서버의 정상 종료를 확인했다. 소유한 복제본의 private socket·임시 loopback 포트만 이용한 **정합성 전용, TLS 없는 진단**이다. 속도 개선율·실제 패키지의 독립 full 재분석 equality·성능 게이트 통과로 해석하지 않는다.

## 남은 판정

같은 제품 소스 c1b93c9의 2ogirS 후보에서 회귀 6,587 PASS·실패0·63 SKIP, 제품36·경합8 및 내부 보안 탐침을 확인했다. medium·large smoke-2는 진행 중이다. 최종20회·실제 Keychain·실계정·서명/공증·독립 C15·수작업 UX 등은 이 유닛의 결과로 승격하지 않는다. 사용자 입력은 기존 USER-INPUT-READINESS 기준으로 준비 상태만 보고한다. [후보 감사](candidate-2ogirs-2026-10-09.md).

후속 빌드의 공간 확보 과정에서 성공한 합성 DB 복제본 두 개와 합성 입력의 확장 PostgreSQL 디렉터리는 전체 복원·inventory 일치 검증 뒤 ZIP 보관으로 전환했다. 원본 불변은 위 진단 실행 시점에 확인한 사실이며, 현재 보관 위치·검증 범위는 [후보 감사 §5](candidate-2ogirs-2026-10-09.md#5-실패-보존과-합성-db-보관)에 기록했다. 실패·보고서·source fixture·다른 프로필 파일은 보존했다.
