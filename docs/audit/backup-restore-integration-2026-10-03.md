# 백업·복원 통합 감사 — 2026-10-03

**일반 사용자 대상 출시는 No-Go다.** 이번 변경은 format3 암호화 백업과 검증된
데이터만 적재하는 복원 경로를 실제 Electron main에 연결한다. 운영 설치·서명·전원 장애
복구의 수용을 뜻하지 않는다. 아래 검증 결과와 남은 차단점을 함께 판단해야 한다.

저장소 `/Users/minseokchae/Dev/code-intelligence`, branch `codex/e2e-docs-scripts`,
HEAD `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`에서 기존 미커밋 변경을 보존했다.
실제 구조는 Electron main/preload → loopback Spring Boot/Java 21 → PostgreSQL/pgvector,
Redis, React/Vite 및 NestJS/TypeScript 분석 sidecar다. Flyway는 V1–V25다.
다른 저장소를 추정하거나 스택을 전면 교체하지 않았다.

## 실제 연결한 동작

- 새 runtime manifest의 `backupProtocol: 3`과 묶인 코드·JAR·migration을 사용한다.
  이전 bundle은 백업·복원 진입점을 계속 거부한다. native dialog가 선택한 경로만 받으며
  renderer가 보내는 DB 이름·SQL·키·소스 경로·복구 명령을 실행하지 않는다.
- backend의 HTTP·비동기 AI·job admission을 먼저 막고 실제 실행 중 작업의 종료를
  기다린다. AI gateway도 새 전송/과거 승인을 차단하고 정산을 마칠 때까지 기다린다.
  backend/analyzer 종료 후 PG job 상태를 다시 확인한다.
- main이 소유한 PostgreSQL 프로세스의 PID, `postmaster.pid`, canonical data directory,
  system identifier 및 시작 시각을 검사한다. 임시 포트에 다른 서버가 응답하는 것만으로
  준비 완료로 인정하지 않는다. 모든 psql은 사용자 startup script를 비활성화한다.
- 52 table / 439 column의 실제 catalog와 25 migration 해시를 확인한다. repeatable-read
  export와 정밀한 bigint/NUMERIC/JSONB codec을 사용한다. SQL NULL과 JSON null도 구분한다.
  자격증명·원본 폴더 경로·이전 승인·세션은 복원 권위로 가져오지 않는다.
- Git 소스는 고정 JAR helper가 필요한 object와 근거를 검증해 내보낸다. clone config,
  hooks, 원격 URL, 임의 실행 파일·프로세스는 백업 명령으로 재사용하지 않는다.
  retained source는 기존 source-vault ciphertext와 key ID를 검증하며 새 키로 바꾸지 않는다.
  DB가 요구한 소스가 하나라도 누락되면 전체 백업을 실패시킨다.
- typed payload의 행·소스 수와 hash, 종료 프레임 및 EOF까지 확인한 뒤 목적지의 새
  private directory에 AEAD 암호화 archive를 발행한다. 같은 설치의 보존된 backup key가
  필요하며 key 자체를 archive에 넣지 않는다.
- 복원 입력은 private staging으로 제한 복사하고 전체 AEAD/payload/DB-source closure를
  검증한다. 임의 dump SQL을 실행하지 않는다. 새 staging DB는 묶인 migration만 실행하고,
  현재 owner ID·sequence·preference revision보다 과거로 되돌아가지 않게 적재한다.
- 안전 원장 B는 일반 데이터 A 밖에 둔다. 현재/과거 비용 의무는 B에서 보수적으로 합치고,
  검증된 PG 상태와 payload hash를 seal한다. V25 재무 테이블을 archive의 권위로 적재하지
  않고 B를 기준으로 staging projection을 다시 만든다. AI는 OFF를 유지한다.
- DB OID와 소스 directory의 device/inode를 고정한 뒤 기존 이미지와 새 이미지를 모두
  보존하며 교체한다. 실패 시 실제 자식 종료를 확인한 뒤 동일 식별자만 롤백한다.
  B와 비용 의무는 롤백하지 않는다. 복구 기록은 별도 backup key로 암호화해 fsync한다.
- 복원/롤백 시 GitHub·AI credential row, 로컬 승인과 재시도 입력을 폐기한다. Redis를
  새 디렉터리로 시작하고 폴더 승인 목록·renderer storage/cache·API/path token·private
  backend channel을 갱신한다. 원본 로컬 폴더 접근에는 새 사용자 승인이 필요하다.
- 새 backend는 startup maintenance ID로 처음부터 쓰기를 차단한다. 실제 health와
  DRAINED를 확인한 뒤 B 완료 → PG 재확인 → 복구 완료 기록 → gateway release → HTTP END
  순서로 접근을 연다. 완료 뒤 공개 단계가 실패해도 이미 검증된 A를 임의 롤백하지 않는다.
- 성공 시 이 작업이 만든 plaintext payload만 inode·hash를 대조해 제거한다. 입력 오류가
  maintenance 시작 전에 확정되면 소유한 scratch만 정리한다. 미완료 거래·기존 DB/소스·
  암호화 checkpoint는 삭제하지 않는다.

## 발견과 수정

| 심각도 / 우선순위 | 파일·재현 근거 | 사용자 영향과 처리 |
|---|---|---|
| High / P0 | 이전 `backup.cjs`의 raw dump/clone copy와 live SQL restore | credential 및 실행 권위가 섞인 format2를 제품 fallback으로 허용하지 않고 typed format3 경로 연결. 이전 파일/백업은 보존 |
| High / P1 | `main.cjs:316`, `backup-product-state.cjs:343`: readiness만으로 다른 PG 서버를 오인할 수 있음 | owned child/data-dir/system identifier 확인을 DB 생성·extension 변경보다 앞에 둠 |
| Medium / P1 | `backup-runtime.cjs:348`, `main.cjs:688`, `MaintenanceGate.java:28`: health보다 완료 기록이 먼저이고 기동 실패 롤백 전에 child가 살아 있을 수 있음 | startup admission barrier, health 전용 단계, 종료 확인 후 롤백, 완료 이후 A 보존으로 수정. 독립 fault 및 실제 main VM 검증 |
| Medium / P1 | `backup-runtime.cjs:156`: worker/vault가 필요한 소스를 누락해도 완료 가능했던 실제 RED 2개 | 완성 payload를 DB source inventory와 다시 대조. 누락 시 전체 실패 |
| Medium / P1 | `backup-database.cjs`: 재시도 경로의 allowConnections 미검증, stdout/stderr error 미처리 | 상태·OID·owner를 함께 확인하고 오류 시 실제 close까지 기다림. 독립 RED → 10/10 PASS |
| Medium / P1 | `backup-product-state.cjs:102,310`: result 뒤 premature child close/timeout을 COMMIT 성공으로 오인한 실제 synthetic child | COMMIT 이후 별도 SQL receipt, stream EOF, close(0), sticky failure와 마지막 origin 확인을 요구하도록 보강 |
| Medium / P1 | `backup-cost-state.cjs:90,126`, 실제 PG+JAR backup에서 health → B 완료 → PG 갱신 뒤 복구 기록 완료 거부 | 완료하면서 정상 해제되는 `reconciliationRequired`가 재무 hash를 바꾸던 계약 오류. 유도된 상태 플래그는 digest에서 제외하고 pending seal에는 별도로 true를 요구. 정책·한도·영속 legacy·의무·usage 증거 검증 유지. 독립 신규 7개 중 실제 RED 5개 → 두 파일 100/100 PASS, 실제 왕복/롤백 PASS |
| Medium / P1 | `backup-runtime.cjs:101,288,361`: 잘못된 archive 선택 시 scratch 누적, 성장 파일 복사 상한, maintenance 획득 실패를 INPUT으로 오분류 | 소유 scratch 정리·초기 크기 상한·acquisition attempt 추적. pending seal 재호출도 recovery-required 유지 |
| Medium / P1 | `backup-cost-state.cjs`, `backup-source-selection.cjs` | 알 수 없는 metadata, 입력 순서에 따라 달라지는 HEAD, retained duplicate path를 거부/정규화. 독립 141/141 PASS |
| Medium / P1 | `ai-egress-postgres.cjs`: LOCAL_LINKED owner 거부 | local identity와 동일 owner를 유지해 linked 설치도 허용. GITHUB-only·외부 local identity는 계속 거부 |
| Medium / P1 | `LocalSourceStatusService.java`, `safety-lifecycle.cjs` | 복원 후 null local_path는 재승인 상태로 표시. backup-maintenance 흔적이 있으면 유실된 identity/B를 새 키로 대체하지 않음 |

## 검증

최종 전체 회귀와 실제 임시 런타임 시험 결과는 이 표와 인접
`backup-restore-validation-2026-10-03.json`에 고정한다. focused 수는 전체에 포함될 수
있으므로 서로 합산하지 않는다. 이전 `/tmp/ci-ai-*` 증거는 그 당시 후보의 이력이다.

| 검증 | 결과 |
|---|---|
| Backend 전체 formatter/test | **1284/1284 PASS**, 109 suites, failure/error/skip 0. `CI_BACKUP_MAINTENANCE_PG=1` 포함 |
| Frontend lint/typecheck/test | **293/293 PASS**, 30 files |
| TS analyzer typecheck/test/build | **11/11 PASS** |
| 새 실제 JAR source helper | **46/46 PASS**, export/재구성 포함 |
| 실제 cost PG adapter/LOCAL_LINKED owner | **59/59 leaf PASS** (Node parent 포함 60). 사용자 DB 사용 없음 |
| 실제 임시 PG typed loader/DB swap/cost stage | 최신 **106/106 PASS**, credential 제외·V1–V25·정밀 수·trigger·rollback 확인 |
| source-vault / source directory swap | **104/104**, **99/99 PASS**, 실제 파일·합성 keys/fault |
| encrypted recovery records | **118/118 PASS**, 건강 단계 추가. 실제 Keychain/전원 차단 아님 |
| payload / 비용·source state | **114/114**, 초기 state **141/141 PASS**. 이후 완료 전이 비용·runtime 두 파일 **100/100 PASS** |
| main VM / coordinator fault | main VM **74/74**, 최신 coordinator **44/44 PASS**. 합성 ports/실제 파일 검증이며 설치 Electron UI가 아님 |
| Backend/frontend build + 별도 source 사용자 흐름 | **build PASS**, 실제 backend/PG/별도 headless 흐름 **12/12 PASS** |
| 실제 runtime 백업·복원·health 뒤 장애 롤백 | **두 시나리오 PASS** (Node parent 포함 3/3), 실제 소유 임시 PG·Redis·JAR와 비용 B·소스 교체 검증 |
| 최신 전체 Desktop | **1982 PASS, 5 SKIP, 0 FAIL** (총 1987). 건너뛴 항목은 외부 binary/임시 DB가 필요한 opt-in이고 아래 별도 실행에서 통과 |

검증은 disposable DB/Redis, 별도 headless context 또는 합성 OS wrapping/transport를
사용한다. 사용자 브라우저 세션·실제 프로젝트·Keychain·설치 앱·유료 provider를 사용하지
않는다. 고정 binary/JAR와 테스트 SHA, 실패/재시도/건너뜀의 구분을 기계 판독 기록에 남긴다.

실제 runtime 시험은 먼저 fixture의 과도한 keyring capability 전달을 제품과 같은 backup 전용
facade로 고쳤다. 다음 실행과 진단 실행에서는 위 완료 digest 결함을 재현했다. 초기 실패는
보존했고 수정 후 두 실제 시나리오를 다시 통과했다. 롤백에서는 이후 생긴 비용 의무까지 B에
유지되고, 이전 credential은 폐기되며, 미완료 seal 때문에 후속 작업이 거부되는 것을 확인했다.
이는 process kill/전원 장애 뒤 자동 복구가 구현됐다는 뜻은 아니다.

Desktop의 opt-in 5개는 cost PG adapter, maintenance cost stage, DB swap, typed PG loader,
실제 runtime 시험이다. 위 59 leaf/106/두 시나리오의 별도 실행으로 각각 확인했다. 전체 회귀
통과 수에 다시 더하지 않는다. 최종 전체 회귀 전후 779개 소스·테스트·실행 설정의 hash가
동일했다. 기존 네 기준점의 파일 누락은 0, 동결 문서 21개 변경은 0이다. 실제 JAR의 SHA와
초기 실패·독립 검토·재실행 산출물은 인접 검증 JSON에 남겼다. Gradle/Vite의 기존 비치명
경고가 없는 무경고 빌드라고 주장하지 않는다.

## 남은 출시 차단점

| 심각도 / 우선순위 | 근거·영향·다음 선택 |
|---|---|
| High / P0 — 중단 거래의 제품 복구 | `backup-runtime.cjs:151` 생성자는 active record를 거부한다. 같은 transaction의 실제 PG/B/소스 상태를 재대조해 재개하는 제품 진입점은 아직 없다. process kill 뒤 남은 journal/keyring owner lock을 자동 삭제하지 않는다. 별도 recovery-only boot와 검증된 단일 소유권 회복이 필요 |
| High / P1 — source 완전성 | `SourceGraph.java:55`와 `BackupSourceWorker.java:77`: retained synthetic commit이 정리된 run workspace에만 있으면 helper는 SOURCE_MISSING으로 전체 백업을 거부한다. manifest와 신뢰된 생성 정보에서 정확한 object를 재구성하고 모든 history/IDE reader까지 연결해야 한다. 소스를 조용히 제외해 완전 백업으로 표시하면 안 됨 |
| Medium / P1 — 공간·보존 정책 | `backup-runtime.cjs:81,108,279`에 선택 archive 복사와 해제 공간 검사는 있지만 현재 DB/source, checkpoint, staging, 외부 목적지의 합산 예산·20% 여유와 완료 checkpoint 최근 2개 보존/정리는 미완성. 반복 성공 시 보존 이미지가 증가할 수 있음. 일반 사용자 기능 수용 전에 quota/GC와 실패 복구를 함께 검증해야 함 |
| High / P1 — 과거 형식·이식성 | format1/2는 새 제품 경로에서 거부한다. 신뢰되지 않은 dump를 normal DB에서 실행하는 fallback을 두지 않는다. 별도 격리된 data-only 변환/검증 경로가 필요. 다른 설치로 key portability도 구현하지 않음 |
| High / P1 — 비용의 보수적 거부 | 과거 usage에서 해결되지 않은 의무를 0으로 추정하지 않는다. 엄격한 기록과 연결을 입증할 수 없는 usage는 영속 legacy flag를 남긴다. 높은 liability floor/같은 UUID의 불변 PG reserve 충돌은 전환을 거부할 수 있으며 운영 복구 절차가 필요 |
| High / P1 — native·운영 설치 | backend 프로세스/파일/network confinement, 실제 safeStorage, clean Mac 설치, 서명/notary/Gatekeeper, updater/rollback, OAuth 등록·callback·권한 만료/취소는 미검증. 코드와 unsigned build만으로 승인하지 않음 |
| High / P1 — 분석 품질·규모 | 독립 NestJS/React holdout의 화면→API→서비스→데이터 연결 및 변경 영향/근거 정확도, 대형 저장소 resource budget·취소·오류 복구 수용이 필요. 작은 fixture 통과를 정확도 수치로 일반화하지 않음 |

안전한 다음 단계는 기존 구성 위에 recovery-only 진입점과 단일 소유권 회복을 연결하는
것이다. native helper/XPC로 B·파일·network 권한을 옮기는 전환은 별도 설계·운영 수용이
필요하다. 이번 작업에서 그 대규모 전환이나 과거 백업 SQL 실행을 임의 선택하지 않았다.

동결 기획 20개와 실행 명세 1개는 변경하지 않는다. 기존 변경 reset·삭제, 커밋·push·PR,
실제 자격증명 생성, 외부 업로드·유료 호출·게시·배포·설치 앱 교체를 수행하지 않았다.
