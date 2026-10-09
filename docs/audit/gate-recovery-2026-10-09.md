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
| 대상 workload metrics | 최초 묶음30 PASS, phase/전원 경계 뒤22 PASS, 진단 전용 경계 추가 뒤COORD·INT 각각26 PASS |
| INT 전체 validation runners | f15b30b의 전원 진입 보완 포함432 PASS·0 FAIL·0 SKIP. runners-int-lid-guard.log 및 아래 통합 회귀에서 재확인 |
| COORD 추가 러너 회귀 | 432개 중431 PASS·1 FAIL. tree-analyzer proxy-addr2.0.7의 IPv4-mapped CIDR 보안 시험 실패. INT 설치는2.0.8; 이 실패를 제품 PASS로 대체하지 않음. runners-phase-regression.log 보존 |
| 제한 볼륨 실제 PostgreSQL ENOSPC | 재현·공간 진입 거부 확인 |
| RSS worker 실제 ps·driver 차단 | 완전 수집 확인, 소형 진단 한정 |
| 정상 medium 분석·refresh 병목 | 2ogirS 진단 재개 완료: 두 초기 분석과1% refresh 기능 PASS·수집COMPLETE, INVALID_LOAD·SLO 수용 제외. §6 |
| packaged incremental/독립 clean-full canonical | 2ogirS 제품 소스에서21범주 일치·삭제/변경 전파 확인. 이후 변경 후보에는 상속하지 않음. §6 |
| INT 통합 회귀7종 | f15b30b에서6,591 PASS·0 FAIL·63 SKIP, frontend TypeScript 검사 PASS. INT validation/local/gate-recovery-20261009/full-regression-qYKRfV/ |
| 새 후보·영향 패키지·medium/large smoke | NOT RUN |
| 최종 시작/G-PERF20회 | NOT RUN |

medium30초 달성 판정은 새 실측 전이며 기존59.360초 목표 미달은 유지한다. large 초기 분석600초·RSS6GiB와 별도 hard timeout을 따르고 large refresh에 medium30초를 적용하지 않는다. JVM 수집기는 이전 w24 방식을 재사용하되 후보 소스·asar 해시를 인자로 받는다. 계측 실행 시간은 최종 SLO 표본이 아니다.
실제 ioreg가 닫힌 덮개를 보고한 뒤, 기존 quiet 함수가 CLOSED 표본 세 개를 그대로 승인하는 것을 재현했다. AC·열린 덮개를 세 quiet 표본 모두에서 요구하도록 보완했다. 기존 시험 확장의 수정 전 결과21 PASS·1 FAIL과 수정 후22 PASS를 INT에 보존했다. 실제 호스트 관측 smoke는 앱을 시작하지 않고 대기 경로로 진입했다. 시스템 전원 설정은 변경하지 않았다.

대기 진단 analysis-probe-nnYq0l은 warmup 소유 앱18573의 정상 종료 뒤 측정 앱을 시작하지 않은 상태에서 중단했다. run-IC4YNL 원본의 RUNNING을 PASS로 바꾸지 않고 별도 중단 기록을 남긴다. 이후 무기한 대기를 중단했으며, 재개 범위는 사용자가 명시적으로 허용한 §6의 진단 전용 예외다. 정식 수용 조건은 변경하지 않았다.

통합 회귀 합계는 고유 시험 수가 아니라 실제 실행 수다(events19회 포함). frontend480·TS analyzer318·runners432·desktop3,278·backend2,064·events19 PASS이며 desktop45·backend18 SKIP은 수용으로 세지 않는다. backend/events는 cleanTest를 실행했고 소스·기존 컨테이너 불변, 새 잔류 컨테이너0을 확인했다. backend-JxvI2N 및 events-8V0NBb가 개별 Docker 증거다.

f15b30b까지 새4개 커밋의 gitleaks 탐지0, 합성 app.token-enc-key가 있는63개 시험 파일의 값·해시가 기준 main과 같음을 확인했다. 아직 push·PR·병합은 하지 않았다. ledger-v3.json에 연결했다.

## 5. 사람 입력과 이름 경계

실계정·SSO, 서명/공증 자격, 두 번째 Mac·업데이트 배포 키/host, 독립 보안·정확도 평가, UX8명·VoiceOver, 법률 판단은 USER-INPUT-READINESS의 **준비 상태만** 유지한다. 자동 PASS나 실제 Keychain 실행은 하지 않았다. Sol6.1 high 등록은 확인했으나 모델 고정·fallback 금지 설정의 대화형 승인이 완료되지 않아 서브에이전트를 시작하지 않았다. 다른 모델로 대체하지 않았고 native-turn WebSocket 설정의 승인/해결도 가정하지 않았다.

이름은 미결정이며 SourceLace·Relowick·Maprill의 상표/도메인은 미검증이다. 표시 이름·아이콘 변경과 appId/profile 변경을 분리해 최종 후보 전 결정해야 한다. 후자는 설치 identity, 사용자 데이터 경로, 격리 Validation/Acceptance identity, 서명·업데이트 연속성의 마이그레이션·재검증이 필요하다. 이름·로고·저장소·appId·프로필 경로는 변경하지 않았다.

## 6. 승인된 진단 재개와 근거 저장 개선

사용자가 현재 부하·AC·외부 화면·닫힌 덮개를 **진단·기능 검증에만** 허용했다. fca6868의 명시적 `--diagnostic-only`는 실제 관측값을 보존하고 정식20회와 함께 사용할 수 없다. SLO/RSS 수용 대상이 아니며 assessment/smokeObservations=null, 부하 위반은 INVALID_LOAD다. 기본 quiet·열린 덮개 기준과 디스크 reserve는 그대로다. 신규 진단 경계 시험은 수정 전3 FAIL, 수정 후COORD/INT 각각26 PASS다.

- INT run-u0KBxm: 실제2ogirS 앱에서10,000파일·50MiB 초기 분석 정상 완료. 수집COMPLETE, 분석 phase 최대간격153ms, 정상 종료·소스/번들 불변 확인. native-analysis-proof.json은 격리 앱의 실제 화면·AX 증거다.
- INT run-VtoC9J / refresh-probe-SRp0C4: 초기 분석·1% 갱신 기능 PASS·수집COMPLETE, JVM94개 덤프·observer 오류0. 갱신의 IMPORT·SOURCE_PARSING·TS_PARSING에서 source-store retain 대기와 DB 저장 비용이 관측됐다. 계측/고부하 시간이므로30초 목표 판정은 하지 않았다. worker stderr를 버리는 기존 supervisor 때문에 TS_INCREMENTAL 수치를 얻지 못했으며, 이를 재사용0으로 해석하지 않는다.
- INT canonical-QwhGTb: 실제 증분 갱신 후와 별도 fresh profile의 clean-full이 같은 변경 입력63파일에서21범주 canonical 일치. 노드995·엣지1,657·근거890·flow25, 삭제·변경 전파와 양쪽 정상 종료 확인. SHA256 e77611df30cd38d77dc01b5d57082cff27b56b330eed8177503b086f536de33d. 이것은2ogirS 제품 소스c1b93c9의 결과이며 이후 변경 후보에 상속하지 않는다.

EvidenceService.replaceLinkedAll은 생성 ID를 JDBC로 돌려받아 다시 연결 INSERT에 보내던 경로를500행 단위 materialized CTE로 합쳤다. ID는 서버에서 한 번 할당하고 실제 삽입된 행과 subject를 연결한다. 전체 입력 크기의 중간 parameter/owner 목록을 없앴다. 근거 삭제 범위·마스킹·트랜잭션·의미 있는 작업은 유지하며 migration은 추가하지 않았다.

| 실제 DB 진단 | 10,000 subjects / 20,000 근거 교체 | 정합성 |
| --- | ---: | --- |
| 기존 evidence-baseline-vZg3KC | 1,011.58ms | subject·필드 일치 |
| 변경 evidence-after-2uIG3b | 593.00ms | subject·필드 일치 |

두 값은 단일 격리 PostgreSQL 진단이며 제품 전체 refresh SLO가 아니다. 신규 null·중복 근거 소유자·후반 오류 rollback 경계와 기존 경계5시험 PASS, 별도 근거/graph round-trip 대상7시험 PASS(evidence-target-IHV1Ts). 첫 준비 실패 evidence-baseline-pPuQyk는 임시 경로 명명 보호 조건 위반으로 보존했고, 보호 조건을 낮추지 않고 경로를 고쳤다. source-store 복호화·주소·키·경로 검증은 변경하지 않았다.

실제2ogirS small 분석의 rss-scope-8GPYpr/run-g5yiRY 동시 관측에서 앱3465의 bridge5079와 별개로 XPC supervisor5081(PPID1)·worker5086이 나타났다. 기존 PPID-only collector는 둘 다 제외했다. 실제 RSS 누락은 측정 범위 결함이며 제품 메모리 고장으로 보지 않는다. 과거 COMPLETE는 표본 간격에 한정되며 전체 앱 RSS 수용 증거가 아니다.

수집기는 전체 호스트의 PID/PPID/실행파일만 조회한 뒤, 소유 트리와 정확히 같은 독립 Validation 번들의 XPC 범위만 대상으로 RSS를 조회한다. 같은 앱 main이 둘 이상이면 모호성 오류로 거부하고 조회 중 실행파일 변경도 거부한다. 실제 PPID는 보존하고 읽기 전용 scopeOwnerPid를 별도 기록한다. 종료 권한이나 cleanup의 소유 범위는 확대하지 않는다. CSV 형식2는 scope_owner_pid를 추가한다. 100ms 주기·250ms 공백 기준은 유지한다.

누락/귀속 경계 시험은 수정 전2 FAIL, 변경 영향 sampler 시험68 PASS·0 FAIL이며 실제 OS reader smoke도 확인했다(rss-scope-fix-i9Fmt4). 수정 후 실제 XPC 앱 동시 수집·새 후보 검증은 다음 단계이며 아직 PASS로 기록하지 않는다. ledger-v8/v9의 과거 관측은 보존한다.

