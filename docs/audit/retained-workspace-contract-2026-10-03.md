# T02 retained analysis workspace contract — 2026-10-03

Status: implementation candidate. This document describes the primitive and its
synthetic test coverage, not a release approval. The root session owns Gradle
execution and pipeline integration; a test written here is not a claimed pass.

## Ownership and lifetime

`RetainedRunWorkspace` is a Spring service whose only application dependency is
`AppProperties`. Construction does not create storage or acquire locks. Its first
`create(projectId, jobId)` initializes `${app.data-dir}/repos/.analysis-runs`,
checks the private storage entries, and obtains an exclusive `FileChannel` OS lock
on `owner.lock`. It does not inspect PIDs, steal locks, or remove the lock file.
Another service/process cannot clean or allocate this workspace while that lock
is held. Closing an unused service has no filesystem side effects.

Before opening any `owner.lock` channel, the service also reserves the canonical
workspace root in a shared JVM registry. A same-JVM contender is rejected before
it can open or close another descriptor for that inode. The registry remains
reserved throughout OS locking, initialization, lease lifetime, and cleanup; it
is released only after the owner's lock/channel release succeeds. Failed
initialization releases its own reservation after closing its channel. A failed
contender cannot remove a different owner's reservation. Unconfirmed channel
closure retains the reservation and blocks new work until successful explicit
close or process exit. The JVM reservation supplements the OS lock and is not a
replacement for cross-process exclusion.

The registry key uses the already verified root device/file identity, rather
than relying on canonical path spelling to collapse filesystem aliases. The
canonical path remains bound to the instance for IO and ownership checks. This
also prevents a case-folded spelling of the same directory from receiving a
second reservation, while independent directories remain independent.

Each fresh lease has a random `run-<UUIDv4>` root, a bounded `owner.meta` with the
format identifier/run name/project ID/job ID, and a `repo` directory. The root and
repo start with mode `0700`; the marker and lock are regular, single-link, owned
files with mode `0600`. The marker is an ownership *format* checked under the OS
lock, not a cryptographic attestation. The current account and a trusted
application storage configuration remain part of the threat model.

`Lease.clonePath()` preserves the configured lexical `reposRoot` prefix because
the existing importer checks that prefix before its canonical check. Internal
ownership checks, reconstruction, and deletion use the canonical path. A trusted
pre-existing parent may be canonicalized (for example `/var` → `/private/var` on
macOS). Application-owned data/repos/workspace entries must be owned directories,
not symbolic links; group/other-writable directories are rejected.

At most **four leases** can be live in one service, and a job ID cannot have two
leases. This bounds the number of simultaneous attempts in this primitive. It
does not implement a scheduler, queuing, a one-job product default, an aggregate
installation disk quota, or a bound on filesystem metadata/disk blocks.

Closing a lease verifies its identity and marker, scans without following links,
then deletes only that fresh owned run. The marker is retained until source and
object entries have been removed. Close is idempotent after successful deletion.
If cleanup encounters an unsafe entry or fails, the lease stays live; new
creation/reconstruction is blocked, and service close rejects
`WORKSPACE_ACTIVE_LEASES` instead of releasing its lock. After resolving the
unsafe entry, the same lease can retry close. The service then needs to close and
be reopened before accepting further work.

On the next startup after a process exits, the service first obtains the OS lock,
then validates *all* existing top-level entries and all candidate orphan trees
before it deletes any of them. Only the empty private lock file and up to four
`run-<UUIDv4>` directories with exact, bounded markers are recognized. Unknown
siblings, missing/wrong markers, symlinks, hard-linked files, special files,
identity/device changes, excessive trees, or unsafe permissions stop cleanup.
They are not guessed away. A crash before a fresh marker was fully written can
therefore require explicit repair; automatic recovery does not trade ownership
checks for availability.

## Reconstruction API and input

```java
Lease create(long projectId, long jobId);
String reconstruct(Lease lease, Manifest manifest, BlobReader reader);

record Manifest(String snapshotSha, Instant approvedAt, String policyVersion,
                String limitsSha256, String manifestSha256, int fileCount,
                long totalBytes, List<Entry> entries) {}
record Entry(String path, String gitOid, String rawSha256, long byteSize) {}
interface BlobReader { byte[] read(String sha256, long byteSize) throws IOException; }
```

The manifest defensively copies its entry list. The caller must authenticate and
authorize the project/job/snapshot, load sealed immutable metadata, and bind the
blob reader to that project. The primitive accepts no original source-folder
path, does not query the live folder, and does not substitute it if a blob fails.

Validation precedes blob reads. It requires lowercase exact-length Git SHA-1 and
raw SHA-256 strings, the supported local policy version, a valid approval time,
matching file count/byte total, and the same framed `LocalSourceManifest` digest
over policy/limits/paths/raw content hashes. The limits digest is bound into the
manifest; the caller is responsible for any policy about compatibility with new
runtime configuration. The primitive does not invent missing historical limits
or claim that an arbitrary digest demonstrates a measured runtime limit.

Entries must be in unsigned UTF-8 byte order, with no duplicates, file/directory
prefix conflicts, or NFC/case-folded aliases. Paths must be relative, canonical
slash-separated names without traversal, controls, backslashes, invalid UTF-8,
encoded traversal separators, or any `.git` component (case-insensitive).
Bounds are 8 KiB per encoded path, 255 encoded bytes per component, depth 64,
50,000 files, 2 MiB per file, 512 MiB total source, and 200,000 distinct source
file/directory entries. The metadata accounting bound is
`256 + sum(pathUtf8Bytes + 128) <= 16 MiB`; fixed-size digest/numeric fields are
included in those framing allowances. This is an encoded metadata budget, not a
claim about JVM object overhead or a JSON transport limit.

Each returned blob must match its declared size, raw SHA-256, Git blob OID, valid
UTF-8, and absence of NUL anywhere (including after the initial 8 KiB). Original
raw bytes, including BOM and line endings, are written unchanged using
`CREATE_NEW`, `NOFOLLOW_LINKS`, and mode `0600`. Fresh source directories use
`0700`. Files are not marked executable.

## Deterministic Git metadata and failure behavior

The synthetic object database uses JGit `ObjectDirectory` with a fresh parentless
`Config`; the implementation does not call `Git.init/open`, load source Git
configuration, run hooks/filters, or launch processes. Tree entries are regular
files. The no-parent commit has author and committer `Code Intelligence
<local@code-intelligence.invalid>`, the receipt's approval instant in UTC using
the same JGit timestamp representation as `LocalImportService`, and message
`Code Intelligence local snapshot`. Its computed commit OID must equal the
immutable snapshot OID. Generated Git entries are narrowed to private modes
before reconstruction returns.

Reconstruction is allowed once on an empty lease repo. Invalid metadata, missing
source, source or commit mismatch, malformed text, cancellation, time exhaustion,
and IO failures close that lease when safe; partially written plaintext is
removed. Source and filesystem exception details are replaced by fixed codes,
without path-bearing causes. A failure to remove an unsafe tree is never reported
as a released lease. The caller owns failure/retry state in the job database.

Creation/reconstruction use a cooperative 30-second monotonic budget. Blob reads
are checked both before and after invocation, and thread interruption cancels
reconstruction. Cleanup uses bounded scans/deletes and temporarily clears an
existing interrupt only to let filesystem cleanup proceed, then restores it.
An indefinitely blocked OS operation or blob-reader implementation cannot be
preempted by these checks; the production blob client must enforce its own IO
deadline. Tree walks are capped at 401,024 entries and depth 70.

## Validation scope and remaining limits

### Corrected high-severity lock-lifetime defect

The first candidate opened a second channel in a same-JVM contender, caught
`OverlappingFileLockException`, and closed that channel. On the actual Mac with
Java 21.0.12, closing this descriptor released the process's POSIX lock even
though the first `FileLock.isValid()` still returned true. A third, separate JVM
then acquired the lock. The potential user impact was another backend process
mistaking an active plaintext run for an orphan and deleting it during analysis.
Priority: P1; must be corrected before workspace use.

Evidence from the root session:

- `/tmp/ci-filelock-probe-2026-10-03.log`: external `BUSY` before the same-JVM
  contender; Java owner still valid afterward, but external `ACQUIRED`.
- `/tmp/ci-workspace-lock-red-2026-10-03.log` and `.xml`: both new regressions
  against the real workspace class failed before the production fix, for the
  same root and a parent-path alias.

The registry above prevents the extra descriptor from being opened. Separate-JVM
regressions test that the actual OS lock remains busy after a contender fails,
after that contender closes, and after owner shutdown is refused due to a live
lease; the child can acquire it after normal owner close. Additional cases check
failed initialization, an external process that already holds the lock,
independent roots, and cleanup failure. These children run only fixed synthetic
Java source in test temporary directories. The production reconstruction path
still launches no processes. Final green execution belongs to the root session;
the existence of these tests is not itself a pass claim.

Root subsequently executed all **80/80 cases successfully**, with failure/error/skip zero,
in `/tmp/ci-continuation-backend-full-first-2026-10-03-xml/`. The actual case-variant test below
ran and passed on this filesystem. That overall backend attempt still failed three unrelated
legacy fixtures; the class result is not an overall build success claim.

A separate case-variant regression requires the actual filesystem to resolve
the two spellings to the same directory. It explicitly skips on filesystems
without that alias; such a skip is not case-insensitive-filesystem validation.

### Other boundaries

The dedicated test file covers deterministic reconstruction against the existing
importer; exact UTF-8/BOM/CRLF bytes; empty and 2 MiB files; unsafe paths and
metadata; count/metadata bounds; missing/corrupt/oversized blobs and failed commit
identity; NUL/invalid UTF-8; partial cleanup; lock contention; four simultaneous
leases; rejected shutdown with live leases; conservative orphan/lock validation;
symlink refusal; importer compatibility through a configured lexical alias;
cancellation; and elapsed blob-read time. All source fixtures are public synthetic
bytes in temporary directories. The orphan test supplies the on-disk shape left
by an interrupted run; it does not claim to kill/restart an actual process or
simulate power loss.

Unsafe-path, conflicting-path, directory-count, and metadata-budget fixtures have
a recomputed digest matching their supplied entries and assert zero blob reads.
The negative checks therefore cannot pass merely because a stale manifest digest
fails at the final comparison. Unsorted/duplicate fixtures use a test framing
encoder without the production builder's ordering guard so the workspace's own
validation is exercised.

The primitive is **not T03 native isolation**. These are pathname/identity checks,
not descriptor-relative protection against a hostile same-account process racing
ancestor replacement. Plaintext exists in the run tree and generated Git objects
during the lease and may remain after a crash until verified cleanup. Ordinary
deletion is not secure erasure of RAM, filesystem snapshots, backups, or SSD
blocks. The primitive does not remove previous legacy project clones, integrate
with backup/restore, attest packaged native helpers, or establish complete
encryption at rest. Root integration and current test results must be evaluated
separately before any product-level completion claim.
