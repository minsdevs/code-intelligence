# Desktop JVM budgets and measured startup limits — 2026-10-06

## Current conclusion

The desktop JVM heaps are bounded and candidate **XIWb8X** passes the default
36-check native functional sequence with six normal COMPLETE/code0 exits.
**The performance and complete release verdict remain NO_GO.** Both completed
twenty-run series exceed the startup and idle-memory targets. An earlier
new-candidate series was incomplete because its sampling gap exceeded the fixed limit. A separate
fresh launch failed manifest verification before any crash test ran. These
failures are preserved and cannot be erased by later successful runs.

The work follows merged PR97 (`c2fcd20`), which verified two actual Electron
SIGKILL/recovery boundaries on the unchanged j5EJLB app. That older crash proof
is separate from the new JVM-budget candidate. Current implementation commit is
`a5f91ad`; exact full identities and final run results are in the companion JSON.

## Product change and limits

The previous backend launch selected `-XX:MaxRAMPercentage=55`, while the separate
Java lease and process-guardian workers had no explicit heap budget. These are
replaced by role-specific immutable options:

| Role | New JVM options |
| --- | --- |
| Backend analysis service | `-Xms64m -Xmx2048m` |
| Non-Windows lease/process control workers | `-Xms16m -Xmx64m` |

The backend retains analysis headroom rather than being sized only for the empty
profile benchmark. The fixed helper flags precede `-jar` and never enter the
target's framed command or bootstrap data. Windows native helper launch, pinned
JAR identity, environment filtering, locks, child ownership and STOP/EXIT protocols
are unchanged. No garbage collector, service ordering, Node analyzer limit,
backend/frontend/analyzer implementation, dependency version or schema changed.

These are **Java heap** limits, not complete process-RSS limits or proof that the
chosen values are optimal for every supported repository. Native memory, class
metadata and all the app's other processes still contribute to measured RSS.
No actual `PrintFlagsFinal` output or in-process heap telemetry was obtained;
the optional diagnostic command was rejected before execution and not worked around.

## Measurement contract

`run-startup-benchmark.cjs --app '<retained candidate>' --warm-startup-20` creates
one fresh private automation claim. An initialization launch is recorded outside
the twenty measured restarts of the same empty synthetic profile. OS caches are
not flushed, so initialization is not labeled a cold-cache measurement.

Timing begins before the SDK launch and ends only when the actual home UI,
packaged identity, AI-off state and four runtime services are verified. The
three-second idle window then samples RSS of the captured owner's observed
PID/PPID descendants. The target interval is100ms; actual gaps and the initial
unsampled SDK-capture interval are reported. RSS is a sampled sum, not continuous
peak or private-memory accounting. Numeric PIDs never authorize a signal.

The local raw CSV is bounded to64MiB for the series and2,000 samples per launch.
A complete sample requires positive measurements, at least20 idle observations,
no gap above250ms, and verified cleanup. Every ordinary close requires the actual
SDK-owned process's code0 plus a drained COMPLETE diagnostic stream, followed by
read-only disappearance of the sampled PIDs. No inferred cleanup on SDK failure.

Any operational/sampling/cleanup failure ends that series. Remaining rows stay
`NOT_RUN`; p95 is null rather than recalculated from successful survivors. A
completed series uses nearest-rank p95 for warm startup≤10s. The1.5GiB idle target
is a ceiling for **every** measured idle peak. Its p95 is also reported, but does
not permit one large outlier. The first baseline used the earlier p95-only RSS
assessment; its raw report is retained and a separate stricter recomputation is
recorded in the final audit. All its samples exceeded the limit in either version.

All three measured series observed **BATTERY** power, not the specified AC condition.
Consequently they cannot certify AC-qualified performance. A failing SLO is kept
separate from a functioning app or a successfully completed measurement series.

## Executed results

Paths below are relative to `validation/local/`.

| Check | Actual result | Evidence |
| --- | --- | --- |
| Initial measurement contracts | 31/31 PASS | `startup-performance/unit-9Jsp9E` |
| Bounded CSV/sample contracts | 33/33 PASS | `startup-performance/unit-final-J8yD1z` |
| JVM launch, real lease and validation contracts | 229 PASS,1 deliberate SKIP,0 FAIL | `startup-performance/jvm-unit-AgDoBN`; includes the stricter single-outlier RSS test. |
| Old j5EJLB warm series | 20/20 operationally complete; **SLO FAIL** | `startup-performance/run-v78dTZ`: warm p95 13,871ms, idle p95 2,454,624KiB, idle maximum 2,470,048KiB. |
| First XIWb8X warm series | **INCOMPLETE/FAIL**,1 failed measured row and19 NOT_RUN | `startup-performance/run-hDxpEp`: first ready12,150ms, idle2,013,856KiB, maximum sample gap741.329ms; p95 unavailable. |
| Second XIWb8X warm series | 20/20 operationally complete; **SLO FAIL** | `startup-performance/run-djPGa1`: warm p95 14,106ms, idle p95 2,028,624KiB, idle maximum 2,030,576KiB. |
| XIWb8X full native product sequence | **36 recorded checks PASS**,6 COMPLETE/code0 exits | `pre-release-final/product-6R5ZA0` |
| XIWb8X crash-preparation launch | **FAIL before injection**,0 checks, no SIGKILL executed | `electron-crash/native-RCWx2I`: MANIFEST / `RUNTIME_INTEGRITY_FAILED`. |
| Follow-up integrity diagnostic | **FAIL**, no inventory-loop result returned | `pre-release-final/integrity-eTStZi`: startup MANIFEST failure; candidate identity unchanged. |
| XIWb8X completed-restore crash | **6 checks PASS**,1 intentional SIGKILL and2 COMPLETE/code0 exits | `electron-crash/native-2kMxcZ`: restored snapshot1/source91/note preserved. |
| XIWb8X source-rename crash | **6 checks PASS**,1 intentional SIGKILL and2 COMPLETE/code0 exits | `electron-crash/native-5HgJxa`: previous snapshot2/source92/note preserved. Separate fresh attempt after the initial pre-injection failure. |

The quarantined real Java guardian-loss test remains skipped because its cleanup
contract is unverified. It was not enabled or counted as a pass. Counts across
these suites overlap and cannot be added into a unique-test total.

The incomplete series'741ms gap remains a measurement failure rather than being
deleted or accepted by loosening the limit. A separate same-candidate series with
unchanged criteria then completed twenty rows. Across the two completed series,
the observed maximum idle RSS fell from2,470,048 to2,030,576KiB, while warm p95 rose
from13,871 to14,106ms. These are sequential battery-powered measurements on one
host, not randomized paired evidence of a universal improvement. Both metrics
still miss their acceptance thresholds. No failed row was removed from a series.

The full native sequence imported892 filtered files/8,072,629 bytes in63,837ms,
verified108 entrypoints and102 flows, followed a five-step flow to snapshot source,
and exercised reanalysis, backup/restore, old-authority rejection, deletion and
restart. These are one-input functional observations, not the1k/10k/50k benchmark
fixtures or an independent precision/recall claim. The36 recorded checks include
repeated startup checks.

Both crash cases were executed again with the new JVM budgets, rather than
inheriting j5EJLB's earlier results. The successful later source-rename case does
not rewrite `native-RCWx2I` or prove its startup failure's cause. None of these
cases combines nonzero provider-cost obligations with source recovery.

## Remaining startup failure

`native-RCWx2I` failed in MANIFEST before helpers or the backend were launched.
The JVM flags are applied later, so that ordering does not establish them as the
cause. The validator maps an unrecognized original exception to a fixed public
`RUNTIME_INTEGRITY_FAILED` code. The current read-only diagnostic attaches its
filesystem observer through the SDK after launch; when startup fails that early,
its evaluate call can fail before returning the inventory trace. The absent
inventory field is not20 successful or failed validations.

No file hash, signature, source boundary or startup guard was bypassed. The exact
lower-level exception and its relationship to older intermittent failures remain
**unconfirmed**. Later healthy starts do not resolve that cause. Startup stability
remains a release blocker even when the broader functional scenario passes.

## Candidate and next acceptance requirements

```text
app                  .native-product-XIWb8X/Code Intelligence Validation.app
buildSequence        1791254132380
app.asar SHA-256      4c71f0990f57dba2d04bc1b82aed553e2f105ec27db6044d93c62eca54bad907
runtime manifest     24a471f27ad20e3c3559213aa4c2164e5df29ed47e706247db714109a486db0c
backend JAR          bd20db8f69443eca950ff7b886454658548bf5ccb6b40ae807148c009858bbee
```

Build evidence is `pre-release-candidate/build-hWKnC2`:750 classes,27 migrations,
120 static entries,30 analyzer files and44 desktop source files read back. The
old app is preserved. Native/JRE supply is reused after validation, not rebuilt.
This development candidate is not an automatic replacement for a user installation.

The new offline component inventory is
`pre-release-final/inventory-startup-20261006.json`. Its276 resolved query
coordinates and single excluded JAR match the prior candidate's exact query set;
the backend JAR and dependency inputs are unchanged. The prior public advisory
query remains a dated result, not a new online scan of this build. Full SBOM,
license, native/JRE/Electron/browser and reachability acceptance remain incomplete.

Stage5 still needs acceptable startup/idle measurements under the required
environment plus workload-specific performance, security and user-task evidence.
Stage1 still needs the remaining crash/power-loss and combined nonzero-cost/source
matrix. Real-account import/refresh/revoke/SSO, existing user-data application,
fresh-machine/minimum-OS/signed update, complete SBOM/license and operational
release requirements remain open. No Actions, real-user credentials/profile,
paid provider, Developer ID signing, notarization or public release is requested.
