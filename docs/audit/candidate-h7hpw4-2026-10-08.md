# Medium/large time fixes and candidates wFroXK, h7hpw4 — 2026-10-08

After candidate 9lVRha (medium class backend OOM, large class not run), units w7-medium, w8-graph,
w9-keychain, w9-deps and w10-restart were verified and merged into `codex/perf-medium-20261008`, and
candidate **wFroXK** was built from clean `25ab8b1`. wFroXK passed the functional checks, but its
medium smoke failed in TS_PARSING: the isolated (XPC) analyzer path could not carry a multi-request
analyzer session. Units w11-ts-xpc (that defect) and w12-downloader (a flaky desktop test) followed,
and candidate **h7hpw4** was built from clean `4bd54bf` (`adapterIsolation=xpc-required`). On
h7hpw4 the medium and large classes complete end to end in the packaged app for the first time;
their single smoke observations exceed the analysis and refresh limits (see
[G-PERF smoke](#g-perf-smoke)). Formal release remains **NO_GO**.

Commands, identities and raw-result hashes are in the [companion ledger](candidate-h7hpw4-2026-10-08.json).

## Decisions recorded by the user (2026-10-08)

| Item | Decision |
| --- | --- |
| SEC-M-02 / `packaged-keychain-acceptance` | Import through the product folder picker (no drop, no confirmation dialog); the drop confirmation stays covered by the product sequence and the security probe |
| Dependabot #49–#52 | Update lockfiles only to the patched versions; `package.json` ranges unchanged |
| Verification scope | Risk-based per candidate: full regressions plus the packaged checks the changes touch, medium/large smoke (`--smoke-2`) and SBOM. Twenty-run gates (warm startup, small/medium/large series) run once, on the final release candidate on a quiet machine |

Because of the last decision, checks not rerun are recorded as **NOT RUN** for that candidate, not
as carried over. On h7hpw4 only the checks touched by w11 were rerun (product sequence, job races,
security probe, medium/large smoke); owner-crash, UX pilot and SBOM ran on wFroXK, whose
product sources differ from h7hpw4 only in `desktop/src/adapter-isolation.cjs`, two supervisor
byte limits and three backend TS client classes (`git diff 25ab8b1 4bd54bf`). Not run on either: warm-startup twenty runs, G-PERF
small/medium/large `--series-20`, G-COST packaged probe and PK-08 ask, accuracy packaged export,
native preflight/recovery matrix, import-evidence native, adapter-isolation stage (last results:
9lVRha).

## Units

| Unit | Audit | Change | Verified by the coordinator |
| --- | --- | --- | --- |
| w7-medium | [medium-oom](medium-oom-2026-10-08.md) | JavaAnalyzer passes and bounded symbol-solver caches (medium heap), TS session timeout | merged before this wave (`dba2557`); backend Docker suite below |
| w8-graph | [medium-large-time](medium-large-time-2026-10-08.md) | Custom plans for key-list lookups, linear feature linking and seed overlap, batched link/flow/evidence/commit persistence, Java parse-ahead and concurrent analyzers, TS single walk and line index, full ids in scanner patch headers | ts-analyzer 296/296; backend Docker 1,960 pass / 0 fail; product sequence, job races and smoke on wFroXK |
| w9-keychain | [keychain-acceptance-picker](keychain-acceptance-picker-2026-10-08.md) | Runner only: shared folder-picker helper; real-Keychain runner imports through the picker and refuses any message box | runner tests 414/414; UX pilot on wFroXK (uses the shared helper) |
| w9-deps | [dependabot-lockfiles](dependabot-lockfiles-2026-10-08.md) | Lockfiles: proxy-addr 2.0.8 (tree-analyzer), source-map-js 1.2.2 (tree-analyzer, ts-analyzer, frontend); offline cache entries added | `npm ls` in the build checkout; shipped ts-analyzer in `AdapterSupervisor.xpc` has proxy-addr 2.0.8; SBOM below |
| w10-restart | [restart-shutdown-hang](restart-shutdown-hang-2026-10-08.md) | none (finding only) | job-race rerun on wFroXK, below |
| w11-ts-xpc | [ts-xpc-medium](ts-xpc-medium-2026-10-08.md) | One worker per 03 §6 analyzer session (open → close) in xpc-required mode; supervisor relays up to 1 GiB per session each way (was one 10 MiB request / 64 MiB response; counters only, streaming, per-frame bounds, 10 min limit and two sessions unchanged); analyzer rejections fail the job with `TS_ANALYZER_REJECTED` / `ANALYSIS_LIMIT` instead of a null code | desktop 3,266 pass / 0 fail; backend Docker 1,962 pass / 0 fail; product, job races, security probe and medium/large smoke on h7hpw4 |
| w12-downloader | [downloader-retry-test](downloader-retry-test-2026-10-08.md) | Test only: the loopback fixture server counts only fixture paths | `dependency-downloader.test.cjs` 5/5 runs, 13/13 each; desktop suite on `4bd54bf` 0 fail |

w8-graph harness observations (non-acceptance, below the app): medium 277 → 125 s, large 2,230 →
604 s with identical result digests. The large base run overlapped a 93 s host sleep (09:05:41,
`pmset -g log`), so its sum is a lower-confidence figure in both directions.

## Regression on the merged source (`52e007d`)

Short-path detached worktree `~/Dev/ciw/int`, evidence `validation/local/post-merge-20261008a`
(`25ab8b1` adds only the w8 audit): frontend vitest 480/480 and `tsc -b`; ts-analyzer 296/296;
validation runner tests 414/414; desktop 3,309 (3,263 pass, **1 fail**, 45 skip); backend Docker
suite 1,992 (1,960 pass, 0 fail, 32 skip; `backend-QoRJUb`); events 19/19 (`events-X91yJq`).

- The first Docker attempt was refused by the runner because the coordinator's script omitted
  `--socket`; logs kept (`backend-docker.log`, `events-docker.log`), rerun above.
- Desktop failure: `dependency-downloader.test.cjs` "upstream HTTP failures retain the stable builder
  server-error retry behavior" (`3 !== 2` requests). Intermittent and pre-existing: on `main`
  `8e9a9d8` it failed 1 of 3 isolated runs, on the merged head 2 of 3 and later 4 of 5. Unit
  w12-downloader ([downloader-retry-test](downloader-retry-test-2026-10-08.md)) found the third
  request to be a foreign `GET /` (user agent `dev-cockpit`) from another desktop app probing
  listening loopback ports during the builder's 2 s retry backoff; electron-builder's fallback
  download never ran. Test-only fix: the fixture server counts only fixture paths (other paths get
  404); the assertions are unchanged. After the fix the file passed 10/10 runs (unit) and 5/5
  (coordinator, 13/13 tests each). The original failing run is kept.

## Candidate wFroXK

Built from baseline tZgvV7 at clean `25ab8b1`, build sequence `1791422163000`,
`--adapter-isolation xpc-required` (`pre-release-candidate/build-xzbSkA`); codesign (ad-hoc) verifies;
835 MB. Ad-hoc Validation app; not signed, notarized or released. The build-work duplicate retirement
was refused (frontend copy in use by Spotlight, staged runtime inventory differs from the app);
nothing was removed.

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks | `pre-release-final/product-qSQ5I5` |
| Owner crash `AFTER_SOURCE_RENAME` / `BEFORE_COMPLETED_CLEANUP` | **PASS**, 6 / 6 | `electron-crash/native-vjvyod`, `native-UyihRx` |
| Packaged job races, first run | FAIL (host sleep): the lid was closed on battery 10:25:40–10:35:16 during `analyzer-owner-kill`; shutdown phase SOURCES "ran" 575.5 s, exactly the sleep | `job-race/product-2YwMwH` (kept), w10-restart audit |
| Packaged job races, rerun (unchanged runner, AC, lid open) | **PASS**, 8 | `job-race/product-i8wPjJ` |
| Packaged security probe | COMPLETE: fuses (xpc-required), node modes and renderer CSP PASS | `security-internal-review/packaged-BgylVh` |
| UX scripted pilot | COMPLETED, 190 states, 0 errors, 0 contrast failures; the folder picker answered once per import | `pre-release-ux/ux-ssq5mw` |
| SBOM (`sbom-candidate.cjs --offline`) | SBOM_WRITTEN, 348 components, 0 unattributed, complete | `sbom/run-Kjb0f6` |
| Runtime exclusions (`--jar`) | **PASS**, 150 nested JARs, 0 excluded artefacts | `stage5-wFroXK/sbom-runtime-exclusions.log` |

Host sleeps on battery with the lid closed also occurred at 09:49:43–09:59:34 and 10:43:50–10:58:46;
no wFroXK run overlapped them. Timing runs are now wrapped in `caffeinate` and require AC with the
lid open.

## Regression after w11 (`4bd54bf`)

Evidence `validation/local/post-merge-20261008b`: desktop 3,311 (3,266 pass, 0 fail, 45 skip);
backend Docker suite 1,994 (1,962 pass, 0 fail, 32 skip; `backend-ceqXFF`). Frontend, runner and
events suites were not rerun (no changes in those paths since `52e007d`).

## Candidate h7hpw4

Built from baseline tZgvV7 at clean `4bd54bf`, build sequence `1791433118000`,
`--adapter-isolation xpc-required` (`pre-release-candidate/build-vhkAig`); codesign (ad-hoc) verifies.
Not signed, notarized or released.

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks | `pre-release-final/product-5RY1Oz` |
| Packaged job races | **PASS**, 8 | `job-race/product-v5ynKu` |
| Packaged security probe | COMPLETE: fuses (xpc-required), node modes and renderer CSP PASS | `security-internal-review/packaged-bH6316` |
| Medium / large smoke | see below | |

## G-PERF smoke

Quiet-machine wait (1-minute load < 4, three checks 30 s apart, `mdworker_shared` ≤ 6) under
`caffeinate`, AC power, native lock; no host sleep overlapped (`pmset -g log`). Smoke runs are
single observations, not series results (`assessment: null`); limits are the 05 §4 p95 targets.

### wFroXK

| Run | Result | Evidence |
| --- | --- | --- |
| medium `--smoke-2` (started at load 1.97 with 10 `mdworker_shared`) | **FAIL**, both runs: TS_PARSING failed after ~2.6 s at 20%, `failureCode` null. The 9lVRha heap exhaustion is gone (SOURCE_PARSING 72.7 s, GRAPH_BUILD 5.3 s, peak RSS ≤ 2,160,944 KiB) | `workload-performance/run-etYDCC` |
| medium `--smoke-1 --keep-work` | FAIL, same step: `ts-analyzer rejected input without a recognized diagnostic` at `TsAnalyzerControlClient.accept`; root cause and fix in w11-ts-xpc | `run-GWEbC7`, `run-GWEbC7-profile-logs` |
| large | NOT RUN (same TS path) | `stage5-wFroXK/timing-summary.txt` |

### h7hpw4 (`--smoke-2`, both classes complete end to end)

| Observation | medium run 1 / 2 | Limit | large run 1 / 2 | Limit |
| --- | --- | --- | --- | --- |
| Analysis, approve → overview | 140,745 / **200,871 ms** | 180,000 ms | **643,383 / 645,141 ms** | 600,000 ms |
| Peak owner-tree RSS, analysis | 2,706,016 / 2,613,056 KiB | 4,194,304 KiB | 4,410,192 / 4,534,032 KiB | 6,291,456 KiB |
| Preview complete / first response | 4,591 / 4,687 ms; 1 ms | 10,000 / 500 ms | 19,438 / 18,875 ms; 1 ms | — |
| Graph search / node page / relations API | 108–167 / 46–72 / 7–50 ms | 500 ms | not assessed | — |
| First graph page render | 11 / 9 ms | 2,000 ms | 21 / 20 ms | — |
| 1% refresh | **185,738 / 183,732 ms** | 30,000 ms | 801,593 / 803,433 ms | — |
| Peak RSS during refresh | 3,076,176 / 3,038,624 KiB | — | 4,892,864 / 4,653,024 KiB | — |
| Cancel → lock release | 223 / 227 ms | 5,000 ms | 118 / 116 ms | — |

Evidence: medium `workload-performance/run-Rr1JmK` (started at load 3.84), large `run-63Hygy`
(started at load 2.43).

- Step times, medium: IMPORT 24 s, SOURCE_PARSING 74 s, GRAPH_BUILD 5 s, TS_PARSING 30 s (run 1)
  and 90 s (run 2; the only step that differed). Large: IMPORT 114 s, SOURCE_PARSING 335 s,
  GRAPH_BUILD 19 s, TS_PARSING 138 s, all other steps ≤ 11 s, both runs within 2 s of each other.
- **Refresh is a full re-analysis** (High, open): a 1% change repeats IMPORT (medium 56 s, large
  286 s), SOURCE_PARSING and TS_PARSING over every file. Medium refresh is six times its 30 s target.
  This needs incremental import/parsing, which is outside this wave.
- Large analysis exceeds 600 s by about 7%; SOURCE_PARSING (335 s, Java) and IMPORT (114 s) dominate.
- The UI-acknowledgement metric is again negative (−21 to −12 ms), the runner timing defect noted
  for 9lVRha; not counted as evidence.

## Remaining conditions

- G-PERF: refresh is a full re-analysis (High); large analysis ~7% over 600 s and medium run 2 over
  180 s (smoke observations); twenty-run series per class on the final candidate on a quiet machine;
  R11 quotas; negative UI-acknowledgement metric (runner).
- Other desktop tests with loopback fixture servers may count foreign probes too (w12 audited one file).
- Transport failures (analyzer crash, timeouts) still end jobs with a null `failureCode`; main's
  10 min limit now covers a whole analyzer session (w11 limits).
- G-SEC: Developer ID path and C15 OS denial with a signed helper; independent review.
- G-UPDATE: release key, update host and Team ID (O2).
- G-JOB / G-RECOVERY: power loss, real profile, older binary.
- G-ACCURACY: independent annotations and blind review. G-UX: eight-participant study and VoiceOver.
- Stage 7: counsel decisions; licence texts not available offline.
- `packaged-keychain-acceptance` (now picker-based): NOT RUN, uses the real Keychain; a human run is
  required.

Overall release: **NO_GO**.
