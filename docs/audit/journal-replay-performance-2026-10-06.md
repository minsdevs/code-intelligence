# Journal reopen cost and POSIX lease metadata waits — 2026-10-06

This continues PR100 without repeating its 194-test phase-marker suite or the
older full-app acceptance runs. New work measures the history-dependent journal
open path and overlaps independent POSIX metadata reads. The product change is
`85f889e`; no new app has been packaged. Formal release remains **NO_GO**.

Exact source, supply and raw-result identities are recorded in the
[companion ledger](journal-replay-performance-2026-10-06.json).

## New measurement

`run-journal-replay-probe.cjs` uses current Node journal/keyring modules and the
verified tZgvV7 candidate's unchanged JRE/control JAR. Each history is newly
created through public journal operations: one GENESIS record followed by
USER_OFF records, with 1, 65 or 257 records in total. Keyring initialization and
history creation are outside the timed journal open. The keyring remains open,
as it does before the gateway opens its journal. Each case reopens once and must
preserve the old log prefix while appending exactly one restart record.

The harness uses actual native Java lease workers and a public synthetic
authenticated wrapper. It does not start Electron, PostgreSQL, Redis, a provider
or an existing user profile. Every case closes its journal, keyring and provider,
then requires three actual helper close events with code0 and no signal. All nine
helpers in each diagnostic exited normally; no forced stop was used. AI stayed
OFF, transferred key copies were cleared and previous journal bytes were kept.

| Initial records | Before open | After open | Before MAC-key lookup time | After MAC-key lookup time | MAC-key lookups | Keyring CHECK commands |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 153.014ms | 155.834ms | 16.941ms | 16.306ms | 5 | 14 |
| 65 | 343.159ms | 318.829ms | 203.189ms | 177.002ms | 69 | 142 |
| 257 | 948.983ms | 784.364ms | 789.820ms | 640.735ms | 261 | 526 |

Before evidence is `validation/local/journal-replay/probe-KjaeIG/result.json`;
after evidence is `validation/local/journal-replay/probe-ptGfUk/result.json`.
Both are COMPLETE_DIAGNOSTIC, with identical runner bytes and four tracked supply
identities: runtime manifest, ASAR, Java executable and control JAR. Each run
validates the runtime inventory and ad-hoc signature before execution, then
rechecks these four identities afterward. A final full-runtime inventory scan is
not claimed. The two runs have distinct recorded product-source fingerprints.

The 257-record observation is 164.619ms, or 17.35%, lower; the 65-record
observation is 24.330ms lower. The one-record observation is 2.819ms higher.
These are single, sequential observations on different fresh synthetic histories,
not a randomized comparison, a p95 benchmark or a universal improvement claim.
There is no new whole-app startup or RSS result.

For N initial records, both implementations measured `getMacKey=N+4`,
`currentKeyId=2`, wrapper availability checks `N+6`, and keyring lease CHECK
commands `2(N+6)`. The journal lease itself issued eight CHECK commands per open.
This confirms history-dependent key-validation work in this scenario. It does
not retrospectively prove that this path caused all earlier gateway delays.

## Product change

In `desktop/src/native-owner-locks.cjs`, POSIX `verifyPath` now starts its root
directory, role directory and marker-file metadata checks together. It awaits
all three results, selects the first error in the original root/role/marker
order, and performs the existing final ownership assertion on success.

The check still runs before and after the CHECK/HELD exchange. Every path,
permission, file identity and OS lease check remains; no key or file-state cache,
retry, journal truncation or ownership exception was added. Windows retains its
original sequential branch. Pending reads must finish before failure handling;
this can delay failure return compared with failing on the first rejected read.
Three concurrent reads are a concurrency limit, not an I/O deadline. Absolute
path checks remain non-atomic against same-user path replacement.

## Executed checks and limits

The new diagnostic's argument/framing/measurement/wrapper suite passed 15/15 in
`validation/local/journal-replay/unit-nekFxu`. The changed lease provider's existing
native-owner, exception and keyring/journal integration suites passed 41/41 in
`validation/local/journal-replay/lease-regression-yLdI6h`, with no failures,
cancellations or skips. These are new executions for this change, not a reused
full-app result. The separate read-only implementation review found no new P1/P2.

Four new metadata-concurrency cases also passed 4/4 in
`validation/local/journal-replay/metadata-unit-EIO5n8`. They gate the actual
provider module's metadata reads in an isolated VM and verify that CHECK waits
for all pre-exchange reads, success waits for all post-HELD reads, rejection and
queued release wait for pending reads, and ownership loss or a changed marker
prevents success. Their process is a protocol double; the actual native lease
execution is recorded separately in the diagnostics and existing native suite.

Key API times include native ownership and keyring filesystem verification.
Wrapper availability timing is nested and must not be added again. The timed
open also includes native journal lease acquisition, latch authentication and
restart-latch writes; it is not an isolated replay CPU timer. The fixture's
owner assertion performs directory checks and therefore differs from Electron's
singleton check. Zero-liability USER_OFF histories do not represent every cost,
restore, key-rotation or corruption workload. Actual Keychain timing is unmeasured.

## Next release boundary

tZgvV7 remains the latest packaged candidate and contains neither PR100's backend
subphase markers nor this POSIX metadata change. Its prior whole-app warm p95
12,544ms and maximum sampled idle RSS 1,745,680KiB still fail the existing
10s/1.5GiB goals. The work is within stage5 performance follow-up; stage6 needs a
new candidate once the unchanged 8GiB build-space check passes. That candidate
must receive its own affected functional/recovery checks and twenty-run
performance assessment. The remaining real-account, independent quality,
clean-machine, signing and operational release conditions also remain open.

At ledger generation, free space was 6,535,139,328 bytes (about 6.09GiB), below
8,589,934,592 required. The check returned `MAC_BUILD_DISK_SPACE`; a new full
candidate build was not started. Existing apps, profiles and raw evidence were
preserved. The probe and its new synthetic records do not require a full build.
