# w21 — TS 실제 session 성능 조사 (2026-10-08)

- 기준: 공개 main `6ddeefb`, 유닛 `f66057a164fdcf99e42d8e920957cf166d8a0627`.
- 실측 후보: `p6yGme`, product source `f0b983f`, baseline `tZgvV7`. 과거 `h7hpw4`/w17 수치는 현재 후보 시간으로 대체하지 않는다.
- 증거: `validation/local/w21-adapter-perf/`. 기존 w17 감사 및 `w17-adapter-incremental/validation/local/w17-adapter-incremental/coordinator-final/verify.log`를 읽었다. 원래 `memory://root/memory_summary.md`는 이 작업자에서 존재하지 않았다.
- 실제 large fixture는 `run-Fn31Fu/result.json`의 **50,000파일 / 209,715,200 bytes (200 MiB)**다. brief의 250 MiB는 coordinator가 오기로 정정했으며 generator·seed·목표를 바꾸지 않았다.

## 초기 profiler 관찰

`npm run build` 뒤 실제 `dist/stdio.js`의 새 프로세스마다 handshake와 `open/put/seal/analyze/page/close`를 사용했다. input은 backend와 같은 TS/JS/config 전체 목록, chunk는 JSON 기준 1 MiB다. 실제 generator `g-perf-1`, 기본 1% revision mutation을 사용하고 변경 refresh 전체 canonical JSON SHA-256를 새 cache 없는 full session과 비교했다.

`baseline-medium.log`는 다른 작업과 겹쳐 load1 10.93–27.10이었다. **시간 비교·SLO 근거로 사용하지 않는다.** CPU sample/소유 cache 동작의 원인 진단용이다.

- medium TS/config 5,503개, 26,271,681 source bytes. 결과 token 5,499개 모두 보관, backend 문자수×2 비용 15,771,406 bytes, eviction/oversize 0.
- refresh 인증 envelope 5,499개 승인; 실제 decode 2,930개 모두 성공, 호출 64 MiB 중 40,272,018 bytes 잔여. result reuse 2,330 / metadata reuse 581 / compiler 입력 합계 5,069 (cold 9,546). cap/HMAC/해제 실패로 reuse가 줄어든 것이 아니다.
- cold profile의 `collectManifestFacts` self sample 1,237,134 µs. provider마다 program 전체 method map을 prefix scan하는 중첩 순회가 확인됐다.
- cold/refresh `writtenBindings` inclusive sample 4,308,860 / 2,679,332 µs. React route가 없는 program에도 write-binding 증명을 미리 계산했다. 이 값은 겹친 CPU sample이며 wall-time 개선치가 아니다.
- 독립 full canonical equality 통과: `80f561e0c6ac6578c86ef70d1c7315c9059bd49b658cccbc58a75720d57bf264`. 원문/토큰/인증키는 로그에 쓰지 않았다.

## 변경 경계

- `semantic-extractor.ts`: metadata 소비자용 method 목록을 정확한 owner로 한 번 묶는다. method name의 quoted/computed dot을 자르지 않으며 기존 declaration/map 순서를 유지한다.
- 최종 제품 변경은 provider owner-index와 그 consumer 회귀뿐이다. provider가 없는 경우 index를 할당하지 않는다. provider alias/overload/동명 class/점 포함 method 및 cold·warm 전체 equality를 검사한다.
- React write-set 지연 계산은 실제 session precise coverage에서 cold/refresh/full 호출수 모두 1→1로 효과가 없어 원복했고 그 변경 전용 시험도 제거했다. hotspot이라는 이유만으로 입증되지 않은 최적화를 남기지 않는다.
- `AdapterResultCache`, Tree caller, SourceParsing, outcome loop, GraphPersistence, desktop bridge/supervisor는 변경하지 않는다. 신규 migration 없음.
- 50k/512 MiB source, request 10 MiB/chunk 1 MiB, 기존 source/root 증명, HMAC-before-inflate, 4 MiB/entry·64 MiB/call decode, owner 16 MiB, unknown/transitive/SCC/global/Nest 의미는 유지한다. cap 증가는 없다.

## 제한

packaged workload의 `resultEqualsFull=null`/`NOT_RUN`은 그대로다. 단독 session equality를 packaged graph equality로 주장하지 않는다. 전체 suite·새 packaged candidate·최종20회·실계정/실사용 profile/Keychain·paid AI·signing/notary·Actions·push는 **NOT_RUN**이며 릴리스 판정은 변경하지 않는다.

## 변경 없는 p6 실제 격리 worker

coordinator 승인으로 원본 p6 app의 `adapter-bridge`만 직접 실행했다. app/asar/manifest/helper는 수정·재서명하지 않았다. 제품 `attestSupervisor`의 manifest hash, codesign, sandbox-only entitlement 및 bridge entitlement 검사를 통과한 뒤 `createBridgeAdapter`로 분석했다. source-broker/import/DB 측정은 아니다.

공통 `wait-quiet.sh → with-native-lock.sh → caffeinate → env -i`, lock 내부 `QUIET-REQUIRED` 독점 생성 및 trap 정리. 각 phase 직전에 30초 간격 load1<4·mdworker≤6을 3회 확인했다. 공통 quiet에서 660초 기다린 뒤 시작하여 3회 admission 규칙이 실제 적용됐다. 타 worker DB/JFR/build와 직렬화했다.

| medium, 새 worker/session | 전체 ms | analyze ms | open ms | put 합계 ms | page 합계 ms |
|---|---:|---:|---:|---:|---:|
| cold, cache 없음 | 16,628 | 15,709 | 385 | 108 | 240 |
| 1% revision refresh | 10,911 | 10,193 | 170 | 122 | 242 |
| 독립 clean full | 15,890 | 15,247 | 171 | 105 | 208 |

매 회 5,503 input·26,271,681 source bytes. chunk 27/35/27개, page 요청 54/54/47개(첫 analyze page 제외). cold/refresh token5,499개 전부 owner 정책 안에 보관(15,770,462 bytes), eviction/oversize0. 전체 canonical hash `80f561e0c6ac6578c86ef70d1c7315c9059bd49b658cccbc58a75720d57bf264` 동일. helper가 worker TS_INCREMENTAL stderr를 전달하지 않아 native compiler/reuse 개수는 측정했다고 주장하지 않는다.

시작 load1 cold3.097 / refresh2.377 / full2.302, 종료2.920 / 2.712 / 2.998. 증거 `p6-native-medium.log`. bridge SHA-256 `1b74e6e9bb39441aa2ccbf59e3646da044d7c3b460fa7d5574e2d056cadaf90f`, supervisor SHA-256 `919914109d729dd4838388f3a4c9350c0c5b14510110630ed67d8de5325da1d8`.

**해석:** packaged TS cold92–93초 / refresh49–50초 차이는 이 실제 격리 worker/compiler/protocol 경로 자체에서 재현되지 않았다. cold→refresh 계산 감소는 존재하며 session 전송은 1초 미만이다. [INFERENCE] backend source 읽기/mapper/outcome/persistence 등 잔여 전체 경로를 분리해야 한다. 차액을 SQL 시간으로 간주하지 않으며 main이 공통 DB 구간을 별도 계측·수정한다.

## 실행 횟수 진단과 유지/폐기 결정

동일 synthetic small session(553 source/config)에 V8 precise coverage를 적용했다. baseline `f66057a` 보존 dist와 변경 dist를 각각 새 cold/refresh/full worker로 실행했다. `call-count-diagnostic.log`, `baseline-count-small-*.worker.log`, `green-count-small-*.worker.log`에 원시 block counter를 보존한다. coverage/JIT 영향 및 high load 때문에 wall-time 비교 자료가 아니다.

- 기존 `collectManifestFacts`의 provider별 전체 method loop body 79,355회 = provider 59 × method 1,345. 실제 필요한 owner method 처리 664회.
- 변경 후 전체 method index 1,345회 + owner method 처리 664회. prefix predicate 반복 대신 정확한 owner lookup을 사용한다. 전체 canonical 결과는 baseline/변경 모두 `0a7cc79abb849fd935ec8ac141261f5211bcf211e2fc74a20f8db068545e5ce5`로 동일했다.
- `writtenBindings`는 baseline/변경 모두 각 phase 1회였다. 해당 lazy 변경은 이 경로의 실제 AST 순회를 제거하지 못하므로 폐기했다.
- 이는 성능상 불필요 반복의 재현→제거와 의미 보존 증거다. 기존 의미 오류를 재현한 semantic RED라고 주장하지 않는다.

large 최초 worker 진입 전 low-load admission만 21분 지속돼 중단했다. `large-admission-cancelled.log`와 원본 `baseline-quiet-large.log` 보존. main 승인으로 반복하지 않았으며 large cache eviction/재사용 원인 및 quiet 전후 시간 비교는 **NOT_RUN**이다. 원래50k/200MiB fixture, limits, SLO는 변경하지 않았다.

## 부가 실행 경계와 backend 검증

Java20이 나중에 공개한 JFR 후처리(Java source-file mode, 21:10:40+09부터0.72초)는 quiet admission 중이었다. 보존 worker.log mtime에서 elapsed를 뺀 보수적 phase 시작 추정은 cold21:11:40.926, refresh21:13:58.183, full21:15:09.196(+09)이다. 첫 실제 worker보다60초 이전으로 분석 phase와 겹치지 않았다. 원시 mtime는 각각12:11:57.554Z /12:14:09.094Z /12:15:25.086Z다.

backend bridge/owner cache/tree 대상 **35/35 PASS, skip0**. `backend-target.log`, `backend/test-totals.json`, JUnit XML 보존. backend/core/tree 코드는 변경하지 않았으므로 공용 cache의 tree 소비 경로를 그대로 확인했다. Gradle loopback handshake/deprecation 경고는 로그에 보존했고 억제하지 않았다.

실행은 공통 quiet 후 native lock 안에서 아래 명령이다. `T`는 이번 유닛에서 만든 저장소 직하위 private `.citd-XXXXXX` 경로다.

```sh
CI_DOCKER_TEST_ROOT="$PWD/validation/local/w21-adapter-perf/backend" CI_DOCKER_TEST_TMP="$T" backend/gradlew -p backend --offline --no-daemon --max-workers=2 -I "$PWD/validation/pre-release/docker-integration.init.gradle" cleanTest test \
  --tests dev.codeintelligence.analysis.core.AdapterResultCacheTest --tests dev.codeintelligence.analysis.ts.TsAnalyzerControlClientTest \
  --tests dev.codeintelligence.analysis.ts.TsParsingStepTest --tests dev.codeintelligence.analysis.ts.TsGraphMapperTest \
  --tests dev.codeintelligence.analysis.ts.TsRequestBudgetTest --tests dev.codeintelligence.analysis.ts.TsProjectSessionTimeoutTest \
  --tests dev.codeintelligence.analysis.ts.TsAnalyzeDtosTest --tests dev.codeintelligence.analysis.tree.TreeParsingStepTest
```

최초 green build의120초 외부 deadline은 quiet admission 중 만료돼 build 자체는 NOT_RUN이었다. `build-admission-timeout.log` 보존 후 admission/build만 deadline 없이 재실행했다. threshold나 gate를 완화하지 않았다.

medium cold/refresh 차이는 별도 baseline stdio profiler의 **호출수**로도 설명된다. cold compiler project4회(누적 root9,546), extract3회; refresh project3회(누적 root5,069), extract2회였다. 누적 root 수를 고유 파일 수로 해석하지 않는다. 결과2,330개·metadata581개를 재사용했지만 slice/dependency context의 compiler 작업은 남는다.

refresh envelope5,499개 전부 인증됐고 decode2,930개 모두 성공,64MiB call budget은40,272,018 bytes 남았다. owner eviction/oversize0이므로 이 medium의 남은 비용을 인증/eviction/인플레이트 cap 실패로 설명할 근거는 없다. 이 계수는 high-load standalone 진단이며 p6 native가 출력하지 않은 내부 계수를 추정해 채운 것이 아니다.

## 최종 retained 코드 검증

제품 코드 `a81f1b2`에서 TS 대상10파일 **142/142 PASS**, `npm run build` PASS. 새 consumer 회귀는 controller에 새 endpoint/method를 추가하여 unchanged provider metadata를 재사용한 **새 CALLS edge**와 clean full equality를 확인한다. 단순 unchanged graph/cache echo가 아니다. `final-checks.log`와 `final-summary.json`에 기록했다.

```sh
cd analyzers/ts-analyzer
./node_modules/.bin/vitest run --maxWorkers=1 src/incremental-metadata.test.ts src/react-component-binding.test.ts src/incremental.test.ts src/incremental-workload.test.ts src/incremental-large-result.test.ts src/ts-scale.test.ts src/analyze-session.test.ts src/incremental-session.test.ts src/stdio-transport.test.ts src/http-boundary.test.ts
npm run build
```

실제 stdio와 loopback HTTP 각각 새 cold/refresh/clean-full worker/session을 실행했다. synthetic1000-file fixture 중 완전한 TS/config553개를 전송하고, refresh에서는 fixture1% revision 외에 실제 `fetch` body를 추가했다. 두 transport 모두 API call0→1·canonical 변경을 관측했으며 refresh=clean full, stdio=HTTP의 **전체 graph 응답** SHA가 `0a7cc79abb849fd935ec8ac141261f5211bcf211e2fc74a20f8db068545e5ce5`로 같았다. cold SHA는 `e94bf1b264825689fdcbf2a096ebd7d341cebd2c877f231511eb1403b9296fbb`로 별도다. count-only 비교가 아니다.

실행은 `wait-quiet.sh → with-native-lock.sh → caffeinate`; smoke parent/worker는 clean env였다. `PROFILE_LABEL=final-stdio PROFILE_COVERAGE=1 node validation/local/w21-adapter-perf/session-profile.cjs small`와 `PROFILE_LABEL=final-http PROFILE_HTTP=1 node validation/local/w21-adapter-perf/session-profile.cjs small`를 사용했다. 원본로그와 CPU/coverage 자료는 보존한다. high load 및 precise coverage 영향이 있으므로 시간비교/SLO 증거로 사용하지 않는다. 최종 cold coverage도 index생성1회, index1,345회+owner664회를 확인했다.

중간커밋: `46b2402`, `00d7b40`, `a81f1b2`. 최종 net 변경은 `semantic-extractor.ts`, `incremental-metadata.test.ts`, 이 감사이며 React/core/backend/transport/후보 바이트는 원래대로다. 메인의 통합 재검증과 fresh packaged pipeline 성능 확인 전에는 성능/SLO 통과나 release GO를 선언하지 않는다.

### 소비자 회귀의 mutation guard

새 시험이 잘못된 owner grouping을 실제로 거부하는지, 일시적으로 `key.split('.')[0]`를 주입해 동일한 시험 하나를 실행했다. **RED1/1**: warm controller의 새/기존 CALLS edge3개가 사라지고 SUCCESS가 PARTIAL/UNRESOLVED_CALLS로 바뀌어 clean-full equality가 실패했다(`owner-index-mutant-red.log`). 올바른 suffix-length 식을 즉시 복원하여 원래 제품 file hash `E7D1`로 돌아온 뒤 같은 명령에서 **GREEN1/1**, 나머지6개는 name filter로 skipped였다(`owner-index-green.log`). 이것은 의도적 mutation guard이며 baseline의 기존 semantic 결함이라고 주장하지 않는다.

```sh
./node_modules/.bin/vitest run --maxWorkers=1 src/incremental-metadata.test.ts -t "keeps provider method identity"
```

임시 profiler/stdio·HTTP harness/quiet wrapper, 보존용 baseline dist 및 취소된 synthetic fixture는 제거했다. 실패·취소·coverage·CPU profile·JUnit·canonical 증거는 `validation/local/w21-adapter-perf`에 그대로 보존한다. 영구 telemetry나 새로운 runtime abstraction은 남기지 않았다.

## 통합 담당자 재검증

동일 대상 10파일을 독립 실행하여 **142/142 PASS**를 확인했다(`main-core/verify.log`). 이어진 build는 npm user/global config에 같은 `/dev/null` 경로를 지정한 러너 설정 오류로 시작하지 못했다(`main-core/build.log`). 원본 러너와 오류를 보존하고 각기 다른 빈 config 파일을 사용하여 **build만 재실행 PASS**했다(`main-build-retry/build.log`, `status.txt`). 이미 통과한 대상 시험을 반복하거나 최초 build를 PASS로 바꾸지 않았다.

메인 명령은 `validation/local/followup-main-verification/recheck-w21.sh main-core` 및 같은 스크립트의 `main-build-retry build-only`다. 공통 quiet·native lock·caffeinate를 사용했으며 제품 코드 변경 없이 재검증했다. 새 통합 후보의 전체 파이프라인 시간·최종20회·출시 판정은 별도다.
