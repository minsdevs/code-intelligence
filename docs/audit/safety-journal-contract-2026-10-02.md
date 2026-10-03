# Isolated safety journal module

2026-10-02; restore recovery revised 2026-10-03. Implements a bounded main-process library for the journal part of frozen
05 §7 ADR-02, with synthetic cases relevant to 06 C13/C16. This is an isolated T08
slice. It does not complete T08, C13, C16, native isolation, the egress gateway,
PostgreSQL budgeting, or the product restore state machine. Whole-task acceptance
counts remain unchanged.

Owned files are `desktop/src/safety-journal.cjs`,
`desktop/test/safety-journal.test.cjs`, and this document. No integration changes to
`main.cjs`, `backup.cjs`, existing providers, credentials, or installed userData.

## Private boundary and files

The module uses Node standard-library cryptography and filesystem operations. It
has no network, shell, Electron, database, renderer, or provider client. Main must
keep this capability private. It must not be exposed through public HTTP or given
to workers. Neither a provider call nor a PostgreSQL commit is proven by this
module alone.

Within an existing installation, the caller supplies an absolute `safetyRoot`
outside every restorable data root. Overlap in either direction is rejected after
canonicalizing existing parents, including symlink aliases. The module owns:

| Path below safetyRoot | Purpose |
|---|---|
| `ai-journal/events.log` | Append-only authenticated event frames, mode 0600 |
| `ai-journal/writer.lock` | Exclusive process ownership, mode 0600 |
| `ai-off.json` | Authenticated durable OFF latch independent of log availability |
| `.ai-off-<random32hex>` | Private temporary file for replacing the latch |

The `ai-journal` directory is 0700. Files must be regular, owned by the current OS
user, have one hard link, and deny group/other access. Symlinks and special files
are rejected. The sibling `source-vault` directory and its keys/lock are untouched.
These are pathname and descriptor checks inside a private installation directory,
not a claim of native confinement against a hostile process sharing the OS account.

`writer.lock` is created exclusively and retained for the instance lifetime.
Operations within an instance are serialized. Clean close removes only the exact
inode owned by that instance. An existing or ambiguous stale lock is never removed
automatically, even if its claimed PID appears dead. Recovery requires an external,
verified maintenance procedure; this module does not implement one.

## API

Exports `initializeSafetyJournal(options)`, `openSafetyJournal(options)`, and
`SafetyJournalError`. Initialize is an explicit fresh enrollment operation; it
refuses any existing journal directory or latch. Open never silently initializes,
truncates, repairs, or replaces missing history. Both return a frozen method facade;
mutable state, descriptors, options, and key providers are not exposed.

Required options:

| Option | Contract |
|---|---|
| `safetyRoot`, `restoreRoots` | Absolute paths; at least one restorable root |
| `installationId` | Existing opaque desktop identity matching `[A-Za-z0-9_-]{1,128}`, including leading `-` or `_`; included in the authentication domain and never used as a path segment. No identity is minted or replaced. |
| `runningBuild` | Canonical nonnegative signed64 decimal **build sequence**, not semantic version text |
| `keyProvider.currentKeyId('safety')` | Current named key ID |
| `keyProvider.getMacKey(keyId, 'safety')` | Transfers ownership of a fresh private 32-byte Buffer to the journal; the provider separately retains old verification keys |
| `verifyCommittedReservation(reservation)` | Trusted PG adapter returns every exact reservation field plus `committed: true` only after reservation commit |
| `verifySettlement(settlement)` | Trusted usage adapter returns exact settlement fields plus `verified: true` only for known usage bound to this request/payload |
| `verifyActivation(snapshot, acknowledgement)` | Trusted integration checks PG projection, health, keys, ownership, and explicit activation consent; returns boolean |

Optional options are an injectable millisecond `clock`, an asynchronous
`fault(stage)` hook, and lower test/runtime `limits`. `getMacKey` must return a fresh
owned copy, never the provider's retained key Buffer or a view into it. The journal
copies this transferred Buffer for HMAC and clears **both** buffers in `finally`,
including HMAC errors and invalid returned Buffer lengths. The provider retains its
own independent inventory for old-record verification. These rules match
[`purpose-keyring.cjs`](../../desktop/src/purpose-keyring.cjs) directly; callers do
not need to insert another copying adapter. JavaScript strings/full-heap erasure is
not claimed. Key bytes are never persisted, returned by the journal, or inserted
into errors. The production safeStorage adapter/main lifecycle remains to be
connected. Module fixtures use fresh synthetic key copies, and the separate
`desktop/test/safety-keyring-integration.test.cjs` connects the real purpose keyring
and journal with a synthetic authenticated wrapping adapter in temporary storage.
All callback ports are trusted integration boundaries, not caller claims or
independently verified database/provider proofs. Callbacks must not reenter the
journal queue.

Returned methods:

| Method | Behavior |
|---|---|
| `snapshot()` | Detached diagnostic/projection data, sequence/hash, holds, OFF/recovery status and pending restore commitment/progress; no permit or key material |
| `reserveAndPermit(reservation)` | Exact PG acknowledgment, durable RESERVED, durable DISPATCH_INTENT, then a fresh in-memory permit |
| `consumePermit(permit)` | Validates request UUID/payload/permit identity and atomically consumes it once |
| `settle(settlement)` | Verifies known usage and fsyncs settlement before returning a projection receipt |
| `holdUnknown(requestId, reason)` | Keeps full reservation liability; removes any unused permit |
| `latch(reason)` | Durably sets OFF and invalidates permits before acknowledging |
| `mergeRestore({restoreId, obligations, budgetDay, minimumVersion})` | OFF first, bind complete input, resume only that input, union by UUID with conservative liability and monotonic high-water, then durable completion receipt |
| `activate({projectionDigest, userApproved: true})` | Checks current projection/health/clock/build, commits activation, then durably removes OFF latch |
| `close()` | Drains queue, drops permits, closes log, releases only its own lock |

A reservation has exactly `requestId`, `payloadSha256`, `budgetDay`, `priceVersion`,
and `reservedMicroUsd`. A settlement has exactly `requestId`, `payloadSha256`,
`actualMicroUsd`, and `proofSha256`. All request IDs are canonical UUIDs and digests
are lowercase SHA-256 hex. Price and key IDs are bounded identifiers. No freeform
metadata, prompt, source, token, URL, executable command, or credential field is
accepted. Reasons are a fixed enum, not arbitrary exception messages.
Validators require the entire string to match and reject trailing LF, CR, and
Unicode line terminators. The explicit full-match comparison preserves the
original unflagged anchored patterns' behavior; it is defensive clarification,
not a reproduced validation bug fix.

Amounts are canonical decimal **strings** in `0..9223372036854775807`, checked and
compared with BigInt. Floating point, negative, exponential, padded, or oversized
representations are rejected. Aggregate liability may exceed signed64 and remains
an exact decimal string; no Number conversion is used for money. Build-sequence
high-water uses the same integer representation and numeric comparison.

The clock comes from main, never a reservation's claimed time. `budgetDay` must be
the current UTC day when reserving. Backward time and restored future buckets block
new dispatch. The maximum observed clock, budget day and build sequence cannot be
lowered by restore. This module does not calculate prices, token upper bounds,
daily/monthly allowances, or PG row-lock admission; the PG acknowledgment adapter
must enforce those contracts. At most two issued/live requests are admitted here;
unknown requests retain their liability when they leave the live set.

## Durable state and recovery

Each event is a 4-byte unsigned big-endian length followed by canonical UTF-8 JSON:
`major`, `sequence`, `previousHash`, `atMs`, typed `event`, `keyId`, `mac`. Major is
1. HMAC-SHA256 authenticates all fields except `mac`, with a domain separator and
installation identity. The next record references SHA-256 of the complete previous
frame, including its length and MAC. Replay checks framing, canonical encoding,
sequence, previous hash, MAC, major, event schema, and state transition.

All append transitions are validated before writing. Appends are fully written and
file-fsynced before acknowledgment. New directory entries are directory-fsynced.
The OFF latch uses a fresh 0600 temporary file, file fsync, rename, and directory
fsync. Activation is not acknowledged until latch removal is directory-fsynced.
Faults latch OFF and poison the instance; no further permit can be issued or used.
If storage/key failure prevents persisting the latch, the error and current
instance still fail closed. The integration must not interpret errors as permission
to start a normal backend or dispatch.

No UUID receives a second permit. Permits are memory-only and bound to the approved
payload digest. Restart discards all permits, durably sets OFF, and turns unfinished
requests into full unknown holds. A verified activation is required after every
open. The future egress integration must consume the permit immediately before
its single send and must never treat a consumed authorization result as reusable.
The library cannot stop unrelated code from calling a provider directly.

Known identical settlements are idempotent and append nothing twice. Missing usage
does not mean zero. A different verified settlement is a conflict: preserve the
larger obligation and block activation. Actual cost above reservation is recorded
without clamping and prevents new calls. A journal acknowledgment failure returns
no successful projection receipt and retains a conservative in-memory hold. PG
reservations absent from a durable prefix must remain fully held and be imported
by the recovery adapter; diagnostic in-memory state is not persistence proof.

Restore first persists OFF and invalidates outstanding permits. Existing journal
UUIDs remain even when absent from an old database. Backup-only UUIDs become full
unknown holds, including alleged settled rows: backup data alone cannot prove a
release. Same-UUID conflicts retain the maximum obligation and stay blocked. Only
an already authenticated same-request final journal settlement may supersede its
older matching hold. The input's day/build high-water is merged with maxima,
including retained request days, and is persisted in `RESTORE_BEGIN` before importing
any rows. It cannot regress during recovery or a later restore.

Restore completion is an authenticated transaction in the log:

1. `RESTORE_BEGIN` records the restore UUID, complete canonical input SHA-256,
   obligation count, original input day/build, and accepted maximum day/build.
   Input canonicalization sorts unique obligation UUIDs and object keys. The digest
   covers all input fields, including original metadata and alleged backup status/
   settlement data, even when two inputs would produce the same projection.
2. Each `RESTORE_OBLIGATION` contains that UUID/digest, its zero-based contiguous
   index, and the exact original obligation. Replay requires strictly increasing
   UUIDs, computes the conservative merged row itself, and advances a streaming
   canonical-input hash. It refuses rows outside a pending transaction, duplicate
   or out-of-order progress, and mismatched transaction fields. Settlement conflicts
   use a distinct `SETTLEMENT_CONFLICT` event and cannot masquerade as restore rows.
3. `RESTORE_RECEIPT` is accepted only after the exact count of rows, the reconstructed
   full input digest, and the current projection digest all match. Every event is
   fsynced before acknowledgment. No completion receipt can skip missing rows.

After an interruption, `snapshot().pendingRestore` exposes `restoreId`,
`inputDigest`, `obligationCount`, original input day/build, `appliedCount`,
`lastRequestId`, and `processedInputDigest` (the SHA-256 of the canonical input
prefix processed so far). No hash object or mutable internal state is exposed.
Only the same normalized input can resume; reversed caller row order is equivalent.
A different UUID, an empty/older input, or changed fields under the same UUID
returns `RESTORE_PENDING` without changing the log or poisoning an otherwise
recoverable instance. Resume first verifies its input against the durable prefix,
skips accepted rows, and writes no second begin or duplicate row. A pending restore
blocks activation, including when zero rows survived and the visible liability
sum is zero. That partial sum is **not** a complete budget projection or permission
to dispatch. Integration must retain the original restore input before starting;
this module cannot reconstruct missing rows from a digest. If that input is lost,
AI stays OFF rather than permitting an empty substitute or an abandonment override.

After completion, a new restore UUID is allowed and preserves the union and
high-water. Repeating the most recent completed UUID with its exact input sets OFF
again and returns its existing receipt without repeating imported rows; changing
that UUID's input returns `RESTORE_CONFLICT`. A completion receipt is historical:
later settlement or other journal events can change the current projection. Its
digest must not be assumed to describe a later `snapshot().projectionDigest`.
Root must commit the PG projection and validate count/sum/digest plus full restore
health before its activation adapter accepts anything. Database/source swap and
the complete restore state machine are not implemented here.

This changes the typed restore event schema of an unreleased, unconnected module.
Old experimental restore frames lacking commitment/progress fields fail closed;
there is no in-place history rewrite or migration of installed safety state.

Corrupt, missing, incompatible, or torn logs refuse open with a sanitized
`SafetyJournalError` carrying `aiOff/recoveryOnly=true`. A validated prefix may be
included for conservative diagnostics; its unfinished requests remain held. The
original bytes are preserved. No truncated tail is silently discarded and no fresh
history is generated. Missing keys and corrupt latches also fail closed. Errors do
not echo adapter/OS exception text.

Default limits: 16 KiB per record, 32 MiB per log, 100,000 records, 10,000 request
UUIDs, and 10,000 obligations per restore input. A two-record reservation reserves
space for two maximum-sized frames before calling the PG adapter; actual admission
can stop before the byte limit. Capacity exhaustion sets OFF. Rotation, compaction,
checkpoint publication and automatic key deletion are deliberately absent; no old
segment or key is deleted. Adding rotation requires the separate ADR-02 durable
pointer/recovery protocol, not overwriting this log.

## Validation and remaining gates

Commands for this isolated slice:

```sh
node --check desktop/src/safety-journal.cjs
node --check desktop/test/safety-journal.test.cjs
node --test desktop/test/safety-journal.test.cjs
```

The pre-key-ownership **2026-10-03** run passed **101/101 tests**, with zero failures, skips, or
cancellations, on Node `v26.5.0`; both `node --check` commands passed. Reports:

| Artifact | SHA-256 |
|---|---|
| `/tmp/ci-safety-journal-2026-10-03-final.log` | `1456f71ae2e2062381215630788e192977ce320c593bb6b61b64eadde39d6c04` |
| `/tmp/ci-safety-journal-2026-10-03-final.xml` | `740b05ce26ddf58a5430d75de807231be75769bec8d041e0ce3b7d45fe404e79` |
| `desktop/src/safety-journal.cjs` | `03c271a51893e191faf1e18c8d8e9139f78c0d9c2ee25eb62e04960719993035` |
| `desktop/test/safety-journal.test.cjs` | `01049740516561690933334f1bd5a6ddf5cb65a0b92e911c3bc905f3f16115d3` |

Independent read-only review of that earlier frozen revision found **0 unresolved critical,
high, or medium issues in this scope**. The reviewer inspected the implementation,
tests and contract, independently matched the four artifact hashes above, and
confirmed 101 JUnit cases with zero failures/errors/skips. The reviewer did not
rerun the tests; this is scoped code/artifact review, not independent execution or
whole-T08/operational safety certification.

The later purpose-keyring integration review found a **medium** ownership mismatch:
the journal cleared its own second copy but retained the Buffer transferred by
`getMacKey`. The independent real-module reproduction observed 2/2 transferred
Buffers still nonzero after initialization and close. The original evidence is
`/tmp/ci-purpose-keyring-review-interop-2026-10-03.json`. This did not expose keys via
an API, but left avoidable secret material in the main-process heap. The current
`mac` implementation clears both copies on all exit paths; fake providers now
return fresh copies so retained verification keys are never zeroed by the consumer.
New regression cases observe transferred buffers, invalid 0/31/33-byte results,
and both copies when the HMAC implementation throws. The real keyring/journal
integration separately exercises signing, rotation, old-key replay after keyring
reopen, failed MAC verification, and unavailable-key failure closure. The 101-test
result above and original keyring 79-test result are historical scope-specific
evidence, not validation of this new integration change.

Latest ownership-fix validation on Node `v26.5.0`: **106/106 journal tests PASS**
(the previous 101 plus five ownership/error regressions) and **3/3 separate real
keyring↔journal integration tests PASS**, all with zero failures/skips/cancellations.
Syntax checks passed for the modified module, journal test, and new integration
test. Do not add the earlier 101 or 79 counts to these results. No purpose-keyring
production/test code was changed by this fix. Independent re-review is pending.

| Current artifact | SHA-256 |
|---|---|
| `desktop/src/safety-journal.cjs` | `ac008fce1692c4704ea53badffabb1c590b02406a42f6efadcb5221df9622e9e` |
| `desktop/test/safety-journal.test.cjs` | `6f8beb7eceb446f9d44c0ecc3aff0ec157de2c3dc44861755357d248cc061d36` |
| `desktop/test/safety-keyring-integration.test.cjs` | `4f86e494da89debd9f4265ebede7cfc0e41dee5cf156c29358312b2f49924e56` |
| `/tmp/ci-safety-journal-key-ownership.log` | `bdbf4053c3a311771ee7a151acbdc32d6e9de6ee2e678f6abd9157b242cd67c0` |
| `/tmp/ci-safety-journal-key-ownership.xml` | `bac51d63eade3177c0c297da56f19547fa80ea91288507857ddc6dd562d3525d` |
| `/tmp/ci-safety-keyring-integration.log` | `f5951624e8cf7defe627b690ac855e4bfd4196897c1ffc6c4688efd9b7840e87` |
| `/tmp/ci-safety-keyring-integration.xml` | `da0da7ff093401490eac467c492aacb551cc2f77a9241302e4cee5102a025bd5` |

| Finding | Impact and priority | Resolution and evidence |
|---|---|---|
| High: interrupted restore could be replaced before all obligations were durable | Missing cost holds could enter an apparently complete projection; must close before integration | `desktop/src/safety-journal.cjs` restore transition validation and `mergeRestore` bind input/count/progress; pending first/intermediate-row, replacement, exact-resume and invalid-chain regressions passed |
| Medium: journal retained the key copy transferred by its provider | Avoidable secret material remained in the main-process heap; close before keyring integration | Independent real-module reproduction observed 2/2 nonzero copies before the fix; `mac` now clears transferred and internal copies, and the independent rerun observed 0 nonzero copies with retained key material unchanged |

New cases cover failure before
the first imported row, failures before/after write and fsync for first/intermediate
rows, repeated interruption/restart/exact resume, receipt acknowledgment ambiguity,
replacement refusal, completed-then-new restore, unchanged high-water, and
authenticated but semantically invalid event chains. They also cover altered
input with an unchanged resulting projection, durable-prefix mismatch, and strict
whole-string validation. These are process-reopen and injected I/O failures, not
physical power-loss tests. No rows are silently inferred to be persisted.

The prior **72/72** result is historical and does not validate the revised code:
`/tmp/ci-safety-journal-final-72.log` (SHA-256
`237ffeb7f459b58d847917619580130f2de571d09a6e0a69d6433c8d917fb5ff`)
and `/tmp/ci-safety-journal-final-72.xml` (JUnit, SHA-256
`1d5d175b184652853e1f7ccc636c01057f1b1085cdb669a5d0b98cbfcf2b8321`).
The earlier implementation candidate SHA-256 was
`3b0fa354a63bebc35cf9bf09722e46e56972a72f229098ceb7a1bd970a65c5a6`;
test file SHA-256 was
`be4fe030dd06d22db67916960566c86aa5ab2606b8a54bdf82b3802a73f14eea`.
That candidate retained high-water but allowed an interrupted restore to be
replaced before all input obligations were imported (**high severity**: omitted
cost holds could permit an incomplete budget projection). The first revised run
was 71/72 because its old regression expected the unsafe replacement to succeed;
the regression now asserts refusal and exact recovery. Its log is
`/tmp/ci-safety-journal-2026-10-03-first.log`. This supersedes the old behavior and
does not add old test counts to the new result.

**Evidence correction (2026-10-03):** the earlier report's Medium claim that the
original UUID/hash/identifier/money validators accepted trailing line terminators
is retracted. It was recorded without first reproducing a failure in the original
patterns. A direct probe of those unchanged, unflagged JavaScript `/^...$/`
patterns on Node `v26.5.0` accepted all four valid controls and rejected all 20
suffix cases (LF, CR, CRLF, U+2028, U+2029 for each pattern). Evidence is preserved
in `/tmp/ci-journal-original-regex-probe-2026-10-03.json`. The explicit full-match
comparison and additional cases remain defensive clarity and validation coverage;
they do not count as a discovered or fixed bug. The recorded 101/106 test pass
results remain valid, but passing those added cases does not prove the old code
failed them. The reproduced restore-omission High and key-copy ownership Medium
findings and their independent evidence are unaffected.

Cases use fresh temporary userData, synthetic keys,
fake PG/usage/health acknowledgments,
and fake provider counters. They cover concurrent UUIDs, two live requests,
restarts, wrong payloads, fsync/rename/directory-sync boundaries, no permit on
failure, partial tails/corruption/major mismatch, retained stale locks, numeric
boundaries, known/unknown/conflicting settlement, old restore union, clock/build
rollback, purpose-separated key rotation, and source-vault path coexistence.
The existing opaque base64url installation identity remains unchanged across
restart without loosening request UUIDs.

No real provider/account, credential, OS secure storage, installed userData,
GUI/audio, Gradle, Xcode, signing, or paid call is used. The tests are authored
module regressions, not the complete C13 minimum-30 product-provider corpus or C16
restore acceptance. Native sandbox proof, trusted production adapter wiring,
credential-free format3, all provider entrypoint enforcement, actual power-loss
proof, and rollback-resistant product recovery remain open. Ordinary filesystem
fsync/HMAC does not defeat malicious same-account replacement of all safety state
or provide a hardware monotonic counter.
