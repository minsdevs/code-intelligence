# 설치·업데이트 라운드 감사 — 2026-10-11

브랜치 `release/install-update-20261011`(원본 main 047da03 = PR #116 뒤). 조정 작업트리 COORD, 검증 작업트리 INT(detached). 서브에이전트 0명. 이 문서는 사용자 결정 두 건의 기록, 구현 변경, 실제 실행 증거, 미실행·차단 항목을 적는다. **출시 판정은 NO_GO 유지**(사람 게이트 미해소).

## 1. 사용자 결정(2026-10-11 확정)과 적용 위치

| 결정 | 내용 | 적용 |
| --- | --- | --- |
| 정식 측정 덮개 조건(1안) | 20회 admission 필수 조건은 AC·load1<4·mdworker_shared≤6·30초 간격 3회 연속. 덮개 OPEN은 필수에서 **기록**으로 낮춘다. 이 결정 이후 측정만 정식 비교, 이전 진단 수치는 PASS로 바꾸지 않음 | 05 §4 "정식 측정 admission" 문단; `run-workload-benchmark.cjs` `waitForQuietHost`(`lidPolicy=RECORDED_NOT_REQUIRED`, `lidStates` 기록); `workload-metrics.test.cjs` 2건 |
| 증분 단계 전체 앱 RSS 상한(a안) | 초기 분석과 같은 등급 상한(medium 4GiB, large 6GiB)을 증분 행에 적용하고, refresh 중 이전 스냅샷 보유 메모리 해제를 구현 | 05 §4 증분 행·"증분 RSS 상한 결정" 문단; `workload-metrics.cjs` `incremental.medium`/`incremental.large` rssKiB; 백엔드 `StepHeapRelease`; `jvm-options.cjs` |
| 디스크 정리 사전 승인 | build-AZJ6T6/OP2XUl/IvEZVf의 byte-identical 의존성 사본만 검증 retirement 절차로 제거(결과 JSON·앱 보존). 그 외 삭제 금지 | §6 |

## 2. 구현 변경(소스 da580ad)

### 2.1 설치·업데이트 — 제품 updater의 패키지 실행 경로

NU-01..03(updater·pre-migration checkpoint·rollback floor)은 2026-10-07 구현됐으나 패키지 수용은 NOT RUN이었다(출시 키·호스트·Team ID 부재로 updater 비활성). 이번 라운드는 **Validation 후보 전용 빌드타임 루프백 피드**를 추가해 제품 코드 경로(`update-service.cjs`·`update-startup.cjs`·`update-checkpoint.cjs`·area-B floor)를 실제 패키지에서 끝까지 돌릴 수 있게 했다.

- `desktop/src/update-validation-feed.cjs`(신규): package.json(app.asar 내부, 무결성 검사 대상)의 `validationUpdateFeed`를 읽는다. 패키지 이름이 `code-intelligence-validation`이 아니거나 필드가 하나라도 벗어나면 `UPDATE_VALIDATION_FEED_REFUSED`. 피드는 호스트(점 포함 호스트명, IP 리터럴 거부)·포트(1024~65535)·fixture CA PEM·Ed25519 공개키·fixture Team ID·manifest 경로다. 피드로 만든 키 파일은 제품 파서 `parseUpdateKeys`를 그대로 통과해야 한다. 요청 어댑터는 fixture 호스트만 127.0.0.1로 연결하고 체인을 fixture CA에 고정하며 DNS를 쓰지 않는다(`electronRequest` 비사용). 도구 러너는 `codesign --verify/-dv`·`hdiutil`·`ditto`는 실제로 실행하고 **Team ID(ad-hoc은 없음)·spctl 공증 평가·stapler만 시뮬레이션**하며 시뮬레이션 항목을 `simulatedIdentity`로 상태에 남긴다.
- `update-startup.cjs`: `metadata` 인자 추가. 피드가 있으면 피드 설정·요청·러너를, 없으면 기존 `build/update-keys.json`과 `electronRequest`·`createProcessRunner`를 그대로 쓴다. 메뉴 항목에 `id: 'check-for-updates'`를 부여하고 `checkForUpdates()`·`updateStatus()`(validationFeed, simulatedIdentity)를 노출한다. `main.cjs`는 `packageMetadata`를 넘긴다.
- `desktop-build-gate.cjs`: `requireValidationOnlyUpdateFeed` — 피드가 있는데 validation appId의 `dir` 빌드가 아니면 `VALIDATION_UPDATE_FEED_REFUSED`(PK-08 fake provider와 같은 규칙).
- `build-candidate.cjs`: 선택 인자 `--update-feed <feed.json>`; 제품 리더로 검증한 뒤 `extraMetadata.validationUpdateFeed`에 넣고 build result에 공개 지표(host, port, keyId, teamId, CA/공개키 SHA-256)만 기록한다.
- `validation/pre-release/update-acceptance-fixture.cjs`(신규): fixture CA·서버 인증서·Ed25519 manifest 키 생성(0600, `validation/local` 아래). `update-acceptance-packaged.cjs`(신규): C14 U1–U10 행을 Validation 후보에서 실행한다(§3).
- 시험: `update-validation-feed.test.cjs` 6, `update-startup-feed.test.cjs` 3(피드 없음 → 비활성, 비validation 패키지 거부, 피드 → 메뉴·검증·거부/제공 다이얼로그), `ai-egress-boundary.test.cjs` 네트워크 모듈 인벤토리에 피드 모듈 추가(사유 기록), `build-candidate.test.cjs` 인자 2건. desktop 전체 3,289 PASS·0 FAIL·45 SKIP(COORD, 2026-10-11 04:0x).

### 2.2 증분 refresh 메모리 — 원인 계측과 감축

ZO7qZn large run-UsLN1e의 `resource-samples.csv`(453,276행)를 프로세스별로 다시 집계했다. INCREMENTAL peak 5.91/6.20GiB 시점의 구성은 **백엔드 JVM 2.21/2.48GiB + TS 분석기 worker 1.75/1.74GiB + Electron main 0.33 + 그 외 약 1.6GiB**다. 분석 단계가 끝난 뒤 GRAPH·INCREMENTAL 초반 약 260초 동안 JVM은 2.19GiB에 머물렀고(`-Xmx2048m`, SerialGC는 full GC 전까지 old 세대를 반환하지 않음), refresh의 TS_PARSING에서 worker가 뜨는 약 80초 구간이 run peak다. 즉 "이전 스냅샷 보유 메모리"의 실체는 Java 분석 결과·파스 트리의 **커밋된 채 회수되지 않은 heap**이다(JavaAnalyzer의 의도적 재사용 캐시는 ≤256MiB로 별도).

변경: 백엔드 `StepHeapRelease`(신규 `@Component`) — `JobWorker.runStep`이 SOURCE_PARSING·GRAPH_BUILD·TS_PARSING·TREE_PARSING 완료 뒤와 job 종료(`finally`)에 `System.gc()`를 호출하고 커밋 heap 전후를 로그에 남긴다. 데스크톱 `BACKEND_JVM_OPTIONS`에 `-XX:MaxHeapFreeRatio=50 -XX:-ShrinkHeapInSteps` 추가(성장 조건 MinHeapFreeRatio 불변, 단계적 축소 대신 한 번에). 분석 결과는 바뀌지 않는다. 시험 `StepHeapReleaseTest` 3, `main-runtime-gateway.test` JVM 옵션 고정 2곳 갱신. **측정은 §4**(AC 전원이 있을 때만 smoke-2 diagnostic 가능).

### 2.3 정확도 D3–D9(측정 도구·개발 기준선 범위)

| 항목 | 변경 | 시험 |
| --- | --- | --- |
| D3 Java abstention | `JavaAnalyzer.visitCall`: 프로젝트 후보가 전혀 없는 호출을 호출자 METHOD 노드 metadata `unresolvedCalls[{expression,lineStart,lineEnd,reason:EXTERNAL_TARGET,(declaringType|receiverType)}]`로 공개. `EventKind.UNRESOLVED_CALL`로 증분 tape에 기록·재생 | `JavaAbstentionEvidenceTest` (Class.forName, SpringApplication-류 외부 호출, orElseThrow) |
| D7 상속 clause span | EXTENDS/IMPLEMENTS edge metadata `{clause, lineStart, lineEnd, expression, filePath}` | 동일 |
| D8 상속 placeholder METHOD | 프로젝트 소스에 선언이 없는 수신 타입 메서드 stub은 filePath null + `{inherited:true, provenance:INHERITED}`; `ownerFile` 제거 | 동일 |
| D5 SQL parse verdict | `SqlMigrationAnalyzer` → `GraphCollector.outcome`: 파일별 SUCCESS/`SQL_PARSED`, FAILED/`SQL_PARSE_FAILED`(AnalysisResult.fileOutcomes) | `SqlMigrationSpanOutcomeTest` |
| D6 SQL span | DB_TABLE lineStart/lineEnd = CREATE 문의 텍스트 세그먼트 줄(jsqlparser 5.3 CreateTable은 위치를 주지 않아 `;` 분리 세그먼트와 1:1 정렬될 때만 적용), 컬럼 metadata에 `lineStart/lineEnd`(해당 문 안에서 컬럼명으로 시작하는 유일한 줄), 다른 파일의 ALTER 컬럼은 span 미주장 | 동일 |
| D4 TS 구문 오류 | `ts-extractor.ts`: 프로그램 구성 전 `partitionBySyntax`(파일별 syntactic diagnostics, 코드·위치만)로 깨진 파일을 제외하고 나머지를 분석. 깨진 파일 FAILED/`TS_SYNTAX_ERROR`, 나머지는 SUCCESS 대신 PARTIAL/`SYNTAX_IN_PROJECT`, 프로젝트 전역 사실(routes·endpoints) 보류. 전체 거부(400 TS_SYNTAX_ERROR) 경로와 백엔드 `TsSyntaxInputException`은 호환을 위해 유지. **기준 변경**: 이전의 "구문 오류 하나가 TS 프로젝트 전체를 거부" 설계를 파일별 판정으로 바꿨다(fail-closed 유지: 성공 주장 없음, 전역 사실 보류) | `ts-extractor.test` syntax 블록 5, `incremental.test`, `ts-scale.test`, `analyze.service.test`; ts-analyzer 전체 319 PASS |
| D9 namespace | 제품은 노드별 `area_type`(project_areas)을 dump에 이미 공개. 측정 도구 `accuracy-observations.cjs`가 모든 fact의 파일 area 존재와 roster namespace↔area 1:1 일관성을 `audit.evidence.namespace`로 판정 | `accuracy-observations.test` 4 |

측정 도구(`accuracy-observations.cjs`)는 Java `unresolvedCalls`(J-C), SQL 컬럼 span(끝 `,` 제외)·테이블 문 span(끝 `;` 제외), 상속 clause span(키워드가 바로 앞이면 포함), 파일 없는 상속 stub 집계, `TS_SYNTAX_ERROR`/`SQL_PARSE_FAILED` 구문 판정을 반영했다. 개발 기준선 재측정 결과는 §5.

## 3. 패키지 설치→업데이트→롤백 실행(update-acceptance-packaged)

후보 mQ5nbO의 실제 updater를 Validation 빌드타임 루프백 HTTPS 피드로 구동했다. manifest/zip 검증·checkpoint·journal·runtime은 제품 경로이며, native 대화상자 응답과 Team ID/spctl/stapler 관측만 Validation 하네스가 통제한다. 실제 Keychain 대신 mock Keychain과 새 격리 프로필을 사용했다. 정식 서명·공증·실제 update host·사용자 프로필은 사용하지 않았다.

초기 실패 증거는 보존했다: `packaged-tpGzSJ`는 Electron evaluate에서 CommonJS require를 호출해 실패한 뒤 외부300초 제한으로 종료됐고, `packaged-SBBFuD`는 공개되지 않은 bounded helper import로8행 PASS 후 실패했다. 기존 공개 timeout helper의 resolve/reject 계약을 실제 실행해 확인한 후 재시도 방식을 바꿨다. `packaged-j9Yf8P`는16행 PASS·U9b/U7b FAIL을 기록했지만, binary length-prefixed journal을 줄 단위로 세어 BUILD_STARTED2건을1건으로 오집계하고, signed recovery가 이미 floor를N으로 내린 뒤 같은N 정상 시작에도 새 floor 상승 이벤트를 요구한 하네스 판정 오류였다. 실제 journal의 N/N+1 BUILD_STARTED와 serial20 ROLLBACK_SANCTIONED를 프레임 단위로 확인했다.

하네스만 수정했다: Electron builtin 접근·종료 timeout timer 정리·소유 앱 실패 정리, 매 실행 userData 이동 후 현재 경로 사용, recovery 대화상자 응답, journal 프레임/sequence 판독, 복원 전 최신 journal prefix 보존과 sanctioned floor에서 정상 재시작 검증, 행 FAIL이면 exit1. 후보 제품 바이트는 변경하지 않았다.

수정 후 `packaged-1ORPU3` 실제 실행(exit0):18 PASS·0 FAIL·U8 NOT_RUN·U10b BLOCKED. 미인식 키/변조 manifest·아키텍처·OS·다운그레이드·가짜 서명/zip hash 거부, 정상 다운로드·확인·handoff, serial 재사용 거부, N+1 floor 상승과 이전 빌드 정상 시작 거부, migration 중 강제 종료→checkpoint 복원→upgrade 재시도, signed recovery→N 정상 시작·recovery serial 재사용 거부를 확인했다. 복원 시 실패 DB를 남기고 최신 journal prefix를 보존했다. 강제 종료 대상으로 지정한 C1 외8개 실행은 shutdown COMPLETE·exit0이었다.

증거 상태는 `ROWS_RECORDED_NOT_GATE_PASS`다. U8(old backup 복원 후 high-water 유지)은 패키지 경로 미실행, U10b(실제 다른 Team ID/ad-hoc 재서명)는 O2 차단이다. 드라이버 SHA256 `7f2ca9270518b1e1d3c43fd56cb019131f971a98dfcfa716c61100927cea5783`와 후보 asar/manifest 무변경을 기록했다. 전체 결과는 로컬 `ledger-v6.json`에 연결하며 실패 시도3건도 함께 보관한다.

## 4. 통합 회귀·후보·패키지·smoke·canonical

제품 소스 `da580ad362a770316fd959e0886ecad7cc968be5`의 통합 회귀는 **6,638 PASS·0 FAIL·63 SKIP**, TypeScript 확인 완료다. 후보 **mQ5nbO**(`build-ybYiBX`, xpc-required)는 PACKAGED_NOT_RELEASED이며 소스/베이스라인 불변이다. 제품36·owner-crash 두 경계6/6씩·job-race8 PASS, 내부 보안 COMPLETE, loader·egress OFF·ASK PASS. 자동 UX는190화면·machineErrors0·pageErrors0·consoleErrors3이며 사람 수용이 아니다. 새 startup probe `run-wietUa` 3샘플은 COMPLETE_DIAGNOSTIC이다.

medium `run-4nd3V8`의 warm-up 및2회차 기능 PASS·수집 COMPLETE·모든 종료 확인. 원시 CSV 합계/phase peak, 실제 PPID와 launchd-owned XPC 포함, 후보/manifest 해시 불변을 `medium-mQ5nbO-verification.json`으로 재계산 검증했다. AC·덮개 OPEN이지만 부하 기준 초과로 **DIAGNOSTIC_ONLY / INVALID_LOAD**다.

| medium 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 분석/증분 최대 수집 간격(ms) | 증분4GiB 상한 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 142.395 | 54.013 | 3,606,784 | 4,154,240 | 123 / 139 | 이내 |
| 2 | 139.076 | 56.344 | 3,554,960 | 4,240,176 | 188 / 111 | **초과** |

증분 상한4,194,304KiB를 둘째 회차가45,872KiB 초과했다. StepHeapRelease/JVM 축소 옵션이 추가됐어도 상한을 충족했다고 주장하지 않는다. 정식20회는 NOT_RUN이며 시간·RSS 수용은 미통과다.

large `run-Ce9FCa`도 warm-up 및2회차 기능 PASS·수집 COMPLETE·모든 종료 확인. `large-mQ5nbO-verification.json`이 원시 CSV 합계/phase peak·XPC 소유권·후보 해시를 검증했다(XPC7,063행·launchd3,535행). AC에서 실행했지만 부하 기준 초과로 **DIAGNOSTIC_ONLY / INVALID_LOAD**, 정식 수용은 아니다.

| large 회차 | 초기 분석(s) | 1% refresh(s) | 분석 RSS(KiB) | 증분 RSS(KiB) | 분석/증분 최대 수집 간격(ms) | 증분6GiB 상한 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 524.743 | 404.431 | 4,722,768 | 5,398,048 | 170 / 195 | 이내 |
| 2 | 521.711 | 388.019 | 4,659,040 | 5,167,312 | 154 / 224 | 이내 |

large 증분 두 회차는 상한6,291,456KiB 이내다. 같은 소스의 medium 초과를 덮지 않으며, 두 번의 진단으로20회 p95나 정식 지원 등급을 승인하지 않는다.

**새 후보 canonical PASS**: INT `gate-latency-20261010/canonical-large-S83Fef/result.json`에서 실제 packaged large 증분 결과와 변경된 동일 fixture를 새 프로필로 처음부터 분석한 결과가21범주의 개수·정규화 SHA-256 모두 일치했다(`resultEqualsFull=true`). 파일49,999·노드768,168·간선1,351,932·source evidence695,657개를 포함한다. 삭제 파일의 옛 snapshot 존재/새 결과 부재와 변경 전파를 확인했고 두 앱 모두 exit0·cleanupConfirmed다. DB 생성 ID·타임스탬프·행 순서는 기록된 semantic-key oracle 정책으로 정규화했다. 후보 app.asar·manifest 해시는 실행 전후 동일하다.

## 5. 정확도 개발 기준선 재측정

INT `accuracy-export/install-update-EZW4kN`(da580ad, 제품 경로 dirty 0)의 실제 Spring pipeline·PostgreSQL·TS sidecar export가 완료됐다. `accuracy-baseline.cjs` 재평가: 개발 자료81사례에서 **실패15→2·unmatched1→2·false-resolved0**. 남은 두 사례는 T-C `dev-typescript-calls.candidates`(기대 INFERRED 후보2개, 관측 UNRESOLVED_TARGET)와 SQL-S `dev-todo.sqls.table`(같은 sql:todos이지만 기대 span end118·관측117)다. 금본위·임계치를 바꾸지 않았고 두 실패를 보존했다. T00 gate는 FAIL(exit1), 독립 주석·blind real-repo review는 여전히 BLOCKED다. 개발 기준선 결과를 정확도 수용으로 대체하지 않는다.

## 6. import-evidence·C06/migration 매트릭스와 디스크 정리

디스크: `retire-candidate-dependencies-v3.py`(검증 helper 63b3d7a1… 재사용, `--apply`는 native lock 보유 필수)로 build-AZJ6T6/OP2XUl/IvEZVf의 `work/desktop/node_modules` 3개를 INT의 live 사본과 byte-identical 확인 뒤 제거했다(`candidate-dependency-cleanup-v3-ni7y2gge/result.json`, VERIFIED_DUPLICATES_RETIRED, 가용 7.79→8.79GB). 같은 세 빌드의 frontend·ts-analyzer 사본은 INT live 사본과도 보존 중인 build-yIrzd4 사본과도 inventory가 달라(REFUSED_MISMATCH) **삭제하지 않았다**(승인 범위는 byte-identical 사본만). 결과 JSON·앱은 그대로다.

새 backend `import-evidence/backend-aOXu00`: **574 PASS·0 FAIL·1 SKIP**. C05 72사례 전부 PASS, C06는14 PASS·1 명시적 R2 SKIP, 13라운드/43스냅샷 감사에서4,958사실 검사·실패0(CONFIG·MIGRATION 포함), legacy note-pinned snapshot/file 보존 확인. Flyway V1→V29 29단계·sentinel14개 보존. 새 후보의 `native-OtYNcw`: **14검사 PASS**, 첫/재분석 후 옛/새 스냅샷 사실29/29/31개·파일각8개 검증·실패0, secret sentinel 유출0·원본 무변경·정상 종료·후보 해시 불변.

행별 매트릭스 `validation/local/install-update-20261011/c06-matrix-mQ5nbO.json`: **14 PASS·1 FAIL·2 NOT_RUN**. E-02(CONFIG/MIGRATION span), E-10(legacy pin), E-15(packaged facts)는 이번 증거로 PASS; E-12는 P 이외 S/C/F/X capability partition이 NOT_RECORDED여서 FAIL 유지. E-16 R2 SFC·E-17 AI 증거 수용은 NOT_RUN. 파괴적 retained-source GC를 구현했다고 주장하지 않으며, 실제 OS picker 사람 클릭·독립 real-repo 검토도 수용되지 않았다. 이전 감사의 실패 기록은 그대로 보존한다.

## 7. 배포물 문서

`docs/release/third-party-source-availability.md`(JRE 대응 소스 태그·아카이브·빌드 스크립트 기록, 제안 문구는 법률 검토 전; jmh-core 제외는 빌드와 SBOM 정책으로 보장), `support-policy.md`, `install-and-recovery.md`, `release-notes-draft.md`를 작성했다. 릴리스노트의 해시는 보존한 Validation 후보의 값이며, 정식 배포물·Team ID·공증은 NOT_AVAILABLE로 구분했다. medium 증분 RSS 초과·정확도 개발 사례2개 실패·정식20회 NOT_RUN을 명시한다. 법률 판단은 쓰지 않았다.

## 8. 미실행·차단·판정

**출시 판정 NO_GO 유지.** 이번 변경과 검증 결과의 소스 병합은 제품 출시 승인이 아니다.

- 성능: medium 둘째 증분 RSS가4GiB 초과. medium/large 관측은 AC 고부하 진단이며 정식20회 NOT_RUN.
- 정확도·증거: 개발 기준선2사례 실패와 S/C/F/X capability partition 미기록(E-12 FAIL), 독립 주석·blind real-repo review 미완료.
- 배포·업데이트: 정식 Developer ID·공증·staple·실제 update host·clean Mac/최소OS와 U10b 실제 Team ID 거부는 BLOCKED O2. U8 이전 백업 복원 후 floor 수용은 패키지 NOT_RUN.
- 실권한·독립 수용: 실제 Keychain·GitHub 전체 수명주기·전원 손실·OS picker 사람 클릭·독립 보안·사용자8명/VoiceOver·법률/발행자/운영 소유 승인은 미수용이다.
- 유료 AI·실계정·실제 Keychain·정식 서명/공증·Actions 실행을 사용하지 않았다. 사용자 원본 파일·기존 archive·실패 증거는 보존한다.

원시 결과와 SHA-256은 비공개 로컬 `validation/local/install-update-20261011/ledger-v6.json`에서 연결한다. 이전 후보의 PASS를 상속하지 않으며, 단위 시험이나 synthetic 진단으로 위 미충족 조건을 대체하지 않는다.
