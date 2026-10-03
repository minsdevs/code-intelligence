# Main-only encrypted backup recovery records — 2026-10-03

This is a bounded durable evidence primitive for the T09 coordinator, outside ordinary restore area A. It does not restore PostgreSQL, move sources, authenticate a database OID, inspect live user data, change safety journal B, activate AI, or implement a startup recovery decision. Authenticated decoded JSON is **not authority**. The fixed main coordinator must check its versioned input schema, B's pending transaction/receipt, PG identities and projection, and source identities before using any recovered input.

Ownership for this slice is limited to `desktop/src/backup-recovery-records.cjs`, `desktop/test/backup-recovery-records.test.cjs`, and this document. Previously frozen journal/lifecycle/egress/gateway files are unchanged. The policy follows frozen05 §§5/7 and ADR-02's independent, retained K-backup keys; it does not rewrap or restore installation identity or B.

## API

```js
const records = await createBackupRecoveryRecords({
  root,                 // Canonical absolute userData/backup-maintenance, outside all A roots.
  installationId,       // Existing bounded base64url installation identity, never newly generated here.
  runningBuild,         // Canonical nonnegative decimal string, <= signed int64 maximum.
  keyProvider: {
    currentKeyId,        // await currentKeyId('backup') -> exactly 32 lowercase hex characters.
    getBackupKey,        // await getBackupKey(id) -> caller-owned fresh 32-byte Buffer.
  },
  verifyCompletion,     // Optional at open; mandatory, fixed and affirmative for complete.
  verifyCollection,     // Optional at open; mandatory, fixed and affirmative for collection writes/retries.
  initialize: false,    // Default: open existing root only, without writing.
});

await records.begin({ transactionId, kind: 'BACKUP' | 'RESTORE', input });
await records.append({ transactionId, phase, data });
await records.read();
await records.readTransaction({ transactionId });
await records.complete({ transactionId, receipt });
await records.beginCollection({ transactionId, manifestSha256 });
await records.finishCollection({ transactionId, manifestSha256 });
await records.close();
```

Each operation returns the same deeply frozen read view except `readTransaction`, described below, and `close`, which resolves without a value:

```js
{
  version: 1,
  minimumBuild: '3',
  head: { sequence: 1, hash: '64 lowercase hex characters' },
  active: null | {
    transactionId, kind, input, phase,
    records: [{ sequence, phase, data, hash }],
    markerPresent: true | false,
    completionReceiptPresent: true | false,
  },
  completed: [{ transactionId, kind, sequence, receipt }],
  collections: [{ transactionId, manifestSha256, state: 'BEGUN' | 'COMPLETED' }],
}
```

`head.hash` is the final encrypted record hash, or the enrollment hash when there are no records. `minimumBuild` is the maximum authenticated file build requirement, not permission to alter B's updater minimumVersion. `input` equals the PREPARED record data. A recovered active-less transaction has `active !== null` and `markerPresent:false`; this is not a fresh store. `completed` contains only transactions whose COMPLETED record and matching encrypted receipt are both present and no longer active. `read()` returns only the current transaction's full phase history; `readTransaction` additionally permits an exact historical lookup. GC events advance the global head while leaving `active`, completed transaction ordering, receipt values, and each transaction's ordinary phase history unchanged.

`begin` writes PREPARED and rejects reused UUIDs, any existing active transaction, or an unfinished collection. UUIDs must use the canonical lowercase RFC variant and a version 1–8 nibble. `append` accepts exactly `MERGED`, `SEALED`, `STAGED`, `DATABASE_SWAPPED`, `SOURCES_SWAPPED`, `HEALTH_VERIFIED`, `RETENTION_READY`, or `ROLLED_BACK`. The nonterminal phases may repeat, including multiple source rename acknowledgements and a second MERGED phase. Their product ordering is the coordinator's responsibility. Once any ROLLED_BACK record exists in the transaction, only HEALTH_VERIFIED, RETENTION_READY, and `complete` may follow. This restriction survives those later phases and reopening; MERGED/SEALED/STAGED/DATABASE_SWAPPED/SOURCES_SWAPPED and another ROLLED_BACK remain forbidden. PREPARED, COMPLETED, GC_BEGIN and GC_END cannot be appended through the generic method.

`verifyCompletion(snapshot, {transactionId, receipt})` is captured at factory creation, receives deeply frozen private copies/evidence, and must resolve to exactly `true`. A missing callback, false, object truthiness, or thrown error rejects completion without writing. The main factory must bind it to actual PG+B final receipt/readback verification, never a renderer-supplied callback or a generic JSON field. No authority callback can be registered later. The module rechecks every evidence file after the callback before writing completion. Changed receipt data cannot resume a previously written COMPLETED record.

All admitted operations serialize. Arguments are validated and privately captured synchronously before queueing; same-tick duplicate `begin` calls cannot produce two transactions. Pending operations are limited to 16. `close` immediately rejects new work, drains admitted work including a pending authority callback, releases in-process ownership, returns the same promise on repeated calls, and performs no disk writes. The module does not own or close the key provider. Main must await this close before closing the backup keyring. A callback that never finishes also prevents close from finishing; there is no unsafe forced shutdown beneath admitted work.

## Initialization and filesystem rules

Open and read never create a directory, clean a stale file, rewrite a record, or remove active evidence. `initialize:true` is an explicit exclusive `mkdir` of a missing root followed by encrypted enrollment publication. Its existing parent and root must be canonical private directories (0700, current uid). Existing directories, including empty ones or failed prior initialization, cannot be initialized again. There is no `reset`, repair, data deletion, or disk lock file. Collection methods append evidence only; the separately reviewed retention coordinator owns actual cleanup.

Main must enforce single-instance ownership and its runtime maintenance queue across processes. This module adds an in-process root owner registry and serialized operations, not a cross-process lease. Callers must canonicalize trusted OS aliases in the parent before passing the path. All traversed path components must be real nonsymlink directories; app-controlled aliases, symlink files, hardlinks, foreign ownership, unexpected permissions, changed inodes, changed sizes/timestamps, gaps, malformed filenames, unknown files, and trailing bytes are rejected. File access uses no-follow/nonblocking flags and pre/post identity checks. There is no native `openat`/directory-FD confinement guarantee against an adversarial same-user ancestor rename race. Windows is unsupported by this POSIX primitive.

The records root must remain outside every ordinary DB/source/cache restore root. The module only receives one root and cannot prove that relationship itself. Main must reject a missing root if B has pending work or a prior maintenance receipt, and must compare the last completed transaction/receipt against B on restart. Initialization is allowed only after explicit trusted enrollment checks; absence of active.enc alone is insufficient.

## File and encryption format

The root contains only:

- `enrollment.enc`: authenticated version 1 and independently random 128-bit root ID.
- `record-00000001.enc`, monotonically increasing without gaps, at most 4096 records.
- `active.enc`: encrypted transaction ID/kind and the PREPARED sequence/ciphertext hash. It is immutable during a transaction, including appends.
- `receipt-000000NN.enc`: encrypted completion proof referencing exactly the corresponding COMPLETED ciphertext hash and receipt value.

Every file is private0600 with nlink1. Records, enrollment, and receipts are never overwritten or removed. The encrypted active marker is exclusively created and removed only after a verified completion proof is durable. A subsequent transaction gets a fresh marker; old encrypted history and keys remain.

Envelope framing is `CIBREC01` (8 bytes), a big-endian uint32 canonical JSON header size (<=4096), the header, and exactly the declared ciphertext length. The core metadata includes version, domain-separated installation hash, root ID, filename, role, retained backup key ID, minimum build, plaintext byte count, and SHA-256. A fresh independent random 256-bit DEK encrypts each file using AES-256-GCM with random 96-bit nonce and 128-bit tag. K-backup wraps the DEK with a separate random nonce. Domain-separated AAD binds the entire immutable core; payload AAD additionally binds the complete wrapped DEK. Canonical header and body re-encoding, exact EOF, content hash, key purpose/installation/root/name binding, and record sequence/previous-ciphertext-hash are all checked. An unknown version or too-old running build is rejected. There is no plaintext fallback or executable archive interpretation.

`getBackupKey` results are transferred caller-owned copies. They are zeroed in `finally`, including invalid-length buffers and authentication failures; DEK/plaintext byte buffers are likewise cleared. Retained keyring originals remain valid and old key IDs remain readable after rotation. JavaScript strings/objects returned to trusted main cannot be reliably zeroized, and neither can engine/crypto internal copies; this is not a heap erasure guarantee. Do not expose the facade, decoded evidence, callbacks, keys, or full records through renderer IPC, sockets, workers, environment variables, or logs.

The JSON codec accepts plain or null-prototype objects, dense ordinary arrays, strings with valid Unicode, booleans, null, finite numbers, and safe integer numbers. It rejects proxies without calling traps, accessors without invoking getters, custom prototypes, symbols, nonenumerable properties, extra array properties, cycles, undefined, bigint, functions, Date, Buffer, nonfinite numbers, negative zero, and unsafe integer numbers. Canonical sorted-object encoding must roundtrip byte-for-byte. Large identifiers, money and lossless decimals belong in already normalized strings. Values already rounded or transformed by an upstream codec cannot be reconstructed; this module does not claim lossless PostgreSQL decoding or credential removal.

The fixed capacity is **64MiB cumulative canonical plaintext across all retained files**, plus bounded envelope overhead, at most 4096 records, maximum JSON depth64 and 250,000 nodes per value. Ordinary record count checks reserve one final sequence for completion. A fresh GC_BEGIN reserves both sequence numbers and the exact canonical plaintext bytes for its corresponding GC_END. There is no automatic history pruning, and collecting recovery trees does not reclaim this encrypted evidence history. Main must budget enough byte capacity for final transaction receipts; oversized receipt/input/phase data fails closed. Payloads are bounded in memory, not streamed; transient memory can exceed plaintext size due to canonical encoding, crypto and detached JS objects. This primitive is for normalized maintenance inputs, not source blobs or whole DB exports.

## Durability and interrupted operations

A fresh final filename is created with O_EXCL, written completely, file-fsynced, directory-fsynced, then read back from the same inode and authenticated before success. Existing destinations are never replaced. This is an exclusive single-writer publication with durable readback, **not atomic replacement of a partial final file**. If a write is torn or authentication fails, the owned partial final file remains evidence; close/reopen does not truncate/delete it, and initialization cannot reset it. Such a case requires a separate reviewed recovery procedure and is not silently repaired by this module. Main must not advance A/B based on an unacknowledged call.

Errors from a partial write/fsync/readback poison the handle; close and reopen are required. Files that were completely written may still authenticate after an uncertain ACK. Opening or reading that evidence never writes. A read does not itself fsync or turn uncertain durability into an authority receipt. The next explicit permitted write performs its own file/root sync and revalidation. Error messages are static and exclude inputs, paths, provider messages and causes.

| Interruption | Authenticated read result / permitted next action |
| --- | --- |
| PREPARED complete, active marker not created | `active` returns the exact input with markerPresent=false; new begin is blocked. After main verifies B/PG/source, same-transaction append/complete explicitly publishes the marker. |
| An immutable record is partially written | Authentication/framing fails; no read acknowledgement, no truncation or automatic cleanup. |
| COMPLETED durable, receipt publication absent | Active remains at COMPLETED, completionReceiptPresent=false; only the exact receipt with a new authoritative verification may finish. |
| Receipt durable, active unlink absent/failed | Active remains at COMPLETED with completionReceiptPresent=true; exact verified complete retries do not append another completion. |
| Active removed, following directory fsync/ACK failed | Completed evidence remains; close/reopen/read may return active=null and the matching completed receipt. Main checks this against B. Calling complete again with no active transaction is rejected; read is the recovery lookup. |
| Existing active marker disappears | While open, prior-file tracking rejects disappearance. On restart, the last unfinished transaction remains active from its immutable records; it is never treated as fresh. |

An active marker anchors PREPARED, not the latest phase. As with an ordinary authenticated journal without an external monotonic counter, deletion/rollback of an entire valid history suffix after restart cannot always be distinguished from an earlier valid prefix using this directory alone. In-process tracking rejects removal/replacement of previously observed files. Restart **must** reconcile the exact transaction, normalized merge input, phases and completed receipt against independently preserved B and PG/source identities. This module does not protect against a malicious same-OS-account complete directory rollback, authorize recovery from missing B, or choose rollback versus roll-forward policy.

## Authenticated transaction lookup and retention evidence

`readTransaction({transactionId})` validates the exact own-data argument, authenticates the entire current store, and returns `null` if the canonical UUID is not present. Otherwise it returns a fresh deeply frozen view:

```js
{
  transactionId, kind, input, phase,
  records: [{ sequence, phase, data, hash }],
  receipt: null | verifiedCompletionReceipt,
  status: 'ACTIVE' | 'COMPLETED',
  markerPresent: true | false,
  completionReceiptPresent: true | false,
}
```

`input` is the exact normalized PREPARED payload, `records` contains all ordinary phases including COMPLETED when present, and `receipt` is returned only when the separate authenticated matching receipt exists. An interrupted COMPLETED publication can therefore have `status:'ACTIVE'`, a COMPLETED phase, and `receipt:null`. A surviving active marker also keeps a receipt-bearing transaction ACTIVE until its verified completion finishes. Collection tombstones do not alter this history. The codec's existing cumulative bytes/nodes/depth and record limits bound the lookup; no new unbounded plaintext source is read. Reads and close remain byte-preserving and do not fsync. The returned private evidence is not a path, database, shell-command, cleanup, or restore authorization.

RETENTION_READY stores the trusted coordinator's normalized manifest as `data`, without a second wrapper. The retention coordinator's current manifest contract is `{root:{dev,ino},checkpoint:{bytes,sha256},databases:[{slot,oid}],topLevel:[{name,type,dev,ino}]}`. That separate coordinator validates exact fields, permitted slot/name/type values, live identities, checkpoint contents, references, and absence of unknown entries. This record module does not derive those facts from a JSON label. The binding is SHA-256 of UTF-8 canonical JSON (object keys recursively sorted, array order preserved, no whitespace), using the existing normalized JSON codec. The **last** RETENTION_READY before transaction completion supplies the binding. A recovery may record a changed manifest after rollback; all earlier evidence remains in the chain and cannot be rewritten. Completed transactions accept no further ordinary phases. A historical completion without RETENTION_READY can still be read but is ineligible for collection.

`beginCollection` and `finishCollection` accept exactly `{transactionId,manifestSha256}` with a canonical lowercase UUID and 64 lowercase hex hash. They operate only on an authenticated completed transaction with a matching final retention manifest and matching completion receipt. The newest **two completed transactions are always protected**, including transactions whose own collection is already complete when ordering older history; GC events never count as additional completed backups/restores. A live ordinary transaction blocks all collection operations. A BEGUN collection blocks new ordinary transactions and any other collection. This primitive provides that minimum defense; it does not decide whether an older tree is unreferenced or safe to delete.

The factory captures `verifyCollection(snapshot,{transactionId,manifestSha256,operation:'BEGIN'|'END'})` once. Every write or exact retry requires its return value to be exactly `true`; missing, false, truthy-object, or throwing callbacks produce `BACKUP_RECOVERY_COLLECTION_UNVERIFIED` with no new record. Both arguments are frozen. After the asynchronous callback, all evidence files are revalidated before mutation. Callbacks run inside the same serialized queue and must not reenter this facade and await another operation. Main must bind the callback to independently validated B, current state, recency and manifest evidence; renderer callbacks or decoded booleans are not authority.

GC_BEGIN and GC_END are immutable encrypted records in the **same** global sequence/previous-ciphertext-hash chain. Their data is exactly `{manifestSha256}`. Replay verifies target completion, recency at that point, kind, final manifest binding, a single outstanding begin, matching begin-before-end, and no duplicate or orphan events. No active marker or new completion receipt is created for GC. `read().collections` is a separate tombstone projection: `{transactionId,manifestSha256,state:'BEGUN'|'COMPLETED'}`. A BEGUN entry remains pending across restart even though `active` is null; main must inspect both fields. The retention coordinator must reread the authenticated matching tombstone before starting deletion or acknowledging completion.

Only exact-input retries are idempotent. BEGIN repeated after END returns the existing COMPLETED projection, never a fresh deletion permission. END before BEGIN is rejected. Exact retries require authority again and fsync the original event inode plus its directory, authenticate/revalidate it, and return without appending, replacing or removing files. Before a fresh END is appended, its original BEGIN is synced as well. This matters after a fully written file with an uncertain fsync/ACK: a read alone does not reestablish durability. A failed retry poisons the handle; a torn event, missing prerequisite receipt, resurrected active marker, invalid chain or ambiguous orphan remains fail-closed evidence. Historical records/receipts/enrollment are never garbage-collected by this API.

This extension does not implement an OS lease, retention deletion, database teardown, automatic product startup recovery, B reconciliation, rollback selection, free-space admission or a new key lifecycle. Those remain independently reviewed coordinator boundaries. A valid authenticated prefix after a complete external history rollback still needs the external B/PG/source reconciliation described above.

## Validation and remaining gates

The initial synthetic Node run had 89/91 pass with two fixture defects: the helper default replaced explicit undefined, and the synthetic keyring teardown ran after fixture directory cleanup. Both fixtures were corrected; neither was a production failure. The intermediate runs passed 115/115 and 116/116. The final candidate passed **117/117, zero failure/error/skip/cancel**, including real purpose-keyring composition with a synthetic in-memory wrapper, repeated phases, retained key rotation/restart, private key-copy clearing, plaintext buffer clearing on random-key generation failure, strict JSON/canonical malformed authenticated inputs, cross-installation/binding/tamper/trailing checks, paths/permissions/identity, 33MiB input/completion and cumulative 64MiB rejection, queue/close barriers, fixed completion callback, write/readback/fsync/active/receipt fault injection, and unchanged read/reopen/close files. Both new JavaScript files pass `node --check`; `git diff --check` passes. No full desktop suite or Gradle invocation is claimed by this slice.

Final candidate logs/XML are `/tmp/ci-backup-recovery-records-final-2026-10-03.log` and `.xml`. Counts and SHA evidence are recorded in the author freeze manifest under `/tmp/ci-backup-recovery-records-freeze-2026-10-03.json`; the initial and intermediate logs/XML use separate filenames and remain historical. This contract is a component result only. Independent review, coordinator binding, actual PG+B receipt checks, source swap/restart recovery, real OS key wrapping, power-loss durability, installer/signing/update and release validation are separate gates. No real DB, actual keychain, GUI, network or provider calls are part of these tests.

## Addendum: HEALTH_VERIFIED evidence phase

The main coordinator's health-before-completion ordering requires an explicit `HEALTH_VERIFIED` record. This revision adds only that value to the production append-phase allowlist. Its data remains opaque normalized main evidence; accepting the phase does not perform health checks, verify the backend admission barrier, change B, release the gateway, or replace `verifyCompletion`. Main owns the intended sequence: backend startup with admission blocked and health/STATUS DRAINED verification, then HEALTH_VERIFIED, B completion and final PG readback, records completion, gateway release, and HTTP END/UI publication. The record primitive continues to leave product phase ordering to main.

One new regression first failed against the prior production enum with `BACKUP_RECOVERY_ARGUMENT` (1 selected test, 1 expected failure). The revised module passes **118/118, failure/error/skip/cancel0**, including the new phase's exact data roundtrip, unchanged close/reopen/read files, and continued rejection of completion without a true fixed authority callback. Source and test syntax checks plus `git diff --check` pass. Evidence uses `/tmp/ci-backup-recovery-records-health-red-2026-10-03.log`/`.xml` and `/tmp/ci-backup-recovery-records-health-final-2026-10-03.log`/`.xml`; the new freeze manifest is `/tmp/ci-backup-recovery-records-health-freeze-2026-10-03.json`. Earlier 117-test final artifacts and the original freeze manifest remain unchanged historical evidence. No other production source was modified by this amendment, and no live health/recovery integration acceptance is claimed.

## Addendum: resume lookup and durable collection evidence validation

The resume/retention extension preserves all original 118 cases and adds 46 cases. Its first intermediate run passed 154/154; after the requested rollback-history exception and original-BEGIN durability check, the current targeted suite passes **164/164 with zero failure/error/skip/cancel**. The final XML was parsed separately to confirm 164 testcase elements and no failure/error/skipped elements. Both JavaScript files pass `node --check`; the three owned files have no whitespace-check diagnostics.

Added coverage includes immutable private active/completed lookups and missing receipt/marker states; full retention history and final-manifest binding after rollback; separate collection projection and unchanged earlier encrypted files; protected newest two completions; missing manifest/authority and malformed exact inputs; captured callbacks, exact-true checks and post-callback file revalidation; serialized duplicates, blocked new work, close/drain; no generic GC append; changed/unknown target, mismatched kind/hash, orphan/duplicate/end-before-begin authenticated replay; false active-marker resurrection and missing prerequisite receipts; GC BEGIN/END file/directory fsync failures, read-only reopen and exact durable retry; torn GC evidence; and historical rollback enforcement after HEALTH_VERIFIED/RETENTION_READY and restart. These use synthetic identities, keys, manifests and trusted callback doubles with real private temporary files and authenticated encryption. They do not delete real recovery trees or exercise database/B authority, OS key wrapping, process-kill/power-loss recovery, free-space admission, or the integrated app.

Evidence is `/tmp/ci-backup-resume-records-first-2026-10-03.log`/`.xml` (historical 154-case intermediate) and `/tmp/ci-backup-resume-records-second-2026-10-03.log`/`.xml` (current 164-case candidate). `/tmp/ci-backup-resume-records-freeze-2026-10-03.json` records the source/test/contract hashes and verification scope. Prior 117/118-case artifacts are untouched. This is author verification of the records component; independent review and root coordinator/retention integration remain separate gates. No full desktop run, Gradle, database, GUI, provider or external network execution is claimed here.

## Addendum: authenticated recovery scratch ownership

`registerScratch({transactionId,relativeDirectory,directoryIdentity,payloadIdentity,payloadSha256})`
records the trusted coordinator's already inspected plaintext payload ownership. All five fields
are required own enumerable scalar data properties. The transaction is a canonical lowercase UUID;
relativeDirectory is exactly `verification/verify-checkpoint-<UUID>`,
`verification/verify-incoming-<UUID>`, or `verification/verify-product-<UUID>`. No absolute path,
extra segment, dot segment, alternate casing or trailing separator is accepted. Each identity is
two canonical unsigned 64-bit decimal strings joined by one colon (`dev:ino`), and payloadSha256
is exactly 64 lowercase hexadecimal characters. Getter/proxy inputs are rejected without access.
The module does not open the referenced payload or infer ownership merely from these strings.

An immutable `RECOVERY_SCRATCH` event belongs to the existing global encrypted sequence/hash chain.
Its envelope binds the current transaction and kind, and its exact data consists of the other four
fields. `read().scratches` is a separate deeply frozen array of the five-field inputs. It retains
historical registrations across completion, later transactions and collection. A scratch event
advances only the global head; it does not appear in ordinary `active.records` or
`readTransaction().records`, change `active.phase`, create a transaction, replace a completion
receipt, move its original sequence, change recency, or act as a collection tombstone.

Registration requires the same currently active transaction. This includes recovery after
ROLLED_BACK and after a durable COMPLETED event whose receipt/active-marker cleanup is unfinished.
The rollback restriction on further A mutation phases remains in force. A transaction whose
completion is fully acknowledged and whose active marker is absent cannot register further
scratch, even through an otherwise exact retry. Replay permits the historical side events around
an interrupted completion, but rejects an unknown/different current transaction or kind, a scratch
before PREPARED, duplicate directory bindings, malformed fields, or events after collection has
started. Generic `append` cannot manufacture a RECOVERY_SCRATCH event.

A transaction may register at most 256 distinct relative directories. The existing 4096-event and
cumulative 64MiB plaintext limits still apply, with one ordinary completion slot retained for an
unfinished transaction. Repeating exactly the same directory, inode pair and hash is idempotent:
the original event inode and containing directory are fsynced and revalidated; no event is appended
or rewritten. A different identity/hash for the same transaction/directory is refused. Exact retries
are still allowed at the 256-directory bound while the transaction remains active. Ambiguous fsync
or readback failure poisons the handle; a complete event may be reauthenticated on explicit reopen
and durably retried. Torn events remain unchanged fail-closed evidence.

The coordinator must register each successfully inspected/decrypted or re-exported payload before
advancing recovery. Before claiming completion it must preflight **all** scratch registered for that
transaction against the fixed transaction root, exact parent/file identities, canonical private
paths and content hashes, then remove only the verified payloads. An already missing payload needs
the original verified parent identity. Unknown children or replacements are not cleanup permission.
A kill during writing before registration can leave unregistered scratch: automatic completion must
refuse and preserve it instead of guessing names or recursively deleting it. This extension does
not promise arbitrary torn-write recovery, power-loss repair, filesystem authority, or secure heap/
storage erasure. It adds no restore, DB, key, network or renderer authority.

This amendment addresses a coordinator regression found by an independent runtime review: a
failed verification followed by a successful retry could retain two (backup) or three (restore)
plaintext payloads from the previous attempt while declaring completion. The original RED evidence
is preserved separately as `/tmp/ci-backup-resume-runtime-independent-counterexamples-first-2026-10-03.xml`.
The reviewer was subsequently authorized to author this records extension; its component tests are
author verification and must not be represented as an independent review of this new implementation.
Root's coordinator wiring and integration regressions remain separate acceptance evidence.

The scratch candidate preserves the preceding 164 tests and adds 39, passing **203/203 with zero
failure/error/skip/cancel** in the targeted author run. Tests cover the three fixed directory roles,
full-string/canonical identity limits, getter/proxy capture, wrong or missing active transactions,
generic-phase rejection, exact retries and conflicting bindings, encrypted history/read-only replay,
rollback restrictions, interrupted COMPLETED receipt/marker preservation, malformed authenticated
replay, fsync uncertainty and exact retry, torn evidence, and a real 256-registration per-transaction
bound (including retry at that bound and a subsequent transaction). Node syntax checks and scoped
whitespace checks pass. Log/XML use `/tmp/ci-backup-resume-records-scratch-first-2026-10-03.*`;
source/test/contract hashes and scope are in `/tmp/ci-backup-resume-records-scratch-freeze-2026-10-03.json`.
Earlier records runs and runtime counterexamples remain unchanged. Coordinator cleanup, actual
process interruption and root's full gates are not established by this author component result.
