# G-JOB job race matrix — 2026-10-07

## Scope and position

Release gate **G-JOB** (07 §3: "real worker/DB cancel·delete·retry·power loss·fencing;
forbidden substitute: the UI cancel button alone"), audit item **B4**, corpus **C07**
`increment-cancel` and the 06 threshold row "crash/cancel: partial current publish 0,
late epoch write 0, orphan lock 0 — hard FAIL", the functional part of the 05 §4 cancel
SLO, and stage 4 of 07 §5. Work branch: this worktree (`worktree-agent-ac262e7b572d9d21c`)
from `bcd8081`. Candidate for packaged runs: `.native-product-1lvULq` (built from `9211e88`;
it does **not** contain the product fix below). No real account, Keychain, provider call,
signing or publication was used. This report gives row-level facts; it does not declare
G-JOB PASS.

## Real pipeline steps (enumerated from code)

`IMPORT(100) → FILE_INVENTORY(200) → LANGUAGE_FRAMEWORK(300) → AREA_DETECTION(400) →
GIT_METADATA(500) → SOURCE_PARSING(600) → GRAPH_BUILD(700) → TS_PARSING(750) →
TREE_PARSING(770) → EXTRACTION(800) → CROSS_DOMAIN(850) → FEATURE_DETECTION(900) →
FLOW_DETECTION(920) → FINDING_DETECTION(940) → FINALIZE(10000)` (`@Order` on each
`JobStep`; IMPORT and REANALYZE share it). `theMatrixEnumeratesEveryStepOfTheProductionPipeline`
asserts the matrix list equals the injected production beans.

Design facts the matrix relies on: cancel of a RUNNING job sets `CANCELLING`, the running
step body is **not** interrupted, the worker stops at the next step boundary and only then
`CANCELLING → CANCELLED`; the V21 partial unique index keeps `QUEUED/RUNNING/CANCELLING`
exclusive per project; FINALIZE publishes, checkpoints and sets DONE in one transaction
guarded by `status='RUNNING'` (and, for retained sources, by the STAGING generation whose
predecessor is the current one); startup recovery turns RUNNING into FAILED and CANCELLING
into CANCELLED.

## What ran

| Unit | Components | Command | Result (read from output) |
|---|---|---|---|
| Pipeline race class | real 15 steps, Testcontainers PostgreSQL 16/pgvector + Redis 7, real HTTP API, JGit imports from local bare repos; latches only around step bodies and the Redis publish call | `node validation/pre-release/job-race-backend.cjs --socket unix://$HOME/.docker/run/docker.sock --with-analyzer --tests dev.codeintelligence.job.JobPipelineRaceIntegrationTest --tests dev.codeintelligence.job.JobAnalyzerWorkerRaceIntegrationTest` | `job-race/backend-T0lTsd` (at `679f1fd`, contains the D1 fix): PASS, 60 tests / 60 pass / 0 fail / 0 skipped; pipeline class 56/56 |
| Analyzer worker class | same + the production Nest analyzer (`analyzers/ts-analyzer/dist`) started, relayed and SIGKILLed by the test through its own `Process` handle | (same command) | `backend-T0lTsd`: 4/4 pass |
| D1 regression rerun | the two stale-worker fencing tests alone | `node validation/pre-release/job-race-backend.cjs --socket unix://$HOME/.docker/run/docker.sock --tests 'dev.codeintelligence.job.JobPipelineRaceIntegrationTest.aFailedWorker*'` | `job-race/backend-p1SZCL`: PASS 2/2 (same sources as `backend-T0lTsd`); before the fix `backend-ZJr98L` 0/2 |
| Packaged app | `.native-product-1lvULq` (built from `9211e88`, **without** the D1 fix), fresh isolated automation profile, mock Keychain, real UI drag/preview/approve, real API, three launches | `with-native-lock.sh gate-job env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/job-race-product.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app"` | `job-race/product-u8kj3a` (driver at `cb2514e`): PASS, 8/8 checks, 3/3 clean shutdowns, manifest/app.asar hashes unchanged after the run. Earlier `product-6BsHhc` (driver at `679f1fd`): FAIL after check 1, see "Runner defect R1" |
| Runner unit tests | owner-capture and argument guards | `node --test validation/pre-release/test/job-race.test.cjs` | 3 pass / 0 fail |
| Existing suites | `backend`, `events` (at `679f1fd`) | `node validation/pre-release/run-docker-integration.cjs --suite backend --socket unix://$HOME/.docker/run/docker.sock` (and `--suite events`) | `docker-integration/backend-oH0pXu`: 1743 tests, 1726 pass, **1 fail**, 16 skipped (12 existing explicit skips + the 4 analyzer-class tests, which skip without `--with-analyzer`); pipeline race class 56/56 inside it. The failure is `LocalIngestPolicyTest.specialFilesAreRejectedAndTheOldRepositorySurvives`: `SocketException: Unix domain path too long`. The suite temp root is `…/.claude/worktrees/agent-ac262e7b572d9d21c/.citd-HJOEOJ` (95 characters); with the JUnit `@TempDir` name and `/socket`, the path exceeds macOS's 104-byte `sun_path` limit. This is caused by the worktree path, not by job code. Not rerun from a shorter path (targeted runs only), so it remains a FAIL record. `docker-integration/events-D9fXKL`: PASS 19/19 |

Earlier records are kept, not overwritten: `backend-BXOE4N` (first subset; defect D1 first
observed), `backend-ZJr98L` (D1 RED, 2/2 fail before the fix), `backend-nRrZ1Z` (35 fails,
all HTTP 429 from per-test PAT login — a harness defect, fixed by one login per class),
`backend-9mpIzz` (58/59; analyzer class 4/4; one wrong test expectation for FINALIZE
after-body, fixed), `backend-7WmrMK` (interrupted by the coordinator pause; no totals),
`backend-TgjHZM` (cancel matrix 30/30; pub/sub-loss test predicate matched a *step* status,
fixed), `backend-QqCUWm` (pub/sub loss 1/1).

## Requirement matrix

Status values: PASS, FAIL, NOT RUN, BLOCKED, N/A (out of release scope, with reference).
"backend" = real DB/Redis/pipeline in Testcontainers; "worker" = real analyzer process;
"packaged" = retained candidate app.

| # | Requirement (source) | Evidence | Kind | Status |
|---|---|---|---|---|
| J01 | Cancel before **and** after the body of every one of the 15 production steps: terminal CANCELLED, later steps never run, no current publish, lock released, previous result intact (G-JOB cancel; 06 crash/cancel) | `cancel BEFORE_BODY/AFTER_BODY of "<step>"` ×30, `backend-T0lTsd` | backend | PASS (30/30) |
| J02 | Failure at every step, then retry completes on the same project with one writer (G-JOB retry) | `fail at "<step>", then retry` ×15, `backend-T0lTsd` | backend | PASS (15/15) |
| J03 | FINALIZE commit races cancel / delete / reanalyze, and whichever reaches the row first wins consistently (partial current publish 0) | `"cancel"/"finalize" reaches the job row first`, `"delete"/"reanalyze" reaches the project row first` | backend | PASS (4/4) |
| J04 | Concurrent starts and retry-vs-new-analysis admit exactly one writer (V21 exclusivity, orphan lock 0) | `concurrentStartsAndRetryVersusNewAnalysisAdmitExactlyOneWriter` | backend | PASS |
| J05 | Cancelling a QUEUED job before its worker claims it runs no step | `cancellingAQueuedJobBeforeItsWorkerClaimsItRunsNoStep` | backend | PASS |
| J06 | Fencing: a stale worker cannot complete the cancellation of, or fail, a newer run of the same job (late epoch write 0) | `aFailedWorkerStillExiting…` ×2: `backend-ZJr98L` 0/2 before the D1 fix; `backend-T0lTsd` 2/2 and `backend-p1SZCL` 2/2 after it | backend | PASS on source `8b3fa28`+ (D1 fixed) |
| J07 | Lost progress messages (Redis pub/sub) never change the outcome; terminal state stays observable | `lostProgressMessagesNeverChange…` (`backend-QqCUWm`, `backend-T0lTsd`) | backend | PASS |
| J08 | Matrix covers every production step (no hand-picked subset) | `theMatrixEnumeratesEveryStepOfTheProductionPipeline` | backend | PASS |
| J09 | Full re-analysis of the same snapshot is equivalent and retracts removed relations (C07 full-vs-increment substitute) | `fullReanalysisIsEquivalentForTheSameSnapshotAndRetractsRemovedRelations` | backend | PASS |
| J10 | Real worker killed mid-request: only that run fails; retry on a new worker succeeds (C07 process kill) | `analyzerKilledMidRequestFailsOnlyThatRunAndRetryRecoversOnANewWorker` | worker | PASS |
| J11 | Worker unavailable before the request: the step fails; retry after restart succeeds | `analyzerDeadBeforeTheRequestFailsTheStepAndRetryAfterRestartSucceeds` | worker | PASS |
| J12 | Late worker result after cancel reaches only the cancelled run's own staging snapshot (C07 late worker result; late epoch write 0) | `lateAnalyzerResultAfterCancelOnlyReachesTheCancelledRunsOwnSnapshot`; stale result after a newer publish writes nothing (`cancelWaits…`) | worker | PASS |
| J13 | Cancel bound: worker exit + lock release max 10 s, with kill/wait (05 §4, T03, B4) | `cancelWaitsForTheInFlightRequestUntilItsReadTimeout…` characterizes the job staying CANCELLING >10 s until the 30 s read timeout; packaged A1 single observation 12,453 ms cancel→terminal (`product-u8kj3a`), 12,891 ms (`product-6BsHhc`) | worker + packaged | **FAIL** (D2, T03 not implemented) |
| J14 | Cancel timing SLO: UI ack ≤500 ms, p95 ≤5 s (05 §4) | none; timing is not an acceptance result on this shared machine | — | NOT RUN |
| J15 | Packaged: real UI `Cancel analysis` during the worker step (TS_PARSING) ends the step, runs no later step, publishes nothing, releases the lock; project deletable afterwards | `product-u8kj3a` check 1 | packaged (pre-D1 candidate) | PASS |
| J16 | Packaged: delete refused while RUNNING and while CANCELLING (409/409); API cancel keeps the previous result current | `product-u8kj3a` checks 2–3 | packaged (pre-D1) | PASS |
| J17 | Packaged: SIGKILL of the app-owned analyzer mid-request → job FAILED (`ts-analyzer request failed`), app restarts the analyzer, no active job, previous result intact | `product-u8kj3a` check 4 (exit 137) | packaged (pre-D1) | PASS |
| J18 | Packaged: SIGKILL of the app-owned backend mid-job → app restart, startup recovery marks the job FAILED (`interrupted by backend restart`), previous result intact | `product-u8kj3a` check 5 (exit 137, during FILE_INVENTORY) | packaged (pre-D1) | PASS |
| J19 | Packaged: app restart keeps all race jobs terminal, no lock, previous result unchanged | `product-u8kj3a` check 6 | packaged (pre-D1) | PASS |
| J20 | Packaged: a later re-analysis succeeds, publishes a new snapshot with the change, and history is retained | `product-u8kj3a` check 7 | packaged (pre-D1) | PASS |
| J21 | Packaged: delete after terminal persists across restart | `product-u8kj3a` check 8 | packaged (pre-D1) | PASS |
| J22 | Packaged rows on a candidate that contains the D1 fix | needs a rebuilt candidate (building one is outside this unit) | — | BLOCKED (input: candidate rebuilt from ≥ `8b3fa28`) |
| J23 | Power loss during analysis (G-JOB) | none | — | BLOCKED (input: sacrificial machine/VM with hard power cut) |
| J24 | C07 as a defined corpus of 20 change/interrupt sequences | no C07 corpus exists in the repository; J01–J21 cover its process-kill, late-result and full-reanalysis cells | — | NOT RUN (corpus not defined) |
| J25 | C07 incremental cells: config/lockfile-only change, corrupt cache, full-vs-increment equality | incremental analysis is out of release scope (README "증분 재분석 범위 밖"); full re-analysis substitute in J09 | — | N/A |
| J26 | C15 OS file/egress denial for the worker sandbox (T03) | ADR-01 sandbox belongs to G-SEC/T03 | — | N/A here (G-SEC) |
| J27 | Existing job/event suites are not regressed by the fix | `backend-oH0pXu` 1726/1743 pass, 1 FAIL in `LocalIngestPolicyTest` (path length, not job code); `events-D9fXKL` 19/19 | backend | FAIL record (environmental, outside G-JOB; rerun from a short path needed) |

Counts: PASS 19 (J01–J12, J15–J21), FAIL 2 (J13; J27 environmental), NOT RUN 2 (J14, J24),
BLOCKED 2 (J22, J23), N/A 2 (J25, J26).

## Defects

**D1 — High, fixed (product).** A worker that had recorded FAILED could still be in its
cleanup when the user retried and then cancelled the retried run. Its `finally` called
`finishCancellation(jobId)` and completed the *new* run's cancellation (CANCELLED, project
lock released) while the retried writer was still inside a step; a new analysis was then
admissible — two writers on one project (06 hard-FAIL class "orphan/late epoch"). Via the
same window, a failing last publish sent the stale worker into its generic handler, which
marked the running retry FAILED. Reproduced deterministically by parking the stale worker's
real publish call (`aFailedWorkerStillExiting…`, 2/2 RED in `backend-ZJr98L`). Severity
follows the 2026-10-03 precedent ("ownership released before the writer stops" = High/P1);
the UI makes the window narrow (retry then cancel before the failed worker thread exits;
widened when Redis publish is slow), and FINALIZE's own guards still prevented publishing
from the stale run. Fix (`backend/src/main/java/dev/codeintelligence/job/JobWorker.java`):
run claims and the worker's final transitions are serialized by one lock and owned by a
per-run token, so only the worker owning the current run can complete its cancellation or
mark it FAILED. Repository API and signatures unchanged (MaintenanceBackgroundLeaseTest
mocks remain valid). Invalidates candidate 1lvULq for backend acceptance.

**D2 — open gate gap (not a regression; T03 unimplemented).** Cancel does not abort the
running step or its worker request. With the real analyzer and its result withheld, the job
stayed CANCELLING and the project locked for more than 10 s, until the 30 s analyzer read
timeout ended the step (`cancelWaitsForTheInFlightRequestUntilItsReadTimeout…`). In-process
steps (SOURCE_PARSING, GRAPH_BUILD, …) have no bound at all. The 05 §4 functional
requirement "worker exit + lock release bounded at 10 s; kill/wait/fencing" is therefore not
met. Lock exclusivity during that time is correct. Proposed fix (T03/ADR-01 scope, not a
narrow change): cooperative cancellation checks inside long steps plus abort of the in-flight
analyzer request (or worker process kill and wait) on CANCELLING.

**D3 — Low, open (UX).** A local project's re-analysis started from the project page
(`LocalSourceStatus`) shows only "Analyzing…"; there is no cancel control there. The
`Cancel analysis` button exists only in the import wizard and GitHub status progress views.
API cancel works. Proposed: render the existing `ProgressStep` (or its cancel action) for
`refreshJobId`.

**D4 — observation, not reproduced.** No `spring.data.redis.timeout` is configured, so
Lettuce's 60 s default applies; `JobProgressPublisher.publish` is synchronous in the worker
loop and in `JobService.cancel`. An *unresponsive* (not refused) Redis would stall each job
transition and the cancel request accordingly. In the packaged app a Redis exit triggers a
full runtime restart. Not run; proposed: a short command timeout for the publish path.

**D5 — Low, observation (UX), not reproduced through a click.** The import wizard keys
its state only on the `?path=` parameter. A same-path navigation to `/import` therefore
keeps the finished job's progress view (with the cancelled project's link) and does not
show the folder picker. This is what stopped `product-6BsHhc` (runner defect R1 below).
[INFERENCE] A sidebar "Import" link clicked while already on `/import` behaves the same.
Proposed: key the wizard on the router location key, or reset the step when a terminal
job's view is left.

**Runner defect R1 — fixed (validation only).** `product-6BsHhc` passed check 1 and then
failed in `baseline-import` with `JOB_RACE_STEP_FAILED`/`Error`. The driver pushed `/import`
while the page was already on `/import` showing the cancelled job, so `Choose folder`
never became visible (static diagnosis from `ImportWizardPage.tsx`; the record had no
message because the driver discarded unnamed errors). This was not a load or timeout
artefact, and not a product job defect. `cb2514e` leaves the route before each import,
names the picker failure `IMPORT_PICKER_NOT_VISIBLE`, and records a bounded first line of
unnamed errors. The rerun `product-u8kj3a` passed 8/8. The failed record is kept.

## Limits

- Packaged rows ran on `.native-product-1lvULq`, built before the D1 fix. They prove the
  app-level behaviour (UI cancel, delete refusal, analyzer/backend SIGKILL recovery,
  restarts, re-analysis, delete persistence) on the current candidate. They do not exercise
  D1's narrow window and cannot attest the fixed backend; J22 is BLOCKED until a rebuild.
- The packaged runner keeps its synthetic profile and work copy under `/private/tmp/cnjp-*`
  and `/private/tmp/cnjr-*` (about 1.35 GiB for two runs). These were removed by hand after
  `result.json` was recorded. Proposed follow-up: the runner deletes them on success.
- Power loss was not executed (BLOCKED: needs a sacrificial machine/VM with a hard power
  cut). Process SIGKILL proves only that the app recovers from loss of a process; it does not
  prove PostgreSQL WAL/fsync durability under power loss, OS page-cache loss, or torn writes
  of retained-source files.
- Backend latches park real threads at chosen points; they widen windows that are narrow
  in normal use. They do not model a second backend instance (unsupported deployment).
- Incremental analysis is out of scope for this release (README "증분 재분석 범위 밖"), so
  the C07 incremental cells are N/A; the full-reanalysis substitutes are listed in the matrix.
- Timing values in evidence are single observations on a shared machine, not SLO results.

## Remaining conditions for G-JOB

1. Rebuild a candidate containing D1's fix and rerun `job-race-product.cjs` and the
   pipeline/analyzer race classes on it.
2. Implement and verify D2 (bounded cancel with worker termination and fencing; T03).
3. Power-loss runs on dedicated hardware/VM (BLOCKED input: hardware/VM owner).
4. Independent review of this matrix (no independent reviewer was available).
5. Rerun the `backend` suite from a short checkout path so that the environmental
   `LocalIngestPolicyTest` socket-path failure in `backend-oH0pXu` is either cleared or
   classified; consider D5 for the UX backlog.

## Proposed text for shared documents (not edited here)

- 07 §3 G-JOB "현재": `PARTIAL — job-race-matrix-2026-10-07: 실제 DB/worker/packaged
  cancel·delete·retry·kill·fencing 행 PASS, D1 수정(후보 재빌드 필요), 10초 취소 상한 FAIL(T03),
  전원 차단 BLOCKED`.
- 07 §5 stage 4 status: add "모든 취소/중단/재시도 경합 행렬(15단계×취소 전/후, 실패/재시도,
  완료 경합, 삭제/시작 경합, worker/backend SIGKILL) 실행; 취소 10초 상한 미구현".
- validation/pre-release/README: a "G-JOB race runners" section describing
  `job-race-backend.cjs` (Docker isolation as `run-docker-integration.cjs`, restricted test
  allowlist, `--with-analyzer` builds the analyzer and lets the tests own/SIGKILL it) and
  `job-race-product.cjs` (fresh isolated profile, signals only the SDK-owned Electron child
  and the analyzer/backend owners registered by the app's main, via `owner.kill('SIGKILL')`;
  never a looked-up PID; requires the native lock).
