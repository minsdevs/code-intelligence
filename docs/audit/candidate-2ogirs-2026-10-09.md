# 2ogirS route 저장 개선 후보 — 2026-10-09

**현재 판정: NO_GO.** 통합 회귀와 변경 영역 패키지 검증은 완료했지만 medium은 첫 회차 refresh 목표 미달·둘째 회차 분석 실패로 INCOMPLETE다. 공간 확보 뒤 large-only 진단 절차를 재개했으며 완료 결과는 아직 수집 전이다. 최종 20회·packaged clean-full canonical 동등성·독립 평가·사람 수용도 미완료다. [KOwFxr 감사](candidate-kowfxr-2026-10-09.md)의 목표 미달과 이전 실패·INVALID_LOAD는 유지한다.

## 1. 기준과 경계

| 항목 | 값 |
| --- | --- |
| 공개 기준 main | `6ddeefb32c0cbeafcf96bf84e38e73901802f569` (PR #110) |
| 통합 브랜치 / 빌드 작업트리 | `release/gate-followup-20261008` / `~/Dev/ciw/int` detached |
| 후보 제품 소스 | `c1b93c91f46aed2b46b9ae44672ae6f3c48c8658`, sourceWorkingTree=false |
| baseline / 격리 | `tZgvV7` / `--adapter-isolation xpc-required` |
| build sequence / 결과 | `1791519520229` / `pre-release-candidate/build-EDCFQJ`, PACKAGED_NOT_RELEASED |
| build result SHA-256 | `39939d5e14b8ad48c45f589cb7807bc2972a781eface731bbb71011642b4c381` |
| manifest SHA-256 | `e7cad3e27fc803f696d654eeb1a8d0068a8ddf5ab1c8efd5335b1eb3d5053067` |
| app.asar SHA-256 | `e0511eea85f7ac2a313cd662cde318739bc0133dad5fd0ae50d667dd83813584` |

별도 표시가 없으면 증거는 `int/validation/local/` 기준이다. 빌드는 sourceAndBaselineUnchanged=true이며 Java를 다시 컴파일하고 검증된 native runtime을 재사용했다. 새 migration·외부 의존성 변경은 없다. 제품 검증에 원본 설치 앱·실사용 프로필·실제 Keychain·실계정·유료 호출·GitHub Actions를 사용하지 않았다. 로컬 ad-hoc 검증 변형이며 정식 서명·공증·출시가 아니다.

## 2. 변경과 통합 회귀

[w24 감사](w24-route-refresh-2026-10-09.md)에 실패 먼저 검증, 13개 DB 영향 시험·5개 실제 TS/DB 연동 시험, 실제 저장 서비스의 전체 canonical node/edge 일치를 기록했다. authoritative route 연결 삭제를 최대 500개 ID씩 처리하되 snapshot·방향·edge/target type·marker·트랜잭션 경계를 유지한다. 원본과 변경 전후의 저장 내용 일치는 패키지의 독립 full 재분석 동등성이나 성능 목표 통과를 대신하지 않는다.

`coordination-2026-10-08/regress.sh post-merge-20261009-route`의 7개 실행 명령 모두 exit 0, Gradle cleanTest 경로로 재실행했다. 회귀와 후보의 소스 커밋은 같다.

| 영역 | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| frontend | 480 | 0 | 0 |
| TS analyzer | 318 | 0 | 0 |
| validation runners | 428 | 0 | 0 |
| desktop | 3,278 | 0 | 45 |
| backend | 2,064 | 0 | 18 |
| events | 19 | 0 | 0 |
| 합계 | 6,587 | 0 | 63 |

전체 6,650개이며 frontend tsc도 PASS다. `post-merge-20261009-route/regression-facts.json`, 원본 로그, `docker-integration/backend-9x25Bo`·`events-JT7vfo`가 근거다. SKIP은 통과로 합산하지 않는다. 변경 없는 tree analyzer 독립 suite는 NOT RUN이며 공유 graph 저장은 backend 및 별도 실제 서비스 진단으로 확인했다.

## 3. 영향 영역 패키지 검증

기존 `coordination-2026-10-08/stage5-delta.sh 2ogirS`를 `caffeinate -i`로 감싸고 각 앱 실행은 calm-meadow의 공통 native lock으로 직렬화했다.

| 실행 | 실제 결과 | 증거 |
| --- | --- | --- |
| 제품 시퀀스 | 36 PASS | `pre-release-final/product-Sf1qjN` |
| 작업 경합 | 8 PASS | `job-race/product-Z7YR5g` |
| 내부 보안 탐침 | COMPLETE; fuse·node modes·renderer CSP PASS | `security-internal-review/packaged-nFoizE` |
| import-evidence | NOT RUN | route 저장 SQL 변경과 무관한 경로; 이전 KOwFxr 결과는 참고만 함 |
| owner crash AFTER_SOURCE_RENAME | NOT RUN | source-vault·backup 경로 변경 없음; 이전 PASS 상속 안 함 |
| owner crash BEFORE_COMPLETED_CLEANUP | NOT RUN | source-vault·backup 경로 변경 없음; 이전 PASS 상속 안 함 |

실행한 세 명령 모두 exit 0이며 후보 app.asar·manifest·경로 및 mock Keychain·실계정 미사용을 `stage5-2ogirS/native-facts.json`에서 교차 확인했다. 내부 보안 탐침은 signed-helper C15·독립 보안 검토의 대체물이 아니다.

## 4. 성능 진단 상태

기존 `coordination-2026-10-08/stage5-timing.sh 2ogirS`의 medium 구간은 13:36:13–15:54:26 KST에 실행됐다. `workload-performance/run-VsTTVE/result.json`은 SMOKE_ONLY / INCOMPLETE, 명령 exit 0이다. 둘째 회차가 ANALYSIS_FAILED로 끝났으므로 이 종료값을 검증 통과로 해석하지 않는다. 첫 회차에서 확보한 시간만 아래에 기록한다. large 결과와 전체 ledger는 아직 확정하지 않았다.

| 완료 관측 | 초기 분석(초) | 1% refresh(초) | 실행 직전 load1 |
| --- | ---: | ---: | ---: |
| medium 1 | 141.117 | 59.360 | 3.0225 |

refresh 목표는 30초이며 이 관측은 미달이다. 사용자는 이번 후보의 남은 검증을 마친 뒤 실제 미달·미실행을 기록하고 문서·PR·병합까지 마감하도록 선택했다. 추가 최적화는 별도 작업이며 기존 SLO나 출시 기준을 낮춘 승인이 아니다.

둘째 회차는 quiet admission을 7,057,793ms 기다린 뒤 시작했지만 분석에 실패했다. graph·incremental은 원본에 FAIL / NOT_RUN_AFTER_ANALYSIS_FAILURE, cancel은 CANCEL_FAILED로 기록되어 있다. 메모리 표본에도 MEMORY_SAMPLE_FAILED가 있어 완전한 RSS 증거로 취급하지 않는다. 두 회차의 cleanup과 원본 실패 결과를 보존했고, 실패 프로필은 기존 러너가 자동 정리했다. 상세 실패 원인은 아직 UNDETERMINED다. medium 원본 결과 SHA-256은 `062005995d0f37cb289d3b3e91a10895921feb42e9a1d0d9be54761b02c1903c`이다.

`stage5-2ogirS/medium-failure-sleep.json`은 보존한 pmset 원본과 대조한 기록이다. medium 전체 구간에는 timestamped record 581개와 정확한 Sleep/Wake/DarkWake 전환0건이 있었다. 실제 실패 회차의 마지막 admission 관측부터 종료까지는 timestamped record가 없어 NO_RECORDS_IN_WINDOW다. 이 자료만으로 실패를 절전·부하 또는 특정 제품 코드 탓으로 확정하지 않는다.

medium 종료 뒤 large의 저부하 대기 중 디스크 가용량 472,965,120B를 관측했다. 이전 large 실행의 프로필은 3,922,182,144B·3,918,684,160B였으므로 검증 작업을 중단했다. 중단 시점에는 timing summary에 large 시작이 없고 large 로그도 없어 NOT RUN으로 기록했다. `stage5-2ogirS/timing-cancellation.json`에 중단과 원본 medium 해시를 보존했다. 이후 공간을 확보하여 같은 후보의 large만 재개했다. 기존 medium 실패를 재실행으로 대체하지 않으며, 뒤늦게 관측한 공간 부족만으로 앞선 분석 실패의 원인을 확정하지 않는다.

large-only driver는 2026-10-09T10:16:01.172Z에 재개했다. 기존 timing driver에서 medium 실행 행만 제외했고 quiet admission·공통 native lock·caffeinate·깨끗한 환경과 large smoke-2 명령은 유지했다. `stage5-2ogirS/timing-large-resume-start.json`에 원본/파생 driver·medium 결과 해시와 시작 상태를 기록했다. 이는 실행 절차의 시작 기록이며 실제 앱 시작 또는 진단 완료 증거가 아니다.

실행 직전 quiet admission은 load1<4·mdworker_shared≤6을 30초 간격으로 세 번 확인한다. 사용자가 승인한 AC·외부 화면·덮개 닫힘 예외는 진단 smoke에만 적용한다. 최종 20회에는 조용한 AC·덮개 열린 기기가 필요하며 현재 NOT RUN이다. 시작 직전 부하·전원 경계 관측을 실행 전체의 연속 보증으로 해석하지 않는다.

## 5. 실패 보존과 합성 DB 보관

첫 빌드는 `MAC_BUILD_DISK_SPACE`로 거부됐다. calm-meadow의 `validation/local/w24-ts-refresh/build1/build.log`를 보존하고, 공간 확보 뒤 `build2/`에서 새 build sequence로 성공했다. 공간 검사 기준은 낮추지 않았다.

정리가 거부된 기존 build-work·의존성 디렉터리는 그대로 뒀다. 대신 이번 w24 진단이 만든 성공한 합성 DB 복제본 두 개와 그 합성 입력 DB만 압축 보관했다. `ditto` ZIP을 별도 private 디렉터리에 전부 복원하여 경로·종류·파일 바이트·실행 비트의 전체 inventory 일치를 확인했다. 이후 별도 retirement 단계에서 archive hash·소유권·출처·정지 상태·원본 및 보호 보고서를 다시 확인하고, 정확히 지정한 확장 PostgreSQL 디렉터리만 제거했다.

| 보관 위치 (`w24-ts-refresh/` 기준) | ZIP SHA-256 |
| --- | --- |
| `db-archive-first/postgres.zip` | `6263d5b530b5ad0d42af4130f6bb37433438f59111af06cfc1b2e723ae5613ad` |
| `db-archive-second/postgres.zip` | `274c355dccbfe73a645609b8b3e6db26fe4f3f8fa7d27616bc6826db5a631cbd` |
| `db-input-archive/postgres.zip` | `12b7cb50170f5e39ed8f0d80ea936245586f55f071183f349f3acd65c01df955` |

각 디렉터리의 `result.json`·`retirement.json`이 근거다. 원본 입력은 runtime·automation marker·backend PID·실행 결과·로그·전체 inventory로 이번 시험의 합성 데이터임을 확인했다. 보고서·실패 폴더·source fixture·다른 프로필 파일은 보존했다. 실사용 프로필·Keychain·secrets.enc·source vault는 이 보관 작업에서 읽지 않았다. 과거 진단의 원본 디렉터리 불변 검증은 **그 실행 시점의 사실**이며, 지금의 확장 PostgreSQL 디렉터리는 검증된 ZIP으로 대체되어 있다. 복원 후 inode 동일성이나 같은 UID의 모든 동시 변경을 원자적으로 배제했다는 보장은 하지 않는다.

### 검증용 중복 파일의 조기 정리

사용자의 추가 승인으로 완료된 작업자 8개의 검증용 복제본만 최종 작업트리 제거와 분리해 먼저 정리했다. 공통 native lock과 caffeinate 아래에서 등록 작업트리·통합된 HEAD·clean 상태·소유권·경로 identity·전체 파일 inventory·열린 파일을 확인했다. 원본과 다른 의존성 폴더는 제외했으며 작업트리 자체·소스·빌드 결과·실패 기록은 제거하지 않았다.

| 범위 | 제거한 복제본 | 불일치로 보존 | 시작 가용량(바이트) | 종료 가용량(바이트) |
| --- | ---: | ---: | ---: | ---: |
| 검증 앱 | 24 | 0 | 2,928,136,192 | 2,983,194,624 |
| 의존성 폴더 | 24 | 8 | 3,166,904,320 | 3,228,839,936 |

검증 앱의 보존 원본은 원본 저장소의 1lvULq·tZgvV7과 calm-meadow의 LA8ZS9이다. 기존 ad-hoc 서명 검증과 파일·실행 비트·링크 inventory 일치를 확인했으며 새 서명은 하지 않았다. 각 작업자 후보 디렉터리의 `DUPLICATE-RUNTIME-RETIRED.json`에 보존 원본 경로와 해시를 남겼다. 의존성 원본은 calm-meadow의 frontend·desktop·두 analyzer의 node_modules다. 이 보존 원본들은 후속 정리 대상에서 제외한다.

근거는 calm-meadow의 `validation/local/w24-ts-refresh/runtime-dedup-1/result.json`·`dependency-dedup-1/result.json`과 각 단계의 사전 비교·개별 retirement 기록이다. 다섯 합성 안전장치 smoke에서 실제 동일 복제본 제거와 불일치·열린 파일·identity 교체·원본 자체 지정 거부를 확인한 동일 제거 함수를 재사용했다. 두 실제 정리 모두 보존 원본의 전체 inventory와 작업자 소스 clean 상태를 종료 시 재확인했다.

논리 크기가 큰 복제본이라도 실제 가용량 증가는 작았다. APFS 공유 블록이 있는 복제본의 논리 용량을 회수량으로 간주하지 않는다. 두 구간 사이의 공간 변화에는 다른 호스트 작업도 포함될 수 있으므로 관측 차이를 이 정리의 독점 회수량으로 단정하지 않는다. 이 두 단계만으로는 large 재개 공간을 확보하지 못했다. 열린 파일 확인은 현재 사용자 권한의 시점 관측이며 동일 UID 동시 변경을 원자적으로 배제하거나 모든 확장 속성을 보존했다는 보장은 아니다.

### 사용자 승인 산출물 정리와 재개

추가 승인된 외부 프로젝트의 debug 산출물 한 경로만 Cargo 1.97.1의 dev-profile clean으로 정리했다. 실제 소형 빌드에서 debug만 제거되고 release·검증 자료·소스·lockfile이 보존되는 것을 먼저 실행 확인했다. 첫 합성 smoke의 CACHEDIR.TAG 안전 거부는 보존했으며, 실제 대상에 표식을 새로 쓰거나 안전 검사를 우회하지 않았다.

실제 dry-run의 28,306개 경로가 승인된 debug 트리와 정확히 같음을 확인하고 소유권·Git 미추적·미사용·외부 링크 경계를 검증했다. 정리 명령은 exit 0이며 보호 경로 메타데이터 20,475개와 보호 파일 8개의 해시는 전후 동일했다. 원래 있던 미커밋 수정도 유지했다. 다른 프로젝트의 구체 경로·수정 내용은 공개 문서에 옮기지 않는다. 상세 근거는 calm-meadow의 `validation/local/w24-ts-refresh/approved-debug-clean-1/result.json` 및 동반 검사 기록이다.

| debug 정리 전 가용량(바이트) | 정리 후 가용량(바이트) |
| ---: | ---: |
| 3,224,657,920 | 9,912,082,432 |

이후 같은 2ogirS의 large-only driver를 시작했다. medium 원본은 보존하고 추가 최적화·재빌드 없이 이번 진단 결과 수집과 마감만 진행한다.

원본 저장소로의 증거 복제는 측정·PR 병합·main fast-forward 뒤 마지막 한 번의 `/bin/cp -cRp` 보관 단계에서 수행한다. 계획한 새 위치는 `validation/local/release-gate-followup-20261009-2ogirS/`이며, `calm-meadow-validation/`과 `integration-validation/` 아래에 각 출처 경로를 유지한다. 이 문서 커밋 시점에는 미실행이며, 완료 여부는 해당 위치의 `archive-result.json`으로 확인한다. 기존 목적지는 덮어쓰지 않는다.

## 6. 미실행 수용과 사용자 입력

시작20회·small/medium/large G-PERF20회, packaged clean-full canonical, UX190, 비용 probe·PK-08·SBOM 재생성은 이번 후보 NOT RUN이다. 기존 실패·목표 미달·부하 무효를 통과로 바꾸지 않는다.

`coordination-2026-10-07/USER-INPUT-READINESS.md`의 일곱 입력 묶음은 준비 상태만 보고한다. 실계정/선택 repo·SSO 및 데이터 적용 승인, Developer ID/Team ID/notary, 두 번째 clean Mac·업데이트 출시 키/host/TLS, 독립 보안 reviewer·signed helper, annotator·adjudicator·허가 corpus, UX 참가자8명·moderator·VoiceOver, Redis/JRE/FFmpeg/EPL 법률 판단은 사람 입력이 필요하다.

실제 Keychain은 **NOT RUN, 사람이 실행**한다. 다음 명령은 안내만 했으며 실행하지 않았다. 조용한 AC·덮개 열린 기기에서 검증 후보만 지정한다.

```sh
cd ~/Dev/ciw/int
~/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/coordination/with-native-lock.sh keychain \
  caffeinate -i env -i HOME="$HOME" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node desktop/scripts/packaged-keychain-acceptance.cjs \
  --app "$PWD/.native-product-2ogirS/Code Intelligence Validation.app"
```
