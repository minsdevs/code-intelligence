# Physical runtime metadata and desktop control follow-up — 2026-10-06

This continues the original checkout after PR98 (`d225f56`). It preserves the
previous startup failures and performance measurements, adds diagnostics at the
initial integrity boundary, reduces bounded reader/control-JVM overhead, and
replaces callback-backed physical metadata reads after reproducing stat reentry.
Formal release remains **NO_GO**. Functional validation, measured performance,
and independent release acceptance are separate claims.

## Selected implementation

The candidate selected for final validation is
`.native-product-tZgvV7/Code Intelligence Validation.app`, build sequence
`1791264249607`, built from clean product inputs at implementation commit
`69c2ad8d38c950f543dceca0aa94dd2b28c1b6ce`. Its backend keeps
`-Xms64m -Xmx2048m` and the default collector/
compiler policy. Non-Windows lease and process-guardian JVMs additionally use
`-XX:+UseSerialGC -XX:TieredStopAtLevel=1` with their existing16/64MiB heap budget.
The backend never receives the control worker's SerialGC flag. Windows native
helpers, process ownership, framed bootstrap, service order and shutdown policy
are unchanged. These are measured settings, not a proven global optimum.

Runtime inventory hashing uses one64KiB buffer per verification invocation,
reused sequentially across files. Concurrent invocations have separate buffers.
Reads stop at the initially verified size and perform one extra byte read to
require EOF. Truncation, growth, invalid read counts, wrong hashes, changed file
identity and unexpected entries still reject the runtime. No-follow opens,
single-link/type/size limits, handle/path stamps and first-error-over-close
precedence remain enforced. This is a bounded allocation/read-budget change;
it does not establish the cause of older MANIFEST failures.

Initial verification can now emit one fixed operation/code/kind record before
its public error is normalized. Observer exceptions, rejected promises and
mutations of the original error cannot replace the already captured public
failure. Diagnostic getters are sampled once and arbitrary text, paths, stack
traces or credentials are not emitted. The initial manifest-file read/JSON
prelude remains outside the per-file operation observer.

## Measurement correction

Three earlier diagnostic series were incomplete because a whole-host RSS query
stalled: the longest observed reads were909/987/1605ms and the corresponding
gaps983/1029/1681ms. These are collector observations, not proven application
startup failures. Their original FAIL/NOT_RUN rows remain intact.

The collector now discovers the host's PID/PPID topology, then requests RSS only
for the captured app owner's observed descendants. It rejects unexpected or
malformed returned identities and filters reparented rows through the final
owner closure. No process is signalled or adopted from a numeric PID. The two
queries are not atomic; a child born between them can be absent from one sample.

The100ms target and250ms maximum interval are unchanged. A read is classified
by the phase in which it began, so a startup read cannot be miscounted as idle.
The gap from the last completed observation to the stop boundary also counts;
an unfinished final read cannot hide that gap. At least20 idle samples and
confirmed normal cleanup are still required. Twenty complete measured runs are
needed before p95 is calculated; failed or unexecuted runs are not discarded.
Idle acceptance uses the maximum observed idle peak, not just its p95.

Power is recorded at the start of the series and both boundaries of every run.
Unknown or battery observations prevent AC acceptance. These observations do
not establish uninterrupted AC power between the boundaries. The initial SDK
capture interval and unsampled short-lived processes remain measurement limits.

## Diagnostic experiment and rejected setting

All paths here are relative to `validation/local/`. Diagnostic probes initialize
one fresh synthetic profile and then perform three warm starts. They do not
replace a twenty-run acceptance series or a real-user workload benchmark.

| Evidence | Candidate | Result and interpretation |
| --- | --- | --- |
| `startup-probe/run-osBps8` | qnGyCP: initial diagnostics, old reader/control policy | Warmup and one warm run passed; next run failed sampling and the last was NOT_RUN. |
| `pre-release-final/integrity-Fc4Q6S` | qnGyCP |20 read-only inventory repetitions passed inside one Electron process. Not20 app restarts; no older failure was reproduced. |
| `startup-probe/run-lAuN9a` | jZxj1d: bounded reader/control tuning | Warmup and one warm run passed; next run failed sampling and the last was NOT_RUN. |
| `startup-probe/run-VcdVde` | w58egd: additional backend C1-only experiment | Warmup failed sampling; all three warm runs remained NOT_RUN. |
| `startup-probe/run-BbUJSx` | jZxj1d, targeted collector | Three warm starts11,478/11,545/11,859ms; sampled idle peaks1,783,248/1,786,720/1,797,312KiB. All run boundaries observed AC; normal cleanup confirmed. |
| `startup-probe/run-hZs3YF` | w58egd, same targeted collector | Three warm starts14,503/14,320/14,059ms; sampled idle peaks1,674,416/1,669,216/1,671,920KiB. AC boundaries and cleanup confirmed. |
| `startup-probe/run-HQCIEx` | w58egd, additional retained diagnostic | Three warm starts14,078/14,199/14,058ms; all normal cleanup confirmed. |

The extra backend `-XX:TieredStopAtLevel=1` reduced sampled memory but consistently
slowed startup in these short diagnostics, especially the backend phase. It was
removed from the working implementation before final validation. Candidate
w58egd and its logs remain an explicitly rejected experiment; it was not adopted
or advertised as meeting performance goals. This is not a broad throughput
comparison or a universal claim about that JVM option.

## Executed regression checks

The initial diagnostic changes passed169 checks. Bounded reading and control JVM
changes passed308 checks with one existing guardian-loss test deliberately
quarantined. A later role-name-only probe correction passed its seven focused
tests. The collector, phase/trailing-gap handling, power boundaries and fixed
assessment passed38 focused checks. Backend-C1's74 harness checks belong to that
experiment, not to a decision to adopt it. Overlapping suites are not added into
a unique-test total. Raw logs and source fingerprints remain in each result.

## Earlier candidate checkpoint: jZxj1d

`pre-release-candidate/build-EDuNiC` verifies750 Java classes,27 migrations,
120 frontend static entries,30 analyzer outputs and44 desktop sources. Native
runtime/JRE/dependency supply was verified and reused; no native source rebuild
or public signing occurred.

| Content | SHA-256 |
| --- | --- |
| app.asar | `9b37e8b46a0cd0ddbec947bfe4b077cb57cf4ab48eac4701ad0312516a886bfe` |
| runtime manifest | `02a4b253d66adf464541e9c9855871d18139ed19706980e1d6cb74595c38f737` |
| backend JAR | `bd20db8f69443eca950ff7b886454658548bf5ccb6b40ae807148c009858bbee` |

The subsequent `pre-release-final/product-m8tDF3` recorded 36 passing checks and
six COMPLETE/code0 exits. `electron-crash/native-OA0rMU` passed the source-rename
crash boundary, while `native-OCe8PY` failed at MANIFEST / READDIR / ENOTDIR before
injecting the completed-restore crash. `startup-performance/run-Icavwg` completed
twenty operational rows with AC observed at the run boundaries: warm p95 13,382ms,
idle p95 1,805,616KiB and maximum 1,809,968KiB. Both SLOs failed. Its separate
report also ends with `STARTUP_BENCHMARK_CHECK_FAILED` and has no successful
`sourceAndBundleUnchanged` assertion; diagnostic source changed during that series.
It is not an unchanged-source acceptance result. These observations
are retained history, not acceptance of the newer candidate.

## Standalone control package

Commit `dac77cc` adds a minimal dispatcher for the two existing Java worker
implementations. The algorithms, stdin/stdout framing, lock ownership, bootstrap
zeroing, child lifetime and shutdown rules are unchanged. Only a verified
`controlProtocol: 1` manifest selects the small JAR for non-Windows lease and
guardian processes. The analysis backend and backup-source worker continue to use
the full backend JAR. A missing or invalid advertised control package is rejected
before credentials or helpers; an older manifest retains its earlier entrypoint.

The actual control JAR is 2,639,417 bytes with six own compiled classes, the three
reviewed Jackson dependencies and nine namespaced license/notice files. The
producer verifies own-class set/bytes, manifest, license bytes and provenance;
the independent static verifier checks bounded ZIP structure/CRC, permitted
class namespaces, own-class identity and dependency/license declarations.
Multi-Release metadata is preserved, duplicate entries fail, and provenance is
a declared Gradle output. Neither verifier proves every shaded dependency member
byte-for-byte against its original source archive; this is not a full SBOM or
license-obligation audit.

`control-runtime/verify-ZLtwSG` contains Java 3/3 and Node 193/193 passing results.
`startup-root-cause/control-final-unit-1wCTyr` contains 355 PASS and one existing
guardian-loss quarantine, with no failed tests. Their scopes overlap.
`control-runtime/actual-i7b9jy` executes the generated JAR against three bounded
error inputs and confirms the expected exit2/fixed replies; it does not by itself
prove normal service ownership or recovery.

The recovered first control candidate kcuxVJ passed full functionality in
`pre-release-final/product-XcwogG` (36 checks, six COMPLETE/code0 exits), and the
source-rename crash in `electron-crash/native-FijAIv` (six checks). Its next fresh
launch, `native-nBHbN7`, failed before crash injection. Both results remain intact.

## Reproduced metadata reentry and narrow correction

The kcuxVJ failure recorded `READDIR ENOTDIR` with a preceding DIRECTORY result
and a failure-time FILE result. The relative-path digest matches the packaged
`backend/backup-migrations/V27__file_analysis_outcomes.sql`, a 993-byte ordinary
file whose content still matches the unchanged runtime manifest. This narrows
the observation; it does not establish an actual filesystem replacement.

An isolated synthetic Node probe, `startup-root-cause/stat-reentrancy-t6mkkF`,
then used an async `before` hook to perform a synchronous directory stat while a
callback-backed file stat completed. The promisified callback returned DIRECTORY
for unchanged regular-file bytes; native promise stat returned FILE.

The same controlled mechanism was exercised inside the actual retained Electron
44.4.5 / Node24.21.0 process in `startup-root-cause/electron-stat-aa230e`:

| API under targeted synchronous-stat reentry | FILE results | DIRECTORY results |
| --- | ---: | ---: |
| Electron `fs.promises.lstat` | 0/20 | 20/20 |
| `original-fs.promises.lstat` | 20/20 | 0/20 |
| Promisified `original-fs.lstat` callback | 0/20 | 20/20 |

The hook was armed only around the probe requests, not arbitrary application
requests. Synthetic bytes and candidate identities were unchanged, and normal
cleanup was confirmed. These are 20 metadata probes per API, not 20 app restarts.

The versioned Electron source wraps `fs.promises.lstat` in `util.promisify`;
Node's callback implementation fills its global stat array before entering the
callback. This is consistent with the reproduced reentry mechanism. The original
field failure was not traced inside that callback, so attribution of every
historical MANIFEST/ENOTDIR failure remains unconfirmed.

Commit `69c2ad8` selects Electron's built-in `original-fs` **only for the physical
runtime inventory validator**. Every stat/read/open and failure-time observation
in that validator uses the same selected namespace. Ordinary Node uses `node:fs`;
Electron has no silent fallback. No ASAR toggle, retry, threshold relaxation,
file-type downgrade, hash bypass or global filesystem replacement is introduced.
The diagnostic runner observes both namespaces and restores its temporary wrappers.

The final targeted regression result is 198/198 PASS in
`startup-root-cause/native-stat-final-8j7cc0`. An earlier aggregation attempt
`native-stat-unit-RrMcGE` recorded FAIL because it expected TAP but received the
spec reporter; the actual test process exited0 with 195 passing tests. Its raw
log and original aggregation failure were retained, and the final command
explicitly selected TAP after the additional injection tests were added.

Primary API/source references: [Electron original-fs documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file),
[Electron44.4.5 ASAR wrapper](https://github.com/electron/electron/blob/v44.4.5/lib/node/asar-fs-wrapper.ts),
and [Node24.21.0 FSReqCallback source](https://github.com/nodejs/node/blob/v24.21.0/src/node_file.cc).

## Current candidate and execution checkpoint

`pre-release-candidate/build-HNZIX8` rebuilt and read back 751 Java classes,
27 migrations,120 static entries,30 analyzer outputs and44 desktop sources.
The control JAR and backend JAR bytes are unchanged from kcuxVJ; only the desktop
inventory implementation changed. Native/JRE supply is verified reuse, not a
fresh native rebuild. The earlier apps and raw evidence are preserved.

| Content | SHA-256 |
| --- | --- |
| app.asar | `448d246faecb0efc2a648a9c9d3a1026f7e3657af1261519f6713889d5f70899` |
| runtime manifest | `9a0dc937af6891df7acb4af681cd8e7ea482e88d50426c8a147202199538e7f7` |
| backend JAR | `ca9afe0ac14f1e306bee71d4e8de5a6eb3f58dd8cafc3f7d4257f9430a99add5` |
| control JAR | `70b516885b3c50487cf1937022975b616c99ec176a5632ee3bf9e032946b15b0` |
| control provenance | `24fc8ec1be3a7f5475b2b630e9a566c433f64f606714dffc4cf867e2ad03882e` |

The final results below all belong to tZgvV7. The complete raw-result hashes,
candidate identities, source fingerprints and twenty measured rows are recorded
in [the companion verification ledger](startup-resource-follow-up-2026-10-06.json).
No pass was borrowed from kcuxVJ or jZxj1d.

| Executed validation | Actual result | Evidence relative to `validation/local/` |
| --- | --- | --- |
| Repeated runtime inventory inside one Electron process | 20 validations PASS, no failures/traces, artifact identities unchanged | `pre-release-final/integrity-QSGvEF` |
| Full packaged functionality | 36 recorded checks PASS, no omitted suites, six COMPLETE/natural code0 exits | `pre-release-final/product-1o93Vn` |
| Source-rename owner crash | Six checks PASS, one intentional Electron SIGKILL and two COMPLETE/code0 exits | `electron-crash/native-TOh48T` |
| Completed-restore owner crash | Six checks PASS, one intentional Electron SIGKILL and two COMPLETE/code0 exits | `electron-crash/native-P1tItq` |
| Twenty warm restarts and idle measurement | All20 operational rows complete; **both SLOs FAIL** | `startup-performance/run-oAD8MS` |
| Static component inventory | Written with explicit limitations; `completeSbom: false` | `pre-release-final/inventory-physical-runtime-20261006.json` |

The warm-start p95 is **12,544ms**, exceeding10,000ms. Idle RSS p95 is
**1,741,728KiB** and its maximum is **1,745,680KiB**, exceeding the1,572,864KiB
ceiling. All20 rows have confirmed cleanup and complete sampling, at least29 idle
observations and a largest observed gap of221.047ms. AC was observed at the series
start and every run boundary; this is not continuous power telemetry. The source
and candidate fingerprints remained unchanged. No integrity failure was recorded
in this series. The command nevertheless exits1 because both performance limits
were exceeded. Operational success is not performance acceptance.

Both recovered screenshots were visually inspected: the interrupted source-rename
case displays snapshot2/source `return 92`; the committed-restore case displays
snapshot1/source `return 91`. Folder authorization must be renewed. These images
corroborate the automated source/snapshot checks, not broad usability or native
file-picker acceptance. Neither case combines nonzero provider-cost obligations
with source recovery or simulates power loss.

The representative repository scenario accepted894 files/8,122,142bytes and reached
the overview in62,045ms, with108 entrypoints and102 flows. This is one filtered
source input, not the independent1k/10k/50k workload matrix or a precision/recall
claim. Outcomes retain87 UNMEASURED,641 PARTIAL,165 SUCCESS and one UNSUPPORTED file.

The final offline inventory does not certify all shaded control-JAR members,
native/JRE/browser provenance or full license obligations. No new online advisory
scan is claimed. The final read-back verified all raw-result references, current
product inputs and the candidate's existing ad-hoc signature. Developer ID signing,
notarization and public release remain outside this execution.

## Remaining release acceptance

Historical MANIFEST startup failures still have unconfirmed causes. A successful
new run or more specific diagnostics does not retrospectively fix an old failure.
The final twenty-run series still exceeds the10s startup and1.5GiB idle goals.
Real-account import/refresh/revoke/SSO, existing-user data compatibility, complete
crash/power-loss coverage, independent corpus/security/user-task acceptance,
clean-machine/minimum-OS/signed updates, complete SBOM/license obligations and
operational support decisions remain distinct release requirements.

No actual user profile, Keychain or private key is used as test data. No paid
provider, Actions dispatch, Developer ID signing, notarization or public app
release is part of this unit. Repository publication uses `[skip ci]` commits
and merge messages, and the app/raw private validation directories remain local.
