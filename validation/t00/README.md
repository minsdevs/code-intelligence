# T00a validation contracts

This directory implements the isolated contract and scorer work in the [execution addendum](../../docs/audit/execution-roadmap-2026-10-02.md). It uses Node standard libraries and local files. It does not invoke an analyzer, execute fixture code, fetch a repository, run commands from a manifest, or update gold from product output.

**A contract pass is not a product accuracy pass.** Every one of the 18 R1 cells remains `publicSupported: false`. Gate mode cannot return 0 in T00a because verified product execution, the independent evaluation corpus, and reviewed pattern allocations are absent. The 300-annotation pilot and all product resource measurements remain `NOT_RUN`; G-ACCURACY remains `BLOCKED`.

## Run locally

No package installation is required. Node 24 is the intended CI runtime; the initial local checks used Node 26.5.0. CI execution is separate evidence, not implied by a local pass.

```sh
node --test validation/t00/test/*.test.cjs
```

The CLI requires `--offline` and an explicit mode. The output directory must be new, with an existing parent, and outside the input and runner trees. For example, first create a temporary parent:

```sh
T00_RESULTS="$(mktemp -d /tmp/code-intelligence-t00a.XXXXXX)"

node validation/t00/runner.cjs --mode contract --offline \
  --corpus validation/t00/corpus.json \
  --capabilities validation/t00/capability-manifest.json \
  --output "$T00_RESULTS/contract"
```

This explicit `CONTRACT_ONLY` run returns 0 for a valid contract, with `productEvaluation: NOT_RUN` and `observationEvaluation: NOT_RUN`. Contract mode rejects observation/build options so it cannot quietly ignore supplied product evidence.

```sh
node validation/t00/runner.cjs --mode gate --offline \
  --corpus validation/t00/corpus.json \
  --capabilities validation/t00/capability-manifest.json \
  --output "$T00_RESULTS/missing"
```

This returns 2 (`BLOCKED`): observations and a product build declaration are absent. A provided but nonexistent observation path is also missing evidence; a malformed file is `FAIL` with exit 1.

The following digest identifies the checked-in **synthetic producer descriptor**. It is not a product executable, application build, or execution attestation. It lets the self-test exercise digest binding without inventing a product run.

```sh
T00_SYNTHETIC_DIGEST="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync("validation/t00/selftest/producer-descriptor.json")).digest("hex"))')"

node validation/t00/runner.cjs --mode gate --offline \
  --corpus validation/t00/corpus.json \
  --capabilities validation/t00/capability-manifest.json \
  --observations validation/t00/selftest/known-good-observations.json \
  --product-build-sha256 "$T00_SYNTHETIC_DIGEST" \
  --output "$T00_RESULTS/good-authored"

node validation/t00/runner.cjs --mode gate --offline \
  --corpus validation/t00/corpus.json \
  --capabilities validation/t00/capability-manifest.json \
  --observations validation/t00/selftest/known-bad-observations.json \
  --product-build-sha256 "$T00_SYNTHETIC_DIGEST" \
  --output "$T00_RESULTS/bad-authored"
```

The good authored bundle returns 2, with `observationEvaluation: PASS` scoped to `SYNTHETIC_SELF_TEST`. The bad bundle changes one required abstention into `STATIC_RESOLVED`; it returns 1 with `FALSE_RESOLVED`. A digest mismatch is a contract failure. A matching declaration never changes `artifactVerification` or `productExecutionVerification` from `NOT_RUN`.

| Mode / condition | Exit | Contract or observation result | Product evaluation |
| --- | ---: | --- | --- |
| Explicit contract-only, valid inputs | 0 | Contract `PASS`; observations `NOT_RUN` | `NOT_RUN` |
| Gate, prerequisites missing | 2 | Available inputs validated | `BLOCKED` |
| Gate, good authored observations | 2 | Observation `PASS`, synthetic scope | `BLOCKED` |
| Bad observations / malformed input | 1 | `FAIL`; malformed observations are not scored | `BLOCKED` |
| Unsafe/existing output or invalid CLI | 1 | Fixed error code on stdout | No artifact assertion |

There is no public gate promotion option and no hidden success mode. The runner emits one small JSON summary on stdout and no source excerpts, arbitrary input identifiers, paths, caught error messages, or stacks.

## Checked-in corpus and provenance

`corpus.json` references two small hand-authored development fixtures. Each has two source files and five cases: a valid parse, an invalid parse diagnostic, a direct call, an inferred two-candidate call, and a required unresolved call. There are **10 cases total: 6 positive and 4 negative**. They cover scorer examples in J-P/J-C/T-P/T-C; the remaining 14 cells have no observations.

The Java syntax targets Java 21. The TypeScript fixture targets TypeScript 5.9.3 and intentionally contains CRLF and an accented character for byte-span checks. These declarations do not prove that either compiler or a product parser was run. Sources and expectations were authored together for this repository under its [MIT license](../../LICENSE). License status is `AUTHOR_DECLARED`.

Both fixtures belong to one synthetic project, scenario family, and authoring family. They are not independent projects. Review records say `AGENT`, `SOURCE_AUTHORED`, and `AUTHOR_PROVISIONAL`; reviewer lists are empty. Known-good observations are also authored self-test data, not a capture of analyzer behavior or independent ground truth. The checked-in bad observations are an intentional mutation of that authored bundle.

No command regenerates the gold files from analyzer output. The test helper rewrites only temporary authored test inputs to construct specific rejection scenarios. Editing a real oracle requires new references/hashes and a new review; changing hashes does not manufacture independent review provenance.

## Input contract

[schemas/contracts.schema.json](schemas/contracts.schema.json) supplies named Draft 2020-12 `$defs`: `corpus`, `fixture`, `cases`, `review`, `observations`, and `capabilities`. A caller selects the appropriate definition. The runtime uses a deliberately limited interpreter for the checked-in schema vocabulary, with no external reference loading or expression evaluation. Version `1.0.0` is exact; unknown fields, duplicate JSON keys (including escaped equivalents), forbidden object keys, invalid UTF-8, duplicate identifiers, unsafe numeric offsets, and contradictory states fail closed.

| Input | Required binding / meaning |
| --- | --- |
| Corpus | Purpose and SHA-256 references to pinned fixture manifests |
| Fixture | ID/version, license/origin, project/scenario/generator family, split, target versions, capabilities and pattern/stratum declarations |
| Source roster | Fixture-relative canonical path, SHA-256, byte length, and namespace |
| Gold / negative cases | Source span, semantic target keys, expected state, reason/diagnostic codes, polarity, and prohibition on false resolution |
| Oracle review | Author/provenance, exact gold/negative hashes, reviewer decisions, independence declarations, optional adjudication |
| Observation bundle | Corpus hash, capability manifest hash, declared producer/build identity, exact fixture runs and version/source digests |
| Observed file outcomes | One owner/status for every declared source/capability pair, including exclusions and byte counts |
| Capability manifest | Exact 18-cell policy, thresholds, version ranges, sample requirements and HTTP strata; no support promotion |

Source spans are zero-based UTF-8 byte intervals `[start,end)`. Their hash and namespace must match the roster; neither endpoint may split a UTF-8 sequence. Fact spans are nonempty. A parser case identifies the entire file, once per parser cell. Targets are opaque authored semantic keys in this framework. This contract does **not** establish target-declaration evidence, a persisted product namespace/generation, or both endpoints of a real cross-language edge; the product adapter and T02/T04 must establish those before public evaluation.

The observation bundle is a declaration. The CLI checks that it binds the expected corpus, source bytes, versions, and caller-supplied digest. It does not verify that a product binary with that digest exists or consumed those bytes. Supplied source and build hashes are evidence bindings, not execution attestations.

Two distinct `HUMAN` reviewers declaring independence from both author and implementers, with matching hashes and approvals, are the minimum review metadata. Adjudication needs a third distinct human and matching hashes. These checks do not authenticate human identity or independence. A claimed independent review with missing/conflicting records fails; author-provisional material never counts as independently reviewed.

Cross-split checks bind project, scenario, and generator families, whole source manifests, and individual source content hashes. Copying a file under a new name/project does not remove the split conflict. Common shared source bytes are conservatively rejected across splits. A future public corpus needs independently reviewed allowances or separation, not silent exceptions here.

## Scoring and readiness

Thresholds follow the pinned [06 validation contract](../../docs/multilanguage-plan-2026-10-02/06-benchmarks-validation.md) and [10 public cells](../../docs/multilanguage-plan-2026-10-02/10-r1-public-cells.md):

| Family | Required point metrics |
| --- | --- |
| P | Valid-file success ≥99%; invalid-file required diagnostic recall 100% |
| S | Precision ≥99%; recall ≥95% |
| STATIC C/F/X | Precision ≥99%; recall ≥90%; Wilson 95% precision lower bound ≥95% |
| INFERRED candidate sets | Micro precision ≥90%; recall@5 ≥90%; exact-set accuracy ≥85%; candidates ≤5 |
| All guarded negatives / ambiguous cases | False-resolved count 0 |

The first matching resolved fact counts TP; duplicate resolved claims count FP. Repeated empty-target abstention claims also count FP. No outputs against positive gold produce recall 0 and precision `null`. A denominator of zero is `null`, not 0 or 1, and is excluded from macro averages. Candidate metrics use sets; micro counts and macro per-case precision/recall are separate. Exact-set success also requires the expected resolution state. Duplicate candidate sets and parser results fail because each is a single-result contract.

Expected `UNRESOLVED`, `UNSUPPORTED`, or `INFERRED` states require a prohibition on resolved output regardless of polarity; a caller cannot disable this by setting the guard flag false. The scorer also derives that prohibition from the expected state. Inconsistent resolution states at one fact location, or resolved facts emitted for an `UNSUPPORTED` file outcome, are contract failures before scoring.

An invalid parser input missing even one required diagnostic fails with a one-file sample. False resolution, evidence/contract errors, and unmatched observations awaiting annotation review also fail immediately. Per-case diagnostic failures do not override legitimate aggregate point thresholds: a single ordinary error in a sufficiently large sample is assessed through those thresholds. Unmatched observations are recorded by hash in `annotationReviewQueue`; they cannot be silently discarded or automatically approved into gold.

Wilson intervals are reported for any nonzero static denominator, but the Wilson gate requires at least 200 observed resolved facts. Smaller samples receive `WILSON_SAMPLE_MISSING` instead of being treated as a population pass. Public readiness also requires, **per cell**, 200 positive/100 negative cases, 3 independently reviewed public projects, 10 scenarios, 50 parser files for P, and 50 positive/25 negative holdout cases. Development cases do not enter those totals. X-HTTP additionally reports TSX_SPRING, TSX_NEST, JSX_SPRING, and JSX_NEST separately, with 50 positive/25 negative cases and point thresholds per stratum.

`PRODUCT_EVALUATION` scores only `VALIDATION` and `HOLDOUT` runs. Development facts never contribute TP/FP/FN, candidate metrics, macro averages, or threshold decisions in that scope. `SYNTHETIC_SELF_TEST` explicitly scores its development fixtures. Every supplied run still receives contract/hash/span checks. Coverage rows declare their split and `scoreEligible` flag; the report records scored and unscored-development run counts. A product bundle containing only development runs has `observationEvaluation: NOT_RUN`, not `PASS`.

The capability manifest records required versions (including Java 21, TypeScript 5.9, React 19, Router 7, and Nest 11); a fixture outside its declared cell/stratum versions is rejected. Parser tool inventory is declarative and marked `NOT_VERIFIED`. Quantitative allocations within each pattern await independent review. Coverage statuses partition all files; a reported failed/cancelled/pending scored run or outcome fails observation evaluation. `PARTIAL` and `UNSUPPORTED` remain visible; authored fact scores alone do not establish full processing or public readiness.

`supportedPatternRecall` uses the evaluated, declared oracle denominator. `overallGoldRecall` is `null`, with status `NOT_MEASURED` and reason `UNSUPPORTED_POSITIVE_ORACLE_MISSING`: this framework has no separate annotated unsupported-positive population. It does not reuse supported recall as an overall score or measure unannotated repositories. Unobserved cells report `NOT_RUN` with null metrics. All product gate cells remain unavailable for public support.

## Artifacts and safety limits

A run that acquires a safe new output directory writes six artifacts (ordinary successful filesystem writes are required):

| Artifact | Meaning |
| --- | --- |
| `report.json` | Separate contract, authored-observation and product outcomes; per-cell metrics, failures, blockers, provenance limitations |
| `junit.xml` | One explicitly scoped contract/gate result; blocked gates are skipped with exit 2 |
| `coverage-partition.json` | Claimed file-status partitions, with measurement provenance and hashed fixture references |
| `resource-samples.csv` | `NOT_RUN`, with empty duration/RSS/sample fields |
| `evidence-check.json` | Count of validated observation source bindings; product consumption stays `NOT_VERIFIED` |
| `artifact-manifest.json` | Input hashes/sizes, hashes/sizes of the other five outputs, actual Node/platform/architecture, runner digest and limits |

The runner digest covers the actual implementation/schema bytes, including uncommitted changes. The manifest excludes its own hash to avoid a self-reference. It omits input paths and source text. Case references are SHA-256 of `fixtureId + '/' + caseId`; review-queue references use `fixtureId + '/' + observationId`. These can be correlated privately with the inputs. No raw target keys, rationale, source text, user paths, or reviewer identifiers are copied into artifacts.

Limits: 4 MiB per JSON input, 1 MiB per source file, 64 fixtures, 10,000 oracle cases, 20,000 elements per JSON array, 200,000 parsed JSON nodes, and depth 64. **The 64 MiB `totalBytes` limit is a cumulative runtime read budget, including implementation/schema reads and final integrity rereads; it is not a promise to accept 64 MiB of unique fixture input.** A successful run generally has room for less than 32 MiB of unique inputs once duplicate reads and implementation overhead are included. Descriptor size and cumulative budget are checked again after open, before allocation.

Canonical fixture paths reject absolute paths, traversal, backslashes, repeated separators, encoded separators/dots, and null bytes. Static symlink ancestors, symlink leaves, hard links, directories and other special files are rejected; only the operating system's `/tmp` and `/var` ancestor aliases on macOS are allowed. Reads use `O_NOFOLLOW`, descriptor identity/size/time checks, bounded buffers, hash verification, and a final reread. Output roots cannot overlap input/runner roots, traverse symlinks, or already exist; files use exclusive creation. Existing parent directories are reserved for every declared input before leaf validation, including missing or malformed corpus/observation files. If input parents are missing too, the nearest existing ancestor is conservatively reserved.

This is safety for static synthetic development trees. Node's path-based ancestor checking does not confine hostile concurrent ancestor replacement, and file metadata does not establish a production sandbox. T01/T03 must supply and test descriptor-relative confinement. The read budget does not claim measured process-tree RSS or a product performance result.

T00b remains blocked on licensed pinned public repositories, blind split access control, independently authored/reviewed oracles, qualified independent reviewers, measured annotation/review time, reviewed pattern allocations, and an adapter that captures a real immutable product build's outputs. This small framework supplies none of the planned 300 independently reviewed pilot annotations or the 5,400 annotations for all 18 public cells.
