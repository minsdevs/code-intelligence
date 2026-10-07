# Bounded job cancellation (T03) — 2026-10-07

## Scope

Unit **w1-cancel**, branch `gate/w1-cancel` from `42d3260`. Closes the product side of
G-JOB **D2 / J13** (`docs/audit/job-race-matrix-2026-10-07.md`) and G-PERF **finding 4**
(`docs/audit/workload-performance-2026-10-07.md`): cancel did not stop the running step or its
in-flight analyzer request, so the job stayed `CANCELLING` and the project locked until the step
ended (30 s analyzer read timeout; 23–27 s cancel→lock release during `IMPORT` on LA8ZS9).
Requirement: 05 §4 / 07 G-JOB, G-PERF — UI ack ≤ 500 ms, worker exit + lock release p95 ≤ 5 s,
max 10 s, kill/wait/fencing so a stale worker cannot complete afterwards. This report records
facts; it does not declare G-JOB or G-PERF PASS. No real account, Keychain, provider call,
packaged-app launch, signing or publication was used.

## Design

- `JobCancellation` (new, `job` package): one token per run. `JobService.cancel` marks the job
  `CANCELLING` and then calls `JobWorker.requestCancel`, which flags the token of the run that
  currently owns the job (under the existing B4 `runOwnership` lock, so a stale worker's token is
  never the one flagged and a run claimed concurrently is seen).
- The worker binds the token to its thread only while a step body runs. `JobCancellation.checkpoint()`
  is a thread-local plus volatile read (no DB query); it throws `JobCancelledException` once the
  run was cancelled and is a no-op on threads without a job step (HTTP preview, tests).
- `JobCancellation.interruptibly(...)` wraps blocking analyzer calls (TS and tree `health`/
  `analyze`). A cancel interrupts only a thread inside that region; Spring's
  `JdkClientHttpRequest` then cancels the `HttpClient` exchange (connection closed). The interrupt
  flag is cleared on exit, so JDBC, Redis and JGit work never runs interrupted.
- Checkpoints: `JobContext.updateProgress` (every step except IMPORT's GitHub path and FINALIZE
  reports progress), the per-file loops of the local import (`LocalSourcePolicy.State.check`,
  `LocalStagingVerifier.check`), `FileInventoryScanner`/`FileInventoryStep`, `SourceParsingStep`
  and `JavaAnalyzer`, `GraphBuildStep`, TS/tree payload loops and requests, `CrossDomainStep`
  outer loops. Broad `catch (RuntimeException)` blocks around these rethrow
  `JobCancelledException` so it is never turned into a per-file failure record.
- Worker: `JobCancelledException` from a step body marks that step `FAILED` with error
  `cancelled` (no job FAILED write; the job is `CANCELLING`), then the existing `releaseRun`
  completes `CANCELLING → CANCELLED` and releases the lock only after the worker has left the
  step. Fencing from the D1 fix is unchanged (owner token per run; guarded transitions).

## Red / green

RED on the code before the fix (tests committed in `0ad6713`), GREEN after `55e2213`.

| Requirement | Test | RED (before) | GREEN (after) |
|---|---|---|---|
| (a) cancel during an in-flight analyzer request releases the lock and reaches CANCELLED < 10 s | `JobAnalyzerWorkerRaceIntegrationTest.cancelAbortsTheInFlightAnalyzerRequestAndReleasesTheProjectWithinTheBound` (replaces the characterization `cancelWaitsForTheInFlightRequestUntilItsReadTimeout…` and the old `lateAnalyzerResultAfterCancelOnlyReachesTheCancelledRunsOwnSnapshot`) | `job-race/backend-MzdFqD`: `ConditionTimeoutException … not fulfilled within 10 seconds` | `job-race/backend-o6b4ym`: PASS; observed ack 10 ms, lock released 70 ms after the cancel request (single observation) |
| (b) cancel mid-IMPORT per-file loop stops before the next file | `LocalSourceBindingTest.aCancelDuringTheSourceCopyStopsBeforeTheNextFileAndKeepsTheOldTarget`, `…aCancelDuringStagedVerificationStopsBeforeTheNextFileAndKeepsTheOldTarget` | Gradle (`JobCancellationTest` + `LocalSourceBindingTest`): 46 tests, 2 fail, `Expecting code to raise a throwable` (lines 392, 409) | 41/41 pass in `LocalSourceBindingTest` |
| (c) cancel inside a long in-process step is honoured by its body | `JobPipelineRaceIntegrationTest.aCancelInsideALongInProcessStepIsObservedByItsBodyAndReleasesTheProjectWithinTheBound` [SOURCE_PARSING, GRAPH_BUILD] (worker parked inside the body at its progress publish) | `backend-MzdFqD`: 2/2 fail, `expected "FAILED" but was "DONE"` | `backend-o6b4ym`: 2/2 PASS; lock released 61 / 56 ms after the parked worker resumed |
| (c') a body started after the cancel stops at its first checkpoint | `cancelInsideEveryRealStepKeepsThePreviousResultAndReleasesTheProject` BEFORE_BODY rows (expectation changed from DONE to FAILED/`cancelled` for the 13 steps that report progress; IMPORT GitHub clone stays DONE, FINALIZE stays FAILED) | `backend-MzdFqD`: 13/30 fail, `expected "FAILED" but was "DONE"` | `backend-o6b4ym`: 30/30 PASS |
| (d) a stale worker/result cannot change CANCELLED afterwards | `JobAnalyzerWorkerRaceIntegrationTest.aStaleAnalyzerResultAfterABoundedCancelAndANewerPublishWritesNothing`; (c) also asserts the worker thread exited, step rows and CANCELLED unchanged after a newer run published | `backend-MzdFqD`: fail (10 s bound) | `backend-o6b4ym`: PASS; D1 fencing tests `aFailedWorkerStillExiting…` ×2 PASS in the same run |

`backend-MzdFqD` totals: 34 tests, 17 pass, 17 fail (exactly the rows above).
`backend-o6b4ym` (`--with-analyzer`, both race classes in full, base commit `55e2213`,
`sourcesUnchanged: true`): **PASS 62/62** (pipeline 58, analyzer 4).

Other directly affected classes, run after the fix (`./gradlew --offline cleanTest test --tests …`,
Testcontainers where the class uses it): `JobCancellationTest` 5/5, `JobServiceRetryTest` 3/3,
`JobFrameworkIntegrationTest` 11/11, `ProjectJobApiIntegrationTest` 14/14,
`MaintenanceBackgroundLeaseTest` 6/6, `TsParsingStepTest` 3/3, `TsAnalyzerClientTest` 4/4,
`JavaAnalyzerTest` 3/3, `LocalImportServiceTest` 15/15, `LocalSourceBindingTest` 41/41,
`LocalIngestIntegrationTest` 4/4, `RetainedSourceIntegrationTest` 37/37,
`LocalIngestPolicyTest` 67/67 (from the short path `/Users/minseokchae/Dev/ciw/cancel`; the
socket-path FAIL of `backend-oH0pXu` did not recur here). Corpus goldens:
`node validation/pre-release/run-docker-integration.cjs --suite corpus …` →
`docker-integration/corpus-4KXXSF` 23/23 pass, status `REVIEW_REQUIRED` only because
`preexistingContainersUnchanged: false` (other units' containers changed concurrently; no new
container remained).

## Changed product paths

- `backend/src/main/java/dev/codeintelligence/job/JobCancellation.java` (new)
- `backend/src/main/java/dev/codeintelligence/job/JobCancelledException.java` (new)
- `backend/src/main/java/dev/codeintelligence/job/JobWorker.java`, `JobService.java`, `JobContext.java`, `JobStep.java`
- `backend/src/main/java/dev/codeintelligence/project/LocalSourcePolicy.java`, `LocalStagingVerifier.java`
- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsParsingStep.java`, `analysis/tree/TreeParsingStep.java`
- `backend/src/main/java/dev/codeintelligence/analysis/graph/SourceParsingStep.java`, `GraphBuildStep.java`, `analysis/java/JavaAnalyzer.java`
- `backend/src/main/java/dev/codeintelligence/analysis/core/FileInventoryScanner.java`, `FileInventoryStep.java`, `analysis/cross/CrossDomainStep.java`

Tests: `JobCancellationTest`, `BoundJobCancellation` (test helper), `RacePublisher.holdInStepBody`,
`JobPipelineRaceIntegrationTest`, `JobAnalyzerWorkerRaceIntegrationTest`, `LocalSourceBindingTest`.

## Behaviour changes to note

- A step stopped by a cancel ends `FAILED` with error `cancelled` inside a `CANCELLED` job (as
  FINALIZE already did). The frontend shows the job banner by job status, so no new error banner
  appears; the step row shows the failed mark. No schema or API change.
- A withheld analyzer result is now discarded entirely (the request is aborted); previously it
  was written into the cancelled run's own staging snapshot (J12). Neither ever reached the
  current result.

## Limits and what remains

- **Packaged acceptance NOT RUN**: LA8ZS9 does not contain this fix; the packaged cancel during
  `IMPORT`/`TS_PARSING` (finding 4, J13/J15) and the 20-run SLO (R8: ack ≤ 500 ms, p95 ≤ 5 s)
  need the next coordinator candidate. Timings above are single backend observations on a
  shared machine, not SLO results.
- GitHub clone/fetch inside `IMPORT` has no checkpoint (JGit transport has no cancel hook wired;
  aborting a clone mid-pack also risks a partial clone directory). A cancel during a GitHub
  clone is still observed only after the clone.
- Steps without in-loop checkpoints (LANGUAGE_FRAMEWORK, AREA_DETECTION, GIT_METADATA,
  EXTRACTION, FEATURE_DETECTION, FLOW_DETECTION, FINDING_DETECTION) observe a cancel only at
  their `updateProgress` calls; a single long SQL statement or one long analyzer pass between
  two checkpoints is not interrupted. The 660 s `CROSS_DOMAIN` outlier (finding 5) now has
  per-caller/per-route checkpoints, but its cause is not addressed here.
- The analyzer process is not killed on cancel: the HTTP exchange is aborted and the backend no
  longer waits, but the app-owned Node analyzer may finish computing the abandoned request
  before serving the next one. Killing/restarting it belongs to the desktop process owner
  (out of this unit's file area).
- Cancellation is in-process (single backend instance, the supported deployment); the worker's
  existing per-step DB status check remains the fallback at step boundaries.

## Proposed shared-doc text (not edited here)

- 07 §3 G-JOB "현재": `D2/J13 제품 수정(bounded-cancel-2026-10-07): 취소 시 실행 중 단계 중단·분석기 요청 중단,
  backend 실측 잠금 해제 56–70 ms(단일 관측); 패키지 후보 재검증 필요`.
- 07 G-PERF R8 note: `finding 4(IMPORT 중 취소 23–27 s) 제품 수정 — 차기 후보에서 20회 측정 필요`.
