# T02 source vault: isolated storage primitive

This code slice implements the source-blob/keyring portion of
[architecture §4](../multilanguage-plan-2026-10-02/03-architecture-contracts.md#4-소스-저장보존과-migration)
and [ADR-02](../multilanguage-plan-2026-10-02/05-security-performance-operations.md#7-adr-02-복원-밖에-남는-안전-상태와-키-수명).
It is not wired into Electron main, backup/restore, the backend, or workers. Tests use synthetic wrapping
keys and disposable temporary files only. No installed application, userData, OS keychain, credentials,
network, or imported project is used.

## Main-owned API and ownership

```js
const { createSourceVault, openSourceVault } = require('./source-vault.cjs');
const vault = await openSourceVault({
  safetyRoot, sourceRoot, installationId,
  maxStoreBytes,   // Optional lower limit; default/ceiling 10 GiB of stored file bytes.
  maxStoreEntries, // Optional lower limit; default/ceiling 200,000 entries.
  wrapper: {
    isAvailable, // () => boolean | Promise<boolean>
    wrap,        // (Buffer) => Buffer | Promise<Buffer>
    unwrap,      // (Buffer) => Buffer | Promise<Buffer>
  },
  // Optional trusted test hook: (fixedStageName) => void | Promise<void>.
  // No path, key, or source content is passed to it.
  fault,
});
const blob = await vault.put({ projectId, bytes });
// { format: 1, projectId: string, sha256, byteSize, keyId, deduplicated }
const originalBytes = await vault.read({ projectId, sha256: blob.sha256, byteSize: blob.byteSize });
const inventory = vault.info();
// { format: 1, installationId, activeKeyId, keyIds,
//   store: { storedBytes, maxStoreBytes, entries, maxStoreEntries } }
const rotated = await vault.rotate(); // Same public metadata; old keys retained.
await vault.close();
```

`createSourceVault` has the same options, but is an explicit fresh-store operation. Its own
`safetyRoot/source-vault` directory must be newly created; preexisting `safetyRoot` may hold the journal.
Existing source entries, the dedicated key directory/keyring, or interrupted key-creation residue reject
creation. The dedicated directory is never automatically removed, so missing keys in a previously empty
store cannot be mistaken for fresh initialization. `openSourceVault` never creates
or replaces missing keys. An empty keyring is invalid. Missing keys mean unavailable retained source;
they do not authorize generating replacement keys.

The module owns only these locations:

| Location | Contents / ownership |
| --- | --- |
| `safetyRoot/source-vault/source-keyring.wrapped` | Source-purpose wrapped keyring; outside restore area A |
| `safetyRoot/source-vault/owner.lock` | Exclusive source-vault/store owner; sibling journals/brokers are independent |
| `safetyRoot/source-vault/.pending-<random32hex>` | Wrapped-key staging only |
| `sourceRoot/<projectId>/<plaintext-sha256>/blob.bin` | Immutable encrypted source envelope |
| `sourceRoot/<projectId>/<plaintext-sha256>/.pending-<random32hex>` | Ciphertext staging only |

The dedicated roots must be disjoint; neither may contain the other. The module does not claim exclusive
ownership over the whole `safetyRoot`. It never deletes another purpose's key or lock.

The API is for a trusted main-owned broker. A project namespace is not an end-user authorization check.
The future broker must validate job/project/generation ownership, approved manifest membership, exact
hash/size, request bounds, and caller capabilities before calling it. Keys are never returned by this API
or read from `TOKEN_ENC_KEY`, environment, renderer state, worker configuration, or backup files.

## Exact input and resource limits

| Input | Accepted contract |
| --- | --- |
| `installationId` | `/^[A-Za-z0-9_-]{1,128}$/`; includes main's base64url identities, including leading `_`/`-` |
| `projectId` | Canonical decimal string `1..9223372036854775807`, or a positive JS safe integer; output normalized to string |
| `sha256` | Exactly 64 lowercase hexadecimal characters; Git SHA-1/OID is not accepted as a substitute |
| `bytes` | `Buffer`/`Uint8Array`, copied synchronously before queueing; 0 through 2 MiB inclusive |
| `byteSize` | Required safe integer, 0 through 2 MiB inclusive |
| Blob header | At most 2,048 bytes before JSON parsing; exact versioned fields/canonical encoding |
| Blob file | At most `2 MiB + 2,048 + 12` bytes before allocation/read |
| Wrapped/unwrapped keyring | At most 64 KiB / 32 KiB before JSON parsing |
| Retained source keys | 1–64; rotation at the cap refuses instead of deleting keys |
| Outstanding operations | At most four, including the active operation; additional input is rejected before copying |
| Aggregate source quota | Default/ceiling 10 GiB, optional lower positive safe-integer `maxStoreBytes` |
| Source inventory walk | Depth three; default/ceiling 200,000 directory/file entries, optional lower positive `maxStoreEntries` |

The vault stores raw bytes, including invalid UTF-8. Encoding eligibility belongs to the importer/parser
contract; this module does not silently transcode or claim that arbitrary bytes are analyzable text.
Source filenames/paths are absent from the blob envelope. Installation/project IDs and plaintext hashes
are metadata, not encrypted metadata guarantees.

The quota counts **stored file lengths**, including ciphertext header/tag overhead and preserved
pending/orphan files. It does not claim filesystem block allocation (`st_blocks`), directory metadata,
compression, SSD consumption, or total installation disk usage. Keyring/journal storage in safety area B
is outside this source-store quota and has its own bounds. At open, a bounded streaming walk counts all
entries; it accepts only canonical project/hash directories and regular private `blob.bin` or
`.pending-<random32hex>` files. Unknown, linked, special, oversized, too-deep, or undiscovered entries
cause opening to fail. Incomplete hash directories are counted, and existing pending files are preserved.

The exclusive owner maintains a serialized ledger. A new put reserves the complete encoded envelope
length and all required project/hash/temp entries **before mkdir/write**. Rename reuses the temp entry.
The affected address is recounted after both successful and failed publication, so surviving ciphertext
and empty directory residue remain charged. This recount is limited to that address, avoiding a complete
store rescan per file. Other writers, restore, and cleanup must close/drain the vault first; live external
store mutations violate this ownership contract. Reopening recounts the store. Key rotation does not
reset accounting. Existing blobs remain readable/deduplicable when a lowered limit is below current
usage; new writes fail without destructive GC. Failed reservations cannot silently exceed the entry-walk
cap before restart. Filesystem free-space and installation-wide quota checks remain integration work.

## Encryption and envelope format 1

Each source key is an independent `crypto.randomBytes(32)` value. The complete source keyring is wrapped
through the injected trusted wrapper; its authenticated plaintext contains a fixed source purpose,
format major, installation identity, revision, active key ID, and every retained key. A wrong purpose,
identity, unknown major, unknown/duplicate JSON field, malformed key, or unavailable wrapper rejects
opening. Identity wrapping is rejected; production must supply a reviewed safeStorage adapter with no
plaintext fallback. The wrapper is a trust boundary, not a renderer extension point.

Blob layout is `CISRCBLB` (8 bytes), a big-endian 32-bit header length, canonical UTF-8 JSON header, then
ciphertext. Header fields, in canonical order, are `format`, `major`, `installationId`, `projectId`,
`keyId`, `sha256`, `byteSize`, `nonce`, and `tag`. `format` is `code-intelligence-source-blob`, major is 1.
AES-256-GCM uses an independent random 96-bit nonce and a 128-bit tag. AAD is the canonical header prefix
through `byteSize`, binding format/major, installation, project, source key ID, plaintext SHA-256, and
plaintext byte size. Nonce/tag encodings and lengths are checked. Unknown fields, duplicate fields,
reordered/noncanonical headers, unknown majors, truncation, extra bytes, cross-project copies, and
metadata/ciphertext tampering fail closed.

Reads require the caller's expected hash and byte size. The reader matches both against authenticated
metadata, decrypts with the exact retained key, waits for GCM authentication, then independently hashes
the resulting plaintext and checks its size before returning a buffer. Unauthenticated plaintext is
never returned. Internal copied plaintext/key buffers are cleared when practical; this is not a claim
of complete JavaScript heap, swap, crash-dump, or SSD secure erasure.

`retain({ projectId, blobs })` reuses 1–128 already durable addresses, each with its expected
SHA-256, byte size, and key ID. Pending staged data is flushed first. Retention performs the same
path, ownership, identity, envelope, and plaintext authentication checks as reading; it discards
plaintext instead of returning it and does not rewrite committed ciphertext. At most four reads
authenticate concurrently. Every started read in a failed group finishes and clears its buffers
before rejection, queued mutations, key rotation, or close can proceed. Failures retain request
order within the group; missing array entries cannot be acknowledged. The final root checks and
count acknowledgement occur only after every requested address authenticates successfully.

## Publication, filesystem checks, and recovery

The supported primitive is POSIX/macOS: `O_NOFOLLOW`, directory descriptors/fsync, ownership, and mode
checks are required. Managed roots/directories must have mode 0700 and the current user's
ownership; files must be regular mode-0600, owner-matching, single-link files. Existing unsafe modes are
rejected rather than silently repaired. Parent directories for the two configured roots must already be
private. The module can create only its leaf roots and managed descendants.

Callers first canonicalize the **trusted existing OS/userData parent**, then append managed child names.
For example, macOS `/tmp` and `/var` system aliases resolve to `/private/tmp` and `/private/var`; pass the
canonical parent-derived paths. The module does not automatically follow mutable app-owned symlinks.
It rejects supplied noncanonical paths and symlink ancestors, rechecks root/inode identity, uses
`O_NOFOLLOW` and `fstat`, validates file size before reading, and checks file identity/state afterward.
These JavaScript pathname checks are **not native descriptor-relative ancestor-race confinement**.
Malicious control of the same OS account or a mutable ancestor is outside this slice's guarantee.

Publication order is exclusive private hash-directory reservation → 0600 random temp creation →
ciphertext/wrapped-key write → file fsync → rename → containing-directory fsync → bounded reread and
verification → successful return. Parent directory creation is also synced. Existing blob addresses
are never overwritten: dedup first validates the existing envelope, authentication, expected hash/size,
and bytes. Damaged or incomplete addresses remain unavailable instead of being repaired implicitly.
Rotation may atomically replace its own complete wrapped keyring while holding the source lock; all old
keys remain in the replacement, so retained snapshots and external backup key references remain usable.

| Failure | Behavior |
| --- | --- |
| Blob write before rename | No success response; owned temporary file is cleaned when possible; isolated hash-directory residue remains |
| Blob failure after rename/fsync | No success response; an authentic surviving blob may be read or deduplicated later; no claim that an unacknowledged write survived power loss |
| Incomplete hash directory | That address fails closed; other healthy/new hashes remain usable; no recursive/destructive cleanup |
| Failed key update | Current handle becomes unusable; close/reopen validates whichever complete wrapped keyring is present |
| Missing/corrupt/wrong-install keyring | Fail closed; no key creation or source overwrite |
| Existing/crash-left owner lock | Refuse opening; never infer staleness from PID or delete an ambiguous lock |
| Replaced owner lock | Refuse further operations and preserve the other lock |
| Normal close | Drain accepted operations, clear held key buffers, remove only the owned lock, fsync its directory |

**Production integration is blocked on explicit lock/crash recovery tooling.** A process crash leaves its
lock and potentially encrypted staging residue; this isolated module intentionally has no automatic
stale-lock override. No actual power interruption, filesystem fault driver, or native security boundary
has been validated by these unit tests. Fault injection exercises the deterministic publication stages
`temp-written`, `file-synced`, `before-rename`, `renamed`, `directory-synced` for blobs and wrapped keys.

## Validation and remaining T02 work

Focused validation: **50/50 Node tests PASS**, with syntax checks for the module and test file also PASS.
Commands: `node --test desktop/test/source-vault.test.cjs` and `node --check` on both `.cjs` files.
The run log is `/tmp/ci-source-vault-test.log`; Node version was `v26.5.0`.
All filesystem data is synthetic and temporary. No full desktop/integration or actual power-loss result
is implied by this focused result.
Tests cover ciphertext-only persistence, raw bytes, exact size limits, synchronous input copying,
independent plaintext hash checks after valid AEAD, dedup/no overwrite, cross-project and malformed
envelopes, key loss/rotation/reopen, wrapped-key bounds/purpose/identity, symlink/hardlink/mode/root
checks, lock ownership, operation bounds, aggregate byte/entry quotas including orphans and failure
residue, and failure injection at every named publication stage.

This does not complete T02. Still required: production safeStorage adapter/main lifecycle and recovery,
authenticated bounded UDS broker, immutable source manifest/generation schema and DB commit protocol,
staging/approved-input integration, source API and worker wiring, workspace lifecycle, broader installation
free-space accounting, pin/retention/GC, and same-install backup/restore references that cannot overwrite safety area B.
Native confinement, real installed-OS storage behavior, signed helper acceptance, and actual power-loss
testing remain separate gates. No legacy source is promoted to verified immutable evidence by this module.

## Canonical identifier follow-up — 2026-10-03

The vault and local source broker now explicitly require a pattern match to equal the entire input
string. This covers project and installation identities, expected hashes, key IDs, managed hash/pending
basenames, broker authentication tokens, and request UUIDs, including IDs echoed in error responses.
The vault also explicitly validates the active key ID before parsing key entries. Existing numeric
project normalization and accepted canonical identifiers are unchanged.

This is defensive validation clarification, **not a reproduced line-terminator bypass**. The ten new
cases already passed with the original regular expressions on Node `v26.5.0`; the historical baseline
is `/tmp/ci-source-canonical-red-2026-10-03.xml` despite that filename's `red` label. Coverage includes
LF, CR, CRLF, U+2028, and U+2029 suffixes; invalid broker inputs/options make no vault calls, invalid
request IDs are not echoed, and rejected vault input or managed names preserve existing fixture data.
Invalid stored key IDs also cannot produce a successful broker response.

Focused follow-up: **10/10 PASS**, with zero failures, skips, or cancellations; syntax checks on both
modules and both test files PASS. Command:

```sh
node --test --test-name-pattern='line terminator|noncanonical broker token' \
  --test-reporter=spec --test-reporter-destination=/tmp/ci-source-canonical-2026-10-03-local.log \
  --test-reporter=junit --test-reporter-destination=/tmp/ci-source-canonical-2026-10-03-local.xml \
  desktop/test/source-vault.test.cjs desktop/test/source-broker.test.cjs
```

The initial sandboxed attempt passed the seven vault cases but could not start the three broker cases'
local UDS fixtures. The successful local run above uses only synthetic wrapping keys, disposable files,
and local sockets. It does not validate OS key storage, native confinement, installed packaging, or the
full current integration. The earlier 50/50 result and integration-work list describe the initial
isolated slice; this focused follow-up does not stand in for a new full-suite result.
