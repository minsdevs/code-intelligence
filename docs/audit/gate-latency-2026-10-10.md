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
