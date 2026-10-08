# w17 — TS/tree 증분 파싱 (2026-10-08)

기준: `6ddeefb`, 기존 후보 `h7hpw4`의 감사. 작업 브랜치: `release/w17-adapter-incremental-20261008`.
후보 재빌드·서명·패키지 실행·전체 회귀·20회 성능 게이트는 수행하지 않았다. 릴리스 판정은 변경하지 않는다.
제품 커밋: `ce8629e` (TS 추출기 RED→GREEN), `f982eeb` (backend 소유 cache·인증·Tree·실제 transport/mapper smoke).

## 구현 계약

- 캐시 소유자는 job별로 종료되는 Node worker가 아니라 backend singleton parsing step이다. 프로젝트/경로별 immutable 문자열 결과를 메모리에만 보관한다. 각 adapter owner의 문자열 예산은 16 MiB, 항목은 128 KiB, 개수는 50,000 이하이다. AST·원문 디스크 캐시는 없다. backend 종료 시 결과와 인증키가 함께 폐기된다.
- 기존 TS `open → put → seal → analyze → page → close`를 유지한다. 전체 source manifest를 다시 전달하며 `path\nsha256(content)\n` digest에는 재사용 데이터가 섞이지 않는다. 선택적 `FilePayload.cache`, 응답 `cache`, request/open의 `cacheKey`만 추가했다. chunk JSON에는 cache의 escaping 비용도 포함하며, 10 MiB request/1 MiB result page/50,000개·512 MiB source 한도를 완화하지 않았다.
- backend 수명 256-bit 메모리 키로 결과를 HMAC 인증한다. 원문은 JSON 문자열일 뿐 cache/facts로 해석되지 않는다. 키·토큰·소스는 계측 로그에 기록하지 않는다. 잘못된 인증, binary/key 불일치, 손상·과대 항목은 재계산한다. 영구 키 저장이나 사용자 설정은 없다.
- TS 키는 실제 content hash, 전체 경로 inventory, config/module 입력, 전이 import/export 의존성, 글로벌 선언, Nest provider/prefix 입력, analyzer 코드·compiler/lockfile 버전을 포함한다. SCC 축약과 메모이제이션으로 순환/긴 의존 체인을 반복 확장하지 않는다. config/global/Nest context digest는 호출당 한 번 계산한다. 동적 import·type/lib reference 등 불완전한 의존성은 전체 manifest key/program으로 보수적으로 계산한다.
- 유효한 파일별 phase 결과만 기존 slice 병합에 넣는다. 변경 파일과 역의존 파일은 재파싱하고 전체 pass/file/emission 순서, 중복 edge/node 처리, route ambiguity, outcome을 재구성한다. 16 MiB 이하 최초 계산은 하나의 transient compiler program을 Nest/추출 pass에서 공유한다. AST는 호출 밖에 보관하지 않는다. 큰 입력의 기존 bounded slicing/escalation은 유지한다.
- Tree는 Python module resolution에 전체 `localPaths`를 전달해 40개 배치 경계에서도 import를 유지한다. 현재 Python extractor의 외부 입력은 경로 inventory이며 Go/Vue/Svelte 추출은 해당 파일 내용에 의존한다. 키에 실제 파일 내용·전체 경로·rule/grammar lockfile identity를 포함한다. 삭제/추가/rename 시 갱신한다. JSON body는 경로 목록·cache·인증키를 포함해 10 MiB 안에서 배치한다.
- Graph mapper/persistence에는 기존 전체 결과를 전달한다. transport client/exception, import/source-vault/SQL inventory, Java 파서는 수정하지 않았다.

## RED → GREEN

모든 무거운 명령 앞에서 공통 `wait-quiet.sh`를 실행했다. 지정 worktree에 두 analyzer dependency가 이미 있어서 setup 복제를 반복하지 않았다. 실패 로그를 보존했다.

| 대상 | RED | GREEN / 증거 |
| --- | --- | --- |
| TS per-file 재사용 | 신규 `incremental.test.ts`: 2 실패 / 7 통과 (`first.cache` 없음) | 최종 TS 대상 7파일, 37 통과 / 0 실패 |
| 종료된 worker 뒤 TS session | 신규 `incremental-session.test.ts`: 1 실패 (`first.cache` 없음) | 새 service/sealed session과 실제 새 stdio process 재사용 통과 |
| Tree 재사용·전체 module 경로 | 신규 `incremental.test.ts`: 2 실패 / 1 통과 (`cache` 없음) | Tree 대상 3파일, 15 통과 / 0 실패 |
| Backend 소유권·DTO·byte budget·mapper | 대상 Gradle 실제 실행 | 8클래스, 19 통과 / 0 실패 / 0 skip |

증거 루트: `validation/local/w17-adapter-incremental/`.

- RED: `ts-red.log`, `session-red.log`, `tree-red.log`.
- 중간 GREEN: `ts-green-1.log`, `ts-session-green-1.log`, `tree-green-1.log`, `backend-green-1.log`, `ts-target-2.log`.
- 최종 analyzer build/대상 테스트/실제 stdio+HTTP smoke: `adapters-final-1.log`.
- 실제 graph 출력 smoke: `stdio-http-graph-smoke.log`, `graphs-final-1/{ts,tree}-{incremental,full}.json` (합성 입력의 graph만, cache/인증키 제외).
- Backend 19개: `backend-final-2.log`, `backend/build/test-results/test/TEST-*.xml`.
- 수정 Java 13개 한정 실제 포맷 적용: `format-selected.log`. 앞선 `spotlessIdeHook` 호출은 `IS DIRTY`/apply skip만 했으므로 포맷 성공으로 세지 않았다. 이후 임시 init script로 target을 13개로 한정하여 `spotlessJavaApply`를 실행했고 임시 script는 제거했다.

## 실제 refresh smoke

`validation/analyzer-transport-integration/incremental-smoke.cjs`는 각 cold/refresh/clean 실행마다 **새 프로세스**를 시작한다. TS는 실제 production `dist/stdio.js` handshake와 모든 session 명령을 사용한다. 240파일·1 MiB 합성 workload에서 함수 본문에 fetch 호출을 추가하여 추출 사실 자체가 바뀌는 것을 확인했다. 별도의 cache 없는 worker에서 독립 full을 계산해 전체 응답을 정확히 비교했다.

| 경로 | cold | 본문 수정 refresh | 무변경 refresh |
| --- | --- | --- | --- |
| TS compiler에 실제 들어간 파일 수 (Nest context 재파싱 포함) | 134 | 60 (133개 결과 재사용) | 0 (134개 결과 재사용) |
| Tree stdio | 5 parse | 1 parse / 4 reuse | 별도 측정 안 함 |
| Tree 실제 loopback HTTP `/analyze` | 새 process cold | 1 parse / 4 reuse | 별도 측정 안 함 |

실제 출력의 backend mapper 비교도 수행했다. TS: **nodes 1,288 / edges 2,562 / evidence 1,288 / outcomes 134**, Tree: **nodes 5 / edges 3 / evidence 2 / outcomes 5**. `AnalysisResult` 전체와 outcome이 독립 full과 같다. 단순 count 비교를 equality 증거로 사용하지 않았다.

- TS canonical response SHA-256: `45406fe8f270da165f7341ff5848cdd46e7d59bf20746a33239058fbe6843722`.
- Tree canonical response SHA-256: `a13ce97a2557122fc74d4b2c62be42e9b1d9a5acfb1977014b4be7093a642cb5`.
- 추가 결정적 회귀: 본문/export signature, importer·barrel·순환 의존성, config/global/Nest prefix/provider, unresolved→resolved, 추가/삭제/rename, 구문 오류, 손상/위조/다른 backend 키, 프로젝트 격리, 6,000파일 import chain, 기존 slice-vs-full 비교. 새 테스트는 시간 성능을 assertion으로 삼지 않는다.

## 명령

RED는 해당 analyzer 디렉터리에서 각각 실행했다:

```sh
./node_modules/.bin/vitest run src/incremental.test.ts
# TS session RED
./node_modules/.bin/vitest run src/incremental-session.test.ts
```

최종 adapter 명령 (각 analyzer 디렉터리):

```sh
# analyzers/ts-analyzer
npm run build
./node_modules/.bin/vitest run --maxWorkers=1 src/incremental.test.ts src/incremental-session.test.ts src/ts-scale.test.ts src/analyze-session.test.ts src/analyze.service.test.ts src/analyze.service.lazy.test.ts src/stdio-transport.test.ts
# analyzers/tree-analyzer
npm run build
./node_modules/.bin/vitest run src/incremental.test.ts src/extract.test.ts src/stdio-transport.test.ts
```

Graph smoke는 worktree 루트에서 실행했다. 같은 디렉터리에 재실행하여 기존 증거를 덮어쓰지 않는다.

```sh
export ADAPTER_REFRESH_SMOKE_DIR="$PWD/validation/local/w17-adapter-incremental/graphs-final-1"
node validation/analyzer-transport-integration/incremental-smoke.cjs
```

동일 환경에서 backend 대상 테스트를 실행했다 (`backend-final-2.log`; 실제 호출에는 먼저 13파일의 `spotlessJavaApply -PspotlessIdeHook=...`도 포함되었으나 위 설명대로 apply는 skip):

```sh
cd backend
./gradlew --offline --no-daemon --max-workers=2 cleanTest test \
  --tests dev.codeintelligence.analysis.core.AdapterResultCacheTest \
  --tests dev.codeintelligence.analysis.ts.TsParsingStepTest \
  --tests dev.codeintelligence.analysis.ts.TsAnalyzeDtosTest \
  --tests dev.codeintelligence.analysis.ts.TsRequestBudgetTest \
  --tests dev.codeintelligence.analysis.ts.TsProjectSessionTimeoutTest \
  --tests dev.codeintelligence.analysis.ts.TsIncrementalGraphSmokeTest \
  --tests dev.codeintelligence.analysis.tree.TreeParsingStepTest \
  --tests dev.codeintelligence.analysis.tree.TreeIncrementalGraphSmokeTest
```

## 변경 범위 / 공유 문서 제안

- TS: `incremental-cache`, extractor/slices, types/service/session, 해당 회귀.
- Tree: `incremental-cache`, extractor, request/types, HTTP/stdio entry, 해당 회귀.
- Backend: `core/AdapterResultCache`, TS/Tree parsing step·DTO, TS project session/request budget, 소유권/mapper 회귀.
- 재사용 가능한 실제 adapter smoke와 이 단위 감사만 추가했다. shared README/plan은 수정하지 않았다.

공유 03 §6 제안: “증분 adapter 결과는 backend 프로세스 수명 메모리에 한정한다. 파일별 blob·binary/grammar/rule·contract/config/module·의존 closure와 완전 manifest를 재검증하며 source/context는 생략하지 않는다. 인증·범위·크기·의존성이 불확실하면 재계산한다. Node worker 종료 뒤에도 backend 소유 cache로 refresh를 수행하며 disk source cache는 만들지 않는다.”

## NOT RUN / 통합 담당 확인

- 새 후보의 packaged Java/TS refresh·medium/large smoke·large ≤600s, 최종 20회 게이트: **NOT RUN**, coordinator 담당. 위 parse-count 감소를 packaged 시간 게이트 통과로 해석하지 않는다.
- Tree는 현재 macOS 후보에 포함되지 않는 외부 HTTP 서비스다. HTTP/stdio 자체 smoke만 입증했으며 Tree packaged acceptance로 주장하지 않는다.
- Backend/TS 전체 회귀, desktop/frontend 전체 회귀, signing/notarization/Actions/push: **NOT RUN**.
- mapper smoke 테스트는 `ADAPTER_REFRESH_SMOKE_DIR`가 없으면 명시적으로 skip되므로 통합 시 위 실제 adapter smoke를 먼저 실행하고 같은 환경을 전달해야 한다.

## 통합 전 후속 수정 — 실제 혼합 Nest 1% revision

기존 Nest 후보의 dependency blob을 전역 context에 넣던 키는 module→controller/service의 단순 revision 변경도 모든 TS 결과를 무효화했다. 위 최초 완료 기록은 이 패턴까지 입증하지 못했으므로 아래 후속 결과로 보완한다.

- 기존 provider/token/ref, provider method의 key/name/filePath, global-prefix facts를 정규화하여 호출당 한 번 전역 digest를 만든다. 본문·revision 상수는 해당 파일과 역의존 closure만 무효화한다. 실제 config/package 소비자 분류도 resolver와 공유하여 Java 등 비설정 원문 변경을 TS 전역 설정 변경으로 취급하지 않는다.
- 완전 manifest가 동일한 경우만 HMAC으로 인증된 manifest/key/rows fast path를 사용한다. 다른 manifest에서는 실제 Nest facts를 다시 수집한 뒤 파일 키를 비교한다. provider/token/method/prefix가 바뀌면 전역 무효화한다. v2 토큰의 manifest까지 인증하며 위조 시 full 재계산한다. binary identity·한도·디스크 비저장 정책은 유지한다.
- 실제 `generateWorkload` + `mutateWorkload`를 그대로 사용했다: 합성 1,200파일/6 MiB, `g-perf-1`, 기본 1%·`g-perf-change-1`. 12개 revision 변경 중 Nest service 2개를 포함하며 TS 실제 inventory에서는 8개가 변경된다. generator/selection/기본 비율/오라클은 수정하지 않았다. 이 작은 결정적 회귀는 G-PERF 크기별/20회 게이트가 아니다.
- 신규 RED `nest-revision-red-3.log`: **1 실패**, full equality는 성립하지만 reuse=0. 앞선 `nest-revision-red.log`(macOS realpath fixture 계약)와 `nest-revision-red-2.log`(600파일 seed 선택에 Nest service 없음)는 fixture 준비 실패로 구분하여 보존했다.
- 최종 `nest-target-final.log`: TS build 성공, **8파일 39 통과 / 0 실패**. 새 회귀는 실제 revision 선택, 독립 clean-full 정확한 전체 응답 equality, provider/token/method/prefix 의미 변경, unchanged→edit 연속 refresh, manifest 위조 거부를 검증했다. 기존 syntax/limits/session/transport 대상을 함께 실행했다.
- 실제 production framed session smoke에서 **매 실행 새 worker**를 사용하고 전체 TS/config inventory 663개를 전달했다. cold compiler files **659**, mixed 1% refresh **465** / 결과 **569개 재사용**, 다음 무변경 refresh **0 parse / 659 reuse**. 독립 cache 없는 full 응답과 정확히 같다. SHA-256: `839b35aa0fb49c39504bbc256ef9b7cd980bfd78b1c6d4e0d64ed8cb73a1ac2a`.
- 기존 graph 변화가 있는 fetch 본문 smoke도 **134→60→0 parse**와 동일 hash를 유지했다. Tree stdio/HTTP는 각각 **1 parse / 4 reuse**, 독립 full equality를 유지했다. 별도 증거: `nest-revision-transport-smoke.log`.

후속 RED 명령 (TS 디렉터리):

```sh
./node_modules/.bin/vitest run --maxWorkers=1 src/incremental-workload.test.ts
```

후속 최종 명령 (무거운 명령 전에 공통 wait-quiet 실행):

```sh
cd analyzers/ts-analyzer
npm run build
./node_modules/.bin/vitest run --maxWorkers=1 src/incremental.test.ts src/incremental-workload.test.ts src/incremental-session.test.ts src/ts-scale.test.ts src/analyze-session.test.ts src/analyze.service.test.ts src/analyze.service.lazy.test.ts src/stdio-transport.test.ts
cd ../..
node validation/analyzer-transport-integration/incremental-smoke.cjs
```

후속 변경: `incremental-cache.ts`, `ts-slices.ts`, `semantic-extractor.ts`, `incremental.test.ts`, 신규 `incremental-workload.test.ts`, 기존 transport smoke, 이 감사. Backend/Tree 제품 코드는 후속 수정하지 않았다. Backend mapper 19개는 앞선 실행 결과이며 이번 후속에서 재실행하지 않았다. 새 mixed fixture의 equality는 adapter 전체 응답 비교이며 backend mapper를 새 fixture로 다시 실행했다고 주장하지 않는다.

**NOT RUN 유지:** packaged refresh, medium/large 성능 및 large ≤600s, 20회 게이트, 전체 회귀, signing/notarization/Actions/push. 기존 커밋을 보존하고 후속 커밋으로 추가한다. shared 문서 제안의 Nest 전역 항목은 “provider/token/method/prefix 의미 facts digest”로 구체화할 수 있다.
