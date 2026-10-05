# macOS 런타임 소스 고정·사전 검사 — 2026-10-05

**정식 배포 준비 및 새 native 앱 빌드는 미완료다.** 이번 작업은 앞 단계의
GitHub 복구 UI를 실제 Validation 앱에 넣기 위한 소스 공급 경로와 사전 검사를
준비한 것이다. 기존 합성 DB/브라우저 PASS를 실계정 또는 Electron PASS로 바꾸지 않는다.

**최신 상태:** 원본 `/Users/minseokchae/Dev/code-intelligence`의 기능 브랜치 `codex/macos-runtime-supply-20261005`로 옮겼고 런타임 준비 코드 커밋은 `695424c`다. 원본 반영 파일을 기존 검증본과 해시 대조했다. 기존 검증 기록은 원본 `validation/local/`에 보존하며 독립 clone과 불필요한 캐시·합성 DB·서비스 사본은 사용자 지시에 따라 삭제했다. 아래 디스크 수치와 clone 경로는 초기 검증 당시 기록이다. 기능별 GitHub 반영 후에는 사용자 저장공간 확보 통보까지 새 빌드를 시작하지 않는다.

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
초기 작업에서는 잔여 한도2% 조건 때문에 원격 발행하지 않았으나, 이후 사용자가 해당 조건을 폐기하고 원본 브랜치에서 기능별 commit/push/PR/merge를 지시했다. 현재 이 기능 단위는 소스 공급 준비이며 native 앱 빌드/실계정 검증 완료가 아니다.
