# Legacy coverage honesty — E5 narrow correction

Date: 2026-10-02. Scope: inventory/report semantics and their existing UI, comparison, and export consumers. This does not complete T02 outcome persistence, T06 UX, or a public accuracy/support gate. The release decision remains No-Go under the execution roadmap.

## Contract

Every snapshot currently uses the legacy storage contract, including newly produced snapshots until per-file outcomes exist. Reports therefore return `measurementStatus: "LEGACY_UNMEASURED"`, `supportStatus: "UNVERIFIED"`, and `partialResults.status: "UNKNOWN"`.

| Field | Meaning |
|---|---|
| `fileCoverage.inventoriedFiles` | Number of stored `files` rows for this snapshot. |
| `languageCoverage[].inventoriedFiles` | Stored inventory grouped by language; missing language and literal `unknown` share one bucket. |
| `fileCoverage.discoveredFiles`, `languageCoverage[].total` | Deprecated inventory aliases; neither is a measured analysis denominator. |
| `fileCoverage.analyzedFiles`, language `analyzed`, `skipped`, `failed` | Deprecated keys retained with `null` values because outcomes were not recorded. |
| `fileCoverage.skippedForCount`, `skippedForSize` | A recorded inventory omission count only when one distinct, valid snapshot-linked observation exists. Missing, malformed, overflowing, or conflicting observations return `null`. These counts are never added to an analysis denominator. |
| `fileCoverage.skippedBinary` | `null`: this report has no persisted binary omission measurement. |
| `analyzerStatuses[].status` | Latest job's persisted `pending`, `running`, `done`, `failed`, or `skipped` status for the requested project/snapshot; absent jobs or steps return `unknown`. |
| `partialResults` booleans | Deprecated false placeholders. They do **not** indicate complete results. Use `status: "UNKNOWN"` and the explanatory reason. |
| `excludedFolders`, `unsupportedItems` | Empty because this report has no persisted historical policy or verified capability verdict. Empty is not proof of no exclusions or universal support. |

JSON keys and legacy Java constructor arities remain. This is a deliberate contract correction, **not full backward compatibility**: numeric-only clients must handle `null` outcome/omission counters and use the explicit statuses. Legacy Java constructors classify their input as unmeasured, discard unsupported outcome/partial claims, and preserve historical inventory aliases as inventory.

Analyzer configuration is accepted by the legacy service constructor but never stored or consulted for the report. A `DONE` step can include a disabled/no-op path or partial parser behavior, so it does not prove that any file was analyzed. Failures and their recorded error remain visible. Comparison warnings use recorded step failure, never current configuration or deprecated partial flags. Retry messages identify a recorded failure without promising a successful retry.

The broad language allowlist was removed. Java, TypeScript, Kotlin, Rust, and other detected language labels are inventory facts only. Neither parser existence nor this endpoint establishes public support for any of the 18 R1 capability cells.

## Consumer behavior

- Coverage UI renders inventory counts and unknown analysis-success/failure values. It never renders legacy counters as analyzed counts or percentages. A missing measurement status, an unknown status, or a failed request cannot imply completeness.
- Legacy `active`/`disabled` labels are displayed as unknown historical state; a recorded `failed` status remains visible even when the response lacks new measurement fields. Completed steps are labeled as step completion with unmeasured per-file results.
- Without explicit new inventory fields, old responses show unknown inventory counts instead of reusing `analyzedFiles` or a fabricated denominator.
- Snapshot comparison labels its counts `Inventory` and states that analysis coverage is unmeasured, including mixed old/new responses.
- Markdown export labels inventoried files, unmeasured analysis coverage, unknown completeness, and unverified public capability support. JSON export carries the corrected coverage contract.
- Export captures and validates one snapshot before reading results; coverage uses that same snapshot even if the current pointer changes during export. Area metadata comes from the existing `project_areas` and `area_technologies` tables, including areas without technology rows.

## Verification

Final integrated validation after E3:

| Gate | Result and scope |
|---|---|
| Backend full build | PASS: 572 tests across 85 suites, including `CoverageServiceTest` (43), `ExportServiceTest` (6), and `SnapshotComparisonServiceTest` (2). These named counts are subsets of the 572. |
| Frontend full checks | Lint, typecheck, and build PASS; 120 tests across 24 files PASS. Earlier focused cases below are included in this total. |
| Snapshot source integration | 12 real-backend/headless-browser `snapshotSource` cases PASS in one current run. This separate source-contract gate does not establish coverage accuracy or public capability support. |

The independent reviewer closed the captured-snapshot export issue. These scoped gate results are not combined into a product accuracy score or release approval.

Earlier focused verification executed successfully in the frontend workspace:

```text
npm test -- --run src/features/analysis/coverageHonesty.test.tsx src/features/analysis/analysis.test.tsx
18 tests passed across 2 files (10 focused honesty cases + 8 existing analysis regressions).

node_modules/.bin/eslint src/features/analysis/CoveragePanel.tsx src/features/analysis/SnapshotComparisonPanel.tsx src/features/analysis/coverageHonesty.test.tsx src/features/analysis/analysis.test.tsx src/api/types.ts
PASS

npm run typecheck
PASS
```

The focused frontend tests cover contradictory legacy outcome counters, missing status/inventory fields, old configuration labels, explicit failures, zero inventory, recorded omissions, unfamiliar step status, failed requests, and new/old/mixed comparisons. These are React/JSDOM regressions, not browser E2E or accuracy measurements. The React best-practices review retained unconditional hooks, direct coverage imports, pure derived values, accessible table headers, and explicit loading/error/unknown states.

The original E5 `CoverageServiceTest` added 14 database-backed invocations (9 tests and 5 persisted-step enum cases); E3 expands that suite to43. All passed in the final full backend build. It seeds disposable PostgreSQL inventories, jobs, and evidence and exercises the real service/repositories, serializer, export renderer, and snapshot comparison. Scenarios cover null outcomes/JSON keys, language grouping, four runtime configuration combinations, every stored step state, absent and latest-snapshot steps, omission evidence, Markdown semantics, and recorded failure warnings. A deterministic export regression switches the database pointer from A to B at the snapshot lookup boundary, clears the JPA cache, and verifies that commit, area/technology metadata, features, flows, findings, and inventory remain bound to A while a fresh current report sees B.

A repository search checked coverage consumers in backend, frontend, desktop, and analyzers. Production consumers no longer read deprecated analyzed or partial counters as measurements. No migration, analyzer adapter, imported-source execution, external credentials, or paid provider calls were introduced.

## E3 import observation

`localImport` is nullable and distinct from analysis outcomes. The reader accepts
only one distinct, valid CONFIG excerpt linked to `LOCAL_IMPORT` for the requested
project and snapshot. It bounds the query/excerpt, rejects duplicate/unknown keys,
trailing JSON, unexpected reasons, wrong number types and out-of-range or
contradictory counts. Missing, malformed, conflicting, oversized or unsupported
records return unavailable. No raw excluded paths or source bodies are added.

The UI gives Korean labels to the accepted count, actual bytes read and exclusion
reasons. A pruned subtree counts once; its descendants were not measured. These
counts never fill legacy analyzed/failed values. The [ingest contract](local-ingest-policy.md)
defines the limits. Cleanup removes import evidence links only when their snapshot
is already pruned by the existing retention policy; this does not add pin/GC
protection or complete T02.

Source status also distinguishes `INSPECTION_FAILED` from picker authorization
failure. Its four frontend cases and five backend source-status cases are included
in the final totals. Frontend results are React/JSDOM tests; the separate12-case
headless gate covers actual backend source/refresh behavior.

## Remaining work

T02 still needs durable per-file/per-capability outcomes with generation/source binding, disjoint outcome accounting, and versioned capability validation. This correction does not reconstruct missing historical measurements, verify parser accuracy, prove completeness, or implement the public support manifest. Those limitations are now surfaced instead of replaced with inventory-derived certainty.
