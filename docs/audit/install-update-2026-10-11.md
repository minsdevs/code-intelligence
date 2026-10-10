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

<채움: 후보 ID, 행별 PASS/FAIL/NOT_RUN/BLOCKED, 증거 경로>

## 4. 통합 회귀·후보·패키지·smoke·canonical

<채움>

## 5. 정확도 개발 기준선 재측정

<채움: baseline-<id>, 실패 case 15 → n, unmatched, namespace 판정>

## 6. import-evidence·C06/migration 매트릭스와 디스크 정리

디스크: `retire-candidate-dependencies-v3.py`(검증 helper 63b3d7a1… 재사용, `--apply`는 native lock 보유 필수)로 build-AZJ6T6/OP2XUl/IvEZVf의 `work/desktop/node_modules` 3개를 INT의 live 사본과 byte-identical 확인 뒤 제거했다(`candidate-dependency-cleanup-v3-ni7y2gge/result.json`, VERIFIED_DUPLICATES_RETIRED, 가용 7.79→8.79GB). 같은 세 빌드의 frontend·ts-analyzer 사본은 INT live 사본과도 보존 중인 build-yIrzd4 사본과도 inventory가 달라(REFUSED_MISMATCH) **삭제하지 않았다**(승인 범위는 byte-identical 사본만). 결과 JSON·앱은 그대로다.

<채움: import-evidence backend/native, C06/legacy-migration 결과>

## 7. 배포물 문서

`docs/release/third-party-source-availability.md`(JRE 정확한 대응 소스 태그·아카이브·빌드 스크립트 기록, 제안 문구는 법률 검토 전; jmh-core 제외는 빌드와 SBOM 정책으로 보장), `support-policy.md`, `install-and-recovery.md`, `release-notes-draft.md`(값은 최종 후보에서만 채움). 법률 판단은 쓰지 않았다.

## 8. 미실행·차단·판정

<채움>
