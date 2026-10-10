# 출시 게이트 지연 후속 작업 — 2026-10-10

**NO_GO, 작업 진행 중.** PR #115/main `b0309e9616570438a75b49c931b3ec6448659291`에서 시작했다. 이전 lqudku와 보관 디렉터리는 불변이며 이전 PASS를 새 후보에 상속하지 않는다. 아래 비공개 증거는 COORD `validation/local/gate-latency-20261010/` 기준이다.

## 1. 소스 재사용의 중복 경로 검사

실제 production vault와 합성 메모리 wrapping으로 1,024개·각4KiB의 서로 다른 blob을 stage/barrier한 뒤128개씩 retain했다. 실사용 프로필·Keychain에는 접근하지 않았다. 기존 retain은 한 blob의 project/address와 파일 읽기에 같은 ancestor chain을 반복 순회했다.

| 진단 | 첫 회차 | 둘째 회차 | 셋째 회차 | 회차당 lstat |
| --- | ---: | ---: | ---: | ---: |
| 기존 vault-baseline-vRmo3G | 678.735ms | 645.996ms | 638.946ms | 69,168 |
| 변경 vault-guarded-path-vK2Dlm | 377.195ms | 356.190ms | 357.918ms | 29,232 |

읽기 전후 각각의 ancestor walk에서 project/address의 기대 identity를 함께 검사하도록 합쳤다. root부터 모든 ancestor의 symlink/type 검사, private UID/mode, project/address identity, O_NOFOLLOW 파일 열기, 파일 state 재검사, AEAD/hash/key 검증·실패 시 bytes zeroization은 유지한다. 이전 읽기의 검사를 캐싱하거나 source 검증을 생략하지 않는다. 경로 기반 검사를 descriptor-relative confinement으로 주장하지 않는다. Windows native-state 경로에도 동일한 읽기 전후 directory identity 계약을 유지한다.

추가한 directory 교체 경계2개는 기존 구현에서도 PASS했으며 최적화로 보안 경계가 약해지지 않게 보호한다. 변경 후 batch/Windows 모델36개, 나머지 vault/backup107개, 합계143개가 PASS했다. 실제 진단에서도 마지막 blob의 암호문 변조 거부와 합성 루트 정상 정리를 확인했다. Windows 모델 시험을 실제 Windows 네이티브 수용으로 대체하지 않는다. `vault-identity-before.log`, `vault-security-after.log`, `vault-other-contracts.log`에 결과를 보존했다.

이 값은 깊은 임시 프로필 경로의 소형 계측 진단이며 전체 packaged refresh의 SLO가 아니다. medium30초 목표 검증·새 후보 수용은 NOT RUN이다.

## 2. RSS 최소 관측과 실행 조건

`rss-reader-SFUJma/result.json`은 작은 Node owner를 대상으로 production reader를100회 실행했다. 두 ps 호출 중 discovery의 p95/max는51.037/54.586ms, targeted read는41.193/225.424ms였고 전체 최대271.203ms였다. 제품 large 부하 없이도250ms를 넘을 수 있음을 확인했다. OS 내부 지연의 정확한 원인은 아직 분리하지 않았다. 실제 PPID, 동일 번들의 XPC 범위·owner identity·수집 상한을 유지해야 하며 읽기 scope를 종료 권한으로 사용하지 않는다.

글로벌 탐색까지 libproc로 바꾸는 후보는 폐기했다. short BSD metadata에서도1,090개 중1개, executable path에서는26개를 읽지 못했고 그중25개는 같은 UID였다. 이 누락을 필터링하거나 통과 처리하지 않았다. 채택한 hybrid는 기존 전체 ps metadata 탐색과 owner/동일 번들 XPC scope 재검사를 유지하고, 이미 선택된 최대1,024개 PID의 RSS만 지속형 libproc helper에서 읽는다. 컴파일·READY는 측정/quiet admission 전에 끝내며 EOF·시간 초과·PID identity 변화·잘못된 응답은 실패 처리한다. fallback이나 수집 간격/SLO 완화는 없다. 종료용 process table과 권한은 변경하지 않는다.

실제 정식 worker smoke `rss-production-XAfxln/result.json`에서101개 표본을 수집했다. ANALYSIS 최대 gap104.722ms, 최대 read50.519ms, missing-owner0, failure null, samplingComplete true였다. main thread를650ms 동안 CPU 소비 없이 멈춰도 worker 수집이 지속됐다. CSV peak 합산/실제 PPID/외부 helper 제외와 두 소유 프로세스의 종료를 확인했다. 이 실행은 load1 5.00→6.73의 소형 진단이며 packaged large의 수용 증거가 아니다.

`rss-contracts.log`:64 PASS/0 FAIL/0 SKIP. 실제 macOS에서64MiB를 commit한 자식의 RSS 단위·증가량, admission 전 취소 시 helper 종료, 잘못된/중복/초과 PID 거부, 보존 binary 변조 거부를 확인했다. 기존 owner/XPC 정합성 및 불완전 RSS 거부 계약을 유지했다. startup/workload뿐 아니라 loader·egress·loopback ask의 공유 호출자도 명시적 reader 수명주기로 이관했다.

시작 시 AC·닫힌 덮개·load1 12.48·가용 약3.2GB를 관측했다. 새 build/medium/large의 기존 공간 진입 조건과 정식 quiet/open-lid 조건을 만족하지 못했다. 임의 삭제·부하 기준 완화 없이 소형 재현과 대상 시험을 진행했다. 최종20회와 사람 수용은 NOT RUN/준비 상태만 유지한다.

## 3. 실제 보존 패키지의 시작 진단

runner 소스37addef를 INT detached에서 실행하고, 제품 소스da6062e의 보존 후보lqudku는 변경하지 않았다. INT startup-probe/run-Gq9MCw는 warmup1회·진단3회 모두 PASS/정상 종료, CSV449개 표본과 run/idle peak 재집계 일치였다. 수집 중 최대 gap108.327/110.908/106.946/113.919ms, read 최대65.215ms다. 소유 helper도 네 회차 모두 종료했다. native lock/caffeinate·mock Keychain을 사용했고 소스/번들은 불변이다.

시작 전용 진단은 분석 작업을 제출하지 않아 XPC 귀속 행0이었다. 이를 XPC 누락 수정이나 large 수용 완료로 세지 않는다. 기존 시작 진단 계약은 SDK capture 전 공백을 제외하며 warmup 첫 표본 지연532.976ms도 기록됐다. 수집 중 gap이250ms 이내라는 결과를 전체 시작 순간의 완전한 관측으로 확대하지 않는다. 최초 XPC 행 요구 검증은 범위 불일치로 실패했으며 packaged-rss-xpc-unexercised.json에 남겼다. 최종 독립 재집계는 packaged-rss-proof.json이다.

## 4. 공간 확보 전 영향 회귀·보안·차단 기록

INT의 현재37addef에서 runners445 PASS/0 FAIL/0 SKIP, desktop3,280 PASS/0 FAIL/45 SKIP이다. 합계3,725 PASS는 이 두 영향 suite만의 실행 수이며 전체 통합 회귀나 새 후보 PASS가 아니다. 두 코드 커밋은 gitleaks8.30.1 탐지0, 기준main 대비 app.token-enc-key 합성 시험63파일 값·encoded/decoded 해시 불변을 확인했다.

검증된 retirement helper를 재사용해 이전 build-owzwMA/work만 기존 보관본candidate-build/work와 byte/exec/link inventory·소유권·identity·open-file 검사 후 제거했다. lqudku/baseline 앱·보고서·원본 CLAUDE.md·작업트리·보관본의 불변을 확인했다. 논리618,086,781B 사본을 제거했지만 가용량은3,117,268,992→3,119,833,088B로 관측됐다. clone 공유 블록 때문에 논리 용량만큼 공간이 회수되지 않으며 동시 쓰기도 있어 차액 전부를 배타적 회수로 주장하지 않는다. 첫 두 호출의 경로 오기 실패는 삭제 전에 멈췄고 기록을 보존했다. 최종 결과는 archived-build-cleanup-w0vd6tsa/result.json이다.

small3GiB·medium3.5GiB·large6GiB 및 새 후보 빌드6,845,104,128B의 기존 공간 기준을 낮추지 않았다. 이 시점의 새 후보, medium30초 재측정, large 분석/XPC 완전 수집, 실제 대규모 workload의 독립 fresh-profile clean-full은 공간 부족으로 NOT RUN이었다. 63파일 과거 oracle을 대체 수용하지 않는다. 최종20회는 기술 게이트와 quiet AC/open-lid 조건이 충족된 최종 후보에서만 실행한다. push/PR/병합·마지막 증거 보관은 아직 하지 않았다.

USER-INPUT-READINESS의 실계정/SSO, 서명 자격, 두 번째 Mac/업데이트, 독립 보안·정확도 평가, UX/VoiceOver, 법률 판단은 준비 상태만 유지한다. SourceLace·Relowick·Maprill의 상표/도메인은 미검증이며 이름·로고·appId·프로필을 바꾸지 않았다. 표시 이름·아이콘과 appId/profile 변경은 분리해 최종 후보 전에 결정해야 한다. appId/profile 변경은 설치 identity·XPC 서비스 식별·격리 Validation/Acceptance identity·사용자 데이터 경로·서명·업데이트 연속성의 이관과 재검증을 요구한다. Sol6.1 high 설정과 native-turn WebSocket 설정의 대화형 승인 미완료를 해결된 것으로 가정하지 않고 서브에이전트0개로 직접 처리했다.

## 5. 사용자 승인 캐시 정리와 검증 재개

읽기 전용 조사 결과는 disk-inventory-AU3R4k/candidates.json에 보존했다. 사용자가 명시적으로 승인한 Xcode의 iPhone18,3 26.5.2 (23F84) 기기 지원 폴더와 Arc Sparkle Installation 업데이트 캐시만 삭제했다. Docker 이미지·컨테이너·볼륨, 설치 앱, 브라우저 프로필, 소스, 실사용 데이터, 실패 프로필, 이전 보관본은 삭제 대상에서 제외했다.

기존 hash-pinned retirement helper를 재사용하고 exact allowlist·canonical 소유권·내부 symlink·metadata/identity·열린 파일 검사를 적용했다. parent FD/O_NOFOLLOW 및 descriptor-relative rmtree를 사용했으며 경계 smoke5개(허용, 범위 밖, identity 교체, 열린 파일, 외부 symlink)를 실제 실행해 모두 PASS했다. native lock/caffeinate 아래 두 승인 경로의 소멸과 보호 대상 identity·원본 CLAUDE.md 해시 불변을 확인했다. approved-cache-cleanup-p1j80sjp/result.json은 APPROVED_CACHES_REMOVED이며 여유 공간은2,317,410,304→10,108,686,336B였다. 동시 호스트 쓰기·APFS 공유 블록 때문에 차액을 배타적 회수량으로 보장하지 않는다.

공간 차단 해제 후 INT detached37addef의 전체 통합 회귀를 gate-latency-regression-37addef-20261010에서 완료했다. frontend480·TypeScript analyzer318·runners445·desktop3,280·backend2,066·events19, 합계6,608 PASS·0 FAIL·63 SKIP이며 frontend 타입 검사도 PASS다. backend/events는 cleanTest로 실제 재실행했고 Docker 소유 리소스 정리·기존 컨테이너 보존을 검증했다. integrated-regression-37addef.json이 개별 로그·결과 해시와 합산을 연결한다.

새 후보mV5bkc는 제품 소스37addef, baseline tZgvV7, xpc-required, build sequence1791609502627이다. INT pre-release-candidate/build-Wk8Wva/result.json은 PACKAGED_NOT_RELEASED·sourceWorkingTree false·sourceAndBaselineUnchanged true이며 app.asar SHA256은9858a908ddd105a638582f53395e9ea4aeee99cf3dfa5906fc31f8df8d8d6022, manifest SHA256은c2b7bfdc7eb68576dae7914d053567b6aab79cd9672811c8f244a8b78a48f726이다. 정식 서명·공증·배포는 하지 않았다. 이 시점에는 패키지 검증이 진행 중이었고 medium/large 및 대규모 canonical은 NOT RUN이었다. 캐시 삭제로 정식 성능 측정의 부하·AC·덮개 조건까지 충족됐다고 간주하지 않는다.

## 6. mV5bkc 패키지 검증, medium 진단, 최소 계측과 그래프 중복 쓰기 제거

mV5bkc의 영향 패키지 검증은 INT `validation/local/` 아래에서 완료했고 packaged-mv5bkc-proof.json이 결과 파일·SHA256을 연결한다. 제품 시나리오 product-eS13CI 36 PASS·native-clean-shutdown, 소유 앱 강제 종료 복구 native-P9df19/native-mj34jh 각6 PASS(의도적 SIGKILL1회+정상 복구2회), job race product-d3Q5Ex 8 PASS, 내부 보안 packaged-Vv6DA5 COMPLETE(독립 심사 아님), 자동 UX ux-pi9GxJ 190screens·machine/page errors0·consoleErrors2(사람/VoiceOver 수용 아님), loader loader-bEwG1z 단일 Mac 근사 PASS, AI OFF egress probe-up7m1j PASS, 합성 loopback ask ask-1JOO71 PASS다. 모두 미커밋 그래프 수정 전 소스37addef의 결과다.

medium 진단 run-qYRPKu는 첫 분석139.146초, 1% refresh58.046초(job57.529초; IMPORT11.075·SOURCE_PARSING12.215·TS_PARSING22.279·GRAPH_BUILD3.677초)로 목표30초 미달이다. 분석 RSS 최대 gap372.345ms·read323.071ms로250ms 계약을 넘어 INCOMPLETE이며, 둘째 회차는 앱 시작 전 DISK_SPACE_LOW로 행이 없다. 닫힌 덮개·고부하 DIAGNOSTIC_ONLY/INVALID_LOAD/exit1이므로 정식 SLO 측정이 아니고, 새로운 ANALYSIS_FAILED 재발로도 기록하지 않는다. 실패 증거 `/private/tmp/ciwl-0G7d3R`, `/private/tmp/ciwp-B8usnf`는 보존했다.

최소 계측으로 세 경로를 분리했다. 소스 manifest SQL(manifest-sql-npb7knfg)은 500행 JDBC batch를 multi-values로 바꿔도 warm 약50→31~35ms 절감에 그쳐 제품에 적용하지 않았다. TypeScript 캐시(adapter-cache-7sERPh)는 10,000파일/50MiB에서 5,499 entries 전부 보존·decodeFailures0·과금15,771,406B<16,777,216B로 용량/압축해제 실패를 배제했고, 키 불일치의 주원인(실제 전이 의존성 대 whole-manifest 폴백) 분리는 미완료다. 그래프 저장(graph-sql-qpz05x0m)은 소형 원본의 복제 DB에서 실제 GraphPersistenceService가 기존 storedDrafts를 candidates 앞에 붙여 다시 upsert해 replay의 node INSERT가44→88회가 되는 비용을 확인했다.

이에 `GraphPersistenceService.persist`를 수정했다. 기존 저장 행은 GraphIdentityGuard.sanitize의 충돌 판정에 그대로 참여하되, sanitize 결과의 기존 prefix 중 AMBIGUOUS 대표만 저장 대상에 남기고 변하지 않은 기존 노드는 다시 쓰지 않는다. 이 보존은 `uq_graph_nodes_snapshot_natural_key`로 stored 키가 유일해 sanitize가 prefix를 1:1 순서로 유지한다는 점과 AnalysisResult의 `List.copyOf`에 의존하며, 기존 노드로 향하는 edge는 기존 `storedNodeIds` 조회로 해석된다. GraphApiIntegrationTest의 `laterAnalyzerCannotOverwriteEndpointSourceFromAnotherModule`을 세 번째 경로 선언과 무관한 기존 METHOD 부분 갱신으로 보강했다(candidateFiles3개, name/revision, AMBIGUOUS file/edge 제외). COORD 작업트리에서 대상 네 클래스만 run-targeted-graph.cjs(기존 Docker 드라이버의 private HOME/offline Gradle/spotlessCheck/cleanTest 유지)로 실행해 GraphIdentityGuardTest2·GraphPersistenceRoundTripTest3·GraphPersistenceLookupPlanTest2·GraphApiIntegrationTest6, 합계13 PASS·0 FAIL·0 SKIP, 소유 컨테이너 정리·기존 컨테이너 보존을 확인했다(targeted-graph-azKaDr, docker-integration/backend-RuSJGp). 첫 실행 targeted-graph-FycXsH는 테스트 파일 spotless 형식 위반으로 시험 전에 실패했고 `spotlessApply`로 형식만 고쳤다.

after 계측 graph-sql-after-c8p73ves는 COORD 작업트리 class(capture graph-jdbc-capture-coord-89476ec-dirty-v2, toolchain JDK21, GraphPersistenceService.class만 before와 다름)를 같은 복제 절차와 입력(21,892 nodes/38,104 edges/18,997 evidence)에 적용했다. fresh 2.120/1.926/1.812초는 before 2.166/1.805/1.879초와 같은 범위다. replay는 node-upsert 88→44회(약1,063~1,187→501~555ms), persist 4.463/4.244/4.302→3.714/3.474/3.641초로 줄었다. 6회 모두 node/edge/evidence canonical 동일, rollback, 원본 cluster inventory·보호 파일 불변, clone PG exit0이다. after 실행의 load1은5.36으로 before3.60보다 높았다. 남은 replay 비용은 stored-drafts 44회 약0.95초와 route-binding-delete 약0.2~0.3초이며 이 수정의 범위가 아니다. 이 진단은 최종 snapshot 그래프 전체를 입력으로 한 저장 경로 측정이고 medium GRAPH_BUILD3.677초의 일부만 설명하므로 30초 달성 근거가 아니다.

이 수정은 소스 변경이므로 mV5bkc의 회귀·패키지 PASS를 상속하지 않는다. 새 소스의 통합 회귀, 새 후보, 영향 패키지, medium/large smoke, 대규모 실제 앱 incremental 대 fresh-profile clean-full 비교는 NOT RUN이며 NO_GO를 유지한다.

## 7. medium 1% refresh SLO 조정 — 사용자 결정

사용자는 30초가 다른 방법으로 닿을 수 없다면 목표를 현실적인 범위로 조정해 진행하라고 결정했다. 30초가 증명 가능하게 불가능한 것은 아니지만, 현재 설계의 국소 최적화로는 닿을 수 없다는 근거는 다음과 같다.

| 후보 | medium 1% refresh(초) | 조건 |
| --- | ---: | --- |
| h7hpw4 (2026-10-08) | 185.738 / 183.732 | 진단 |
| p6yGme (2026-10-08) | 110.086 / 108.495 | 진단 |
| XPhUTE (2026-10-08) | 86.848 / 89.946 | 첫 회차 기록 시점 load1 3.14, 둘째 INVALID_LOAD |
| kOwFXr (2026-10-09) | 79.094 / 80.364 | 실행 직전 load1 3.37/3.68 |
| lqudku (2026-10-09) | 56.876 / 59.867 | INVALID_LOAD/닫힌 덮개 진단, RSS 완전 |
| mV5bkc (2026-10-10) | 58.046 | 닫힌 덮개·고부하 진단, RSS INCOMPLETE |

연속된 최적화로 185→58초까지 줄었지만 최근 두 후보는 같은 범위에서 멈췄다. 남은 비용 IMPORT 11.1·SOURCE_PARSING 12.2·TS_PARSING 22.3초는 변경량(1%)이 아니라 저장소 크기에 비례한다. small 1,200파일의 refresh 6.618초(IMPORT 1.423/SOURCE 1.536/TS 2.499)에 대해 medium 10,000파일은 파일8.3배에 시간8.8배이며 세 단계가 각각 약8배다. 즉 각 단계가 전체 저장소 규모의 일을 다시 하고 있다. 30초에 닿으려면 세 단계 중 최소 두 단계를 변경 비례로 바꿔야 하는데, 신뢰 경계의 source-store 검증 생략·invalidation 불명 시 full fallback 제거·TS 전이 의존성 계약 축소는 모두 금지된 정확성 위험이고, 단계별 증분 설계는 출시 게이트 안에서 끝낼 수 없는 설계 변경이다. graph 중복 쓰기 제거(§6)의 약0.6~0.75초, manifest SQL 약18ms, TS 캐시 용량 배제(§5.3)도 이를 바꾸지 않는다.

조정 내용: 05 §4의 증분 행과 `validation/pre-release/workload-metrics.cjs`의 `incremental.medium`을 p95≤30,000ms→≤90,000ms로 바꿨다. 90초는 medium 초기 분석 예산180초의 절반이며, 증분이 전체 분석보다 최소 두 배 빨라야 한다는 요구를 유지한다. 결과 full 동일(`resultEqualsFull`) 요구, 20회 p95, quiet AC/open-lid 조건, INVALID_LOAD 제외는 그대로다. 30초는 단계별 변경 비례 증분 설계 뒤의 R1 목표로 남긴다. 최근 진단값 56.9~59.9초는 조정된 값 안에 있지만 정식 조건의 20회가 아니므로 G-PERF PASS로 바꾸지 않는다.

## 8. 새 소스 b320614의 회귀, 후보 SiP1VX, 패키지 검증

INT detached를 `b320614`로 옮기고 전체 통합 회귀를 gate-latency-regression-b320614-20261010에서 실행했다. frontend480·TypeScript analyzer318·runners445·desktop3,280(+45 SKIP)·backend2,066(+18 SKIP, docker-integration/backend-6cPCHV)·events19(events-l6xogM), 합계 **6,608 PASS·0 FAIL·63 SKIP**, frontend 타입 검사 PASS다. integrated-regression-b320614.json이 로그·증거 해시를 연결한다. COORD 작업트리에서 돈 runners 444 PASS/1 FAIL은 이 체크아웃 tree-analyzer node_modules의 proxy-addr 2.0.7 사본(INT는 2.0.8) 때문이며 소스 변경과 무관하다.

후보 빌드 전 공간은 6,693,351,424B로 예산 6,845,104,128B에 미달했다. 사용자가 승인한 범위만 정리했다: 이 라운드의 private PostgreSQL 진단 clone 4개(graph-sql-qpz05x0m, graph-sql-after-c8p73ves, manifest-sql-npb7knfg, manifest-sql-psc8o68a의 `postgres/` 디렉터리, result.json·로그·probe 출력 보존). 각 clone의 닫힘(postmaster.pid 없음·열린 파일 없음)·소유·result의 `sourceInventoryUnchanged`를 확인하고 삭제 전후 원본 cluster inventory 해시가 같음을 확인했다(approved-clone-cleanup-dr9q74m_, 6,697,422,848→8,071,114,752B). 첫 시도 7h2wtlzl은 tuple/list 비교 오류로 삭제 전에 멈췄고 기록을 보존했다.

새 후보 **SiP1VX**는 build-9ssFKs, source `b320614`, baseline tZgvV7, xpc-required, build sequence1791617519928, PACKAGED_NOT_RELEASED·sourceWorkingTree false·sourceAndBaselineUnchanged true, Java 재컴파일(manifest SHA256 `c033ce9ceef3d4dd2b8fea20d105088d45812cab23c84aa8c7bc0757e78934bb`, app.asar는 mV5bkc와 동일 `9858a908…6022`)이다. 정식 서명·공증·배포는 없다.

영향 패키지 검증은 run-stage5.sh로 native lock 직렬화해 실행했다. 첫 실행(stage5-SiP1VX)에서 product·job-race·ux-pilot은 대화형 셸 환경의 `GITHUB_PERSONAL_ACCESS_TOKEN` 변수를 `validateLocalEnvironment`가 거부해 시작 전 exit1이었다(값은 읽지 않았다). 변수를 제거한 환경(run-stage5-v2.sh)으로 재실행해 product-bXuiGf 36 PASS·native-clean-shutdown, job-race product-xRxoRk 8 PASS, ux-bjDBHa 190screens·machine/page errors0·consoleErrors2를 확인했다. 첫 실행에서 통과한 것은 소유 앱 강제 종료 복구 native-9YHKzR/native-9GmVlp 각6 PASS, 내부 보안 packaged-rrFzfh COMPLETE, loader loader-pXjH91 PASS, AI OFF egress probe-Wsz4Nu PASS다. **egress-ask 첫 실행 ask-twXF1v는 FAIL(NON_LOOPBACK_SOCKET)**: after-ask 표본에 peer `[::127.0.0.1]:51208`이 남았고 probe의 LOOPBACK 분류(`127.x`, `::1`, `localhost`)가 IPv4-호환 IPv6 표기를 loopback으로 인정하지 않는다. 표본은 peer 문자열만 기록하므로 프로세스·명령을 귀속할 수 없다. 공식 재실행 ask-eRxQM0은 PASS(remote 0)였다. 첫 실패를 해명된 것으로 바꾸지 않고 단일 미해명 관측으로 보존한다. probe가 peer의 명령/PID를 함께 기록하도록 보강하는 것은 후속 과제다. 병합 로그 stage5-SiP1VX-final과 packaged-sip1vx-proof.json(VERIFIED_PACKAGE_SCENARIOS)이 결과 파일·해시·앱 identity를 연결한다.

medium smoke는 첫 시도에서 DISK_SPACE_LOW(2,739,904,512B<3,758,096,384B)로 차단됐다. 소비처는 PASS 러너들이 `/private/tmp`에 남긴 작업 트리(2026-10-06부터 누적 약35GB)와 새 빌드 work의 node_modules 복제본이었다. 사용자 승인에 따라 (1) build-9ssFKs/work의 desktop·ts-analyzer node_modules를 기존 검증 retirement 절차로 정리했고 frontend 사본은 불일치로 거부됐다(candidate-dependency-cleanup-s6mh_tkk, 2,740,469,760→3,174,969,344B), (2) cnpc/cnjr/cnux 루트와 context.json의 isolatedRunParent(cnpr/cnjp/cnur)를 result.json 참조와 매칭해 PASS/COMPLETED 실행에만 속하는 40건을 제거하고 FAIL·COMPLETED_WITH_STEP_FAILURES 참조 12건은 보존했다(approved-runner-work-cleanup-cttz418q 계획, approved-runner-work-cleanup-u5o9byxt 적용: 3,173,773,312→35,071,643,648B). workload 프로필(ciwp/ciwl)·소스 프로필(cica)·실패 증거는 건드리지 않았다.

## 9. SiP1VX medium 진단

INT workload-performance/run-5wfWqC(`--class medium --smoke-2 --diagnostic-only`, 닫힌 덮개·load1 약4~7)의 두 회차는 초기 분석·graph·1% 갱신·취소 모두 기능 PASS, cleanupConfirmed, 소스/번들 불변이다. medium-sip1vx-verification.json이 결과·CSV 해시와 phase peak 재집계 일치(xpc rows1,163·launchd rows583)를 연결한다.

| 관측 | 첫 회차 | 둘째 회차 | mV5bkc qYRPKu | 판정 범위 |
| --- | ---: | ---: | ---: | --- |
| 초기 분석 | 132.085초 | 128.443초 | 139.146초 | 기능 완료, 정식180초 p95 미판정 |
| 1% refresh | 50.865초 | 50.825초 | 58.046초 | 조정 게이트90초 이내 관측, 정식20회 아님 |
| refresh GRAPH_BUILD | 2.840초 | 2.830초 | 3.677초 | §6 중복 쓰기 제거와 방향 일치 |
| refresh IMPORT / SOURCE_PARSING / TS_PARSING | 10.589/10.700/20.883초 | 10.490/10.789/20.892초 | 11.075/12.215/22.279초 | 저장소 크기 비례 비용 유지 |
| 분석 RSS peak(phase) | 3,618,304KiB | 3,574,400KiB | 3,593,792KiB | 전체 앱 범위 진단, 정식4GiB 수용 아님 |
| 전체 run peak(INCREMENTAL phase) | 4,457,376KiB | 4,434,048KiB | 4,577,904KiB | 증분 행에는 RSS 상한이 없고 이전과 같은 범위 |
| 분석 RSS 최대 간격 | 252ms | 122ms | 372ms | 첫 회차 INCOMPLETE(2ms 초과), 둘째 완전 |

전체 상태는 DIAGNOSTIC_ONLY / INCOMPLETE / exit1이다. 50.9초는 조정된 90초 안에 있지만 정식 조건(AC·덮개 OPEN·load1<4 연속 확인·20회 p95)이 아니므로 G-PERF PASS가 아니다. refresh 비용 감소는 GRAPH_BUILD 약0.8초 외에 CROSS_DOMAIN 2.401→0.358초 등 소스 변경과 무관한 단계에서도 나타나므로 전부를 이번 수정 효과로 돌리지 않는다. 첫 회차 RSS 간격252ms는 §2의 전역 `/bin/ps` metadata 읽기 지연이 그대로 남아 있음을 뜻하며, 이번 라운드에서는 손대지 않았다.

## 10. SiP1VX large 진단

INT workload-performance/run-xQdyTC(`--class large --smoke-2 --diagnostic-only`, 닫힌 덮개)는 두 회차 모두 기능 PASS·cleanupConfirmed·소스/번들 불변이고, **measurementStatus=COMPLETE**로 warmup 시작 단계와 두 분석 단계의 RSS 수집이 처음으로 완전했다(분석 최대 간격150/118ms, read122/68ms). large-sip1vx-verification.json이 결과·CSV 해시와 phase peak 재집계 일치를 연결한다.

| 관측 | 첫 회차 | 둘째 회차 | lqudku run-2GC1wA | 판정 범위 |
| --- | ---: | ---: | ---: | --- |
| 초기 분석 | 506.467초 | 504.254초 | 530.995/516.662초 | 기능 완료, 정식600초 p95 미판정 |
| 1% refresh | 361.486초 | 361.671초 | 386.367/385.436초 | large refresh SLO 없음 |
| 초기 IMPORT / SOURCE_PARSING / GRAPH_BUILD / TS_PARSING | 79.6/224.1/58.3/115.2초 | 77.0/223.1/58.3/115.7초 | — | 저장소 크기 비례 |
| refresh IMPORT / SOURCE_PARSING / GRAPH_BUILD / TS_PARSING | 50.2/150.9/19.2/111.7초 | 50.8/149.9/19.3/111.9초 | — | 저장소 크기 비례 |
| 분석 RSS peak(phase) | 4,901,232KiB | 5,051,312KiB | — | 6GiB(6,291,456KiB) 이내 관측, 정식 수용 아님 |
| 전체 run peak(INCREMENTAL phase) | 6,208,480KiB | 6,352,672KiB | — | 증분 행에는 RSS 상한이 없으나 6GiB를 넘는 관측이므로 별도 기록 |
| 취소 후 release | 117ms | 117ms | — | 진단 관측 |

이전 lqudku large 둘째 회차의 RSS 공백756ms가 재현되지 않았다는 사실은 이번 호스트 상태에서의 관측이며 OS 지연 원인이 해결됐다는 주장이 아니다. 시간은 모두 DIAGNOSTIC_ONLY이고 최종20회는 NOT RUN이다. 증분 단계의 전체 앱 RSS가 6GiB를 넘는 관측은 05 §4의 증분 행에 RSS 상한을 둘지 결정해야 할 열린 항목으로 남긴다.

## 11. 대규모 실제 앱 incremental 대 clean-full canonical — FAIL

INT gate-latency-20261010/canonical-large-njoo6i(`run-canonical-large.cjs`, SiP1VX, large 50,000파일/1% 500개 변경+route·React 버전·u0.js 삭제, incremental 앱과 별도 fresh-profile clean-full 앱 모두 정상 종료·cleanupConfirmed, 삭제·변경 전파 확인)는 **FAIL / CANONICAL_DIFFERENCE / resultEqualsFull=false**다. 21범주 중 20범주(files 49,999·nodes 768,168·edges 1,351,932·evidence 등)는 count·SHA256이 같고 **flowSteps만** 행 수105,973 동일·내용 불일치다. 차이는 BACKEND flow 10개(`POST /api/items{1233,1754,1818,2325,2368,2422,3058,3329,3392,3494}`)에서 같은 두 호출 대상(`Item…Service#describe(Object)`와 `Item…Dto#id()`)의 `seq` 4/5가 서로 바뀐 20행뿐이다.

원인은 `FlowDetectionStep.load`가 `graph_nodes`/`graph_edges`를 ORDER BY 없이 읽고, `backendSteps`의 BFS가 인접 edge 목록 순서(실질적으로 행 삽입 순서)를 그대로 따르는 데 있다. 증분 갱신에서 변경 파일의 edge가 삭제·재삽입되면 같은 호출자의 형제 CALLS edge 순서가 clean-full과 달라지고, 그 순서가 `flow_steps.seq`라는 의미 데이터로 저장된다. 이는 이번 소스 변경(§6)과 무관한 기존 비결정성이며, 소형 canonical(63·1,200파일)에서는 드러나지 않았고 대규모 본 실행은 이번이 처음이다. 수정과 재검증은 다음 항목에 기록한다.

## 12. flow step 순서 결정성 수정

`FlowDetectionStep.load`가 그래프를 읽은 뒤 `nodesByType`의 노드를 natural key로, 각 노드의 out/in 인접 edge를 (edge type, 상대 노드 natural key)로 정렬하도록 했다. `(snapshot_id, source, target, edge_type)`이 유일하고 natural key가 snapshot 안에서 유일하므로 정렬에 동률이 없고 edge id는 쓰지 않는다. 걷기 알고리즘·깊이·단계 수 제한·evidence는 바꾸지 않았다. DetectionPersistenceRoundTripTest에 같은 그래프의 형제 CALLS edge를 반대 순서로 저장한 두 스냅샷의 flow step 열이 같고 natural key 순서임을 확인하는 `flowStepOrderDoesNotDependOnEdgeStorageOrder`를 추가했다. 기존 시험과 골든은 step을 집합·개수로 검사하거나 선형 체인이라 영향이 없다.

대상 실행(run-targeted-v2.cjs, Docker 드라이버·cleanTest): 첫 실행 targeted-8SbTBb는 골든·flow 시험 26 PASS, 새 시험 1 FAIL — 같은 프로젝트에 활성 job을 두 번 만든 시험 구성 오류(`uq_analysis_jobs_active_per_project`)로 제품 수정과 무관했다. 스냅샷마다 프로젝트를 분리한 재실행 targeted-YQhSpo는 DetectionPersistenceRoundTripTest 2·FlowStepVerdictIntegrationTest 2·FullstackCrossDomainGoldenTest 1 = 5 PASS·0 FAIL이다. FixtureGoldenTest 9·ConfigAnalyzersGoldenTest 5·SpringMiniEndpointsFeaturesGoldenTest 3·SpringMiniGraphGoldenTest 3·ReactMiniTsParsingGoldenTest 2는 첫 실행에서 같은 제품 코드로 PASS했다.

이 수정은 소스 변경이므로 SiP1VX의 회귀·패키지·진단 결과를 상속하지 않는다. 새 소스의 통합 회귀, 새 후보, 영향 패키지, medium/large smoke, 대규모 canonical 재실행은 다음 항목에 기록한다.

## 13. 소스 3a6ec0a의 회귀, 후보 bPN1sU, 패키지·진단

run-chain.sh로 INT detached를 `3a6ec0a`로 옮기고 체인을 실행했다. 첫 통합 회귀(gate-latency-regression-3a6ec0a-20261010)는 7개 suite 모두 시험 실패 0이었으나 backend Docker 드라이버가 **REVIEW_REQUIRED**였다. 실행 중 새 컨테이너 2개(postgres:17-alpine, testcontainers ryuk, 세션 432abada…)가 관측됐는데 이 저장소의 시험은 pgvector/pgvector:pg16·redis:7-alpine만 쓰고, 같은 시각 다른 프로젝트 작업트리(jinju-companion-bus)의 Gradle `bootTest`가 이 호스트에서 돌고 있었다. 드라이버는 남의 컨테이너를 입양·삭제하지 않으므로 검토 상태로 끝났고, 그 컨테이너는 외부 작업 종료 후 사라졌다. backend suite만 같은 드라이버로 재실행(docker-integration/backend-8nwLdg, PASS_EXECUTED_WITH_EXPLICIT_SKIPS, 기존 컨테이너 불변·새 컨테이너 잔존0)해 병합 root gate-latency-regression-3a6ec0a-20261010-merged를 만들었고 integrated-regression-3a6ec0a.json은 frontend480·TypeScript analyzer318·runners445·desktop3,280(+45)·backend2,067(+18, 새 결정성 시험 포함)·events19, 합계 **6,609 PASS·0 FAIL·63 SKIP**, 타입 검사 PASS를 기록한다.

후보 **bPN1sU**는 build-AZJ6T6, source `3a6ec0a`, baseline tZgvV7, xpc-required, build sequence1791625425279, Java 재컴파일(manifest SHA256 `3bd740fcaa868643c8d2bcd91f5c5184a4ec5f6b35daccd29013016e3c6125e8`, app.asar 동일 `9858a908…6022`), PACKAGED_NOT_RELEASED다. stage-5(run-stage5-v2.sh, stage5-bPN1sU)는 한 번에 9개 모두 통과했다: product-nHstUt 36 PASS, native-lJCgKJ/native-6IVCmP 각6 PASS, job-race product-awMDUg 8 PASS, 내부 보안 packaged-ON2IEU COMPLETE, ux-Paxdr4 190screens·errors0·consoleErrors2, loader-EeVYWA PASS, egress-off·egress-ask PASS(remote 소켓0). packaged-bPN1sU-proof.json이 결과·해시·앱 identity를 연결한다.

진단 smoke는 다른 세션의 Gradle 작업과 겹친 고부하 구간에서 돌았다. medium run-w9EfH7: 초기 136.499/140.338초, refresh **55.109/57.756초**(GRAPH_BUILD 2.955/4.547초, TS 22.755/21.800초), 분석 RSS gap 124/487ms로 둘째 회차 INCOMPLETE. large run-l0EyAj: 초기 546.961/543.401초, refresh 433.680/402.192초, 분석 RSS gap 601/498ms로 두 회차 INCOMPLETE, 분석 peak 4,920,016/5,210,272KiB. 둘 다 DIAGNOSTIC_ONLY/INCOMPLETE이며 SiP1VX 진단(§9·§10)보다 느린 것은 소스 차이(flow 정렬은 FLOW_DETECTION 단계뿐)가 아니라 호스트 부하 차이로 본다. 정식 조건의 20회가 아니므로 어느 쪽도 SLO 판정에 쓰지 않는다.

canonical 대규모 비교 첫 실행 canonical-large-v9eVLf는 incremental 앱 완료 뒤 clean-full 앱 실행 중 **DISK_SPACE_LOW**로 FAIL했다(시작 시 가용 9,095,311,360B). 이 라운드의 medium/large 진단이 INCOMPLETE로 프로필·fixture 약11GB를 FAILURE_EVIDENCE로 보존한 것이 직접 원인이다. 사용자 승인에 따라 retire-retained-profiles.py로 보존 프로필/fixture 복사본 16개(이번 라운드 cica-B8Ljyx·cica-8ETiVd·ciwp-RvM2sp·ciwl-7V7B6V·ciwp-ndVmEI·ciwl-UZMjgE와 이전 라운드 run-gapJPc·run-XBkM4L·run-TsY7ff·run-u0KBxm·run-5wfWqC의 profiles/fixture)를 제거했다. 각 대상은 소유·닫힘과 result.json의 retainedWork/work 참조를 확인했고, result.json·resource-samples.csv·canonical NDJSON 출력(canonical-large-njoo6i의 incremental/clean-full 23파일 존재 확인)은 보존했으며 mV5bkc 실패 증거 ciwp-B8usnf/ciwl-0G7d3R는 제외했다(approved-profile-cleanup-c51adby5, 가용 3,074,715,648→약31.2GB). 재실행 결과는 다음 항목에 기록한다.

## 14. 대규모 실제 앱 incremental 대 clean-full canonical — PASS

INT gate-latency-20261010/canonical-large-I0B1GR(bPN1sU, source `3a6ec0a`, large 50,000파일/1% 500개 변경+route·React 버전·u0.js 삭제)는 **PASS / resultEqualsFull=true**다. incremental 앱(초기 분석+갱신)과 별도 fresh-profile clean-full 앱 모두 정상 종료·cleanupConfirmed이고 삭제·변경 전파가 확인됐다. 21범주 전부 count와 C 정렬 NDJSON SHA256이 같다: files 49,999·nodes 768,168·edges 1,351,932·endpoints 19,495·entities 4,499·routes 4,249·features 7,249·featureLinks 37,241·flows 23,744·**flowSteps 105,973**·findings 4,499·sourceEntries 49,999·evidence 695,657, unknown/dangling evidence 0. §11에서 유일하게 어긋났던 flowSteps가 §12 수정 뒤 일치했으므로, 대규모 실제 앱의 증분 결과가 clean-full과 동일하다는 06 §5 계약을 이 후보에서 실제로 확인했다. 시간 판정은 NOT_APPLICABLE_DIAGNOSTIC이며 SLO 수용이 아니다.

## 15. RSS 전역 metadata 지연 — ps 제거와 native 열거(5b562f5)

§2·§9·§13의 분석 단계 RSS 간격(122~601ms)은 선택 PID 읽기가 아니라 매 frame의 전역 `/bin/ps -ww -axo pid=,ppid=,comm=` 호출에서 왔다. 이번 호스트(load1 2.6~4.0, 약1,090 프로세스)에서 다시 잰 값: 전체 테이블 ps 45~50ms, **실패 PID 26개만 `ps -p`로 읽어도 47~50ms**(ps의 비용은 행 수가 아니라 호출당 고정), 단일 PID `ps -p` 3ms, native 열거(proc_listallpids+PROC_PIDT_SHORTBSDINFO+proc_pidpath) 2.7~3.8ms. 인계 §7이 제안한 "native 열거+실패 PID만 ps 보완"은 ps 호출당 비용 때문에 효과가 없어 채택하지 않았다.

native 열거에서 path를 못 읽는 PID는 26개(모두 live, 25개는 같은 UID)였고 전부 실행 파일이 교체·삭제된 프로세스(errno 2)다. `/bin/ps`(setuid root)는 이 경로를 `KERN_PROCARGS2`의 exec path에서 읽는다. 같은 출처를 helper가 직접 읽으면 25개가 복구되고, 남는 1개는 다른 UID(root)의 프로세스로 비특권 helper는 인자 영역을 읽을 수 없어 kernel 짧은 이름만 남는다. 짧은 이름 추정을 bundle 귀속에 쓰지 않도록 행에 출처를 붙였다.

변경(`validation/pre-release/native-rss.c` 프로토콜2, `native-rss.cjs`, `process-memory.cjs`):
- helper `D` 명령이 모든 live PID를 `<pid> <ppid> <source> <executable>`로 돌려준다. source P=proc_pidpath, A=인자 영역 exec path(argv[0]이 아니라 kernel이 기록한 exec path), C=짧은 kernel 이름(다른 사용자 프로세스). 열거 도중 사라진 PID는 두 번째 metadata 읽기가 ESRCH일 때만 생략하고, 그 밖의 실패는 frame 실패(exit 3)다. 모든 행은 제어문자 검사·PID 중복 검사·50,000행/2MiB 상한을 통과해야 한다.
- `readOwnerMemory`는 per-frame ps를 더 쓰지 않는다(`discover`·`readSelected` 둘 다 필수). C 행은 PID/PPID 자손 추적에만 참여하고 owner 동일 실행 파일 모호성 검사·XPC bundle prefix 매칭에서는 제외한다. owner 자신은 path가 있어야 하며(`MEMORY_OWNER_PATH_UNAVAILABLE`) 선택 RSS 읽기도 같은 path 보완을 쓰므로 owner identity 비교의 출처가 같다. ux pilot/startup benchmark의 phase 사이 liveness 검사(`readProcessTable`, pid/ppid만)는 그대로 ps다.
- 이 수집 scope는 읽기 전용이며 프로세스 종료 권한이나 인가 경계로 쓰지 않는다(§2 계약 유지).

검증: `process-memory.test`·`native-rss.test` 22 PASS. 새 시험은 삭제된 실행 파일(소유 C 프로그램을 실행 뒤 unlink)의 PID가 A 출처로 남고 RSS 행이 유지됨, C 행이 자손 추적만 하고 bundle 귀속을 못 함, owner path 부재 거부를 확인한다(시스템 바이너리 사본은 unlink 시 SIGKILL되어 시험 대상으로 쓸 수 없었다). COORD runners 전체 450/451 PASS(1 FAIL은 §13의 COORD `proxy-addr` 2.0.7 stale node_modules 환경 문제, INT에서는 PASS). 소형 진단 `P/rss-discovery-AwOcMW/result.json`(소유 node 프로세스1개, 1,099 프로세스 열거, 200 frame, 회귀 실행 중 load1 6.7): frame당 p50 5.13ms·p95 7.75ms·max 21.15ms로 이전 ps 경로의 45~50ms 고정 비용이 사라졌다. 실제 packaged 후보의 분석 단계 간격은 §17에 기록한다.

### 15.1 실제 후보에서 드러난 특권 자식 문제와 수정(acdbb03)

444ebf2의 후보 f1sTDf(build-OP2XUl)는 회귀 6,615 PASS·0 FAIL·63 SKIP, 패키지 9개 PASS(UX 190화면·consoleErrors 2)였으나 medium smoke run-0wnUbn이 두 회차 모두 기능 PASS(refresh 49.360/51.651초)·**MEMORY_SAMPLE_FAILED**였고 표본은 세 회차 모두 STARTUP 끝(약 8초, READY 직후)에서 멈췄다. worker가 원인 코드를 삼키므로 INT 작업 사본에만 진단 출력을 넣고 small smoke를 두 번 돌렸다(run-WAniiN, run-R1bUuH; 진단 뒤 INT 변경은 되돌려 clean 확인). 원인은 helper exit 3 — 선택 읽기의 `PROC_PIDTBSDINFO`가 pid 하나에 **EPERM**(errno 1)을 돌려줬다. 그 PID는 앱 main의 owner-memory reporter가 READY 직후부터 2~5초마다 실행하는 `/bin/ps`(setuid root)다. 별도 C 프로브로 확인한 바, 이 자식은 생존 16~50ms 동안 SHORTBSDINFO(uid 0)·proc_pidpath는 읽히지만 TBSDINFO/TASKINFO는 EPERM, KERN_PROCARGS2는 EINVAL이다. 이전 ps 기반 discovery는 자체 비용 45~50ms 때문에 이 자식이 끝난 뒤에야 선택 읽기에 들어가 ESRCH로 건너뛰었고, discovery가 4ms로 빨라지자 같은 경쟁이 매 회차 재현됐다.

수정: helper는 선택 집합에서 `bsd()`가 EPERM인 PID를 SHORTBSDINFO로 다시 확인해 **다른 실효 UID**일 때만 `<pid> <ppid> U <path>`로 보고한다(같은 UID의 EPERM은 그대로 frame 실패). `readOwnerMemory`는 U 행이 있는 frame에서만 그 PID 집합에 한해 `/bin/ps -o pid=,ppid=,rss= -p`(단일 PID 3ms)로 RSS를 읽고, ps가 빠뜨린 PID는 재discovery에도 없을 때만 종료로 보며 아직 있으면 `MEMORY_PRIVILEGED_UNREADABLE`로 실패한다. owner 자신이 U면 거부한다. 또 sampler worker가 실패 코드(`stop:MEMORY_NATIVE_QUERY_FAILED` 형태, 원문 금지)와 helper 종료 실패 전까지 모은 표본을 함께 넘기고 runner가 `memoryFailureDetail`로 기록한다. 시험: 실제 setuid `/bin/ps` 자식을 pipe에 막아둔 채 own tree를 읽어 U 행이 RSS와 함께 돌아오는 시험 추가, 단위 50 PASS, COORD runners 452/453(환경 1건). INT에서 acdbb03 runner로 f1sTDf small smoke run-pUkc00: **COMPLETE**, 분석 gap 118ms·최대 read 19ms·312표본·retainedWork 없음.

### 15.2 cwsig6 라운드 — 회귀 재실행, medium 완전 수집, 그리고 두 번째 경쟁(e157298)

acdbb03 체인: 통합 회귀는 backend Docker 스위트에서 `SearchApiIntegrationTest` 2건이 컨텍스트 로드 중 PostgreSQL 연결 실패(EOF; load1 16·fseventsd 165% CPU 구간)로 FAIL했고 backend 소스는 3a6ec0a 이후 변경이 없으므로 §13과 같은 절차로 backend 스위트만 재실행해 병합했다(`gate-latency-regression-acdbb03-merged-20261010`, **6,617 PASS·0 FAIL·63 SKIP**, `integrated-regression-acdbb03.json`). 후보 **cwsig6**(build-IvEZVf, tZgvV7/xpc-required)는 패키지 9개 PASS(제품36·복구6/6·경합8·내부 보안 COMPLETE·UX190화면 consoleErrors2·loader/egress/ask PASS, egress 비loopback 0). 제품 바이트는 bPN1sU와 동일하다(`product-identity-bPN1sU-cwsig6.json`: app.asar 동일, runtime-manifest 964항목 중 buildSequence 외 차이 0; 3a6ec0a 이후 desktop/backend/analyzers/frontend diff 없음). 따라서 대규모 canonical은 재실행하지 않고 I0B1GR PASS를 같은 제품 바이트의 증거로 유지한다(디스크 예산도 재실행을 허용하지 않았다).

medium smoke run-VY4PCa: 세 회차 모두 **COMPLETE**, 분석 단계 최대 간격 **106/130/131ms**(이전 122~601ms), refresh 52.600/52.379초, 초기 132.4/128.1초, 분석 peak 3.60/3.57GiB, 증분 peak 4.37/4.41GiB. 닫힌 덮개 DIAGNOSTIC_ONLY다.

large smoke run-bnPh13은 기능 PASS(초기 506.4/516.5초, refresh 372.9/371.8초)였으나 두 회차 모두 ANALYSIS 도중(234.0초, 54.5초) 수집이 멈췄고, 이번에는 sampler가 원인 코드를 남겼다: **MEMORY_SCOPE_AMBIGUOUS**. 같은 코드가 startup probe run-tseqvZ/run-DzKZA7에서도 STARTUP 2.3초(CACHE_AND_ANALYZER 직후)에 나왔다. 원인: ps 시절 discovery는 `comm`(argv[0])을 썼지만 native discovery는 실제 vnode 경로를 돌려주므로, owner의 Java control runtime이 `process.execPath`로 띄우는 ELECTRON_RUN_AS_NODE 자식(ts-analyzer 등)이 Helper 앱으로 재실행되기 전 수십 ms 동안 main 바이너리 경로로 보이고, "같은 packaged 실행 파일이 둘"이라는 모호성 규칙이 이를 두 번째 앱 인스턴스로 판정했다(helper `D`를 0.3초 간격으로 돌려 확인: 정상 상태에서는 main 경로 프로세스가 회차당 1개뿐이고 Helper 경로 자식 2개가 3초에 나타남). 수정 e157298: 모호성은 **owner 자손 밖**에서 같은 main 바이너리가 보일 때로 한정하고, 자손은 다른 자식처럼 표본에 넣는다(다른 소유 트리의 같은 바이너리는 여전히 거부, 시험 추가, 단위 80 PASS). 사용자 승인으로 run-bnPh13 보존 프로필/fixture 8.7GB를 정리한 뒤(approved-profile-cleanup-v2-5jpkcd83) e157298 체인을 다시 돌렸다. 결과는 §17에 기록한다.

## 16. egress 소켓 귀속(444ebf2)

§8의 `[::127.0.0.1]:51208` 관측은 peer 문자열만 남아 귀속할 수 없었다. `cost-egress-packaged-probe.cjs`의 `inetSockets`가 lsof `-F pcfPnT` 필드 출력을 읽어 비loopback peer마다 소유 pid·command·PPID·scope owner·fd·protocol·소켓 이름·TCP 상태를 `remoteDetails`에 기록한다(`remote` 배열과 실패 판정은 그대로). egress-ask도 같은 함수를 쓴다. 판정 기준(`LOOPBACK` 정규식)은 바꾸지 않았으므로 같은 형태가 다시 나오면 실패하고 이번에는 귀속 정보가 남는다. `cost-egress-sockets.test` 2 PASS.

## 17. e157298 라운드 — 후보 ZO7qZn, medium·large·startup RSS 완전 수집

e157298 체인(run-chain-v2.sh, SKIP_CANONICAL)은 한 번에 끝까지 갔다. 통합 회귀 `gate-latency-regression-e157298`은 재실행 없이 **6,618 PASS·0 FAIL·63 SKIP**(6,681건, `integrated-regression-e157298.json`; acdbb03 대비 +1은 모호성 시험)이다. 후보 **ZO7qZn**(build-yIrzd4, source `e157298`, baseline tZgvV7/xpc-required, build sequence 1791650855306, app.asar `9858a908…6022`, manifest `14cbd56f…400eb`, PACKAGED_NOT_RELEASED)의 stage-5는 9개 모두 통과했다: product-qvhZC0 36 PASS, 복구 6/6(native-GQ1g2I·native-Ih2xfv), 경합 8, 내부 보안 COMPLETE_NOT_INDEPENDENT_ACCEPTANCE, UX 190화면·machine/page errors 0·consoleErrors 2, loader PASS_SINGLE_MAC_APPROXIMATION, egress-off PASS, egress-ask PASS(비loopback 0, `remoteDetails` 없음). `packaged-ZO7qZn-proof.json`이 결과·해시를 연결한다. 제품 바이트는 bPN1sU·cwsig6와 동일하다(`product-identity-bPN1sU-ZO7qZn.json`: asar 동일, manifest 964항목 중 buildSequence 외 차이 0; acdbb03 이후 변경은 `validation/pre-release`뿐). 대규모 canonical은 §15.2와 같은 근거로 I0B1GR PASS를 유지한다(ledger `NOT_RERUN_IDENTICAL_PRODUCT_BYTES`).

| 관측 | medium run-qLZOIV 1회차 | medium 2회차 | large run-UsLN1e 1회차 | large 2회차 |
| --- | ---: | ---: | ---: | ---: |
| measurementStatus | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| 분석 단계 RSS 최대 간격 | **110ms** | **112ms** | **185ms** | **181ms** |
| 모든 단계 최대 간격(단계) | 128ms(INCREMENTAL) | 112ms(ANALYSIS) | 185ms(ANALYSIS) | 181ms(ANALYSIS) |
| 초기 분석 | 123.213초 | 128.666초 | 525.496초 | 522.546초 |
| 1% refresh | 53.023초 | 52.788초 | 380.936초 | 369.065초 |
| 분석 RSS peak | 3,605,744KiB | 3,551,328KiB | 4,869,104KiB | 5,077,488KiB |
| INCREMENTAL RSS peak(run peak) | 4,814,816KiB | 4,416,464KiB | 6,199,568KiB | 6,502,880KiB |
| 취소 release | 346ms | 441ms | 122ms | 116ms |
| 그래프 검색 API 5회 | 105~155ms | 133~151ms | 362~576ms | 361~574ms |
| admission load1 / mdworker / 덮개 | 10.2 / 0 / CLOSED | 29.6 / 32 / CLOSED | 34.1 / 32 / CLOSED | 16.6 / 0 / CLOSED |

warmup(0회차) 시작 단계 간격은 medium 110ms·large 113ms다. 세 후보(§9·§10 SiP1VX 118~150ms, §13 bPN1sU 124~601ms, §15.2 cwsig6 106~131ms)에 걸쳐 불안정했던 분석 단계 RSS 간격이 small·medium·large 전부에서 250ms 계약 안쪽(최대 185ms)으로 들어왔고, 이 수치는 load1 10~34·mdworker 32인 구간에서 나왔다. 시작 진단 run-VyT0Ch(ELECTRON/xpc-required, 4회 warm, `--startup-probe-3`)도 **COMPLETE_DIAGNOSTIC**: readyMs 8,329(warmup)/7,956/7,920/7,872, idle peak RSS 1,384,464/1,343,472/1,341,568/1,355,216KiB(05 §4 idle 1.5GiB=1,572,864KiB 이내 관측), 네 회차 모두 samplingComplete·cleanupConfirmed·integrityFailure 없음. §15.2의 MEMORY_SCOPE_AMBIGUOUS는 large·startup 어느 쪽에서도 재현되지 않았다.

이 라운드의 시간·RSS 수치는 전부 닫힌 덮개·`timingValidity=INVALID_LOAD` DIAGNOSTIC_ONLY다(`performanceAcceptanceEligible=false`). 바뀐 것은 "RSS 수집이 완전한가"라는 계측 계약이 세 등급과 시작 진단에서 충족된다는 점이지, SLO 수용이 아니다. ledger-v5.json(`CANDIDATE_VERIFIED_DIAGNOSTICS_RECORDED`, releaseVerdict NO_GO)이 이 라운드와 이전 후보 f1sTDf/cwsig6의 연결을 기록한다.

### 17.1 정식 측정 조건 — 호스트 차단과 기준 제안(결정 대기)

정식 20회 조건(AC·덮개 OPEN·load1<4·mdworker_shared≤6)은 이 세션 동안 한 번도 성립하지 않았다. 덮개는 세션 내내 CLOSED(`AppleClamshellState=Yes`)였고, load1은 다른 작업트리의 Gradle·Spotlight(mdworker 32) 때문에 체인 실행 중 8~42였다. 사용자 지시("부하가 안 떨어지면 다른 방법을 찾거나 기준을 변경")에 따라 재실행을 반복하지 않고 다음을 제안한다. 어느 쪽도 이 문서에서 적용하지 않았고, 이 라운드의 수치를 PASS로 바꾸지 않는다.

1. **덮개 조건**: 20회 admission에서 `lidState=OPEN`을 필수에서 "기록"으로 낮추고, AC·load1<4·mdworker≤6만 필수로 둔다. 근거: 덮개 상태는 관측값으로 result.json에 남고, 닫힌 덮개의 영향(열 제한)은 load·시간 분포로 드러나며 그 자체가 분포를 왜곡한다는 증거는 이 세션에 없다. 반대 근거: 05 §4 기준 장비 정의와 이전 라운드의 조건을 바꾸는 것이므로 사용자 결정이 필요하고, 바꾸면 그 이후 20회만 비교 가능하다.
2. **부하 조건은 유지**: load1<4·mdworker≤6은 timingValidity의 실체이므로 완화하지 않는다. 대신 20회는 이 호스트의 다른 세션 작업이 끝난 뒤(또는 다른 기기에서) `wait-quiet` admission이 자연히 열릴 때 한 번 돌린다. 이번 라운드의 세 등급 COMPLETE는 그 실행이 "RSS 수집 실패로 무효"가 될 가능성을 제거했다는 의미다.
3. **대안 없는 항목**: 정식 측정 없이 G-PERF를 통과로 바꾸는 방법은 없다. 05 §4의 "미측정 개발 목표" 문구와 NO_GO는 유지한다.

### 17.2 증분 단계 전체 앱 RSS 6GiB 초과 — 결정 대기

large INCREMENTAL 단계 run peak는 SiP1VX 6,208,480/6,352,672, bPN1sU 6,270,112/6,322,912, ZO7qZn 6,199,568/6,502,880KiB로 세 후보에서 일관되게 6GiB(6,291,456KiB)의 −1.5%~+3.4%에 있고, medium은 4.4~4.8GiB로 중간 분석 상한 4GiB를 넘는다(초기 분석 peak는 각각 5.08GiB·3.61GiB로 상한 이내). 05 §4 증분 행에는 RSS 상한이 없고 전체 분석 watchdog(6GiB 초과 시 새 work 중지)은 분석 중 발동하지 않았다. 선택지: (a) 증분 행에 같은 등급 상한을 명시 — 현재 large refresh는 상한을 넘으므로 refresh 중 메모리 감축(이전 스냅샷 보유분 해제)이 선행돼야 한다; (b) 증분 상한을 "등급 상한+10%"로 두고 이유(이전 스냅샷과 새 스냅샷 공존)를 적는다; (c) 상한 없이 관측만 유지. 권고는 (a)지만 R1 범위의 설계 작업이므로 사용자 결정으로 남긴다. 어느 경우든 지금 수치는 닫힌 덮개 진단이다.

## 18. 현재 상태 요약

- 소스 `e157298`(main b0309e9 뒤 12커밋: 경로 검사 통합, RSS helper, 그래프 중복 쓰기 제거, refresh SLO 조정, flow 정렬, native 열거·특권 자식·소유 자식 모호성 수정, egress 귀속, startup failureDetail) — 통합 회귀 6,618 PASS·0 FAIL·63 SKIP, 타입 검사 PASS.
- 후보 ZO7qZn(bPN1sU·cwsig6와 제품 바이트 동일) — 제품36·복구6/6·경합8 PASS, 내부 보안 COMPLETE, 자동 UX190화면(consoleErrors2), loader/egress/ask PASS, **대규모 packaged incremental=clean-full PASS**(I0B1GR, 동일 바이트로 유지).
- 성능: medium 1% refresh 진단 50.8~57.8초(조정 게이트 p95≤90초 범위, 30초는 R1), large 초기 504~547초·refresh 361~434초, 시작 ready 7.9~8.3초·idle RSS 1.34~1.38GiB. 모두 닫힌 덮개·고부하 DIAGNOSTIC_ONLY이며 정식 20회는 NOT RUN(§17.1 제안 대기).
- RSS: 전역 `/bin/ps` 경로를 native 열거로 바꾸고(§15) 특권 자식(§15.1)·소유 자식 모호성(§15.2)을 고친 뒤 small 118ms·medium 110/112ms·large 185/181ms·startup 4회 모두 COMPLETE(§17). 250ms 계약은 세 등급에서 충족됐고 이 사실은 부하와 무관한 계측 결과다.
- 미해명 단일 관측: SiP1VX egress-ask 첫 실행의 `[::127.0.0.1]:51208` 소켓(§8). 이후 f1sTDf·cwsig6·ZO7qZn 포함 모든 실행에서 remote 0이며 probe는 이제 peer 프로세스를 기록한다(§16).
- 열린 결정: 정식 측정의 덮개 조건(§17.1), 증분 단계 전체 앱 RSS 상한(§17.2).
- 마감 순서(push·PR·병합·원본 main 반영·최종 증거 보관)는 인계 §10에 따라 이 문서 커밋 뒤 진행한다. 사람 수용 게이트(독립 보안·정확도·UX/VoiceOver·실계정·서명/공증·법률)는 준비 상태만 유지. **판정 NO_GO 유지.**
