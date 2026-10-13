# 출시 차단 항목 후속 라운드 감사 — 2026-10-12

브랜치 `release/blockers-20261011`(원본 main c98dede = PR #117 뒤). 조정 작업트리 rapid-forest, 검증 작업트리 INT(detached). 서브에이전트 0명. 이 문서는 직전 라운드([설치·업데이트 감사](install-update-2026-10-11.md))가 남긴 로컬 해결 가능 차단 항목 네 건(A 정확도 개발 기준선 2사례, B medium 증분 RSS 상한 초과, C U8 패키지 검증, D C06 E-12 증거 공백)의 원인·수정·실제 실행 결과와, 이번 라운드 중 발생한 호스트 사고를 기록한다. **출시 판정은 NO_GO 유지**(사람·자격 게이트 미해소).

## 1. 호스트 사고(2026-10-11 21:00 KST 전후)와 대응

- 다른 세션의 Homebrew 설치(`brew install` terraform/python/utm, `/tmp/cloud-security-*-install.log`)가 `simdjson`을 5.0.3으로 올리면서 `/opt/homebrew/opt/simdjson`이 재링크됐고, Homebrew node 26.5.0/26.4.0·node@22는 `libsimdjson.33.dylib`를 찾지 못해 실행되지 않는다. node@24(24.21.0_2)만 정상이다.
- 같은 시각 `~/.gradle/caches`(의존성 모듈 캐시), `~/.npm/_cacache`, Testcontainers 이미지(`pgvector/pgvector:pg16`, `redis:7-alpine`)가 제거됐다(가용 디스크 10→40GiB). 어느 프로세스가 지웠는지는 확인하지 못했고, 이 세션은 삭제를 하지 않았다.
- 대응(사용자 환경 설정은 바꾸지 않음): 검증 러너·후보 빌드는 node@24로 실행했고(`PATH` 선행), Docker 스위트가 PATH 고정으로 띄우는 sidecar `node`(brew 26)는 `run-docker-integration.cjs`의 `DYLD_LIBRARY_PATH` 통과(호출자 환경에 있을 때만)로 `simdjson 4.6.4`의 `.33`을 읽게 했다. gradle 모듈 캐시와 두 이미지는 온라인으로 다시 받았다(검증 메타데이터 없음; 동일 좌표의 불변 아티팩트). Homebrew 재링크·`brew reinstall`은 하지 않았으며 사용자 조치로 남긴다.
- 영향: 이번 라운드의 모든 node 실행은 node 24.21.0이다(직전 라운드 26.5.0). 후보 빌드 결과·회귀 로그에 node 버전이 기록된다.
- 디스크: 16:30경 가용량이 다시 4.3GiB로 떨어져(후보 빌드 하한 6.85GB) 두 가지만 정리했다. (1) r2 아카이브가 ARCHIVE_VERIFIED로 복사한 `/private/tmp` 작업 디렉터리 6개(직전 라운드 update-acceptance work 4개·import-evidence native work·canonical work)를 아카이브 사본 인벤토리 해시 재검증 뒤 제거했으나, 사본이 APFS 클론(cp -c)이라 실제 회수는 약 0.1GB였다(`retire-archived-tmp-20261012.json`에 실제 회수량 기록). (2) 이 세션이 중단시킨 실행의 scratch 3개 — admission 거부된 canonical 시도 `cica-D6L22Z`(4.4GB), 조작자가 중단한 update 하네스 `ciu-FPZAYi`(1.9GB)와 그 `.native-update-FONlii`(0.8GB) — 를 열린 파일 확인 뒤 제거했다(`retire-aborted-scratch-20261012.json`; 해당 result.json은 보존). 직전 라운드의 `.native-update-*` 네 디렉터리, 모든 validation/local 증거, 다른 세션의 자료는 손대지 않았다. 정리 뒤 가용 11GiB.

## 2. 원인과 수정

### 2.1 A. 정확도 개발 기준선 2사례

| 사례 | 원인 | 수정 | 시험 |
| --- | --- | --- | --- |
| SQL-S `dev-todo.sqls.table` end 118/117 | 측정 도구 `accuracy-observations.cjs`가 DB_TABLE 문 span에서 끝 `;`를 잘랐다. 계약(`validation/t00/ANNOTATING.md` SQL-S table: `CREATE TABLE name (` through `);`)은 `;`를 포함한다. 제품 span(문 내용 줄 1~5)은 맞았다 | 도구: 문 span 뒤 첫 비공백 바이트가 `;`면 포함(`throughTerminator`); 컬럼의 끝 `,` 제거는 유지 | `accuracy-observations.test` SQL-S 1건 |
| T-C `dev-typescript-calls.candidates` 후보 missing | TS 분석기는 인터페이스/type alias 수신자(`action: Action`)의 호출을 `UNRESOLVED_TARGET`로만 공개했고, 객체 리터럴 구현(`first.run`, `second.run`)은 노드가 없었다 | 제품(`semantic-extractor.ts`): 모듈 수준 객체 리터럴에 프로젝트 interface/type alias 주석이 있으면 함수형 멤버를 METHOD 노드 `ts:<file>#<const>.<member>`로 공개(`declarationKind: OBJECT_LITERAL_METHOD`, `implements`), `implements` 절의 클래스 메서드와 함께 `<type key>.<member>` 구현 색인을 만든다. 수신자 타입이 프로젝트 interface/alias이고 멤버가 그 타입에 선언돼 있으면 **호출 모듈과 타입 선언 모듈**의 구현만 `CALLS/POSSIBLE` 후보로 공개한다(Java class-hierarchy 후보와 같이 CONFIRMED 승격 없음; 5개 초과는 `CANDIDATES_EXCEEDED` abstain; 가시 구현 0은 기존 abstain). 두 모듈은 호출자를 소유한 모든 슬라이스 프로그램에 들어 있으므로 슬라이스 결과가 단일 프로그램과 같고 증분 캐시 키도 두 파일을 이미 덮는다. 다른 모듈의 구현은 추측하지 않는다(cell은 여전히 provisional) | `semantic-extractor.test` 4건, ts-analyzer 전체 323 PASS |

골드·허용오차·분모·D4 파일별 구문 판정은 바꾸지 않았다. 개발 기준선 재측정 결과는 §3.

### 2.2 B. medium 증분 RSS 상한

직전 `run-4nd3V8` 2회차의 `resource-samples.csv`를 프로세스 트리로 다시 집계했다(`workload-composition.py`, 측정 집계 자체는 러너의 값 그대로):

| 구간 | 합계 | TS worker | 백엔드 JVM | PostgreSQL 자식 합 | Electron(main+helper) | 기타 |
| --- | --- | --- | --- | --- | --- | --- |
| ANALYSIS peak(133.6s) | 3,554,960 KiB | 1,342,048 | 859,184 | 401,456 | 924,400 | 27,872 |
| INCREMENTAL peak(197.1s) | 4,240,176 KiB | 1,365,232 | 957,248 | 918,000 | 971,760 | 27,936 |

증분 peak가 초기 분석 peak보다 685MiB 큰 이유는 (1) PostgreSQL 자식 프로세스 합계 +505MiB(refresh 중 backend·checkpointer·bgwriter가 각자 shared_buffers 페이지를 더 많이 만지며 process별 RSS에 같은 공유 메모리가 중복 집계됨), (2) JVM +96MiB, (3) Electron +46MiB다. JVM은 단계 종료 full GC 뒤에도 TS worker가 도는 동안 0.93GiB에 머물렀다: `MaxHeapFreeRatio=50`은 수집 뒤 live set(Java 재사용 캐시 ≤256MiB 포함)의 약 2배를 커밋 상태로 두므로 GRAPH_BUILD→TS_PARSING 전이에서 회수된 RSS는 약 50MiB뿐이었다. TS worker는 두 구간 모두 약 1.3GiB(12MiB 슬라이스 프로그램 + 매니페스트·캐시)다.

수정(제품, `desktop/src/jvm-options.cjs`): `-XX:MinHeapFreeRatio=20 -XX:MaxHeapFreeRatio=30`(기존 50/기본 40)으로 축소 밴드를 좁혀 단계 종료 수집 뒤 커밋 heap이 live set에 가깝게 내려가게 했다(ShrinkHeapInSteps 비활성 유지). 측정 PID·XPC/launchd 집계·샘플 구간·상한은 바꾸지 않았다. TS 슬라이스 예산 축소(12→8MiB)와 PostgreSQL shared_buffers/연결 수 조정은 large 초기 분석 시간(TS_PARSING 117s/524s, SLO 600s)과 DB 성능 영향이 미측정이라 이번에 적용하지 않고 다음 선택지로 기록한다. 측정 결과는 §3.

### 2.3 C. U8 패키지 검증

`update-acceptance-packaged.cjs`에 제품 backup/restore 경로를 추가했다: Phase A(빌드 N 첫 시작) U0 뒤 renderer의 `window.codeIntelligenceDesktop.backup()`(IPC `data:backup`)을 호출하고 native 폴더 선택 대화상자(`dialog.showOpenDialog`)를 스크립트 응답으로 대신해 `CodeIntelligence-<uuid>/backup.cibackup`을 작업 디렉터리에 남긴다(U8a). Phase B에서 N+1이 데이터 위에 처음 시작해 floor를 올린 뒤(U1b) 같은 세션에서 `restore()`(IPC `data:restore`)로 그 이전 백업을 복원한다. 복원은 제품 유지보수 흐름 그대로(일시정지·checkpoint·staging DB·source swap·journal `RESTORE_BEGIN/RESTORE_RECEIPT` merge·재시작)이며 상태 직접 조작은 없다. 판정: 모든 `RESTORE_BEGIN.minimumVersion`이 N+1, 마지막 `BUILD_STARTED`가 N+1이고 N의 BUILD_STARTED는 최초 1건뿐, `schema.json` build가 N+1, 런타임 ready 복귀, 이어지는 U6b(N 정상 시작 거부)가 PASS여야 U8 PASS다. 기존 계약(UInt32BE 길이 프레임 journal, `recordStartedBuild` 조건, signed rollback 뒤 N 재시작, 실행별 이동 userData, timeout·소유 프로세스 정리, 행 FAIL 시 exit 1)은 유지했다. U10b는 O2 BLOCKED 유지.

xtq4U4에서 하네스를 처음 실행한 결과(`update-acceptance/packaged-H5lLYf`)는 두 가지를 드러냈다. (1) 하네스 판정 오류: U8a의 제품 백업이 journal에 남긴 N 시점 `RESTORE_BEGIN`(minimumVersion N)까지 U8 판정에 포함해 FAIL로 셌다. 실제 복원의 두 merge는 모두 minimumVersion N+1이었고 N 시작 거부(U6b)도 PASS였다. 복원 시작 이후 merge만 판정하도록 고쳤다(c51d10e). (2) **제품 결함**: 복원 뒤 허용 롤백(U7)에 이어 N을 시작하면 BACKUP 단계에서 `SAFETY_RECOVERY_REQUIRED`가 났다. `backup-recovery-records.cjs`는 기록마다 작성 빌드를 `minimumBuild`로 저장하고 더 낮은 실행 빌드를 `BACKUP_RECOVERY_UNSUPPORTED`로 거부하는데, safety journal이 서명된 recovery manifest로 floor를 N까지 낮춘 뒤에도 records는 N+1이 남긴 기록을 N에게 열어 주지 않았다(직전 라운드에는 백업 기록이 없어 드러나지 않았다). 기록 형식 버전 검사는 유지하고, journal의 started-build floor가 실행 빌드를 허용할 때(= 허용 롤백 뒤)만 더 높은 `minimumBuild`의 기록을 읽도록 고쳤다(`journalFloor`; 시험 2건 추가). 이 수정은 제품 바이트를 바꾸므로 새 후보로 전 과정을 다시 돌렸다(§3).

### 2.4 D. E-12 capability partition

03의 FileOutcome 계약(파일·capability·owner별 한 번)에 맞춰 제품이 S/C/F/X 결과를 파일별로 기록하게 했다.

- Flyway `V30__file_capability_outcomes.sql`: `file_capability_outcomes(file_id→files, capability S/C/F/X, status TARGETED/SUCCESS/PARTIAL/FAILED/UNSUPPORTED/UNMEASURED, reason)`. P는 기존 `files.analysis_status` 그대로.
- 소유 어댑터가 기록: Java 분석기 S(선언 등록)·C(호출 해결, abstention이 있으면 PARTIAL), Java framework 분석기 F, SQL migration 분석기 S, TS sidecar 응답의 `capabilityOutcomes`(S·C·F; 구문 거부 파일은 FAILED, 이웃 파일은 F PARTIAL `SYNTAX_IN_PROJECT`), tree 분석기 S(P와 동일), 교차 도메인 단계 X(java/typescript/javascript/sql 파일: P 결과에 따름). 인벤토리는 측정 언어 중 소유 어댑터가 없는 capability를 `UNSUPPORTED`로, 파일별 계약이 없는 언어(yaml/json 등)는 미기록(unmeasured)으로 둔다. 단계 시작 시 TARGETED(pending), 실패 시 FAILED/UNMEASURED 전이는 P와 같다.
- `CoverageService`: 다섯 capability 모두 `PER_FILE_RECORDED` 분할(eligible=success+partial+failed+unsupported+pending, eligible+unmeasured=파일 행). 과거 스냅샷은 `LEGACY_UNMEASURED` 유지.
- C06-14 확장: 모든 보존 스냅샷에서 capability별 분할이 인벤토리와 언어 매니페스트(측정 언어 eligible, 비소유 UNSUPPORTED, 소유 capability는 어댑터 결과)와 일치하고 pending 0임을 확인하고 `c06-evidence-history.json`에 기록. legacy migration walk에 V30 sentinel 추가(30단계, 15 sentinel).
- T00 export dump에 `capabilityOutcomes` 행을 추가하고 `accuracy-observations.cjs`는 S/C/F/X cell의 coverage outcome을 기록된 행에서 취한다(없으면 기존 P 투영, `audit.capabilityOutcomes`에 집계).
- 데스크톱 reviewed backup schema: V30 추가(테이블 정의·ENUM·migration SHA), 복원 전용 V29 리더 추가(V27/V29 archive는 새 테이블 비움으로 복원), 레거시 요약·카탈로그 시험 갱신, updater `TARGET_FLYWAY`=30.

## 3. 실행 결과

### 3.1 정확도 개발 기준선(A)

INT `accuracy-export/blockers-vFgRL8`(최종 소스 9212b9d, 제품 경로 dirty 0, 실제 Spring pipeline·Testcontainers PostgreSQL·TS sidecar; 611a6f3 `blockers-hbgAoy`·7e548b5 `blockers-4EEamd`·05bb405 `blockers-BRTgsf`도 같은 결과)의 export를 `accuracy-baseline.cjs`로 재평가했다: 개발 자료 **81사례 실패 0·unmatched 0·false-resolved 0**(직전 2·2·0). T-C는 TP 1·CANDIDATE_EXACT 1·ABSTAINED 1, SQL-S는 TP 4다. T00 gate는 모든 cell이 BLOCKED(exit 2: `DEVELOPMENT_MATERIAL_ONLY`·독립 주석·blind real-repo review 미완)이며 FAIL cell은 없다. 금본위·임계치·분모는 바꾸지 않았다. 개발 기준선 통과는 정확도 수용이 아니다.

coverage outcome은 세 fixture 모두 제품의 capability 행에서 취했다(`evidence-audit.json` `capabilityOutcomes`: recordedRows 8/8/68, parserProjected 0). 이 export의 분할: todo fixture J-S 8 SUCCESS, J-C 6 SUCCESS·2 PARTIAL(abstention), J-F/J-D 8 SUCCESS, X-DATA 9 SUCCESS, SQL-S 1 SUCCESS, T-S 7 SUCCESS(나머지는 fixture eligibility에 따라 EXCLUDED).

### 3.2 통합 회귀·후보

소스 **05bb405**(891bd56 구현 + 611a6f3 JVM 밴드 + 7e548b5 시험 기대값 + 05bb405 backup export 키)의 통합 회귀(INT `blockers-regression-05bb405-20261012`, node 24.21.0): frontend 480·TypeScript 확인 PASS·ts-analyzer 323·runners 457·desktop 3,289(+45 SKIP)·backend 2,076(+18 SKIP, `docker-integration/backend-zyTia8`)·events 19, 합계 **6,644 PASS·0 FAIL·63 SKIP**(`integrated-regression-05bb405.json`). 7e548b5의 회귀(`blockers-regression-7e548b5-20261012`)도 같은 합계였다. 최종 소스 **9212b9d**(05bb405 + records floor 수정, desktop만 변경)의 전체 회귀 `blockers-regression-9212b9d-20261012`는 backend Docker 스위트에서 `AiCostEgressMatrixIntegrationTest` C13-15(reservation commit 전 DB 실패 유도) 1건이 503 `DESKTOP_AI_SAFETY_UNAVAILABLE`로 실패했다(load1 24; backend 소스는 05bb405와 동일하며 그 두 번의 회귀는 통과). 직전 라운드와 같은 절차로 backend 스위트만 재실행해 병합했다(`…-merged`, §3.2 합계는 병합 결과; 원래 실패 로그 보존). 첫 소스 611a6f3의 회귀는 backend `JavaFrameworkReuseTest` 1건이 실패했다(네 추출기 독립 결과와의 동등 비교에 새 F capability 결과가 없었음; 시험 기대값만 보강, 제품 변경 없음) — `blockers-regression-611a6f3-20261012` 보존.

7e548b5의 후보 **k0ECto**(`build-9FFiS1`)는 stage 5 product 단계의 실제 백업에서 `NATIVE_BACKUP_TIMEOUT`로 실패했다(`pre-release-final/product-ULI6Lw`, 12검사 뒤 real-main-backup): 백업 export가 복합 키 테이블 목록에 없는 테이블을 `id`로 정렬하는데 V30 테이블에는 `id`가 없다. 실제 PostgreSQL export 시험은 `CI_BACKUP_PG_TEST_*` 환경이 없어 스위트에서 스킵됐다. `backup-postgres.cjs`에 `file_capability_outcomes: [file_id, capability]` 정렬 키를 추가하고 어댑터 시험에 "id 없는 reviewed 테이블은 명시 키로만 export" 단언을 넣었다(05bb405). k0ECto의 stage 5 부분 결과는 실패 증거로 보존한다.

최종 후보 **xtq4U4**(`build-hLHJrn`, 소스 05bb405, tZgvV7 baseline/xpc-required, buildSequence 1791784629750): PACKAGED_NOT_RELEASED, 소스/baseline 불변, Java 재컴파일(migration 30개, backup-migrations에 V28~V30), Validation 루프백 업데이트 피드 동일(fixture-20261011). 정식 서명·공증·배포 없음. 해시는 ledger-v7.

### 3.2.1 패키지 검증(stage 5)·startup probe

xtq4U4 stage 5(`stage5-xtq4U4`, `packaged-xtq4U4-proof.json` VERIFIED_PACKAGE_SCENARIOS): 제품 36검사 PASS(`product-mVJz1V`, 실제 백업→복원 포함), owner-crash after-rename 6/6·before-cleanup 6/6, job-race 8 PASS, 내부 보안 탐침 COMPLETE(xpc-required; 독립 수용 아님), 자동 UX 190화면(machineErrors 0·pageErrors 0·consoleErrors 2; 사람 수용 아님), loader·egress OFF·egress ASK PASS. xtq4U4의 startup probe `run-vsIfow`는 3샘플 COMPLETE_DIAGNOSTIC(ready 7,988/8,045/7,879ms, idle RSS ≤1,355,744 KiB), 최종 후보 1OW40e의 `run-6RCLG5`도 3샘플 PASS·수집 완전(ready 8,153/8,273/8,477ms). 1OW40e stage 5(`stage5-1OW40e`, `packaged-1OW40e-proof.json`): 제품36·crash 6/6·6/6·job-race 8·보안 COMPLETE·UX 190화면(consoleErrors 2)·loader/egress PASS — xtq4U4와 같은 결과다.

### 3.3 import-evidence backend·C06 capability partition(D)

INT `import-evidence/backend-ShGgDe`(최종 소스 9212b9d; 7e548b5 `backend-bEL258`·05bb405 `backend-d1RB9E`도 동일): **574 PASS·0 FAIL·1 SKIP**(C06-15 R2 명시적 SKIP). C05 72사례 PASS. C06-14는 보존 스냅샷 7개 모두에서 P/S/C/F/X 다섯 분할이 인벤토리와 언어 매니페스트에 일치했다(예: 스냅샷 1~3 파일 11개 — P eligible 11(8 SUCCESS·3 PARTIAL)/unmeasured 2, S 11 SUCCESS, C 9 SUCCESS·1 PARTIAL·1 UNSUPPORTED, F 10 SUCCESS·1 UNSUPPORTED, X 11 SUCCESS; sql 파일은 S/X SUCCESS·C/F UNSUPPORTED, package.json·application.yml은 모든 capability unmeasured; pending 0). legacy migration walk는 V1→V30 30단계·sentinel 15개(V30 `file_capability_outcomes` sentinel 포함) 보존. 행별 매트릭스는 §3.5.

### 3.4 medium·large smoke-2(B)

medium `run-qmAOnh`(xtq4U4, AC 전원, 덮개 기록, 실행 직전 load1 13.2/5.6 → **DIAGNOSTIC_ONLY / INVALID_LOAD**): warm-up 및 2회차 기능 PASS·수집 COMPLETE(최대 간격 205/228ms)·종료 확인. `medium-xtq4U4-verification.json`이 원시 CSV 합계/phase peak·XPC 소유·후보 해시를 재검증했다.

| medium 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 증분 4GiB 상한 | 증분 peak 구성(MiB: worker/JVM/PostgreSQL/Electron) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 144.176 | 57.794 | 3,488,864 | 4,158,608 | 이내(−35MiB) | 1,328 / 790 / 946 / 969 |
| 2 | 142.437 | 56.129 | 3,458,096 | 3,955,552 | 이내(−233MiB) | 1,336 / 784 / 749 / 967 |

JVM 축소 밴드 조정의 효과는 증분 peak 시점 JVM RSS 934→784~790MiB(−145MiB), 초기 분석 peak 시점 859→762~788MiB다. 두 회차 모두 상한 이내이지만 1회차 여유는 35MiB뿐이며, 회차 간 차이는 PostgreSQL 자식 프로세스 합(749~946MiB; 공유 버퍼의 process별 중복 집계)에서 온다. TS worker는 약 1.33GiB로 불변. 시간은 분석 144/142s, refresh 57.8/56.1s(직전 142/139, 54.0/56.3)로 축소 밴드의 시간 비용은 관측 범위 안이다. 고부하 진단이므로 정식 20회·RSS 수용으로 취급하지 않는다. 다음 선택지(미적용): TS 슬라이스 예산 12→8MiB, PostgreSQL shared_buffers/연결 수 조정.

large `run-cYwfJV`(xtq4U4, AC, 실행 직전 load1 9.1/17.4 → **DIAGNOSTIC_ONLY / INVALID_LOAD**): warm-up 및 2회차 기능 PASS·수집 COMPLETE(최대 간격 219/226ms)·종료 확인, `large-xtq4U4-verification.json`으로 재검증.

| large 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 증분 6GiB 상한 | 증분 peak 구성(MiB: worker/JVM/PostgreSQL/Electron) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 529.520 | 392.704 | 4,657,024 | 5,324,080 | 이내 | 1,724 / 1,349 / 1,028 / 1,070 |
| 2 | 533.159 | 396.221 | 4,839,376 | 5,460,208 | 이내 | 1,737 / 1,331 / 1,161 / 1,075 |

large는 직전(5,398,048/5,167,312 KiB, 524.7/521.7s, 404.4/388.0s)과 같은 범위이며 두 회차 모두 상한 이내다. 두 번의 고부하 진단으로 20회 p95나 정식 지원 등급을 승인하지 않는다.

**최종 후보 1OW40e(소스 9212b9d, records floor 수정 포함)** medium `run-q9iZ1s`(AC, load1 8.9/36.5 → DIAGNOSTIC_ONLY / INVALID_LOAD, 수집 COMPLETE 221/234ms):

| medium 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 증분 4GiB 상한 | 증분 peak 구성(MiB: worker/JVM/PostgreSQL/Electron) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 171.280 | 72.705 | 3,510,064 | 3,936,416 | 이내(−252MiB) | 1,317 / 823 / 717 / 959 |
| 2 | 144.647 | 55.937 | 3,477,008 | 4,135,456 | 이내(−57MiB) | 1,330 / 765 / 948 / 968 |

1회차 시간(171/72.7s)은 실행 직전 load1 8.9·실행 중 36까지 오른 고부하 구간의 관측이며, 2회차는 직전 후보와 같은 범위다. 증분 peak는 xtq4U4와 같이 두 회차 모두 상한 이내이고, JVM 765~823MiB·PostgreSQL 자식 717~948MiB의 구성도 같다. **large smoke-2와 large canonical은 2026-10-12 시점에는 1OW40e에서 실행하지 못했다**: 러너 admission이 디스크 부족으로 거부했다(`large-1OW40e-blocked-disk.log`: 가용 4,065,619,968 < 필요 6,442,450,944바이트; §1 디스크 항 참조). 이 세션은 승인 없이 더 정리하지 않았고, AC와 가용 7.5GB가 관측되면 실행하는 대기 작업을 걸어 두었다(`large-canonical-when-ready.sh`). 그 뒤의 실제 실행은 §3.6에 기록했다.

### 3.5 업데이트 수용(C)·packaged import-evidence·C06 매트릭스

최종 후보 1OW40e(소스 9212b9d)에서 `update-acceptance/packaged-ZkAnzz`(드라이버 SHA-256 `2cd2de4a…39cc`, 후보 asar/manifest 불변, exit 0): **20 PASS·0 FAIL·U10b BLOCKED**(ROWS_RECORDED_NOT_GATE_PASS). U8a: 빌드 N(1791792184141)이 `data:backup`으로 48,196바이트 `backup.cibackup`을 작업 디렉터리에 썼고(폴더 picker 스크립트 응답 기록), 백업 유지보수가 journal에 N 시점 merge(minimumVersion N)를 남겼다. U8: N+1(…142)이 N의 데이터 위에 시작해 floor를 올린 뒤(U1b) 같은 세션에서 `data:restore`로 그 백업을 복원했다 — 복원이 추가한 `RESTORE_BEGIN`은 inputMinimumVersion·minimumVersion 모두 N+1, `RESTORE_RECEIPT` 1, BUILD_STARTED는 [N, N+1] 그대로, `schema.json` build N+1, 런타임 ready 복귀. 이어서 N 재설치 시작은 거부됐다(U6b: `SAFETY_RECOVERY_REQUIRED` 오류 상자 1, exit 0, 새 BUILD_STARTED 없음). 이후 migration 중 강제 종료→recovery-only 복원→재시도 commit(U9a–c), 서명된 recovery manifest로 허용 롤백(U7), **N 정상 재시작(U7b, records 결함 수정 뒤 PASS)**, recovery serial 재사용 거부(U7c)까지 모두 PASS. U10b(실제 다른 Team ID/ad-hoc 재서명 거부)는 Developer ID 자격이 없어 O2 BLOCKED 유지. 이전 시도(xtq4U4 `packaged-H5lLYf` 18 PASS·U8 FAIL(하네스 판정)·D2 시작 실패, 조작자 중단 `packaged-URRQqJ`)는 실패 증거로 보존한다.

packaged import-evidence `native-A8ejj6`(1OW40e): 14검사 PASS, 후보 해시 불변(xtq4U4의 `native-2Mic6q`도 PASS).

행별 매트릭스 `c06-matrix-1OW40e.json`(backend-ShGgDe + native-A8ejj6, `make-c06-matrix-v2.cjs`): **15 PASS·0 FAIL·2 NOT_RUN**. E-12는 C06-14의 capability별 분할 증거(§3.3)로 PASS가 됐다(제한: synthetic C06 corpus와 개발 기준선; tree 분석기 비활성 시 python/go S는 unmeasured). E-14는 V1→V30 30단계·sentinel 15개. E-16(R2 SFC)·E-17(AI 증거 수용)은 NOT_RUN 유지, 독립 real-repo 수용·실제 OS picker 사람 클릭은 미수용.

### 3.6 2026-10-13 추가 실행: large smoke-2·large canonical(1OW40e)

PR #118 병합(53356eb)과 r2 증거 보관 뒤, 사용자 승인으로 미사용 Docker 이미지 27개를 제거해(`docker-image-prune-20261013.json`; 프로젝트가 쓰는 `pgvector/pgvector:pg16`·`redis:7-alpine`·`node:24`·ryuk 0.14와 종료된 컨테이너가 참조하는 이미지는 유지) 가용 디스크가 3→16GiB가 됐고, AC가 연결된 뒤 대기 작업이 실행됐다.

large `run-uyUKW5`(1OW40e, AC, 실행 직전 load1 10.5/23.4 → **DIAGNOSTIC_ONLY / INVALID_LOAD**): warm-up 및 2회차 기능 PASS, 종료 확인. 1회차는 샘플 최대 간격 631ms(허용 500ms 초과)로 수집 INCOMPLETE, 2회차는 183ms로 COMPLETE. `large-1OW40e-verification.json`이 CSV 합계/phase peak·XPC 소유·후보 해시를 재검증했고 measurementStatus는 **INCOMPLETE**로 남긴다(1회차 peak 값은 간격이 넓은 구간의 관측이므로 하한으로만 읽는다).

| large 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 증분 6GiB 상한 | 증분 peak 구성(MiB: worker/JVM/PostgreSQL/Electron) | 수집 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 530.809 | 432.968 | 4,682,544 | 5,316,864 | 이내 | 1,731 / 1,370 / 1,008 / 1,055 | INCOMPLETE(631ms) |
| 2 | 569.344 | 436.164 | 4,613,776 | 5,253,488 | 이내 | 1,738 / 1,381 / 908 / 1,076 | COMPLETE(183ms) |

증분 peak는 xtq4U4(5,324,080/5,460,208)와 같은 범위로 두 회차 모두 상한 이내이며, 구성도 같다(TS worker ≈1.7GiB·JVM 1.37~1.38GiB·PostgreSQL 자식 0.9~1.0GiB·Electron ≈1.05GiB). 시간(531/569s, 433/436s)은 load1 10~23의 고부하 관측이다. 러너는 1회차 간격 초과 때문에 fixture·profile을 FAILURE_EVIDENCE로 보존했고(4.7GB), 이 디렉터리는 아래 canonical 재시도를 위해 사용자 승인으로 제거했다(`retire-scratch-20261013.json`; result.json·samples CSV·treeSha256은 유지).

large canonical 1차 `canonical-large-hIA3j4`(AC, load1 25.7): 초기 가져오기·분석 launch PASS 뒤 두 번째 launch admission에서 **FAIL DISK_SPACE_LOW**(첫 admission 가용 11.7GB; 작업 디렉터리 4.4GB·large smoke 보존 4.7GB·export 1.4GB가 쌓여 6GiB 미만). 두 번째 시도는 시작 시 약 12GiB가 필요했고, 사용자 승인으로 1차 작업 디렉터리·large smoke 보존분·10-12 stage5 러너 scratch(총 12.5GiB)를 정리했다(`retire-scratch-20261013.json`).

**large canonical 2차 `canonical-large-lCjl3h` PASS — 배터리 전원, 사용자 결정 기록.** 호스트를 충전할 수 없는 상태에서 사용자가 배터리 실행을 지시했다. 러너(`run-workload-benchmark.cjs` diagnostic admission)와 로컬 드라이버(`run-canonical-large.cjs`)는 배터리에서 중단하도록 돼 있었으므로, 기본값을 바꾸지 않고 **명시적 정책 `BATTERY_RECORDED_USER_DECISION_2026_10_13`**을 추가했다(하네스 커밋 08b1f3e; 제품 트리는 9212b9d와 동일, 테스트 28 PASS): 진단 실행만 배터리에서 시작할 수 있고, 전원은 매 관측·launch마다 기록되며, timingValidity는 **INVALID_POWER**로 어떤 시간도 수용하지 않는다. 정식(ADMITTED) admission은 종전대로 배터리를 거부한다. 결과: 실제 packaged large 증분 결과와 변경된 동일 fixture를 새 프로필로 처음부터 분석한 결과가 **21범주의 개수·정규화 SHA-256 모두 일치**(`resultEqualsFull=true`; 파일 49,999·노드 768,168·간선 1,351,932·evidence 695,657). 삭제 파일의 옛 snapshot 존재/새 결과 부재와 변경 전파 확인, 두 launch 모두 exit 0·cleanupConfirmed, 후보 app.asar·manifest 해시 실행 전후 동일(05:03:36–05:34:26Z, 배터리 94→62%). 이 비교는 결과 동일성 진단이며 성능·전원 조건 수용이 아니다.

ledger `ledger-v7.json`은 위 결과로 재생성했다(large DIAGNOSTIC_ONLY/INCOMPLETE, canonicalLarge PASS + powerPolicy·1차 FAIL 기록; 이전 판은 `ledger-v7-before-large.json`·`ledger-v7-before-canonical2.json`). 증거는 r2 보관소의 addendum `release-blockers-20261012-1OW40e-r3`에 보관한다.

## 4. 미실행·차단·판정

**출시 판정 NO_GO 유지.** 네 항목의 로컬 결함은 해소됐지만 필수 게이트의 사람·자격·장비 조건은 그대로다.

- 네 항목: A 정확도 개발 기준선 81사례 실패 0(제품 TS 후보 + 도구 span; 독립 주석·blind review BLOCKED), B medium 증분 RSS 두 후보 네 회차 4GiB 이내(고부하 진단, 정식 20회 NOT_RUN; 1회차 여유 35~57MiB로 얇음 — TS 슬라이스 예산·PostgreSQL 설정은 다음 선택지), C U8 20행 PASS(U10b O2 BLOCKED), D E-12 PASS(매트릭스 15 PASS·0 FAIL·2 NOT_RUN).
- large(2026-10-13 추가, §3.6): large smoke-2 `run-uyUKW5` 두 회차 증분 6GiB 이내이나 1회차 수집 INCOMPLETE(DIAGNOSTIC_ONLY/INVALID_LOAD); large canonical 2차 PASS(21범주 일치) — 배터리 전원에서 사용자 결정 정책으로 실행, INVALID_POWER로 시간 수용 없음. 정식 20회 NOT_RUN. 전원 손실·OS picker 사람 클릭·전체 복구 매트릭스 NOT RUN.
- 차단(자격·장비·사람): Developer ID 서명·공증·staple·clean Mac/최소OS·실제 update host·U10b 실제 Team ID 재서명(O2), 실제 Keychain·GitHub 전체 수명주기·실계정, 독립 보안 검토·사람 UX 8명/VoiceOver·법률/발행자/운영 승인.
- 호스트: 다른 세션의 Homebrew 재링크로 brew node 26이 깨진 상태는 사용자 조치(`brew reinstall node` 또는 relink)로 남긴다. 이 라운드의 node 24 실행과 DYLD 통과는 결과에 기록했다.
- 유료 AI·실계정·실제 Keychain·정식 서명/공증·GitHub Actions dispatch는 사용하지 않았다. 사용자 원본 파일, 기존 보관본·실패 증거, INT의 `.native-update-*` 네 디렉터리는 보존했다.

원시 결과와 SHA-256은 로컬 `validation/local/blockers-20261011/ledger-v7.json`에서 연결한다. 이전 후보(k0ECto, xtq4U4)의 PASS를 1OW40e로 상속하지 않았고, 단위 시험이나 synthetic 진단으로 미충족 조건을 대체하지 않는다.
