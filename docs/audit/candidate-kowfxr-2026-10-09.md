# KOwFxr refresh 병목 개선 후보 — 2026-10-09

**현재 판정: NO_GO.** 통합 회귀와 변경 영역의 패키지 기능은 확인했지만 medium 1% refresh 목표 미달이 남았다. 최종 20회·정식 서명/공증·독립 평가·실계정/실제 Keychain 수용도 미완료다. 이전 후보의 목표 미달·부하 위반은 [XPhUTE 감사](candidate-xphute-2026-10-08.md), [p6yGme 감사](candidate-p6ygme-2026-10-08.md), [h7hpw4 감사](candidate-h7hpw4-2026-10-08.md)에 보존하며 새 실행 결과로 고쳐 쓰지 않는다.

## 1. 기준과 실행 조건

| 항목 | 값 |
| --- | --- |
| 공개 기준 main | `6ddeefb32c0cbeafcf96bf84e38e73901802f569` (PR #110) |
| 통합 브랜치 / 빌드 작업트리 | `release/gate-followup-20261008` / `~/Dev/ciw/int` detached |
| 후보 제품 소스 | `a04fa4d1edae6c72e31a9b7652f6c98c11869ae0`, sourceWorkingTree=false |
| baseline / 격리 | `tZgvV7` / `--adapter-isolation xpc-required` |
| build sequence / 결과 | `1791503346245` / `pre-release-candidate/build-hvP3ca`, PACKAGED_NOT_RELEASED |
| manifest SHA-256 | `1a46a98215dc88a264a5af2095777b1b3a9e40c936349909e210946e05151640` |
| app.asar SHA-256 | `e0511eea85f7ac2a313cd662cde318739bc0133dad5fd0ae50d667dd83813584` |
| backend/src/main digest | `58d5d10abc73ad62286ef5717f46e754c58dff52b102a72660be9da482f44185` |

증거 경로는 별도 표시가 없으면 `int/validation/local/` 기준이다. 패키지 실행은 calm-meadow의 `validation/local/coordination/with-native-lock.sh`와 `caffeinate -i`로 직렬화했다. 사용자가 승인한 **AC·외부 화면·덮개 닫힘 예외는 진단 smoke에만 적용**하며 최종 20회 수용에는 적용하지 않는다. 실행 직전 quiet admission은 load1<4·mdworker_shared≤6을 30초 간격으로 세 번 확인한다. 이는 실행 경계 관측이며 실행 전체의 부하를 연속 보증하는 장치는 아니다.

원본 설치 앱·실사용 프로필·실제 Keychain·자격증명·유료 호출·실계정·GitHub Actions는 제품 검증에 사용하지 않았다. 로컬 ad-hoc 검증 변형이며 정식 서명·공증·출시가 아니다. 빌드 결과의 `sourceAndBaselineUnchanged=true`를 확인했다. 새 migration과 외부 의존성 변경은 없다.

## 2. 추가 변경과 대상 검증

자세한 원인·실패·실제 변경 경로 증거는 [w23 감사](w23-refresh-2026-10-08.md)에 기록했다. 이전 후보까지의 증분 Java/adapter 처리·import·근거/상태 저장 변경은 XPhUTE 감사에 연결되어 있다.

| 변경 | 유지한 경계 | 별도 대상 검증 |
| --- | --- | --- |
| FILE→type 연결의 파일 ID 조건 | 현재 snapshot·canonical FILE natural key·허용 type 조건 | 실제 PostgreSQL 대상 3/3 PASS; 통계 없는 새 snapshot의 별도 실행 계획 비교 |
| retained source 인증의 최대 4개 동시 읽기 | ownership·경로·AEAD·key ID·기존 queue 직렬화; 진행 중 읽기를 모두 회수한 뒤 실패 | 관련 158/158 PASS; 실제 모듈 256개 blob readback·변조 거부·close/reopen; 두 소비자-visible mutant 실패 확인 |
| node/edge SQL의 최대 500개 묶음 처리 | 중복 키에서 flush; metadata/마지막 값 의미·nullable 값·natural-key ID 대응 | DB 대상 11/11 PASS; 실제 서비스의 전체 node/edge canonical 내용이 원본·변경 전후 일치 |
| 본문 secret 검사 literal 사전 검사 | 기존 signature/assignment 정규식·placeholder·source/config 판정과 전체 read/hash 유지 | import/fingerprint·binding·secret corpus 198/198 PASS; 실제 제품 클래스 판정 45,940개 일치 |
| 실제 TypeScript 연동의 그래프 소비자 | 실제 loopback analyzer와 PostgreSQL 사용 | 일반 test에서 제외되는 React route binding을 전용 accuracyTest로 실행, 5/5 PASS |

격리 진단의 속도 차이를 패키지 전체 성능 개선율로 쓰지 않는다. JDBC execute 계수도 wire round-trip 측정으로 해석하지 않는다. 기존 SQL의 작은 Docker 재현 시도는 PASS였으므로 실패 재현으로 세지 않는다. 실제 Unix socket fixture의 최초 197 PASS / 1 FAIL과 수정 뒤 실패 시험 우선 재검증, quiet timeout·provenance assertion 등 진단 실패도 그대로 남겼다.

## 3. 통합 회귀

`coordination-2026-10-08/regress.sh post-merge-20261009-perf3`를 재사용했다. 7개 실행 명령 모두 exit 0이며 Gradle은 cleanTest 경로로 재실행했다. 후보와 회귀의 소스 커밋이 같다.

| 영역 | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| frontend | 480 | 0 | 0 |
| TS analyzer | 318 | 0 | 0 |
| validation runners | 428 | 0 | 0 |
| desktop | 3,278 | 0 | 45 |
| backend | 2,063 | 0 | 18 |
| events | 19 | 0 | 0 |
| 합계 | 6,586 | 0 | 63 |

전체 6,649개이며 frontend tsc도 PASS다. `post-merge-20261009-perf3/regression-facts.json`·원본 로그와 `docker-integration/backend-x8WJ3u`, `events-quk5qw`를 근거로 집계했다. tree analyzer 독립 suite는 코드가 바뀌지 않아 이번에 NOT RUN이다. 공유 graph persistence는 backend 시험과 별도 실제 서비스 정합성 진단으로 확인했다. SKIP 63개를 통과로 합산하지 않았다.

## 4. 변경 영역 패키지 검증

| 실행 | 실제 결과 | 증거 |
| --- | --- | --- |
| 제품 시퀀스 | 36 PASS | `pre-release-final/product-hFgEZN` |
| 작업 경합 | 8 PASS | `job-race/product-39fV6m` |
| 내부 보안 탐침 | COMPLETE; fuse·node modes·renderer CSP PASS | `security-internal-review/packaged-MbZdVd` |
| import-evidence | 14 PASS | `import-evidence/native-yXNzoo` |
| owner crash AFTER_SOURCE_RENAME | 6 PASS | `electron-crash/native-RwgpMc` |
| owner crash BEFORE_COMPLETED_CLEANUP | 6 PASS | `electron-crash/native-SBgwvn` |

기존 `stage5-delta.sh KOwFxr`와 calm-meadow의 `w23-refresh/changed-native.sh KOwFxr`로 실행했다. 모든 명령 exit 0, 후보 app.asar/manifest 일치와 기록된 mock Keychain·실계정 미사용을 `stage5-KOwFxr/native-facts.json`에서 대조했다. SIGKILL 복구는 전원 손실 검증이 아니며 내부 보안 탐침은 독립 보안 검토·signed-helper C15 수용의 대체물이 아니다.

## 5. 성능 진단과 잔여 병목

기존 stage5-timing.sh KOwFxr로 medium 09:36:49–10:03:02, large 10:05:32–11:13:36 KST에 실행했다. 각 구간에는 warmup·회차 사이 quiet 대기도 포함된다. 두 러너 모두 SMOKE_ONLY / COMPLETE, exit 0이며 여섯 번의 앱 실행(warmup 포함) 모두 실행 직전 quiet admission과 AC 경계 관측을 확인했다. 이는 최종 20회 SLO 수용이 아니다.

| 클래스·회차 | 초기 분석(초) | 1% refresh(초) | 실행 직전 load1 |
| --- | ---: | ---: | ---: |
| medium 1 | 139.791 | 79.094 | 3.3682 |
| medium 2 | 136.082 | 80.364 | 3.6831 |
| large 1 | 529.340 | 398.829 | 2.6606 |
| large 2 | 526.712 | 398.680 | 3.4614 |

medium은 10,000파일·50MiB 중 100파일, large는 50,000파일·200MiB 중 500파일을 변경했다. large 초기 분석은 두 관측 모두 600초 이내지만, medium refresh는 30초 목표에 미달한다. large refresh의 별도 SLO는 없다. 전체 canonical 비교는 NOT RUN이며 resultEqualsFull=null을 유지했다. 두 결과의 source/app 불변과 각 실행의 cleanup을 확인했다.

| medium refresh 단계 | 1회차(ms) | 2회차(ms) |
| --- | ---: | ---: |
| IMPORT | 13,690 | 14,199 |
| SOURCE_PARSING | 13,442 | 12,804 |
| GRAPH_BUILD | 2,999 | 2,940 |
| TS_PARSING | 42,415 | 43,923 |

현재 가장 긴 단계는 TS_PARSING이다. 이 시간만으로 analyzer CPU·통신·DB 저장 중 어느 부분이 원인인지 단정하지 않는다. 단계별 계측으로 남은 비용을 분리하며, 격리 SQL 계획·정규식 진단의 개선을 패키지 목표 달성으로 대체하지 않는다.

원본은 workload-performance/run-pTTsgG/result.json과 workload-performance/run-I2fgeN/result.json이다. stage5-KOwFxr/performance-facts.json, sleep-correlation-timing.json, ledger-plan.json, ledger.json에 원본 해시·관측 범위·NOT RUN을 연결했다. 사전 점검부터 종료까지 09:03:46–11:13:36 KST의 pmset 원본과 대조한 실제 Sleep/Wake/DarkWake 전환은 0건이었다. 전원 assertion이나 Wake Requests는 전환으로 세지 않았다. 이 대조가 실행 중 부하의 연속 보증이나 최종 수용을 뜻하지는 않는다.

첫 실행 wrapper의 heredoc 구문 오류는 측정 시작 전에 발생했다. timing-preflight-attempt1.log에 보존했으며 실제 측정을 중복 실행하거나 실패 기록을 덮어쓰지 않았다. 이전 XPhUTE의 부하 무효 기록도 그대로 유지한다.

## 6. 미실행 수용과 사용자 입력

시작20회, small/medium/large G-PERF20회, packaged clean-full canonical 동등성, 비용 probe·PK-08·SBOM 재생성은 이번 후보 **NOT RUN**이다. overview/outcome 개수 일치는 canonical 동등성을 대신하지 못한다. frontend digest가 이전 후보와 같아 UX190 자동 pilot은 이번에 NOT RUN이며 이전 실행은 역사적 기록으로만 유지한다.

`coordination-2026-10-07/USER-INPUT-READINESS.md`의 일곱 입력 묶음은 준비 상태만 유지한다. 실제 GitHub 계정·선택 repo/SSO와 데이터 적용 승인, Developer ID/Team ID/notary profile, 두 번째 clean Mac과 업데이트 출시 키·host/TLS, 독립 보안 reviewer와 signed helper, annotator 2명·adjudicator·허가 corpus, UX 참가자8명·moderator·VoiceOver, Redis/JRE/FFmpeg/EPL 법률 판단은 여전히 사용자/사람 입력이 필요하다.

실제 Keychain은 **NOT RUN, 사람이 실행**한다. 조용한 AC·덮개 열린 기기에서 검증 후보만 지정한다. 다음은 명령 안내이며 실행하지 않았다.

```sh
cd ~/Dev/ciw/int
~/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/coordination/with-native-lock.sh keychain \
  caffeinate -i env -i HOME="$HOME" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node desktop/scripts/packaged-keychain-acceptance.cjs \
  --app "$PWD/.native-product-KOwFxr/Code Intelligence Validation.app"
```
