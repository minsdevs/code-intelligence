# Medium class backend OutOfMemoryError (unit w7-medium) — 2026-10-08

## Scope

Unit **w7-medium**, branch `gate/w7-medium` from integration `34b9293`. Defect: G-PERF R5, the
packaged medium smoke on candidate 9lVRha (`run-u8ObYG`, earlier `run-abPyCb`) admitted 10,000
files, then the backend (`-Xms64m -Xmx2048m -XX:+UseSerialGC`) failed with
`OutOfMemoryError: Java heap space` and the job ended `ANALYSIS_FAILED`. Earlier unit work is kept:
[perf-fixes](perf-fixes-2026-10-07.md) (batched persistence, lazy extractor parsing, TS sessions)
and [scale-large](scale-large-2026-10-07.md) (vault barrier, sliced TS, R10 watchdog). No packaged
app was launched; no SLO, threshold, heap option or gold data was changed; no migration was added.
Every timing and memory figure below is a **non-acceptance observation** on a shared machine.
Release verdict: **NO_GO**.

## Evidence read from the packaged failure

`run-u8ObYG/resource-samples.csv`: the backend process grew from 0.5 GiB to its 2.4 GiB ceiling
between 32 s and 44 s into the analysis phase and stayed there until the runner gave up; the
`https-jsse-nio` acceptor thread then died with the OOM (`backend.log`), so the runner's job poll
failed (`ANALYSIS_FAILED` is the runner's label for a failed poll). The backend log has no step
lines, so the failing step was not visible in the packaged evidence.

## Reproduction below the app

`validation/pre-release/workload-backend-memory.cjs` generates the workload fixture
(`workload-fixture.cjs`, medium tree digest `b61f3ce0…9635fe`, equal to the packaged run's), starts
the real TS analyzer (`analyzers/ts-analyzer/accuracy-server.cjs`, loopback) and runs the Gradle
task `workloadMemoryTest` (`WorkloadMemoryHarnessTest`): every pipeline step after IMPORT on a
synthetic single-commit repository of the tree, Testcontainers PostgreSQL, a test JVM with the
desktop backend's heap options (`-Xms64m -Xmx<heap> -XX:+UseSerialGC`, optional heap dump). It
prints one `[workload-memory]` line per step (wall time, peak heap, peak old generation after GC,
committed heap, full GCs) and the test JVM's and analyzer's peak RSS. The task is excluded from
`test`.

On `34b9293` (run `medium-base`): FILE_INVENTORY → GIT_METADATA passed (peak heap ≤ 116 MiB), then
`SOURCE_PARSING` failed: `Gradle Test Executor … java.lang.OutOfMemoryError: Java heap space`.
Live class histograms (`jcmd GC.class_histogram`, three samples while the heap filled) were
dominated by JavaParser syntax trees: 14.2 M `Position` (340 MB), 7.1 M `JavaToken` (227 MB),
9.1 M `Range`, 2.0 M `TokenRange`; the test thread was in `JavaAnalyzer.parseFile` ←
`JavaAnalyzer.analyze:99` ← `SourceParsingStep.run:84`. No heap dump was written to disk (the
histograms, thread dumps and, on the regression corpus, a JFR old-object sample gave the
retainers; disk was tight).

## Root causes (all in `JavaAnalyzer`)

1. **Every syntax tree was retained for three passes.** `analyze` parsed all Java files into a
   list, then ran `registerTypes`, `visitMembers` and `visitCalls` over the list. A JavaParser tree
   with tokens costs about 80–90x its source in heap; the medium class has 26 MB of Java (4,496
   files), so the list alone needs more than 2 GiB.
2. **The symbol solver kept a second copy of nearly every file, strongly, beyond the analysis.**
   `JavaParserTypeSolver(Path)` and `CombinedTypeSolver()` use unbounded caches. Every solved type
   pins the tree declaring it (`CombinedTypeSolver.typeCache` is a strong `InMemoryCache`, path
   `typeCache → SymbolReference → JavaParserClassDeclaration → wrappedNode`, seen in a JFR
   old-object sample on the regression-test corpus), and a name that is not a project type (`String`, an unresolvable library
   annotation) parses *every file of the package* it is looked up from (`parsedDirectories`).
   `JavaParserFacade` keeps a facade per type solver in a static `WeakHashMap` whose values
   reference their keys, so the solver and those trees also stayed reachable after `analyze`
   returned (228 MiB left over in the regression test below).
3. **Quadratic unresolved-call fallback (CPU).** An unresolved call scanned every project method
   (`projectMethods.entrySet().stream().filter(name)`); on the medium tree this was 55% of the
   CPU samples (JFR) once memory was fixed.

## Fix

- `JavaAnalyzer.analyze` keeps only the list of files that parsed; each pass parses the file again,
  one at a time (the analysis workspace is read-only; a later parse failure is reported as
  "Java source changed during analysis"). Order of nodes, edges and evidence is unchanged.
- The symbol solver's four caches are size-bounded Guava caches (soft values, like the library's
  own size-limited mode) weighted by syntax trees: at most 128 trees each (a cached package weighs
  its file count; unsolved names and missing files weigh nothing; one segment so a large package
  fits). After each analysis the static facades are released (`JavaParserFacade.clearInstances()`
  under the facade class lock; facades hold no results).
- Project methods are indexed by name (`LinkedHashSet` per name, first-declaration order), giving
  the same candidate lists as the scan.

Exactness: base `34b9293` (with an 8 GiB heap) and the fix (2 GiB) produce identical sorted
digests on the medium Java tree — 103,125 nodes, 202,099 edges, 91,425 evidences, 4,496 file
outcomes (scratch comparison, not committed; metadata compared with sorted keys). Java analysis
time on that tree: base 143 s (8 GiB), fix 58–74 s (2 GiB, four runs).

### TS session timeout found on the same path (fixed)

With SOURCE_PARSING fixed, the harness failed next in `TS_PARSING`: `TsAnalyzerException:
ts-analyzer request failed` ← `HttpTimeoutException`. The sealed session's single `analyze`
command extracts the whole project (medium TS/JS ≈ 25 MiB; [scale-large](scale-large-2026-10-07.md)
measured 37 s for it in-process), but every analyzer request, including the packaged control
socket exchange (`TsAnalyzerControlClient` watchdog), is bounded by `app.ts-analyzer.timeout-seconds`
(30 s; the desktop does not override it). The `analyze` command now gets the configured timeout once
per started single-request budget (10 MiB) of manifest bytes (medium 90 s, large ≈ 300 s); other
commands keep 30 s; cancellation and the R10 watchdog still stop it. `TsAnalyzerClient` and
`TsAnalyzerControlClient` gained an `analyze(request, timeout)` overload.

## Red → green

| Defect | Test | Red (observed) | Green (observed) |
| --- | --- | --- | --- |
| Retained trees + unbounded solver caches + facade leak | `JavaAnalyzerMemoryTest.liveHeapDuringAnalysisDoesNotHoldEverySyntaxTree` (1,200 generated classes, 1.72 MB; peak live heap beyond the result < 100 MiB, left over after the analysis < 10 MiB, outcomes and 4,796 confirmed CALLS) | on `34b9293`: `expected < 100 but was 231` (peak 463 MiB over baseline, 228 MiB left over) | 1/0 (peak 61 MiB over baseline, result 4 MiB, left over 0 MiB) |
| Same, end to end at the packaged heap | `WorkloadMemoryHarnessTest` medium, 2048m | `OutOfMemoryError: Java heap space` in SOURCE_PARSING | all 14 steps DONE, snapshot READY (table below) |
| Session analyze bounded by one request timeout | `TsProjectSessionTimeoutTest.analyzeCommandOfAProjectOverOneRequestBudgetOutlastsThePerRequestTimeout` (HTTP, 1 s timeout, 11 MB manifest, 1.5 s extraction); `TsAnalyzerControlClientTest.aRequestWithItsOwnTimeoutOutlastsTheConfiguredOne` (control socket) | on `34b9293`: `TsAnalyzerException: ts-analyzer request failed` at `TsProjectSession.page(TsProjectSession.java:120)` ← `Request cancelled` | 2/0 and 1/0 |

Directly affected suites on the final tree (`--offline cleanTest test`): `analysis.java.*`,
`FixtureAccuracyTest`, `T00ObservationExportTest`, `ConfigAnalyzersGoldenTest`,
`FullstackCrossDomainGoldenTest`, `SpringMiniEndpointsFeaturesGoldenTest`,
`SpringMiniGraphGoldenTest`, `ReactMiniTsParsingGoldenTest`, `RetrySourceGuardTest`,
`FixtureGoldenTest`: 77 tests, 0 failures, 1 skipped (opt-in `T00ObservationExportTest` export);
`analysis.ts.*`: 68 tests, 0 failures. `spotlessCheck` clean. Final memory-test line: peak 59 MiB
over baseline, result 4 MiB, left over 0 MiB.

## Medium harness after the fix (non-acceptance observation)

Final tree, `workload-backend-memory.cjs --class medium` (tree `b61f3ce0…`), 2048m SerialGC, all
steps after IMPORT, snapshot READY:

| Step | ms | peak heap MiB | peak old gen after GC MiB | committed MiB |
| --- | ---: | ---: | ---: | ---: |
| FILE_INVENTORY | 3,202 | 110 | 51 | 125 |
| LANGUAGE_FRAMEWORK | 229 | 109 | 51 | 125 |
| AREA_DETECTION | 613 | 113 | 51 | 125 |
| GIT_METADATA | 4,146 | 117 | 51 | 125 |
| SOURCE_PARSING | 112,373 | 590 | 251 | 607 |
| GRAPH_BUILD | 40,502 | 484 | 147 | 607 |
| TS_PARSING | 52,037 | 556 | 203 | 607 |
| TREE_PARSING / EXTRACTION / CROSS_DOMAIN | 44 / 78 / 537 | ≤ 472 | 203 | 607 |
| FEATURE_DETECTION | 49,360 | 590 | 219 | 607 |
| FLOW_DETECTION | 8,658 | 551 | 219 | 607 |
| FINDING_DETECTION / FINALIZE | 745 / 128 | 565 | 219 | 607 |

Sum 272.7 s (IMPORT not included). Peak RSS: test JVM 1,089 MiB, TS analyzer (Node, accuracy
server) 2,015 MiB. Before the fix the same run died in SOURCE_PARSING with the heap full.

Observations, not fixed here (time, not memory): the medium analysis SLO (p95 ≤ 180 s) is still
exceeded below the app — SOURCE_PARSING 112 s (Java analysis about 60 s of it, the four annotation
extractors and persistence the rest), GRAPH_BUILD 41 s, TS_PARSING 52 s, FEATURE_DETECTION 49 s.
[INFERENCE] Owner tree at the TS peak: backend ≈ 1.1 GiB + TS analyzer ≈ 2.0 GiB + PostgreSQL,
Redis and Electron (≈ 0.9 GiB at packaged STARTUP minus the backend) ≈ 4.0 GiB, at the 4 GiB
limit; only the packaged run can tell, because the packaged TS worker is not the accuracy server.

## Large class

Same harness, `--class large` (50,000 files / 200 MiB, tree `5f5e7354…`), 2048m: **no step failed,
no OutOfMemoryError**, snapshot READY after 2,240 s of steps (IMPORT not included; the 600 s SLO and
the 15 min job limit would both stop it). Largest steps: SOURCE_PARSING 508 s (peak heap 1,460 MiB,
old gen after GC 877 MiB, committed 1,979 MiB, 87 full GCs), GRAPH_BUILD 840 s, FEATURE_DETECTION
512 s, TS_PARSING 263 s (inside the new 300 s session budget, so with little margin), FLOW_DETECTION
45 s. Peak RSS: test JVM 2,398 MiB, TS analyzer 2,423 MiB. The heap is close to its cap for large
(committed 1,979 of 2,048 MiB), so large has no memory headroom in the backend.

GRAPH_BUILD's time is spent in `GraphPersistenceService.persist`'s candidate lookup (`select … from
graph_nodes n … where n.snapshot_id = $1 and n.natural_key in ($2 … $501)`, 500 keys per batch):
the PostgreSQL backend sat at 100% CPU for about 6.5 s per batch on the large run, while the same
statement prepared in `psql` against the same database (also as a forced generic plan, 6
executions) used the `(snapshot_id, natural_key)` unique index and took 1.5 ms. The plan the app's
pooled connection uses was not captured (no `auto_explain`/`pg_stat_statements` in the test
image); [INFERENCE] a plan cached on that connection before the bulk insert of SOURCE_PARSING
(compare the CROSS_DOMAIN statistics finding in [perf-fixes](perf-fixes-2026-10-07.md)). Not fixed.

## Changed paths

Product: `backend/src/main/java/dev/codeintelligence/analysis/java/JavaAnalyzer.java`,
`backend/src/main/java/dev/codeintelligence/analysis/ts/{TsProjectSession,TsAnalyzerClient,TsAnalyzerControlClient}.java`.
Tests and harness: `backend/src/test/java/dev/codeintelligence/analysis/java/JavaAnalyzerMemoryTest.java`,
`backend/src/test/java/dev/codeintelligence/analysis/ts/{TsProjectSessionTimeoutTest,TsParsingStepTest,TsAnalyzerControlClientTest}.java`,
`backend/src/test/java/dev/codeintelligence/analysis/WorkloadMemoryHarnessTest.java`,
`backend/build.gradle.kts` (`workloadMemoryTest` task, excluded from `test`),
`validation/pre-release/workload-backend-memory.cjs`. `desktop/src/jvm-options.cjs` is unchanged.

## Limits and what remains

- No packaged run: acceptance of both fixes (and the packaged owner-tree RSS) is pending the next
  coordinator candidate. The harness runs below the app: no IMPORT, Docker PostgreSQL instead of the
  bundled one, the accuracy-server TS analyzer instead of the packaged worker, a Gradle test JVM.
- Java analysis now parses every file three times (plus the four extractors' own parses); results
  are byte-identical on the medium tree, but the analysis is CPU-bound and the remaining time
  findings above (SOURCE_PARSING, GRAPH_BUILD, FEATURE_DETECTION, TS_PARSING) keep medium and large
  over their time SLOs.
- The 128-tree cache budget is a count, not bytes: a project of very large files can still hold
  128 × (tree of one file) per cache. The facade release clears all `JavaParserFacade` instances,
  which only costs a concurrent analysis its facade (recreated on next use).
- The TS session budget scales linearly with source size (30 s per started 10 MiB); large used 263 s
  of 300 s here.
- `JavaAnalyzerMemoryTest` measures live heap with explicit full GCs every 100 ms in the shared test
  JVM; its bounds (100 MiB working, 10 MiB left over) are wide against the fixed values (59/0)
  and narrow against the base (231/228).

## Proposed shared-doc text (not applied)

- validation/pre-release/README: "`workload-backend-memory.cjs --class <small|medium|large>` runs
  every analysis step after IMPORT on the workload fixture with the desktop backend's heap options
  and the real local TS analyzer (Docker required) and prints step time, heap and RSS; it is an
  observation tool, not an acceptance measurement."
- 03 §6: "A sealed session's `analyze` command is bounded by the request timeout once per started
  10 MiB of manifest source; other commands keep the per-request timeout."
- 05 §4: "Java analysis keeps at most one parsed file per pass plus a bounded symbol-solver cache;
  medium below the app peaks at about 0.6 GiB of backend heap (2 GiB limit), large at about 2 GiB."
