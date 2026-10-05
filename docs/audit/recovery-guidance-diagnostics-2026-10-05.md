# 복구 상태 안내·시작 무결성 오류 진단 — 2026-10-05

## 전체 과정에서의 위치

**배포 전 8단계 중 1단계 ‘데이터 복구 안정화’의 후속 구현이다. 1단계 전체 및 정식 배포는 아직 완료되지 않았다.**
원본 `/Users/minseokchae/Dev/code-intelligence`의 `main=origin/main=8dd6c99`에서
`codex/recovery-guidance-diagnostics-20261005` 브랜치로 작업했다. PR90의 실제 복원
실패 시험에서 발견한 잘못된 안내 문구와 MANIFEST 오류 구분 부족을 보완한다.

사용자 DB·실계정·기존 Validation 프로필·Keychain·private key를 변경하지 않았다.
삭제된 clone/workspace를 재생성하지 않았고, 정식 서명·공증·배포·유료 AI 호출·
GitHub Actions는 실행하지 않는다. 원본에서 기능 브랜치 → 검증 → `[skip ci]`
커밋/푸시 → PR/병합 순서를 유지한다.

## 구현한 변경

### 1. 복구 상태와 기능 지원을 분리

main의 공개 상태에 `backupSupported`를 추가했다. 이 값은 번들이 backup protocol3을
지원하는지 나타내며, 현재 `backupAvailable`/`restoreAvailable`과 다르다. 기존 브리지
자료형에는 optional 필드로 연결하고 실제 `recoveryOnly`/`aiOff` 필드도 명시했다.

Settings는 복구 필요 → 진행 중 작업 → 상태 조회 실패/미확인 → 기능 미지원 →
현재 사용 불가 순서로 안내한다. 복구 필요가 알려져 있으면 ready/지원 여부가
모순되거나 새 상태 조회가 실패해도 복구 안내를 우선한다. 새 안내는 데이터가 이미
교체되었을 수 있음을 설명하고 백업·체크포인트·복구 파일 보관, 앱 재오픈 시 조건부
복구 안내, 검증 실패 시 점검을 요구한다. 원복·무변경·복구 성공을 보장하지 않는다.

복구 필요 또는 상태 미확인/작업 중에는 백업·복원·Runtime 재시작을 차단한다.
Runtime 재시작 버튼이 중단 거래 복구의 대체 수단인 것처럼 안내하지 않는다.
backup/restart 결과 후에도 상태를 갱신하며, 이전 비호환 백업의 ‘기존 데이터 유지’
안내는 이후 복구필요 상태와 함께 남기지 않는다. 한영 문구를 함께 수정했다.
이 pending 차단은 해당 Settings 인스턴스의 상태 기준이며 전역 same-tick 중복 방지
증거는 아니다. 기존 main의 작업 직렬화와 복구 guard를 유지한다.

### 2. MANIFEST 거부 조건을 고정 코드로 기록

`startup-diagnostics.cjs`의 유한한 코드 집합을 제품과 native observer가 공유한다.
manifest 누락·JSON·형식/플랫폼·build/protocol·경로, inventory 누락/추가·파일 형태·
한도·해시·파일 상태 변경, 권한/파일 한도/읽기 오류를 구분한다. 기존
`SAFETY_BUILD_SEQUENCE_INVALID` 계약은 유지한다. ENOENT는 실제 readFile 오류로
판정하며 `existsSync=false`만으로 누락을 확정하지 않는다.

`verifyRuntimeIntegrity`와 inventory 검사에서 원래 message/cause/path/값은 고정
오류로 교체한다. 이미 만들어진 진단 오류가 나중에 수정되어도 고정 message로 다시
구성한다. I/O 실패는 ‘파일을 읽거나 닫지 못했다’고 표시하며 곧바로 파일 손상이라고
단정하지 않는다. 읽기/해시 검사 실패 뒤 close도 실패하면 최초 오류를 유지하고,
검사는 통과했지만 close만 실패해도 정상 시작을 허용하지 않는다.

기존 전수 inventory, 상대경로·Windows alias, symlink/hardlink 거부, 512MiB·개수·
깊이 한도, O_NOFOLLOW, SHA-256, open 전후 identity/size/time/nlink, 필수 파일 검사를
완화하지 않았다. 파일/manifest 자동 수정이나 검증 실패 후 실행 fallback은 없다.

**코드는 관측한 거부 조건이지 과거 실패의 근본 원인을 입증하지 않는다.** PR90의
최초 `native-nqH5kC` MANIFEST 오류 원인은 여전히 미확정이다. 비MANIFEST 시작 단계의
기존 raw-message 경로 전체를 정화한 변경도 아니다. observer는 SDK launch 완료 후
부착하므로 그 이전의 모든 실패/로그를 수집했다고 주장하지 않는다.

## 검증 기록

이번 로컬 실행 기록은 `validation/local/recovery-guidance.ggRZRr/`에 보존한다.

| 실행 | 결과 | 정확한 범위 |
| --- | --- | --- |
| `desktop-first.log` | 178 PASS / 6 FAIL | 구 protocol 문구 기대5개와 공개 상태 키 기대1개가 변경 계약과 달랐다. 최초 실패 기록 보존 |
| `desktop-reviewed.log` | **204 PASS / 0 FAIL / 0 SKIP** | 기존 main/runtime/observer/Windows 모형 및 신규 manifest·I/O·identity·fixed-code·close 회귀. native crash 시험을 실행한 수치가 아님 |
| `desktop-final.log` | **236 PASS / 0 FAIL / 0 SKIP** | 위 범위 + 플랫폼 경로·배포 gate 회귀, 새 합성 C 파일의 ad-hoc 서명/보존 시험. 6932.2515ms. 정식 서명/사용자 키 접근 아님 |
| `settings-first.json` | **44/44 PASS** | 한영 복구·지원 구분, pending/unknown/조회 실패, 실패 후 상태 갱신, 오래된 보존 안내 제거. DOM/API 대역 |
| `settings-final.json` | **44/44 PASS** | 최종 같은 제품 코드의 재검증. 첫 결과와 합산하지 않음 |
| `typecheck.log`, `lint.log` | exit0 | frontend TypeScript noEmit 및 변경 파일 ESLint |
| `package-result.json` / `packager.log` | 첫 패키징 FAIL | 빌드 도구의 제한된 PATH에 npm이 없어 `npm list` 시작이 ENOENT로 실패. 제품 실행 실패와 구분 |
| `package-resume-result.json` | PACKAGED / exit0 | 확인한 npm 경로와 offline 설정으로 패키징 재개. 같은 frontend 빌드/JAR를 재사용, 이전 실패 기록을 별도 보존 |

검증용 frontend는 `.env`를 읽지 않는 별도 Vite 설정으로 빌드했다. 검증된 기존
`wXqDvU` 앱 runtime의 사본에서 JAR의 static 자산120개만 교체했고, 나머지1080 ZIP
entry의 bytes/압축방식과 nested JAR 방식을 대조했다. Java/C 소스를 재컴파일하지
않았다. 별도 앱 `.native-product-jXdOYk/Code Intelligence Validation.app`에 현재
desktop 소스를 반영했고, 각 `.cjs`의 ASAR readback과 runtime inventory, custom
ad-hoc 서명/strict deep 검사를 통과했다. 기존 앱의 ASAR/manifest 해시는 유지됐다.

```text
buildSequence         1791207880791
app.asar SHA256       ab6aeddb1ef96f7586185ba6ebad0a1148a0686b107cc2f3086410d31fab5d12
runtime-manifest      198982420d3d2074ec29898286056cef567cb83f5cd0f972400bb1792e37f6db
```

새 앱의 native 실행은 아래 결과와 검증 JSON에 기록한다. Playwright mock-Keychain과
새 합성 claim만 사용하며, OS 파일선택/복구 확인 응답은 제한된 검증 계약으로 제어한다.
Finder 더블클릭은 격리 claim을 적용하지 않으므로 사용자 프로필 검증 방법으로 사용하지 않는다.

| 새 앱 실행 / `validation/local/` 아래 기록 | 실제 결과 |
| --- | --- |
| `restore-interruption/native-e5Y4sU/result.json` | PASS / 6 checks. B 완료 후 정리 오류에도 복원91 유지·검증 복구·추가 정상 재시작. 한영 안내와 Runtime 재시작 비활성 확인 |
| `restore-interruption/native-hnbzah/result.json` | PASS / 6 checks. source rename 뒤 실패에서 이전92 유지·검증 복구·추가 정상 재시작. 한영 안내와 Runtime 재시작 비활성 확인 |
| `restore-preflight/native-VCIheO/result.json` | PASS / 4 checks. 인증된 비호환 archive의 사전 거부·이후 새 분석·정상 백업 복원·재시작. 새 UI에서도 이전 preflight 계약 유지 |

두 interruption 실행은 각3개, preflight는2개 소유 앱 프로세스의 exit0/signal없음을
기록했다. source-rename 실행의 최초 종료에는 shutdown recovery 안내가 있었으므로
`cleanShutdownObserved=false`를 유지한다. 프로세스 종료와 모든 safety 종료 성공을
동일시하지 않는다. 이번8회 시작에서는 PR90의 MANIFEST 오류가 재현되지 않았지만,
과거 원인이 해결됐거나 향후 재발하지 않는다는 증거로 쓰지 않는다.

실제 한영 안내 화면을 직접 확인했다. 이전의 unchanged 보장은 없어졌고 복구 파일
보관과 앱 재오픈 안내가 표시됐다. 오래된 복원 확인 영역은 실패 화면에 남지만 확인
버튼이 비활성화되어 재실행되지 않는다. 이 영역의 자동 닫기와 페이지 전체의 부가
설정 UX는 후속 사용성 정리 대상으로 구분하며 현재 검증을 G-UX 전체로 세지 않는다.

검증 해시와 실행/보존 상태는
`docs/audit/recovery-guidance-diagnostics-validation-2026-10-05.json`에서 확인한다.

### 정리 범위

이번 실패한 패키징의 부분 앱 `.native-product-cCuC8e`만 열린 파일 부재와 디렉터리
identity를 확인한 뒤 제거했다. 새 빌드 작업 사본 `work-EH5hDE`는 열린 파일 부재를
확정하지 못해 보존했으며, 이를 프로세스가 반드시 남아 있다는 뜻으로 해석하지 않는다.
다른 프로세스에 신호를 보내거나 정리 조건을 완화하지 않았다. 보고서·로그·화면 등32개
증거와 새/기존 앱의 해시를 대조했고, 새 합성 프로필과 백업도 삭제하지 않았다.
정확한 대상/결과는 `validation/local/recovery-guidance.ggRZRr/cleanup.json`에 있다.

## 잔여·다음 실행

전체1단계에는 여전히 소유 프로세스 경계가 검토된 강제종료/전원손실·nonzero 비용
원장 recovery, 구 DB의 extension/physical index/locale·ICU 호환과 실제 적용·되돌리기
조건이 남아 있다. 이번 안내·진단 수정과 개발 Mac의 단일 앱 검증을 G-RECOVERY 전체,
실계정 project1 적용, 지원 OS 설치/업데이트 또는 정식 배포 승인으로 확대하지 않는다.

전체8단계별 상태는 `docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md`
§5의 최신 표를 따른다. 다른 단계의 기반 구현이 존재하더라도 그 단계의 실사용/출시
수용 기준이 완료된 것은 아니며, 단계 번호를 개발 완료율로 환산하지 않는다.
