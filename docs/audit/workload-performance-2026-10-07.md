# Workload-size performance (G-PERF) — 2026-10-07

This unit prepares release gate **G-PERF** (doc 07 §3: "05의 지원 크기별 20회 p95/full
RSS·quota·latency"; forbidden substitute: backend single-process RSS). It adds a
deterministic offline workload generator, a packaged-app workload runner with
owner-process-tree RSS sampling, and fixed assessment against the unchanged SLOs of
doc 05 §4 under the series rules of doc 06 §5 item 4. Only **smoke** runs were made:
every number below is a **single observation on a shared, non-quiet machine**
(load average 5–36 from concurrent agents) and is not an acceptance result. The
twenty-run series were not run. The gate is not passed. Formal release: **NO_GO**.

All smoke runs used retained candidate `.native-product-1lvULq` (build sequence
`1791292686000`, `app.asar` SHA-256 `fe08c457…`), which does **not** contain the
product fix `635b48b`. Identities, commands and hashes are in the
[companion ledger](workload-performance-2026-10-07.json).

## Main findings

1. **Local import of the small class can fail on candidate 1lvULq (High, fixed in source).**
   `LocalStagingVerifier` starts the 30-second source-inspection clock and then runs
   the per-file consumer (repository object insert and the retained-source vault write)
   inside it. The time limit therefore also bounds product-owned writes. Under high
   load (load average 34–36) 2 of 2 small runs (run-fkMoaB) failed in `IMPORT` after
   31.8 s and 31.5 s with `LOCAL_PREVIEW_REQUIRED` and the misleading message that the
   approved source changed. At load 6–10 (run-IdkmiX) `IMPORT` passed in 26.8 s and
   29.3 s, i.e. within 10% of the limit. [INFERENCE] Every 10,000-file import fails the
   same way. Commit `635b48b` excludes consumer time from the inspection limit (reading
   the source stays bounded); regression test
   `LocalSourceBindingTest.retainedSourceWritesDoNotConsumeTheSourceInspectionTimeBudget`
   passes after the fix (rerun in this session: 39 tests, 0 failures). Its failure
   before the fix was observed by the earlier session of this unit, not re-observed
   here. The next candidate must include `635b48b`.
2. **Medium and large classes exceed declared product limits (High for the gate, open).**
   One TypeScript project request is limited to 20,000 files and 10 MiB JSON
   (`TsRequestBudget.MAX_FILES/MAX_BYTES`, `analyzers/ts-analyzer/src/analyze.service.ts`).
   The planned fixtures (computed in memory with `planWorkload`, nothing written)
   contain 5,499 TS/TSX/JS files with 26,271,054 content bytes (medium) and 27,499 files
   with 105,158,175 bytes (large), so `TS_PARSING` must reject both with the explicit
   budget error. The backend admits at most 20,000 files per import
   (`app.analysis.max-files`, default `20000`), so the 50k-file large class is never
   fully admitted. No medium or large packaged run was made; this is source inspection.
   Resolving it is a product decision: either split TS analysis into bounded requests
   and raise the admission limit, or narrow the supported size classes that doc 05 §4
   advertises.
3. **Small analysis exceeds its time SLO in every completed smoke run; RSS in 2 of 3 (provisional).**
   Approval to populated overview: 100.8 s (run-AxkHyG, uncalibrated fixture) and
   61.9 s (run-IdkmiX run 2) against p95 ≤ 30 s. `IMPORT` (26.8–29.3 s),
   `SOURCE_PARSING` (18.9–25.4 s) and `TS_PARSING` (9.1–41.2 s) dominate. Peak
   owner-tree RSS in the analysis phase: 2.85, 3.20 and 3.28 GiB against the 3 GiB
   ceiling (2 of 3 over). Not acceptance numbers; the quiet 20-run series decides.
4. **Cancellation during `IMPORT` is observed only after the step ends (Medium, open).**
   In run-IdkmiX the cancel trigger fired 1 s into `IMPORT`; UI acknowledgement took
   1 ms, but the job reached `CANCELLED` and released the project lock only after
   25.9 s and 24.8 s (SLO: p95 ≤ 5 s, max 10 s). The lock release itself was proven
   (refresh preview accepted afterwards). [INFERENCE] The import loop does not check
   the job's cancellation flag per file; `LocalStagingVerifier.check()` honours only
   thread interruption and the time limit. Proposed fix: check the job cancellation
   state in the per-file import loop and stop with `CANCELLED`, with a regression test
   that cancels mid-import.
5. **One refresh spent 660.5 s in `CROSS_DOMAIN` (provisional High, unreproduced, open).**
   run-IdkmiX run 2: the full refresh after the 1% change took 698.2 s, of which
   `CROSS_DOMAIN` took 660,504 ms; the same step took 35 ms in the first analysis of the
   same run and 42 ms in the refresh of run-AxkHyG. The result still equalled the full
   analysis (`resultEqualsFull: true`). Load average (6–10) cannot explain a ~15,000×
   step slowdown and the in-app database is private to the synthetic profile. Root
   cause is unknown; [INFERENCE] candidate: a poor plan for the second snapshot's
   `graph_edges`/`graph_nodes` joins in `CrossDomainStep` while statistics are stale.
   Needs a reproduction with query timing before it is classified finally.
6. **Overview not shown after a finished analysis (unclassified, open).** run-IdkmiX
   run 1: the analysis job ended `DONE` after 57.7 s but the overview page with at least
   one row was not observed within 60 s, so the run failed with `OVERVIEW_NOT_SHOWN`.
   Whether the renderer did not navigate/populate or the runner's watcher missed it is
   undetermined. Run 2 with the same runner showed the overview normally.
7. **Project deletion is slow (Medium, open).** Deleting the analyzed small project
   (two snapshots, about 64k nodes) did not finish within the then 60 s diagnostic limit
   (run-AxkHyG, `PROJECT_DELETE_FAILED`). Foreign keys
   `graph_edges.source_node_id/target_node_id` and `graph_nodes.file_id` have no
   leading-column index (V6 indexes lead with `snapshot_id`), so [INFERENCE] every
   cascaded node delete scans the edge table. Proposed fix: a new migration adding
   those three indexes (past migrations unchanged).

Functional facts that held in every completed run: 1,000 of 1,000 files admitted with
5,242,880 bytes read; preview completed in 0.65–1.02 s; the 1% refresh result equalled
the full analysis (refresh is always a full reanalysis; incremental reanalysis is not
implemented, so it is measured as the SLO full fallback); graph API calls 9–231 ms;
first result page rendered in 8 ms (product page is 40 rows, there is no 100-node view).

## What was built

| File | Purpose |
| --- | --- |
| `validation/pre-release/workload-fixture.cjs` | Seeded, offline Java/Spring, NestJS, React and JavaScript generator. Exact file count and byte budget per class (small 1,000/5 MiB, medium 10,000/50 MiB, large 50,000/200 MiB); bytes are 50% Java, 18% TS, 17% TSX, 15% JS. Cross-file imports, Spring controllers called by React `fetch`, Nest modules/DI; about 400 bytes per method. Tree digest = SHA-256 over sorted `sha256\tsize\tpath`. Deterministic 1% change (`mutateWorkload`). |
| `validation/pre-release/workload-metrics.cjs` | Unchanged SLO table, p95 at rank ⌈0.95n⌉ with failed samples kept as +∞, RSS ceilings over every run, required checks, smoke labelling, phase-aware owner-tree RSS sampler (100 ms). |
| `validation/pre-release/run-workload-benchmark.cjs` | Packaged-app runner: `--app <bundle> --class small|medium|large --smoke-1|--smoke-2|--series-20 [--rows …] [--keep-work]`. New synthetic profile per run, real UI drag/preview/approve, renderer-side marks, job step timings, graph API latency, 1% refresh, cancel (also during `IMPORT`) with lock-release proof, preview-only row for the large class, optional delete diagnostic, AC/load/disk/build/fixture identities. |
| tests | `test/workload-fixture.test.cjs` (8) and `test/workload-metrics.test.cjs` (16). |
| product | `backend/src/main/java/dev/codeintelligence/project/LocalStagingVerifier.java` (finding 1) with `LocalSourceBindingTest` regression test. |

The runner follows the startup-benchmark conventions: owned output under
`validation/local/workload-performance/run-*`, clean environment, mock Keychain,
isolated-run claim, fixed failure codes, no raw stderr, source/bundle/fixture hashes
re-checked at the end, AC observed at run boundaries, profiles removed only after the
owned process tree is confirmed gone. A failed, timed-out or unexecuted run stays in
the series.

## What ran

| Check | Command (cwd = worktree root unless noted) | Result |
| --- | --- | --- |
| Runner unit tests | `node --test validation/pre-release/test/workload-fixture.test.cjs validation/pre-release/test/workload-metrics.test.cjs` | 24 pass, 0 fail |
| Product regression | cwd `backend`: `./gradlew --offline test --tests 'dev.codeintelligence.project.LocalSourceBindingTest'` | BUILD SUCCESSFUL; 39 tests, 0 failures, 0 errors |
| Smoke (earlier session, runner at `bcd8081` + uncommitted draft) | mode `SMOKE`, `--class small`, 1 run, rows analysis,graph,incremental,cancel (from `result.json`; exact argv not retained) | run-AxkHyG: FAIL `PROJECT_DELETE_FAILED` (analysis/graph/refresh completed) |
| Smoke (earlier session, runner at `5e88565`) | mode `SMOKE`, `--class small`, 2 runs, rows analysis,graph,incremental,cancel,delete (from `result.json`) | run-fkMoaB: 2/2 FAIL `ANALYSIS_FAILED` (`IMPORT` limit, finding 1) |
| Smoke (this session) | `with-native-lock.sh gate-perf env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/run-workload-benchmark.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app" --class small --smoke-2` | run-IdkmiX: `SMOKE_ONLY`, `INCOMPLETE`; run 1 FAIL `OVERVIEW_NOT_SHOWN`, run 2 PASS (functional) |

One earlier attempt of this session's smoke (`smoke-small-d-cancelled-before-lock.log`)
was cancelled on coordinator request while still waiting for the native lock; it never
launched the app.

### Smoke observations (single observations, not acceptance)

| Observation | run-AxkHyG (1 run) | run-fkMoaB (2 runs) | run-IdkmiX run 1 | run-IdkmiX run 2 | SLO |
| --- | --- | --- | --- | --- | --- |
| Load average at start | 5.1 | 34.0 / 34.8 | 6.4 | 6.7 | quiet machine |
| `IMPORT` step | 29.3 s | FAILED 31.8 / 31.5 s | 26.8 s | 29.3 s | (30 s inspection limit) |
| Analysis (approve → overview) | 100.8 s | — | job DONE 57.7 s, overview not seen | 61.9 s | p95 ≤ 30 s |
| Peak owner-tree RSS, analysis | 2.85 GiB | 1.54 GiB (failed early) | 3.20 GiB | 3.28 GiB | ≤ 3 GiB |
| Graph API (search / node page / relations) | 52–150 / 36–46 / 12–20 ms | — | — | 31–42 / 213–231 / 9–16 ms | p95 ≤ 500 ms (medium) |
| First page render | 8 ms | — | — | 8 ms | ≤ 2 s (medium) |
| 1% refresh (full reanalysis) | 64.0 s, equal | — | — | 698.2 s (`CROSS_DOMAIN` 660.5 s), equal | p95 ≤ 30 s (medium) |
| Peak owner-tree RSS, whole run | 3.82 GiB | 1.54 GiB | 3.20 GiB | 3.83 GiB | — |
| Cancel UI ack / lock release | not run | not run (analysis failed) | 1 ms / 25.9 s | 1 ms / 24.8 s | ≤ 500 ms / p95 ≤ 5 s, max 10 s |
| Delete diagnostic | > 60 s (FAIL) | 74 / 107 ms (no snapshots) | not requested | not requested | no SLO |

## Requirement matrix

| ID | Requirement (doc 05 §4 / doc 07 G-PERF) | Status | Evidence / reason |
| --- | --- | --- | --- |
| R1 | preview 10k/50 MiB p95 ≤ 10 s, first response ≤ 500 ms (20 runs) | NOT RUN | medium series not run; medium analysis blocked (R5), preview row alone can run with `--class medium --rows preview` |
| R2 | preview hard limit 50k files / 512 MiB | NOT RUN | no over-limit case run; backend admits 20,000 files (finding 2) |
| R3 | small analysis 1k/5 MiB p95 ≤ 30 s (20 runs) | NOT RUN | series reserved for coordinator; smoke 100.8 s and 61.9 s exceed (finding 3) |
| R4 | small analysis full process-tree RSS ≤ 3 GiB (every run) | NOT RUN | series not run; smoke 2.85, 3.20, 3.28 GiB |
| R5 | medium analysis 10k/50 MiB p95 ≤ 180 s, RSS ≤ 4 GiB | BLOCKED | TS request budget 20,000 files / 10 MiB vs 26.3 MB TS/JS (finding 2); needs product decision |
| R6 | large 50k/200 MiB p95 ≤ 600 s, RSS ≤ 6 GiB, 15 min hard timeout | BLOCKED | `app.analysis.max-files` 20,000 and TS budget (finding 2) |
| R7 | 1% change on medium p95 ≤ 30 s, result equal to full | BLOCKED | depends on R5 |
| R8 | cancel UI ack ≤ 500 ms; release p95 ≤ 5 s / max 10 s (20 runs) | NOT RUN | series not run; small smoke release 25.9 s and 24.8 s exceed max (finding 4) |
| R9 | graph search/partial API p95 ≤ 500 ms, first 100 nodes ≤ 2 s (medium) | BLOCKED | depends on R5; small smoke within limits |
| R10 | 6 GiB analysis memory watchdog stops new work | NOT RUN | no test in this unit |
| R11 | quota: workspace 10 GiB, parser temp 2 GiB, cache 2 GiB, import free-space pre-check | NOT RUN | runner records profile bytes only; no quota-enforcement case |
| R12 | 20-run series per supported size class on a quiet machine with the new candidate | NOT RUN | reserved for coordinator; command in ledger `series20` |
| R13 | full owner process-tree RSS, not backend single process | PASS | `workload-metrics.cjs` sampler, unit tests; run-IdkmiX run 2 `samplingComplete: true`, max gap 170 ms |
| R14 | runner and fixture correctness | PASS | 24/24 node tests |
| R15 | regression test for finding 1 | PASS | `LocalSourceBindingTest` 39/0 |
| R16 | refresh result equals full analysis (small, functional) | PASS | `resultEqualsFull: true` in run-AxkHyG and run-IdkmiX run 2 |
| R17 | execution environment and evidence disclosed | PASS | `environment`, identities and hashes in each `result.json`; ledger |
| R18 | project deletion completes (diagnostic, no SLO) | FAIL | run-AxkHyG > 60 s (finding 7) |

Counts: PASS 5, FAIL 1, NOT RUN 8, BLOCKED 4 (18 rows). Findings 1–7 are ledger
defects D1–D7.

## Limits

- Smoke numbers come from a machine shared with up to five concurrent agents; none is
  an acceptance result. Cold OS cache was not measured.
- Candidate 1lvULq predates `635b48b`; the import margin in run-IdkmiX (26.8–29.3 s) is
  not evidence that finding 1 is harmless.
- Findings 2, 4 (cause) and 7 (cause) rest on source inspection; finding 5 and 6 are
  single observations without a root cause.

## Remaining conditions

1. Build a new candidate that includes `635b48b`.
2. On a quiet machine, run the small 20-run series (exact command in the ledger,
   `series20.small`) and read `assessment` in its `result.json`.
3. Product decision on finding 2 (TS request budget and admission limit vs the advertised
   medium/large classes); only then can R5–R7, R9 run (`series20.medium`/`large`).
4. Reproduce and classify finding 5 and 6; fix findings 4 and 7 with regression tests.
5. Cover R2, R10 and R11 with dedicated cases.
