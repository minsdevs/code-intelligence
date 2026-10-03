# E2 내용 승인과 worker 입력 결합 — 진행 계약

2026-10-02. 이전 [통합 결과](execution-results-2026-10-02.md)는 완료된 수정 묶음의
체크포인트다. 사용자는 전체 구현의 계속 진행을 명시했다. No-Go는 출시 판단이며
구현을 멈추는 조건이 아니다. 이 문서는 기존 기획20개와 검토된 실행 명세를 바꾸지
않고 다음 수직 기능의 구현 범위를 구체화한다. 현재 구현/독립 검토/회귀는 진행 중이다.

## 의존관계와 실행 분류

| 항목 | 지금 가능한 작업 | 외부 입력이 있어야 가능한 검증 |
|---|---|---|
| E2/T01 승인→worker | 현재 E3 selector 위에 SHA256 manifest, POST preview,10분 일회용 승인, job receipt, 실제 staging 비교, UI와 DB/HTTP 반례 | native picker·hostile ancestor OS confinement은 별도 T01/T03 |
| T02 불변 소스 | additive schema, immutable generation/blob+workspace 계약, broker protocol와 합성 key 암호화 시험, pin/grace/GC·legacy 경로 분리 | 설치된 OS vault·signed helper·clean Mac 인수. 운영 자격증명 없이 코드 개발 가능 |
| T08 strict 비용 | preview의 provider 호출0, fake provider gateway/예약/정산/dispatch journal·복원 불변성 | 실제 유료 호출은 개발 수용에 불필요. 운영 가격/catalog와 실제 계정 수용은 별도 |
| T03/T09 native | helper/stdio/manifest·relocation 검증기와 fault matrix 개발 | Developer ID/notary·signed OS sandbox/설치·실기기 전원 중단·배포 artifact |
| T00b/T04/T10 | runner와 annotation 도구·adapter 반례·공개 corpus 후보 검토 | 독립 사람의 annotation/review, blind holdout, 실제 사용자 과제 |

우선 E2를 현재 local flow 전체(처음 가져오기+기존 project 재분석)에 연결한다.
병렬로 확인된 T08의 구체 결함인 preview→retrieval→summary/embed 호출을 차단한다.
다음은 T02의 source generation/broker 수직 기능이며, 비용 ledger의 product 통합은
해당 source/context 계약과 ADR-02를 지킨다. 새 운영 계정·인증서·보안 권한·유료 API를
사용하거나 설치 앱/userData를 바꾸지 않는다.

## E2 불변 조건

1. 일반 GET source status는 정보 조회이며 승인을 발급/소비하지 않는다. 별도 POST로
   원본을 검사한 결과를 받은 뒤 사용자가 확인해야 한다. 경로 query parameter만으로
   preview 또는 import를 자동 실행하지 않는다.
2. preview는 user, INITIAL/REFRESH, canonical root와 root identity, policy version과
   적용 limits, ordered(path,type,size,raw-content SHA256) manifest에 결합한다. Git blob
   OID를 SHA256라고 바꾸지 않는다. 상대 경로·크기를 모호하지 않게 framing한다.
3. 서버가32byte 난수 token을 발급하고 DB에는 SHA256만 보관한다.10분 만료와 소비
   상태를 서버에서 검사한다. token은 URL/로그/브라우저 저장소/query cache에 넣지 않는다.
4. INITIAL preview는 아직 project/snapshot이 없다. create transaction에서 승인 소비,
   project/job 생성, job별 expected input 복제를 함께 commit한 뒤 worker를 dispatch한다.
   REFRESH는 발급 당시 project/snapshot에 결합하며 null snapshot인 최초 실패 project도
   명시적 새 preview→새 job으로 복구할 수 있다. 같은 project를 다시 만들지 않는다.
5. 소비한 token으로 다른 job을 시작할 수 없다. job별 receipt는 승인 내용을 복제해
   token 정리 후에도 변경되지 않는다. legacy local job에 receipt를 임의로 생성하지 않는다.
6. worker는 receipt의 source를 사용한다. 실제 staging bytes의 manifest를 검증한 뒤에만
   기존 target을 교체한다. staging 검사는 제외 규칙을 다시 적용해 추가 파일을 숨기지
   않는다. source/policy/root/base snapshot 불일치면 publish와 새 snapshot 연결0,
   기존 target/current pointer 유지다. 선택 digest만 비교하고 copy recheck를 생략하지 않는다.
7. relink/delete/new analysis는 같은 project writer 경계를 공유한다. active job 중 relink는
   거부하고, job/receipt 연결은 after-commit dispatch 전에 완료한다. 기존 checkpoint
   IMPORT 완료 retry에는 E1 guard를 유지하며, 다시 IMPORT할 receipt 부재나 입력 불일치는 새 preview를
   요구한다. generic/GitHub pipeline의 의미를 바꾸지 않는다.
8. worker의 승인 실패는 구조화한 `failureCode: LOCAL_PREVIEW_REQUIRED`로 표시한다.
   UI는 generic retry 대신 해당 project의 새 preview 흐름으로 안내한다. HTTP 승인
   오류는409와 안전한 code로 전달한다. source path/token/raw 내용은 오류에 복제하지 않는다.
9.10분 TTL은 아직 소비하지 않은 token에 적용한다. 소비 후에는 만료되지 않는 job별
   불변 receipt가 그 job의 정확한 입력만 승인하므로 queue 지연이나 재시작 때문에
   이미 승인한 같은 바이트를 취소하지 않는다. 다른 job에는 재사용할 수 없다. 소비
   시점의 DB server time을 권위로 두고 issued/expiry의 모순과 역행을 거부한다.
   client 시간 검사는 UX 보조다. worker는 현재 경로 권한을 다시 검사한다.

현재 Java pathname 검사는 native descriptor confinement이 아니다. E2도 이 경계를
확장해서 주장하지 않는다. publish와 DB snapshot 생성의 crash atomicity, immutable
encrypted source, post-check malicious mutation은 T02/T03에서 계속 해결한다.

## API와 UI 방향

- `POST /api/projects/local/preview` `{path,name?}`: INITIAL preview. 정규화한 생성 name도
  초기 승인에 결합한다. 반환은 opaque
  `previewToken`, `expiresAt`, `operation`, safe source label, nullable `snapshotId`,
  change counts/visible selected paths와 count-only import summary다. manifest/root identity는
  서버가 보관하며 client가 주장한 digest로 대체하지 않는다.
- `POST /api/projects/{id}/local-preview`: REFRESH preview. ownership/current source를
  서버에서 읽고 기존 snapshot 또는 명시적인 null baseline에 결합한다.
- `POST /api/projects/local`은 `{path,name,previewToken}`, local reanalyze는
  `{previewToken}`을 사용한다. 과거 count-only 요청은 승인으로 인정하지 않는다.
- `POST /api/projects/local/preview-outcome` `{previewToken}`은 불명 confirmation을
  같은 token row lock 아래 해결한다. 이미 소비했다면 immutable receipt의 정확한
  소유 project/job을 `CONSUMED`로 반환한다. 미소비면 token을 revoke한 transaction이
  commit한 뒤 `ABANDONED`를 반환해 늦게 도착한 원래 요청의 생성을 막는다. receipt의
  token hash는 preview 정리 후에도 유지한다. 이 endpoint는 job/승인을 새로 만들지 않는다.
- UI는 preview 결과를 component memory에 고정해 보여주고 별도 confirmation에서
  token 한 번만 전송한다. path/project/relink/status refresh 변경과 늦은 응답을 구분한다.
  만료/충돌 뒤 자동 새 승인을 받아 즉시 실행하지 않는다. 불명 응답 뒤 자동 mutation
  retry를 하지 않고 위 outcome을 조회한다. outcome 조회까지 실패하면 새 mutation을
  막고 조회만 다시 시도한다. ABANDONED도 새 명시적 preview가 필요하다.
  `bytesRead`는 복사 bytes라고 부르지 않는다.

JSON 명칭은 `previewToken`으로 통일한다. 세부 DTO/SQL은 파일 ownership 확정과 독립 설계 검토 뒤 고정한다. schema는 V22부터
새 migration만 추가하고 V1–V21·기존 notes/tasks를 수정하지 않는다.

## 수용 증거

실제 PostgreSQL/JGit/HTTP로 initial+refresh 정상, 같은 개수·길이의 변경, 다른 파일로
교체, queue 대기 중 변경, root/relink/base 교체, expiry/replay/wrong owner/purpose,
동시 소비 두 건 중 하나만 성공, transaction rollback과 dispatch0, legacy receipt 부재,
copy/staging 변조와 이전 target/pointer 보존을 검증한다. UI는 명시적 preview/confirm,
만료/충돌 재확인, double-click1회, path/project switch의 stale 응답, NO_SNAPSHOT 복구를
검증한다. 기존 실제 source/refresh12개 gate를 새 계약으로 연결하며 baseline은 유지한다.
잠금 대기 중 만료되면 lock 획득 후 별도 문장의 `clock_timestamp()`로 거부한다.
transaction 시작 시각과 lock 대기 전에 평가될 수 있는 SELECT projection은 권위로
쓰지 않는다. 소비한 receipt는10분 이후/재시작/preview 정리 뒤에도 같은 job의 입력을
검증한다. outcome과 confirmation의 두 commit 순서 모두 시험하며, revoke가 먼저면
늦은 confirmation의 project/job/receipt/dispatch 증가는0이어야 한다.

T08 preview의 별도 수용은 missing cache·embedding model 변경·focused file 부재에서도
provider chat/embed 호출0·DB write0이다. 정상 유료 analysis 경로를 이 시험으로 strict
budget 완료라고 하지 않는다. 전체16개 작업의 수용 완료는 여전히0이다.
