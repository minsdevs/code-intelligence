# Medium/large time fixes and candidate wFroXK — 2026-10-08

After candidate 9lVRha (medium class backend OOM, large class not run), units w7-medium, w8-graph,
w9-keychain, w9-deps and w10-restart were verified and merged into `codex/perf-medium-20261008`.
The coordinator ran the full regression suites and built candidate **wFroXK** from clean `25ab8b1`
(`adapterIsolation=xpc-required`). wFroXK passes the 36-check product sequence, both owner-crash
boundaries, the packaged job races, the security probe, the UX pilot and the SBOM checks. The
medium/large packaged smoke results are in [G-PERF smoke](#g-perf-smoke). Formal release remains
**NO_GO**.

Commands, identities and raw-result hashes are in the [companion ledger](candidate-wfroxk-2026-10-08.json).

## Decisions recorded by the user (2026-10-08)

| Item | Decision |
| --- | --- |
| SEC-M-02 / `packaged-keychain-acceptance` | Import through the product folder picker (no drop, no confirmation dialog); the drop confirmation stays covered by the product sequence and the security probe |
| Dependabot #49–#52 | Update lockfiles only to the patched versions; `package.json` ranges unchanged |
| Verification scope | Risk-based per candidate: full regressions plus the packaged checks the changes touch, medium/large smoke (`--smoke-2`) and SBOM. Twenty-run gates (warm startup, small/medium/large series) run once, on the final release candidate on a quiet machine |

Because of the last decision, checks not rerun on wFroXK are recorded as **NOT RUN**, not as
carried over: warm-startup twenty runs, G-PERF small/medium/large `--series-20`, G-COST packaged
probe and PK-08 ask, accuracy packaged export, native preflight/recovery matrix, import-evidence
native, adapter-isolation stage. Their last results stay those of 9lVRha (not the shipped bytes
of wFroXK).

## Units

| Unit | Audit | Change | Verified by the coordinator |
| --- | --- | --- | --- |
| w7-medium | [medium-oom](medium-oom-2026-10-08.md) | JavaAnalyzer passes and bounded symbol-solver caches (medium heap), TS session timeout | merged before this wave (`dba2557`); backend Docker suite below |
| w8-graph | [medium-large-time](medium-large-time-2026-10-08.md) | Custom plans for key-list lookups, linear feature linking and seed overlap, batched link/flow/evidence/commit persistence, Java parse-ahead and concurrent analyzers, TS single walk and line index, full ids in scanner patch headers | ts-analyzer 296/296; backend Docker 1,960 pass / 0 fail; product sequence, job races and smoke on wFroXK |
| w9-keychain | [keychain-acceptance-picker](keychain-acceptance-picker-2026-10-08.md) | Runner only: shared folder-picker helper; real-Keychain runner imports through the picker and refuses any message box | runner tests 414/414; UX pilot on wFroXK (uses the shared helper) |
| w9-deps | [dependabot-lockfiles](dependabot-lockfiles-2026-10-08.md) | Lockfiles: proxy-addr 2.0.8 (tree-analyzer), source-map-js 1.2.2 (tree-analyzer, ts-analyzer, frontend); offline cache entries added | `npm ls` in the build checkout; shipped ts-analyzer in `AdapterSupervisor.xpc` has proxy-addr 2.0.8; SBOM below |
| w10-restart | [restart-shutdown-hang](restart-shutdown-hang-2026-10-08.md) | none (finding only) | job-race rerun on wFroXK, below |

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

## G-PERF smoke

Quiet-machine wait (1-minute load < 4, three checks 30 s apart) under `caffeinate`, AC power, native
lock. The medium run started at load 1.97 with 10 `mdworker_shared` processes still active
(Spotlight re-indexing evidence directories), above the script's ≤ 6 target at that moment.

| Run | Result | Evidence |
| --- | --- | --- |
| medium `--smoke-2` | **FAIL**, both runs: TS_PARSING failed after ~2.6 s at 20%, job `FAILED` with `failureCode` null. The 9lVRha heap exhaustion is gone: IMPORT 23.7 s, SOURCE_PARSING 72.7 s, GRAPH_BUILD 5.3 s, peak owner-tree RSS 2,160,944 / 2,123,728 KiB (limit 4,194,304) | `workload-performance/run-etYDCC` |
| medium `--smoke-1 --keep-work` (diagnosis) | FAIL, same step; backend: `TsAnalyzerException: ts-analyzer rejected input without a recognized diagnostic` at `TsAnalyzerControlClient.accept` (isolated XPC path) | `workload-performance/run-GWEbC7`, profile logs `run-GWEbC7-profile-logs` |
| large `--smoke-2` | NOT RUN: stopped after the medium failure (same TS path) | `stage5-wFroXK/timing-summary.txt` |

The w8 harness analyzed the same medium and large workloads with the local TS analyzer over HTTP,
so the failure is specific to the isolated control path or to how the packaged worker handles the
medium requests. Unit w11-ts-xpc: see [ts-xpc-medium](ts-xpc-medium-2026-10-08.md).

## Remaining conditions

- G-PERF: twenty-run series per class on the final candidate on a quiet machine; R11 quotas.
- Flaky desktop test above (Low).
- G-SEC: Developer ID path and C15 OS denial with a signed helper; independent review.
- G-UPDATE: release key, update host and Team ID (O2).
- G-JOB / G-RECOVERY: power loss, real profile, older binary.
- G-ACCURACY: independent annotations and blind review. G-UX: eight-participant study and VoiceOver.
- Stage 7: counsel decisions; licence texts not available offline.
- `packaged-keychain-acceptance` (now picker-based): NOT RUN, uses the real Keychain; a human run is
  required.

Overall release: **NO_GO**.
