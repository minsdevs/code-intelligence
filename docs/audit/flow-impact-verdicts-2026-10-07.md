# Flow and impact verdicts (G-UX F5/F6, pilot P5/P6) — 2026-10-07

## Scope and result

Unit **w1-verdicts**, branch `gate/w1-verdicts` from `42d3260`. Fixes the two open
High false-certainty findings F5 and F6 of
[ux-accessibility-2026-10-07](ux-accessibility-2026-10-07.md) in source (backend API
and UI). Evidence is backend Testcontainers integration tests and React/JSDOM tests
only; no packaged candidate contains the fix, so F5/F6/P5/P6 stay **FAIL** in the
G-UX matrix until the UX pilot is rerun on a new candidate. Release verdict stays
**NO_GO**.

## Rules implemented

**Flow step verdict (F5).** `GET /api/projects/{p}/flows/{f}` steps gain
`entry`, `relationType`, `confidence` (additive); the detail gains
`inferredStepIncluded`.

- A step stored with an edge id takes that edge's type and verdict
  (`CONFIRMED` / `LIKELY` / `POSSIBLE`, the same vocabulary as the relation verdict
  labels `relation.confidence.*`).
- The flow detector stores no edge id for backend steps. Such a step takes the
  strongest relation the detector walks from an earlier step to it:
  `CONSUMES`, `CONTAINS`, `DECLARES`, `CALLS`, `READS_WRITES`, `DEPLOYED_IN`
  forward, `EXPOSES` backward (controller reached from its endpoint). Other
  relation types (for example `IMPORTS`) never lend a verdict.
- The first entry-node step without an edge id is the anchor (`entry: true`, no
  verdict). Any other step without a found relation has `confidence: null` and
  counts as not confirmed.
- `inferredStepIncluded` is true when any non-anchor step is not `CONFIRMED`
  (doc 03 §3: a path inherits its weakest edge). The UI shows the badge when the
  API says so or when its own step check finds a non-confirmed step, so an old
  response without verdict fields reads as inferred.

**Impact (F6).** `GET /api/projects/{p}/impact` keeps every existing field.

- One row per dependent node: `depth` and `edgeType` from a shortest path;
  `confidence` is the strongest verdict over all simple paths within depth, where
  each path carries its weakest edge; `pathCount` counts those paths; `group` is
  `CONFIRMED_DEPENDENCY` (confidence `CONFIRMED`) or `CANDIDATE_IMPACT`.
- Score rule `scoreVersion: "unique-node-weight-v2"`: the node-type weight
  (endpoint/route 4, component/class 2, other 1) is added once per unique
  dependent, confirmed or candidate. Extra paths cannot raise it; thresholds
  (HIGH ≥ 20, MEDIUM ≥ 8) are unchanged. It is a size indicator, not a probability.
- `outsideAnalysis`: for a snapshot with per-file outcomes, the recorded counts
  (unsupported, failed, partial, pending, unmeasured, excluded files, excluded
  submodules; same source as the coverage report) and up to 20 areas grouped by
  status and language with a sample path. Older snapshots report
  `measurementStatus: LEGACY_UNMEASURED` with null counts; the UI says the
  outside area is unknown.
- The UI shows three labelled areas: confirmed reverse dependencies, candidate
  impact (inferred or possible) and outside analysis, with the verdict in text on
  every row and the score rule under the score. A row without a verdict (old
  response) is never placed in the confirmed group.

API changes are additive; `WhatIfService` still reads `riskLevel`, `riskScore` and
`dependents` (now unique rows). The doc 03 target `/impact?node=…&maxDepth=8&confidence=…`
on generations is not implemented here.

## Red → green

| Defect | Test (failing on `42d3260`) | Red (recorded) | Green |
|---|---|---|---|
| F6 dedupe/verdict | `ImpactVerdictIntegrationTest.returnsOneRowPerDependentWithShortestDepthAndStrongestPathVerdict` | `Expected size: 3 but was: 5` | pass |
| F6 score | `ImpactVerdictIntegrationTest.riskScoreCountsEachDependentOnceRegardlessOfPathCount` | `expected: 4 but was: 7` | pass |
| F6 outside | `ImpactVerdictIntegrationTest.reportsRecordedOutsideAnalysisAreas`, `legacySnapshotReportsOutsideAnalysisAsUnmeasured` | `outside` is null (NPE) | pass |
| F6 JSON compat | `ImpactVerdictIntegrationTest.keepsExistingJsonFields` | passed (guard) | pass |
| F5 steps | `FlowStepVerdictIntegrationTest.feBeFlowStepsCarryTheVerdictOfTheirProducingRelation`, `confirmedOnlyFlowHasNoInferredStep` | `entry` missing (NPE) | pass |
| F5 UI | `flowImpactVerdicts.test.tsx` F5 block (ko/en per-step verdict + badge, no badge when confirmed, old response) | 4 failed | pass |
| F6 UI | `flowImpactVerdicts.test.tsx` F6 block (ko/en three groups, legacy outside, old response) | 4 failed | pass |

`falseCertainty.test.tsx` flow case now expects the new note and the badge instead
of the old "per-step confirmation is not shown" note (the product text changed on
purpose).

## What ran (cwd = worktree root)

| Check | Result |
|---|---|
| `backend: ./gradlew --offline cleanTest test --tests ImpactVerdictIntegrationTest --tests FlowStepVerdictIntegrationTest --tests Phase5ApiIntegrationTest --tests CoverageServiceTest spotlessCheck` | BUILD SUCCESSFUL; 5 + 2 + 5 + 45 tests, 0 failures |
| `node frontend/node_modules/vitest/vitest.mjs run --config validation/pre-release/frontend-regression.config.mjs src/features/ux src/features/flows src/features/analysis src/features/projects src/features/code src/lib` | 12 files, 130 tests passed |
| `cd frontend && node node_modules/typescript/bin/tsc -b` | exit 0 |
| eslint on the touched frontend files | exit 0 |
| `node --test validation/pre-release/test/ux-accessibility.test.cjs` | 7/7 pass |

## Changed paths

- `backend/src/main/java/dev/codeintelligence/analysis/flow/FlowService.java`
- `backend/src/main/java/dev/codeintelligence/analysis/impact/ImpactService.java`
- `backend/src/main/java/dev/codeintelligence/analysis/coverage/CoverageService.java` (public read of the recorded outcome summary)
- `frontend/src/api/types.ts`, `frontend/src/lib/translations.ts` (ko/en)
- `frontend/src/features/flows/FlowsPage.tsx`
- `frontend/src/features/analysis/AnalysisPage.tsx`, `frontend/src/features/analysis/ImpactGroups.tsx` (new)
- `validation/pre-release/ux-accessibility-pilot.cjs`: the single `Impact dependents`
  list is gone, so U4 now reads the confirmed and candidate lists and the
  outside-analysis region; U3 records per-step verdicts, the badge (`추정 단계 포함` /
  `Inferred step included`) and whether it matches `inferredStepIncluded`.
- Tests: `ImpactVerdictIntegrationTest`, `FlowStepVerdictIntegrationTest`,
  `frontend/src/features/ux/flowImpactVerdicts.test.tsx`, `falseCertainty.test.tsx`.

## Limits and what remains

- No packaged evidence: rerun `ux-accessibility-pilot.cjs` on a candidate built
  from this branch; F5/F6/P5/P6 stay FAIL until then.
- Backend step verdicts are derived at read time because the flow detector
  (pipeline, out of scope) stores no edge id for backend steps. When two earlier
  steps both reach a step, the stronger relation is shown; the overall badge still
  follows the weakest step.
- P5's other gap (the relation walk does not reach the entity/table) is untouched.
- Impact still enumerates simple paths in SQL as before (now aggregated in the
  database); path explosion on dense graphs is unchanged. `pathCount` counts paths
  within the requested depth only.
- Duplicate-impact semantics across namespaces belong to G-ACCURACY (doc 07).
