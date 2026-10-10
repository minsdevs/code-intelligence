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

## 4. 영향 회귀·보안·공간 차단

INT의 현재37addef에서 runners445 PASS/0 FAIL/0 SKIP, desktop3,280 PASS/0 FAIL/45 SKIP이다. 합계3,725 PASS는 이 두 영향 suite만의 실행 수이며 전체 통합 회귀나 새 후보 PASS가 아니다. 두 코드 커밋은 gitleaks8.30.1 탐지0, 기준main 대비 app.token-enc-key 합성 시험63파일 값·encoded/decoded 해시 불변을 확인했다.

검증된 retirement helper를 재사용해 이전 build-owzwMA/work만 기존 보관본candidate-build/work와 byte/exec/link inventory·소유권·identity·open-file 검사 후 제거했다. lqudku/baseline 앱·보고서·원본 CLAUDE.md·작업트리·보관본의 불변을 확인했다. 논리618,086,781B 사본을 제거했지만 가용량은3,117,268,992→3,119,833,088B로 관측됐다. clone 공유 블록 때문에 논리 용량만큼 공간이 회수되지 않으며 동시 쓰기도 있어 차액 전부를 배타적 회수로 주장하지 않는다. 첫 두 호출의 경로 오기 실패는 삭제 전에 멈췄고 기록을 보존했다. 최종 결과는 archived-build-cleanup-w0vd6tsa/result.json이다.

small3GiB·medium3.5GiB·large6GiB 및 새 후보 빌드6,845,104,128B의 기존 공간 기준을 낮추지 않는다. 새 후보, medium30초 재측정, large 분석/XPC 완전 수집, 실제 대규모 workload의 독립 fresh-profile clean-full은 공간 확보 전 NOT RUN이다. 63파일 과거 oracle을 대체 수용하지 않는다. 최종20회는 기술 게이트와 quiet AC/open-lid 조건이 충족된 최종 후보에서만 실행한다. push/PR/병합·마지막 증거 보관은 아직 하지 않았다.

USER-INPUT-READINESS의 실계정/SSO, 서명 자격, 두 번째 Mac/업데이트, 독립 보안·정확도 평가, UX/VoiceOver, 법률 판단은 준비 상태만 유지한다. SourceLace·Relowick·Maprill의 상표/도메인은 미검증이며 이름·로고·appId·프로필을 바꾸지 않았다. Sol6.1 high 설정과 native-turn WebSocket 설정의 대화형 승인 미완료를 해결된 것으로 가정하지 않고 서브에이전트0개로 직접 처리했다.
