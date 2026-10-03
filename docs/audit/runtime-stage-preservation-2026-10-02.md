# 개발 런타임 stage 보존 수정

T09의 한 결함을 좁게 수정했다. `desktop/scripts/stage-runtime.mjs`는 새 runtime을 승격하기 전에 기존 runtime을 삭제했다. 마지막 rename이 실패하면 사용 가능한 이전 개발 runtime도 사라졌다.

`desktop/scripts/runtime-stage.cjs`는 빌드 시작부터 exclusive lock을 확보하고 고유한 incoming 디렉터리를 만든다. publication은 staged 파일/디렉터리 fsync → marker 파일 및 parent fsync → old runtime을 고유 previous 경로로 rename → incoming 승격 → parent fsync → marker 제거 및 parent fsync 순서다. 성공해도 previous는 자동 삭제하지 않는다.

새 runtime 승격 전 실패는 가능한 경우 old runtime을 원래 이름으로 되돌린다. rollback 실패, 승격 뒤 실패, 중간 종료는 남아 있는 old/new/incoming과 marker/lock을 보존한다. marker가 unlink됐으나 parent fsync가 실패한 경우에도 sticky recovery 상태와 lock을 유지한다. 다음 실행은 복구 자료를 덮어쓰지 않고 중단한다. lock 해제 뒤 fsync 오류는 이미 durable한 publication을 되돌리지 않는다.

stage 경로의 정적 symlink·비디렉터리, incoming symlink/hardlink/special file, 다른 invocation의 lock/임시 디렉터리 소유권을 검사한다. 이 개발 도구는 악의적으로 동시 경로를 교체하는 같은 OS 계정에 대한 sandbox가 아니다.

## 검증

`node --test desktop/test/*.test.cjs`: **45/45 PASS**, 실패·skip0. 이 중 stage 시험은 **22개**다. 초기15개 시험 후 독립 리뷰의 Medium 검증 공백을 반영해6개 fsync 경계 시험과 다른 invocation의 marker 보존 시험을 추가했다.

실제 임시 파일시스템에서 정상/첫 publish, 빌드 실패, 동시 producer 잠금, 기존 symlink/파일, marker 생성 실패, staged 파일/디렉터리 fsync, marker 파일/parent fsync, old/new rename 뒤 parent fsync, marker unlink 뒤 parent fsync, rollback 실패, 교체된 lock, 별도 프로세스의 rename 사이 종료를 검증했다. 원본 runtime sentinel과 복구본 바이트를 확인했다.

독립 코드 리뷰 `s1_gate_review`: scoped Critical0/High0. 첫 리뷰에서 빠진 fsync 경계 시험을 지적했고 추가했다. 최종 전체45개 회귀 결과는 `/tmp/ci-execution-desktop.xml`에 기록했다. 두 stage script의 `node --check`도 통과했다. CI에 stage script 구문검사와 T00 계약 job을 추가했지만 원격 CI는 실행하지 않았다.

## 복구·한계

중단된 stage는 `.runtime-stage.lock`와, publication을 시작했다면 `.runtime-stage-recovery.json` 및 고유 recovery 경로를 남긴다. **재빌드 성공을 위해 marker/lock 또는 previous를 일괄 삭제하지 않는다.** builder/stager가 모두 종료했는지 확인하고 marker의 same-directory 경로와 각 runtime manifest/파일 hash를 검증한 뒤, 유효한 후보를 새 recovery 사본으로 보존한 상태에서 복구해야 한다. 자동 복구 CLI와 오래된 previous의 quota/GC는 T09 후속 범위다. 이 변경이 사용자 설치 데이터나 backup format을 수정하지는 않는다.

잠금은 stage producer만 직렬화한다. 현재 `pack:mac`/`dist:mac`은 staging 종료 뒤 electron-builder를 실행하므로 packaging consumer까지 잠금을 유지하지 않는다. 병렬 packaging coherence·manifest 서명·runtime relocation/SBOM·native 설치·업데이트·실제 power loss는 미검증이며 별도 게이트다. 실제 `npm run stage`, electron-builder, 설치된 `.app` 교체는 수행하지 않았다. 결과는 T09 전체 완료나 G-NATIVE/G-UPDATE PASS가 아니다.
