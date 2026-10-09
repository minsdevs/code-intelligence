# 출시 게이트 재개: 실패 원인과 측정 러너 — 2026-10-09

**현재 판정: NO_GO, 작업 진행 중.** PR #114 뒤 main `aabb8e6d4e34db768faed962eee198c7e808498a`에서 새 통합 브랜치를 시작했다. 이전 2ogirS의 완료·실패·보관 기록은 변경하지 않았다. 새 후보의 수용은 아직 아니다.

## 1. medium 둘째 회차의 실패 원인

보존한 run-VsTTVE RSS CSV에서 소유 앱56166 → 어댑터56335 → PostgreSQL56360 → DB 자식56657의 부모 관계를 확인했다. 새로 조회한 macOS unified log에는 다음 사건이 같은 kernel thread79409171에서 이어진다. 시간은 UTC다.

| 시각 | 실제 기록 |
| --- | --- |
| 06:53:58.393696 / .402289 | APFS postgres INSERT ENOSPC |
| 06:53:58.409723 | PID56657 postgres core dump 거부 |
| 06:53:58.409772 | postgres[56657] corpse |
| 06:53:59.047025 | ReportCrash fatal309, PID56657 postgres |

기존 표본에서 이전 DB 자식들은 elapsed82335ms 뒤 사라지고 대체 자식61819/61820/61821이82462ms부터 나타난다. **실패 당시 소유 PostgreSQL의 공간 부족과 치명적 종료**가 확인됐다. 뒤늦은 디스크 가용량 관측만으로 원인을 추정한 것이 아니다. 앱 owner의 exit0은 DB 작업 성공을 뜻하지 않는다.

정확한 PostgreSQL stderr와 HTTP 예외는 기존 러너가 버려 남아 있지 않다. DB 연결 소실이 terminal job 관측 실패를 일으켰다는 세부 경로는 [INFERENCE]다. kernel에는 동시각 validation helper와 node ENOSPC도 있지만 node PID가 없어 RSS CSV 실패의 특정 원인으로 확정하지 않는다. ReportCrash에 기록된 ips 파일은 현재 없다.

COORD `validation/local/gate-recovery-20261009/medium-historical-cause.json`에 원본 해시와 연결했다. ARCHIVE는 읽기 전용으로 유지했다. 아래 진단 경로는 별도 표시가 없으면 COORD의 같은 디렉터리 기준이다.

## 2. 최소 재현과 수정

동일 후보의 번들 PostgreSQL을 독립256MiB APFS 시험 이미지에서 single-user로 실행했다. 실사용 DB·앱·Keychain·네트워크 인증에는 접근하지 않았다. 실제64MiB INSERT가 `pg_wal/xlogtemp` 쓰기 ENOSPC → PANIC → SIGABRT로 끝났다. 이 PANIC을 과거 실행의 유실된 스택으로 대체하지 않는다.

수정한 quiet admission 함수는 마지막 quiet 관측 직후 현재 가용량을 읽는다. 실제 시험 볼륨의17,412,096B를 읽어 DISK_SPACE_LOW로 거부했다. quiet 관측·대기만 주입했으며 statfs와 공간 기준은 실제다. 시간 판정은 NOT RUN이다. 볼륨 분리 성공을 확인했고 호스트 디스크를 채우지 않았다.

- `enospc-5djoOr/`: 실제 DB 실패 및 공간 진입 거부 확인.
- `enospc-PmvC61/`: 첫 준비 실패 보존. APFS 예약 공간으로 채우기 자체가 ENOSPC였다. DB 재현 PASS로 세지 않았으며 별도 실행에서 준비 여유32MiB를 두고 DB 실패를 확인했다.
- `cf3e731`: 대기 전 검사만으로 시작하던 경로를 실행 직전 재검사. 기존2GiB+크기별 reserve 유지. 실패/불완전 RSS는 실패 종료, 실패 프로필·입력 보존. HTTP 상태·실패 단계·마지막 job 관측과 안전한 표본 오류 코드를 기록.
- 외부 작업이 진입 후 공간을 소진하는 경우까지 선점 예약으로 막는 구현은 아니다. 충분한 호스트 공간 유지와 종료 가용량 기록이 필요하다.

## 3. RSS 원인 분리

기존 large 둘째 분석은 표본 간격481ms·266ms로250ms 한도를 넘었다. failure=null은 완전성을 보증하지 않는다. 과거 자료는 read/scheduler 지연을 분리하지 않아 두 공백의 정확한 원인은 확정할 수 없다.

실제 ps 수집 중 driver event loop를600ms 막은 별도 진단에서 기존 방식은 최대699.05ms 간격으로 불완전했다. `3ee61b7`의 독립 Worker 수집기는 같은 차단 중 최대155.40ms, samplingComplete=true였다. 100ms 수집 주기·250ms 한도는 유지하며 phase 첫·끝 미수집 시간도 검사한다. **러너의 차단 취약점 수정 증거이며 large 전체 수집 완료 증거는 아니다.**

`rss-probe.json`, `rss-worker.csv`, `rss-worker-result.json`에 보존했다. `rss-worker.json` 말미의 잘못된 literal newline escape는 원본 그대로 두고 별도 유효 JSON을 만들었다.

추가 smoke에서 STARTUP 종료 뒤 완료된 표본이 STARTUP에 귀속되는 경계 오류를 발견했다. 완료 시각의 활성 phase에 기록하도록 수정했다. 새 회귀는 수정 전 FAIL·수정 후 PASS이며 실제 Worker의 driver600ms 차단 smoke에서 phase 경계 일치·samplingComplete=true·최대간격108.70ms를 확인했다. 원본은 rss-phase-y53GM3/와 rss-phase-fail-before.log·rss-phase-pass-after.log다.

## 4. 현재 검증과 남은 작업

| 검증 | 현재 결과 |
| --- | --- |
| 대상 workload metrics | 최초 대상 묶음30 PASS, 추가 경계 수정 뒤 metrics22 PASS |
| INT 전체 validation runners | f15b30b의 전원 진입 보완 포함432 PASS·0 FAIL·0 SKIP. runners-int-lid-guard.log 및 아래 통합 회귀에서 재확인 |
| COORD 추가 러너 회귀 | 432개 중431 PASS·1 FAIL. tree-analyzer proxy-addr2.0.7의 IPv4-mapped CIDR 보안 시험 실패. INT 설치는2.0.8; 이 실패를 제품 PASS로 대체하지 않음. runners-phase-regression.log 보존 |
| 제한 볼륨 실제 PostgreSQL ENOSPC | 재현·공간 진입 거부 확인 |
| RSS worker 실제 ps·driver 차단 | 완전 수집 확인, 소형 진단 한정 |
| 정상 medium 분석·refresh 병목 | NOT RUN. quiet 대기 중 실제 닫힌 덮개 관측으로 소유 진단만 중단; 기존 원본·실패 기록 유지 |
| packaged incremental/독립 clean-full canonical | 준비, NOT RUN |
| INT 통합 회귀7종 | f15b30b에서6,591 PASS·0 FAIL·63 SKIP, frontend TypeScript 검사 PASS. INT validation/local/gate-recovery-20261009/full-regression-qYKRfV/ |
| 새 후보·영향 패키지·medium/large smoke | NOT RUN |
| 최종 시작/G-PERF20회 | NOT RUN |

medium30초 달성 판정은 새 실측 전이며 기존59.360초 목표 미달은 유지한다. large 초기 분석600초·RSS6GiB와 별도 hard timeout을 따르고 large refresh에 medium30초를 적용하지 않는다. JVM 수집기는 이전 w24 방식을 재사용하되 후보 소스·asar 해시를 인자로 받는다. 계측 실행 시간은 최종 SLO 표본이 아니다.
실제 ioreg가 닫힌 덮개를 보고한 뒤, 기존 quiet 함수가 CLOSED 표본 세 개를 그대로 승인하는 것을 재현했다. AC·열린 덮개를 세 quiet 표본 모두에서 요구하도록 보완했다. 기존 시험 확장의 수정 전 결과21 PASS·1 FAIL과 수정 후22 PASS를 INT에 보존했다. 실제 호스트 관측 smoke는 앱을 시작하지 않고 대기 경로로 진입했다. 시스템 전원 설정은 변경하지 않았다.

대기 진단 analysis-probe-nnYq0l은 warmup 소유 앱18573의 정상 종료 뒤 측정 앱을 시작하지 않은 상태에서 중단했다. run-IC4YNL 원본의 RUNNING을 PASS로 바꾸지 않고 별도 중단 기록을 남긴다. 새 진단은 최신 러너의 전원·덮개·quiet 조건이 충족돼야 실행된다.

통합 회귀 합계는 고유 시험 수가 아니라 실제 실행 수다(events19회 포함). frontend480·TS analyzer318·runners432·desktop3,278·backend2,064·events19 PASS이며 desktop45·backend18 SKIP은 수용으로 세지 않는다. backend/events는 cleanTest를 실행했고 소스·기존 컨테이너 불변, 새 잔류 컨테이너0을 확인했다. backend-JxvI2N 및 events-8V0NBb가 개별 Docker 증거다.

f15b30b까지 새4개 커밋의 gitleaks 탐지0, 합성 app.token-enc-key가 있는63개 시험 파일의 값·해시가 기준 main과 같음을 확인했다. 아직 push·PR·병합은 하지 않았다. ledger-v3.json에 연결했다.

## 5. 사람 입력과 이름 경계

실계정·SSO, 서명/공증 자격, 두 번째 Mac·업데이트 배포 키/host, 독립 보안·정확도 평가, UX8명·VoiceOver, 법률 판단은 USER-INPUT-READINESS의 **준비 상태만** 유지한다. 자동 PASS나 실제 Keychain 실행은 하지 않았다. 승인된 Sol6.1 high 실행 프로필을 확인하지 못해 다른 모델로 대체하거나 서브에이전트를 시작하지 않았다. native-turn WebSocket 설정의 승인/해결도 가정하지 않았다.

이름은 미결정이며 SourceLace·Relowick·Maprill의 상표/도메인은 미검증이다. 표시 이름·아이콘 변경과 appId/profile 변경을 분리해 최종 후보 전 결정해야 한다. 후자는 설치 identity, 사용자 데이터 경로, 격리 Validation/Acceptance identity, 서명·업데이트 연속성의 마이그레이션·재검증이 필요하다. 이름·로고·저장소·appId·프로필 경로는 변경하지 않았다.
