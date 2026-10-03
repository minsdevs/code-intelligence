# T09 main-only backup safety maintenance contract (2026-10-03)

This bounded implementation connects trusted maintenance capabilities in the existing Electron
main lifecycle, AI gateway and safety journal. It follows frozen
[05 §§5 and 7](../multilanguage-plan-2026-10-02/05-security-performance-operations.md).
It does not enable the product backup/restore entry points, export/import PostgreSQL, validate an
archive's product contents, implement a recovery-marker loader, replace source storage, or use
an OS keychain/provider. Those integration responsibilities remain with main's orchestrator.
The subsequent [main integration report](backup-restore-integration-2026-10-03.md) records
which of those responsibilities are now connected and which release blockers remain.

## Ownership and API

The public lifecycle facade remains exactly `diagnostics`, `latch`, `denyAdmission`, and `close`.
Its two new trusted main options are:

```js
openSafetyLifecycle({
  // existing options
  recoveryMode: false, // optional; only a marker-validated main recovery factory may set true
  createBackupRuntime: async ({ keyProvider, journal, readSafetyState }) => runtime,
});
```

The optional backup factory receives a frozen capability object:

- `keyProvider.currentKeyId('backup')` and `keyProvider.getBackupKey(id)` only. There is no source,
  credential or safety-key access, rotation, initialization, generic export, or close method.
  Every key lookup transfers a fresh caller-owned Buffer. The trusted archive consumer must clear
  it in `finally`, including failures. These bytes must never reach a renderer, environment,
  worker, socket or report. Lifecycle does not attempt to erase already-issued caller copies.
- `journal.snapshot()`, `journal.sealMaintenance(metadata)`, and
  `journal.completeMaintenance(metadata)` only. No activation, permit, settlement, arbitrary append,
  raw file, or signing-key capability is passed to the backup factory.
- `readSafetyState()` returns a detached frozen `{aiOff, recoveryOnly, closing}` view.

The factory returns a handle with `close(): Promise<void>`. Its own close must synchronously stop new
operations and wait for all accepted archive/PG/journal work. Lifecycle close is idempotent and marks
itself closing before waiting for backup close, then gateway/journal close, then keyring close. If
backup drain rejects, lifecycle retains journal/keyring ownership because unresolved work could still
use them. A factory throwing before it returns a handle must clean up its own unpublished work.
An invalid factory result is rejected and construction-owned journal/keyring handles are closed.

`openDesktopAiGateway` accepts optional trusted `verifyMaintenanceSeal` and
`verifyMaintenanceCompletion` functions. It passes them through core to `openJournal`; a renderer or
bridge caller cannot register/replace them. Missing callbacks are not treated as successful checks.
Main's factory must provide fixed target-specific PG adapter readbacks, not a generic success lambda.

## Metadata and durable records

Both journal methods accept exactly:

```js
{
  transactionId,                 // canonical lowercase UUID
  kind,                          // BACKUP or RESTORE
  payloadSha256,                 // 64 lowercase hex; verified immutable staging payload
  pgProjectionDigest,            // 64 lowercase hex; adapter-defined normalized financial state
  legacyLiabilityUnresolved,     // boolean
  budgetDay,                     // real YYYY-MM-DD date
  minimumVersion,                // canonical decimal string, 0..signed Long max
}
```

No paths, source, prompts, key IDs/bytes, arbitrary messages, SQL, or credentials are admitted.
The metadata is validated and copied before joining the writer queue. Bucket and minimum version
cannot regress; a requested minimum above the running build is refused. Completion must match the
pending transaction ID, kind and payload digest. Its PG digest may change after conservative merging.
Completed transaction IDs cannot be reused for another seal in the current journal history.

`verifyMaintenanceSeal(snapshot, metadata)` / `verifyMaintenanceCompletion(snapshot, metadata)` must
return an exact `{...metadata, verified:true}` acknowledgement. A missing/false/mismatched/extra-field
acknowledgement rejects the operation. The callback must independently read committed PG rows, bind
installation/ownership, prove completeness, compare each obligation and count/sum/hash, preserve the
legacy flag, and check the current journal position. Normalized financial digest excludes changing
journal sequence/hash/clock fields and the derived `reconciliationRequired` flag, which can clear
when the completed B head is published. Position and clock are checked separately; a pending B
maintenance seal independently requires `reconciliationRequired=true`. Persistent policy, limits,
legacy uncertainty, all obligations and usage evidence remain in the financial digest. A receipt
therefore survives its own expected completion transition without weakening those checks. This library cannot
establish that an arbitrary injected callback actually contacted a database.

After verification, `MAINTENANCE_SEALED` / `MAINTENANCE_COMPLETED` records use the existing authenticated
append/fsync path. Before ACK, bounded persisted-chain readback must agree with the owned log identity
and trusted in-memory head. Exact idempotent retries still perform fresh callback verification and
persisted-chain readback. Ambiguous write/fsync/readback failure yields OFF/recovery, never permission
to mutate A. Existing per-record/log/record-count limits also bound maintenance history.

Snapshot adds `pendingMaintenance`, `maintenanceReceipt`, and `legacyLiabilityUnresolved`.
The latter is an authenticated OR-only flag: no completion, restore, restart or activation clears it.
An unacknowledged append also conservatively retains a possible newly set flag in poisoned memory.
Pending maintenance and the legacy flag independently reject journal/core activation.

Existing `mergeRestore` receipts remain B-internal import acknowledgements. They are not product
restore completion receipts. The prior obligation projection digest algorithm is unchanged, so adding
the new metadata does not invalidate historical projection hashes.

## Main-only maintenance and actual drain

```js
const maintenance = await gateway.beginMaintenance({ transactionId, kind });
await maintenance.waitForDrain({ timeoutMs }); // exact integer, 1..120000
await maintenance.readProjection();
await maintenance.mergeAndCommit({ mergeInput: {
  restoreId, obligations, budgetDay, minimumVersion,
} });
await maintenance.refreshProjection();
await maintenance.rotateBackendChannel();     // desktop gateway handle only
await maintenance.release();
```

`beginMaintenance` establishes its in-memory barrier before its first await: prepared plans are
invalidated, activation generations are superseded, and QUOTE/APPROVE/EXECUTE/ACTIVATE are blocked.
It then writes the durable OFF latch. Only one main maintenance handle can be active. Nothing adds a
bridge operation or expands the renderer API.

Drain waits for core's actual EXECUTE task promises, including transport, evidence, settlement,
failure accounting and buffer cleanup, followed by the settlement/control queue. It does not rely on
the diagnostic active-request count, journal permit count, or a disconnected backend socket. Timeout
keeps admission blocked and does not authorize A mutation or new dispatch. A later explicit drain can
wait for the same tasks; there is no resend. Core close also drains/closes the journal if writing its
final latch fails, before lifecycle closes purpose keys.

Read/merge/refresh/release require this handle's successful drain. Projection remains the existing
strict `{version:1, complete:true, gate, requests, evidence}` contract with a non-null gate. Missing
gate, failed reads, unsupported legacy liability and incomplete data are not empty-state fallbacks.
A verified fresh/no-gate installation needs a separate explicit main/PG initialization contract.

`mergeAndCommit` captures a bounded exact merge input, uses the existing digest-bound resumable
`journal.mergeRestore`, then publishes and independently reads back the PG projection. It never
activates AI. The private authority passed to `bindAuthority` adds
`readMaintenanceSnapshot(): frozen detached JournalSnapshot`. Only trusted main adapters receive this
getter. The existing JOURNAL bridge DTO is unchanged; its `restorePending` boolean includes pending
maintenance. PG's `fromSnapshot` conversion must use the same OR rule. B's legacy=true / PG's
legacy=false is an exact-comparison failure.

Product sequencing is a main responsibility:

1. Acquire the main operation mutex; stop admission, latch, drain actual AI and project/source writers,
   and stop the backend while retaining the required PG process.
2. Verify/commit the current conservative PG/B union and read it back. Only then write the B seal and
   verify its durable ACK before modifying A.
3. Validate/stage/recover/swap A using the separate product loader. B and all purpose/source keys
   remain outside swap/rollback/cleanup paths.
4. Merge restored obligations into surviving B; PG commit/readback; B completion receipt; PG refresh
   and readback again because the receipt advances the journal position.
5. Verify product health and marker policy, rotate the stopped backend's private channel, and release
   maintenance. AI remains OFF until a later explicit valid activation.

`release` requires this transaction's completion receipt, no pending merge/maintenance/recovery state,
and fresh PG readback exactly matching the latest B position and obligations. Calling it after the
receipt but before the final PG refresh fails, even when row counts/amounts appear unchanged. It does
not validate main's filesystem marker, source state, SQL schema, application health or user consent.

## Backend channel rotation

Only the desktop maintenance handle exposes `rotateBackendChannel()`. It verifies drained ownership,
disables bootstrap/release while rotating, closes the old private bridge and waits for all old handlers,
then creates a fresh capability and channel epoch. Old credentials cannot use the new socket. Main's
core epoch remains the same; prepared request plans were already invalidated by the maintenance barrier.
The old backend must be stopped by the orchestrator before rotation. Rotation failure is fail-closed;
no replacement bootstrap is acknowledged. Shutdown waits for an in-progress rotation before closing
bridge/core resources. No new RPC command exposes this operation.

## Recovery and historical settlement compatibility

Normal lifecycle/core startup rejects pending maintenance or a pending B merge. Trusted `recoveryMode`
requires an existing enrollment marker and B, plus a backup recovery factory; it never initializes
missing safety state. It remains recovery-only for that handle's entire lifetime, even after completion.
Main must validate its durable marker and exact staging input before selecting recovery mode. Normal
runtime requires closing that recovery handle and a clean normal reopen after all product checks.

For a partial merge, the original `restoreId`, obligations, budget day and minimum version must be
reused. Recomputing input from a changed PG snapshot or the current day is not equivalent; the persisted
input digest/prefix rejects it. Marker loading, staging retention, A rollback, process-crash ownership
recovery and offline UX are not implemented here. Stale locks are not deleted or bypassed. The tests
model append/ACK failures followed by explicit handle close/reopen, not a power cut or automatic
recovery of an abandoned writer lock.

New `RESTORE_OBLIGATION_V2` records preserve an existing proven SETTLED row's status/amount/proof
when an archive conflicts, while setting conflict and the maximum liability floor. Conflict liabilities
remain fully held and cannot activate AI. This agrees with PG's immutable-settlement rule when its
existing authoritative row matches B. Historical `RESTORE_OBLIGATION` records keep their old replay
semantics and digests. Already-converted historical UNKNOWN rows are not upgraded to invented proofs.
An older reader that does not understand a new event fails closed.

The importer must not first insert a conflicting archive SETTLED row as immutable PG authority and
then expect this code to rewrite it to B's different settlement. It must construct the final row from
authoritative B plus conservative conflict/floor before insertion, or reject that restore. This change
does not disable PG triggers or repair historical proof conflicts automatically.

## Verification scope

All keys, provider responses, rows and secure-storage wrappers used by this slice's tests are synthetic.
The first restricted-sandbox run recorded 283 PASS / 43 gateway FAIL out of 326: a separate temporary
Unix socket probe returned EPERM. Those environmental failures remain in
`/tmp/ci-backup-safety-first-2026-10-03.log` and `.xml`; they were not counted as product regressions.
The subsequent allowed local-socket draft run passed 362/362, zero failure/skip/cancellation, in
`/tmp/ci-backup-safety-targeted-2026-10-03.log` and `.xml`. Later private-authority/readback/close and
recovery regressions are separate from that earlier result. Final candidate evidence follows below.

Final owned-suite candidate: **366/366 PASS**, 0 failure, skipped or cancelled, in
`/tmp/ci-backup-safety-candidate-2026-10-03.log` and `.xml`. All four production and four test files
passed `node --check`; `git diff --check` passed. The four production SHA-256 values are:

| File under `desktop/src/` | SHA-256 |
|---|---|
| `safety-journal.cjs` | `de6a118790274a71574e5180a86bf485ebb68a2bb5adb6900771aeb9999aec35` |
| `safety-lifecycle.cjs` | `2788a96c4fbfbda3c52633f4df79d9bf55b31db16fe874e9dd3510c6092c7637` |
| `ai-egress.cjs` | `b13f2959545ca30d8baae8dd3fd8cf2b0d556b84a54ae72ab9b16b3988c7d847` |
| `ai-desktop-gateway.cjs` | `509b950a7f459c9c3e7afb8124a42b4af8a895871ec2e1cff1de6f7579e434e7` |

The accompanying `/tmp/ci-backup-safety-freeze-2026-10-03.json` records all eight code/test hashes,
this contract, and the separate environmental/draft/final evidence hashes. This candidate has not yet
received independent review. Other desktop suites, the PG adapter/staged importer and the product
main orchestrator were not validated by the 366-test run.

This scope does not certify real PostgreSQL transactions, actual Keychain behavior, product backup
export/import/scrubbing, source swap, physical power loss, native ancestor confinement, signed builds,
updates, or release readiness. Existing product backup/restore guards must remain until the main
orchestrator and those acceptance gates pass.
