# p6yGme 출시 게이트 후속 — 2026-10-08

**판정: NO_GO.** 승인된 증분 import/parsing을 통합했지만 medium 초기 분석·1% refresh와 large 초기 분석이 목표를 초과했다. 사용자가 추가 최적화를 승인했으며, 이 후보로 PR 병합·출시를 진행하지 않는다. 최종 20회 성능 게이트·정식 서명/공증·독립 평가·실계정/실제 Keychain 수용은 통과로 바꾸지 않는다. 이전 실패는 [h7hpw4 감사](candidate-h7hpw4-2026-10-08.md)에 보존한다.

## 1. 기준과 실행 조건

| 항목 | 값 |
| --- | --- |
| 기준 main / 이전 후보 | `6ddeefb` (PR #110) / `h7hpw4` |
| 통합 브랜치 / 빌드 작업트리 | `release/gate-followup-20261008` / `~/Dev/ciw/int` detached |
| 후보 제품 소스 | `f0b983f24879c1f42e46fe999773a2fac776594c`, sourceWorkingTree=false |
| baseline / 격리 | `tZgvV7` / `--adapter-isolation xpc-required` |
| build sequence / 결과 | `1791450287639` / `pre-release-candidate/build-76Ivoj`, PACKAGED_NOT_RELEASED |
| manifest SHA-256 | `d2d9f551843a1338027fb71280bd8f79f6f4c6ae0d6c16f3bd8cbe7d9f5e376c` |
| app.asar SHA-256 | `1b4feb7d80d0faf94b5ecfca6d0b1f9b4bdb2d9d404ab7057cdc5ee16a6d82d5` |

모든 패키지 실행은 calm-meadow의 `validation/local/coordination/with-native-lock.sh`와 `caffeinate -i`로 직렬화했다. AC·외부 화면을 확인했으나 센서상 덮개가 닫혀 있어 최초 preflight 두 건은 시험 시작 전에 중단했다. 사용자가 **이번 기능 진단과 medium/large smoke에 한해 AC·외부 화면 clamshell 예외**를 승인했다. 최종 20회 게이트에는 이 예외를 적용하지 않는다. 시간 측정은 기존 `stage5-timing.sh`의 load1<4·mdworker_shared≤6, 30초 간격 3회 확인 후 시작한다.

원본 설치 앱·실사용 프로필·실제 Keychain·자격증명·유료 호출·실계정·GitHub Actions는 사용하지 않았다. 앱은 로컬 ad-hoc 검증 변형이며 정식 서명·공증·출시가 아니다. 증거 경로는 별도 표시가 없으면 `validation/local/` 기준이다.

## 2. 변경과 안전 경계

- [w13 전송 실패](w13-transport-2026-10-08.md): timeout·전송·거부의 typed failureCode를 분류하고 redaction 후에도 보존한다. 새 재시도 정책은 추가하지 않았다. 통합 담당자가 실제 Node 강제종료를 포함한 대상 21/21을 확인했다.
- [w14 loopback](w14-loopback-2026-10-08.md): 다른 프로세스의 인증 없는 GET/HEAD 탐침만 요청 수에서 제외한다. 진짜 요청·잘못된 인증 요청은 유지한다. 실제 Electron TLS를 포함한 대상 29/29을 확인했다.
- [w15 측정·picker](w15-runner-2026-10-08.md): 빈 아이콘 버튼의 잘못된 ACK를 제거하고 renderer의 같은 clock domain에서 실제 클릭 이후 상태를 관측한다. 음수를 0으로 보정하지 않는다. 느슨한 picker 사본을 공유 도우미로 교체했다. 대상 28/28, 재분석 UI 27/27, metrics/ACK 20/20을 확인했다.
- [w16 Java](w16-java-incremental-2026-10-08.md): 실제 bytes·선언·resolver/config 경계에 묶인 불변 tape와 bounded reuse, 단일 framework AST, 취소 가능한 대기를 도입했다. `.git` 소스는 포함하지 않는다. 통합 핵심 58/58과 실제 DB canonical 비교를 확인했다.
- [w17 adapter](w17-adapter-incremental-2026-10-08.md): HMAC 검증을 거친 불투명 재사용 토큰, 전역 설정·의존성/SCC 무효화와 보수적 재계산을 구현했다. manifest 50k files/512MiB, request 10MiB/chunk 1MiB 경계는 유지한다. 통합 TS 대상 46/46, 새 Node 프로세스 및 medium 진단, backend 대상 17/17, tree 15/15을 확인했다. tree analyzer는 macOS 후보에 배포하지 않는다.
- [w18 import](w18-import-2026-10-08.md): 실제 현재 bytes와 committed sealed manifest를 검증한 source vault RETAIN, inventory/SQL batching을 구현했다. 승인 snapshot의 전체 범위 검증·암호화·무결성 확인을 생략하지 않는다. vault 48/48, backend 208/208 및 실제 broker PUT→RETAIN→READ/손상 거부를 확인했다.

Java cache는 총 256MiB, adapter 소유 토큰은 16MiB로 제한한다. 재시작·부족·불명확한 무효화 조건은 재계산으로 돌아간다. 이 제한은 무제한 warm 성능 보장이 아니다. 새 migration과 외부 의존성 변경은 없다.

## 3. 통합 회귀와 보존된 실패

| 실행 | 실제 결과 | 증거 |
| --- | --- | --- |
| 최초 통합 `a15ba08` | frontend 480 PASS + tsc, TS 317 PASS, validation runners 419 PASS | `post-merge-20261008-refresh` |
| 같은 실행 desktop | 총 3,320: 3,275 PASS / 0 FAIL / 45 SKIP | 같은 디렉터리 |
| 최초 backend/events | 새 Java 파일의 Spotless 위반으로 시험 시작 전 중단 | `docker-integration/backend-Ixn7Sb`, `events-h7ZIXx` |
| 형식 수정 `3cebb73` backend 전체 | 총 2,053: 2,034 PASS / 1 FAIL / 18 SKIP | `docker-integration/backend-jl6yBm` |
| 같은 실행 events | 19/19 PASS | `docker-integration/events-f8jM3O` |
| source boundary 후속 `f0b983f` | calm-meadow·int 각각 대상 49/49 PASS, int Spotless PASS | `followup-main-verification/source-boundary`, `regression-source-boundary/int` |
| import 판정 수정 후 pre-release | 305/305 PASS; 앞선 419 전체 묶음 재실행과 구분 | `stage5-p6yGme/runners-import-fix.log` |

전체 backend의 한 실패는 `.git/injected/Helper.java`를 분석 대상으로 삼아 호출 결과가 바뀌어야 한다는 오래된 시험이었다. 그 잘못된 기대를 삭제하고 cold/warm canonical 결과에서 숨김 소스가 제외되는 소비자 경계 시험을 추가했다. 기존 retry source-guard 거부 시험은 유지했다. **전체 backend 실행의 FAIL 기록은 그대로이며, 후속 49개 통과를 전체 재실행 PASS로 쓰지 않는다.**

제품 `backend/src/main` digest는 전체 backend 실행과 후보가 모두 `4a03857aabc75f028faaffdc2d9a7ed3b392e318d0ef452fc0c2b4316c257e45`다. 이후 `589a859`는 import 검증 러너와 회귀 시험만 바꿨으므로 앱 재빌드는 하지 않았다. Gradle 대상 시험은 cleanTest 경로로 실행했다.

## 4. 변경 영역 패키지 검증

| 실행 | 실제 결과 | 증거 |
| --- | --- | --- |
| 제품 시퀀스 | 36 PASS | `pre-release-final/product-60diCK` |
| 작업 경합 | 8 PASS; adapter 실패의 `ADAPTER_ISOLATION_UNAVAILABLE` 관측 | `job-race/product-TBLnd4` |
| 내부 보안 탐침 | COMPLETE; fuse·node modes·renderer CSP PASS | `security-internal-review/packaged-oLxlUs` |
| owner crash AFTER_SOURCE_RENAME | 6 PASS | `electron-crash/native-G38xQy` |
| owner crash BEFORE_COMPLETED_CLEANUP | 6 PASS | `electron-crash/native-RVsuzo` |
| UX 자동 pilot | 190상태 완료, 오류·화면 실패·대비 위반·배경 판정 불가 각각 0; 18,278개 대비 검사 | `pre-release-ux/ux-MdsaXC`, `stage5-p6yGme/ux-counts.json` |
| import-evidence 최초 | 11개 확인 뒤 published-facts 판정 FAIL, 보존 | `import-evidence/native-3pl71y` |
| import-evidence 러너 수정 후 | 같은 후보에서 14 PASS, 세 facts 결과 실패0, 후보 불변 | `import-evidence/native-6eGse3` |

최초 import 실패는 파일 단위 CONFIG/MIGRATION의 이름인 파일명이 소스 문자열에도 있어야 한다고 잘못 요구한 러너 판정이었다. 정확한 natural key·파일명·첫 줄·전체 범위 또는 publisher의 파일 위치를 검증하도록 고쳤다. 세부 엔티티의 literal span과 승인 bytes/OID/snapshot·namespace·evidence bounds는 유지했다. RED 7개 중 3 FAIL → GREEN 7/7 PASS. 당시 18:13:01–18:33:49 KST의 pmset 기록에는 Sleep/Wake/DarkWake가 없었다. 원본 실패와 `stage5-p6yGme/pmset-import-failure.log`, `sleep-correlation-import.json`을 보존한다.

실제 native 창의 synthetic 프로젝트/settings 화면도 관측했다(`stage5-p6yGme/native-surface.png`). 이것은 사람이 OS picker를 직접 클릭하거나 VoiceOver를 평가한 증거가 아니다.

### 별도 staged picker 경로

`adapter-isolation-stage`는 legacy runtime 레이아웃과 거부 탐침 worker를 조립하므로 tZgvV7에 통합 소스를 올린 **별도 ad-hoc 앱**에서 실행했다. p6yGme를 수정하지 않았다. 공유 picker의 단일 호출·title·properties 검사 후 분석 DONE·graph 9개, app→launchd supervisor→adapter-node 경로, probe 및 node grandchild의 sandbox=1·파일 read/create·TCP connect/listen·UDP 거부, 종료 뒤 adapter 프로세스0을 관측했다. 증거: `stage5-p6yGme/adapter-stage-analysis/result.json`. DNS 오류만으로 DNS egress 차단을 주장하지 않는다. 후보 검증이나 Developer ID signed-helper C15 PASS로 대체하지 않는다.

## 5. medium·large smoke-2 실제 측정

두 실행 모두 SMOKE_ONLY·measurementStatus=COMPLETE다. 실행 완료는 SLO 통과가 아니다. 2회 측정으로 p95나 최종 20회 gate를 판정하지 않는다.

| 크기·실행 | 초기 분석(초) | 1% refresh(초) | 분석 중 RSS 최대(KiB) | 취소 ACK / 해제(ms) |
| --- | ---: | ---: | ---: | ---: |
| medium 1 | 198.922 | 110.086 | 3,011,120 | 1 / 225 |
| medium 2 | 198.012 | 108.495 | 2,973,616 | 1 / 226 |
| large 1 | 651.161 | 551.899 | 4,610,960 | 1 / 121 |
| large 2 | 610.235 | 529.440 | 4,603,856 | 1 / 117 |

medium 초기 분석 한도는 180초, refresh 한도는 30초다. large 초기 분석 한도는 600초이며, 이 large 러너 결과에는 별도 refresh SLO가 정의되어 있지 않다. large refresh를 임의의 30초 한도와 비교하지 않는다. UI preview/cancel ACK는 두 크기 모두 음수가 아니었다. 네 refresh 모두 packaged clean-full canonical 비교는 NOT_RUN이고 resultEqualsFull=null이다.

fixture는 medium 10,000파일/50MiB, large 50,000파일/**200MiB**이며 generator SHA-256은 `f604121c8d78b035b8a4809b3c3e388ae25cb37660579c0993a9c2eb48bfbba9`다. large를 250MiB로 표기하지 않는다. 시작 입장 부하는 medium 3.66, large 3.37이었다. 후보 bytes와 bundle은 두 실행 전후 불변이다.

주요 단계는 medium 초기 IMPORT 23.7–24.0초·SOURCE_PARSING 68.2–68.9초·TS_PARSING 92.5–93.1초, refresh IMPORT 29.5–30.2초·SOURCE_PARSING 16.0–18.3초·TS_PARSING 49.8–50.5초였다. large 초기 SOURCE_PARSING은 302.1–321.4초, IMPORT는 114.8–117.4초였다. 단독 analyzer의 캐시 재사용 성공만으로 이 end-to-end 비용이 해소되었다고 판단하지 않는다.

원본: `workload-performance/run-bjLzXG/result.json`, `run-Fn31Fu/result.json`. 집계·원장: `stage5-p6yGme/performance-facts.json`, `ledger.json`; 실행 조건: `timing-summary.txt`. 원본 실패와 측정값은 유지하고 다음 후보 결과로 덮어쓰지 않는다.

medium 19:03:58–19:16:08 KST와 large 19:19:38–20:05:07 KST를 전체 원본 pmset 로그와 대조했다. 해당 구간의 실제 Sleep/Wake/DarkWake 전이는 각각 0건이었다(일반 assertion과 예약 WakeRequests는 전이로 세지 않음). 원본 `pmset-timing.log`와 SHA-256·대조 결과 `sleep-correlation-timing.json`을 보존한다. 따라서 이번 목표 초과를 관측된 sleep 탓으로 돌리지 않는다.

## 6. 미실행과 사용자 입력 준비

시작 20회, small/medium/large G-PERF 20회, **packaged canonical clean-full 동등성**, 비용 probe·PK-08·SBOM 재생성은 이번 후보 NOT RUN이다. workload의 overview/outcome 개수 일치는 진단값일 뿐이므로 `resultEqualsFull=null`, `fullResultComparison=NOT_RUN`으로 기록한다. 단위/standalone canonical 비교를 이 패키지 gate에 복사하지 않는다.

`USER-INPUT-READINESS.md`의 준비물은 유지되며 다음 입력이 남는다.

| 항목 | 준비 상태 / 남은 입력 |
| --- | --- |
| GitHub OAuth·기존 project1 | 계약/복구 러너 준비; 실계정·선택 repo/SSO·실사용 데이터 rollback 승인 필요 |
| 서명·공증 | runbook·스크립트 준비; Developer ID·Team ID·notary profile 필요 |
| clean Mac·업데이트 | updater/검증 계획 준비; 두 번째 Mac(macOS 13/current), 출시 키·host/TLS·Team ID 필요 |
| 독립 보안 검토 | xpc-required 내부 증거 준비; 독립 reviewer와 signed-helper C15 필요 |
| 정확도 | annotation/export 도구 준비; annotator 2명·adjudicator·허가된 corpus·blind review 필요 |
| 사용성 | kit와 자동 pilot 준비; 참가자 8명·moderator·실제 VoiceOver 평가 필요 |
| 법률 | SBOM/고지 자료 준비; Redis/JRE/FFmpeg/EPL 판단 필요 |

실제 Keychain은 **NOT RUN, 사람이 실행**한다. 조용한 AC·덮개 열린 기기에서 다음 명령을 사용한다. 기존 설치 앱이나 실사용 프로필을 지정하지 않는다.

```sh
cd ~/Dev/ciw/int
~/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/coordination/with-native-lock.sh keychain \
  caffeinate -i env -i HOME="$HOME" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node desktop/scripts/packaged-keychain-acceptance.cjs \
  --app "$PWD/.native-product-p6yGme/Code Intelligence Validation.app"
```

이 명령은 안내만 했으며 실행하지 않았다. 실계정·전원 손실·정식 배포 수용을 승인 없이 추가하지 않는다.
