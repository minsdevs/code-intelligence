# XPhUTE 추가 성능 최적화 후보 — 2026-10-08

**현재 판정: NO_GO.** 통합 회귀와 변경 영역 패키지 기능은 확인했다. medium refresh 원시 관측은 30초 목표를 넘었고, medium 두 번째 회차와 large 두 회차는 기록된 시작 부하도 기준을 넘었다. 유효한 smoke-2 성능 수용이나 최종 게이트 통과로 해석하지 않는다. 최종 20회·정식 서명/공증·독립 평가·실계정/실제 Keychain 수용도 미완료다. 이전 목표 미달과 실패는 [p6yGme 감사](candidate-p6ygme-2026-10-08.md)와 [h7hpw4 감사](candidate-h7hpw4-2026-10-08.md)에 보존한다.

## 1. 기준과 실행 조건

| 항목 | 값 |
| --- | --- |
| 공개 기준 main | `6ddeefb32c0cbeafcf96bf84e38e73901802f569` (PR #110) |
| 통합 브랜치 / 빌드 작업트리 | `release/gate-followup-20261008` / `~/Dev/ciw/int` detached |
| 후보 제품 소스 | `be698cca3f723e7c3235abe811cb2548cb956042`, sourceWorkingTree=false |
| baseline / 격리 | `tZgvV7` / `--adapter-isolation xpc-required` |
| build sequence / 결과 | `1791470086372` / `pre-release-candidate/build-itxgux`, PACKAGED_NOT_RELEASED |
| manifest SHA-256 | `bb39c03174aac8e79d6c8c6d7092c103dbab6a6a1e2ad6a7b89c9f342294c561` |
| app.asar SHA-256 | `df9843dc9fcf2afb65ee9358c520362bafb3f7c47f3b598d49dae474b86bfe15` |
| backend/src/main digest | `5f6ee1346075406c8f937d25166e4beaf5701cbc80d4ab8774f9738047abe21a` |

증거 경로는 별도 표시가 없으면 `int/validation/local/` 기준이다. 빌드와 기능 실행은 2026-10-08 KST, 아래 성능 smoke는 2026-10-09 KST에 완료했다. 패키지 실행은 calm-meadow의 `validation/local/coordination/with-native-lock.sh`와 `caffeinate -i`로 직렬화했다. 사용자가 승인한 **AC·외부 화면·덮개 닫힘 예외는 진단 smoke에만 적용**하며 최종 20회 수용에는 적용하지 않는다. 기존 타이밍 드라이버의 최초 quiet 확인만으로 회차별 실행 직전 부하를 보장하지 못한 결함과 실제 부하 초과는 아래에 구분해 기록한다.

원본 설치 앱·실사용 프로필·실제 Keychain·자격증명·유료 호출·실계정·GitHub Actions는 제품 검증에 사용하지 않았다. 로컬 ad-hoc 검증 변형이며 정식 서명·공증·출시가 아니다. 새 migration과 외부 의존성 변경은 없다.

## 2. 추가 변경과 메인 재검증

| 유닛 | 변경과 유지한 경계 | 메인 검증 |
| --- | --- | --- |
| [w19 import](w19-import-perf-2026-10-08.md) | 새 Git snapshot을 pack으로 쓰고 flush 후 게시. source vault의 중복 leaf stat만 재사용하며 ancestor·symlink·승인 bytes/OID·취소/rollback 검증은 유지 | desktop 157/157, backend 132/132 PASS |
| [w20 Java](w20-java-perf-2026-10-08.md) | 완전한 Java 선언 inventory가 확인될 때만 존재하지 않는 source type의 반복 탐색을 차단. 불완전/실패/unknown/layout 불일치는 기존 resolver로 돌아감 | 대상 64/64 PASS, 실제 DB canonical 비교 포함 |
| [w21 adapter](w21-adapter-perf-2026-10-08.md) | Nest provider마다 전체 method map을 순회하던 경로를 owner index로 교체. quoted/computed 이름과 순서를 유지. 효과가 없던 React 변경은 반영하지 않음 | TS 142/142 PASS, TypeScript build PASS |
| [w22 근거·상태 저장](w22-persistence-2026-10-08.md) | 근거 삭제 구간만 기존 CustomPlans 적용 후 설정 복원. 파일 상태는 최대500개 tuple update, 반복 path에서 flush하여 순차 상태 전이 유지 | 실제 DB 6/6 및 상태/소비자 경로 17/17 PASS |

w22는 기존 근거 120,000개·대상 40,000개 교체에서 삭제 50,191ms로 8초 예산을 넘는 실패를 먼저 재현했다. 수정 후 예산 시험 전체 JUnit 시간은 2.310초이며, 이를 삭제 구간 정밀 측정값으로 쓰지 않는다. 별도 실제 PostgreSQL 1,001행 상태 저장은 왕복 1,001회에서 3회로 줄었고 상태·이유·targeted와 snapshot 경계를 확인했다.

Java cache 256MiB, adapter token 16MiB 및 기존 source/request 제한은 유지한다. 고부하 standalone before/after의 wall time은 유효한 성능 개선값으로 쓰지 않는다. 구체적인 실패와 검증 명령은 각 유닛 감사에 있다.

## 3. 통합 회귀

`coordination-2026-10-08/regress.sh post-merge-20261008-perf2`를 재사용했다. 2026-10-08 23:19:31–23:32:40 KST, 7개 실행 명령 모두 exit 0이다. Gradle은 cleanTest 경로로 재실행했다.

| 영역 | 실제 결과 |
| --- | --- |
| frontend | 480 PASS, 실패/skip 0; tsc PASS |
| TS analyzer | 318 PASS, 실패/skip 0 |
| validation runners | 426 PASS, 실패/skip 0 |
| desktop | 총3,322: 3,277 PASS / 0 FAIL / 45 SKIP |
| backend | 총2,064: 2,046 PASS / 0 FAIL / 18 SKIP |
| events | 19 PASS, 실패/skip 0 |

합계 **6,566 PASS / 0 FAIL / 63 SKIP**, 전체6,629개다. 증거는 `post-merge-20261008-perf2/regression-facts.json`·원본 로그와 `docker-integration/backend-ivppOw`, `events-tFKzPF`다. tree analyzer 독립 suite는 제품 코드가 바뀌지 않아 이번에 NOT RUN이며, 바뀐 backend TreeParsingStep 소비자는 backend 전체 회귀에 포함됐다.

이전 p6 전체 backend의 1실패는 그대로 보존한다. 이번 새 실행의 통과로 과거 결과를 고쳐 쓰지 않는다. w19 최초 메인 검증의 umask-dependent fixture 실패, w21 build 시작 전 npm 설정 오류, w22 quiet admission deadline 종료와 새 fixture 초기값 오류도 각 유닛에 남겼다. 실행되지 않은 시험을 제품 실패나 통과로 분류하지 않는다.

## 4. 변경 영역 패키지 검증

| 실행 | 실제 결과 | 증거 |
| --- | --- | --- |
| 제품 시퀀스 | 36 PASS | `pre-release-final/product-f6QDPt` |
| 작업 경합 | 8 PASS | `job-race/product-OtJ6Ev` |
| 내부 보안 탐침 | COMPLETE; fuse·node modes·renderer CSP PASS | `security-internal-review/packaged-9KFoOa` |
| import-evidence | 14 PASS; 승인8파일, 과거/새 snapshot facts와 근거 검증 | `import-evidence/native-AcTEGz` |
| owner crash AFTER_SOURCE_RENAME | 6 PASS | `electron-crash/native-WlE4QV` |
| owner crash BEFORE_COMPLETED_CLEANUP | 6 PASS | `electron-crash/native-cmsvU4` |

기존 `stage5-delta.sh XPhUTE`와 `stage5-XPhUTE/changed-native.sh`로 실행했다. 원본 note/source 복구와 추가 재시작을 확인한 실제 프로세스 SIGKILL 시험이며 전원 손실 검증은 아니다. 모든 결과를 후보의 app.asar/manifest digest에 묶었다. 내부 보안 탐침을 독립 검토나 signed-helper C15 PASS로 대체하지 않는다.

정확한 XPhUTE 앱 경로와 PID를 대조해 실제 native 창을 읽기 전용 관측했다. `stage5-XPhUTE/native-surface.png`는 import 진행 화면, 뒤이어 수집한 `native-surface.json`의 AX는 합성 attack-project의 완료 overview와 GET /hello 근거를 보여 준다. 서로 다른 전이 순간이며 한 화면의 동시 상태라고 주장하지 않는다. 입력·권한 변경은 없었고 사람 UX/VoiceOver 수용 증거가 아니다.

## 5. 성능과 미실행 범위

2026-10-09 medium `00:30:43–00:39:44`, large `00:43:15–01:22:45` KST에 실행했다. 원시 러너 상태는 둘 다 `SMOKE_ONLY / COMPLETE`이며 이는 분석 동작의 완료이지 SLO PASS가 아니다. 목표는 medium 초기 180초·1% refresh 30초, large 초기 600초다. large refresh의 별도 SLO는 정의되어 있지 않다.

| 클래스·회차 | 초기 분석(초) | 1% refresh(초) | 기록된 회차 시작 load1 | 해석 |
| --- | ---: | ---: | ---: | --- |
| medium 1 | 125.759 | 86.848 | 3.1362 | refresh 원시 관측은 목표 초과. 기록 시점의 부하만 기준 내이며 앱 실행 직전 재확인은 없음 |
| medium 2 | 124.478 | 89.946 | 7.8022 | INVALID_LOAD; 유효한 성능 수용에 사용하지 않음 |
| large 1 | 528.322 | 478.331 | 6.4956 | INVALID_LOAD; 600초보다 작은 원시 값으로 통과 주장 금지 |
| large 2 | 518.041 | 463.693 | 5.4751 | INVALID_LOAD; 동일 제한 |

medium은 10,000파일·50MiB 중 100파일, large는 50,000파일·200MiB 중 500파일을 변경했다. medium의 두 번째 회차도 부하 초과였으므로 large만 무효라고 취급하지 않는다. 두 결과 모두 source/app hash 불변과 소유 프로세스 종료를 확인했지만, canonical 동등성은 NOT RUN이다. 전체 pmset 원본 36,751,392bytes를 위 실행 구간과 대조했으며 실제 Sleep/Wake/DarkWake 전환은 각각 0건이었다. 이는 부하 위반을 해소하는 증거가 아니다.

원본은 `workload-performance/run-BpwTie/result.json`, `workload-performance/run-cOyQOC/result.json`에 유지한다. `stage5-XPhUTE/performance-facts.json`, `sleep-correlation-timing.json`, `ledger-plan.json`, `ledger.json`에 회차별 유효성과 원본 해시를 기록했다. 기존 후보의 실패·새 후보의 미실행을 통과로 변경하지 않았다.

후속 검증 러너 `0f8b94e`는 fixture 준비 뒤 매 앱 실행 직전에 load1<4·mdworker_shared≤6을 30초 간격으로 3회 확인하고, 세 번째 성공 후 추가 대기 없이 실행한다. 대상 시험 30/30 PASS. 실제 `workload-performance/run-N3xuOT`에서 부하 조건 탈락 4회/6회 뒤 각각 연속 3회 확인을 거쳐 실행했고, `QUIET_HOST_OBSERVED_AT_LAUNCH`, 분석 완료·정상 종료·source/app 불변을 확인했다. 이 실행의 JVM 표본 수집은 ERR_ASSERTION으로 실패했으므로 별도 진단 실패로 보존하며, 진단용 시간은 SLO 판정에 쓰지 않는다.

사용자 승인에 따라 이후 최적화 반복은 대상 시험과 실제 변경 경로에 한정한다. 성능이 수렴하면 통합 회귀·새 후보·영향 패키지·medium/large smoke-2를 묶어서 진행한다. 안전성·복구 경계와 기존 성능·독립 수용 기준은 유지하며, 최종 20회는 최종 후보에서만 수행한다.

시작20회, small/medium/large G-PERF20회, packaged clean-full canonical 동등성, 비용 probe·PK-08·SBOM 재생성은 이번 후보 **NOT RUN**이다. overview/outcome 개수 일치는 canonical 동등성의 대체 증거가 아니다. UX190 자동 pilot도 frontend digest가 이전 후보와 같으므로 이번에 NOT RUN이며, p6의 실행 결과는 역사적 기록으로만 유지한다.

## 6. 사용자 입력 준비

`coordination-2026-10-07/USER-INPUT-READINESS.md`의 준비 상태를 유지한다. 실제 GitHub 계정·선택 repo/SSO와 데이터 적용 승인, Developer ID/Team ID/notary profile, 두 번째 clean Mac과 업데이트 출시 키·host/TLS, 독립 보안 reviewer와 signed helper, annotator 2명·adjudicator·허가 corpus, UX 참가자8명·moderator·VoiceOver, Redis/JRE/FFmpeg/EPL 법률 판단은 여전히 사용자/사람 입력이 필요하다.

실제 Keychain은 **NOT RUN, 사람이 실행**한다. 조용한 AC·덮개 열린 기기에서 검증 후보만 지정한다. 다음은 명령 안내이며 실행하지 않았다.

```sh
cd ~/Dev/ciw/int
~/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/coordination/with-native-lock.sh keychain \
  caffeinate -i env -i HOME="$HOME" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node desktop/scripts/packaged-keychain-acceptance.cjs \
  --app "$PWD/.native-product-XPhUTE/Code Intelligence Validation.app"
```
