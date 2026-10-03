# Format 3 encrypted file container primitive (2026-10-03)

This is an isolated T09 development primitive for the encrypted container portion of frozen
[05 §5 and ADR-02](../multilanguage-plan-2026-10-02/05-security-performance-operations.md).
It encrypts/decrypts **one opaque, already scrubbed staging file**. It does not construct a product backup,
classify/remove credentials, export PostgreSQL, extract paths, run SQL, swap a source store, restore the
safety journal, or alter an installation. Its format version is 3; product format3 backup acceptance
remains a separate integration gate. No `main.cjs` or existing `backup.cjs` path is enabled by this module.

## Minimal private API

```js
const { encryptFile, decryptFile } = require('./backup-archive.cjs');
const metadata = await encryptFile({
  sourcePath, sourceRoot,              // trusted credential-scrubbed staging payload
  destinationPath, destinationRoot,    // fresh private container path
  installationId,                     // existing installation identity
  keyProvider: purposeKeyring,         // main-only currentKeyId('backup'), getBackupKey(id)
  // maxPayloadBytes: optional lower bound, never above 10 GiB
  // fault(stage): optional trusted test hook, never a renderer callback
});
// decryptFile takes the same fields, with the container as source and fresh staging as destination.
```

Both calls resolve only after verification and durable publication. The frozen result contains
`format: 3`, `archiveId`, `keyId`, `identityHash`, `payloadBytes`, `payloadSha256`, and `chunkCount`.
All IDs/hashes are non-secret metadata. No key bytes, plaintext, file handles, or provider references
are returned. Failures are sanitized `BackupArchiveError` codes/messages without OS/provider details
or a nested cause. There is no generic archive extraction, inspection-to-execution path, key export,
overwrite option, automatic restore, source directory traversal, or environment/worker key transport.

Roots must be existing canonical absolute private directories; file paths must be their direct children.
The caller canonicalizes a **trusted existing OS parent** first (e.g. `/tmp` → `/private/tmp` on macOS).
The module does not follow an app-owned symlink to make a supplied path acceptable. Both roots can
coincide, but source and destination file paths must differ. The installation ID uses the existing
1–128 ASCII base64url grammar, including a leading `_` or `-`; it is never a path component.

The source is exclusively a trusted staging payload produced by a future credential allowlist exporter.
This container cannot establish that an arbitrary input is scrubbed or safe to execute. Decrypted bytes
remain opaque data; do not pass them to PostgreSQL/tar/a shell until separate product validation and
isolation gates are implemented. Payloads containing path-like strings are not interpreted here.
An external user-selected backup folder is not implicitly made a private staging root by this API.

## Version 3 wire contract

All integers in the binary framing are unsigned 32-bit big-endian. The file is:

1. Eight bytes `CIBAK003` and a four-byte canonical-header length (1–4096 bytes).
2. Exact canonical UTF-8 JSON header, with ordered members:
   `format`, `version`, `identityHash`, `keyId`, `archiveId`, `chunkBytes`, `chunkCount`,
   `payloadBytes`, `payloadSha256`, `wrappedDek`.
3. Exactly `chunkCount` frames, each `index:4`, `ciphertextLength:4`, `nonce:12`, `tag:16`,
   then that many ciphertext bytes. No footer, missing frame, or trailing byte is accepted.

`format` is `code-intelligence-backup-container`, `version` is 3, and `chunkBytes` is exactly 1 MiB.
`chunkCount = ceil(payloadBytes / 1 MiB)`, so an empty payload has zero chunk frames. Counts, byte
sizes, frame order, and exact container length are verified before/during reading. `payloadBytes` is
an exact safe integer in `0..10737418240`; the 10 GiB hard cap cannot be raised by the caller. The optional
`maxPayloadBytes` may lower that cap to any nonnegative integer, including zero for empty-only input.

`identityHash` is SHA-256 of UTF-8 `CI-BACKUP-INSTALLATION-3\0` followed by the existing identity.
`keyId` is the selected retained backup key's exact 32 lowercase hex ID. `archiveId` is an independently
random 128-bit value encoded as 32 lowercase hex. `payloadSha256` is SHA-256 of every raw plaintext
byte. Duplicate/unknown JSON members, reordered/whitespace/invalid UTF-8 encodings, noncanonical
base64/IDs, wrong installations, unsupported versions, and unreasonable sizes/counts fail closed.
The reader accepts only the exact canonical encoding reconstructed from validated fields.

Each encryption creates an independent 256-bit random archive DEK. `K-backup[keyId]` wraps the DEK
using AES-256-GCM with a random 96-bit nonce and a 128-bit tag. `wrappedDek` contains exactly ordered
`nonce`, `ciphertext` (32 bytes), and `tag`, all canonical base64. DEK-wrap AAD is the domain-separated
`CI-BACKUP-DEK-3\0` plus the complete canonical core metadata (all header fields except `wrappedDek`).
Thus version/schema, identity, key/archive IDs, payload hash/size, and chunk sizing/count are bound
before any chunk is processed. Empty containers still authenticate this wrapped DEK and compare the
final SHA-256 of zero plaintext bytes; a missing payload does not bypass authentication.

Each chunk uses the DEK with its own independent random 96-bit nonce and a 128-bit GCM tag. Its AAD
binds the version/domain, identity hash, key/archive IDs, SHA-256 of the **entire immutable encoded
header**, chunk index, total chunk count, total payload bytes, and this chunk's plaintext byte count.
Nonce reuse within a container is refused, including a chunk nonce matching the DEK-wrap nonce.
Generation retries a random collision at most eight times before failing. Decryption rejects duplicate
nonces/indices, reordering, missing/extra frames, wrong tags/bytes, and chunks spliced from another
archive. Authentication finishes before that chunk's plaintext is written to the private temporary file.
No unverified plaintext chunk is published as a final destination.

Successful decryption may be repeated into another fresh path: this primitive does **not** claim
anti-replay/anti-rollback policy for a complete old authentic archive. Restored cost obligations,
installation safety state, minimum-version high-water, and product restore consent are later gates.

## Key ownership and bounded processing

`keyProvider.currentKeyId('backup')` and `getBackupKey(keyId)` are trusted main-only ports. Encryption
uses the current ID; decryption requests the exact ID in the authenticated envelope, allowing old
backups to remain usable after rotation. The provider must separately retain old backup keys and
return a fresh caller-owned Buffer on each lookup. The container clears that copy in `finally` on
success/failure, including invalid key lengths. Per-archive DEK and transient plaintext buffers are
also cleared when practical. No source, credential, or safety key is reused as a backup key. Wrong or
unavailable keys fail closed; there is no plaintext fallback or key generation during decryption.

There are at most two accepted operations per loaded module instance, with immediate `BUSY` rejection
above the bound. This is not a cross-process mutex. Each operation uses bounded reads no larger than
1 MiB plus the small header/frame; it never reads the whole payload/container into memory. The nonce
set is bounded by 10,240 payload chunks plus the one wrap nonce. Several chunk-sized crypto buffers can
coexist, so a 1 MiB read bound is not a claim that total RSS is 1 MiB. Actual 10 GiB throughput/RSS and
whole-installation free-space reservation are not measured or implemented here.

Encryption hashes the source in one bounded pass and encrypts/hashes it again in a second pass.
The passes must agree on content and the original file's device/inode/size/mtime/ctime. Decryption
authenticates every chunk, enforces exact EOF and source file identity/state, and compares the entire
plaintext digest. Every staged output is fsynced and reread with bounded buffers to compare its bytes
against the digest accumulated during writing before publication. File growth, truncation, replacement,
and same-size mutation detected through state/hash checks abort instead of publishing a mixed snapshot.
Trusted adapters and filesystem operations are asynchronous but not natively cancellable; admission
bounds do not promise a deadline for an OS call or a stalled trusted adapter.

## Fresh-only publication and failure behavior

The POSIX primitive requires current-user ownership, exact 0700 root directories, and regular 0600
single-link input/final files. Existing ancestors cannot be symlinks; roots are rechecked by identity.
Input descriptors use `O_NOFOLLOW | O_NONBLOCK`, validate `lstat` against `fstat`, and recheck after
streaming. No existing permissions are silently repaired. These JavaScript pathname/state checks are
**not native descriptor-relative ancestor-race confinement** and do not protect against a malicious
actor controlling the same OS account or the entire filesystem.

Output order is exclusive private `.archive-pending-<32 hex>` creation → bounded write → all input
authentication/EOF/hash verification → file fsync → bounded output reread/hash verification → source,
root, and staged file identity checks → atomic no-replace hard-link publication → unlink only the owned
temporary name → directory fsync → final single-link identity/state checks → close → success.

Node's ordinary POSIX `rename` can overwrite a destination created by a concurrent writer. Instead,
`link(temp, destination)` is used as the no-replace atomic publication point. `EEXIST` preserves the
existing destination exactly. A temporary two-link state is allowed only between that publication and
owned-temp removal, with both names checked to refer to the same inode. A normal acknowledgment
requires a final single-link file. The plaintext destination does not exist before all authentication and
hash checks pass. The public metadata result is withheld until containing-directory fsync completes.

| Failure boundary | Behavior |
| --- | --- |
| Before publication | No final output; close/remove only this operation's temporary file when ownership checks allow |
| Racing existing destination | `EXISTS`; preserve its bytes and remove only the owned temporary file |
| After publication or directory fsync, before acknowledgment | Return failure; preserve the complete but unacknowledged final destination; never silently overwrite it on retry |
| Replaced temporary name/root | Refuse operation and preserve foreign replacement; cleanup does not delete arbitrary paths |
| Process/power failure between link and temp unlink | May leave two names/links; subsequent normal reads reject non-single-link input and require explicit recovery |

Cleanup is restricted to the operation's exact randomized temporary name and inode. There is no
directory scan/delete recovery, stale ownership override, automatic replacement, or partial destination
rollback. Failure to safely clean a temporary file can leave private residue requiring later recovery.
Decrypting necessarily writes partial **authenticated** plaintext to a private staging file before
whole-archive validation; handled failures unlink it, but crash residue, SSD secure erasure, swap,
native crypto internal storage, and complete JavaScript heap erasure are not guaranteed.

## Validation and integration gates

Focused commands:

```sh
node --check desktop/src/backup-archive.cjs
node --check desktop/test/backup-archive.test.cjs
node --test desktop/test/backup-archive.test.cjs
```

Fixtures use the real purpose-keyring primitive with a public synthetic authenticated wrapper and fresh
temporary private roots. They cover empty/1-byte/1 MiB boundaries, independent envelopes, retained
key rotation/reopen, correct key-copy cleanup, wrong-install/purpose/key refusal, authenticated wrong
whole-file hash, authenticated nonce reuse, header/framing/tag/ciphertext damage, truncation/trailing
data, cross-archive chunk splicing, cap checks, path/link/mode checks, input/output stream changes,
fresh-only races, operation capacity, key/nonce failures, and fault injection around each publication
step. A resource regression disables whole-file reads and observes a maximum 1 MiB read buffer while
processing a multi-chunk file. The sparse oversized-file case tests size rejection only, not 10 GiB I/O.

The deterministic fault stages are `encrypt:after-hash`, `encrypt:chunk-written`,
`decrypt:chunk-written`, `output:created`, `output:verified`, `output:file-synced`,
`output:before-publish`, `output:published`, `output:temp-unlinked`, `output:directory-synced`.
These injected failures/process reopens are not real power-loss or kernel fault-driver tests.

Latest focused result on Node `v26.5.0`: **84/84 tests PASS**, zero failures/skips/cancellations; module
and test syntax checks PASS. The earlier 83-test pass preceded the additional bounded-read regression
and is not added to the final count. Root's combined desktop run passed 388/388, including these
84 cases (`/tmp/ci-desktop-root-2026-10-03.log` and `.xml`). Independent review found no additional
Critical/High/Medium issue within this primitive and ran five separate synthetic failure/race probes;
it did not rerun the entire suite. Review artifacts:
`/tmp/ci-backup-archive-independent-review-2026-10-03.md` and `.json`.

| Artifact | SHA-256 |
| --- | --- |
| `desktop/src/backup-archive.cjs` | `fb59bd1384743ec7e39053f0c1992a72e83e65ccb51309dfd63378f22c6db680` |
| `desktop/test/backup-archive.test.cjs` | `ae82b05851af2e5f807e0513da8b23b5f72ee1d0dd3fb3e7dea35bfc0452eeda` |
| `/tmp/ci-backup-archive-test.log` | `f5f1b55abb83368f7e8d6103a0cbeda35c43cd68bf5f4be8ab47efd8131c2ee7` |
| `/tmp/ci-backup-archive-test.xml` | `792cb0df5c7217aff260d06d8415d14abb649494f9d14d94bc642756d1c28742` |

Product readiness remains
**No-Go**: credential allowlist export, schema/app/source manifest and ID references, source/notes/tasks
selection, preflight free space, main maintenance mutex/lifecycle, real safeStorage integration,
restored SQL staging isolation, safety-journal union/merge, recovery markers, native confinement,
signed packaging, installed-device acceptance, and actual crash/power-loss testing are not established
by this file-container primitive. No provider, actual credential, OS Keychain, real userData, GUI, Gradle,
signing, publishing, or paid call was used.
