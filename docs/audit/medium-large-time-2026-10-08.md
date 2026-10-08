# Medium and large analysis time (unit w8-graph) — 2026-10-08

## Scope

Unit **w8-graph**, branch `gate/w8-graph` from integration `dba2557`. Goal: bring the medium
(10,000 files / 50 MiB) and large (50,000 files / 200 MiB) classes toward the 05 §4 analysis SLOs
(medium p95 ≤ 180 s / ≤ 4 GiB, large p95 ≤ 600 s / ≤ 6 GiB, 15 min hard timeout), in the order
given: the GRAPH_BUILD lookup plan, steps that scale super-linearly, SOURCE_PARSING time and large
heap headroom, TS time against its 300 s session budget. Earlier work is kept and referenced:
[medium-oom](medium-oom-2026-10-08.md) (heap fix, harness), [perf-fixes](perf-fixes-2026-10-07.md),
[scale-large](scale-large-2026-10-07.md). No packaged app was launched; no SLO, timeout, heap
option, threshold or gold data was changed; no Flyway migration was needed (so
`desktop/src/backup-export-policy.cjs` is unchanged). Every time and memory figure below is a
**non-acceptance observation** below the app on a shared machine (load average 3–24 from other
sessions). Release verdict: **NO_GO**.

## Method

`validation/pre-release/workload-backend-memory.cjs` (w7 harness: every step after IMPORT on the
workload fixture, Testcontainers PostgreSQL 16, the real local TS analyzer, a test JVM with the
desktop heap options `-Xms64m -Xmx2048m -XX:+UseSerialGC`) gained three observation options:
`--explain-ms/--explain-log` (auto_explain loaded on every pooled connection, the plans of slower
statements copied from the container log), `--jfr` (JFR profile) and `--jvm-args` (compare collector
options); the test now prints order-independent result digests (`[workload-memory] digest`: count
and md5 of sorted rows of nodes, edges, node evidence, file outcomes, feature links, flow steps and
findings, by natural key, no generated ids). Base runs check out the `dba2557` product sources
(backend and `analyzers/ts-analyzer/src`) into the same worktree for the run only.

## Root causes and fixes

### 1. GRAPH_BUILD candidate lookup: a generic plan cached on the empty snapshot (fixed)

Captured with auto_explain on the app's own pooled connection (reduced-scale test below, the same
statement as `GraphPersistenceService.persist`):

```
Nested Loop Left Join  (cost=4.45..27.39 rows=2 width=200)
  ->  Bitmap Heap Scan on graph_nodes n  (cost=4.16..10.75 rows=2 width=184)
        Recheck Cond: (snapshot_id = $1)
        Filter: (natural_key = ANY (ARRAY[($2)::text, ($3)::text, … ($501)::text]))
        ->  Bitmap Index Scan on idx_graph_nodes_snapshot_area  (cost=0.00..4.16 rows=2 width=0)
              Index Cond: (snapshot_id = $1)
```

600 ms per execution at 60,000 rows (6.5 s at the large class). Cause: pgjdbc prepares a repeated
statement on the server, and after five executions PostgreSQL keeps a **generic plan**. SOURCE_PARSING
persists the whole Java result in one transaction whose first ~200 lookups run while the snapshot is
still empty, so the generic plan is built for a 2-row table: scan the snapshot, compare each row
with 500 parameters (a parameter array is not hashed, unlike a constant one). Nothing invalidates it
before GRAPH_BUILD looks up its keys in the filled snapshot on the same connection. The same
statement with constants (a custom plan) took 5–8 ms even without statistics (one hashed pass).

Fix: `common/CustomPlans` runs the three key-list lookups of `GraphPersistenceService` (stored
drafts, file ids, stored edge endpoints) with `plan_cache_mode = force_custom_plan` set
transaction-locally and restored afterwards. Not the whole transaction: replanning every upsert
cost 2.6 s → 4.6 s for 60,000 nodes. ANALYZE was not needed (the custom plan is linear without
statistics), so no migration.

### 2. Super-linear steps (fixed)

- **FEATURE_DETECTION** (medium 49 s, large 512 s). JFR: 97% in
  `FeatureLinkBuilder.expandOwnersAndEntities`. Per feature, every graph node was scanned for
  `DB_ENTITY` nodes, and per table the whole included set was copied and scanned (tables × included
  nodes, and features × graph nodes; the large workload has about 4,250 route features over 768k
  nodes). Now the included ENTITY files are collected once per feature and only the table nodes
  (listed once per builder, same order) are checked. `FeatureMerger.jaccard` copied both seeds twice
  per pair (one seed holds every endpoint); it now counts the overlap without copying (same value).
- **Per-row statements**: feature links, flows, flow steps and flow/feature evidence were one
  statement each (medium about 30,000; large flow steps alone 105,973); now JDBC batches of 500 and
  `EvidenceService.replaceLinkedAll`. GIT_METADATA inserted each file of the snapshot commit (every
  file is added) separately; now batched.
- **GIT_METADATA scan** (medium 4.2 s, large 38–47 s). JFR: `GitMetadataScanner.lineStats` →
  `DiffFormatter.toFileHeader`, ObjectId parsing and ASCII encoding: each file's (discarded) patch
  header abbreviated its blob id, and JGit checks an abbreviation for uniqueness by listing the
  loose-object directory it falls in. The formatter now writes full ids (no lookup; line counts are
  unchanged).

### 3. SOURCE_PARSING time and heap (improved)

Timeline (JFR) on the medium class before: Java analyzer 68 s (three parses per file, plus the
symbol solver re-parsing evicted files on the job thread), the four annotation extractors 27 s
(one parse per file each), persistence 16 s, about 24 s of collector pauses inside.

- `ParseAhead` parses the next few files (at most `2 × helpers`, helpers = min(3, cores − 1)) on
  helper threads with one parser each and hands them back strictly in input order; used by every
  `JavaAnalyzer` pass and by `JavaParseSupport.parseJavaFiles`. Visiting, symbol solving and
  cancellation checks stay on the job thread.
- The symbol solver parses its own trees without token lists (it only reads declarations; call-site
  spans come from the analyzer's own trees, which keep tokens). `JavaAnalyzerMemoryTest`: peak live
  heap over baseline 61 → 25 MiB; medium SOURCE_PARSING 88.8 → 73.4 s, full GCs 41 → 20, identical
  digests.
- The other source analyzers (annotation extractors, config analyzers) run on one helper thread
  while the Java analyzer runs on the job thread (it checks for a cancel per file); results merge in
  analyzer order and a failing analyzer is still retried per file. A first version ran the *first*
  matching analyzer inline, which is not the Java analyzer in the Spring order, so the Java analyzer
  ran on the helper without cancel checks and nothing overlapped; corrected and tested.
- Tried and rejected: the extractors' parser without token lists changed the node and evidence
  digests (excerpts), so it was reverted; `-Xmn256m` (88.9 s vs 88.8 s) and a 256-tree solver cache
  (72.2 s vs 73.4 s) made no difference.

### 4. TS extraction time (improved; in `analyzers/ts-analyzer`)

CPU profile of the in-process extraction (`workload-ts-memory.cjs`, medium 38.5 s): 45% in
ts-morph `getDescendantsOfKind`, called once per kind by `forEachDescendantOfKinds` and walking the
tree through nested generators (cost: tree depth per node); on large, 20 s in ts-morph
`getLineNumberAtPos`, which counts newlines from the start of the file on every
`getStartLineNumber()`/`getEndLineNumber()` call. Now one iterative walk per call collects all
requested kinds (same wrappers, same order, wrapped in pre-order) and `lines.ts` answers line
numbers from one sorted newline index per source text (exactly ts-morph's count: `\n` only).

| TS/JS subset, in process | Before | After |
| --- | --- | --- |
| medium 5,499 files / 25.1 MiB | 38.5 s, 1,828 MiB RSS | 18.7 s, 1,830 MiB, digest `818f608b…` (unchanged) |
| large 27,499 files / 100.3 MiB | 198 s ([scale-large](scale-large-2026-10-07.md)), 2,197 MiB | 101.7 s, 2,190 MiB, digest `88d9d221…` (unchanged) |

## Red → green

| Defect | Test | Red (observed) | Green (observed) |
| --- | --- | --- | --- |
| Generic lookup plan | `GraphPersistenceLookupPlanTest.graphBuildLookupStaysFastAfterSourceParsingFilledTheSnapshot` (60,000 nodes persisted, then 20,000 new keys; budget 8 s) | `expected < 8000 but was 25521` | pass, 4.1 s incl. seeding |
| Table scan per table | `FeatureLinkBuilderScaleTest.linkingOneFeatureIsLinearInEntitiesAndIncludedNodes` (8,000 modules, budget 2 s) | `18395 < 2000` failed | 0.08 s |
| Graph scan per feature | `FeatureLinkBuilderScaleTest.linkingManySmallFeaturesDoesNotScanTheWholeGraphForEach` (4,000 features, 412k nodes) | `15733 < 2000` failed | 0.25 s |
| Seed copies per pair | `FeatureMergerTest.comparingManySeedsWithOneLargeSeedDoesNotCopyTheLargeSeedPerPair` (budget 1 s) | 9.7 s | 0.04 s |
| Per-row links/flows/evidence | `DetectionPersistenceRoundTripTest.featureLinksAndFlowsCostRoundTripsPerBatchNotPerRow` (300 modules; also exact links, step order, evidence) | `expected < 50 but was 2409` | pass |
| Per-file commit rows | `GitMetadataStoreRoundTripTest.storingACommitCostsRoundTripsPerBatchNotPerFile` | `expected < 20 but was 2005` | pass |
| Abbreviation lookups | `GitMetadataScannerTest.scanningOneCommitThatAddsManyFilesStaysLinear` (one commit adding 30,000 files, budget 4 s; 12,000 files did not separate) | `12596 < 4000` failed | pass (scan about 1.2 s; at 50,000 files 30.4 s → 2.0 s) |
| Serial parsing | `JavaParseSupportTest.parsesABoundedNumberOfFilesAheadAndDeliversThemInOrder` (replaces `parsesEachFileOnlyWhenTheCallerReachesIt`, which pinned strictly one-at-a-time parsing; the bound is now `AHEAD`) | `0 between [1, 6]` failed | pass |
| Analyzers in sequence | `SourceParsingConcurrencyTest.laterAnalyzersRunWhileTheFirstOneDoesAndResultsKeepAnalyzerOrder` | overlapped `false` | pass |
| Java analyzer off the job thread (own regression) | `SourceParsingConcurrencyTest.theJavaAnalyzerRunsOnTheJobThread` | on `8bb4f5b`: `false` | pass |
| Walk per kind | `walk.test.ts` deep tree (3,000-term chain, budget 1 s) + identity/order equality with the old per-kind walk | 2,664 ms | 25 ms; first version overflowed the stack (recursive walk, then deep-first wrapping), fixed |
| Line numbers | `lines.test.ts` (20,000-line file, budget 0.5 s) + equality with ts-morph for every node with `\r\n`, lone `\r`, U+2028 | 5,428 ms | pass |

Directly affected suites on the final tree (Gradle `--offline spotlessCheck cleanTest test`,
`analysis.*`, `evidence.*`, `history.*`, `job.*`): 80 classes, **486 tests, 0 failures, 6 skipped**
(opt-in `T00ObservationExportTest`, the four opt-in `JobAnalyzerWorkerRaceIntegrationTest` cases
whose system property the Gradle test task does not pass, and the recorded-not-run C06-15 cell);
`EvidenceHistoryIntegrationTest` ran its other 14 cases against the rebuilt real TS analyzer.
spotlessCheck clean. `analyzers/ts-analyzer`: `tsc --noEmit` clean, vitest 13 files, **296 tests
passed**.

The solver token change has no red test of its own (it is a memory/time change with identical
output): evidence is the digest equality and `JavaAnalyzerMemoryTest` 61 → 25 MiB.

## Measurements (harness, non-acceptance)

Back to back on the same worktree and machine state (base = `dba2557` product sources), step
wall time in ms, IMPORT not included. Load average was 3–7 for the medium runs and up to 24 during
the last large run (other sessions).

| Step | medium base | medium after | large base | large after |
| --- | ---: | ---: | ---: | ---: |
| FILE_INVENTORY | 3,636 | 3,152 | 16,387 | 15,873 |
| LANGUAGE_FRAMEWORK / AREA_DETECTION | 228 / 625 | 226 / 620 | 1,142 / 3,064 | 1,141 / 3,026 |
| GIT_METADATA | 4,284 | 858 | 47,993 | 4,359 |
| SOURCE_PARSING | 112,815 | 74,563 | 507,302 | 349,965 |
| GRAPH_BUILD | 41,335 | 5,980 | 912,605 | 24,770 |
| TS_PARSING | 51,946 | 34,455 | (171,064 †) | 175,608 |
| TREE_PARSING / EXTRACTION / CROSS_DOMAIN | 45 / 75 / 525 | 45 / 74 / 557 | 42 / 382 / 2,879 | 48 / 391 / 2,849 |
| FEATURE_DETECTION | 51,979 | 2,405 | 518,482 | 13,582 |
| FLOW_DETECTION | 8,740 | 1,529 | 44,801 | 7,236 |
| FINDING_DETECTION / FINALIZE | 757 / 134 | 772 / 125 | 3,805 / 498 | 4,153 / 656 |
| **Sum** | **277.1 s** | **125.4 s** | **2,230 s †** | **603.7 s** |
| Peak heap / committed (MiB, of 2,048) | 605 / 610 | 640 / 683 | 1,737 / 1,979 | 1,794 / 1,819 |
| Peak live old gen after GC, SOURCE_PARSING (MiB) | 252 | 266 ‡ | 885 | 752 |
| Full GCs in SOURCE_PARSING | 37 | 20–23 | 87 | 26 |
| Peak RSS test JVM / TS analyzer (MiB) | 1,093 / 2,016 | 1,135 / 1,986 | 2,464 / 2,377 | 2,296 / 2,381 |

† The large base run's TS analyzer loaded `ts-extractor` lazily at its first request, after the
worktree's `dist` had been rebuilt from the new sources, so its TS_PARSING (171 s) used the new
extractor and is **not** a base figure. Base references: [medium-oom](medium-oom-2026-10-08.md)
263 s, an earlier run of this unit before the TS changes 266 s; in-process back to back the base
extractor takes 205.3 s and the new one 102.8 s (table in §4). The large base sum is therefore at
least about 90 s low. ‡ medium after: 205–269 MiB across runs.

Result digests: medium base = medium after (`nodes 182214:a026e061…`, `edges 317483:9059cc31…`,
`nodeEvidence 158155:07f64a1b…`, `files 10000:a7c3c93c…`, `featureLinks 7441:f5833cb6…`,
`flowSteps 21173:e7f26937…`, `findings 899:3a0b17e4…`); large base = large after (`nodes
768175:f324f912…`, `edges 1351952:aff9659a…`, `nodeEvidence 647916:acfeb1e2…`, `files
50000:fa332f2a…`, `featureLinks 37241:fc43f8b1…`, `flowSteps 105973:f36218b1…`, `findings
4499:d220a3c0…`). Every intermediate run of this unit had the same digests except the rejected
extractor experiment. Slow statements (> 1 s, auto_explain) after the fix: none in persistence; the
largest are GRAPH_BUILD's area tagging update (2.2 s medium, 10.1 s large, an UPDATE of most graph
rows) and file-contains edge insert (2.3 s medium).


## Changed paths

Product: `backend/src/main/java/dev/codeintelligence/common/CustomPlans.java` (new),
`backend/src/main/java/dev/codeintelligence/analysis/graph/{GraphPersistenceService,SourceParsingStep}.java`,
`backend/src/main/java/dev/codeintelligence/analysis/feature/{FeatureLinkBuilder,FeatureMerger,FeatureDetectionStep}.java`,
`backend/src/main/java/dev/codeintelligence/analysis/flow/FlowDetectionStep.java`,
`backend/src/main/java/dev/codeintelligence/analysis/java/{ParseAhead (new),JavaAnalyzer,JavaParseSupport}.java`,
`backend/src/main/java/dev/codeintelligence/history/{GitMetadataStore,GitMetadataScanner}.java`,
`analyzers/ts-analyzer/src/{walk,lines (new),ts-extractor,semantic-extractor}.ts`.
Tests and harness: the tests in the table, `backend/src/test/java/dev/codeintelligence/testsupport/StatementCounter.java`
(extracted from `GraphPersistenceRoundTripTest`), `WorkloadMemoryHarnessTest`, `backend/build.gradle.kts`
(`workloadMemoryTest` options), `validation/pre-release/workload-backend-memory.cjs`.

## Limits and what remains

- **SLOs are not shown to pass.** Below the app, medium analysis steps now take about 125 s
  (SLO 180 s for the whole job, IMPORT not included here) and large about 600 s, i.e. at the 600 s
  SLO before IMPORT (≈ 25 s of vault work per [scale-large](scale-large-2026-10-07.md)), on a busy
  machine. Only the coordinator's packaged runs on the next candidate decide the gates.
- Large remaining time: SOURCE_PARSING about 330–350 s (Java analysis on the job thread with the
  solver re-parsing evicted files, about 25% collector pauses with SerialGC, persistence of about
  500k nodes / 1M edges about 70 s), TS_PARSING about 170 s (extraction about 100 s, persistence
  about 45 s, one statement per file outcome about 10 s).
- Not done: per-file outcome statements (`FileAnalysisOutcome.record`, about 20 s for large over
  SOURCE_PARSING and TS_PARSING; batching needs the step mocks in `TsParsingStepTest`/
  `FileAnalysisOutcomeTest` reworked); persistence throughput (multi-row inserts would need a JDBC
  URL option, not in this unit's area); GRAPH_BUILD's area tagging UPDATE (10 s large);
  `react-component-binding.writtenBindings` (about 20% of large TS extraction CPU, runs over every
  file of every slice program). PostgreSQL logged "checkpoints are occurring too frequently" during
  large persistence (default `max_wal_size`; the desktop uses the same default) — not changed.
- Large heap headroom improved only modestly: SOURCE_PARSING's live old generation 885 → 752 MiB
  and full GCs 87 → 26, but the overall peak is in later steps (FEATURE_DETECTION and TS_PARSING
  hold the whole graph or TS result; 1,794 MiB of 2,048 committed in the last run).
- TS: the 300 s session budget for large now has about 200 s of margin in process (102.8 s); the
  packaged analyzer runs in the ADR-01 worker, not measured.
- Parsing ahead uses up to three more threads during Java analysis and one helper thread for the
  other source analyzers; after a cancel the helper's running analyzer finishes in the background
  (its result is dropped). The CPU use of the packaged backend rises accordingly.
- `JavaParseSupportTest.parsesEachFileOnlyWhenTheCallerReachesIt` was replaced: it pinned strictly
  one-tree-at-a-time parsing; the new test pins the bounded look-ahead (at most `AHEAD` trees).
- The plan fix forces custom plans only for the three key-list lookups; other repeated statements
  keep PostgreSQL's default plan cache behaviour.
- No packaged app, no IMPORT, Docker PostgreSQL instead of the bundled one, the accuracy-server TS
  analyzer instead of the packaged worker.

## Proposed shared-doc text (not applied)

- 05 §4: "Analysis lookups by key list are planned per execution (`plan_cache_mode =
  force_custom_plan`, transaction-local) so a generic plan built on an empty snapshot is never reused
  on a filled one. Below the app (Docker PostgreSQL, non-acceptance), steps after IMPORT take about
  125 s for medium and about 600 s for large."
- validation/pre-release/README: "`workload-backend-memory.cjs` also takes `--explain-ms <ms>
  --explain-log <file>` (plans of slower statements), `--jfr <file>` and `--jvm-args` and prints
  `[workload-memory] digest` lines to compare results between runs."

