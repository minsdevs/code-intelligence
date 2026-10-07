# G-EVIDENCE Medium fixes and G-ACCURACY D1/D2 — 2026-10-07

Unit `w3-evidence`, branch `gate/w3-evidence` from `33f8d95`. Sources:
[evidence-integrity-matrix-2026-10-07.md](evidence-integrity-matrix-2026-10-07.md) (F-1, F-2, F-3) and
[accuracy-baseline-2026-10-07.md](accuracy-baseline-2026-10-07.md) (D1, D2). Product changes only; no gate is
declared PASS, no candidate was rebuilt, no gold/oracle data, threshold or earlier record was changed.

## Scope and decisions

- **F-3** CONFIG/MIGRATION whole-file spans ended one line late (`lineCount` = 1 + number of `\n`).
- **F-1** `FinalizeStep` pruned note-pinned legacy (v0) snapshots.
- **F-2** coverage had no capability dimension.
- **D1 (user decision 2026-10-07):** calls on an interface or abstract receiver are INFERRED class-hierarchy
  implementation candidates; a concrete or final class receiver stays STATIC_RESOLVED.
- **D2** Java CALLS edges had no call-site evidence; it was narrow and is fixed here.

## Red/green

| Defect | Failing test (red, read from output) | Fix | Green |
|---|---|---|---|
| F-3 | `ConfigSpanLineEndTest` (4 tests): `lineEnd of config:package.json for {"name":"a"}\n expected: 1 but was: 2`; same for `build.gradle` (3 vs 4), `application.yml` (2 vs 3), `migration:…V1__init.sql` (1 vs 2) | One shared `ConfigFileSupport.lineCount`: LF, CRLF and lone CR end a line, a final terminator opens none, empty file = line 1; the three private copies removed | 4/4; `analysis.config.*` 35 tests, 0 failures |
| F-3 (pipeline) | `EvidenceHistoryIntegrationTest` extended with `web/package.json` (LF), `application.yml` (CRLF, no final newline), a Flyway SQL file (CRLF); `PublishedFactAudit` now checks path-keyed CONFIG/MIGRATION facts like FILE facts (whole file, end = last line). Against the pre-fix analyzers: `node span outside retained bytes config:web/package.json 1-2 of 1`, `… migration:…/V1__users.sql 1-4 of 3` (the packaged `native-bJn2bY` failure, reproduced) | (as above) | 15 tests: 14 pass, 1 skip (C06-15 R2); 13 audit rounds, 4,958 fact checks, 0 failures; final round 797 facts over 7 snapshots incl. 14 CONFIG and 7 MIGRATION nodes |
| F-1 | `LegacySnapshotRetentionIntegrationTest` (real PostgreSQL, real `FinalizeStep`): `[snapshot pinned through a FILE reference] Expecting value to be true but was false` | Prune excludes snapshots whose `files` or `graph_nodes` row is referenced by a `note_references` FILE/NODE row of a note in the same project; unpinned and unresolved-reference snapshots are still pruned | 1/1; C06-13 now asserts the kept snapshot/file (`pinnedLegacySnapshotKept: true`, `status: PASS` in `c06-evidence-history.json`) |
| F-2 | `CoverageServiceTest.coverageIsReportedPerCapabilityWithoutInventingUnrecordedCapabilities`: compile failure, no `capabilityOutcomes()` / `CapabilityOutcome` | Additive `CoverageReport.capabilityOutcomes` (P, S, C, F, X). P comes from the recorded per-file primary-parser outcome: eligible = success + partial + failed + unsupported + pending, plus `unmeasuredFiles`, so eligible + unmeasured = file rows. S/C/F/X are `NOT_RECORDED` with null counts; legacy snapshots are `LEGACY_UNMEASURED` for all five | `CoverageServiceTest` 46/46, `ExportServiceTest` 6/6, `SnapshotComparisonServiceTest` 2/2 |
| D1 | `JavaAnalyzerTest.interfaceAndAbstractReceiverCallsAreInferredImplementationCandidates`: `Expecting actual ["java:demo.Action#run()"] to contain exactly in any order [FirstAction#run(), SecondAction#run()]`. A record implementor was then added: red again (missing `ThirdAction#run()`) | Virtual calls (not static, private, final or `super.`) whose receiver static type is a project interface or abstract class publish `CALLS/POSSIBLE` to each concrete override in the receiver and its project subtypes (classes, records, enums), metadata `resolution: inferred`, `declaredTarget`, `targetCandidates`. With 0 or more than 5 candidates only the declared method is published, as POSSIBLE, with `candidateCount` | 5/5 JavaAnalyzerTest; `analysis.java.*`, graph/feature/cross/area goldens, flow and impact verdict tests all pass (counts below) |
| D2 | `JavaAnalyzerTest.javaCallEdgesCarryTheirCallSite`: `Expecting map {} to contain entries ["filePath"="Calls.java"]` | Every Java CALLS edge (static, inferred, unresolved, name fallback) carries `filePath`, `lineStart`, `lineEnd` of the call and `expression`, the callee text as written (scope through name, from the token range), as `TsGraphMapper` edges do | 5/5 |

Directly affected targeted runs after the last change (all `--offline cleanTest`):
`analysis.java.*` 18, `analysis.graph.*` 13, `FixtureGoldenTest` 9, `analysis.feature.*` 7,
`analysis.cross.*` 6, `ConfigAnalyzersGoldenTest` 5, `FlowStepVerdictIntegrationTest` 2,
`ImpactVerdictIntegrationTest` 5, `EvidenceHistoryIntegrationTest` 15 (1 skip) — 0 failures.

## T00 development baseline rerun (D1/D2)

Command as documented in the accuracy baseline (backend path, `env -i … node
validation/pre-release/accuracy-export.cjs --corpus validation/t00/baseline/corpus.json --capabilities
validation/t00/capability-manifest.json --socket unix://$HOME/.docker/run/docker.sock --label baseline`, then
`accuracy-baseline.cjs`). Run `validation/local/accuracy-export/baseline-0lz4nX` at `25346be`
(`dirtyProductPaths: 0`): accuracyTest 1/1, T00 result `FAIL` (exit 1), report SHA-256
`07b6a839…c293`, findings SHA-256 `94f1e4a6…4767`. No gold, spec or oracle file was touched.

| Measure | `baseline-2nwqUR` (before) | `baseline-0lz4nX` (after) |
|---|---|---|
| Failing cases / unmatched facts / false-resolved | 25 / 11 / 0 | 15 / 1 / 0 |
| J-C TP / FP / FN / unmatched | 0 / 0 / 6 / 10 | 6 / 0 / 0 / 0 |
| J-C candidate cases exact | 0 of 4 | 4 of 4 (`dev-java-calls.candidates` = {FirstAction#run, SecondAction#run}) |
| J-C failure codes | ABSTENTION_MISSING, ANNOTATION_REVIEW_REQUIRED, CANDIDATE_EXACT_SET/RECALL_BELOW, RECALL_BELOW | ABSTENTION_MISSING only (D3, 3 cases) |
| Java call projections | `call-declaration-no-callsite-evidence` | `call-expression` 3 (java-calls) + 8 (fullstack) |
| Other cells | J-S, T-P, T-C, SQL-P, SQL-S FAIL; J-P, J-F, J-D, T-S, X-DATA BLOCKED | unchanged |

D1 is no longer masked: the interface call is published INFERRED at its call site and matches the provisional
gold exactly. The development material stays tiny and agent-transcribed; these are findings, not accuracy
evidence.

## Changed product paths

- `backend/src/main/java/dev/codeintelligence/analysis/config/{ConfigFileSupport,BuildFileAnalyzer,YamlConfigAnalyzer,SqlMigrationAnalyzer}.java`
- `backend/src/main/java/dev/codeintelligence/job/FinalizeStep.java` (prune SQL `where` clause and Javadoc only; w1-cancel notified)
- `backend/src/main/java/dev/codeintelligence/analysis/coverage/{CoverageReport,CoverageService}.java`
- `backend/src/main/java/dev/codeintelligence/analysis/java/JavaAnalyzer.java`

Tests: `ConfigSpanLineEndTest`, `LegacySnapshotRetentionIntegrationTest` (new), `CoverageServiceTest`,
`JavaAnalyzerTest`, `EvidenceHistoryIntegrationTest`, `PublishedFactAudit`. No migration was needed.

## Limits and what remains

- Not on a candidate: packaged acceptance (`import-evidence-native.cjs`, packaged T00 export) waits for the next
  coordinator build. E-02/E-10/E-15 stay open until then.
- F-2 is partial by design: only P is recorded per file. S/C/F/X outcomes need per-adapter recording
  (03 FileOutcome `unique(generation,file,capability,owner)`), a new table and analyzer contract changes;
  they are reported `NOT_RECORDED`, never as zero. No owner/adapter id is reported. The frontend does not
  display the new field yet.
- D1: candidates come from project source only (library implementors are invisible); generic overrides
  fall back to name + arity matching. One DB edge per (source, target, type) remains: a caller that reaches
  the same target both statically and through an interface keeps the last call site and confidence
  (existing upsert behaviour, shared with TS).
- F-1 covers note FILE/NODE pins. Task `source_finding_id` keeps `ON DELETE SET NULL` semantics and is not a pin.
- Not fixed: D3 (Java abstentions), D4–D9; `DB_TABLE` still publishes an open line range (D6), so the C06
  migration uses a statement without a table; the audit now reports an open range as
  `incomplete node span` instead of throwing. `FileInventoryScanner.countLines` (FILE nodes) does not treat a
  lone CR as a line end [code reading, not run].

## Proposed shared-doc text (not applied)

For `validation/pre-release/README.md` / G-EVIDENCE notes: "CONFIG and MIGRATION file facts end on the line
holding the last byte (LF, CRLF, lone CR). Legacy snapshot retention never prunes a snapshot whose file or
node a note pins. Coverage reports per capability (P recorded from per-file parser outcomes; S/C/F/X
NOT_RECORDED). Java calls on interface/abstract receivers are INFERRED class-hierarchy candidates
(≤5) with call-site evidence; concrete/final receivers stay STATIC_RESOLVED."
