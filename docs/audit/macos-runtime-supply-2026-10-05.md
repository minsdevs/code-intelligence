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
