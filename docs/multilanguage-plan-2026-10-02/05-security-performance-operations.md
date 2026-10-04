# 보안·개인정보·비용·성능·설치 운영 계약

## 1. 위협 모델과 로컬 가져오기

신뢰 경계: repo/파일명/설정/AI 응답은 비신뢰 데이터, renderer는 최소 권한, Electron main은 picker/key/child 관리 권한, backend는 인증된 loopback API, parser worker는 지정 source만 읽는다. 다른 OS 사용자의 접근과 악성 웹페이지/renderer가 로컬 API·비밀을 이용하는 공격을 막는다. OS 계정 전체 탈취·관리자 malware까지 방어한다고 하지 않는다.

| 공격/실패 | 강제 정책 | 검증 |
|---|---|---|
| 임의 경로 승인 | main 전용 path capability, normalized canonical root+identity+expiry+nonce, native dialog 결과만 발급 | renderer/general bearer만으로 승인 403; 재사용/다른 root 거부 |
| home/시스템/secret 폴더 선택 | home 자체/볼륨 root/시스템 root 기본 거부, 더 작은 project 선택; nested secrets 공통 제외 | nested `.ssh/.aws/.gnupg/.config`, keychain, credentials fixtures |
| symlink/race/hardlink/special file | lstat+no-follow open+fstat identity; symlink·socket·FIFO·device·nlink>1 제외, approved root 밖 mount traversal 금지 | preview→copy swap/rename/hardlink/FIFO 중단 |
| preview 뒤 파일 바뀜 | ordered(path,type,size,contentHash,exclusionPolicy) digest+서버 발행 preview token(10분) | count가 같아도 다른 내용/파일이면 409 |
| 용량/압축 폭탄 | preview와 copy 모두 파일50,000/총512MiB/텍스트 파일2MiB, stream bytes actual 제한; compressed archive 자동 해제 안 함 | 한도±1byte, sparse 파일, 파일 증가 race |
| 비밀 복사/전송 | common policy를 preview/copy/inventory/cache/backup/export/AI에 재사용; `.env*`(공개 example만 별도 확인), PEM/key/token 파일 패턴 제외, 내용 secret scan | 제외 sentinel이 snapshot/source cache/log/backup/AI mock body에 0 |
| 설정으로 코드 실행 | package scripts·Gradle·Maven plugins·MSBuild·Cargo/build.rs·proc macro·SwiftPM manifest·compiler plugins 실행 금지 | 악성 hook은 파일/네트워크 sentinel을 만들 수 없음 |
| path alias/case 충돌 | macOS case-fold 충돌과 Unicode 정규화 충돌 검출→명시 실패 | `A.ts/a.ts`, NFC/NFD, traversal·NUL 등 |

vendor/node_modules/venv/.git/build/dist/generated/submodule은 기본 제외. 사용자가 **일반 소스 제외 규칙**을 해제해도 secret/system/symlink/hard limit 금지는 유지한다. ignore 규칙은 snapshot exclusionPolicyHash에 기록한다. 미지원 파일도 inventory metadata에 세지만 bytes 저장은 허용 text/크기 정책에 따른다. 프로젝트 local source를 바꾸지 않는다.

GitHub 가져오기는 기존 JGit 재사용, HTTPS github.com의 검증된 repo identity만 허용, branch는 commit OID로 고정, submodules/LFS 자동 추적·credential helper/filter/hook 실행 금지. raw pack/objects를 받는 transient 0700 quarantine은 512MiB 수신 및 디스크 hard budget을 적용하고 clone 중단 뒤 정리한다. Git transport 특성상 제외될 비밀의 object를 수신할 수 있음을 안내한다. quarantine은 최종 source store/backup/AI에 포함하지 않고 복사 정책을 통과한 text만 snapshot에 남긴다. crash 시 다음 시작에서 cleanup, SSD secure erase는 보장하지 않는다. 소스의 영구 암호화와 transient 접근 제한을 구별한다.

파일 source store는 03의 AEAD/keyring 정책, DB와 metadata는 userData 0700/파일0600·OS 계정 경계. 임의 비밀 완벽 탐지는 불가능하므로 미리보기·제외 설정과 AI OFF를 병행한다. secret scan은 가져오기·근거 excerpt·AI egress 직전 실행하며 큰 파일 앞부분만 검사하고 통과시키지 않는다.

## 2. 인증·네트워크·권한

선택한 GitHub App은 device OAuth를 사용한다. [공식 device 절차](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)는 client ID/device code 기반이며 선택 repo 권한은 user와 app 권한 교집합이다. device code는 main/backend 메모리 전용, renderer에는 user code·허용된 공식 verification URL만 제공한다. polling interval/slow_down/expiry/denied를 지킨다. Contents read-only+Metadata 외 권한을 요구하지 않는다. PR 작성·Actions·조직 관리 권한은 없음.

**공식 문서 검증으로 보정한 결정:** [refresh 문서](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)는 device flow로 생성한 토큰에 client_secret 예외를 명시한다. 따라서 `tokenOrigin=DEVICE`인 토큰만 secret 없이 갱신한다. connector별 단일 갱신 잠금, 새 access/refresh token 원자 교체, 갱신 응답 유실 시 무한 retry 대신 device 재인증. web-origin/legacy 토큰은 재인증 요구하며 secret을 bundle에 내장하지 않는다. 실제 설치 repo 목록·private clone·권한 철회·조직 SSO는 운영 App으로 별도 게이트다.

2026-10-05 구현 경계: 위 자동 갱신·회전은 목표 계약이며 아직 구현 완료가 아니다. 현재 native 흐름은 scope를 보내지 않고 GitHub App의 만료 응답을 검증해 기존 `expires_at`에 저장한다. 만료되거나 과거 OAuth의 만료 시각을 모르면 재인증을 요구하고 PAT로 자동 우회하지 않는다. 기존 PAT 경로는 유지한다. 새 web OAuth는 provider가 준 만료 시각을 저장하며, 만료 시각이 없는 web/legacy OAuth는 사용할 수 없다. refresh token을 저장하지 않으므로 만료 후 사용자가 다시 로그인해야 한다. Client ID는 공개 build metadata 또는 개발 실행 환경으로 전달하며 secret은 포함하지 않는다. 자동 갱신과 실계정 expiry/revoke/SSO를 완료 게이트에서 제거하지 않는다.

기존 GitHub identity 프로젝트는 새 local identity로 임의 전환하지 않는다. migration은 identity ownership map을 검증하여 기존 계정을 보존하고, 로컬 shell identity에 연결할 필요가 있으면 같은 설치의 인증된 explicit account-link 절차를 제공한다. 새 토큰을 받았다는 사실만으로 과거 다른 계정 소유 프로젝트를 읽을 수 없다.

토큰·BYOK 키는 backend 암호화+main safeStorage key wrapping; OS secure storage unavailable이면 plaintext fallback 없이 연결/AI를 비활성화한다. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)의 OS별 보장 차이는 Windows/Linux 이후 게이트에서도 다시 검증한다. 로그·crash dump·환경 진단·child argv에는 토큰 금지; child env는 꼭 필요한 값만 전달하고 로그에서 redaction한다.

| 경로 | 기본 네트워크 정책 |
|---|---|
| local import/parser/graph | 외부 egress 없음, loopback만. source config의 remote schema/URL 자동 fetch 금지 |
| GitHub 연결/import | main/backend만 github.com/api.github.com HTTPS; redirect마다 scheme/host/IP/credential 재검사, cross-origin Authorization 전달 금지 |
| AI | 사용자가 선택한 지원 provider의 고정 HTTPS endpoint만, 임의 baseURL·localhost·사설망 endpoint 첫 릴리스 미지원 |
| 업데이트 | O2로 정한 HTTPS host allowlist+서명 manifest, 코드/분석 결과 전송 없음 |
| telemetry/진단 | 자동 telemetry OFF; 사용자가 확인한 redacted bundle만 수동 내보내기 |

DNS rebind·redirect·IPv6·userinfo URL·encoded host 우회, 사설/loopback/link-local 목적지를 egress dispatcher에서 거부한다(제품 내부 loopback 통신은 별 allowlist). GitHub 응답에서 임의 URL을 그대로 fetch하지 않는다. download CDN이 필요하면 명시된 host만 추가하고 token 제거 후 검증한다. TLS 오류/프록시 인증 오류에서 인증서 검사 disable fallback 금지.

renderer sandbox/contextIsolation 유지, nodeIntegration OFF, remote content/new window/navigation 거부, source/Markdown은 escape+sanitize, CSP 유지. IPC는 sender frame/origin·schema·권한 검사. local API는 loopback bind+설치 token+CSRF/CORS/Origin 검증, DB/Redis는 외부 bind 불가·고유 credential. production parser는 03 ADR-01의 XPC/App Sandbox+상속 worker+stdio로 격리하고 source 밖 사용자 파일/직접 네트워크 접근을 OS에서 차단한다. 개발 sidecar HTTP를 production의 권한 격리 대안으로 쓰지 않는다. [Electron security 지침](https://www.electronjs.org/docs/latest/tutorial/security)을 패키지 검사 목록으로 연결한다.

## 3. AI 비용·개인정보 모델

AI 없이 핵심 분석을 제공한다. 첫 실행 OFF, BYOK optional. 코드·노트·로그는 기본 외부 전송 없음. 켜도 매 호출 preview에서 provider/model·정확한 span 목록·redaction·입력/최대출력·예약액을 보여준다. 사용자가 지정한 context 밖 source를 확대 전송하지 않는다. provider의 보존 정책은 연결 화면에서 해당 provider 공식 정책 링크를 확인하도록 하며 “절대 보관 안 함”을 대신 보장하지 않는다.

과금 범위는 **이 설치가 이 provider로 전송하는 승인 요청**. 같은 키의 다른 앱/수동 호출, 공급자 가격 변경·오청구·세금/환율까지 제한하지 않는다. 엄격 모드는 알려진 price/model/tokenizer/output cap 계약이 있는 adapter만 활성화하며 나머지는 호출 차단한다. 잔액 알림을 상한 보장으로 부르지 않는다.

reservation(microUSD 정수) = ceil((inputUpperBound*inputRate + outputMax*outputRate + embeddingInputUpperBound*embeddingRate + 고정요금상한)*안전계수1.10). 실제 rate는 versioned price catalog에서 읽으며 기획에 현재 가격을 하드코딩하지 않는다. tokenizer가 불명인 model은 UTF-8 bytes만으로 임의 상한이라고 가정하지 않고 strict mode 미지원 처리. reasoning token·cache write 등 추가 과금 차원을 adapter가 upper-bound에 넣을 수 없으면 차단. outputMax는 요청/공급자 모두 enforce 가능한 경우만 허용한다. price catalog 30일 경과 또는 model 계약 변경 감지 시 재검증까지 OFF.

앱 예산 기본값은 **0**, 사용자가 일일/월간 한도를 입력해야 활성화. 동시 요청 최대2, batch는 전체 예약 가능 범위부터 queue. 원장 DB transaction에서 `settled + held + newReservation <= budget`을 체크하고 row lock으로 reserve. UTC 일/월 bucket을 UI timezone 설명과 함께 고정하며 시스템 시간 역행은 새 예산을 주지 않는다.

상태: RESERVED→DISPATCHED→SETTLED 또는 UNKNOWN_HELD. send 전에 reservation과 dispatch intent를 durable commit, commit 실패면 전송하지 않는다. UUID logical request ID와 provider idempotency 지원 여부를 저장한다. response validation/answer 저장 실패여도 usage부터 정산한다. provider timeout/사용량 누락/DB 장애/프로세스 crash는 최대 예약액 유지. 전송 여부 불명은 자동 재호출 금지. provider idempotency가 검증되지 않은 retry는 사용자가 새 예약을 승인해야 한다. 미사용 예약 해제는 “전송 안 됨” 증거 또는 provider usage 확인이 있을 때만 가능하다.

embedding/summary/review/task/playground/what-if와 retry 모두 같은 egress gateway/ledger 사용. AI reservation ledger는 일반 restore로 되돌리지 않는다: 복원 전·후 원장의 logical request ID 합집합과 더 보수적인 settled/held를 보존하고 불일치면 AI OFF로 복구하여 수동 reconciliation 요구. 다른 기기 backup은 범위 밖이다. 일/월 reset이 UNKNOWN_HELD를 지워 새 허용량으로 재사용하지 않도록 총 outstanding guard도 둔다. provider가 상한보다 많이 청구했다고 응답하면 원장 실제액 반영·추가 호출 차단·경고; 초과를 숨기지 않는다.

비용 시험은 fake provider+price fixture로만, 실제 유료 호출 없음. privacy fixture는 key뿐 아니라 인증 header·DB URI·PEM fragment·개인정보 dummy·repo prompt injection·source 외 파일 유도 등을 포함한다. 정적 그래프 fact에 AI 내용을 적재하지 않는다.

## 4. 성능·용량 예산

기준 장비: Apple Silicon M1급 4 performance core 이상/16GiB RAM/SSD, macOS 지원목록, 전원 연결. 측정은 Electron/backend/DB/Redis/모든 worker 합계 process-tree RSS, cold OS cache와 warm cache를 구별한다. 아래는 **미측정 개발 목표**이며 지금 통과한 수치가 아니다.

| 작업/fixture | 목표 SLO/상한 | 초과 시 동작 |
|---|---|---|
| 앱 시작 | cold p95≤30초, warm≤10초, idle RSS≤1.5GiB | runtime별 상태·진단, 무한 spinner 금지 |
| preview | 10k files/50MiB p95≤10초, 첫 응답≤500ms | 진행과 취소, 총 50k/512MiB hard limit |
| 작은 분석 | 1k files/5MiB p95≤30초, 전체 RSS≤3GiB | memory guard/time diagnostic |
| 중간 분석 | 10k files/50MiB p95≤180초, RSS≤4GiB | T05 session 통과 후에만 이 등급 광고 |
| 큰 구조 탐색 | 50k files/200MiB p95≤600초, RSS≤6GiB | deep capability 별 상한 안내; 15분 hard timeout |
| 증분 1% 변경 | medium p95≤30초, 결과 full 동일 | invalidation 불명은 full fallback |
| 취소 | UI ack≤500ms, worker 종료+lock release p95≤5초/max10초 | kill/wait/fencing, partial publish 금지 |
| 그래프 | 검색/부분graph API p95≤500ms, 첫 100노드 표시≤2초 | page당500 nodes/2k edges, 전체10k 탐색 제한 표기 |
| 복구 | 1GiB 테스트 백업 restore≤5분, hash 일치100% | 실패 rollback/marker로 backend 차단 |

hard source file2MiB, DB graph generation 최대1M nodes/5M edges(예산 초과 PARTIAL_LIMIT, current 전환 금지), worker 응답 page≤1MiB/metadata field≤64KiB, AI context는 model별 상한과 사용자 선택 중 작은 것. 전체 분석 메모리 watchdog은6GiB 초과에서 새 work 중지하고 worker 종료; OS OOM 전 제어해야 한다. pg temp/disk·graph 폭증도 quota에 포함한다.

입력·cache·backup 공간을 무제한으로 두지 않는다. workspace quota10GiB, parser temp2GiB, 캐시2GiB LRU, 백업은 사용자 목적지 선택이며 자동 checkpoint 최근2개(각 실제 크기 확인) 보존. import 필요 여유공간 = copied input + 예상 graph(최대 input*5 또는1GiB 중 큰 값) + parser temp 예산 + 1GiB safety. restore/update는 현재 DB+source+이전 bundle+staging+recovery copy 실제 합계 +20% 여유를 사전 검사. 추정치 부족은 stream hard quota로 중단하고 이전 상태 유지한다.

## 5. 백업·복구와 데이터 수명

선택은 same-install format3 encrypted backup. format2 reader는 같은 identity일 때만 지원, format2가 plaintext일 수 있음을 알리고 신규 writer는3만. format3는 versioned manifest(DB schema/app/source format/identity hash), 정제된 DB dump+source blobs+notes/task+필요 source key의 key ID 참조를 포함한 AEAD 암호화 archive, integrity hash와 nonce uniqueness를 검사한다. vault의 key bytes 자체를 덤프하거나 복원으로 교체하지 않는다. GitHub/AI token과 원본 working folder는 제외하고 복원 후 재연결한다. unlock key는 같은 설치 safeStorage에서만 가져오며 archive에 plaintext로 넣지 않는다.

관리 작업 mutex+project writer drain→backend pause→일관 DB dump/source manifest→fsync+hash→암호화 output temp→검증→rename. restore는 암호화/header/identity/schema 검사→안전 staging 추출(경로/symlink/hardlink/special file 거부)→모든 hash 확인→recovery backup→repo/source swap+transactional DB restore→health/invariant 검증→marker clear. 기존 rollback·crash marker 구조를 확장한다. power loss 시 자동으로 성공 취급하지 않고 다음 시작 recovery UI에서 동작한다.

키 rotation은 key version을 늘려 새 데이터부터 사용; 상세 목적별 보존은 §7을 따른다. OS Keychain/설치 identity 유실은 이 백업으로 복구 불가하다고 명시한다. source snapshots와 notes export는 사용자가 따로 보관 가능하지만 외부 전송은 수동 확인. 백업 삭제와 앱 프로젝트 삭제는 별도이며 SSD의 물리 완전 삭제는 보장하지 않는다.

## 6. 패키징·서명·업데이트

빌드 시 JRE21/Node+analyzer/Postgres/pgvector/Redis/필요 native libs를 exact version+digest로 stage하고 SBOM/라이선스 notice 포함. 개발자 빌드에는 toolchain이 필요하지만 사용자 기기에는 요구하지 않는다. native Mach-O `otool -L`로 외부 Homebrew/개발 경로 참조가 없는지 확인하고 `@rpath/@loader_path` relocation 뒤 내부 binary부터 서명한다. `DYLD_LIBRARY_PATH`에 기대어 독립 실행 통과로 인정하지 않는다.

Apple [Developer ID](https://developer.apple.com/developer-id/) 기준 signing+hardened runtime+notarization+staple+Gatekeeper를 검증한다. 새 Mac은 Xcode CLT/Homebrew/Java/Node/Docker/Postgres/Redis 없이 시험한다. 빌드 중 stage는 새 경로 생성→검증→이전 stage 보존 swap→정리, B10의 중간 삭제 창을 제거한다.

첫 업데이트는 사용자가 확인하는 전체 signed DMG/ZIP 전달이다. updater manifest는 pinned public key로 signature를 검증하고 version/platform/arch/artifact SHA-256/schema compatibility/minimum version을 포함한다. manifest만 TLS로 받거나 hash만 맞는 것을 신뢰하지 않는다. 다운받은 app의 TeamID/bundleID/notarization을 확인한 뒤 종료→사용자 설치→첫 기동 health check. update minVersion/antirollback state는 backup restore로 내리지 않는다. 예외 downgrade는 공식 signed recovery manifest+호환 데이터 checkpoint만 허용한다.

DB migration 실패 시 원본 checkpoint가 있으므로 이전 bundle+DB+source를 함께 복원하고 §7의 최신 vault/journal을 유지한다. recovery copy를 남기고 사용자에게 영향 표시. 오류가 지속되면 parser/AI/원격 fetch가 없는 recovery-only 모드. 자동 delta update/무인 설치는 이후 범위다. [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)의 플랫폼 차이를 이유로 현재 단계에서 Windows/Linux updater 지원을 묶어 약속하지 않는다.

Release 전에 모든 runtime/grammar의 재배포 라이선스·NOTICE·보안 advisory를 manifest에 첨부한다. 특히 Redis는 **실제 번들 exact version/license**를 T09에서 확인해야 하며 저장소의 제품 MIT만으로 의존성 배포가 허용된다고 가정하지 않는다. 호환·라이선스 실패 시 공개 배포 차단, 임의 다른 DB/runtime으로 대체하지 않고 좁은 ADR로 돌아간다.

## 7. ADR-02: 복원 밖에 남는 안전 상태와 키 수명

**일반 restore 영역 A** = PostgreSQL 제품 DB, source blobs/manifests, 일반 cache. **안전 영역 B** = main만 쓰는 설치 identity/vault, append-only safety journal, AI OFF latch, updater minimumVersion, 마지막 승인 budget time bucket. B는 A 밖 `userData/safety/`와 OS secure storage에 두며 backup/restore/repo swap/migration cleanup이 B를 덮어쓰지 못하도록 경로 policy를 강제한다. 백업에 보이는 B 정보는 ID/high-water 진단값일 뿐 복원 명령이 아니다. 파일시스템을 장악한 같은 OS 계정의 악의적 rollback까지 막는 하드웨어 단조 카운터를 주장하지 않는다.

journal은 길이-prefix record+증가 sequence+이전 record hash+MAC으로 된 단일 writer log다. main이 0600 파일 append→fsync 후에만 성공 응답한다. atomic checkpoint/rotation은 old segment 유지→new fsync→directory fsync→pointer rename→directory fsync로 처리하고 새 pointer의 durable 확인 및 복구 검증 전 old를 지우지 않는다. source/token/prompt를 넣지 않고 request UUID, budget epoch, reserved/actual microUSD, dispatch/settlement state, price version, key IDs, update high-water만 기록한다. torn tail은 마지막 완전 record까지만 읽되 그 뒤 전송 여부가 불명인 SQL reservation은 전액 HELD 처리한다. checksum/sequence 손상·journal 유실은 AI OFF+update recovery-only로 실패 폐쇄한다.

전송 순서: (1) PG row lock으로 예산 예약 commit, (2) main journal에 RESERVED+DISPATCH_INTENT durable append, (3) 해당 UUID/payload digest에 대한 일회성 dispatch permit 반환, (4) backend egress가 한 번 전송. permit 전에는 provider 호출 금지. crash/retry는 같은 UUID의 두 번째 permit을 발급하지 않는다. usage settlement는 journal fsync→PG projection 반영 순서다. journal ACK 실패는 최대 hold 유지. PG는 동시성/조회 원장, **되돌릴 수 없는 과금 의무는 journal이 상위 권위**다. 서로 다르면 더 보수적인 의무를 적용하고 reconciliation 전 신규 AI 차단한다.

복구 state machine(각 화살표 전후 power-loss test):

`NORMAL → LATCHED → SAFETY_SEALED → DATA_STAGED → DATA_RESTORED → SAFETY_MERGED → HEALTH_VERIFIED → NORMAL`.

1. `LATCHED`: 관리 mutex 획득, 새 dispatch 중단, 안전영역에 AI OFF latch fsync. 진행중 응답을 기다리거나 timeout을 UNKNOWN_HELD로 확정하고 journal에 기록한다. latch는 snapshot DB에 두지 않는다.
2. `SAFETY_SEALED`: 현재 PG reservation/usage와 journal을 UUID 기준 검증하고 `restoreTransactionId,seq,hash,key inventory`를 B에 fsync. journal에 없던 legacy usage/reservation은 보수적 import record로 기록. 실패면 A를 건드리지 않는다.
3. `DATA_STAGED/RESTORED`: backup 무결성·필요 key 존재 확인 후 A만 복원. B/키 vault가 포함된 경로 항목은 거부. DB/source rollback도 A만 대상으로 한다.
4. `SAFETY_MERGED`: journal의 latest valid per-UUID settlement/hold를 새 PG에 반영. backup에만 있는 UUID는 추가 의무로 취급하고 UNKNOWN이면 최대 예약액 유지. 동일 UUID의 충돌에는 큰 liability를 적용하며 **같은 요청의 증명된 최종 settlement**만 미사용 hold 해제 가능. budget bucket/clock high-water·minimumVersion은 max 유지. merge transaction commit→count/sum/hash invariant 확인→journal merge receipt fsync.
5. `HEALTH_VERIFIED`: source keys·DB·ownership·노트/task 참조·잔액 nonnegative·현재 signed binary의 minimumVersion 허용을 검사. 통과해야 latch 제거를 fsync. 실패/도중 재기동은 latch 유지하고 마지막 state부터 idempotent 복구. provider key는 제외했으므로 새 연결과 사용자의 AI 재활성화도 필요하다.

오래된 binary가 safety journal major를 이해하지 못하면 정상 backend/AI를 시작하지 못한다. signed recovery manifest와 호환 reader가 있는 버전만 rollback 허용하며 “옛 버전이니 예산 검사를 건너뛴다”는 경로는 없다.

| 키/식별자 | 목적·저장 | rotation·복원 정책 |
|---|---|---|
| installationIdentity | 같은 설치/소유권 binding, B+OS key wrapping | restore로 교체 금지; 유실은 다른 설치로 간주 |
| K-source[v] | source blob AES-256-GCM | 새 버전부터 쓰기. retained snapshot/recovery/백업의 key ID가 참조하면 삭제 금지 |
| K-backup[v] | archive별 무작위 DEK wrapping | 독립 버전. 최초 R1에서는 old backup wrapping key를 자동 삭제하지 않음; 사용자가 외장 저장소 백업을 갖고 있을 수 있음 |
| K-credential[v] | GitHub/BYOK credential 암호화 | 백업 제외, restore 후 최신 키로 재연결; source/backup key로 사용 금지 |
| K-safety[v] | journal MAC/암호화·checkpoint 무결성 | B에 보존, 이전 segment 검증용 old key 유지; 일반 restore/GC 금지 |

safeStorage로 감싼 purpose별 독립 무작위256bit key를 사용하며 root secret을 environment/worker/백업에 넣지 않는다. archive DEK는 독립 무작위256bit AES key다. archive chunk nonce와 source blob nonce는 각각 독립96bit random이며 GCM tag는128bit다. archive는1MiB chunk 단위, AAD에 format/identity/keyId/archiveId/chunkIndex/총개수를 묶고 duplicate nonce/index·누락·재정렬을 거부한다. 구현에서는 검증된 crypto API만 사용하고 재시도 시 새 archive DEK/nonce를 발급한다. source key는 R1에서 자동 폐기하지 않아 이동된 옛 backup의 key 참조를 놓치지 않는다. 수동 key 폐기는 영향 백업이 복구 불가함을 별도 확인하는 장래 관리 기능이다.

**credential-free DB backup:** 현재 `github_credentials`와 `user_ai_settings.encrypted_key`가 일반 pg_dump에 들어갈 수 있다. format3 writer는 허용된 데이터 export 정책을 적용해 credential 테이블 data를 제외하고 `user_ai_settings`는 key 없는 별도 설정 projection만 포함한다. schema는 유지하며 restore 후 settings OFF/reconnect-required로 생성한다. 새 secret column/table 추가 시 export allowlist와 분류 검증이 없으면 build gate FAIL. 복원 staging DB에서 encrypted/plain token sentinel이0인지 검사 후에만 사용자 DB 교체. format2 legacy dump는 key를 담을 수 있으므로 신뢰한 same-install 자료만 격리 staging DB로 읽어 동일 scrub/검증 후 적용하며 직접 restore하지 않는다. PG dump archive는 untrusted executable SQL일 수 있어 unknown identity/format/signature 자료를 정상 DB에 실행하지 않는다.
