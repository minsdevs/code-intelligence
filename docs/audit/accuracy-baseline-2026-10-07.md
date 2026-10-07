# G-ACCURACY measurement harness and development baseline (2026-10-07)

Unit `gate-accuracy`, branch `worktree-agent-aa6d56354c50ce366` (base `bcd8081`). Ledger: [`accuracy-baseline-2026-10-07.json`](accuracy-baseline-2026-10-07.json).

**G-ACCURACY is not PASS and cannot become PASS from this unit.** No R1 cell has a single independent evaluation annotation, and the independent annotation and blind real-repository review need people. This unit makes the measurement real and repeatable: the actual product's output is captured, bound to a build digest and scored by the unmodified T00 metrics. It then measures the current product against the implementation-side material that exists. That baseline is development-split only. It is a list of product findings, not accuracy evidence.

## Scope

Gate table (07): "06 cell thresholds + negative 0 + blind real-repo review; forbidden substitute: parser success / total test count". The cells, quotas and independence rules come from 10. The metrics, thresholds and Wilson bound come from 06 §4. The T00 contract is in `validation/t00/README.md`.

In scope:

1. Product-observation exporters. The backend path runs the real job pipeline with Testcontainers PostgreSQL and the real local TS sidecar. The packaged path drives the retained candidate `.native-product-1lvULq` through its UI import and API. Both emit T00 observations and an execution attestation, and `runner.cjs --mode gate` verifies them.
2. An inventory of the existing oracle material per cell.
3. A per-cell baseline with every FN, FP, unmatched fact and missing abstention, each with its location.
4. Annotation tooling and an annotator guide.
5. A gap table and this audit.

Out of scope, and not simulated: independent annotation, blind review, real-repository selection, signing.

## What was built

| Component | Path | Notes |
|---|---|---|
| Backend exporter test (opt-in) | `backend/src/test/java/dev/codeintelligence/analysis/accuracy/T00ObservationExportTest.java` | Runs `Pipeline.stepsFor(IMPORT)` after `IMPORT`; that step is replaced by a byte-verified roster copy into a JGit repo. Uses Testcontainers PostgreSQL and the real sidecar URL with no fake fallback. Dumps the persisted rows: files, nodes, edges, endpoints, entities, routes. Digests the loaded `build/classes/java/main` and `build/resources/main` trees. Reads manifests and roster sources only, never gold. |
| Backend driver | `validation/pre-release/accuracy-export.cjs` (+ `accuracy-export.init.gradle`) | Builds and starts `analyzers/ts-analyzer/accuracy-server.cjs`, then runs Gradle `accuracyTest --tests …T00ObservationExportTest` offline. Converts the result, writes `bundle/{observations,attestation,evidence-audit}.json` and runs the T00 gate with `--product-artifact-root`. |
| Packaged driver | `validation/pre-release/accuracy-packaged-export.cjs` | Uses the same boundary as `run-product-candidate.cjs`: isolated-run claim, `--use-mock-keychain`, codesign verify and manifest validation. The import is the real UI flow (native drag, preview, approve). Readback uses only the product API: files, file-content `contentOid`, graph nodes and details, `relations` out depth 1, endpoints and entities. It compares the result with a backend dump of the same fixture and binds the manifest and `app.asar` digests. `git diff 9211e88..HEAD` over product paths must be empty. The run deletes its isolated profile afterwards. |
| Shared adapter | `validation/pre-release/accuracy-observations.cjs` | Maps dumps to T00 facts and outcomes. Every row is emitted or counted with a reason, and a mapped fact is never re-targeted. Reports hash and span evidence counts. |
| Case-level findings | `validation/pre-release/accuracy-baseline.cjs` | Re-loads the corpus and bundle through the runner's contract loader and repeats the attestation binding. It lists each failing case and each unmatched fact with path and line. Runner reports carry only hashed case references. |
| Runner extension | `validation/t00/runner.cjs`, `lib/attestation.cjs`, `lib/contracts.cjs`, `lib/metrics.cjs`, `schemas/contracts.schema.json` | Adds `--execution-attestation` and `--product-artifact-root`, plus `captureAttestation: EXTERNAL_ATTESTATION`. The build digest must equal `sha256(stableJson(build))`; components are re-hashed; consumed roster and observation bytes are bound. Adds `purpose: DEVELOPMENT_BASELINE`, which scores DEVELOPMENT only and adds the blocker `DEVELOPMENT_MATERIAL_ONLY`. Result: `productExecutionVerification: HARNESS_ATTESTED_UNSIGNED` with blocker `EXECUTION_ATTESTATION_LOCAL_UNSIGNED`. The gate and every cell stay non-PASS. |
| Annotation tooling | `validation/t00/annotate.cjs`, `lib/annotation.cjs`, `ANNOTATING.md` | `build` (inline markers or text anchors → byte spans), `compare` (two annotators), `validate` (spans re-checked against bytes, duplicate ids, cross-split leakage across corpus files, refusal of gold mirroring an observation bundle), `show`. Product-shaped specs and sources are refused. |
| Development baseline corpus | `validation/t00/baseline/{specs,fixtures,corpus.json,corpus-packaged.json}` | Agent transcription with `AUTHOR_PROVISIONAL` status and `DEVELOPMENT` split. Sources: `validation/t00/fixtures/{java-calls,typescript-calls}` and `FixtureAccuracyOracle` (fullstack-mini). No product output was read while writing the specs. |

## What ran (results read from output)

| Check | Command (cwd = worktree) | Result |
|---|---|---|
| T00 + adapter unit tests | `node --test validation/t00/test/*.test.cjs validation/pre-release/test/accuracy-observations.test.cjs` | 125 tests, 125 pass, 0 fail (104 existing + 11 attestation + 6 annotation + 4 adapter) |
| Backend formatting | `cd backend && ./gradlew --offline --no-daemon --console=plain spotlessJavaCheck` | First run FAILED: 3 format violations in the new test. Fixed in `238d58d`, rerun BUILD SUCCESSFUL |
| Baseline contract | `node validation/t00/runner.cjs --mode contract --offline --corpus validation/t00/baseline/corpus.json --capabilities validation/t00/capability-manifest.json --output <new dir>` | `PASS`, exit 0 |
| Annotation validator | `node validation/t00/annotate.cjs validate --capabilities validation/t00/capability-manifest.json --corpus validation/t00/baseline/corpus.json --corpus validation/t00/corpus.json --allow-unrecorded` | `PASS`. 5 fixtures; the 3 baseline fixtures have checked span records, and the 2 original T00 fixtures have no record (`--allow-unrecorded`) |
| Backend export (final) | `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/accuracy-export.cjs --corpus validation/t00/baseline/corpus.json --capabilities validation/t00/capability-manifest.json --socket "unix://$HOME/.docker/run/docker.sock" --label baseline` | `baseline-2nwqUR`: accuracyTest 1/1 pass, 69 facts. T00 gate contract `PASS`, `artifactVerification: VERIFIED`, `HARNESS_ATTESTED_UNSIGNED`. Observation evaluation `FAIL`, exit 1 |
| Packaged export (final) | `env -i … SCRATCH/with-native-lock.sh gate-accuracy node validation/pre-release/accuracy-packaged-export.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app" --corpus validation/t00/baseline/corpus-packaged.json --capabilities validation/t00/capability-manifest.json --backend-dumps validation/local/accuracy-export/baseline-2nwqUR/dumps --candidate-revision 9211e88d85de0c7f7fa08bd1082bc2e9e5dab941` | `packaged-Dvy5Vw`: packaged launch, AI off, UI import, job DONE, clean shutdown. 65 facts. T00 contract `PASS`, `VERIFIED`, `HARNESS_ATTESTED_UNSIGNED`. Observation evaluation `FAIL`. **The two paths have identical facts (65 = 65) and identical coverage outcomes** |
| Findings | `node validation/pre-release/accuracy-baseline.cjs --corpus … --capabilities … --observations <run>/bundle/observations.json --execution-attestation <run>/bundle/attestation.json --output <run>/findings.json` | backend 81 cases: 25 failing, 11 unmatched facts, 0 false-resolved. Packaged 71 cases: 17 failing, 9 unmatched, 0 false-resolved. The same 17 cases fail on both paths |

Earlier records are kept unchanged next to the final runs in `validation/local/accuracy-export/`. Each failed for a harness defect that was fixed before the next run, except `baseline-MX0PX0`:

* `baseline-Bv7Eby`: `DUPLICATE_ID` (observation ids repeated per fixture).
* `baseline-A0jj4r`: `OUTPUT_OVERLAPS_INPUT` (the artifact root was protected wholesale).
* `baseline-SvlfCP`: `ARTIFACT_DIGEST_MISMATCH` (wrong FILE component framing).
* `baseline-MX0PX0`: Gradle "connection preamble within 10s" under machine load. This is environmental; the rerun passed.
* `baseline-SIwZlL`: the old adapter projected `PROJECT_SYNTAX_REJECTED` as a per-file syntax verdict.
* `baseline-2xCyT7`: the harness source before Spotless formatting.
* `packaged-qco3eD`: file-content was requested for a file the product did not ingest.
* `packaged-Oi9po1`: the driver dropped the app handle before close. The product's own shutdown was `COMPLETE`.
* `packaged-p6iqkf` and `packaged-TPsjuG`: attestation `validationIdentity` was an object (`SCHEMA_VIOLATION`). `TPsjuG` ran before the fix was saved.
* `packaged-bz1xyM`: like `Dvy5Vw`, but compared against `2xCyT7`.
* `probe-fYx4ek` and `probe-wYCBod`: the previous session's incomplete probes.

## Inventory of existing oracle material (deliverable 2)

None of it is evaluation gold. All of it was written on the implementation side: commits in this repository, T00 review records `AGENT / AUTHOR_PROVISIONAL`, and specs by `gate-accuracy-transcriber` (AGENT). All sources are synthetic. No project is a public repository with a pinned commit.

| Source | Cells touched | Unique positive / negative-ambiguous | Projects / scenarios | Note |
|---|---|---|---|---|
| `validation/t00/fixtures/{java-calls,typescript-calls}` (= `baseline/fixtures/dev-t00-*`) | J-P 1/1, J-C 2/1, T-P 1/1, T-C 2/1 | 6 / 4 | 1 synthetic / 1 | One generator family. The baseline transcription repeats it and is not counted twice |
| `FixtureAccuracyOracle` (fullstack-mini) → `baseline/fixtures/dev-todo-fullstack-mini` | J-P 8/0, J-S 30/0, J-C 5/5, J-F 5/0, J-D 1/0, SQL-P 1/0, SQL-S 4/0, T-P 6/0, T-S 4/0, X-DATA 1/1 | 65 / 6 | 1 synthetic (todo-mini) / 1 | Exact-set graph facts, not span annotations. Spans were added by transcription. React 18 / Router 6 facts (2 routes, 2 route bindings, 1 api-call, 2 `CONSUMES POSSIBLE`) are outside the R1 versions (React 19 / Router 7) and count for no R1 cell |
| `spring-mini`, `react-mini` (same oracle generator) | — | 0 additional | — | Byte-identical to `fullstack-mini/backend` and `/frontend` (`diff -rq`). Counting them would repeat one generator |
| Golden tests (`FixtureGoldenTest` 6, `ConfigAnalyzersGoldenTest` 5, `SpringMiniGraphGoldenTest` 3, `SpringMiniEndpointsFeaturesGoldenTest` 3, `ReactMiniTsParsingGoldenTest` 2, `FullstackCrossDomainGoldenTest` 1, `FixtureAccuracyTest` 3) | J-*/T-*/X-DATA, config | 0 additional | same mini sources | Assertions over the same fixtures and generator. `infra-mini` maps to no R1 cell |
| `ReactRouteBindingIntegrationTest` (5 tests) | T-UI-like route binding | not countable | inline snippets | No pinned React/Router version and no span annotations |
| Analyzer unit tests: `ts-analyzer` (114 `it`/`test` across 8 files), `tree-analyzer` (8), backend `analysis/java` (16), `analysis/ts` (46) | P/S/C/F/UI | not countable | inline snippets | Implementation unit expectations without byte-span gold or independent review |

**Independent evaluation annotations available, per cell: 0 of 300 for all 18 cells. Independent public projects: 0. Evaluation scenarios: 0.**

## Development baseline (deliverable 3): backend path, `baseline-2nwqUR`

Metric definitions follow 06 exactly, as implemented by `validation/t00/lib/metrics.cjs`; no threshold was changed. Notation: P = precision, R = recall on the supported patterns. Overall gold recall is `NOT_MEASURED`, because no unsupported-positive oracle exists. W = Wilson 95% lower bound with sample size n.

| Cell | Result | TP | FP | FN | dup FP | unmatched | false-resolved | P | R | W (n) | valid-file | invalid diag | cand P | cand R@5 | exact-set | Failure codes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| J-P | BLOCKED | 9 | 0 | 0 | 0 | 0 | 0 | 1.000 | 1.000 | 0.701 (9) | 1.000 | 1.000 | – | – | – | |
| J-S | FAIL | 29 | 1 | 1 | 0 | 0 | 0 | 0.967 | 0.967 | 0.833 (30) | – | – | – | – | – | PRECISION_BELOW_THRESHOLD |
| J-C | FAIL | 0 | 0 | 6 | 0 | 10 | 0 | – | 0.000 | – (0) | – | – | – | 0.000 | 0.000 | ABSTENTION_MISSING, ANNOTATION_REVIEW_REQUIRED, CANDIDATE_EXACT_SET/RECALL_BELOW, RECALL_BELOW |
| J-F | BLOCKED | 5 | 0 | 0 | 0 | 0 | 0 | 1.000 | 1.000 | 0.566 (5) | – | – | – | – | – | |
| J-D | BLOCKED | 1 | 0 | 0 | 0 | 0 | 0 | 1.000 | 1.000 | 0.207 (1) | – | – | – | – | – | |
| T-P | FAIL | 6 | 0 | 1 | 0 | 0 | 0 | 1.000 | 0.857 | 0.610 (6) | 0.857 | 0.000 | – | – | – | INVALID_DIAGNOSTIC_MISSING, OBSERVED_EXECUTION_FAILED, PARSE_SUCCESS_BELOW |
| T-S | BLOCKED | 4 | 0 | 0 | 0 | 0 | 0 | 1.000 | 1.000 | 0.510 (4) | – | – | – | – | – | |
| T-C | FAIL | 0 | 0 | 1 | 0 | 0 | 0 | – | 0.000 | – (0) | – | – | – | 0.000 | 0.000 | ABSTENTION_MISSING, CANDIDATE_*_BELOW, OBSERVED_EXECUTION_FAILED, RECALL_BELOW |
| SQL-P | FAIL | 0 | 0 | 1 | 0 | 0 | 0 | – | 0.000 | – (0) | 0.000 | – | – | – | – | PARSE_SUCCESS_BELOW_THRESHOLD |
| SQL-S | FAIL | 0 | 0 | 4 | 0 | 1 | 0 | – | 0.000 | – (0) | – | – | – | – | – | ANNOTATION_REVIEW_REQUIRED, RECALL_BELOW_THRESHOLD |
| X-DATA | BLOCKED | 1 | 0 | 0 | 0 | 0 | 0 | 1.000 | 1.000 | 0.207 (1) | – | – | 1.000 | 1.000 | 1.000 | |
| T-F, T-UI, JS-P, JS-S, JS-C, JS-UI, X-HTTP | NOT_RUN | – | – | – | – | – | – | – | – | – | – | – | – | – | – | no material |

`BLOCKED` means no threshold failure on this tiny development sample. Every measured cell also carries `DEVELOPMENT_MATERIAL_ONLY`, `EXECUTION_ATTESTATION_LOCAL_UNSIGNED`, `INSUFFICIENT_EVALUATION_CORPUS` and `INDEPENDENT_ORACLE_REVIEW_MISSING`. C, F and X cells also carry `WILSON_SAMPLE_MISSING`. With n ≤ 30, none of these numbers is an accuracy estimate.

Evidence and coverage over all published facts (06 "소스 근거" and "coverage"):

| Measure | Backend (3 fixtures) | Packaged (fullstack) |
|---|---|---|
| File content hash = git blob of roster bytes | 29/29 | 24/24 (`contentOid`); served bytes equal roster bytes for 24/24 |
| Mapped facts with a valid source span | 69 of 72 | 65 of 68 |
| Facts without a span | 3: `TodoRepository#findAll()/findById(Long)/save(Todo)` METHOD nodes with null lines | same 3 |
| Incomplete line range | 1 (`table:todos`, `lineEnd` null) | 1 |
| Namespace published by the product | 0. The roster assigns namespaces, so they cannot be verified | same |
| Coverage partition (runner `coverage-partition.json`) | PASS | PASS |

Path agreement on `dev-todo-fullstack-mini`: observations are equal, and so are coverage outcomes. The API-visible dumps differ in one file, `backend/src/main/resources/application.yml`. The packaged local-ingest policy refused it as `SECRET_CONTENT` (1 file node, 1 config node, 2 edges), while the backend harness replaces `IMPORT` with a verified copy and therefore bypasses that policy. Converting the backend dump with and without edge metadata gives identical facts, so the API's lack of edge metadata does not change this fixture.

## Case-level findings (every failing case; backend path)

Locations are relative to each fixture's `source/`. "Product fact at" is the unmatched product fact overlapping the case.

| Case | Cell | Pol. | Location | Expected | Outcome | Product fact at |
|---|---|---|---|---|---|---|
| dev-java-calls.direct | J-C | POS | `Calls.java`:7 | STATIC `demo.Calls#twice(int)` | FN | L7 declaration span, STATIC, same target |
| dev-java-calls.candidates | J-C | POS | `Calls.java`:8 | INFERRED {FirstAction#run, SecondAction#run} | CANDIDATE_MISSING | L8 declaration span, **STATIC `demo.Action#run()`** (see D1) |
| dev-java-calls.dynamic | J-C | NEG | `Calls.java`:9 | UNRESOLVED EXTERNAL_TARGET (`Class.forName`) | ABSTENTION_MISSING | none |
| dev-typescript-calls.valid | T-P | POS | `calls.ts`:1 | valid | FN (project rejected) | none |
| dev-typescript-calls.invalid | T-P | NEG | `invalid.ts`:1 | invalid + SYNTAX_ERROR | INVALID_DIAGNOSTIC_MISSING | none (project-level rejection names no file) |
| dev-typescript-calls.direct | T-C | POS | `calls.ts`:6 | STATIC `ts:source/calls.ts#twice` | FN | none (job failed) |
| dev-typescript-calls.candidates | T-C | POS | `calls.ts`:7 | INFERRED {first.run, second.run} | CANDIDATE_MISSING | none |
| dev-typescript-calls.dynamic | T-C | NEG | `calls.ts`:9 | UNRESOLVED DYNAMIC_TARGET | ABSTENTION_MISSING | none |
| dev-todo.js.type.TodoRepository | J-S | POS | `backend/…/repository/TodoRepository.java`:6 | type key | TP + FP | `extends JpaRepository` projected onto the same declaration span |
| dev-todo.js.extends.TodoRepository | J-S | POS | `backend/…/repository/TodoRepository.java`:6 | `extends java:…JpaRepository` on the clause | FN | the EXTENDS edge has no clause span |
| dev-todo.jc.AuthController.login | J-C | POS | `backend/…/api/AuthController.java`:20 | STATIC `AuthService#login()` | FN | L18 declaration span, same target |
| dev-todo.jc.AuthController.logout | J-C | POS | `…/AuthController.java`:25 | STATIC `AuthService#logout()` | FN | L23 declaration span, same target |
| dev-todo.jc.TodoController.list | J-C | POS | `…/api/TodoController.java`:25 | STATIC `TodoService#findAll()` | FN | L23 declaration span, same target |
| dev-todo.jc.TodoController.get | J-C | POS | `…/TodoController.java`:30 | STATIC `TodoService#findById(Long)` | FN | L28 declaration span, same target |
| dev-todo.jc.TodoController.create | J-C | POS | `…/TodoController.java`:35 | STATIC `TodoService#create(Todo)` | FN | L33 declaration span, same target |
| dev-todo.jc.TodoService.findAll | J-C | AMB | `…/service/TodoService.java`:18 | INFERRED {TodoRepository#findAll()} | CANDIDATE_MISSING | L17 declaration span, INFERRED, same set |
| dev-todo.jc.TodoService.findById | J-C | AMB | `…/TodoService.java`:22 | INFERRED {TodoRepository#findById(Long)} | CANDIDATE_MISSING | L21 declaration span, INFERRED, same set |
| dev-todo.jc.TodoService.create | J-C | AMB | `…/TodoService.java`:26 | INFERRED {TodoRepository#save(Todo)} | CANDIDATE_MISSING | L25 declaration span, INFERRED, same set |
| dev-todo.jc.TodoApplication.main.run | J-C | NEG | `…/TodoApplication.java`:10 | UNRESOLVED EXTERNAL_TARGET (`SpringApplication.run`) | ABSTENTION_MISSING | none |
| dev-todo.jc.TodoService.findById.orElseThrow | J-C | NEG | `…/TodoService.java`:22 | UNRESOLVED EXTERNAL_TARGET | ABSTENTION_MISSING | none |
| dev-todo.sqlp.V1 | SQL-P | POS | `backend/…/V1__create_todos.sql`:1 | valid | FN | file `UNMEASURED`, no parser verdict |
| dev-todo.sqls.table | SQL-S | POS | `…/V1__create_todos.sql`:1 | `sql:todos` on the statement | FN | L1 only (`lineEnd` null) |
| dev-todo.sqls.column.{id,title,done} | SQL-S | POS | `…/V1__create_todos.sql`:2–4 | `sql:todos#…` | FN ×3 | columns published without spans |

Unmatched product facts (11): the 10 J-C declaration-span facts listed above, and the 1 SQL-S table fact. Each overlaps a case, and no product fact lies outside the gold's reach. **False-resolved on all 12 guarded cases (NEGATIVE/AMBIGUOUS, INFERRED-expected or `mustNotEmitResolved`): 0.** That count is masked for one case by D2; see D1.

## Defects and product findings

None was fixed in product code. No product path was changed. Defect classes:

| ID | Severity | Finding | Reproduction | Status / proposed fix |
|---|---|---|---|---|
| D1 | **High (candidate), open** | An interface-typed receiver call `action.run()` (`Calls.java`:8) is published `CONFIRMED` (STATIC_RESOLVED) to the declared interface method `demo.Action#run()`. The provisional T00 gold expects INFERRED implementation candidates. It escapes `FALSE_RESOLVED` only because D2 moves the fact off the call-site span. If the gold's semantics hold, this is a correctness blocker. Spring Data repository calls on the same kind of receiver are already `POSSIBLE` (INFERRED) | `baseline-2nwqUR/findings.json`, unmatched fact `f0.p00004` | No narrow cause can be fixed without a semantic decision: whether a declared interface method is a valid static target. That decision belongs to the support table and needs adjudication (06: changing a core inferred/dynamic case requires product support-table review). If adjudicated as INFERRED: publish CHA candidates for interface or abstract receivers in `JavaAnalyzer` CALLS and add a regression test there |
| D2 | Medium, open | Java `CALLS` edges carry no call-site evidence (`metadata` `{}`), so a call can be anchored only to the caller declaration. Under the 06 match key (call-site span), every Java call is a miss plus an unmatched fact: 5+1 static, 4 candidate sets. TS edges do carry `lineStart` and `expression` | dumps in `baseline-2nwqUR/dumps/*.dump.json` | Record call-site line, column and expression on Java CALLS edges, as `TsGraphMapper` does |
| D3 | Medium, open | Java publishes no unresolved-call abstentions: `Class.forName`, `SpringApplication.run`, `Optional.orElseThrow` → `ABSTENTION_MISSING` ×3. Nothing is falsely resolved | findings | Publish `unresolvedCalls` metadata with a reason (`EXTERNAL_TARGET`/`DYNAMIC_TARGET`), as the TS path does |
| D4 | Medium, open | One TS file with a syntax error rejects the whole TS project: `TsSyntaxInputException` → job `FAILED`, and every submitted file gets `FAILED/PROJECT_SYNTAX_REJECTED` (`TsParsingStep.java`:101). The valid file loses its verdict and the invalid file is not identified, so all T-S/T-C output of the snapshot is lost. This is fail-closed: no false facts | `dev-t00-typescript-calls` dump, step `TS_PARSING FAILED` | Per-file syntax diagnostics. Exclude only the invalid files from the project |
| D5 | Medium, open | No SQL parse verdict: `V1__create_todos.sql` is `UNMEASURED`, so SQL-P valid-file success is 0/1 | findings | Record a per-file SQL parse outcome |
| D6 | Medium, open | SQL evidence: `DB_TABLE` has `lineEnd` null, and columns are published in metadata without spans → SQL-S FN ×4, 1 unmatched | findings | Publish statement and column line ranges |
| D7 | Low, open | `EXTENDS`/`IMPLEMENTS` edges have no clause span; the harness projects them onto the type declaration → J-S 1 FP + 1 FN | findings | Publish the clause range on inheritance edges |
| D8 | Medium, open | Three placeholder `METHOD` nodes for inherited Spring Data methods are published against `TodoRepository.java` with null lines, so they are facts without span evidence. The 06 rule "every public fact hash/span/namespace 100%" makes this a hard FAIL | evidence audit | Publish them as external or inherited stubs without a file association, or with the declaring type's span and an explicit `INHERITED` provenance |
| D9 | Info | The product publishes no per-fact namespace, so the 06 namespace check cannot be applied to product output | evidence audit | Publish module or namespace on facts (multi-module X-* depends on it) |

Harness defects found and fixed in this unit (no product impact):

* Observation ids were not unique across fixtures.
* The FILE component digest used the wrong framing.
* The runner protected the whole artifact root, refusing any output inside the repository; it now protects only the re-hashed components.
* `PROJECT_SYNTAX_REJECTED` was over-projected as a per-file syntax verdict, which credited the product with diagnosing `invalid.ts`.
* The packaged driver dropped its app handle before close.
* The packaged driver fetched file content for a non-ingested file.
* Attestation `validationIdentity` had the wrong type.

## Requirement matrix

| # | Requirement (source) | Status | Evidence / blocking input |
|---|---|---|---|
| 1 | Backend exporter: real pipeline + Testcontainers PG + real TS sidecar, T00 observations bound to classes/resources/dist digests and git revision (task, 06 §5) | PASS | `baseline-2nwqUR`; runner `artifactVerification: VERIFIED` |
| 2 | Packaged-app API exporter for ≥1 fixture, bound to manifest and app.asar hashes (task) | PASS | `packaged-Dvy5Vw`, fullstack fixture |
| 3 | Both paths agree (task) | PASS | 65 = 65 facts, identical outcomes. Dumps differ only by the ingest-policy file (documented) |
| 4 | Runner verified-execution attestation with tests (task) | PASS | 11 attestation tests + 4 adapter tests |
| 5 | Signed / third-party-witnessed execution proof | BLOCKED | Needs signing material and an independent witness. The attestation is local and unsigned (`EXECUTION_ATTESTATION_LOCAL_UNSIGNED`) |
| 6 | Inventory of existing oracle cases per cell, deduplicated by generator (task) | PASS | Inventory section |
| 7 | Per-cell baseline with 06 metric definitions (task) | PASS | Table above; the measured values themselves fail |
| 8 | Every FP/FN/false-resolved case listed with location (task) | PASS | Case table, `findings.json` |
| 9 | Annotation tooling (marker → span, validator for span/dup/leak/mirror) + `ANNOTATING.md` with procedure and quotas (task) | PASS | 6 annotation tests; guide |
| 10 | Gap table and remaining-work statement (task) | PASS | Gap section |
| 11 | 06 cell thresholds per R1 cell on an evaluation corpus (07 G-ACCURACY) | BLOCKED | 0 evaluation annotations in all 18 cells. On development material: FAIL J-S, J-C, T-P, T-C, SQL-P, SQL-S; no failure on tiny n for J-P, J-F, J-D, T-S, X-DATA; NOT_RUN for T-F, T-UI, JS-P, JS-S, JS-C, JS-UI, X-HTTP |
| 12 | Negative/ambiguous false-resolved = 0 on evaluation corpus (06) | BLOCKED | No evaluation negatives. Development: 0 of 12 guarded cases, but D1 is masked by D2 |
| 13 | Evidence hash validity 100% over published facts (06) | PASS (development material) | 29/29 and 24/24 |
| 14 | Evidence span validity 100% over published facts (06) | FAIL | 69 of 72 (D8); 1 incomplete range (D6) |
| 15 | Evidence namespace validity 100% (06) | FAIL | The product publishes no namespace (D9) |
| 16 | Coverage partition 100% (06) | PASS (development material) | runner `coverage-partition.json` PASS on both paths |
| 17 | Wilson 95% lower bound ≥ 0.95 with n ≥ 200 for C/F/X (06) | BLOCKED | Largest n = 5 (J-F). Needs the evaluation corpus |
| 18 | Per cell 200 positive + 100 negative/ambiguous independent annotations, ≥3 projects, ≥10 scenarios, 50/25 holdout, P ≥50 files (10) | BLOCKED | Needs independent human annotators and licensed pinned repositories |
| 19 | X-HTTP four strata 50/25 each with per-stratum thresholds (10) | BLOCKED | No X-HTTP material at R1 versions |
| 20 | Two-annotator review + adjudication of evaluation gold (06, 10) | BLOCKED | Needs people (tooling is ready) |
| 21 | 300-annotation pilot with measured time and disagreement (10) | BLOCKED | Needs people |
| 22 | Blind real-repository review (07) | BLOCKED | Needs reviewers and a selected real-repository corpus |

Counts (22 rows): **PASS 11, FAIL 2, NOT RUN 0, BLOCKED 9.** Rows 13 and 16 pass on development material only.

## Gap table (deliverable 5)

| Cell | Required evaluation pos / neg | Independent available | Development material (pos / neg-amb, unique) | Gap |
|---|---|---|---|---|
| J-P | 200 / 100 (+50 files) | 0 / 0 | 9 / 1 | 300 annotations, 50 files |
| J-S | 200 / 100 | 0 / 0 | 30 / 0 | 300 |
| J-C | 200 / 100 | 0 / 0 | 7 / 6 | 300 |
| J-F | 200 / 100 | 0 / 0 | 5 / 0 | 300 |
| J-D | 200 / 100 | 0 / 0 | 1 / 0 | 300 |
| T-P | 200 / 100 (+50 files) | 0 / 0 | 7 / 1 | 300, 50 files |
| T-S | 200 / 100 | 0 / 0 | 4 / 0 | 300 |
| T-C | 200 / 100 | 0 / 0 | 2 / 1 | 300 |
| T-F | 200 / 100 | 0 / 0 | 0 / 0 | 300 (no Nest 11 material) |
| T-UI | 200 / 100 | 0 / 0 | 0 / 0 (React 18 material is out of version) | 300 |
| JS-P | 200 / 100 (+50 files) | 0 / 0 | 0 / 0 | 300, 50 files |
| JS-S | 200 / 100 | 0 / 0 | 0 / 0 | 300 |
| JS-C | 200 / 100 | 0 / 0 | 0 / 0 | 300 |
| JS-UI | 200 / 100 | 0 / 0 | 0 / 0 | 300 |
| SQL-P | 200 / 100 (+50 files) | 0 / 0 | 1 / 0 | 300, 50 files |
| SQL-S | 200 / 100 | 0 / 0 | 4 / 0 | 300 |
| X-HTTP | 200 / 100, 4 strata × 50/25 | 0 / 0 | 0 / 0 (2 out-of-version POSSIBLE) | 300 |
| X-DATA | 200 / 100 | 0 / 0 | 1 / 1 | 300 |

What remains is the full 10 budget, unchanged by this unit:

* 5,400 evaluation annotations and 10,800 independent review decisions, with adjudication of about 20%.
* About 75 person-days of review, plus 20–35 person-days to prepare the corpus: licences, version pins, development gold.
* Real-repository selection: at least 3 independent public projects per cell at the R1 versions (Java 21, Spring 6.2 / Boot 3.4, Jakarta Persistence 3.1, TS 5.9, Nest 11, React 19 / Router 7, ES2022, PostgreSQL 16 DDL), with SPDX licence and pinned commits, and splits assigned by project, scenario and generator family.
* The 300-annotation pilot.
* The blind real-repository review.

The development baseline also shows product work needed before a corpus measurement can pass J-C, T-C, SQL-P, SQL-S or the evidence rows: D1–D9.

## Limits

* The development material is tiny (n ≤ 30 per cell) and was written on the implementation side. Its metrics are findings, not estimates. Spans in the transcription follow the conventions in `ANNOTATING.md`. Some failures (D2, D6, D7) are evidence-granularity mismatches between those conventions and what the product publishes. Under 06's match key they remain misses.
* The backend path replaces the `IMPORT` step, so it does not exercise the local-ingest policy. The packaged path does.
* The packaged path cannot see edge metadata, AMBIGUOUS nodes, the entity source column or route component keys through the API (recorded as `apiLimits`). For this fixture the converted facts are unaffected.
* The candidate was built from `9211e88`. `git diff 9211e88..HEAD` over the product paths is empty (`dirtyProductPaths: 0`).
* No timing or memory figures are reported. The native lock was held only for the packaged runs.

## Remaining conditions and recommendation

G-ACCURACY stays **BLOCKED** (rows 11, 12 and 17–22) and has two **FAIL** rows on product evidence (14, 15). Recommendation:

1. Adjudicate D1's semantics, then fix D2 and D3: Java call-site evidence and abstentions. Both are prerequisites for any J-C measurement.
2. Fix D8 and D9, or record an explicit support-table exception reviewed by the parent plan.
3. Fix D4 to D6 before measuring T-P, T-C, SQL-P and SQL-S.
4. Staff the annotation pilot with the tooling in `validation/t00/annotate.cjs`.
5. Select the real-repository corpus.
6. Run `accuracy-export.cjs` and `accuracy-packaged-export.cjs` on the evaluation corpus once it exists. The runner scores only `VALIDATION`/`HOLDOUT` there.
