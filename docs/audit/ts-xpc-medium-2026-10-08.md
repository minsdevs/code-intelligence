# TS rejection of medium projects on the isolated adapter path (unit w11-ts-xpc) — 2026-10-08

## Scope

Unit **w11-ts-xpc**, branch `gate/w11-ts-xpc` from integration `877abb4`. Defect: the G-PERF
**medium** packaged smoke on candidate **wFroXK** (`adapterIsolation=xpc-required`) failed in
TS_PARSING after about 2.6 s at 20 % in both runs, job FAILED with `failureCode` null, backend error
`TsAnalyzerException: ts-analyzer rejected input without a recognized diagnostic` from
`TsAnalyzerControlClient.accept` via `TsProjectSession.call`. Small class and the product sequence
passed. Evidence of the failure (not rewritten): `validation/local/workload-performance/run-etYDCC`
(smoke-2) and `run-GWEbC7` (smoke-1 `--keep-work`, logs in `run-GWEbC7-profile-logs/`) in the
integration worktree. No packaged app was launched by this unit, no SLO, threshold, gold data or
Flyway migration was changed (`desktop/src/backup-export-policy.cjs` unchanged). Release verdict:
**NO_GO**.

## Root cause

1. **One worker per control request, but a 03 §6 session lives in one analyzer process.** A project
   above one request (`TsRequestBudget`: 20,000 files / 10 MiB JSON; medium is 5,503 files /
   25.1 MiB) goes through the session commands `open → put → seal → analyze → page → close`. The
   analyzer keeps session state in memory (`AnalyzeSessions`). In `xpc-required` mode every control
   request reached `createBridgeAdapter().analyze`, which started a fresh bridge → supervisor →
   worker and ended it after the reply. `open` succeeded in worker 1; the first `put` reached
   worker 2, which answered `400 {code: SESSION_UNKNOWN}`. The kept backend log confirms the
   position: `TsProjectSession.analyze(TsProjectSession.java:83)` is the first `put` (line 66, the
   `open`, had returned). The w8 harness used the HTTP sidecar, one long-lived process, so the same
   workloads passed there.
2. **The supervisor capped a connection at one request.** `supervisor.c` ended a session after
   10 MiB + 16 KiB relayed in or 64 MiB + 16 KiB out. Even with (1) fixed, medium relays 26.4 MiB in
   and 47.2 MiB out (measured below), so it would have failed as `ADAPTER_CLOSED`; large
   (100 MiB source) also exceeds the output cap.
3. **The analyzer's code was dropped.** The control client (and the HTTP client) turned any 400
   without syntax diagnostics into a plain `TsAnalyzerException` with no `RecoveryActionFailure`,
   so the job ended with `failureCode` null and the job error did not name `SESSION_UNKNOWN`.
   The worker's stderr goes to `/dev/null` in the supervisor and the bridge's stderr is ignored by
   main, so the frame's code was the only diagnostic, and the backend discarded it.

Reproduction with the real analyzer (no packaged app): `createBridgeAdapter` with a pass-through
"bridge" that starts `analyzers/ts-analyzer/dist/stdio.js` per spawn, driving the session protocol
over the kept medium fixture (`/private/tmp/ciwl-qIhbX3/fixture`, 5,503 TS/JS/config files,
25.1 MiB). At `877abb4`: `put` rejected `ADAPTER_REQUEST_REJECTED 400 SESSION_UNKNOWN`, 2 workers.
After the fix: 1 worker, 26 puts, 48 result pages, 59,379 nodes / 113,108 edges, 26.4 MiB in,
47.2 MiB out, 20.2 s.

## Fixes

| Defect | Failing test first (red line read) | Fix | Green (counts from output) |
|---|---|---|---|
| 1 | `desktop/test/adapter-isolation.test.cjs` › `one analyzer session runs in one bridge session from open to close (03 §6)` and `an analyzer session ends on a rejection, an abandoned command or idleness` — `not ok 9`, `error: 'Adapter rejected the analysis request'` (fake worker keeps sessions per process, like the analyzer) | `createBridgeAdapter` keeps the worker that answered `open` for that session id; later commands for the id go to it; it ends on `close`, a rejected command, an abandoned command (connection abort → SIGKILL), 60 s without a command (the analyzer's own idle limit) or the existing 10 min analysis limit. Single requests and unknown ids keep one fresh worker each. | `adapter-isolation` 16/16; with `adapter-control` and `adapter-supervisor`: 32 pass, 0 fail |
| 2 | `desktop/test/adapter-supervisor-native.test.cjs` (opt-in `ADAPTER_SUPERVISOR_NATIVE=1`, real ad-hoc-signed supervisor, bridge, Electron worker and ts-analyzer) › `one analyzer session above the single-request bounds runs in one sandboxed worker (03 §6)` — 10.7 MiB source in, > 100 MiB pages out; with the old `supervisor.c`: `not ok 6`, `error: 'ADAPTER_ISOLATION_UNAVAILABLE: ADAPTER_CLOSED'` | `MAX_INPUT_BYTES` / `MAX_OUTPUT_BYTES` per supervisor session: 10 MiB + 16 KiB / 64 MiB + 16 KiB → 1 GiB each | native suite 9 pass, 0 fail (session case 38.8 s) |
| 3 | `TsAnalyzerControlClientTest.anAnalyzerRejectionWithoutSyntaxDiagnosticsFailsTheJobWithItsCode`, `TsAnalyzerClientTest.anAnalyzerRejectionWithoutSyntaxDiagnosticsNamesItsCode` — `Expecting actual throwable to be an instance of RecoveryActionFailure but was TsAnalyzerException: ts-analyzer rejected input without a recognized diagnostic` (7+5 run, 1+1 failed) | New `TsAnalyzerRejectedException` (`RecoveryActionFailure`): message `ts-analyzer rejected the analysis request (<CODE>)`, code only if it matches `[A-Z][A-Z_]{0,63}` (else `UNKNOWN`), no cause, no response text; `failureCode` `ANALYSIS_LIMIT` for the analyzer's or main's `ANALYSIS_LIMIT`, else `TS_ANALYZER_REJECTED`. Syntax diagnostics keep `TS_SYNTAX_ERROR`. | package `dev.codeintelligence.analysis.ts.*` (`--offline cleanTest`): 70 tests, 0 failures, 0 errors |

The existing control-client case `{"status":400,"response":{"message":"source marker"}}` moved from
the "plain `TsAnalyzerException`" list to the new test (now `TS_ANALYZER_REJECTED (UNKNOWN)`, still
without the response text or capability).

### Why the raised supervisor bounds stay safe

The bound is per supervisor session (one bridge connection, one worker). 1 GiB in is twice the 03 §6
session source limit (512 MiB, enforced by the backend before `open` and by the analyzer on every
`put`), leaving room for JSON escaping; measured overhead is about 5 % (25.1 → 26.4 MiB). 1 GiB out
is about 5× the large class's expected result (medium returned 1.9× its source; large is 100 MiB of
source). Neither side buffers the stream: the supervisor relays chunks of at most 1 MiB, main still
rejects any frame above 10 MiB + 4 KiB (request) or 64 MiB (response) and still ends the worker at
the 10 min analysis limit, and `MAX_SESSIONS` (2 concurrent workers) is unchanged. A pathological
project that exceeds a bound fails closed (`ADAPTER_CLOSED`), as before.

## Changed product paths

- `desktop/src/adapter-isolation.cjs` (session affinity in `createBridgeAdapter`; `createWorkerSession` also returns `stop`)
- `desktop/native/adapter-supervisor/supervisor.c` (per-session relay bounds)
- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsAnalyzerRejectedException.java` (new)
- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsAnalyzerControlClient.java`
- `backend/src/main/java/dev/codeintelligence/analysis/ts/TsAnalyzerClient.java`

Tests: `desktop/test/adapter-isolation.test.cjs`, `desktop/test/adapter-supervisor-native.test.cjs`,
`backend/src/test/java/dev/codeintelligence/analysis/ts/TsAnalyzerControlClientTest.java`,
`backend/src/test/java/dev/codeintelligence/analysis/ts/TsAnalyzerClientTest.java`.

## Limits and what remains

- **Packaged acceptance is open.** wFroXK does not contain these changes (native code changes the
  supervisor hash in the runtime manifest). The coordinator rebuilds the candidate and reruns the
  medium and large smokes; only that run can show TS_PARSING passing on the packaged path.
- The 10 min analysis limit in main now bounds a whole session (upload, extraction, pages). The
  backend's `analyze` command budget is 30 s per 10 MiB of source; the large class needed about
  100–170 s of TS time in the w8 harness, well inside it, but a project close to 512 MiB would hit
  main's 10 min limit first. Not changed here.
- The TEST_ONLY unsigned adapter still requires a synthetic fixture marker in every request body,
  so it cannot run session commands; it is a development path only.
- Transport failures (`ANALYZER_FAILURE`, closed control connection, timeouts) still end the job
  with `failureCode` null; only analyzer rejections and `ANALYSIS_LIMIT` carry a code now. The
  stdio worker's top-level envelope codes (`INVALID_ENVELOPE`, `UNSUPPORTED_OP`) are still not
  forwarded by `createStdioAdapterClient` (they surface as `TS_ANALYZER_REJECTED (UNKNOWN)`).
- The frontend has no dedicated text for `TS_ANALYZER_REJECTED` / `ANALYSIS_LIMIT`; the job error
  text carries the code.
