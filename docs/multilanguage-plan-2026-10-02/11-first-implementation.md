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

작업은 `/Users/minseokchae/orca/workspaces/code-intelligence/main-2`의 main 기반 목적 브랜치에서만 한다. 원본 체크아웃·설치 앱·원본 DB·기존 Keychain/profile·`.repowise/`·기존 `.native-stage-proof-*`·공유 의존성·기존 stage/dist를 보존한다. rtk로 셸 명령을 실행하고 자동 stash/reset/clean은 하지 않는다. 문서와 구현을 작은 커밋으로 구분하고 `[skip ci]`를 붙인다. GitHub Actions는 실행하지 않는다. 2026-10-05 사용자 후속 지시로 정식 배포 전 준비까지 범위를 확대했다. Codex 잔여 한도가 2% 이하가 되면 진행 중인 단위를 완료하고 Markdown 현황·다음 세션 프롬프트를 정리한 뒤 별도 브랜치 commit/push/PR/merge까지 진행하도록 조건부 승인받았다. 이 조건 전 원격 발행과 정식 배포는 수행하지 않는다.

변경 경로와 계약에 맞춘 테스트 및 실제 화면 검증을 수행한다. 대표 Java/TS/JS fixture와 미지원/부분 실패 사례로 snapshot 일치, 동명 분리, AI OFF, 재분석·취소·재시작을 확인한다. 작은 변경마다 전체 빌드·VM·감사를 반복하지 않는다. 검증용 서비스는 소유 범위를 확인하고 종료한다. 대상 레포의 설치·스크립트는 실행하지 않는다.

인계된 과거 호스트 검증은 최초 복원 구간 FAIL, 수정 뒤 남은 복원 구간 PASS였다. 과거 전체 실행 단일 PASS로 바꾸거나 이번 변경의 검증으로 사용하지 않는다. API mock, 브라우저 UI, 실제 DB, 실제 .app 증거를 구분한다.

## 승인과 후속 결정

로컬 구현·격리 검증은 계속 진행한다. 새 자격증명, 유료 호출, 실제 사용자 코드 외부 전송, 데이터 파기, 서명/배포는 직전 승인 대상이다. 파괴적인 schema 정리는 이관안과 별도 승인 없이 하지 않으며 과거 migration은 수정하지 않는다.

정식 배포와 수익화 검토를 구분한다. 마인드맵은 기존 폴더/개요/관계보다 효용이 있는지 사용자 검증 후 결정한다. 언어 확대, PR 비교, 승인 기반 코드 수정, 공식 모델 구독 연결, 앱 유료화는 후속이다. Codex/Claude 연결은 최신 공식 인증/허용 범위 확인 후 별도 진행하며 쿠키/토큰 추출·우회·구독 재판매를 사용하지 않는다. 결제·멀티테넌트 API 플랫폼은 만들지 않는다.

## 2026-10-05 구현 상태와 제한

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

### 다음 AI 세션에 전달할 프롬프트

> Code Intelligence 정식 배포 전 준비를 이어서 수행하라. 먼저 이 문서의 구현 상태와 검증 경계, 01-prd.md의 실제 GitHub App 등록 정보를 읽고 현재 git 상태를 확인하라. 작업 체크아웃은 `/Users/minseokchae/orca/workspaces/code-intelligence/main-2`, 준비 브랜치는 `codex/pre-release-account-stability`다. 등록 ID 반영 구현은 `26238ef`이며 이후 문서 커밋/원격 병합 상태는 실제 git으로 확인하라. `/Users/minseokchae/Dev/code-intelligence`, 원본 설치 앱/DB/profile/Keychain, 기존 산출물과 추적되지 않은 파일은 보존한다. 셸은 rtk를 사용하고, codebase-memory 그래프를 먼저 활용한다. 자동 stash/reset/clean, GitHub Actions, 유료 AI 호출, 정식 서명/공증/배포는 하지 않는다. 커밋에는 `[skip ci]`를 붙인다.
>
> 실제 등록된 GitHub App은 `Code Intelligence Dev minsdevs`(App ID 5189413, 공개 Client ID `Iv23licOyolwwPyDe1JY`), 설치 ID는 167934276이다. 중복 등록하지 마라. 사용자가 private key를 직접 생성·보관했고 전체 저장소 읽기 유지를 명시했다. 키 파일/내용은 열거나 수집하지 말고 앱에 넣지 마라. 등록과 설치는 실제 OAuth 로그인 성공을 뜻하지 않는다. 최신 실계정 검증 상태는 이 문서의 후속 기록과 사용자 응답을 확인하라.
>
> 현재 수정 빌드 원본은 `.native-product-atowzz/Code Intelligence Validation.app`이며 교체 실행 대상은 `.native-product-e1e4tO/Code Intelligence Validation.app`이다. 실계정 프로필은 위 후속 기록을 먼저 확인하고 임의 복제/변경하지 마라. 이전 격리 claim은 `/private/tmp/civa-i21e3J/desktop-run-5mdAr2/.isolated-run.json`이다. 위 실행 명령으로 열되 원본 앱/프로필을 사용하지 마라. 최초 FAIL과 후속 PASS를 합치지 말고 기존 evidence를 보존하라. 최소 OS/새 기기와 Developer ID 검증은 미완료다. 현재 OAuth는 만료 시 재로그인을 요구하며 refresh token 저장·자동 갱신·회전은 아직 없다. **첫 작업은 기존 실패 GitHub project 1을 삭제하지 않고 새 분석으로 복구하는 UI를 제공하고, 실제 재분석에서 GIT_METADATA 이후 완료까지 검증하는 것이다.** checkpoint source 오류/중복 import/ANALYZING 잔류 상태를 함께 확인하라. 이후 실계정 연결/해제/재연결/권한 철회, 자동 갱신, 완료·취소 경합/강제 실패, 최소 OS·새 설치/업데이트 검증 순으로 범위를 나눠 진행하라. 테스트·실제 DB·실제 앱·실계정 증거를 구분하라. 새 기능에 schema 변경이 필요하면 V27 백업 호환 계약도 함께 검토하라.
>
> 이번 세션은 Codex 잔여 2%에 도달해 진행 중인 가져오기/계정 표시 수정과 인계를 마무리했다. 다음 세션도 사용자 지시대로 Codex 잔여 한도가 2% 이하가 되면 진행 중인 단위까지만 마치고 기존 Markdown과 이 프롬프트를 갱신한 후 별도 브랜치 commit/push/PR/merge로 마무리하라. 해당 조건 전 원격 발행은 하지 않는다. 병합은 보호 규칙을 우회하지 않고, GitHub Actions 금지와 충돌하면 차단 사유를 남긴다. 정식 배포 준비 전체가 끝나지 않았으면 완료라고 보고하지 마라.
