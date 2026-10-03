# T02 encrypted source and generation continuation

This is an implementation contract under the approved execution roadmap, not a new release claim.
The existing Spring/PostgreSQL/Electron stack stays in place. The first vertical slice is LOCAL
imports with the E2 receipt; GitHub and legacy data keep explicit legacy states until separately
verified. Existing Git OIDs and row identifiers are never relabeled or rewritten as SHA-256.

## Ownership and durability

Electron main owns the source keyring at `safety/source-vault/`. Source ciphertext is under a
disjoint ordinary-data source root, namespaced by canonical project ID and plaintext SHA-256.
The source key is independent of credentials, backup keys and safety-journal keys. A wrapper port
allows synthetic fixture keys now and safeStorage in the desktop integration; no root key is put
in an environment variable, renderer API, worker protocol, log, report or backup.

The vault provides bounded `put(projectId, bytes)` and `read(projectId, sha256, byteSize)` operations.
AES-256-GCM authenticates format, installation identity, project, key ID, content hash and size.
Writes fsync the ciphertext, atomically publish it, then fsync its directory before acknowledgment.
An existing address must decrypt and match exactly before deduplication. Missing/corrupt keys or
unknown formats fail closed. Old source keys are retained; this slice has no automatic key deletion.
An ambiguous writer lock after a crash fails closed until recovery can prove safe ownership.

The production bridge will be a bounded private Unix-domain channel owned by main. Requests
contain versioned identifiers and bounded bytes, never arbitrary filesystem paths or key exports.
The backend keeps ownership and job/manifest authorization; adapters receive only their temporary
workspace and do not receive the bridge capability. Native denial of unauthorized processes remains
T03, not a claim established by a Unix socket mode or Java path checks.

## Additive data and publication

Next migrations start after V22 and add source blob metadata, immutable source manifests and ordered
entries, plus analysis generation identity/status. New manifests bind the E2 approved byte digest,
project, job, snapshot, effective policy, Git OIDs and distinct plaintext SHA-256 values. Blob durability
precedes the transaction that marks its manifest usable. A failed transaction may leave bounded
encrypted orphans; it cannot make the old committed source pointer unreadable.

Versioned source reads resolve an owned snapshot/manifest first, check expected content and size,
and request that exact blob. Missing or corrupt retained source is unavailable/stale; a newer working
tree is never substituted. Legacy snapshots retain their existing explicit legacy/unavailable behavior.
Old snapshot bytes cannot be reconstructed from a changed live folder.

The enabled LOCAL worker now uses disposable 0700 run workspaces and reconstructs approved
immutable bytes for retained retries. Its initial worker path does not create a permanent project
clone. Import diagnostics and source publication share a transaction; a crash after that commit
but before IMPORT DONE resumes the checkpoint without reopening the original folder. Admission
checks supported metadata and the previous generation; the worker verifies every blob and the
synthetic Git commit before any remaining analysis step runs. A later import attempt still
conservatively blocks an older completed import. Producer rule/config/dependency fingerprints are
not yet measured, so this is not a general cross-build checkpoint compatibility claim.

The scratch module's independent review found a real same-JVM contender/OS-lock counterexample;
its fix and final regression are tracked in [the continuation report](continuation-2026-10-03.md).
Scratch safety does not establish native isolation. Existing legacy clones are preserved, desktop
main does not yet enable the source broker, and automatic plaintext migration/removal is not active.
Tests use disposable fixture keys and a real local bridge; any remaining plaintext clone is
transitional and does **not** satisfy whole-installation encryption at rest or T02 acceptance.

## Retention and acceptance

The target is five recent snapshots, explicit/note/task pins and a30-day grace period, within the
10GiB installation quota. Destructive pruning must not remove a retained/pinned manifest or a blob
needed by recovery. GC needs its own mark/grace/recheck transaction and crash tests; until those
exist the encrypted store must fail at quota rather than silently evict source.

Acceptance uses synthetic keys/providers and disposable data: cross-project substitution, corrupt
envelopes, missing keys, unknown versions, write/fsync interruption, restart, duplicate/concurrent
put, migration sentinels, old/new source reads, unchanged notes/tasks, rollback before publication,
and scratch cleanup. Real OS vault, signed isolation and clean-machine installation remain separate
operational gates. No installed app or real userData is changed by these development tests.
