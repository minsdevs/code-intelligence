# Purpose-isolated main-process keyring (2026-10-03)

Status: isolated T09/T08 primitive. This implements the `K-backup[v]` and `K-safety[v]`
inventory from [ADR-02](../multilanguage-plan-2026-10-02/05-security-performance-operations.md#7-adr-02-복원-밖에-남는-안전-상태와-키-수명).
It is not a production safeStorage adapter, archive implementation, cost gateway, or installed-app
validation. The source-vault inventory remains separate, and no existing credential/source key is used.

## Main-only API and lifecycle

```js
const { initializePurposeKeyring, openPurposeKeyring } = require('./purpose-keyring.cjs');
const keys = await openPurposeKeyring({
  safetyRoot,                        // canonical absolute private safety directory
  restoreRoots: [databaseRoot, sourceRoot], // all ordinary restore/swap roots; required, nonempty
  installationId,                   // existing installation identity, never regenerated here
  wrapper: { isAvailable, wrap, unwrap }, // trusted main-process secure-storage adapter
});
const journalKeyProvider = keys;    // currentKeyId('safety'), getMacKey(keyId, 'safety')
const backupId = await keys.currentKeyId('backup');
const backupKey = await keys.getBackupKey(backupId);
try { /* main-only archive DEK wrapping, implemented separately */ }
finally { backupKey.fill(0); }
```

`initializePurposeKeyring(options)` is an explicit first-use operation. `openPurposeKeyring(options)`
never generates keys. Initialization can use an existing private `safetyRoot` alongside `source-vault`,
`ai-journal`, and the AI OFF latch, but exclusively creates its own `purpose-keyring` directory.
An existing owned directory, even empty or missing its key file, prevents initialization. A failed
initialization leaves this marker, so callers must not retry initialization as a recovery strategy.

The returned object is frozen and exposes only:

| Method | Behavior |
| --- | --- |
| `currentKeyId('backup' \| 'safety')` | Asynchronously returns the durable active key ID of that purpose |
| `getMacKey(keyId, 'safety')` | Returns a fresh 32-byte copy of that retained safety key; the purpose argument is mandatory |
| `getBackupKey(keyId)` | Returns a fresh 32-byte copy of that retained backup key |
| `rotate('backup' \| 'safety')` | Durably adds an independent random key for that purpose and returns its new ID |
| `info()` | Returns frozen metadata/IDs/revisions/limits only, with no key bytes |
| `close()` | Stops accepting operations, drains accepted operations, clears internal key buffers, removes only its owned lock, and fsyncs the directory |

All methods are asynchronous. There is no generic `getKey`/export/import/delete API. The keyring object
and returned copies are for trusted main-process code only: do not expose them to renderers, IPC,
sockets, HTTP, child processes, environment variables, diagnostics, or backups. Callers must clear their
owned key copies in `finally`. Closing or rotating the keyring does not mutate copies already returned
to callers. Internal buffers and temporary serialization buffers are cleared when practical; JavaScript
strings, the full heap, swap, dumps, and SSD secure erasure are not covered by this guarantee.

The journal's `getMacKey` port follows this transfer-of-ownership contract. Its consumer clears both
the transferred Buffer and its internal HMAC copy in `finally`, including invalid Buffer lengths and
HMAC failures. Providers must return fresh copies instead of lending their retained verification keys.
The `journalKeyProvider = keys` example above is covered by real-module integration tests (with a
synthetic wrapper); the journal does not require an additional key-copy adapter.

The adapter's `isAvailable()` must return the boolean `true`; plaintext fallback is forbidden.
`wrap(Buffer)` and `unwrap(Buffer)` may be asynchronous, must return fresh owned `Buffer` instances,
and must provide authenticated OS-backed confidentiality. Their inputs must not be retained. The
keyring copies wrapped output, verifies its round trip before publication, clears borrowed plaintext
afterward, and validates decrypted payload structure/binding on open. The synthetic AES-GCM wrapper
in tests is not production secure storage. Availability is checked on initialization/open and before
each operation. Availability loss makes the current handle unusable until close and successful reopen.

## Format, purpose separation, and bounds

Files belong to safety area B, outside all ordinary restore roots:

```text
safetyRoot/
  purpose-keyring/
    purpose-keyring.wrapped
    owner.lock
    .pending-<32 lowercase hex>    # temporary wrapped ciphertext during a write
```

Only wrapped ciphertext is persisted. The authenticated plaintext format is canonical UTF-8 JSON with
`format: code-intelligence-purpose-keyring`, `major: 1`, exact installation ID, total key-count revision,
and exactly the ordered `backup` and `safety` inventories. Each inventory binds its purpose, revision,
active key ID, and ordered key records. The active ID is the last retained record and revision is the
inventory count. Each key is independently generated with `crypto.randomBytes(32)` and each ID with
`crypto.randomBytes(16)`, encoded as 32 lowercase hex characters. Key IDs and key material are checked
for uniqueness across both inventories. Rotation preserves every old key and the other purpose's
active key. No automatic retirement or general restore replacement is supported.

The exact installation identity grammar is 1–128 ASCII base64url characters (`A–Z`, `a–z`, `0–9`, `_`,
`-`), including a leading underscore or hyphen. It is payload binding, never a path component. Source or
credential purpose payloads, wrong installations, duplicate/unknown members, noncanonical encodings,
invalid key lengths/base64, changed revision/active ID, truncation, and unknown majors are refused.
An authenticated wrapper does not bypass these checks. Copies of a backup ID cannot retrieve a safety
key, or vice versa.

Default hard ceilings are 64 retained keys **per purpose**, 32 KiB decrypted keyring, 64 KiB wrapped
file, 16 accepted pending operations, and 32 supplied ordinary restore roots. Optional `limits`
(`keysPerPurpose`, `keyringBytes`, `wrappedBytes`, `pendingOperations`) can only lower these ceilings.
Reads check file size before allocation. Unknown key-directory entries and crash-left temporary files
require recovery instead of being ignored or deleted. Key-count exhaustion blocks further rotation
without affecting existing reads; reaching a write/format limit after a rotation begins requires close
and reopen. There is no unlimited key growth or background GC.

## Filesystem and publication contract

This module requires POSIX ownership, `O_NOFOLLOW`, directory descriptors, and file/directory fsync.
Callers canonicalize the trusted existing OS parent before appending managed names (macOS `/tmp`
and `/var` aliases must resolve to their `/private/...` paths). The private parent and managed directories
must already have mode 0700/current-user ownership; managed files must be regular 0600/current-user,
single-link files. The module creates only its own leaf safety directory if absent and owned descendants.
It refuses unsafe existing permissions instead of repairing them. Symlink ancestors, symlink/hardlink
key files, special files, replaced roots, changed key file identity/state, and foreign writer locks fail
closed. These are JavaScript pathname/identity checks, **not native descriptor-relative ancestor-race
confinement** or protection against malicious control of the same OS account.

Every supplied ordinary restore root is checked for canonical, nonsymlink existing ancestry; missing
leaf paths are allowed. Equal/ancestor/descendant overlap with `safetyRoot` is rejected. The configured
list is copied and checked again before key use. This enforces the configured separation; the caller
must enumerate every actual restore/swap root and route those operations through the restore policy.
The keyring cannot stop another subsystem from writing an undeclared path.

Publication order is owned writer lock → canonical serialization → secure wrapping plus unwrap
round-trip check → exclusive 0600 random temporary file → complete write → file fsync → identity/state
checks → rename → containing-directory fsync → bounded reread/byte comparison → root/lock verification
→ success. Parent creation and lock creation are also synced before use. Rotation atomically replaces
one complete wrapped file containing all previous keys. A failure never acknowledges successful
rotation, even if a complete new file has already been renamed into place. Reopening then validates
whichever complete inventory is present; unacknowledged publication is not claimed durable.

Reads, current-ID lookup, metadata lookup, and rotation share one bounded serialized queue. Close
rejects new calls, drains all already accepted work in order, clears the owned buffers, and releases the
lock. Concurrent close calls share one promise. A failed rotation or lost integrity/availability poisons
the handle, including queued operations, so cached keys cannot silently bypass a damaged/missing
inventory. No key deletion/reset, automatic lock expiry, or PID-based stale-lock override exists.
Closing verifies lock ownership and preserves a replacement lock. A crashed process requires explicit
recovery tooling before reopening; this primitive does not implement it.

## Validation and remaining gates

Focused commands:

```sh
node --check desktop/src/purpose-keyring.cjs
node --check desktop/test/purpose-keyring.test.cjs
node --test desktop/test/purpose-keyring.test.cjs
```

Fixtures cover independent purposes, explicit purpose/installation substitution, private-copy behavior,
restart and retained versions, canonical payload validation, wrapper availability/failures, private
paths and restore-root overlap, lock ownership, pending-operation/key/byte ceilings, concurrent
initialize/read/rotate/close, and fault injection at `keyring:temp-written`, `keyring:file-synced`,
`keyring:before-rename`, `keyring:renamed`, and `keyring:directory-synced`. The fault callbacks exercise
publication decisions; they are not real power interruption or a filesystem driver fault test. A trusted
wrapper or blocked filesystem syscall can still stall an in-flight operation/close; queue bounds limit
admitted work but do not claim native cancellation.

Isolated keyring baseline: **79/79 Node tests PASS**, zero failures/cancellations/skips, on Node `v26.5.0`.
Both `.cjs` syntax checks PASS. Evidence: `/tmp/ci-purpose-keyring-test.log` and
`/tmp/ci-purpose-keyring-test.xml`. The first run had one fixture-only failure: a symlink test left its
saved file inside the owned directory, correctly triggering the unexpected-entry guard before the
symlink check. Moving that synthetic saved file outside the owned directory made the intended check
reachable; no production check was weakened. The full 79-test rerun passed.

Independent integration review subsequently found a medium consumer ownership mismatch in the
journal: it copied the returned key again and only cleared that second Buffer. The keyring's core copy
semantics were correct; the journal was changed to clear the transferred Buffer too, and its synthetic
providers now return fresh owned copies. The preserved independent reproduction is
`/tmp/ci-purpose-keyring-review-interop-2026-10-03.json`. The original 79-test keyring result alone
does not validate this fix. The latest separate journal and real-module interop results are recorded
below; no real OS wrapping or production wiring is implied.

Ownership-fix validation: **106/106 journal tests PASS** and **3/3 new real keyring↔journal integration
tests PASS**, zero failures/skips/cancellations, Node `v26.5.0`. The keyring's production/test source
remained unchanged. These counts are separate from the earlier 101 journal and 79 keyring baselines.
Current evidence is `/tmp/ci-safety-journal-key-ownership.log`/`.xml` and
`/tmp/ci-safety-keyring-integration.log`/`.xml`; the [journal contract](safety-journal-contract-2026-10-02.md)
records exact current source/test/report hashes. Modified/new `.cjs` syntax checks PASS.
Independent re-review is pending. Integration fixtures observe each transferred Buffer after signing,
failed MAC authentication, rotation, and full keyring/journal reopen; every observed copy is zeroed,
while retained original keys still authenticate old records. Additional journal regressions cover
invalid 0/31/33-byte key responses and both Buffer copies when HMAC creation throws.

No real OS Keychain call, installed
application, native helper, production backup/restore, real provider cost path, or signed distribution
has been exercised by this primitive. Those remain separate implementation/acceptance gates.
