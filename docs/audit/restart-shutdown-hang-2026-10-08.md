# Restart/shutdown "hang" in the wFroXK job-race run (unit w10-restart) — 2026-10-08

## Scope

Unit **w10-restart**, branch `gate/w10-restart` from integration `25ab8b1`. Input: the FAIL of
`validation/pre-release/job-race-product.cjs` on candidate **wFroXK** (built from `25ab8b1`,
xpc-required), evidence `validation/local/job-race/product-2YwMwH` in the integration worktree.
Its result recorded `failure.phase = analyzer-owner-kill`, `detail = page.evaluate: Target page,
context or browser has been closed`, `cleanupFailure: true`, and a desktop shutdown trace
BACKEND 57 ms → ANALYZER 982 → REDIS 983 → POSTGRES 1,470 → **SOURCES 575,513 ms (RUNNING)**.
The task: find the root cause and, if it is a product defect, fix it test-first.
No product code, threshold, timeout or gold data was changed, and no Flyway migration was needed,
so `desktop/src/backup-export-policy.cjs` is unchanged. Release verdict stays **NO_GO**.

## Finding: the host slept; the product did not hang

The 575 s gap is a **macOS clamshell sleep of the host during the run**. It is not a desktop
shutdown that waited on `closeProductionSources()`, a vault operation or a broker barrier.

| Time (KST) | Source | Event |
|---|---|---|
| 10:24:57 | backend.log | runner `restartRuntime()` (start of `analyzer-owner-kill`); backend #2 up 10:25:06 |
| 10:25:35 | `pmset -g log` | "Display is turned off"; unified log: app main pid 29738 receives `kCGSDisplayWillSleep` |
| 10:25:40 | `pmset -g log` | "Entering Sleep state due to 'Clamshell Sleep' … Using Batt (Charge:30%) **576 secs**" |
| ≈10:25:41.0 | derived | runner's `page.evaluate` rejects ("Target page … closed") → runner `close()` → `app.quit()` → `DESKTOP_SHUTDOWN QUEUED` |
| 10:25:41.067 | backend.log | backend SIGTERM: graceful shutdown; `retainedRunWorkspace` destroy refuses `WORKSPACE_ACTIVE_LEASES` (job B still in SOURCE_PARSING persistence); Hikari closed; the job thread's `graph_edges` batch then fails on the closed socket |
| 10:25:42.457–.508 | postgres.log | smart shutdown, "database system is shut down" (trace POSTGRES at 1,470 ms) |
| 10:25:42.5 → 10:35:15 | `pmset -g log` | host asleep: every process frozen, including the app and the runner |
| 10:35:15–16 | `pmset -g log`, unified log | "Display is turned on", "Wake from Deep Idle … lid"; pid 29738 `kCGSDisplayDidWake` |
| 10:35:16.5 | result.json | runner receives `DESKTOP_SHUTDOWN SOURCES` at elapsed 575,513 ms. On wake its 30 s close timer is already overdue, so it gives up before COMPLETE: `cleanupFailure`, `finishedAt 01:35:16.532Z` |

Why the numbers fit: QUEUED ≈ 10:25:41.0 plus 575.5 s is 10:35:16.5, the minute the lid opened.
The sleep lasted 576 s, and Node's monotonic clock on this macOS host counts sleep time (the
elapsed time matches wall time). The desktop shutdown steps that ran before sleep took the usual
times (backend ≈ 0.9 s, redis ≈ 0.5 s, postgres ≈ 0.5 s). The step that the trace shows as
"still RUNNING" ran right after wake, when the runner had already stopped observing.

What is inferred rather than observed: why Playwright's page target closed about 1 s after sleep
entry. The app's stderr was not captured in that run, and nothing in `desktop/src` reacts to
suspend (`powerMonitor` is not used). The only path that issues `app.quit()` in this runner is its
own `close()` after a failure, and the failure is recorded before `clean-shutdown`.

Not a w8-graph regression. `desktop/src` is identical between 9lVRha (`52e2e33`) and wFroXK
(`25ab8b1`). The backend log shows the expected fail-closed behaviour for a job interrupted by
shutdown (lease refusal, failed batch, recovery at the next start).

The same host had more battery clamshell or maintenance sleeps on 2026-10-08: 09:05:41 (93 s),
09:49:43 (591 s) and 10:43:50–10:58:46. Any packaged or timing evidence that overlaps those
windows is suspect.

## Product checks run on wFroXK (same candidate, isolated synthetic profiles, mock Keychain)

Two runs under `with-native-lock.sh w10`, using untracked diagnostic copies of the runner. The
copies were deleted after use. They teed app stderr, hooked `app.quit`, `before-quit`, the window
`close` event and a main-loop stall detector, and sampled `ps`.

| Run | Evidence (this worktree, `validation/local/job-race/`) | Result |
|---|---|---|
| Full job-race flow plus diagnostics | `product-2LPFPr` (`diag.log`, `result.json`) | **PASS, 8/8 checks**. Every quit QUEUED→COMPLETE took 2.0–2.4 s; SOURCES→COMPLETE took ≤ 0.1 s; no main-loop stall logged |
| `restartRuntime()` while SOURCE_PARSING is persisting (progress ≥ 70), 3 rounds, then `app.quit()` while persisting | `product-kAYqVY` | restarts returned in **9,532 / 9,345 / 9,342 ms**; each job ended FAILED "interrupted by backend restart". The quit during persistence reached COMPLETE in **2.1 s**, exit code 0. Run status FAIL only because the driver ends with `DIAG_DONE` by design |

`/usr/bin/sample` could not attach to the hardened app, so no native stacks were taken. The ps
samples were taken only after exit and carry no information.

## Changed product paths

None. No failing product test could be written, because the observed failure is not reproducible
as product behaviour. Two restart-during-persistence quits and three restarts completed within
bounded times.

## Limits and what remains

- The failed run cannot be replayed: it had no stderr capture and depended on the host sleeping.
  The causal chain from sleep entry to the runner's page-target error is inferred from timing.
- Not demonstrated, so not changed: `source-broker.close()` waits for `server.close()` before its
  drain timeout starts, and `source-vault.close()` awaits its operation queue without its own
  bound. Both only wait on in-process sockets and fs operations, which settled in every
  observation here. A host-independent bound would be a separate, test-first change if a real
  stall is ever observed.
- The wFroXK job-race gate needs a rerun on an awake, AC-powered host (lid open). The coordinator
  owns that rerun; the 2026-10-08 FAIL record stays as it is.
