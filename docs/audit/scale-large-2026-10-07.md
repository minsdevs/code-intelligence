# Large size class: vault durability, TS memory and the memory watchdog (unit w4-scale) — 2026-10-07

## Scope

Unit **w4-scale**, branch `gate/w4-scale` from `485d782`. Makes the user's decision to support
the large class (50k files / 200 MiB, 05 §4: 600 s, 6 GiB, 15 min hard timeout) reachable on
the three blockers left open by [perf-fixes](perf-fixes-2026-10-07.md) ("Not done") and the
[workload audit](workload-performance-2026-10-07.md) (R10): the `IMPORT` vault durability cost,
TS extraction memory, and the 6 GiB analysis memory watchdog. No packaged app was launched, no
SLO or threshold was changed, no gold data was regenerated. Every timing and RSS figure below is
a **non-acceptance observation** on a shared machine (load average 2–4); the coordinator's next
candidate decides the gates. Release verdict: **NO_GO**.

## 1. Source-vault batched durability barrier

**Cause.** `put` made each blob durable alone: `mkdir` + parent flush, temp write + flush,
rename + directory flush — three `F_FULLFSYNC` per file. Measured here: **18.1–18.7 ms per 5 KiB
put** (1,000 puts, real module, synthetic wrapper, temp dir). A probe of the costs (scratch, same
volume) showed the expensive part is flushing an inode whose *metadata* changed after its data
was written (a rename dirties both the file and its directory): 4–6 ms each, while flushing a
file that was written and closed before the batch's first device flush costs about 0.04 ms.

**Design.** New vault operations `stage` and `barrier` (POSIX); `put`, `read`, export, restore
staging (`importCiphertext`) and Windows storage keep their per-blob behavior.

- `stage` encrypts into an in-memory batch and returns a receipt with this vault handle's random
  `session` and a `sequence`; nothing is written. Quota (bytes, entries) is reserved per batch.
- A batch is flushed at 512 blobs / 16 MiB, at `barrier`, and before any other operation, so
  every other operation (and every per-blob `put`, including a deduplicating one) only ever sees
  durable blobs. Flush order: (1) an intent record `<sources>/.batch-intent` listing the batch's
  *new* addresses and new project directories, MAC'd with an HKDF subkey of the active source key,
  is published with the existing atomic writer (temp flushed, renamed, root flushed); (2) each
  address directory is created and `blob.bin` written **in place** (no rename), read back and
  authenticated; (3) every new blob file and address directory, each touched project directory
  and the root (new projects) are flushed — each inode still gets its own `F_FULLFSYNC`; (4) the
  intent is unlinked and the root flushed; only then does the flush count as done.
- `barrier(session, sequence)` succeeds only for the current handle's session and a sequence it
  issued, after the flush. A reopened vault never vouches for blobs a closed or crashed handle
  dropped (`SOURCE_VAULT_MISSING`).
- Opening a vault recovers first: leftover root `.pending-*` intent temps are removed (an
  address is never created before the intent's rename was flushed); a valid intent's addresses
  are removed (blob/pending files, address directory, empty new project directory), the project
  directories and root are flushed, then the intent is removed. A damaged or forged intent fails
  closed (`SOURCE_VAULT_INTEGRITY`) and deletes nothing. A failed flush poisons the handle.
- Broker: `STAGE` (fields as `PUT`) and `BARRIER {session, sequence}`. Backend: `SourceStoreClient
  .stage/barrier`; `LocalSnapshotStore.Capture` stages every file, requires one session for the
  whole capture and calls `barrier` **before** the manifest transaction. A crash anywhere before
  the barrier leaves no committed manifest and only intent-listed residue that the next open
  removes; after the barrier and before the commit, durable orphan blobs (as an orphaned `put`
  could already leave); after the commit, the committed state.

**Measured (observation, same machine state).** 1,000 × 5 KiB: base `put` 18.67 ms/file, this
branch `put` 18.12 ms/file (unchanged path), `stage`+`barrier` **0.49 ms/file**. [INFERENCE]
Vault time for one import: small ≈ 0.5 s (was ≈ 18 s), medium ≈ 5 s (≈ 180 s), large ≈ 25 s
(≈ 900 s); the per-file broker socket round trip is not included.

## 2. TS extraction memory (large class)

**Causes found.** (a) `noResolve: false` made TypeScript follow every import from the first root
file depth-first (`processImportedModules → findSourceFile → findSourceFileWorker`, 127 frames
each in the overflow trace), so the fixture's `u{i}.js` helper chain overflowed the stack; all
inputs are already root files, so resolution is unaffected by `noResolve: true` (identical result
digests on small/medium). (b) Full `forEachDescendant` walks (declarations, routes, Vue router,
API calls, written bindings, `containsJsx`) kept one ts-morph wrapper per compiler node: about
600 MB of the medium heap; they now wrap only the node kinds each pass reads, in the same
pre-order. (c) One program for the whole manifest needs about 70 MiB of process memory per MiB of
source (AST + binder): the large class's 100 MiB needed 6.4 GiB even after (a)+(b).

**Slicing rule (03 §6 "single context", implemented as an exact merge).** Above 16 MiB of TS/JS
the manifest is extracted in programs of about 12 MiB, one at a time, and merged so the result is
the one-program result. Every fact depends only on (1) its own file, (2) files its
import/export/require specifiers resolve to (the extractors' own resolver; the checker is only
asked about a file's own and global declarations), (3) global-scope files (scripts, `.d.ts`,
`declare global`; CommonJS/JSX-only scripts are included conservatively) and (4) manifest-wide
Nest facts (provider tokens with their classes' methods, the global prefix), which a first pass
over the files that can declare them collects. A slice program = owned files + their direct
targets + all global-scope files. Any resolution that still leaves a program (e.g. a React route
component behind a barrel re-export) is reported and that file is re-run with twice the import
depth (falling back to the whole manifest). Lists are merged by whole-program pass, file order
and emission order; duplicate graph keys keep the first emission in that order. Medium-and-below
inputs up to 16 MiB still run as one program. A full GC (`--expose-gc` set at runtime) runs
between programs.

**Measured (observation; `validation/pre-release/workload-ts-memory.cjs`, back to back).**

| Input (TS/JS subset of the workload fixture) | Base `485d782` | This branch |
| --- | --- | --- |
| medium, 5,499 files / 25.1 MiB | 24.95 s, 2,292 MiB peak RSS | 37.0 s, **1,814 MiB**, same digest `818f608b…` |
| large, 27,499 files / 100.3 MiB | **fails** after 10.2 s: `RangeError: Maximum call stack size exceeded` (3,494 MiB) | **198 s, 2,197 MiB**, digest `88d9d221…` |
| large as one program (after fixes a+b, 12 GiB heap) | — | 128 s, 6,390 MiB, digest `88d9d221…` (equal to the sliced run) |

Sliced and one-program digests were also equal on a 2,000-file/12 MB fixture with 53 programs of
≤ 1 MiB. [INFERENCE] Large owner tree ≈ TS 2.2 GiB + backend ≤ 2.3 GiB (2 GiB heap) + PostgreSQL,
Redis, Electron ≈ 1 GiB → about 5.5 GiB, inside 6 GiB but with little headroom.

## 3. R10 analysis memory watchdog

`AnalysisMemoryWatchdog` (backend `job`): `app.analysis.memory.limit-bytes` (default 6 GiB,
05 §4) over the owner process tree's RSS, measured with one `/bin/ps -axo pid=,ppid=,rss=`
snapshot summed from `app.analysis.memory.owner-pid` (the desktop now passes its main process as
`ANALYSIS_MEMORY_OWNER_PID`; 0 = the backend's own tree). `JobWorker` refuses to start a job while
the tree is above the limit (job `FAILED`, `failure_code = ANALYSIS_MEMORY_LIMIT`, retryable) and
watches every running job: a 2 s sampler (only while a job runs) stops the run once, which
interrupts its in-flight analyzer request and fails the step with `AnalysisMemoryLimitException`
(job `FAILED` with the same code, not `CANCELLED`). An unmeasurable tree (no `ps`, e.g. Windows)
does not block analysis.

## Red → green

| Defect | Test | Red observed | Green |
| --- | --- | --- | --- |
| Vault 3× full flush per blob | `desktop/test/source-vault-batch.test.cjs` (13: session/barrier, unacknowledged batch lost, durability calls bounded by batches, batch-limit flush, crash at intent temp / intent written / blob written / blobs flushed / intent retired, other operations flush first, damaged intent fails closed, quota, rotated-key dedup) | `TypeError: vault.stage is not a function` (12 failing) | 13/0 |
| Broker has no staged path | `source-broker.test.cjs` STAGE/BARRIER cases | 2 failing | 16/0 |
| Manifest committed per-put | `SourceStoreClientTest` (stage/barrier, 4 new), `LocalSnapshotStoreBarrierTest` (3: barrier before transaction, failed barrier commits nothing, session change fails) | compile: `cannot find symbol stage/barrier/StagedBlob` | 87/0, 3/0 |
| End to end with the real vault/broker | `RetainedSourceIntegrationTest` | — | 37/0 |
| TS import chain overflow | `ts-scale.test.ts` 6,000-file chain | `RangeError: Maximum call stack size exceeded` | pass |
| One program for any size | `ts-scale.test.ts`: sliced = one program on the reduced workload fixture (in order, programs bounded), cross-slice barrel/alias/Nest token/global prefix/global script (13 programs incl. one escalation; fails with escalation or manifest facts disabled), syntax error in a later slice | new | 4/4; analyzer suite 292/0 |
| No memory watchdog | `AnalysisMemoryWatchdogTest` (7, injected RSS), `JobCancellationTest` (+2), `JobMemoryWatchdogIntegrationTest` (2), `main-runtime-gateway` owner pid | compile: `cannot find symbol`; owner pid `undefined` | 7/0, 7/0, 2/0, 150/0 (with `runtime.test.cjs`) |

Directly affected suites rerun green on the final tree: desktop vault/backup/broker/journal/
runtime set 861 tests, 858 pass, 0 fail, 3 skipped (opt-in JAR cases); backend, one
`cleanTest` run: the whole `job` package (12 classes, 161 tests, 0 failures, 4 skipped in the
opt-in `JobAnalyzerWorkerRaceIntegrationTest`), `MaintenanceBackgroundLeaseTest` 6/0,
`RetainedSourceIntegrationTest` 37/0, `LocalIngestIntegrationTest` 4/0,
`LocalSnapshotStoreBarrierTest` 3/0, `SourceStoreClientTest` 87/0. `ImportSecretsCorpusIntegrationTest` C05-46 (20,001 eligible
files → expects one `FILE_LIMIT`) **fails on base `485d782` and on this branch alike**: the test
still assumes the old 20,000-file default that `fb22516` raised to 50,000.

## Changed product paths

`desktop/src/source-vault.cjs`, `desktop/src/source-broker.cjs`, `desktop/src/main.cjs` (one env
entry), `backend/src/main/java/dev/codeintelligence/source/{SourceStoreClient,SourceStoreException}.java`,
`backend/src/main/java/dev/codeintelligence/project/LocalSnapshotStore.java`,
`backend/src/main/java/dev/codeintelligence/job/{AnalysisMemoryWatchdog,AnalysisMemoryLimitException,ProcessTreeMemory,JobCancellation,JobWorker}.java`,
`backend/src/main/java/dev/codeintelligence/common/AnalysisMemoryProperties.java`,
`backend/src/main/resources/application.yml`,
`analyzers/ts-analyzer/src/{ts-extractor,ts-slices,semantic-extractor,react-component-binding,syntax-diagnostics,walk}.ts`.
No Flyway migration was needed.

## Limits and what remains

- Packaged acceptance of all three changes is pending the next candidate; the large owner-tree
  RSS, the full `IMPORT` time and the 600 s/6 GiB SLOs were not measured in the app.
- Vault crash tests inject faults in-process and reopen; power loss was not tested. The cheap
  per-inode flushes are an APFS observation, not a guarantee; correctness does not depend on it.
  Windows `stage` stays per-blob durable. One broker socket per file remains.
- TS: sliced extraction costs time (medium 37 s vs 25 s, large 198 s vs 128 s as one program).
  The inter-program GC sets `--expose-gc` at runtime; if that is unavailable in the Electron-run
  analyzer, peak RSS was observed up to 3.2 GiB for large. There is no per-analyzer heap cap
  (worker `resourceLimits`) yet; the backend watchdog is the hard stop. Exactness is shown by
  digest equality on four fixture sizes and the cross-slice unit cases, not proven for every
  project shape (the application-origin cache of the global prefix is per program, which can
  differ only at its 64-step depth limit).
- Watchdog: when it stops a job, the backend abandons the analyzer request; the analyzer process
  itself is not terminated (its session expires after 60 s idle). RSS sums count shared pages per
  process, like the workload runner.

## Proposed shared-doc text (not applied)

- 03 §6: "The single compiler context is realized as sliced programs (owned files + their direct
  resolution targets + global-scope files, with manifest-wide Nest facts from a first pass) whose
  merged output equals one whole-manifest program; a file whose facts leave its slice is re-run
  with more context."
- 05 §4: "The 6 GiB analysis watchdog samples the desktop owner tree every 2 s during a job;
  above the limit no job starts and a running job fails with `ANALYSIS_MEMORY_LIMIT`."
- validation/pre-release/README: "`IMPORT` stages retained blobs and commits the manifest after
  one vault barrier; `workload-ts-memory.cjs` reproduces the TS extraction observation per class."
