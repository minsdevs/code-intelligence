# w19 — 실제 IMPORT 경로의 중복 파일시스템 작업

- 공개 기준 `6ddeefb`(PR110), 유닛 기준 `f66057a164fdcf99e42d8e920957cf166d8a0627`.
- 측정 후보 `p6yGme`, product source `f0b983f`, baseline `tZgvV7`. 이 유닛은 후보 앱을 재빌드하거나 실행하지 않았다.
- 브랜치 `release/w19-import-perf-20261008`; 증거 `validation/local/w19-import-perf/`.
- 기존 `w18-import-2026-10-08.md`의 RETAIN128·DB500은 유지한다. large의 실제 fixture 크기는 50k/200MiB이다.

## 진단과 변경 범위

실제 Spring backend + PostgreSQL/Redis + Java Unix socket client + Node vault/broker에서 `ImportStep → FileInventoryStep → FinalizeStep`을 실행했다. 소스는 기존 `workload-fixture.cjs`, `g-perf-1`, medium 10k/50MiB이다. 두 번째 실행은 **변경 없는 refresh**이며, packaged 1% 변경 benchmark와 같다고 주장하지 않는다. 파서 단계는 실행하지 않았으므로 전체 refresh SLO 측정도 아니다.

- warm capture에서 STAGE 0, RETAIN 10,000개: 기존 암호문 재사용은 실제 작동했다. 새 암호화/fsync 제거가 누락된 것이 아니다.
- 기존 vault의 warm RETAIN은 `lstat` 373,002회, open 10,000회, fstat 20,000회, read 10,000회였다. RETAIN sync/rename은 0회다. 전체 path chain을 매번 확인하면서 같은 마지막 디렉터리를 곧바로 한 번 더 stat하고 있었다.
- `source-vault.cjs`: chain 검사에서 얻은 마지막 stat을 private-directory의 소유자/권한/identity 검사에 그대로 전달한다. ancestor 검사를 캐시하거나 생략하지 않는다. blob 인증·경로/링크 검사·key 확인·기존 queued stage flush와 BARRIER 계약은 변경하지 않는다.
- `LocalImportService`: 이미 새로 생성한 독립 Git object DB에 개별 loose object를 쓰는 대신 한 pack을 쓴다. 해당 DB에는 과거 pack이 없으므로 기존 pack 검색을 하지 않고, 기존 loose writer와 같은 기본 compression을 사용한다. 승인 manifest 전체 byte hash, Git OID, staging 전후 검사와 publication guard는 그대로다. pack flush와 close가 끝난 후 기존 target 교체 경로를 실행한다.
- `LocalSnapshotStore`, `SourceStoreClient`, broker 프로토콜, inventory·parser·graph/DB 및 source 승인 정책에는 영구 변경이 없다. 새 migration도 없다.

## 측정 조건과 증거 해석

첫 준비 실패는 fixture root를 만들지 않아 발생한 ENOENT이며 `profile-before/gradle.log`에 보존했다. 이를 의미 회귀 RED로 세지 않는다.

`profile-before2`는 동시 작업과 load1 8.13→20.51 조건의 진단이다. `quietbefore`는 native lock + QUIET-REQUIRED + caffeinate로 직렬 보호하고 test 시작을 load1<4까지 기다렸지만, test 구간 표본은 3.72–5.37이었다. **두 실행 모두 부하 조건 미충족으로 성능 시간 비교가 무효**다. raw wall 수치는 XML에만 보존하고 개선율/SLO 근거로 사용하지 않는다. syscall 개수와 STAGE/RETAIN 동작 사실만 사용한다.

기준의 `quietbefore/vault-profile.json`, `quietbefore/junit/test/TEST-dev.codeintelligence.project.RetainedSourceIntegrationTest.xml`, `quietbefore/load.jsonl`이 실제 경로 분해 증거다. timing과 fs 계측은 임시 진단용이며 제품 telemetry로 남기지 않는다.

변경 후 `quietafter`도 test 구간 load1 3.83–5.03으로 시간 비교 자격을 충족하지 못했다. 따라서 wall 개선율은 제시하지 않는다. 실제 warm RETAIN의 lstat은 **322,528회**로, 동일한 10,000개 암호문을 다시 읽고 인증하면서 중복 stat **50,474회**를 제거했다. open 10,000/fstat 20,000/read 10,000, STAGE 0, RETAIN sync/rename 0은 그대로다. 해당 JSON·XML·load 증거는 `quietafter/`에 있다. 두 protected profile은 각각 1/1 시험 성공이며 SLO PASS가 아니다.

## 진단 실행 명령

두 보호 실행의 명령은 `bash validation/local/w19-import-perf/profile.sh quietbefore`, `bash validation/local/w19-import-perf/profile.sh quietafter`였다. 일회 스크립트는 wait-quiet → with-native-lock → caffeinate → QUIET-REQUIRED 설정/해제와 load 표본 수집을 수행했다. 내부 Gradle 명령은 다음과 같다(`E=validation/local/w19-import-perf/<label>`, 저장소 바로 아래 private `.citd-w19<label>`). 스크립트·추가 init·임시 시험 및 제품 계측은 종료 후 제거했다.

```sh
CI_DOCKER_TEST_ROOT="$PWD/$E" CI_DOCKER_TEST_TMP="$PWD/.citd-w19<label>" \
  backend/gradlew -p backend --offline --no-daemon --console=plain --max-workers=2 \
  -I "$PWD/validation/pre-release/docker-integration.init.gradle" \
  -I "$PWD/validation/local/w19-import-perf/quiet-profile.init.gradle" cleanTest test \
  --tests dev.codeintelligence.project.RetainedSourceIntegrationTest.profileImportWorkload
```

## 의미·안전 회귀

- Desktop 대상 157/157 성공, 실패/skip 0: `desktop-green.log`. 새 RETAIN128 말미 손상 거부·queued stage 내구성·교체된 project ancestor symlink 거부와 기존 cross-project/blob integrity/atomic durability/backup/Windows fixture 경계를 포함한다.
- Backend 대상 **297/297 성공**, 실패/skip 0: `backend-final/test-totals.json`, `backend-final/junit/test/*.xml`. LocalImport 19, LocalIngestPolicy 69, barrier 3, 실제 Node vault/Unix broker를 쓰는 RetainedSource 40, secrets corpus 73, SourceStoreClient 92, 실제 scoped HTTP 승인/import smoke 1개다. 신규 empty/duplicate/Unicode byte·Git OID roundtrip과 capture 취소 후 이전 snapshot 보존·불완전 staging 회수·재시도도 성공했다.
- 변경 Java 두 파일의 targeted `spotlessJavaApply` 성공: `format.log`. 전체 formatter는 실행하지 않았고 일회 target init은 제거했다.

```sh
"$COORD/wait-quiet.sh"
node --test desktop/test/source-vault.test.cjs desktop/test/source-vault-batch.test.cjs \
  desktop/test/source-broker.test.cjs desktop/test/source-vault-windows.test.cjs \
  desktop/test/source-vault-backup.test.cjs
```

```sh
E="$PWD/validation/local/w19-import-perf/backend-final"
"$COORD/wait-quiet.sh"
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" \
  CI_DOCKER_TEST_ROOT="$E" CI_DOCKER_TEST_TMP="$PWD/.citd-w19final" \
  backend/gradlew -p backend --offline --no-daemon --console=plain --max-workers=2 \
  -I "$PWD/validation/pre-release/docker-integration.init.gradle" cleanTest test \
  --tests dev.codeintelligence.project.LocalImportServiceTest \
  --tests dev.codeintelligence.project.LocalIngestPolicyTest \
  --tests dev.codeintelligence.project.LocalSnapshotStoreBarrierTest \
  --tests dev.codeintelligence.project.RetainedSourceIntegrationTest \
  --tests dev.codeintelligence.project.ImportSecretsCorpusIntegrationTest \
  --tests dev.codeintelligence.source.SourceStoreClientTest \
  --tests dev.codeintelligence.project.LocalPreviewApiIntegrationTest.aScopedApprovalImportsExactlyTheApprovedScope
```

재실행에는 기존 증거를 덮어쓰지 않는 새 private root/tmp가 필요하다. Gradle loopback handshake 경고는 원본 로그에 남겼으며 시험 실패로 바꾸어 세거나 숨기지 않았다. commit `59c3608`·`721de28`은 의미 회귀, `2d3676a`는 제품 최적화와 초기 감사를 담는다. 최종 감사 갱신은 별도 문서 commit이다. 공용 README/07 및 p6 후보 감사는 수정하지 않았다.

## 판정 경계

WORKLOAD row PASS나 이 유닛의 타깃 시험 통과는 SLO 통과가 아니다. `resultEqualsFull=null/NOT_RUN`을 유지한다. 이 변경은 성능 최적화이며 기존 의미적 버그의 RED→GREEN을 조작하지 않는다. 새 회귀는 소비자 byte/OID·취소/회수·retention 안전 경계를 검사한다.

전체 suite, 새 packaged 후보, large 성능 비교, medium 전체 refresh 30초 목표, 최종20회, 실제 Windows native boundary, 실제 Keychain/사용자 프로필, 실계정, signing/notary, paid AI, Actions/push는 이 유닛에서 NOT_RUN이다.
