# Annotating T00 evaluation fixtures

This guide is for the people who build the G-ACCURACY evaluation corpus. It covers the authoring tool (`annotate.cjs`), the span and key conventions, the two-annotator procedure with adjudication, and the per-cell quotas. The tool and checked-in transcriptions do **not** constitute an evaluation corpus. Gold that an implementer or an agent writes is development material, whatever the tool says.

## Hard rules

1. **Never look at product output while annotating.** That includes the app UI, API responses, `validation/local/**` evidence, observation bundles, dumps, `findings.json`, and product logs. Annotate from the pinned source bytes and the language/framework specification only. The tool refuses specs and source trees containing product-output fields or files, but it cannot detect copying by hand.
2. Annotators and the adjudicator must be independent of the product implementers and of each other's drafts until the comparison step.
3. A fixture is never edited in place. A corrected oracle is a new `fixtureVersion` built into a new directory, with a new review.
4. Evaluation splits (`VALIDATION`, `HOLDOUT`) are assigned by **project, scenario family and generator family**, never by case. One project, scenario family, generator family or identical file content may appear in only one split across all corpus files.
5. Real repositories need a licence that allows redistribution of the excerpts, an SPDX id, and a pinned 40-hex commit. Never run their install or build scripts.

## Tool

All commands are offline, read the given files only, and refuse to overwrite.

```sh
# Build a fixture directory (fixture.json, gold.json, negatives.json, review.json, annotation-record.json, source/)
node validation/t00/annotate.cjs build --spec <spec.json> --output <new-directory>

# Compare two annotators' specs for the same fixture (exit 3 when they disagree)
node validation/t00/annotate.cjs compare --a <annotator-a.spec.json> --b <annotator-b.spec.json>

# Validate corpora: contract, span records, duplicate ids, cross-split leakage across ALL given corpus files,
# and (with --observations) refusal of gold that mirrors an observation bundle
node validation/t00/annotate.cjs validate --capabilities validation/t00/capability-manifest.json \
  --corpus <corpus-a.json> [--corpus <corpus-b.json> ...] [--observations <observations.json> ...]

# Print the text and line of each case span for review
node validation/t00/annotate.cjs show --fixture <fixture.json> [--case <caseId>]
```

`build` writes `review.json` with `status: AUTHOR_PROVISIONAL` and no reviewers. Only the review procedure below may change that, and only into a new fixture version.

## Spec format (`t00-annotation-spec/1`)

A spec names the annotator (`HUMAN` for evaluation material), the fixture metadata (`fixtureId`, `fixtureVersion`, `corpusId`, `license`, `origin` with `projectId`/`uri`/`commit`, `scenarioFamilyId`, `generatorFamilyId`, `split`, `versions`, `capabilities`, `sourceRoot`, `sourceMode`, `namespaces`, optional `eligibility.overrides` and `exclude`) and the `cases`. See `validation/t00/baseline/specs/*.spec.json` for complete development examples.

Each case selects its span in one of these ways:

| Selector | Meaning |
|---|---|
| `{ "marker": "id" }` | `sourceMode: INLINE_MARKERS`: the bytes between `[[@id]]` and `[[/@id]]` in a copy of the source. Markers are removed before hashing; offsets refer to the stripped bytes. |
| `{ "file": "f", "wholeFile": true }` | The whole file (parser cases). |
| `{ "file": "f", "text": "...", "occurrence": n }` | One literal occurrence; `occurrence` is required when the text occurs more than once. |
| `{ "file": "f", "from": "...", "to": "...", "fromOccurrence": n, "toOccurrence": m }` | From the start of `from` through the end of the next `to`. |

Add `expectText` (or `expectSha256`) to any case whose selector could drift; the build fails on a mismatch. Every span is re-checked against the source bytes by `validate` through `annotation-record.json`.

## Span conventions

| Cell / pattern | Span |
|---|---|
| P (`valid-syntax`, `invalid-syntax`) | Whole file. Invalid files carry `valid: false`, `diagnostics: ["SYNTAX_ERROR"]`. |
| S type/method declaration | From the first annotation or modifier through the closing brace (or `;` for abstract/interface members). |
| S inheritance (`inheritance-span`) | The `extends …`/`implements …` clause only. |
| S component/function (TS/JS) | From `export`/`function`/`const` through the closing brace. |
| SQL-S table / column | `CREATE TABLE name (` through `);` / the column definition without the trailing comma. |
| C call (`FACT` or `CANDIDATES`) | The call expression: callee through the closing parenthesis (`authService.login()`). |
| F route / Spring handler | From the mapping annotation through the handler's closing brace. |
| J-D entity / X-DATA mapping | From `@Entity` through the class's closing brace. |
| UI HTTP call-site | The URL literal including quotes. |

The match key is `(cellId, kind, relationKind, namespace, path, start, end)`. A product fact on a different span is an unmatched fact plus a missed case: it is never silently re-targeted.

## Expectation vocabulary

* `resolution`: `STATIC_RESOLVED` (exactly one target is determined by the source alone), `INFERRED` (a candidate set of at most five; `kind: CANDIDATES`), `UNRESOLVED` / `UNSUPPORTED` (abstention; `targets: []` with a reason), `NOT_APPLICABLE` (parser cases).
* `polarity`: `POSITIVE` for facts the product must find; `NEGATIVE` for cases that must stay unresolved; `AMBIGUOUS` for candidate cases whose single static answer would be wrong. Set `mustNotEmitResolved: true` on every NEGATIVE/AMBIGUOUS case: one `STATIC_RESOLVED` there is a correctness blocker.
* Reason codes: `EXTERNAL_TARGET` (target outside the analysed sources, e.g. JDK or library), `DYNAMIC_TARGET` (computed member, reflection, `any` receiver), `UNRESOLVED_TARGET` (no declaration found), `SYNTAX_ERROR` (parser diagnostics).
* Target keys:

| Cell | Target key |
|---|---|
| J-S, J-C | `java:<package>.<Type>` / `java:<package>.<Type>#<method>(<erased parameter types>)`; inheritance `extends java:<fqcn>` / `implements java:<fqcn>` |
| T-S, T-C, JS-* | `ts:<fixture path>#<name>` / `js:<fixture path>#<name>` |
| J-F, T-F | `route:<METHOD> <path>` |
| J-D | `jpa:<fqcn> -> sql:<table>` |
| SQL-S | `sql:<table>`, `sql:<table>#<column>` |
| X-DATA | `<namespace>:sql:<table>` |
| X-HTTP | `<namespace>:route:<METHOD> <path>` |
| T-UI, JS-UI | `ui-route:<path>`, `ui-route:<path> -> <ts|js>:<component>`, `http-call:<METHOD> <url>` |

When the pattern list in `capability-manifest.json` does not cover a case, stop and ask for a pattern review; do not invent a new pattern id in a spec.

## Two-annotator procedure with adjudication

1. A corpus coordinator selects the project (licence checked, commit pinned), assigns its split, `projectId`, `scenarioFamilyId` and `generatorFamilyId`, and copies the source roster into a read-only directory. The coordinator does not annotate.
2. Annotators A and B independently write a spec each (same `fixtureId`, same case ids for the case list the coordinator gives them, or their own ids for open discovery). Neither sees the other's spec or any product output.
3. Run `annotate.cjs compare --a A.spec.json --b B.spec.json`. Record agreement and per-case disagreements.
4. A third person, the adjudicator (HUMAN, not an annotator, not an implementer), decides each disagreement from the source only and writes the final spec. Unresolvable cases are dropped from the evaluation split and listed; they are not converted to negatives.
5. `annotate.cjs build` the final spec into a new directory, then `annotate.cjs validate` with every corpus file of the release (to catch cross-split leakage).
6. Write the review record into a **new fixture version**: `review.json` with `status: INDEPENDENT_REVIEWED` when both reviewers approve the final gold unchanged, or `ADJUDICATED` when the adjudicator decided disagreements. `reviews` holds one entry per independent reviewer (`reviewerId`, `kind: HUMAN`, `decision: APPROVE`, the final `goldSha256`/`negativesSha256`, `independentFromAuthor: true`, `independentFromImplementers: true`); `adjudicator` (only for `ADJUDICATED`) is a further `HUMAN` reviewer who is neither the author nor a listed reviewer and signs the same hashes. The runner refuses a non-provisional status without two such reviewers, and counts a fixture as independently reviewed only then.
7. Record time per case and disagreement rate. The first 300 annotations are the T00 pilot that re-estimates the full budget.

## Per-cell quotas (evaluation splits only; development material does not count)

From `validation/t00/capability-manifest.json` (10-r1 public cells). Every cell needs 200 positive and 100 negative/ambiguous evaluation annotations, at least 50/25 of them in `HOLDOUT`, from at least 3 independent public projects and 10 scenario families. P cells additionally need at least 50 parser files.

| Cell | Positive | Negative/ambiguous | Holdout pos/neg | Projects | Scenarios | Parser files | Patterns | Strata (pos/neg) |
|---|---:|---:|---|---:|---:|---:|---|---|
| J-P | 200 | 100 | 50/25 | 3 | 10 | 50 | valid-syntax, invalid-syntax | |
| J-S | 200 | 100 | 50/25 | 3 | 10 | 0 | type-declaration, method-declaration, inheritance-span | |
| J-C | 200 | 100 | 50/25 | 3 | 10 | 0 | direct-source-call, overload, external-unresolved, dynamic-unresolved | |
| J-F | 200 | 100 | 50/25 | 3 | 10 | 0 | literal-route, mapping-conditions, composed-mapping, inherited-mapping, dynamic-bean-unresolved | |
| J-D | 200 | 100 | 50/25 | 3 | 10 | 0 | entity, schema-table, runtime-naming-unresolved | |
| T-P | 200 | 100 | 50/25 | 3 | 10 | 50 | valid-syntax, invalid-syntax | |
| T-S | 200 | 100 | 50/25 | 3 | 10 | 0 | function, type, module, component-span | |
| T-C | 200 | 100 | 50/25 | 3 | 10 | 0 | direct-source-call, config-alias, reexport, dynamic-unresolved | |
| T-F | 200 | 100 | 50/25 | 3 | 10 | 0 | controller-route, global-prefix, module, dynamic-unresolved | |
| T-UI | 200 | 100 | 50/25 | 3 | 10 | 0 | component, literal-route, http-callsite, dynamic-url-unresolved | |
| JS-P | 200 | 100 | 50/25 | 3 | 10 | 50 | valid-syntax, invalid-syntax | |
| JS-S | 200 | 100 | 50/25 | 3 | 10 | 0 | function, module, component-span | |
| JS-C | 200 | 100 | 50/25 | 3 | 10 | 0 | direct-source-call, explicit-import, prototype-unresolved, computed-unresolved | |
| JS-UI | 200 | 100 | 50/25 | 3 | 10 | 0 | literal-route, http-callsite, dynamic-url-unresolved | |
| SQL-P | 200 | 100 | 50/25 | 3 | 10 | 50 | create-table, alter-add-column, alter-drop-column, invalid-syntax | |
| SQL-S | 200 | 100 | 50/25 | 3 | 10 | 0 | schema-table, column-span | |
| X-HTTP | 200 | 100 | 50/25 | 3 | 10 | 0 | service-origin-method-path, conditions, ambiguous-service | TSX_SPRING 50/25; TSX_NEST 50/25; JSX_SPRING 50/25; JSX_NEST 50/25 |
| X-DATA | 200 | 100 | 50/25 | 3 | 10 | 0 | datasource-schema-table, name-only, different-database | |

Total: 18 × 300 = 5,400 evaluation annotations and 10,800 independent review decisions (`docs/multilanguage-plan-2026-10-02/10-r1-public-cells.md`). The same source project may serve several cells, but each cell's cases and review are its own.

## Measuring the product against a corpus

The product is measured only after the corpus is final (see `validation/pre-release/README.md` once updated, and `docs/audit/accuracy-baseline-2026-10-07.md`): `validation/pre-release/accuracy-export.cjs` (backend pipeline with Testcontainers PostgreSQL and the local TS sidecar) and `accuracy-packaged-export.cjs` (packaged app API) write an observation bundle and an execution attestation, and `validation/t00/runner.cjs --mode gate` scores it. Annotators never run these.
