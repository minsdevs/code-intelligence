# 현재 출시 준비도 — 2026-10-03 재시작 복구 후속 후보

**출시 No-Go 유지.** 인증된 동일 거래 재개, retained 소스 재구성, 공간·보존과
프로세스 종료 소유권을 구현했다. 실제 PG·Redis·JAR owner SIGKILL 두 경계가 통과했다.
현재 상세 발견·수정·검증 한계는 [재시작 복구 감사](restart-recovery-audit-2026-10-03.md)를 따른다.
최종 backend 1337/1337, frontend 293/293, analyzer 108/108 및 실제 TS→Java→PG 7/7을 통과했다.
Desktop 전체는 2520 PASS/실패 0/별도 PG opt-in skip 8이며 76개 파일 drift 0이다.
Native 독립 28/28을 포함한 최종 명령·범위·실패 이력·SHA는
[기계 판독 검증 기록](restart-recovery-validation-2026-10-03.json)에 있다.

호환 runtime·운영 OAuth·일반 source consumer 이행·OS 격리·서명 설치와 대표
정확도 수용은 남아 있다. 아래 수치와 미연결 목록은 각 시점의 이력으로 보존한다.

## 이전 후보 기록

# 출시 준비도 — 2026-10-03 백업·복원 통합 후보

**일반 사용자 대상 출시는 No-Go다.** 실제 Electron main에 format3 typed 백업·복원,
안전 원장 B의 비용 의무 보존, 자격증명·승인 폐기와 시작 시 maintenance 차단을 연결했다.
실제 backend health를 확인한 뒤에만 완료를 기록하고 공개 접근을 다시 연다.

현재 발견·수정·검증·남은 차단점은 [백업·복원 통합 보고서](backup-restore-integration-2026-10-03.md),
재현 명령·실패 이력·소스/산출물 해시는
[검증 기록](backup-restore-validation-2026-10-03.json)을 따른다.
이후 문단의 백업 진입점 미연결과 이전 테스트 수치는 각 당시 후보의 이력이다.

중단된 거래의 recovery-only 시작/동일 거래 재개, source 완전성·native 권한 경계,
전체 공간/보존 정책과 과거 형식 변환, 운영 OAuth·실제 Keychain·서명 설치/업데이트,
독립 NestJS/React 정확도·대형 저장소 수용은 아직 완료되지 않았다.
빌드와 합성·격리 통합 검증 통과를 운영 출시 승인으로 해석하지 않는다.

## 이전 비용 통합 후보 — 당시 기록

# 출시 준비도 — 2026-10-03 비용 통합 후보

**일반 사용자 대상 프로덕션 출시는 No-Go다.** 최신 코드는 Electron main/preload,
Spring Boot/Java 21, PostgreSQL/pgvector·Redis, React/Vite와 NestJS/TypeScript sidecar를
유지하며 Flyway V1–V25를 사용한다. 이전의 desktop AI 일괄 차단 단계에서 실제
요청 승인·main 전송·영속 예약/정산을 연결했다.

현재 수정·심각도별 발견·검증 수치는 [비용 통합 보고서](strict-ai-cost-integration-2026-10-03.md),
명령·소스/산출물 해시·실패 이력·보존 근거는
[기계 판독 기록](strict-ai-cost-validation-2026-10-03.json)을 따른다.
아래 V24 및 그 이전 수치는 해당 시점의 이력이며 현재 실행 결과가 아니다.

사용 가능한 구현 범위는 로컬 설치 소유자의 고정 OpenAI 모델 Assistant Q&A다.
키 저장, 예산 한도와 활성화, 개별 문맥/최대액 승인을 분리했다. 불확실한 전송은 비용을
보류하고 자동 재시도하지 않는다. 다른 desktop AI 호출은 계속 거부한다.
운영 provider·실계정·실제 Keychain·설치 Electron을 검증한 것은 아니다.

| 남은 blocker / 우선순위 | 사용자 영향과 필요한 작업 |
|---|---|
| High / P0 — 백업·복원 | 기존 제품 진입점은 계속 차단. Typed PG export/격리 loader/source pin과 키/A·B 의무 merge 필요. 소유자 범위와 완전 source 대 metadata export 계약 선택 필요 |
| High / P1 — source·native 권한 | 과거 history/IDE 소비자의 shared clone·원본 경로 의존을 함께 이행하고 서명된 파일/프로세스/네트워크 경계를 검증해야 함 |
| High / P1 — 운영 AI·복구 | 제한된 고정 모델/가격 계약만 구현. 실제 usage/청구, 강제 종료·전원 장애·legacy 불명 의무와 부분 초기화 복구 수용 필요 |
| High / P1 — OAuth·배포 | 실제 GitHub 등록·callback·권한/만료·취소, clean Mac 설치, safeStorage 업그레이드, 서명/notary/Gatekeeper/update/rollback 증거 없음 |
| High / P1 — 정확도·성능 | 독립 NestJS+React holdout, 화면→API→서비스→데이터와 변경 영향의 근거 정확도, 대형 저장소 자원 한도·사용자 과제 수용 필요 |

기존 사용자 변경과 동결 명세를 보존했다. 실제 프로젝트 데이터/비밀을 검증에 사용하지
않았으며 reset·커밋·push·PR·업로드·유료 호출·게시·배포하지 않았다.
빌드 통과와 합성/격리 통합 통과만으로 일반 사용자 출시를 승인하지 않는다.

## 이전 V24 앱 안전 통합 체크포인트

다음 본문은 889/179/572 후보의 원래 기록이다. 그 시점의 desktop AI 차단과 비용 경로
미연결은 위 V25 후속 후보에서 바뀌었으며, 이력을 보존하기 위해 원문을 남긴다.

**판정: 일반 사용자 대상 프로덕션 출시는 No-Go다.** 범위가 명확한 결함은 수정했고
후속 앱 안전 통합의 전체 회귀와 독립 검토를 마쳤다. 미완성 기능을 사용할 수 없도록 한
보호 조치와 실제 출시 기능의 완성을 구분한다.

현재 스택은 Electron main/preload, loopback Spring Boot/Java 21, PostgreSQL/pgvector·Redis,
React/Vite와 NestJS/TypeScript 분석 sidecar다. Flyway는 **V1–V24**이며 기존 스택을 교체하지 않았다.
main이 purpose keyring과 safety journal의 시작·종료를 실제로 소유한다. source vault/broker와
모든 source consumer의 연결, provider 비용 승인·정산, 안전한 백업 loader는 아직 미완료다.

최종 구현·심각도별 발견·실패 재현은 [앱 안전 통합 보고서](app-safety-integration-2026-10-03.md),
명령·소스/산출물 해시·검증 한계는 [검증 기록](app-safety-validation-2026-10-03.json)에 있다.

| 최종 검증 | 결과 | 한계 |
|---|---|---|
| Backend formatter/test/build | **889/889 PASS**, 96 suites | 임시 DB 단위·통합, 실제 배포 아님 |
| 별도 source 사용자 흐름 | **12/12 PASS** | 실제 backend/PG와 격리 headless, 설치 Electron UI 아님 |
| Frontend | **179/179 PASS**, 27 files; lint/typecheck/build PASS | 컴포넌트 검증, 실제 Keychain/OAuth 아님 |
| Desktop | **572/572 PASS** | main/lifecycle 118개·export 정책 77개·stage 23개 포함, synthetic key/temp FS |
| 독립 main probe | **17/17 PASS** | 종료 경합 두 결함 수정 후 검증, 실제 OS 강제 종료/Keychain 아님 |
| V24 임시 DB catalog | **8/8 PASS**, 49 tables·395 columns | export/restore 전체 제품 흐름 아님 |

위 최종 실행은 실패/error/skip 0이며 서로 포함되는 범위의 수를 합산하지 않는다. 기존 Gradle
handshake와 Vite bundle 크기 경고는 남아 있다. 운영 OAuth·실계정 만료/취소, clean Mac 설치,
서명/notary/Gatekeeper/update/rollback, 전원 장애와 대형 저장소 성능 수용은 **미실행/미검증**이다.

| 남은 blocker / 우선순위 | 현재 근거·사용자 영향과 다음 작업 |
|---|---|
| High / P0 — AI 요청·비용 승인 | `AiSafetyPolicy.java`가 desktop Save/provider 진입을 막는다. OFF·재연결과 동시성 제한은 구현됐지만 RequestPlan, 가격/출력 상한, durable 예약·정산 및 PG↔journal 조정이 필요하다. Desktop AI 사용 불가. |
| High / P0 — 백업·복원 | `desktop/src/main.cjs`의 기존 backup/restore는 dialog·dump·SQL 이전에 거부한다. Typed PG codec, 일관된 export, 격리 loader, source pin/key 및 안전 원장 merge가 필요하다. 전체 설치 사용자/현재 사용자, 완전 소스/metadata 전용 범위는 제품 결정이 필요하다. |
| High / P1 — source/runtime 권한 경계 | main keyring/journal 연결과 source vault/broker 연결은 별개다. 과거 source의 shared Git clone·원본 IDE 경로 의존을 함께 옮기고 서명된 native descriptor/file/network 격리를 검증해야 한다. |
| High / P1 — 운영 로그인·배포 | 실제 GitHub 등록/callback·권한 흐름, build sequence 발급 주체, safeStorage 접근/업그레이드, 서명/notary 및 개발 도구 없는 새 Mac 설치·업데이트 수용 증거가 없다. |
| High / P1 — 정확도·성능 | 작은 fixture는 독립 NestJS+React holdout의 화면→API→서비스→데이터 흐름·변경 영향·근거 정확도와 대형 저장소 자원 한도를 입증하지 않는다. 독립 annotation과 사용자 과제 검증이 필요하다. |

기존 변경을 보존했으며 초기/후속 기준 파일을 삭제하지 않았다. 이번 재개 기준 857파일 모두
남아 있고 기획 20개 및 동결한 실행 명세는 byte-identical이다. 실자격증명·실제 userData·설치 앱·
사용자 브라우저를 사용하지 않았고 reset/commit/push/PR/외부 업로드/유료 호출/배포를 하지 않았다.

## 이전 후보 기록 — 아래 수치와 미연결 항목은 당시 상태

아래는 857/152/456 후보의 원래 발견·검증 이력이다. 환경 key fallback과 main keyring/journal
미연결, 활성 legacy backup/restore 등의 당시 결함은 위 후속 수정으로 바뀌었으므로 현재
판정에는 위 표와 최종 보고서를 우선한다. 기존 실패와 검증 한계를 숨기지 않기 위해 보존한다.

**일반 사용자 대상 프로덕션 출시는 No-Go다.** 코드 수정과 합성·실제 로컬 통합 검증은
진전됐지만, 운영 OAuth·권한 격리·암호화 저장소의 앱 연결·안전한 복원·서명 설치·독립
정확도 수용은 아직 완료되지 않았다. 이 판정은 개발을 중단하라는 뜻이 아니다.

저장소 접근은 정상이다. `codex/e2e-docs-scripts`, HEAD `ebe3ab1`의 기존 작업 트리에
수정했으며 reset/삭제/commit/push/PR/배포를 하지 않았다. 743개 초기 기준 파일과 797개
후속 기준 파일이 모두 남아 있고, 원래 기획 20개와 동결한 실행 명세의 SHA가 일치한다.
사용자 프로젝트 데이터·실자격증명·설치 앱·실제 userData·Keychain·사용자 브라우저는
검증 자료로 사용하지 않았다.

현재 구현은 Electron main/preload, loopback Spring Boot/Java 21, PostgreSQL/pgvector와
Redis, React/Vite, NestJS/TypeScript 분석 sidecar다. Flyway V1–V23을 기준으로 읽었다.
기존 스택을 교체하지 않았으며, 새 소스 저장소와 안전 원장 모듈이 존재한다는 사실을
실제 데스크톱 main 연결 완료로 계산하지 않았다.

## 수정한 주요 결함

| 심각도 / 우선순위 | 근거 및 사용자 영향 | 수정·검증 |
|---|---|---|
| High / P1 | `ContextRetrievalService.java`의 `retrieveWithExclusions`: 제외 전에 요약 생성·임베딩을 실행해 제외한 소스/요약이 보조 요청과 최종 관련 요약에 다시 포함됨 | 비어 있지 않은 제외 목록은 로컬 조립만 사용. 바뀐 제외 ID는 409로 중단. 수정 전 3건 실패, 수정 후 provider 호출·DB 쓰기 0 검증 |
| High / P1 | `AiPanel.tsx`의 `copyPrompt`: 체크 해제와 무관하게 전체 원본 프롬프트 복사 | 제외 목록을 지원하는 로컬 preview API에 다시 검증. 실패 시 클립보드 유지. 실제 API 및 UI 실패 재현 후 통과 |
| Medium / P1 | `AiPanel.tsx`의 `onPreview`: 바뀐 미리보기에도 숨은 옛 제외 ID 유지 | 새 목록을 보수적으로 전부 제외한 뒤 포함 항목을 선택. 현재 ID만 전송하는 회귀 통과 |
| High / P1 | `RetainedRunWorkspace.java`의 잠금 획득: 같은 JVM의 실패한 contender가 채널을 닫아 실제 OS 잠금까지 해제 | 채널 열기 전 디렉터리 identity로 JVM 소유권 예약. 실제 별도 JVM 반례 2건 실패→수정 후 전체 80건 통과, case alias도 실제 실행 |
| High / P0 | `FinalizeStep.java`: 취소와 결과 게시가 경합하면 취소된 작업이 새 current를 게시할 수 있음 | project→job→snapshot 잠금과 상태 재검증. generation/current/checkpoint/DONE을 한 DB transaction으로 게시 |
| High / P1 | `SourceJobWorkspace.java`, `RetrySourceGuard.java`, `ImportStep.java`: retained retry가 삭제된 공유 clone 또는 원본 폴더를 다시 요구 | 승인된 immutable manifest와 blob으로 매 실행을 재구성. public retry+worker, blob 손상·누락·과거 작업 방어를 포함한 37개 실제 DB 통합 통과 |
| Medium / P1 | `LocalSnapshotStore.java`: 진단 저장 실패 전에 source metadata와 job snapshot이 게시됨 | 진단·metadata·job 연결을 같은 transaction으로 묶고 실제 부분 실패 주입 회귀 통과 |
| High / P1 | `ContextRetrievalService.java`의 과거 소스 읽기: snapshot A 요청에서 live B를 사용 | 인증·소유권으로 확인한 snapshot Git OID/retained bytes만 읽으며 live fallback 제거. 실제 Git 반례 3건 실패→통과 |
| Medium / P2 | `ContextRetrievalService.java:95,282`: 제외 필터가 포함 NODE의 링크를 잃고, 예산에서 탈락한 SOURCE/NODE 링크를 남기며 노트의 임의 `file:...` 문자열을 구조화 근거로 취급 | 본문 해석 대신 실제 포함 block에 fileRefs를 연결. 수정 전 25개 중 4개 실패, 수정 후 집중 43개 및 전체 회귀 통과. 한글·공백·콜론 경로도 보존 |

추가 schema 불변성, parent 삭제 FK 순서, 안전 원장 복원 중단·키 버퍼 정리, 아키텍처
의존성 충돌의 근거와 수정 이력은 [연속 작업 기록](continuation-2026-10-03.md)에 있다.
독립 검토 결과는 해당 수정 범위의 판단이며 제품 전체 보안 인증이 아니다.

## 실행 결과

| 검증 | 결과 | 수용 범위 |
|---|---|---|
| backend formatter/check/build | PASS, **857/857**, 92 suites, 실패/error/skip 0 | 추가 근거 링크 수정까지 포함. 실제 임시 DB를 사용하는 단위·통합 |
| `snapshotSourceTest` | PASS, **12/12** | 실제 backend/DB와 격리 headless 브라우저, Java/TS 소스·근거·경합 흐름 |
| frontend | lint 및 TypeScript/Vite build PASS, **152/152**, 27 files | UI 단위/컴포넌트 검증. Electron 실기기 UI 아님 |
| desktop Node 모듈 | PASS, **456/456**, skip/cancel 0 | source vault/broker, runtime/stage/backup, safety/keyring, opaque archive와 신규 export 정책 68개 포함. synthetic key/temp FS |
| 실제 TS sidecar fixture pipeline | PASS, **7/7** | spring/react/fullstack 작은 fixture. 독립 대형 NestJS 정확도 아님 |
| TS analyzer | typecheck/build PASS, **11/11** | analyzer 자체 회귀 |
| 신규 export policy | 실제 임시 PostgreSQL catalog **8/8**, 독립 합성 probe **21/21** PASS | 48개 table·388개 column과 23개 migration 검증. 실제 제품 export/restore·권한·OFF 강제는 미연결 |
| 운영 OAuth·실계정 만료/갱신·새 Mac 설치·서명/notary/update·전원 장애 | **미실행/미검증** | 자격증명·기기·운영 인수 환경 필요 |

첫 전체 실행의 845개 중 3개 실패와 새 결함의 RED 결과도 보존했다. 잘못된 Git/job
fixture를 실제 런타임 계약에 맞췄으며 production guard를 완화하지 않았다. 로컬 Gradle
handshake 경고와 Vite 큰 bundle 경고는 남아 있다. 빌드 성공은 성능/서명 수용이 아니다.

신규 백업 정책은 지정 자격증명·경로·승인 컬럼을 선택 대상에서 제외하고, 노트/task 원문과
큰 정수 ID·금액을 보존한다. 미분류 schema/SQL은 중단한다. 순수 모듈과 임시 catalog만
검증했으며 임의 본문의 비밀 제거, 실제 DB 숫자 변환, 복원 후 OFF 집행 완료를 뜻하지 않는다.
[정책 계약과 검증 범위](backup-export-policy-contract-2026-10-03.md)에 독립 검토·실행 근거를 구분했다.

## 남은 출시 차단점과 순서

| 심각도 / 우선순위 | 현재 근거 | 영향 및 다음 결정·작업 |
|---|---|---|
| High / P0 | `AiUsageService.java:24–36`, `SummaryService.java:63,98,125`: 호출 전 사용량 조회·호출 후 기록, embedding 직접 호출 | 동시 요청·응답 유실·DB 오류에서 엄격한 한도 미보장. main safety journal과 모든 provider 호출의 예약/dispatch/정산을 연결하고 복원 후 OFF를 강제해야 함 |
| High / P0 | `desktop/src/main.cjs:501`, `backup.cjs:96`: 전체 DB dump/Git 디렉터리 복사와 일반 DB SQL 복원 | credential-free format3와 안전한 staging 복원이 아님. schema allowlist, keyless 설정, isolated data loader, safety-state merge가 필요. [48 table/388 column 설계·선택지](t09-export-design-2026-10-03.md) 참조 |
| High / P0 | `AIProviderConfig.java:47–59`: DB key가 없으면 환경 설정으로 fallback | 백업에서 key row를 빼는 것만으로 AI OFF가 되지 않음. 복원/재시작 후 지속 OFF·재연결 상태를 별도 권위로 구현해야 함 |
| High / P1 | `SourceStoreProperties.java:10–34`는 기본 disabled, desktop main에 source broker/keyring/safety journal 연결 없음 | 모듈 시험 성공이 설치 앱의 암호화 저장을 뜻하지 않음. legacy 평문 clone, pin/grace/GC, producer/config/dependency fingerprint를 처리해야 함 |
| High / P1 | `GithubNativeOAuthService.java:65,109,175`와 native OAuth 설정은 운영 등록·실 callback/token 교환 검증 없음 | 일반 사용자의 GitHub 로그인·권한 있는 repo 가져오기를 출시 수용하지 못함. 운영 App 유형·등록 및 실권한/만료/취소 테스트 필요 |
| High / P1 | Java/Node pathname 점검 및 합성 lock 시험, `desktop/build/entitlements.mac.plist:5` | 서명된 native descriptor confinement, 프로세스 네트워크/파일 권한 격리·clean Mac standalone 수용을 대체하지 않음 |
| High / P1 | 작은 fixture oracle와 현행 frontend/headless 결과 | 실제 NestJS+React 대형 저장소의 흐름·변경 영향·정확도/abstention/성능, 독립 annotation/holdout·사용자 과제 검증 필요 |
| High / P1 | `desktop/package.json:35–41`, `.github/workflows/ci.yml` | 패키징 설정은 존재하지만 실제 서명/notary/Gatekeeper/update/rollback 완료 증거 없음. 설치 앱과 stage/dist는 이번 작업에서 교체하지 않음 |
| Medium / P2 | 제외 ID만 확인하는 현행 AI 계약 | 포함된 새 block까지 전체 preview identity에 묶는 RequestPlan은 미완료. 근거 링크 수정이 전체 요청 payload의 승인 일치를 보장하지는 않음 |

소스 저장소 연결은 기존 소비자의 이행도 필요하다. `HistoryService.java:145,265`는 프로젝트의
공유 Git clone을 직접 열고, `IdeOpenService.java:49,165`는 원래 로컬 폴더와 HEAD를 사용한다.
`main.cjs:503`의 기존 백업도 repo 디렉터리만 복사한다. 임시 분석 workspace 정리 후 과거
히스토리·원본 폴더를 잃은 경우의 IDE 열기·암호화 source backup을 각각 검증하기 전에는
소스 broker 설정만 켜서 제품 이행 완료로 처리할 수 없다.

대규모 전환은 적용하지 않았다. 백업은 우선 전체 설치 소유 데이터 보존과 명시적 owner
범위 선택, legacy/GitHub 소스까지 보존하는 완전 백업과 별도 metadata export, 복원 후
새 승인 분석과 과거 checkpoint 재개 중 어떤 제품 계약을 채택할지 구분해 기록했다.
선택 전 기존 데이터의 소유권·ID·본문·키·승인을 임의 변환하지 않는다.

최종 명령·실패 이력·artifact SHA와 보존 확인은
[기계 판독 검증 기록](continuation-validation-2026-10-03.json)에 있다. 이 기록의 최종 source
707개는 검증 이후 hash 변경 0이며, frontend 152개와 desktop 456개는 각각 마지막 변경 후
실행한 해당 영역 결과다. 영역별 수를 합산해 제품 정확도나 완료율로 사용하지 않는다.
