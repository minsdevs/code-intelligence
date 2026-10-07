# G-PERF product fixes (unit w2-perf) — 2026-10-07

Scope: product defects behind G-PERF findings 3, 5 and 7 of the
[workload-performance audit](workload-performance-2026-10-07.md), the CROSS_DOMAIN refresh
slowdown of the [LA8ZS9 twenty-run series](release-gate-units-la8zs9-2026-10-07.md#g-perf-small-twenty-run-series-interrupted),
and the user's decision to support all three size classes (finding 2, R2/R5/R6). Branch
`gate/w2-perf` from `34b0e22` (contains the [bounded-cancel fix](bounded-cancel-2026-10-07.md)).
No packaged app was launched and no SLO or threshold was changed. Every timing below is a
**non-acceptance observation** on a shared machine (load average 3–19 during the runs); the
coordinator's twenty-run series on the next candidate decides the gate. Release verdict: **NO_GO**.

## Root causes found

1. **Refresh `CROSS_DOMAIN` 644–663 s (High, fixed).** After the first analysis autovacuum has
   analyzed `graph_nodes`/`graph_edges`/`frontend_routes`, so the refresh snapshot's freshly
   inserted rows are estimated at one row. The route query in `CrossDomainStep.linkConsumes` then
   nests a full-snapshot index scan inside another (`loops=385056`, 18k rows filtered per loop).
   Reproduced below the app in PostgreSQL 16 with the small workload's graph shape (18k nodes, 31k
   edges, 84 routes, 169 components per snapshot): **556,214 ms** for snapshot 2 versus **0.39 ms**
   for snapshot 1; after `ANALYZE` of the three tables (151 ms) the same query took **0.35 ms**.
   Fix: `CrossDomainStep` refreshes planner statistics (`ANALYZE` of the graph projection tables,
   bounded sampling) before its joins; all later steps benefit from the same statistics.
2. **Project delete > 60 s (Medium, fixed).** Nine single-column foreign keys into snapshot data
   had no leading-column index (`graph_edges.source_node_id/target_node_id`,
   `graph_nodes.file_id`, `feature_links.node_id`, `flows.entry_node_id`, `flow_steps.node_id`,
   `flow_steps.edge_id`, `analysis_findings.node_id`, `ai_conversations.snapshot_id`), so each
   cascaded row scanned the referencing table. New migration `V28__foreign_key_lookup_indexes.sql`
   (past migrations unchanged; V28 announced to the coordinator).
3. **Small `SOURCE_PARSING` (finding 3, partly fixed).** Measured with a scratch harness (real
   pipeline steps, Testcontainers PostgreSQL, 2 GiB SerialGC heap like the desktop backend, small
   fixture tree `88140e38…6254e`, fake TS analyzer):
   * `GraphPersistenceService` issued about five statements per node (file lookup, upsert, evidence
     delete/insert/link) plus one per edge — 8,410 statement executions for 1,200 nodes/2,401
     edges — and matched evidence to nodes with an O(nodes × evidences) stream filter. Now file
     ids, node upserts (JDBC batch with generated keys), evidence replacement
     (`EvidenceService.replaceLinkedAll`) and edge upserts are batched (500 rows), endpoint
     lookups are one IN query, evidence is grouped once.
   * The four annotation extractors (`JpaEntityExtractor`, `KafkaEventExtractor`, `LayerTagger`,
     `SpringEndpointExtractor`) each parsed every Java file up front and held all syntax trees at
     once. `JavaParseSupport.parseJavaFiles` now parses lazily, one file per iteration step.
4. **`IMPORT` ~26 s (not fixed, design needed).** The retained-source vault
   (`desktop/src/source-vault.cjs`, `put`) makes each blob durable with three `FileHandle.sync()`
   calls, which libuv maps to `F_FULLFSYNC` on macOS (mkdir parent sync, blob file sync, blob
   directory sync), plus about 272 `lstat` path-chain checks. Scratch benchmark of the real module
   (synthetic wrapper key, temp dir): **16.9 ms per 5 KiB put** (4.4 ms per raw write+sync;
   3.8 ms per put with syncs stubbed). One sequential put per file therefore costs about 17 s
   for the small class, [INFERENCE] about 170 s for medium and 850 s for large — over the medium
   (180 s) and large (600 s) analysis SLOs by itself. Node offers no plain `fsync` on macOS, so
   a fix needs a batched-durability vault operation (one barrier per chunk of blobs) or a
   pack format; that is a vault-format/durability decision for the source-vault owner.
5. **Medium/large TS analysis (finding 2, protocol fixed, extractor memory open).** See below.

## Red → green

| Defect | Test (failing before → after) | Red observed | Green |
| --- | --- | --- | --- |
| Refresh CROSS_DOMAIN | `CrossDomainRefreshPlanTest.refreshSnapshotIsLinkedWithinBudgetAfterStatisticsDescribeOnlyThePreviousSnapshot` (statement timeout 30 s, step budget 10 s, CONSUMES 126 = first analysis) | `QueryTimeoutException` at `CrossDomainStep.linkConsumes(CrossDomainStep.java:126)` | 1 test, 0 failures (2.1 s incl. seeding); `analysis.cross.*` 7/0 |
| Project delete | `ProjectDeleteCascadeIndexTest` (catalog: every FK into snapshots/files/graph_nodes/graph_edges has a leading index; delete of two seeded snapshots ≤ 10 s) | catalog listed 9 FKs; delete hit the 30 s statement timeout in `DELETE FROM graph_edges WHERE $1 = target_node_id` | 2 tests, 0 failures (delete test 3.2 s incl. seeding) |
| Per-row persistence | `GraphPersistenceRoundTripTest.persistingAGraphCostsRoundTripsPerBatchNotPerRow` (same rows, metadata merge of a duplicate draft, evidence replaced not accumulated, < 100 executions) | 8,410 executions | 1/0; `analysis.*` + `evidence.*`: 286 tests, 0 failures besides the uncommitted scratch harness |
| Eager Java parsing | `JavaParseSupportTest.parsesEachFileOnlyWhenTheCallerReachesIt` | expected `Later` but was `B` | 1/0; `analysis.java.*` + Fixture/SpringMini/Fullstack goldens 30/0 |
| TS request cap (analyzer) | `analyze-session.test.ts` (5): chunked session result `toEqual` single request on the 501-file boundary fixture; > 10 MiB project accepted; pages ≤ limit and concatenate to the result; seal fails on missing/duplicate/changed file and forgets the session; manifest/open-session/idle limits | 2 of 5 failed on the old service (`session` undefined) | vitest 288 passed (10 files); `tsc --noEmit` clean |
| TS request cap (backend) | `TsParsingStepTest.sendsAProjectOverTheSingleRequestBudgetAsOneSealedSession`, `sessionLimitIsTheLocalPreviewHardLimit` | replaces `refusesOverBudgetInputBeforeSendingOrPersistingPartialAnalysis`, which pinned the old refusal (`TsAnalyzerException` "10 MiB"); the new test was not run against the old code | `analysis.ts.*` 58 tests, 0 failures |
| Admission 20,000 | `ShippedAnalysisLimitsTest.shippedAdmissionReachesThePreviewHardLimit` | expected 50000 but was 20000 | 1/0; with `LocalIngestPolicyTest`, `LocalPreviewApiIntegrationTest`, `analysis.core.*`, `analysis.coverage.*`, `job.*`: 313 tests, 0 failures, 4 skipped |

All Gradle runs used `--offline cleanTest test --tests …`; spotless clean for the changed files.

## Measurements (non-acceptance observations)

Same harness and machine state, base `34b0e22` sources versus this branch, back to back
(load 11.1 → 15.2):

| Step / metric | Before | After |
| --- | --- | --- |
| `SOURCE_PARSING` | 30,162 ms | 10,706 ms |
| `GRAPH_BUILD` | 1,032 ms | 644 ms |
| `TS_PARSING` (fake analyzer) | 1,448 ms | 554 ms |
| Peak live heap after GC | 956 MB | 552 MB |
| Total GC pause | 5.5 s | 2.5 s |

The harness reaches PostgreSQL through Docker, so per-statement latency is higher than the
desktop's TLS loopback; the packaged gain will be smaller. `IMPORT` was not measured in the
harness (finding 4 above). Real TS analyzer, measured in-process on the workload fixture's TS/JS
subset (`extractTs`, Node 26): small 553 files/2.6 MB 2.5 s, 487 MiB RSS; medium 5,503 files/
26.3 MB 26.8 s, 2,866 MiB RSS, 49.5 MB result; large 27,499 files/105 MB **failed**: `RangeError:
Maximum call stack size exceeded` in TypeScript module resolution on the main thread; in a worker
with a 256 MiB stack it reached 5.8 GiB RSS after 40 s and failed with `RangeError: Map maximum
size exceeded` in ts-morph's `ForgetfulNodeCache` (one wrapper per visited compiler node).
End to end over HTTP with the new session (backend `TsProjectSession` → local Nest analyzer,
medium TS subset): 26.4 s, 59,379 nodes / 113,108 edges / 1,198 endpoints / 849 routes — the same
counts as the in-process single extraction; analyzer RSS peak 2.45 GiB.

## Size-class design (user decision: small, medium, large)

* **Admission:** `app.analysis.max-files` default 20,000 → 50,000 (`application.yml`,
  `AnalysisProperties`), equal to the existing local preview/copy hard limit 50,000 files /
  512 MiB (`LocalSourcePolicy.Limits`, R2).
* **TS batching without splitting the project (03 §6):** a project that fits the old single
  request (≤ 20,000 files, ≤ 10 MiB JSON) is sent unchanged. Larger projects use session commands
  carried inside the existing `analyze` body, so neither the HTTP nor the stdio transport changes:
  `open(fileCount, bytes, digest)` → `put(seq, files ≤ 1 MiB content)` → `seal(exact manifest)` →
  `analyze` → `page` → `close`. The manifest digest is SHA-256 over `path\nsha256(content)\n` in
  send order, computed on both sides; the backend re-reads and re-hashes on the send pass and fails
  if the sources changed. The analyzer builds **one** ts-morph project from the sealed manifest,
  so imports, DI and route prefixes resolve exactly as in one request; results are paged at
  ≤ 1 MiB and merged in order (`TsAnalyzeDtos.Response.concat`). Limits: 50,000 files /
  512 MiB per session, two open sessions, 60 s idle expiry; a failed step forgets the session.
* **Memory bound (R10): not done.** The extractor's memory grows with the project (medium
  2.9 GiB in the TS process alone). Proposed next step: run `extractTs` in a worker thread with
  `resourceLimits` (old-generation cap, larger stack) so an oversized project fails as
  `ANALYSIS_LIMIT` instead of exhausting the machine, and key the extractor's node maps by
  `compilerNode` so per-file passes can run inside `forgetNodesCreatedInBlock` (needed before
  the large class can complete).

## Changed product paths

`backend/src/main/java/dev/codeintelligence/analysis/cross/CrossDomainStep.java`,
`backend/src/main/resources/db/migration/V28__foreign_key_lookup_indexes.sql`,
`backend/src/main/java/dev/codeintelligence/analysis/graph/GraphPersistenceService.java`,
`backend/src/main/java/dev/codeintelligence/evidence/EvidenceService.java` (new
`replaceLinkedAll`), `backend/src/main/java/dev/codeintelligence/analysis/java/JavaParseSupport.java`,
`backend/src/main/java/dev/codeintelligence/analysis/ts/{TsAnalyzeDtos,TsParsingStep,TsRequestBudget,TsProjectSession}.java`,
`backend/src/main/java/dev/codeintelligence/common/AnalysisProperties.java`,
`backend/src/main/resources/application.yml`,
`analyzers/ts-analyzer/src/{analyze-session,analyze.service,types}.ts`. `TsAnalyzerClient`, the
stdio/HTTP transports, `JavaAnalyzer` and the desktop are unchanged.

## Not done / limits

* Packaged acceptance of every fix is pending the next candidate. The CROSS_DOMAIN and delete
  reproductions use a seeded graph with the run's shape, not the packaged app.
* `IMPORT` vault durability cost (finding 4 above) and `JavaAnalyzer` memory (it retains every
  `CompilationUnit` plus the symbol solver's parsed copies; peak live heap 552 MB on small) are
  open. `JavaAnalyzer` was left to w3-evidence.
* Small-class time/RSS SLOs are probably still exceeded: `IMPORT` alone was 25.8 s on LA8ZS9.
* Medium: [INFERENCE] fails the 180 s SLO on `IMPORT` (≈ 170 s of vault syncs) and the 4 GiB tree
  RSS (TS process ≈ 2.9 GiB plus a backend heap up to 2 GiB). Large: TS extraction fails (above);
  the runner also reserves 4 GiB disk for large while this machine had 2.1–2.2 GiB free.
* Finding 6 (overview after DONE) and R11 quotas were not investigated.
* `ImportSecretsCorpusIntegrationTest` still configures its own 20,000-file limit (cases
  C05-45/46); it tests the policy with that value, not the shipped default, and was left as is.

## Commands for the coordinator (next candidate, quiet machine)

Smoke before series, because medium/large are expected to fail on `IMPORT`/TS memory:

```
COORD/with-native-lock.sh gate-perf env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/run-workload-benchmark.cjs --app "$PWD/.native-product-<NEW>/Code Intelligence Validation.app" --class small --series-20
COORD/with-native-lock.sh gate-perf env -i … node validation/pre-release/run-workload-benchmark.cjs --app "$PWD/.native-product-<NEW>/Code Intelligence Validation.app" --class medium --smoke-1   # then --series-20
COORD/with-native-lock.sh gate-perf env -i … node validation/pre-release/run-workload-benchmark.cjs --app "$PWD/.native-product-<NEW>/Code Intelligence Validation.app" --class large --smoke-1 --rows preview   # R2 preview of 50k/200 MiB
COORD/with-native-lock.sh gate-perf env -i … node validation/pre-release/run-workload-benchmark.cjs --app "$PWD/.native-product-<NEW>/Code Intelligence Validation.app" --class large --smoke-1   # analysis; needs ≥ 4 GiB free disk
```
