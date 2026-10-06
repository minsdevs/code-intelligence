# 현재 구현 단계 — 근거 중심 레포 분석 (2026-10-05)

기존 PRD의 낯선 레포 이해 목표를 구체화한다. 과거 S1 소스 보관 착수 계획은 이미 구현된 snapshot 소스·암호화·복구 기반으로 대체됐다. 이를 재작성하거나 첫 작업으로 반복하지 않는다. 일반 작업은 Astra high 권장, 복잡한 정확도/경합 문제만 xhigh를 제안한다.

## 단계·의존·사용자 완료 기준

| 단계 | 실제 구현 범위 | 의존 | 사용자 관점 완료 기준 |
|---|---|---|---|
| A 첫 사용 | 학습 관리 전용 화면/API/서비스/질문 제거, 분석 메모·검토 보존. 로컬 미리 보기/승인→분석→개요 기본 진입; 영역 선택은 결과 뒤 선택 사항 | 기존 import/소스 계약 | 학습 기능이 제품 경로에 없고 첫 결과를 개요에서 확인. 기존 기록 삭제 없음 |
| B 개요·탐색 | 같은 snapshot ID의 주요 구성/확인된 진입점/기능 링크/분석 시점·범위. 검색·정렬·필터 가능한 파일/심볼/API/패키지/관계/상태 표; 선택 주변 관계와 소스 근거 | A, 기존 graph/files/features/flows API | README 선언·코드 사실·AI 추론과 선언 의존성·실행 사용을 구분. 해당 시점 소스 이동 |
| C 질문 해결 | 기능/진입점→호출·의존 경로, 선택 항목의 역관계 영향 후보, 끊기는 지점/이유 | B | 주요 구성·기능 위치·함께 확인할 코드를 AI 없이 확인. 동명/다른 모듈 오연결 없음. 관계 미발견은 영향 없음이 아님 |
| D 결과 신뢰 | 새 분석에 발견/대상/성공/부분/실패/제외/미지원/미측정 기록. snapshot·소스 상태·재분석 선택/취소/실패 일관성 | 기존 job/analysis, B와 병행 | 목록 수·단계 종료·파서 성공을 구분. 과거 미측정 유지. 실패/취소 후 이전 유효 결과·메모 근거 유지 |
| E 분석 보조 AI | 코드/관계/흐름 설명과 추가 확인 질문, 기존 범위·프롬프트·비용 승인 재사용 | A–C | AI OFF/실패에도 핵심 사용. 레포 문서는 분석 자료이며 명령으로 실행하지 않음 |
| F 맥 앱 | 별도 격리 runtime/profile로 arm64 .app 제작, 실행·분석·탐색·종료·재시작·결과 유지, 첫 결과 지연·대표 큰 입력 화면 실측 | A–E | 터미널로 DB/backend를 켤 필요 없는 .app. 원본 설치 앱/데이터/Keychain 보존. 최소 OS는 실검증 범위만 표시 |
| G 정식 배포 | Developer ID·공증·Gatekeeper·깨끗한 설치·업데이트 데이터 보존·복구 | F + 외부 승인/자격 | 필요한 준비는 완료하되 실제 서명/공증/배포는 승인 후. F 완료와 구분 |

## 구현·검증 경계

**최신 전체 진행 보고:** 제품 A–E 구현과 F 개발용 앱 검증을 배포 수용 완료와 구분한다.
복구 안내 이후 PR92의 nonzero 비용원장 복구, PR93의 인증 갱신·권한 소비자 검증,
통합 보안패치 후보 Imupzt·실제 앱 회귀와 문서 정리를 수행했다. 현재는
[배포 전8단계 진행표](07-delivery-release-gates.md#최신-전체-진행표--보고-기준)의
최종 후보 판정까지 기록했으며 **정식 출시는 No-Go**다. 실제 계정·전체 crash/원장·
독립 정확도/성능/사용성·최소 OS/서명 등의 수용 잔여를 완료로 표시하지 않는다.
상세는 [최신 메타데이터 보정·제어 런타임·후보 검증](../audit/startup-resource-follow-up-2026-10-06.md)을 따른다.

2026-10-06 [Docker 통합 후속](../audit/docker-integration-2026-10-06.md)은 이전 실행환경
차단을 해소하고 기본 backend1639PASS·명시opt-in skip 분리, 실제 인증13/유지보수9,
정확도fixture7/golden23 및 분석기TS222/tree8을 확인했다. 제품 소스와 보존 후보는
변경하지 않았다. 이때 source검토에서 드러난 default-export route 연결은 이후
[React export 바인딩 후속](../audit/react-route-binding-2026-10-06.md)에서 실제선언
참조·미해결 차단·후속 API전파·재분석 연결철회로 보완했다. 새 후보 qUMAST는 Java와
TS분석기를 함께 반영한 당시 후보이며 전체 출시의 독립·실기기·실계정 조건은 여전히 별개다.

최신 후속은 마지막 package-entry 보호 수정을 TS271·실제sidecar/PG12개로 검증하고,
완료 알림 유실을 실제 반례로 재현해 서버 구독 순서와 화면 재조회를 보정했다.
SSE19·backend1665PASS/12명시skip·frontend436·타입/lint·선택desktop212·corpus23을
확인하고 새 후보 j5EJLB를 만들었다. 종료 FAILED를 exit0으로 정상 처리하지 않는
진단 검증도 포함한다. 정확한 후보·native 결과·남은 수용조건은 위 최신 원장을 따른다.

이어 [Electron owner 강제종료 복구](../audit/electron-owner-crash-2026-10-06.md)에서
j5EJLB의 실제 복원 두 경계를 SIGKILL로 중단한 뒤 같은 새 프로필을 복구했다.
소스·메모·암호화 기록 보존과 추가 정상 재시작까지 통과했고 제품 코드는 변경하지
않았다. 이 두 경계의 통과를 전체 crash/전원손실·기존 실사용 데이터 수용으로 확대하지 않는다.

이전 XIWb8X는 백엔드2GiB·제어용64MiB의 최대 Java 힙을 적용했다. 기능36개 및
복원 중SIGKILL 두 경계 각6개가 통과했다. 두 후보의 정상 시작20회 측정에서는
idle RSS가 감소했으나 새 p95 14.106초/최대2030576KiB로 성능 목표는 미충족이다.
배터리 조건·초기 불완전 측정·별도 원인 미확정MANIFEST 실패도 공개하며,
JVM 상한 보정을 출시 준비 완료로 해석하지 않는다.

현재 `69c2ad8`의 tZgvV7는 경량 제어 JAR와 물리 파일 메타데이터 조회 보정을
반영했다. 실제 Electron 합성 재진입 시험에서 기존 Promise 경로는 파일을
디렉터리로20/20 잘못 읽고 원본 Promise 경로는20/20 정확하게 읽었다. 새 후보는
전체 기능36개·정상 종료6회와 복원 중SIGKILL 두 경계 각6개를 통과했다.
이 재현·보정을 모든 과거 시작 오류의 원인 확정이나 정식 출시 승인으로 확대하지
않으며,20회 성능 실측과 미검증 조건은 최신 보고서/해시 원장을 따른다.

이후 PR99를 `ce0322f`로 병합하고 [시작 구간 계측 후속](../audit/startup-phase-breakdown-2026-10-06.md)을
진행했다. 같은 tZgvV7의 새 합성 프로필에서 정상 시작 3회와 종료를 확인하고,
`69337a4`에 백엔드의 소스 준비·프로세스 생성·health 대기·폴더 권한 복원 계측을
추가했다. 기존 회귀 194개가 통과했으나 여유 공간 6.11GiB가 기존 8GiB 기준에
미달해 새 앱은 제작하지 않았다. 당시 제품 소스와 tZgvV7의 구현은 이 계측만큼
다르며, 새 계측의 native 시간과 성능 개선은 미검증이다. 현재 후속 작업 위치는
8단계 No-Go 판정 이후의 5단계 성능 원인 분해와 6단계 새 후보 준비다.

다음 [원장 검증 비용 후속](../audit/journal-replay-performance-2026-10-06.md)은
`85f889e`에서 POSIX 잠금 확인의 세 독립 metadata 조회를 모두 기다리는 병렬
조회로 바꿨다. 기록별 키 조회·잠금 확인·전후 재검증 및 Windows 순차 경로는
유지한다. 실제 native lease 진단의 257기록 관측은 949→784ms이고 영향 회귀41·
새 경합4·진단15개가 통과했다. 단일 관측을 전체 앱 성능으로 확대하지 않는다.
여유 공간 약6.09GiB<8GiB로 새 앱은 미제작이며, tZgvV7에는 이 변경과 앞선
시작 세부 계측이 없다. 현재 수행은 5단계 성능 보완·6단계 패키징 대기다.

최신 사용자 지시에 따라 **원본 로컬 저장소 `/Users/minseokchae/Dev/code-intelligence`(CoS `/code-intelligence`)에서 기능별 브랜치를 만들어 작업한다.** Orca `main-2`와 별도 clone은 사용하지 않는다. 주요 기능의 구현·검증을 마치면 commit → push → PR → merge까지 진행하고 모든 커밋·병합 메시지에 `[skip ci]`를 붙인다. 이전의 잔여 한도 2% 원격 발행 조건은 폐기됐다. GitHub Actions와 정식 서명·공증·배포는 계속 금지하며 보호 규칙을 우회하지 않는다. 과거 `main-2` 또는 `.cos-pre-release-recovery-20261005` 경로는 당시 증거의 출처이며 현재 작업/실행 지시가 아니다. 원본 설치 앱·DB·Keychain/profile·기존 산출물과 사용자 작업을 보존하고 자동 stash/reset/clean은 하지 않는다.

2026-10-05 사용자가 저장공간 확보와 다음 단계 진행을 명시했다. 원본/원격 main `a0b572a` 일치와 약36GiB 여유 공간, 8GiB 사전 검사 통과를 확인한 뒤 원본의 `codex/native-validation-20261005` 브랜치에서 native 검증을 재개했다. 기존 앱·계정 프로필과 과거 실패/성공 증거는 보존한다.

변경 경로와 계약에 맞춘 테스트 및 실제 화면 검증을 수행한다. 대표 Java/TS/JS fixture와 미지원/부분 실패 사례로 snapshot 일치, 동명 분리, AI OFF, 재분석·취소·재시작을 확인한다. 작은 변경마다 전체 빌드·VM·감사를 반복하지 않는다. 검증용 서비스는 소유 범위를 확인하고 종료한다. 대상 레포의 설치·스크립트는 실행하지 않는다.

인계된 과거 호스트 검증은 최초 복원 구간 FAIL, 수정 뒤 남은 복원 구간 PASS였다. 과거 전체 실행 단일 PASS로 바꾸거나 이번 변경의 검증으로 사용하지 않는다. API mock, 브라우저 UI, 실제 DB, 실제 .app 증거를 구분한다.

## 승인과 후속 결정

실계정용 새 자격증명, 유료 호출, 실제 사용자 코드 외부 전송, 사용자 데이터 파기, 서명/배포는 별도 승인 대상이다. 승인된 새 격리 검증 프로필의 합성 자격증명은 실제 사용자 자격증명과 구분한다. 파괴적인 schema 정리는 이관안과 별도 승인 없이 하지 않으며 과거 migration은 수정하지 않는다. 사용자는 저장공간 확보 후 개발 재개와 후속 단계 진행을 승인했다.

정식 배포와 수익화 검토를 구분한다. 마인드맵은 기존 폴더/개요/관계보다 효용이 있는지 사용자 검증 후 결정한다. 언어 확대, PR 비교, 승인 기반 코드 수정, 공식 모델 구독 연결, 앱 유료화는 후속이다. Codex/Claude 연결은 최신 공식 인증/허용 범위 확인 후 별도 진행하며 쿠키/토큰 추출·우회·구독 재판매를 사용하지 않는다. 결제·멀티테넌트 API 플랫폼은 만들지 않는다.

## 2026-10-05 구현 상태와 제한

아래는 단계별 구현 당시의 기록이다. 과거 항목의 ‘자동 refresh 미구현’ 등은 당시
상태이며, 최신 device-origin refresh/CAS 구현과 실제 검증 한계는
[PR93 수명주기 기록](../audit/pre-release-github-lifecycle-2026-10-05.md)과 위 통합
후보 보고를 우선한다. 과거 실패/범위 기록은 삭제하거나 새 PASS로 바꾸지 않는다.

후속 준비 브랜치는 `codex/pre-release-account-stability`다. 계정 설정에서 GitHub 연결·연결 계정·계정 전환·연결 해제를 제공하고 Sidebar에 계정 진입점을 추가했다. OAuth가 미설정이면 원인을 표시하며 로컬 분석은 유지한다. 가져오기와 설정은 같은 device-flow UI를 사용한다. 연결 해제/새 로그인과 이전 인증 응답의 경합에서는 이전 시도가 자격증명을 다시 게시하지 않도록 계정별 세대를 검증한다. 관련 프런트 51개 테스트·타입 검사·변경 파일 lint, 백엔드 OAuth 18개 테스트를 통과했다. 이 결과는 실제 GitHub 계정 인증을 대신하지 않는다.

후속 사용자 승인으로 개발용 GitHub App 등록을 완료했다([01 O1](01-prd.md#6-부모사용자-운영-입력)). Client ID는 사용자의 GitHub 아이디가 아니라 등록된 앱의 공개 식별자이며 secret/PAT/비밀번호를 문서나 대화에 넣지 않는다. 착수 시 기존 OAuth App 범위와 PRD의 GitHub App 계약 차이를 확인해 아래와 같이 보완했다. 자동 갱신·실권한 검증이 남으므로 Client ID를 넣은 것만으로 운영 완료로 표시하지 않는다. GitHub가 요구한 private key는 사용자가 직접 생성·보관했다. 설치 ID `167934276`의 코드·메타데이터 읽기 권한을 확인했고 사용자가 전체 저장소 범위 유지를 명시했다. 에이전트는 키를 열거나 수집하지 않았다. 실제 device 로그인 검증은 별도다.

후속 만료 보정은 native의 broad OAuth scope 전송을 제거하고 GitHub App의 `expires_in`을 검증해 기존 `expires_at`에 저장한다. 발행 직전에도 만료·연결 해제 세대를 재확인한다. 만료/만료 미확인 OAuth는 PAT로 자동 대체하지 않으며 Settings·Sidebar에서 재인증을 안내한다. 로컬 소유 identity는 그대로 두고 `/me`의 유효 연결 종류를 보정해 native 로그인 뒤 저장소 가져오기로 진행할 수 있게 했다. 과거 expiry 없는 OAuth는 재인증 필요로 처리한다. 새 web OAuth도 provider가 제공한 expiry만 저장하며, 자동 refresh·회전은 아직 구현하지 않았다. 기존 schema를 재사용하여 백업 버전을 추가하지 않았다.

`9cfed39`는 공개 Client ID를 desktop package metadata에 포함할 수 있게 하여 Finder 실행에 shell 설정이 필요하지 않도록 했다. 유효 ID가 없으면 GitHub만 비활성화한다. main/runtime 집중 검증 첫 실행에서 115개 중 113개가 통과했고, 기존 두 테스트의 가짜 renderer 이벤트가 현재 origin 검증 계약을 만족하지 못해 실패했다. 보안 검사를 우회하던 fixture를 실제 동일-origin main frame으로 수정한 뒤 실패한 2개가 통과했다. 단일 전체 PASS로 기록하지 않으며 실제 OAuth 인증과 구분한다.

`6771fd6`는 native OAuth에서 설치 계정·조직을 명시적으로 고른 뒤 해당 설치의 저장소를 페이지별로 요청한다. 모든 설치의 저장소를 한꺼번에 요청하지 않으며 PAT/브라우저 목록은 유지한다. 미설치·중지·권한 부족·만료·요청 한도를 구분하고 설치를 바꾸면 이전 저장소/브랜치 선택을 버린다. API 클라이언트 12개와 가져오기 UI 13개 시험, 타입·Java 컴파일·lint를 통과했다. 실계정 설치 목록을 확인한 것은 아니다. `26238ef`는 실제 등록한 개발용 App의 공개 Client ID만 build metadata에 넣었다. 해당 App은 본인 계정만 설치 가능하며 공개 배포 설정은 아니다.

A–E의 제품 경로를 구현했다. 기본 진입은 개요이며 파일·진입점·심볼·manifest 의존성의 검색/정렬/필터, 선택 주변 정적 관계와 snapshot 소스를 연결한다. 기능/흐름/영향 응답도 분석 시점 ID를 유지한다. 새 프로필의 AI 패널은 닫힌 상태로 시작하고, 설명 요청 시 기존 전송 미리보기·승인 경로를 연다. 기존 프로필의 화면 설정은 유지한다. 이전 snapshot의 AI 설명은 현재 결과로 대체하지 않고 지원 제한을 표시한다.

학습 관리 전용 UI/API/서비스와 학습 과제 생성은 제거했다. 분석 메모·개발/검토 작업·저장된 리뷰/실험 기록은 보존한다. 기존 학습 행과 과거 migration은 삭제하지 않았다. 자동 요약·임베딩과 구형 직접 AI 호출이 승인 경로를 우회하지 않도록 차단한다.

V27은 파일별 대상 여부·결과·사유와 snapshot별 발견/제외 수를 추가한다. 이전 결과는 `LEGACY_UNMEASURED`로 남는다. Java 및 TS/JS 파서 결과를 기록하며, tree 분석기가 없는 앱이나 미계측 설정 추출은 성공으로 추정하지 않는다. 동명 Java 선언/endpoint/TS 컴포넌트를 구분할 수 없는 경우 관계를 생략하고 부분 분석 사유를 남긴다. 모든 언어/호출/프레임워크 연결을 해결했다는 의미는 아니다.

백업의 명시적 reviewed schema와 정렬 정책을 V27에 맞췄다. 후속 `e68b882`에서 **정확한 V26 아카이브를 V27 staging에 복원하는 호환 경로**를 추가했다. migration hash·전체 schema·원본 행/footer digest·소유자·소스 검증을 유지하며 과거 파일은 `LEGACY_UNMEASURED / null / false`, 새 측정 테이블은 0행으로 복원한다. export는 V27만 허용한다. V25 이하·알 수 없는 schema·다른 PG major/extension catalog는 계속 거부한다.

백업 policy/payload/postgres/runtime 집중 시험과 암호화 V26 복원·완료 직후 중단 후 복구 시험을 통과했다. 실제 격리 PostgreSQL에서는 구버전 `4d8946c7b18b1cdee4f6f86b1e30fc9d469d923f` exporter/payload writer가 만든 V26 자료를 현재 V27 reader/staging으로 복원했다. FK·trigger·readback, 메모 보존, 파일 미측정 기본값, 측정 0행, Flyway 27개, 원본 payload bytes 불변을 확인했다. 기존 `.app`의 PG 실행 파일은 읽기만 사용했고 새 임시 cluster·포트·TLS를 사용했다. 소유 PG와 임시 디렉터리는 정리했다. 이 시험은 실제 사용자 백업이나 최소 OS/새 기기 업데이트 검증이 아니다.

집중 UI/분석기/백엔드/백업 검증과 타입/컴파일 검사를 수행했다. Docker가 실행 중이지 않아 Testcontainers DB 통합 시험은 컴파일까지만 확인했다. 실제 계정 OAuth, 유료 AI 호출/사용자 코드 외부 전송, 완료와 취소의 동시 경합·강제 실패의 이번 native 재현, 다른 macOS 버전과 깨끗한 Mac 설치는 미검증이다. 기존 깊은 Impact 탐색(5–8단계)의 큰 그래프 성능 한계는 남으며, 새 기본 주변 탐색은 깊이 1과 응답 한도를 사용한다.

### 이번 실제 앱 검증

macOS 26.6.2 (25G83), Apple Silicon에서 `69a02e6`의 ad-hoc 서명 `.app`을 별도 프로필/Keychain으로 실행했다. 실제 내장 DB·backend·TS 분석기를 사용했다. 가져오기 승인→개요→표/관계→보관 소스, 재분석 전후 snapshot, 암호화 소스의 프로세스 재시작, V27 백업·복원·복구 checkpoint, 이전 API 권한 폐기와 삭제 상태 유지가 통과했다. 백업 파일 선택은 검증용 단발 picker 제어이며 네이티브 파일 선택기 수동 조작을 검증한 것은 아니다.

최초 전체 실행은 대표 레포 진입점 표를 잘못 찾는 검증 선택자에서 **FAIL**이었다. 실제 데이터 행은 존재했고, 이름과 파일 경로를 함께 가진 셀에 exact-text 선택자를 사용한 것이 원인이었다. 이 실패 기록을 보존했다. 선택자를 수정한 뒤 동일 보관 결과로 나머지 탐색만 이어간 실행은 **PASS**였다. 실제 진입점 선택, 파일 검색→주변 관계→snapshot 소스, 실제 5단계 flow→소스, 앱 재시작 후 결과 유지를 확인했다. 전체 실행이 처음부터 한 번에 통과한 것으로 해석하지 않는다.

대표 입력은 현재 프로젝트의 desktop/frontend/backend/TS 분석기 소스를 필터링해 가져온 852개 파일(약 7.4MB)이다. 대상 레포의 설치/스크립트는 실행하지 않았다. 승인 클릭→개요 약 55.3초, 이어서 측정한 파일 검색 약 22ms, 선택 관계 표시 약 1.13초였다. 단일 개발 Mac/해당 입력의 측정이며 다른 레포 성능 보장이 아니다. 파일 결과는 성공 156, 부분 610(미해결 호출 592, 모호한 심볼 18), 미측정 85, 미지원 1이었다. 정확도나 완료율로 바꾸어 표현하지 않는다.

최종 UI 수정(`46a3d2f`)은 프런트엔드 정적 자산만 다시 묶은 새 `.app`에서 별도로 확인했다. 첫 추가 검증은 실행 전 스크립트 변수 중복으로 FAIL, 다음 시도는 `CREDENTIALS` 준비 시간 초과로 FAIL이었다. 이를 보존한 뒤 **동일 앱을 재빌드하지 않고**, 기존 고정 `validation` 목적의 새 격리 프로필과 최초와 동일한 정제된 상속 환경으로 실행해 PASS했다. 두 환경 조건이 함께 달라졌으므로 시간 초과를 Keychain ACL 문제로 단정하지 않는다. Keychain ACL 수정/삭제·비밀번호 입력·보안 우회는 하지 않았다.

최종 앱에서 가져오기 직후 Sidebar 갱신, 기본 AI 패널 접힘, 980×700/1280×800/1440×900 화면, 두 함수의 실제 CALLS 관계와 snapshot 소스 이동, 재시작과 정상 종료를 확인했다. 화면도 직접 확인했다. 그래프 중앙 관계 라벨은 노드에 일부 가려질 수 있으며 같은 관계표에서 종류·방향·판정을 읽을 수 있다. 기본 탐색은 표와 선택 주변 관계를 함께 사용한다. 개발 Mac의 검증 버전은 macOS 26.6.2이며 빌드 대상 13.0을 실제 최소 지원 검증으로 취급하지 않는다.

위 제품 개편 검증 당시 로컬 산출물은 `.native-product-tGw4qF/Code Intelligence Validation.app`이다. 아래 후속 계정 검증 앱과 구분해 보존한다. 당시 검증한 프로필로 실행하려면 다음 명령을 사용한다(backend/DB는 앱이 관리). `.app`의 일반 더블클릭과 아래 격리 실행을 동일한 검증 상태로 취급하지 않는다. 프로필은 임시 경로이므로 정식 설치/업데이트 완료물이 아니다.

```sh
rtk proxy open -n '/Users/minseokchae/orca/workspaces/code-intelligence/main-2/.native-product-tGw4qF/Code Intelligence Validation.app' --args '--isolated-run-claim=/private/tmp/civa-9GHRY4/desktop-run-9wNPsx/.isolated-run.json'
```

원본 체크아웃·설치 앱·DB/profile·사용자 Keychain·기존 stage/dist와 보호 디렉터리는 보존했다. 이 앱 검증 시점에는 원격 push/PR/병합/Actions를 실행하지 않았다. V26 백업 호환 후속 결과는 위 별도 기록을 따른다. 정식 배포 전에는 취소/실패 경합·최소 OS·깨끗한 설치/업데이트, Developer ID/공증/Gatekeeper와 운영 연동을 별도로 검증해야 한다. 마인드맵·언어 확대·구독 연결·수익화는 실제 사용자 검증 뒤 판단한다.

마지막 단일 취소 검증에서는 같은 최종 앱/검증 프로필의 소유 입력에만 대표 파일을 추가하고, 실제 preview 승인 후 재분석 job 2가 RUNNING일 때 취소했다. 약 21.7초 뒤 CANCELLED가 되었고 current snapshot 1, 이전 파일 목록과 coverage가 그대로 유지됐다. 재시작 뒤에도 CANCELLED/current snapshot 1과 보관된 두 함수 소스가 유지됐다. 소스 UI의 줄바꿈·마지막 빈줄을 다르게 가정한 검증 matcher FAIL 2건을 보존했고, **취소/재분석을 반복하지 않은 읽기전용 재개**에서 실제 Monaco의 snapshot URI와 각 줄을 확인해 PASS했다. 완료와 취소의 동시 경합·강제 실패 시험을 대신하지 않는다.

최종 앱 옆 `evidence/`에 최초·후속 보고서와 주요 화면을 보존했다: `baseline/`, `final-attempts/`, `final-pass/`, `cancellation/`. 모든 실행을 단일 PASS로 합치지 않는다. 검증 종료 후 소유 앱·내장 서비스·개인 빌드 컴파일러의 잔존 프로세스가 없는 것을 확인했다.

### 계정·백업 후속 앱 검증과 현재 산출물

`6771fd6`을 private source/dependencies/build 경로에서 묶은 `.native-product-NG9NMa/Code Intelligence Validation.app`을 검증했다. 첫 실행은 검증 helper의 새 `control`/`work` 디렉터리가 0755여서 격리 guard가 앱 실행 전에 거부했다. 해당 소유 디렉터리만 0700으로 수정하고 **동일 앱을 재빌드하지 않은 재개**가 PASS했다. `evidence/account-ui-acceptance.json`의 FAIL과 `account-ui-resume.json`의 PASS를 모두 보존했다. Sidebar→계정 설정, LOCAL/미연결/미설정 이유·비활성 로그인, 3가지 창 크기, 로그인 없이 1파일(57B) 가져오기→snapshot 1/SUCCESS 1→보관 소스를 확인했다. 홈까지 약 57.5초(초기 credentials 단계 지연 포함), 가져오기 승인→개요 약 1.14초였으며 대표 대형 입력 성능 시험을 반복한 것은 아니다.

등록한 공개 Client ID만 반영한 `26238ef`는 Java/frontend 재컴파일 없이 별도 `.native-product-e1e4tO/Code Intelligence Validation.app`으로 재패키징하고 ad-hoc 서명을 검증했다. 새 격리 프로필에서 `oauthAvailable=true`, 로그인 버튼 활성화, 미설정 경고 없음이 PASS했다. `evidence/registered-account-ui.json`, `registered-account-980x700.png`를 보존했다. 홈까지 약 19.8초, OAuth start/poll/cancel 요청은 0건이며 실제 로그인·설치 저장소 조회 통과를 의미하지 않는다. 새 검증 앱·내장 서비스는 종료했고 이전 산출물은 보존했다.

현재 계정 기능 검증 앱 실행:

```sh
rtk proxy open -n '/Users/minseokchae/orca/workspaces/code-intelligence/main-2/.native-product-e1e4tO/Code Intelligence Validation.app' --args '--isolated-run-claim=/private/tmp/civa-i21e3J/desktop-run-5mdAr2/.isolated-run.json'
```

등록·사용자 키 생성·설치는 완료했다. 남은 순서는 실제 device 로그인/연결 해제/재연결/권한 철회→자동 토큰 갱신과 회전→최소 OS·깨끗한 설치/업데이트 검증이다. Developer ID·공증·정식 배포는 이번 승인 범위 밖이다. GitHub App 등록은 완료됐으므로 같은 앱을 중복 생성하지 않는다. 키 내용은 수집하지 않는다. 현재 구현은 만료 시 재로그인을 요구하며, 정식 배포 전 모든 게이트가 완료된 상태로 보고하지 않는다.


### 실계정 연결 후 발견한 가져오기 실패

사용자가 실제 device 인증을 완료한 뒤 `.native-product-e1e4tO` 화면에서 `GitHub 연결됨 · ID 154256470`을 확인했다. 사용자가 직접 시작한 GitHub 가져오기는 Import/File inventory/Language-framework/Area detection까지 Done이었으나, `GIT_METADATA` 70%에서 `step 'GIT_METADATA' failed: GitHub pulls request failed`로 실패했다. 따라서 실제 로그인 성공과 전체 가져오기 성공을 구분한다. `9b2deb3`에서 GitHub가 명시한 PR 권한 부족 403만 선택 정보 미수집으로 처리했다. 기존 PR/ETag를 보존하고 snapshot의 GIT_METADATA evidence에 미수집 경고를 기록한다. 커밋 절단 경고도 함께 보존한다. 401·429·일반 403·네트워크 오류는 실패로 유지하며 LOCAL 프로젝트는 토큰 조회 전 외부 PR 요청을 막는다. 회귀 27개와 전체 Java/test 컴파일·포맷 검사를 통과했다. 실제 수정 앱 재시도 결과는 후속 기록을 따른다. 최초 실패 증거를 성공으로 덮어쓰지 않는다.

`eb380a3`은 LOCAL_LINKED 계정에 로컬 프로필 이름 `@local`을 GitHub 이름처럼 표시하던 오류를 수정했다. 확인된 GitHub ID를 표시하며 GITHUB identity의 실제 사용자 이름은 유지한다. Settings 35개 테스트와 프런트 전체 타입 검사를 통과했다. API/schema 변경은 없다.

### 현재 수정 앱과 실제 계정 프로필

두 후속 수정 `9b2deb3`·`eb380a3`를 묶은 앱은 `.native-product-atowzz/Code Intelligence Validation.app`이다. private frontend build·backend bootJar·runtime manifest·ad-hoc 서명 검증이 38.3초에 완료됐고 `evidence/runtime-fix-build.json`을 남겼다.

실제 사용자 조작 중 원래 격리 프로필과 기본 Validation 프로필을 구분해야 하는 상황이 확인됐다. 61473 포트의 초기 실패 화면 뒤 63343 포트의 실패 화면도 확인됐으며, 후자의 main process에는 claim 인수가 없고 renderer 경로는 `~/Library/Application Support/Code Intelligence Validation`이었다. 최초 로그인/실패를 격리 claim만의 증거로 단정하지 않는다. 실제 설치 앱의 `Code Intelligence` 프로필과 구분한다. 기본 Validation 프로필의 파일/자격증명을 열거나 복제·삭제하지 않았다. 같은 프로필을 유지해 실행 파일을 교체하는 후속 절차를 진행했다.

교체는 `.native-product-e1e4tO/Code Intelligence Validation.app`에 수정본을 넣고 이전본을 같은 디렉터리 `Code Intelligence Validation.before-eb380a3.app`로 보존했다. `evidence/runtime-fix-replacement.json`은 교체·실행 요청 근거다. 이후 실제 UI(64052)에서 Ready, LOCAL_LINKED/Connected, `GitHub ID 154256470`, 설치 `minsdevs · code-intelligence-dev-minsdevs`와 private 저장소 목록을 확인했다. 재로그인 없이 계정이 유지됐고 @local 표시 수정도 실제 화면에서 통과했다. 앱은 사용자 확인용으로 실행 상태를 유지한다.

**실제 재분석은 미완료다.** 기존 실패 project 1(`minsdevs/code-intelligence`)은 목록에서 ANALYZING, 개요에는 완료 결과 없음으로 남았다. 이전 Retry는 checkpoint source 변경/검증 불가를 표시했고, 새 가져오기는 `This repository is already imported.`로 거부됐다. 기존 GitHub 프로젝트를 화면에서 새 분석으로 복구하는 경로가 부족하다. 데이터를 삭제하거나 API로 UI를 우회하지 않았다. 한도 2% 종료 지시에 따라 새 복구 UI 구현은 다음 세션 첫 단위로 남긴다. PR 권한 오류 수정의 단위 검증 PASS를 실제 가져오기 종단 성공으로 해석하지 않는다.

### 2026-10-05 GitHub 기록 기반 독립 복구 작업

사용자가 기존 Orca 작업공간 사용을 철회하여 GitHub에서 새 독립 clone을 만들었다. PR #84가 `279fb69`까지의 준비 작업을 `a352290`으로 병합한 것을 실제 GitHub에서 확인했다. 새 작업본/브랜치와 상세 결과는 [GitHub 실패 프로젝트 복구 기록](../audit/github-project-recovery-2026-10-05.md)에 있다.

기존 GitHub 프로젝트의 새 분석 시작 UI, 최신 job 기반 상태 표시, checkpoint 검증 불가 안내, 중복 가져오기의 기존 프로젝트 이동을 구현했다. 시작 요청 유실과 POST 전 준비 실패, 같은 작업의 다른 창 재시도, SSE 정상 종료도 처리한다. 완료 결과 보관 개수 제한이 실패 snapshot/job/step을 자동 삭제하지 않도록 READY 결과에만 적용했다. schema/migration 및 V27/V26 백업 계약 변경은 없다.

후속 프런트엔드 전체 370개·타입 검사, 백엔드 전체 컴파일·bootJar·포맷 검사가 통과했다. 선택 백엔드 시험 18개는 통과했고 2개는 Docker 미실행으로 실패했다. 실제 PG/Redis/Spring/Chromium의 새 실행은 30개 확인 PASS이며 기존 프로젝트 UI 새 분석으로 GIT_METADATA 이후 DONE, 두 차례 새 분석 뒤 첫 실패 증거 보존과 DELETE 0회를 확인했다. GitHub는 합성 fixture이며 사용자의 실계정 project 1 완료 검증이 아니다. 첫 브랜치 선택자 오류 FAIL과 후속 PASS, 중간 시험 실패도 별도로 보존한다. 자세한 입력 fingerprint·종료 결과·잔여 범위는 위 복구 기록을 따른다.

내부 복구 링크의 문서 재요청과 늦은 retry/cancel 응답의 상태 역행을 추가로 재현·수정했다. 최종 `frontend-reviewed-final.json`도 38파일/370개 PASS이며 GitHub/메타데이터 집중 백엔드 17개와 Spotless가 통과했다. 별도 `verify.cjs`의 `browser-l94ivS/result.json`은 실제 JAR·DB·브라우저에서 12개 확인 PASS다. 같은 합성 프로젝트를 UI로 세 차례 새 분석하여 GIT_METADATA/FINALIZE 완료, 원래 실패 job/step·메모 보존, READY 결과 2개 보관을 확인했다. `api-faT5EM` 준비 단계 FAIL과 `api-XtGfYA` API 9개 PASS도 별도로 보존했다. 이는 실계정·설치 앱 검증을 대신하지 않으며 각 실행에서 소유 서비스 종료를 확인했다.

새 native stage는 PostgreSQL 및 관련 라이브러리의 최소 OS 26.0과 고정 macOS 13.0 정책이 충돌해 차단됐다. 패키지/정책을 완화해 배포 성공으로 처리하지 않았다. standalone 실제 서비스 시험은 배포 앱 검증과 구분한다. 기존 실계정 project 1에 이번 수정으로 재분석 완료를 확인한 상태가 아니며, 정식 배포 준비도 미완료다.

### 2026-10-05 후속 런타임 소스 준비

기존 `native-acceptance-macos.sh`의 macOS13 소스 빌드 경로를 재사용하고 OpenSSL3.5.8·PostgreSQL16.15·Redis8.10.2·pgvector0.8.7 입력을 URL/해시로 고정했다. 초기 디스크 사전 검사, curl 전송 크기 제한 지원 확인, 실패 archive 보존과 license/lock 동봉 경로를 추가했다. 집중64개 시험이 통과했으며 실제 사전 검사는 남은 공간 약1.17GiB로 `MAC_BUILD_DISK_SPACE`를 반환했다. 8GiB는 보수적 여유공간 기준이지 앱 크기 측정값이 아니다. 이번에는 전체 런타임 소스 빌드·새 앱 실행을 수행하지 않았다. 상세 기록은 [macOS 런타임 소스 준비](../audit/macos-runtime-supply-2026-10-05.md)에 있다.

pgvector 버전 변경 시 기존 DB와 이전 V26/V27 백업의 exact extension catalog hash가 달라질 수 있다. 현재 시작 경로에 기존 extension UPDATE는 없고 V26→V27 schema 지원도 extension 버전 변환은 아니다. 따라서 새 격리 검증 프로필로 빌드/실행을 먼저 확인하고, extension·이전 백업·locale 호환 fixture를 검증한 뒤 실계정 프로필 적용을 판단한다. 원본 DB를 자동 갱신하거나 hash 검사를 완화하지 않는다.

### 원본 복귀·기능별 반영·중복 정리

복구 기능은 원본에서 `4689176`으로 커밋·푸시한 뒤 PR #85로 병합됐다(merge `7fb5ea0`). 남은 런타임 준비 7개 파일과 문서 5개도 원본에 반영했고, 최초 전송 목록 40개 모두 기존 검증본과 바이트 단위로 일치함을 확인했다. 런타임 준비 코드 커밋은 `695424c`이며 별도의 `codex/macos-runtime-supply-20261005` 브랜치를 사용한다. 현재 원격 병합 상태는 GitHub/실제 git으로 확인한다.

사용자의 명시적 정리 요청에 따라 불필요한 독립 clone과 중복 Gradle/npm 입력·host build 사본·종료된 합성 시험 DB/프로필·서비스 사본을 삭제했다. 실패/성공 보고서·화면·로그 등 182개 파일(3,286,605 bytes)은 원본 `validation/local/`로 옮기고 삭제 전후 해시를 대조했다. 원본 앱/DB/Keychain/기존 의존성은 정리 대상이 아니다. 측정된 여유 공간 증가는 3,512,872,960 bytes이며 사용 중인 시스템의 여유 공간은 변동할 수 있다. 과거 보고서의 삭제된 작업 디렉터리·DB 경로는 역사적 기록이며 재실행 대상으로 사용하지 않는다. 새 시험은 재개 승인 후 새 입력과 run을 준비한다.

### 원본에서 실제 native 빌드·격리 자동화 재개

사용자의 저장공간 확보 통보 뒤 고정 source 빌드·native gate·runtime stage·ad-hoc `.app` 제작을 실제로 완료했다. 실제 host는 macOS26.6.2이고 바이너리의 목표는13.0이다. 앱은 원본 `.native-product-yGBKOK/Code Intelligence Validation.app`이며 같은 앱으로 후속 시험을 진행했다. standalone Keychain probe를 `Code Intelligence Acceptance` 이름으로 맞추고 관련65개 회귀를 통과했다.

첫 packaged 자동화는 재분석 후 보관 소스 화면 검사에서 FAIL이었다. 같은 앱·같은 격리 프로필의 읽기전용 재개는 current2 READY/job DONE, old1/41 및 new2/42의 본문·URI를 확인해 PASS했다. native helper에서 전달 snapshot을 콤보로 명시 선택하도록 수정한 뒤 앱 재빌드 없이 새 격리 프로필의 전체 자동화가203,433ms에 PASS(반복 시작검사 포함31개 체크 기록)했다. 최초FAIL·읽기전용재개·전체재검증은 `validation/local/native-validation-20261005/`에 각각 보존한다.

새 런타임의 V27 백업·복원·복구checkpoint·구API권한폐기·재시작·대표867파일/7,571,029bytes 분석·검색·관계·5단계 흐름의 보관 소스 이동·정상 종료가 통과했다. 대표 입력의 개요까지57,414ms, 결과 SUCCESS161/PARTIAL618/UNMEASURED87/UNSUPPORTED1이다. 모두 같은 호스트/입력의 측정이며 정확도나 전체 지원률로 환산하지 않는다. 화면도 직접 확인했다.

직접 Electron probe의 실제 Keychain PASS와 Playwright의 `--use-mock-keychain` 제품 자동화 PASS를 구분한다. 자동화 claim `/private/tmp/civa-j0lCXC/desktop-run-n2pYEv/.isolated-run.json`은 그 조건의 재개 증거이며 일반 `open`으로 그대로 재사용하지 않는다. 기존 Validation 프로필을 열 수 있는 단순 더블클릭도 현재 검증 범위가 아니다. 다음은 새 수동용 격리 프로필의 실제 packaged Keychain, 이전 pgvector/V26·V27 백업·locale 호환성, 이후 실계정 프로젝트 복구다. 정식 배포 준비는 미완료다. 상세 증거·빌드 fingerprint는 [런타임 후속 기록](../audit/macos-runtime-supply-2026-10-05.md)을 따른다.

후속 정리에서 이번 Gradle daemon을 종료하고 중복 임시 소스/의존성·캐시·C 빌드 트리/압축파일12개 경로를 삭제했다. 앱과 검증 증거는 해시를 보존했고 약2.77GiB를 회수했다. 최종 앱, 실제 소스빌드 prefix(약64MiB), 두 자동화 프로필과 합성 입력/백업은 후속 호환성 시험을 위해 유지한다. 원본 의존성·실계정 자료를 삭제하지 않았다. `.native-product-*`는 로컬 산출물로 Git에서 제외한다.

### 실제 packaged Keychain·백업 버전 후속 검증

PR #87 merge `2b5a98d` 뒤 원본 `codex/packaged-keychain-compatibility-20261005`에서 진행했다. 보존 `.native-product-yGBKOK/Code Intelligence Validation.app`을 직접 실행하고 그 소유 PID의 loopback CDP에 연결해 Playwright Electron loader/mock-keychain 없이 새 Acceptance 프로필을 검증했다. 첫 연결단계 FAIL과 두 후속 PASS를 각각 보존했다. 최종 `validation/local/packaged-keychain/run-RGWnsP/result.json`은 두 번의 실제 실행·local 인증·암호문 불변·분석 결과와 snapshot 소스 유지, 종료코드0/신호0를 확인했다. 앱 manifest/asar/실행파일 불변이며 재빌드하지 않았다. 종료 실패·무기한 CDP 대기 방지 회귀12개도 PASS다. Keychain 키/실계정 자격증명은 열지 않았다.

별도 실제 PostgreSQL/TLS fixture에서 동일 pgvector0.8.7의 V27 복원과 역사적 V26→V27 복원, 구0.8.1 SQL 정의/new0.8.7 binary 상태에서 만든 V27 백업의 `BACKUP_PG_SCHEMA` 거부와 source/target 행 불변을 확인했다. fixture에서 명시적 extension UPDATE 뒤 만든 새 백업은 복원됐지만 UPDATE 전 백업은 계속 거부됐다. 이 결과는 구 binary/물리 DB·인덱스 업그레이드나 기존 archive 자동 변환을 증명하지 않는다. C→en_US.UTF-8도 작은 fixture에서 복원됐으나 locale fingerprint가 없는 현재 계약을 보완하는 호환 보증은 아니다.

이 시점의 다음 차단 단위는 **기존 확장 버전의 구 백업 변환/사전 호환 검사와 앱의 암호화 복원·복구 수명주기**였다. 당시 앱은 maintenance seal 뒤 typed DB load를 하므로 거부가 복구 필요 상태를 남길 수 있었다. 이후 사전 거부 구현과 남은 제약은 아래 최신 기록을 따른다. 기존 백업의 자동 변환과 실계정 profile 적용을 완료한 것으로 해석하지 않는다.

### 복원 전 호환성 검사와 후속 정상 복원

원본 `codex/restore-compatibility-preflight-20261005`에서 PR #88 병합 `8d5f398` 이후 구현했다. 인증된 암호화 백업의 전체 payload 검사 후, 유지보수 시작 전에 실제 pinned migrations로 별도 probe DB의 V26/V27 catalog를 계산해 소유자와 비교한다. 정상 probe 정리 후 live identity와 payload inode/hash를 재확인하며 실제 load도 기존 검사를 반복한다. 정확한 호환 거부만 `BACKUP_INCOMPATIBLE` 고정 결과로 화면에 전달하고, 비용원장·기존 데이터 변경 없이 정상 사용을 유지한다. 실제 load 이후 실패에 필요한 recovery-required 계약은 유지한다.

새 검증 앱은 `.native-product-wXqDvU/Code Intelligence Validation.app`이다. 기존 `yGBKOK` 앱과 검증된 C runtime/Java 코드는 보존·재사용했으며 현재 desktop/src 및 frontend static 자산을 반영했다. `build-41XPbn/build.json`의 제품4개 해시, native report의 app.asar/manifest 해시를 최종 코드와 다시 대조했다. 최종 제품 집중시험337 PASS/4 native opt-in SKIP, Settings38 PASS, TypeScript noEmit·변경 frontend ESLint가 통과했다.

새 PostgreSQL/TLS matrix의 최종 `validation/local/backup-compatibility-VjdhHc/report.json`은10/10 PASS다. 원본 prefix/vector hash 불변, probe 부재, 소유 PostgreSQL exit0/포트닫힘을 확인했다. 별도 native 최초 `native-j08bk9`와 `native-RcDzlZ` FAIL, 후속 `native-Y6flRA` PASS를 각각 보존한다. 마지막 검토에서 검증기의 미보호 CDP/response 대기만 기존 deadline으로 감싼 뒤 같은 앱을 재빌드하지 않고 새 empty fixture로 재실행한 `validation/local/restore-preflight/native-jGteM6/result.json`도 PASS다. UI 백업1 생성→인증된 비호환 archive 거부→UI 재분석92/snapshot2→정상 백업 복원91/snapshot1→재시작 유지로 no-op과 실제 복원을 구별한다. 최종 두 앱 PID는 exit0/signal없음이다.

이 native 시험은 Playwright mock-Keychain, 단발 picker 제어, 새 합성 프로필의 암호화 fixture다. 실제 사용자의 구백업/DB 또는 real-Keychain 검증으로 확대하지 않는다. CREATE 응답유실·probe cleanup 실패에서는 추정 삭제하지 않아 잔여 DB가 남을 수 있으며 자동 회수/상세 진단은 후속 운영 과제다. probe 이후 발생한 상태변경·복원 실패가 모두 무변경 거부로 끝나는 것도 아니다. 구 pgvector archive 자동 변환, physical index/locale/ICU 업그레이드는 여전히 미완료다.

검증 종료 후 이번 임시 빌드 사본과 종료된 matrix DB/runtime/legacy-source/TLS17개 경로만 정리했다. 보고서·화면·로그·typed/encrypted payload214개는 삭제 전후 해시가 일치한다. 두 보존 앱, 기존 source prefix, 기존 사용자 자료와 최종 native 프로필은 유지했다. 상세 기록은 `validation/local/restore-preflight/cleanup.json` 및 런타임 audit를 따른다.

배포 직전 전체 순서는 [07 §5](07-delivery-release-gates.md#5-현재-구현에서-배포-직전까지의-실행-순서)의8단계다. 다음 구현·검증은 복원 도중 강제실패/중단·재시작, 정상종료 실패 전달과 기존 DB/백업 적용·되돌리기 정책이다. 기존 profile 적용 조건을 확인한 뒤 실제 project1 복구, OAuth 연결/철회/갱신, 작업 경합·성능/보안/사용성, 최소OS·새 설치/업데이트와 운영 준비를 진행한다. 개별 native PASS를 정식 출시 gate 전체 PASS로 올리지 않는다.

### 다음 AI 세션에 전달할 프롬프트

> Code Intelligence 정식 배포 전 준비를 이어서 수행하라. 사용자는 배포 직전까지의 전체 설명과 다음 작업 진행을 승인했다. native 빌드·실제 packaged Keychain·백업 버전 matrix 이후 **복원 사전 호환 거부와 후속 정상 복원**까지 구현·검증했다. **작업은 원본 `/Users/minseokchae/Dev/code-intelligence`(CoS `/code-intelligence`)의 기능별 브랜치에서만 한다.** Orca `main-2`와 삭제된 `.cos-pre-release-recovery-20261005`를 사용하거나 clone을 다시 만들지 마라. PR #85–88 및 `codex/restore-compatibility-preflight-20261005`의 후속 commit/PR/merge를 실제 GitHub·git으로 확인한다. 이 문서와 런타임 audit/JSON·07 §5·01-prd.md·사용자 프롬프트를 읽고 현재 git status를 확인하라. 기존 앱/DB/profile/Keychain·사용자 코드·미추적 자료를 보존한다. 셸은 rtk, codebase-memory 그래프는 최신 소스와 교차 확인한다. 자동 stash/reset/clean, Actions, 유료 AI, 정식 서명/공증/배포는 금지다.
>
> 기존 GitHub App `Code Intelligence Dev minsdevs`(App ID 5189413, 공개 Client ID `Iv23licOyolwwPyDe1JY`), 설치 167934276을 유지한다. 중복 등록·private key 생성/열람/수집/복사·번들 삽입을 하지 마라. 사용자가 명시한 전체 저장소 읽기 선택을 유지한다. 과거 실계정 로그인은 성공했지만 최초 가져오기는 GIT_METADATA에서 실패했고 이번 수정의 실계정 종단 성공과는 별개다. 기본 Validation 프로필을 과거 격리 claim과 동일시하거나 임의 복제/변경하지 마라.
>
> 실패 프로젝트 복구 UI와 복원 사전검사를 재구현하지 말라. GitHub 합성 fixture PASS를 실계정 project1 완료로 해석하지 마라. 최신 제품 수정 앱은 `.native-product-wXqDvU/Code Intelligence Validation.app`이며 이전 `yGBKOK`도 보존한다. `validation/local/restore-preflight/`의 build-41XPbn, 최초 두 native FAIL, Y6flRA PASS, 최종 jGteM6 PASS 및 unit-Hrcr0x 최종시험을 구분하라. jGteM6의 driver SHA256은 de803bb3f8452b2ad75f2ee64504135105346216ae2c6420f76ed944e4797b9a이며 같은 앱·새 mock-Keychain fixture로4개 핵심 확인을 통과했다. 제품4개 build hash/app.asar/manifest 대조와337 PASS/4 SKIP 및 Settings38 PASS를 기록했다. 최종 PG matrix VjdhHc는10항목 PASS다. 이전 실제 Keychain run-RGWnsP는 yGBKOK의 별도 증거이며 새 앱 또는 mock 프로필의 증거로 합치지 마라. **다음은 복원 중 강제실패/중단·재시작, 정상종료 실패의 정확한 전달, 구 DB/백업 적용·되돌리기 정책**이다. 비호환 사전 거부는 구현됐지만 구 archive 자동 변환·구 binary/physical index·locale/ICU 호환은 미완료다. probe cleanup/CREATE 응답유실은 잔여 DB를 추정 삭제하지 않으며 자동회수는 없다. 실제 load 재검사 후 실패는 recovery-required를 유지한다. 기존 profile 적용 조건 확인 후에만 실제 project1의 UI 재분석을 GIT_METADATA 이후 DONE까지 진행하라. 계정 연결/해제/재연결/철회·refresh 저장/갱신/회전, 완료/취소 경합, 실제 최소OS·새설치/업데이트는 별도 미완료다. schema 변경 시 V27 백업 계약을 검토한다.
>
> 주요 기능의 구현·검증이 끝날 때마다 문서를 갱신하고 원본 기능 브랜치에서 commit → push → PR → merge를 수행하라. 잔여 한도 2%를 기다리지 않는다. 모든 커밋과 병합 메시지에 `[skip ci]`를 붙이고 보호 규칙을 우회하지 않는다. Actions 금지와 필수 검사 충돌이 생기면 차단 사유를 남긴다. 기능 단위의 완료와 정식 배포 준비 전체의 완료를 구분한다.
>
> 추가 빌드가 필요한 경우에만 디스크 사전 검사 후 실행하라. 보존 앱을 우선 사용하고 host 전체 재실행·동일 source/dependency 재빌드를 피하라. 임시 `.restore-preflight-build-7WuXGI`와 두 최신 PG matrix의 DB/runtime/legacy-source/TLS 사본은 종료/미사용 확인 후 삭제했으며 보고서·payload·화면·로그214개를 보존했다. 삭제된 경로를 재실행 대상으로 쓰지 마라. 최종 native claim `/private/tmp/cirp-voXvgj/desktop-run-8cbj7P/.isolated-run.json`은 mock-Keychain 전용이며 일반 실행에 재사용하지 않는다. 최소OS gate·catalog/hash/소유권 검사를 완화하거나 원본 실계정 DB·프로필·GitHub App 키를 임의 변경·열람하지 않는다.
