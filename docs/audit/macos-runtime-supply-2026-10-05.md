# macOS 런타임 소스 고정·사전 검사 — 2026-10-05

**정식 배포 준비는 미완료다. 새 native 앱 빌드와 후속 격리 자동화는 아래 재개 기록에서 통과했다.** 초기 작업은 앞 단계의
GitHub 복구 UI를 실제 Validation 앱에 넣기 위한 소스 공급 경로와 사전 검사를
준비한 것이다. 기존 합성 DB/브라우저 PASS를 실계정 또는 Electron PASS로 바꾸지 않는다.

**최신 상태:** 런타임 준비 `695424c`와 인계 정정 `f195f65`는 PR #86/merge `a0b572a`로 원격 main에 반영됐다. 사용자가 저장공간 확보를 통보하여 원본 `/Users/minseokchae/Dev/code-intelligence`의 `codex/native-validation-20261005` 브랜치에서 실제 native 검증을 재개했다. 39,047,188,480 bytes 여유 공간을 측정했고 8GiB 사전 검사를 통과했다. 기존 검증 기록은 원본 `validation/local/`에 보존하며 삭제한 clone을 재생성하지 않는다. 아래 디스크 수치와 clone 경로는 초기 검증 당시 기록이다.

## 기준과 실제 차단 원인

작업본은 `/code-intelligence/.cos-pre-release-recovery-20261005`, 브랜치는
`codex/github-project-recovery-20261005`다. GitHub PR84가 MERGED이고 원격 main은
`a352290`인 것을 재확인했다. 기존 복구 변경은 미커밋 그대로 보존했다.
Orca main-2, 원본 앱·DB·프로필·Keychain·private key를 사용하거나 변경하지 않았다.

2026-10-05 17:45:24 KST 사전 검사에서 여유 공간은 **1,261,203,456 bytes
(약 1.17GiB)**였다. 새 초기 사전 검사 기준은 8GiB이며 결과는
`BLOCKED / MAC_BUILD_DISK_SPACE`, exit 1이다. 이 기준은 작업 여유를 위한
보수적 정책이며 실제 최종 앱 크기 또는 빌드 완료 보장이 아니다.
기존 자료를 삭제하지 않고 실제 런타임 소스 컴파일·패키징을 시작하지 않았다.

## 구현한 변경

기존 `native-acceptance-macos.sh`에 이미 macOS13 대상 소스 빌드가 있었다.
해당 경로의 Homebrew stable 조회/캐시 다운로드를 검증한 소스로 고정했다.
새 `desktop/scripts/macos-runtime-supply.json`에 OpenSSL3.5.8, PostgreSQL16.15,
Redis8.10.2, pgvector0.8.7의 URL·SHA256·확인 출처를 기록했다.
pgvector는 HTTPS에서 확인한 고정 commit archive digest이며 서명된 공급자
checksum이라고 표시하지 않는다. 나머지 세 값은 공식 체크섬 공표와 대조했다.

`macos-runtime-supply.cjs`는 디스크·고정 입력·다운로드 제한·체크섬·수령 기록을
검사한다. archive는 exclusive create여서 성공/실패 파일을 재실행으로 덮지 않는다.
잘못된 바이트는 추출 전에 거부한다. curl8.4 미만은 길이 미공개 응답의 전송 중
크기 제한을 보장하지 않으므로 archive 생성 전에 거부한다. 현재 호스트의
`/usr/bin/curl`은 **8.7.1**로 확인했으며 이 확인은 네트워크를 사용하지 않았다.

host 진입점은 새 run/JDK 다운로드 전, 소스 provisioning은 claim 전 여유 공간을
확인한다. 기존 PG SSL·Redis TLS·pgvector portable 옵션·의존 라이브러리 재배치와
고정 macOS13 gate를 유지한다. 라이선스/소스 lock을 PG share에 동봉하도록 연결했다.
macOS acceptance에 상속된 `PGVECTOR_ROOT`가 새 버전을 덮지 않도록 자식 환경에서
제거했다. 기존 hosted context의 0755 임시 부모 아래 0700 작업 폴더도 처리하되
로컬 context의 private ancestor 제약은 유지했다. 실제 GitHub Actions는 실행하지 않았다.

## 검증 증거

원시 기록은 `validation/local/macos-supply-20261005-UFh946/`에 보존한다.

| 실행 | 결과 | 범위 |
|---|---|---|
| `targeted-first.tap` | 38개 중 37 PASS/1 FAIL | 실제 host 함수를 VM 밖의 배열로 호출한 테스트 구성 오류. 용량 차단 전에 인수 비교 실패 |
| `targeted-resume.tap` | 39개 PASS | 같은 VM 안에서 인수 생성으로 테스트 수정, checksum 성공 receipt 검증 추가 |
| `native-acceptance-regression.tap` | 20개 PASS | 기존 acceptance helper 회귀. 작은 합성 C/dylib 재배치 fixture 포함 |
| `reviewed-final.tap` | **64개 PASS**, FAIL/SKIP 0 | hosted 작업 폴더, curl 최소 버전, inherited extension overlay 차단까지 반영한 3개 파일 집중 시험 |
| `actual-preflight.json` | **BLOCKED**, exit 1 | 실제 디스크 측정. 다운로드/컴파일/앱 실행은 하지 않음 |

JS 문법 검사, Bash 문법 검사와 `git diff --check`도 통과했다. 읽기 전용 검토에서
발견한 hosted 부모 권한, 구 curl 한도, 상속 PGVECTOR_ROOT 문제를 수정했다.
이 숫자를 기존 frontend370/backend17 또는 실제 앱 검증 숫자와 합산하지 않는다.
실제 새 버전의 전체 다운로드·컴파일·TLS/extension ABI·최소 OS 실행은 미검증이다.

## 기존 DB·백업 적용 전에 필요한 단계

[pgvector0.8.7 공지](https://www.postgresql.org/about/news/pgvector-087-released-3392/)는
IVFFlat index build buffer overflow 수정을 알린다. 이번 source lock은 새 검증
런타임에 수정 릴리스를 사용한다. 원본 DB의 버전을 열람하거나 자동 UPDATE하지 않았다.

`desktop/src/backup-postgres.cjs:181-182,222,497-527,616-619`에서 extension
`extversion`과 PG major가 exact catalog hash에 포함되고 현재 런타임으로 staging
catalog를 만든다. **V26→V27 지원은 pgvector 버전 전환 지원이 아니다.** 새 버전과
기존 백업의 버전이 다르면 복원이 `BACKUP_PG_SCHEMA`로 거부될 수 있다.
`desktop/src/main.cjs`의 CREATE EXTENSION IF NOT EXISTS는 기존 버전을 갱신하지 않는다.
locale/provider도 기존 백업 fingerprint에 포함되지 않아 별도 호환 근거가 필요하다.

다음 실행은 공간 확보 → 고정 source build → unchanged native gate → 새 Validation
앱/격리 프로필 → extension/이전 백업/locale 호환 fixture → 기존 실계정 project1의
UI 새 분석 순서다. catalog/소유권/hash를 완화하거나 원본 DB·프로필을 복제하여
건너뛰지 않는다. 실제 계정 연결·해제·재연결·철회, refresh/rotation, 완료·취소 경합,
최소 OS·새 설치/업데이트 및 정식 서명·공증은 각각 별도 미완료 범위다.

실행 절차와 제약은 [source supply 설명](../../desktop/scripts/macos-runtime-supply.md)에 있다.
초기 작업에서는 잔여 한도2% 조건 때문에 원격 발행하지 않았으나, 이후 사용자가 해당 조건을 폐기하고 원본 브랜치에서 기능별 commit/push/PR/merge를 지시했다. 당시 기능 단위는 소스 공급 준비였으며, 실제 빌드 결과는 다음 재개 기록을 따른다.

## 저장공간 확보 후 실제 native 검증

원본 `codex/native-validation-20261005`에서 실행했다. `/usr/libexec/java_home -v 21`의 결과가 이 호스트에서 Java26을 가리켜, 이미 존재하는 Temurin21.0.12 경로를 `java -version`으로 확인해 명시적으로 사용했다. 네 가지 source archive 검증과 컴파일이 통과했고 PostgreSQL 측 71개/Redis 측 3개 네이티브 파일의 arm64·최소 대상13.0·의존성 재배치 검사가 통과했다. 실제 stage, JRE21, backend/analyzer/frontend, ad-hoc Validation 앱 패키징도 통과했다. 이는 macOS13 기기에서 실행했다는 뜻은 아니다. 실제 호스트는 macOS26.6.2였다.

실행 전 독립 safeStorage probe가 실계정과 같은 `Code Intelligence Validation` 이름을 쓰는 문제를 수정했다. 제품 자동화와 동일한 `Code Intelligence Acceptance` 이름을 사용하며 write/read 프로세스 모두 ready 전에 식별자와 private 경로를 설정하는 회귀를 추가했다. 관련 집중65개 시험이 PASS였다. host 진입점에는 현재 run/artifact 위치를 알 수 있는 시작 기록만 추가했다.

| 실행 | 결과 | 근거 |
|---|---|---|
| 최초 source provision | PASS | `validation/local/native-validation-20261005/first-attempt/provisioning.json` |
| 최초 packaged 자동화 | FAIL | 같은 폴더 `acceptance.json`; 분석·재시작·백업·snapshot2 생성 후 `synthetic-reanalysis` 소스 화면 검증에서 중단 |
| 같은 앱·같은 프로필 읽기전용 재개 | PASS | `read-only-snapshots.json`; current2 READY/job DONE, old1/41과 new2/42의 UI 본문·snapshot URI 확인, mutating API0, 정상종료 |
| 같은 앱·새 격리 프로필 전체 재검증 | PASS | `second-attempt/acceptance.json`; 203,433ms, 31개 체크 기록(반복 시작 검사 포함), 정상종료 |

최초 실패 당시의 정확한 DOM/요청은 저장되지 않았다. 따라서 제품 데이터 손상이나 Monaco 결함으로 확정하지 않는다. 정적 검토에서 bare `/code` 이동과 파일 재클릭이 UI 캐시 갱신 전에 이전 snapshot을 URL에 다시 고정할 수 있음을 확인했다. 검증 helper가 전달받은 snapshot을 `Source snapshot` 콤보로 명시 선택한 뒤 기존 본문·배지·URI 검사를 그대로 수행하도록 수정했다. 실패 하위 단계를 `sourceVerification`에 남긴다. 프런트엔드나 저장소 데이터를 수정한 것이 아니며 current 모드의 자동 갱신 검증을 대신하지 않는다.

두 번째 실행은 **앱과 C 소스를 재빌드하지 않았다.** 기존 검증용 소스/의존성 사본은 같은 임시 빌드 트리 안에서 이동해 재사용하고 새로운 automation claim과 합성 입력을 만들었다. 첫 실패를 덮거나 같은 시도를 처음부터 PASS로 바꾸지 않았다. 명시 snapshot 소스 탐색, 백업 생성·복원·복원 전 checkpoint 복원, 이전 API 권한 폐기, 복원 뒤 재시작, 합성 프로젝트 삭제의 재시작 지속성, 대표 입력 탐색 및 정상 종료가 통과했다. 백업 파일 picker는 단발 시험 제어이며 수동 파일선택기 조작 검증이 아니다.

대표 입력은 필터링한 현재 프로젝트 코드다. 복사943개 중 실제 승인867개/7,571,029 bytes, 개요까지57,414ms, 파일검색10ms, 관계표시1,115ms를 관측했다. 결과는 SUCCESS161/PARTIAL618/UNMEASURED87/UNSUPPORTED1이며 정확도·성공률로 환산하지 않는다. 108개 진입점 및 102개 흐름 중 실제 5단계 흐름의 보관 소스 이동을 확인했다. 단일 호스트·단일 입력의 측정이다. 980×700/1280×800/1440×900 native 화면을 보존했고 대표1280×800 화면을 직접 확인했다.

**검증 경계:** 직접 Electron probe의 실제 macOS Keychain write/read PASS와 Playwright 제품 자동화 PASS는 별개다. 설치된 Playwright loader는 `--use-mock-keychain`을 사용하므로 자동화 safeStorage 재시작을 최종 packaged 앱의 실제 login Keychain 수명주기 증거로 합치지 않는다. 현재 런타임의 V27 백업/복원 PASS는 이전 pgvector 버전의 V26/V27 백업 호환, 기존 ICU/locale, 실계정 project1, 실권한 철회/갱신, 실제 macOS13, 신규기기 설치·업데이트 또는 Developer ID/공증을 입증하지 않는다. 기존 실계정 앱·DB·Validation 프로필·키 파일은 사용하지 않았다.

앱은 `.native-product-yGBKOK/Code Intelligence Validation.app`(측정 약510MiB)에 보존한다. 서명 후 실제 runtime manifest 파일 SHA256은 `f58610e3f16ae87fed95473a1b8f32f5d1289772e13388e0f7a414b7f9d5a726`이다. 최초 report의 `runtimeManifestSha256`은 서명 전 stage 표현 해시이며 이것과 구분한다. 실행 시작 HEAD는 `a0b572a`, 실제 빌드 입력943개 fingerprint는 `37d8dfcffa72c1c247a5f69c8b1fd39e0462d5d6e3a968c68d3a4ac2b43589f8`이며 미커밋 검증 도구 수정도 포함한 작업트리였으므로 HEAD만으로 빌드 바이트가 동일하다고 주장하지 않는다.

두 번째 자동화 claim은 `/private/tmp/civa-j0lCXC/desktop-run-n2pYEv/.isolated-run.json`이다. 이 프로필은 Playwright mock-keychain 조건으로 만들어졌으므로 일반 `open` 명령에 그대로 재사용하지 않는다. 단순 Finder 더블클릭은 격리가 적용되지 않아 기존 Validation 프로필을 열 수 있다. 다음 수동/실계정 작업은 별도의 새 격리 프로필에서 실제 packaged Keychain 경계를 확인한 뒤 진행한다. 이번 종료 시 앱은 실행 상태로 남기지 않았다. 기존 사용자 프로필 적용 전에는 pgvector 버전·구백업·locale도 각각 검증해야 한다.

검증 종료 후 이번 run의 Gradle daemon 작업 디렉터리를 확인하고 소유 PID64729를 종료했다. 사용이 끝난 임시 앱 소스/의존성 사본, Gradle/npm 캐시, 네 가지 C 소스 빌드 트리와 압축파일 등12개 경로를 정리했다. 원본 저장소의 기존 의존성은 건드리지 않았다. 최종 앱 manifest와 보고서/화면32개 해시는 정리 전후 일치했다. `cleanup.json`을 포함한33개 증거의 해시는 `macos-runtime-supply-validation-2026-10-05.json`에 기록했다. 관측된 공간 증가는2,978,340,864 bytes(약2.77GiB), 정리 후 여유 공간은37,828,354,048 bytes였다. 다음 호환성 시험에 필요한 실제 소스빌드 prefix(약64MiB), 두 자동화 프로필과 작은 합성 입력·백업은 보존했다. 삭제한 임시 `source` 경로는 과거 실행의 출처이며 현재 재실행 대상으로 쓰지 않는다.

## 실제 packaged Keychain 후속 검증

PR #87 merge `2b5a98d`와 원격 일치를 확인한 뒤 원본의
`codex/packaged-keychain-compatibility-20261005`에서 진행했다. 보존 앱의
runtime manifest 해시와 `codesign --verify --strict --deep`를 확인했다.
`desktop/scripts/packaged-keychain-acceptance.cjs`는 해당 실행 파일을 직접
시작하고 소유 PID의 loopback CDP에 연결한다. Playwright Electron launcher,
main-process loader와 `--use-mock-keychain`을 사용하지 않는다. 새로운
Acceptance 목적 claim을 만들며 실계정 Validation 프로필을 재사용하지 않는다.
실제 Keychain은 같은 OS 계정의 Acceptance 앱 식별자에 속하며 실행마다 새
OS Keychain을 만든다는 의미는 아니다.

첫 `validation/local/packaged-keychain/run-6b20Le/result.json`은 앱 READY 뒤
`attach-existing-renderer`에서 FAIL이었다. 당시 구체 오류 본문은 기록되지
않았으므로 원인을 확정하지 않는다. 검증 도구의 lsof 주소 확인에 `-nP`를
추가하고 연결 하위 단계/제한된 공개 오류 정보를 기록하도록 보완했다. 최초
PID93075 및 해당 격리 경로의 잔존 프로세스가 없는 것을 후속 확인했다.

`run-fcb5jj/result.json`은 같은 앱을 재빌드하지 않은 새 격리 프로필에서
PASS였다. 직접 실행 두 번의 READY는 11,427ms/11,365ms였으며, UI 폴더 승인과
합성 `keychain.ts` 분석 뒤 동일 프로필 재시작에서 프로젝트1/snapshot1과
`return 73` 소스/Monaco snapshot URI가 유지됐다. 새 fixture의 `secrets.enc`
암호문 해시는 바뀌지 않았고 local 인증 및 실제 내장 서비스가 정상 응답했다.
키나 자격증명 평문을 직접 열거나 내보내지 않았다. 보존 화면도 직접 확인했다.
두 앱 PID95093/95326의 종료 코드0과 신호 없음, 해당 프로필 경로의 열린
파일 프로세스 부재를 확인했다. 보고서의 `cleanExit`는 이 프로세스 종료
관측을 뜻하며 미관측된 모든 safety 종료 오류까지 검증했다는 의미가 아니다.

이 검증은 **새 프로필에서 보존 packaged 앱의 실제 Keychain 암호화 저장과
프로세스 재시작 후 복호화·데이터 지속성**을 입증한다. 실계정 GitHub 토큰,
키체인 잠금/권한 거절/키 회전, 정식 Developer ID 설치, 다른 OS,
기존 Validation 프로필 및 이전 확장 버전 백업은 별도 범위다. 위의 기존
Playwright mock-keychain 결과와 하나의 동일 시험으로 합치지 않는다.

후속 검토에서 CDP/window-close의 무기한 대기와 종료 기록 누락 경로를 보완했다.
기존 `createDeadline`/`closeOwnedApplication`을 재사용하고, 정상 창 닫기 요청·
PID별 종료 관측·강제 신호·확인되지 않은 종료를 구분한다. 가짜 프로세스와
CDP를 사용하는12개 회귀가 통과했다. 최종 `run-RGWnsP/result.json`도 실제
새 격리 프로필에서 PASS였다. 직접 실행2회 READY11,610ms/11,166ms,
각 종료코드0/신호0/강제종료요청0/종료확인true이며, 자격증명 암호문과
runtime manifest·app.asar·실행파일 해시가 모두 유지됐다. 이 최종 보고서의
`processExitedZero`는 관측한 프로세스 종료만 뜻한다. 최초 실패나 이전 성공
보고서를 덮어쓰지 않았으며 앱은 모든 시도에서 재빌드하지 않았다.

## pgvector SQL 버전과 V26/V27 백업 호환성

`validation/backup-compatibility/run.cjs`는 보존한 소스빌드 PostgreSQL prefix를
새 fixture에 복사해 실행한다. 원본 prefix·앱·사용자 DB는 변경하지 않는다.
공식 pgvector0.8.1의 고정 commit
`778dacf20c07caf904557a88705142631818d8cb`에서 가져온 SQL/control 해시를
검증하고, 복사본의 새0.8.7 binary에 구0.8.1 SQL 정의를 적용했다. 이는
**바이너리 교체 뒤 SQL 확장을 아직 UPDATE하지 않은 상태**의 모델이며,
구 바이너리 자체나 과거 물리 DB·인덱스의 업그레이드 검증은 아니다.

첫 실제 matrix `validation/local/backup-compatibility-GAaskZ/report.json`은
8개 확인 항목이 모두 PASS였다. PostgreSQL16.15, 새 소유 DB,
SCRAM 인증·TLS `verify-full`, UTF8/libc/C 기준에서 실행했다.

| 시나리오 | 실제 결과 | 범위 |
|---|---|---|
| 동일 pgvector0.8.7의 V27→V27 | 복원 PASS | 메모와 1536차원 vector 데이터 보존, 원본 행·payload 불변 |
| 구0.8.1 SQL 상태의 V27→새0.8.7 staging | `BACKUP_PG_SCHEMA`로 거부 | load iterator 미시작, 회계 writer0회, source/target 행·원본 payload 불변 |
| fixture에서 명시적 UPDATE 후 새 V27 export | 복원 PASS | 기존 사용자 행 불변; UPDATE 전 export는 계속 거부 |
| 고정 역사적 V26 producer→V27, 양쪽0.8.7 | 복원 PASS | `LEGACY_UNMEASURED`, 새 측정0행, 메모·vector 보존, payload 불변 |
| libc C→en_US.UTF-8, 양쪽0.8.7 | 작은 fixture 복원 관측 | 모든 locale의 호환이나 locale 거부 검사가 있다는 증거가 아님 |

역사적 V26 producer는 로컬 Git의
`4d8946c7b18b1cdee4f6f86b1e30fc9d469d923f`를 사용했다. 현재 opt-in typed
backup 시험에 남아 있던 V26 이전 `root_device/root_inode` fixture를
`root_platform/root_identity/root_owner` 계약에 맞춰 수정했고 실제 native
시험1개도 통과했다. 제품 migration·schema·backup 검증 코드는 수정하지 않았다.
단위 실행의72개 PASS/2개 opt-in SKIP와 실제 matrix의 native PASS를 구분한다.

따라서 **기존 pgvector 버전의 백업을 새 버전으로 자동 변환하는 기능은 아직
없다.** 이 matrix의 거부는 typed DB adapter 경계다. 실제 앱의 복원은
`backup-runtime.cjs`에서 maintenance seal 뒤에 DB load를 수행하므로,
같은 거부가 앱에서는 복구 필요 상태를 남길 수 있다. “사용자 앱 상태가 전혀
변하지 않는 사전 거부”로 확대하지 않는다. 기존 백업·실계정 profile 적용 전에
버전 변환/명시적 사전 호환 검사와 암호화 archive·복구 수명주기를 별도로
구현·검증해야 한다. 원본 locale와 ICU 호환도 아직 미확인이다.

후속 fixture의 client TLS 경로를 합성 인증서/키로 명시하고 종료 타이머를
정리한 최종 코드에서도 `validation/local/backup-compatibility-PwRTQx/report.json`
8개 항목이 모두 PASS였다. 소유 PostgreSQL PID8387은 종료코드0/신호없음,
원본 prefix와 vector binary 해시 불변을 확인했다. 먼저 실행한 GAaskZ 보고서는
그대로 유지하며 최종 코드의 증거는 PwRTQx를 따른다.

완료 뒤 소유 프로세스 부재를 확인하고 이전 Keychain 시험2개의 프로필과
backup matrix2개의 PostgreSQL 복사본·시험 DB·임시 legacy 소스·합성 TLS
파일을 정리했다. 첫FAIL·후속PASS 보고서/화면, 원본 구·신 payload8개와
보고서2개의 해시는 유지됐다. 최종 실제 Keychain 프로필
`/private/tmp/cikr-sFCVEv/desktop-run-IfGJW2`와 보존 앱, 원래 소스빌드 prefix는
후속 검증을 위해 남겼다. cleanup 기록은 각각
`validation/local/packaged-keychain/cleanup-20261005.json` 및
`validation/local/backup-compatibility-cleanup-20261005.json`이다. 삭제된 경로가
과거 보고서에 남아 있어도 현재 재실행할 DB나 프로필로 취급하지 않는다.

## 복원 전 호환성 검사 — 원본 8d5f398 이후

작업 브랜치는 `codex/restore-compatibility-preflight-20261005`다. 사용자 요청의
배포 직전 전체 순서는 [07 §5](../multilanguage-plan-2026-10-02/07-delivery-release-gates.md)에
정리했다. 아래 완료는 G-RECOVERY 전체나 정식 배포 완료를 뜻하지 않는다.

### 구현

`backup-runtime`은 인증된 백업의 copy/decrypt/전체 payload 검사 뒤, 유지보수
시작 전에 `readRestoreIdentity()`로 소유자/catalog만 읽고 별도의 probe DB를
만든다. `initializeStaging()`의 고정 V1–V27 migrations로 실제 V26/V27 catalog를
계산한 뒤 `assertRestoreCompatibility()`로 비교한다. 임의 SQL이나 archive가
제공한 DB 이름은 실행하지 않는다. 실제 loadRows도 같은 비교를 다시 하고,
load 트랜잭션의 catalog/행/소유권/제약조건/readback·비용 비역행 검사를 유지한다.

`withCompatibilityStage(callback)`는 내부 UUID·CREATE 응답과 실제 OID·owner에
한정한 cleanup 권한을 사용한다. callback의 DB 연결 종료 후 probe 세션0과
live/probe 식별자를 확인하고 probe만 연결금지→DROP→OID/name 부재를 확인한다.
live·previous·failed는 삭제하지 않는다. CREATE 응답 유실/식별변경 때 추정
삭제하지 않으며 정리 실패는 단순 호환 거부보다 우선한다. 기존 retention
권한을 확장하지 않았다. main의 cluster mutex가 협력하는 관리 작업을 직렬화하며,
악의적인 superuser의 check→DROP 경쟁까지 차단하는 OS 경계는 아니다.

probe의 정상 종료/정리 후 live identity와 payload inode/hash를 재확인한다.
정확한 catalog/소유자 불일치만 `BACKUP_RUNTIME_INCOMPATIBLE`로 분류하고,
유지보수 시작 전 소유 scratch를 정리한다. main IPC는 `recoveryRequired=false`
인 이 경우만 `{restored:false,code:'BACKUP_INCOMPATIBLE'}`로 전달한다.
Settings는 한영 고정 안내와 정상 사용 가능한 상태를 표시하고 모든 복원 결과
뒤 runtime을 새로 조회한다. 임의 native 오류 상세는 화면에 노출하지 않는다.

ACTIVE_JOB·초기화·I/O·cleanup 오류를 호환성 불일치라고 단정하지 않는다.
사전검사 중 실패가 있어도 이 경로 자체가 비용원장/OFF/seal을 시작하지 않는다.
단 scratch 정체성 훼손/정리 실패는 기존 recovery-required 계약을 유지하며,
사전검사를 통과한 뒤 실제 load에 실패하면 기존 복구 절차가 여전히 필요하다.
전체 행/동시 AI 기록/향후 상태를 동결하거나 모든 복원 실패를 예방하는 기능은 아니다.

### 검증

| 층 | 실제 확인 |
|---|---|
| adapter/coordinator 단위 | 185 PASS/2 native opt-in SKIP. `validation/local/restore-preflight/unit-Hrcr0x/tests.tap`; 인증된 비호환 archive, 정리실패, live identity·payload 변조, 후속 정상 복원 포함 |
| DB controller 단위 | 89 PASS/2 opt-in SKIP. 신규64 probe cases와 기존25 회귀; 응답유실·OID/owner/세션변화·동시 호출·callback 예외 보존 |
| main IPC / Settings | main VM63 PASS, Settings DOM/mock38 PASS, TypeScript noEmit·변경 frontend ESLint 통과 |
| 실제 PostgreSQL/TLS | `backup-compatibility-nz44fc`와 최종 `backup-compatibility-VjdhHc/report.json` 각각10/10 PASS. 소유 PG 정상종료·포트닫힘·원본 prefix/vector hash 불변 |
| 새 packaged 앱 | 최종 `restore-preflight/native-Y6flRA/result.json` PASS, 아래 범위와 초기 실패 기록 참조 |

실제 PG fixture는 V27/V26 승인과 old0.8.1-SQL/new0.8.7-binary 거부 뒤
모든 probe DB 부재를 확인했다. 실제 `encryptFile`/payload/runtime coordinator도
구 SQL의 users-only archive를 거부했고 gateway.begin/pause/failure/journalWrites0,
pendingRecovery=null, archive/live OID·행·기록 불변을 확인했다. 이 standalone
fixture의 B journal/gateway는 mock이며 실제 원장의 모든 crash 상태 시험은 아니다.

새 앱은 `.native-product-wXqDvU/Code Intelligence Validation.app`다. 기존
`yGBKOK` 앱은 보존하고 검증된 native runtime/Java 코드를 재사용했다.
현재 frontend만 `.env`를 읽지 않는 Vite build로 다시 만들고 복사 JAR의
`BOOT-INF/classes/static/`에 반영했다. 나머지1080 ZIP entry의 bytes와 압축방식,
중첩 JAR의 stored 방식이 유지됨을 대조했다. 현 desktop/src로 새 패키지를
만들고 기존 custom ad-hoc signer/manifest 검사를 통과했다. Java/C 재컴파일,
정식서명·공증·배포는 하지 않았다. build 근거는 `build-41XPbn/build.json`이다.

native 첫 `native-j08bk9`는 영문 안내 선택자 문제를 포함한 검증 단계 FAIL,
두 번째 `native-RcDzlZ`는 거부·복원까지 확인한 뒤 도구의 종료기록 TypeError로
FAIL이었다. 둘을 보존했다. 선택자·종료 전 ChildProcess 보관·소유경로검증을
수정하고, 정상복원과 no-op을 구분하도록 UI 재분석을 추가했다. 제품을
재빌드하지 않은 최종 `native-Y6flRA`에서:

- 실제 UI로 분석91/snapshot1과 암호화 백업을 만든다. 새 합성 프로필의
  backup 목적 키를 main process 안에서만 사용해 catalog hash만 다른 인증된
  시험 archive를 생성한다. 키는 도구 결과/로그/외부 IPC로 반환하지 않는다.
- 비호환 파일을 실제 UI/IPC에 전달하면 안내가 보이고 ready=true,
  recoveryOnly=false이며 safety/backup-maintenance 파일목록·내용, 프로젝트 DTO,
  API token과 두 archive가 그대로다. 실제 안내 화면을 직접 확인했다.
- 계속 사용해 UI 재분석으로92/snapshot2를 만든 다음 정상 백업을 복원한다.
  currentSnapshot1과 소스91·배지·Monaco URI로 되돌아오고 재시작 뒤에도 유지된다.
  두 앱 프로세스는 exit0/signal없음으로 종료됐다.

native 시험은 새 Playwright **mock-Keychain** 프로필이고 파일 picker 결과만
단발 제어했다. 실제 DB/source/암호화/유지보수·기록은 제품 구현을 사용한다.
이는 기존 실제 Keychain PASS와 별개의 증거이며 사용자의 실제 계정/DB/키를
읽은 시험이 아니다. 새 앱 manifest SHA256은
`75a6e93f77cdd4fa03f7e99e25a2555e7aace89f643ee35f4dcd28aac7e8f87b`,
app.asar SHA256은 `2d6f591a4f8d3448004d7914820d8e653be49951431f81f4ab686ce15f09808e`다.

**잔여:** 구 archive의 자동 변환은 구현하지 않았다. 같은 extension의 V26/V27
복원과 비호환 사전 거부를 구별한다. 기존 프로필에 새 런타임을 적용하기 전
extension·physical index·locale/ICU 및 되돌리기 조건을 확인해야 한다.
실계정 project1, OAuth refresh/revoke, 실제 최소 OS·새 설치/업데이트,
정식 release gates는 별도 미완료다.

### 중단 작업 재개 후 최종 검토·반영

사용자 재개 지시 후 현재 제품4개 파일이 `build-41XPbn/build.json`의 해시와
일치하고 `native-Y6flRA`의 app.asar/manifest·driver가 당시 검증본과 일치함을
다시 확인했다. 최종 제품 집중시험은 `unit-Hrcr0x/final-review.tap`의341개 중
337 PASS/4 native opt-in SKIP, FAIL0이다. 최종 Settings는
`unit-Hrcr0x/final-settings.json`38/38 PASS이며 TypeScript noEmit과 변경 파일
ESLint도 통과했다. 기존 시험 기록을 이 최종 로그로 덮지 않았다.

독립 검토에서 native helper의 일부 evaluate/response.json 등 외부 Promise가
전체 deadline 밖에 있던 P2를 보완했다. 기존 perform/bounded를 재사용하고
종료의 독립 제한시간·소유 ChildProcess·실패 기록은 유지했다. 이 수정은
제품/번들 변경이 아니다. 수정본 SHA256
`de803bb3f8452b2ad75f2ee64504135105346216ae2c6420f76ed944e4797b9a`로 같은
앱을 재빌드하지 않고 새 empty fixture를 실행한
`validation/local/restore-preflight/native-jGteM6/result.json`이 PASS다.
백업 생성·비호환 거부·새 분석92에서 정상백업91로 복원·재시작 유지의4개 확인을
통과했고 PID59231/60273은 각각 exit0/signal없음이다. 새 claim은
`/private/tmp/cirp-voXvgj/desktop-run-8cbj7P/.isolated-run.json`이며 mock-Keychain
전용이다. 이전 Y6flRA PASS와 최초 두 FAIL도 별도 보존한다.

제품 검토에서 확정 차단급 결함은 발견되지 않았지만, CREATE 응답유실이나
probe cleanup 실패에는 정체성을 추정해서 삭제하지 않는다. 해당 오류는
INCOMPATIBLE가 아니라 일반 INPUT으로 처리되며 잔여 probe DB의 상세 진단·자동
회수는 아직 없다. 정상 호환 거부 시험의 probe 부재를 모든 실패에 확대하지 않는다.
사전검사 뒤 상태변경은 실제 load가 다시 검사하며, 유지보수 이후의 실패는 기존
recovery-required 절차를 따른다. 프로세스 exit0를 모든 safety 종료 경합을
검증한 것으로 확대하지 않는다.

새 앱 검증 후 이번 build 사본과 두 확장 matrix의 종료된 PG/runtime/legacy
source/TLS17개 경로만 삭제했다. 삭제 직전 해당 디렉터리에 열린 프로세스가
없음을 확인했고 보고서·화면·로그·typed/encrypted payload214개 해시를 유지했다.
`validation/local/restore-preflight/cleanup.json`에 대상과 보존 해시를 기록했다.
관측 여유 공간은35,785,981,952→36,644,417,536 bytes였다. 기존 의존성·사용자
DB/profile/Keychain·기존 source prefix와 두 보존 앱은 정리 대상이 아니다.

## PR89 후속: packaged 복원 실패 / 재시작 검증

원본 `380f67e`에서 `codex/restore-interruption-recovery-20261005`로 작업했다.
제품 코드를 바꾸거나 앱을 재빌드하지 않고, 보존 `wXqDvU` 앱을 매번 새
automation/mock-Keychain claim으로 실행했다. 상세 범위·해시·실패 기록은
`docs/audit/restore-interruption-2026-10-05.md`에 있다.

최종 동일 driver의 `native-fbwjDc`는 실제 DB 교체 뒤 source rename 성공/ACK 전
오류에서92로 rollback·검증 복구·추가 정상 재시작을 통과했다. `native-CRrBPQ`는
B 완료 뒤 plaintext 정리 오류에서91로 복원된 상태를 유지한 채 복구·추가 정상
재시작을 통과했다. 실제 UI 오류, recoveryOnly와 조작 비활성, encrypted checkpoint/
입력/wrapped keyring 및 journal prefix 보존, 소스와 snapshot URI를 확인했다.
각3회 프로세스는 exit0/signal없음이며, 첫 시나리오의 첫 종료는 실제 shutdown
recovery 오류 전달을 관측했으므로 clean으로 세지 않는다. OS native dialog 결과는
검증 도구가 제한된 계약으로 제어하며 사용자 실계정/실제 Keychain은 쓰지 않았다.

최초 `native-nqH5kC`의 세 번째 MANIFEST-stage 시작 실패는 별도 보존한다.
후속 inventory/hash 재검사는 통과했지만 최초 실패 원인은 미확정이다. 검증 도구의
조기 종료 child 참조 보존 결함은 보완했으나 이를 제품 시작 실패의 수정이라고
기록하지 않는다. 후속 `native-mm6XFa`와 위 최종 두 실행은 통과했다.

복구필요 상태에도 기존 데이터 unchanged를 약속하는 generic unavailable 문구가
실제 화면에서 발견되어 다음 UI 수정 항목에 기록했다. 이번 I/O failure 시험을
SIGKILL·전원손실·nonzero 비용원장·실계정 적용·G-RECOVERY 전체 PASS로 확대하지 않는다.

이후 복구 안내와 MANIFEST 진단 코드를 수정한 새 `jXdOYk` 앱의 한영 안내·두 실패
경로 복구/재시작·비호환 사전 거부 회귀가 통과했다. 상세 최신 상태는
`docs/audit/recovery-guidance-diagnostics-2026-10-05.md`와 `07-delivery-release-gates.md`
§5의8단계 진행표를 따른다. 과거 최초 MANIFEST 실패의 근본 원인은 미확정이다.
