# Mac 유지 및 Windows 지원 준비

사용자의 최신 요청에 따라 **Windows 앱 지원을 개발 범위에 추가**했다. 동결된 이전 계획의
macOS 첫 배포 범위는 역사적 기준이며 Windows 요청을 거부하는 근거로 사용하지 않았다.
현재 Mac과 Windows 모두 **출시 No-Go**다. 이번 작업은 Windows 완성 설치 파일을 만들지 않았다.

## 완료한 안전한 준비

- `desktop/src/runtime-platform.cjs:6`과 main 연결: bundle 상대 경로에서 drive-relative,
  traversal, NUL/control, NTFS stream 문법을 거부한다. Windows에서는 device 이름,
  trailing dot/space 및 금지 문자도 거부한다. canonical manifest 구분자는 `/`다.
- 같은 파일 `:19`: Windows native 실행 파일만 `.exe`로 찾고 JAR/JS는 유지한다.
  relocated PostgreSQL bin, 공백·한글 경로를 모델링해 검증했다.
- 같은 파일 `:30`: Windows의 `SystemRoot`, `TEMP`, `USERPROFILE` 등 필요한 OS 값과
  대소문자 차이를 처리한다. 호스트 API key, Node/Java injection 옵션은 상속하지 않는다.
  `:42`에서 DLL 디렉터리는 Windows PATH, 기존 Mac은 기존 library 환경으로 구성한다.
- `desktop/package.json:48`: Windows x64 NSIS, 사용자 단위 설치, app `asInvoker`,
  elevation helper 제외, uninstall 시 app-data 보존, 서명 필수 설정을 추가했다.
  Mac target/기존 staging 지침은 유지했다. 자동 업데이트/배포 채널은 만들지 않았다.
- `npm run check:windows`는 blocker를 출력하고 exit 1 한다. `pack:win`/`dist:win`과
  직접 builder 호출의 `beforePack` 모두 같은 차단을 적용한다. 안전 구현 없이 설치물을
  만들 수 있는 환경 변수 우회는 없다. `--publish never`를 명시했다.

**검증:** 플랫폼 모형·경로 공격 입력·환경 allowlist·build 차단·설치된 builder 26.15.3 schema
**28 PASS**, 실제 main의 기존 integrity/environment 모형 **2 PASS**, JS syntax 및
`git diff --check` PASS. 이것은 Windows OS 실행 결과가 아니다.

## 발견 및 출시 차단점

| 심각도 / 우선순위 | 현재 파일·근거 | 사용자 영향 / 처리 |
|---|---|---|
| High / P1 | `safety-lifecycle.cjs:48`은 darwin만 허용. `purpose-keyring.cjs:69,334`, `source-vault.cjs:65,422`, `source-broker.cjs:82`는 getuid/POSIX/O_NOFOLLOW 의존 | Windows에서 단순 조건 제거로 실행하면 보관·권한 보장이 사라진다. ACL/reparse-point 검증, secure storage, durable replace/fsync에 대한 Windows 구현·실기기 시험이 먼저 필요. 차단 유지. |
| High / P1 | `NativeLeaseWorker.java:80,163,177`, `RetainedRunWorkspace.java:146,632`의 POSIX permissions/unix attributes. `managed-process.cjs:167`의 Java worker 실행 | Windows 잠금·open handle·재시작·process tree 종료가 검증되지 않았다. 소유 Java Process/Windows Job Object 등 native 수명 관리 전략과 NTFS 잠금 시험 필요. PID 재사용 시험 재활성화 금지. |
| High / P1 | `stage-runtime.mjs:153` Mac arm64 전용, Mach-O/otool/jlink 및 Unix PG/Redis layout | Mac에서 `.exe` 이름만 만들 수 없다. Windows x64 JRE 21, PostgreSQL·pgvector/pg_trgm·전이 DLL의 독립 bundle, 라이선스와 hash/서명 검증이 필요. 별도 Windows staging 구현은 아직 없다. |
| High / P1 | `main.cjs` Redis 시작과 Java Spring Session/JobProgressPublisher의 Redis 사용 | Windows native Redis 공급 방식 또는 desktop session/event 구조 선택이 필요. 아래 선택지 참조. |
| Medium / P2, 수정 | 이전 main은 확장자 없는 native binary만 조회하고 Unix library 변수를 사용 | Windows executable/environment 경로 준비를 공통 모듈로 구현. 실제 프로세스 기동은 미검증. |
| Medium / P2, 수정 | 이전 manifest 검사는 Windows drive-relative/stream/device alias 전체를 거부하지 않음 | 플랫폼에 따라 같은 문자열이 다른 파일을 가리킬 여지가 있음. 새 경로 검증으로 거부. 현재 Windows 실행 gate는 계속 닫혀 있음. |
| High / P1, Mac도 해당 | package mac floor 13.0, 동결 PRD D02 목표 floor 14, 기존 stage `jre/release`의 JAVA_VERSION 26.0.2 | JDK 21 계약과 기존 bundle이 불일치한다. 지원 OS 명세와 실제 독립 bundle을 맞추고 깨끗한 Mac에서 검증해야 한다. 이번 standalone JDK 21 시험이 설치 bundle을 교체한 것은 아님. |
| High / P1, 공통 | 운영 OAuth 선택/등록·토큰 갱신, source consumer migration, 대표 정확도·대규모 성능, signed install/update/rollback 미검증 | 빌드나 제한 연결 시험 성공만으로 배포할 수 없음. 기존 release blocker 유지. |

## 운영 결정 권고

**첫 Windows 목표는 Windows 11 Home/Pro 25H2·26H2 x64**를 권고한다. Mac arm64 목표를 유지하고
Windows ARM64는 JRE·DB·확장·서명 산출물 전체의 native 검증 후 추가한다. 이것은 지원 완료 약속이 아니다.
25H2/26H2의 지원 상태는 [Microsoft lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-11-home-and-pro)로 확인했다.
Windows 10 Home/Pro 기본 지원은 이미 종료돼 첫 지원 대상으로 권하지 않는다.
[Microsoft Windows 10 lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro).

Redis 운영 선택은 다음과 같다. 자동으로 제품 구조나 라이선스를 변경하지 않았다.

| 선택 | 장점 | 필요한 결정/검증 |
|---|---|---|
| **권고: desktop 프로필의 Redis 의존을 분리**하고 단일 backend의 session/event 전달로 구성, 서버 프로필 Redis 유지 | 사용자가 WSL/Docker·서비스를 별도로 설치할 필요를 없애고 native bundle 수를 줄임 | session/OAuth reconnect·SSE 복구·동시성 계약 검토, Java 구성 전환과 회귀 시험이 필요한 구조 변경. 이번에는 미구현. |
| Windows 호환 Redis runtime 공급 | 기존 Spring Redis 계약 유지 | 재배포·유료/사용 조건·API 버전·process ownership·DLL 공급 검토 필요. 비용·계약 선택을 승인 없이 진행할 수 없음. |
| 사용자 WSL/Docker 설치 | 기존 Linux runtime 사용 | “개발 도구 설치 없이 앱만 설치” 목표에 맞지 않아 기본 제품 경로로 권고하지 않음. |

Redis 공식 문서는 Windows native 경로로 Memurai, 다른 경로로 WSL을 안내한다.
이를 번들 재배포 허가로 해석하지 않았다. [Redis Windows 설치 문서](https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-on-windows/).

현재 Electron synchronous safeStorage의 Windows DPAPI는 같은 사용자 계정으로 실행되는
다른 앱에 대한 macOS Keychain과 동일한 격리를 제공하지 않는다. worker에 토큰을 주지 않는
기존 경계를 유지하되 Windows threat model/ACL 정책을 따로 정해야 한다. 단순 OS 조건 삭제나
평문 fallback은 구현하지 않았다. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## OS별 인수 상태와 다음 순서

| 검증 | Mac | Windows |
|---|---|---|
| 공통 HTTP → DB → SSE | Mac Node/JDK + Linux Docker DB로 14항목 통과 | Windows에서 미실행 |
| 경로/환경/build 규칙 | Mac 기존 main 모형 2개 통과 | Mac 위 Windows 규칙 모형 28개 통과; native 증거 아님 |
| 전체 native bundle | 기존 stage가 JDK/배포 기준과 불일치 | 공급·staging 미완료 |
| 새 OS 사용자 설치→로컬 폴더→마인드맵→소스 | 이번에는 미실행 | 미실행 |
| 운영 GitHub OAuth→private repo | 미실행/운영 선택 필요 | 미실행/운영 선택 필요 |
| 서명·업데이트·rollback·data 보존 | Developer ID/notary/실기기 수용 미완료 | Authenticode/설치·업데이트 수용 미완료 |

이 세션에서 확인된 실행 환경은 Mac arm64와 Linux arm64 Docker뿐이다. Windows runner는 제공·확인되지 않았다.
VM 구매, OS 설치, 보안 설정 변경, 외부 CI 업로드를 수행하지 않았다. 다음 순서는
① 공통 출시 blocker와 desktop Redis/Windows 보관 정책 결정 → ② native Windows 구현·독립 bundle →
③ 실제 Windows 환경 및 깨끗한 Mac의 설치·OAuth·복구·업데이트 수용이다.
별도 Mac 앱 실행 요청의 충돌/경로 정보는 [실행 담당 인계](app-launch-handoff-2026-10-03.md)에 있다.
