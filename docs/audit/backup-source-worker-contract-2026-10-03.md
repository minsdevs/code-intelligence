# T09 selected-source offline worker

This is a development adapter, not complete product format3 backup acceptance. It uses the bundled
Java 21 and JGit dependency already used by the application. No native Git, Spring context, database,
network, shell command, original working folder, OS key, or archive-provided Git configuration is used.
The parent coordinator owns full-installation database selection, maintenance locking/writer drain,
archive encryption, space accounting, safety sealing/merge, data switching and product authorization.

## Entry and trust boundary

The only worker argument is `--ci-backup-source-worker`; the application dispatches it before
`SpringApplication.run`. Additional arguments, an assigned value, or an unknown worker suffix fail
without starting the application. Commands and data travel on private framed stdin/stdout. No path,
token, source text or exception is printed in an error. The exit code is 0 for success and 2 for failure.

This is a main-only helper. `reposRoot` and `stageRoot` are trusted main inputs, not archive fields or
filesystem grants received from a renderer. Main binds the former to its current `data/repos` and the
latter to a freshly owned restore stage. The worker addresses only their canonical decimal project-ID
child. It never reads a project's `local_path`. Main must supply the complete, consistent installation
inventory, including all users/projects and historical snapshots; this helper cannot prove that a
caller omitted no database rows. It does not restore source access approvals or credentials.

## Wire protocol v1

Each frame is a four-byte unsigned big-endian length followed by UTF-8 JSON. Frames are at most
16 MiB. Duplicate/unknown fields, invalid UTF-8, non-integral counts, out-of-range IDs, and noncanonical
OID/hash/base64 strings are rejected. JSON key order is not significant. Exactly one command is
accepted per process, and input EOF is mandatory. Parent code must consume stdout with backpressure,
bound aggregate bytes, close stdin, enforce a process deadline and require a successful process exit.
Neither a `BEGIN` nor partially received objects are a complete export.

EXPORT request (then EOF):

```json
{"version":1,"operation":"EXPORT","reposRoot":"<trusted main path>","projectId":"7","selection":{"snapshots":[],"commits":[],"branches":[],"headOid":null}}
```

`selection` has exactly these fields:

- `snapshots`: `{snapshotId: decimalString, commitOid: lowercase40hex, files: [...]}`.
- Each file: `{path: canonicalRelativePath, gitOid: lowercase40hex, byteSize: nonnegativeInteger}`.
- `commits`: distinct known lowercase40hex commit IDs (the product history rows, not arbitrary refs).
- `branches`: `{name: validShortBranchName, headOid: lowercase40hex}`. Case aliases and ref prefix
  collisions are rejected, including on a case-sensitive test filesystem.
- `headOid`: null or an exact tip already bound by a snapshot, known commit or branch. It is restored
  as a detached HEAD; no remote or working tree is generated. Empty projects have an unborn fixed HEAD.

EXPORT emits `BEGIN`, zero or more `OBJECT` frames, and `END`. BEGIN/END both contain:

```text
{version:1,kind:"BEGIN"|"END",projectId,selectionSha256,
 objectCount,totalObjectBytes,objectsSha256}
```

An object frame has exactly:

```text
{version:1,kind:"OBJECT",objectType:"COMMIT"|"TREE"|"BLOB",
 gitOid,rawSha256,byteSize,bytesBase64}
```

Objects are sorted by lowercase Git OID with no duplicate. `rawSha256` hashes the object's raw payload,
not its zlib or Git-object header. The Git OID is independently recomputed over its type and raw bytes.
Only a matching final END plus clean process exit is success. Errors use
`{version:1,kind:"ERROR",code:<static reason>}` and can follow partial output after an I/O failure.

IMPORT request is followed by those OBJECT frames, the matching export END, and EOF:

```text
{version:1,operation:"IMPORT",stageRoot:<trusted fresh stage parent>,projectId,selection,
 expected:{selectionSha256,objectCount,totalObjectBytes,objectsSha256}}
```

Success emits one receipt with the BEGIN fields and `kind:"RESTORED"`. Root/path fields never come from
the archive. The project child must not exist; an existing directory or symlink is never adopted.
Failed validation removes only the child freshly created by this invocation after checking its root
identity. A cleanup failure is itself failure; main must quarantine/recover that stage, not promote it.
If the success pipe breaks after verified publication, the private stage can remain, but there is no
successful receipt and main must not switch it into live data.

## Deterministic digests

`selectionSha256` is SHA-256 of UTF-8 compact JSON in the exact construction order below:

1. Top fields: `snapshots`, `commits`, `branches`, `headOid`.
2. Snapshots sorted by numeric ID; snapshot fields: `snapshotId`, `commitOid`, `files`.
3. Files sorted by unsigned UTF-8 path bytes; fields: `path`, `gitOid`, `byteSize`.
4. Commits sorted by OID; branches sorted by unsigned UTF-8 name bytes, fields: `name`, `headOid`.

IDs are decimal strings, sizes are JSON integers, and no whitespace is added. Selection paths use
NFC, reject invalid surrogate encoding/control characters, absolute paths, traversal, `.git`
components, encoded traversal and backslashes. Selection normalization never changes source bytes.

`objectsSha256` is SHA-256 over the ASCII domain `CI_BACKUP_OBJECTS_V1\n` followed by each OID-sorted
object's `TYPE + NUL + gitOid + NUL + rawSha256 + NUL + decimalByteSize + LF`. TYPE is uppercase.
An empty object set hashes only the domain. Counters are bounded below JavaScript's exact-integer limit.

## Source selection and consumers

Snapshot selections verify each path/OID/size against its exact commit tree and retain the requested
blobs, commit, and tree metadata. Known commits retain their first-parent comparison tree and every
changed old/new blob. This covers the rename candidates used by `HistoryService.diff` without running
configured diff/filter/attribute commands. The raw `.gitattributes` blobs in those trees are also
retained because JGit's read consumers consult them even when unchanged. Branches retain the complete
ancestor commit-header closure for existing paginated RevWalk behavior, including merge parents;
unneeded ancestor tree/blob contents are not recursively dumped. Tags and pull-request metadata remain
in the database projection; they do not authorize arbitrary extra Git object traversal here.

Import validates every envelope, writes only fresh JGit objects, then independently derives the same
required object set from the selection and staged repository. Extra objects with otherwise valid
hashes/digests are rejected, as are missing objects, wrong types or tree membership. Source text and
commit metadata are strictly decoded and tested with the application's `SecretMask`: a hit fails the
whole operation without printing, redacting or truncating it. NUL/binary/non-UTF8 required objects,
Git symlink/gitlink modes, and unsafe tree paths fail explicitly. These cases are unsupported in this
adapter and are not a metadata-only complete backup. Unreferenced Git blobs and working-tree files
are not examined or included.

The source object reader uses `ObjectDirectory(new Config(), ...)`, not `Git.open`, a repository config,
global config, a Git executable, or configured remote. Managed metadata is checked for symlink,
hardlink, special entries, alternates, shallow history, grafts and directory indirections. A bounded
before/after metadata inventory plus object ID/hash verification rejects observed concurrent changes.
Source pack files may be read through JGit, but are never copied into the archive or accepted as input.
Restore generates fixed safe config, HEAD and validated branch refs, then fsyncs private files and
directories. It creates no worktree and runs no hooks, checkout, clean/smudge filter or network fetch.

## Bounds and limitations

- Per object: 2 MiB. Per command: 200,000 selected objects, 10 GiB raw object bytes.
- Selection: 10,000 snapshots, 50,000 total file entries, 50,000 known commits, 10,000 branches.
- Each inspected tree: 50,000 entries, 16 MiB path metadata, depth 64, path length 8,192 UTF-8 bytes.
- Managed `.git` inspection: 600,000 entries, depth 64, 10 GiB stored files.
- Processing checks interruption and a 120-second monotonic budget. Blocking stdin/stdout is bounded
  by the parent's deadline/kill/reap contract, not by a claimed native Java I/O cancellation guarantee.

The coordinator additionally checks installation-wide quota, actual staging/recovery/free-space needs,
and any lower product limits. This worker does not claim native hostile-ancestor confinement, secure
erasure of Java strings/heap/swap, adversarial same-account rollback resistance or physical power-loss
proof. Sources missing before export stay a hard failure: no original-folder or remote fallback.

Retained-v1 ciphertext/key preservation is a separate vault adapter. The initial worker candidate
rejected known synthetic history commits missing from the managed clone after retained run cleanup.
The retained-export extension below reconstructs those exact objects from verified retained bytes.
It does not silently remove missing history from the selection or infer Git coverage from ciphertext
alone. Source approval receipts are not imported, and historical job retry remains subject to renewed
authorization/provenance policy.

The paired `LocalSourceStatusService` change returns `REAUTHORIZATION_REQUIRED` for restored null/blank
local paths, with no source filesystem access. It preserves snapshot identity and does not grant access.

## Main-only Node launcher

`createBackupSourceWorker({javaPath, jarPath, env?})` pins the canonical regular, single-link bundled
executable/JAR identities and checks them before each launch. Binary authenticity remains the signed
runtime's responsibility. Each process has the fixed arguments
`-Xmx512m -jar <bundled JAR> --ci-backup-source-worker`; no project path, source text, token or archive
field is an argument. Its environment retains only PATH, HOME, TMPDIR, LANG, LC_ALL, LC_CTYPE, TZ,
USER and LOGNAME. Java injection variables, CLASSPATH and provider/database credentials are excluded.
Injected `spawn` is a main/test dependency, not a renderer, archive or environment switch.

- `exportProject({reposRoot, projectId, selection, writeRecord})` calls the awaited private sink with
  each validated BEGIN, OBJECT and END. It returns the four-field receipt only after END validation,
  stdout EOF and exit/close code 0. A sink can have partial records even when the operation later fails;
  the coordinator must discard that private partial payload and publish no backup.
- `restoreProject({stageRoot, projectId, selection, expected, objects})` accepts an async iterable of
  OBJECT frames, verifies their bytes/hashes/order/bounds, then sends END and stdin EOF. Success requires
  the exact RESTORED receipt, stdout EOF and close code 0. The Java helper owns fresh stage cleanup.
- `close()` cancels the owned child. SIGTERM followed by bounded SIGKILL escalation requires an actual
  close event; neither `kill()` returning nor throwing is exit confirmation. An unconfirmed child stays
  owned, blocks all further work, and can be retried by an explicit close. Concurrent termination
  attempts share one sequence, and child ownership is established before stdio setup validation.

The launcher permits one active command with no queue. It bounds frames to 16 MiB, stderr discard to
64 KiB, raw selected objects to the Java limits, aggregate wire bytes, and wall time to 180 seconds by
default. It awaits each stdin write and export sink callback. Errors expose only a fixed code; worker
stderr, arbitrary JSON error text and exception causes are not included. Owned decoded/write buffers
are cleared, but JavaScript strings, outstanding caller-owned sink work and secure erase are not claimed.

## Verification ownership

Author fixtures cover raw-byte/CRLF preservation, exact Git identity, rename and merge comparison,
branch history beyond one page, historical snapshots, unselected blob/config/worktree exclusion,
missing/corrupt source, secret/encoding/mode bounds, unsafe paths/refs/filesystem entries, extra valid
objects, malformed envelopes/EOF, fresh-only cleanup, permissions, cancellation and empty projects.
Only disposable synthetic repositories/bytes are used. The author did not run Gradle; parent-serialized
compile/test/packaged-entry evidence must be recorded separately. This document is not a test PASS or
a product backup/restore Go decision.

The Node author run recorded 45 passing synthetic cases, no failures, and one opt-in packaged-JAR test
not run in `/tmp/ci-backup-source-wrapper-final-2026-10-03.log` and `.xml`. It covers fixed argv/env,
streaming BEGIN/OBJECT/END, backpressure, malformed frames/hashes/receipts, static failures, initialization
failure reaping, deadline/escalation, failed termination ownership, cancellation, binary replacement and
fresh restore inputs. `CI_BACKUP_SOURCE_TEST_JAVA` and `CI_BACKUP_SOURCE_TEST_JAR` are read only by the
test file to enable a temporary public-byte roundtrip; the production module has no test-mode variable.
The packaged worker and complete application acceptance remain separate parent-owned gates.

## Retained source completeness extension (2026-10-03)

This addition preserves the existing EXPORT/IMPORT selection and receipt format. Main can now call:

```text
exportProject({reposRoot, projectId, selection, writeRecord,
               scratchRoot, retained, readRetainedBlob})
```

The three additional fields must all be present. `retained` is a nonempty array in strictly increasing
numeric snapshot-ID order. Each descriptor has exactly:

```text
{snapshotId, commitOid, commitEpochSecond: decimalString | null,
 policyVersion: "local-ingest-v1", limitsSha256, manifestSha256,
 fileCount, totalBytes, entries:[{path, gitOid, rawSha256, byteSize}]}
```

IDs and non-null epoch seconds are canonical decimal strings; counts and byte lengths are bounded
JSON integers. `commitEpochSecond` is in 0..253402300799. Main obtains the actual historical second
from a validated `commits.committed_at` or the job approval linked to that retained manifest. Neither
the helper nor this launcher substitutes the current clock, snapshot creation time or a guessed date.
When the timestamp is null, the helper reads the exact existing managed-clone commit, obtains its
committer second and still reconstructs and compares the whole synthetic commit OID. This permits
re-export of an already restored clone without restoring old approval rows. If that exact commit is
also absent, the whole export fails `SOURCE_MISSING`.

Every descriptor must match the same snapshot ID and commit OID in the standard selection. Its full
entry array must equal that selected snapshot's complete path/Git-OID/byte-size file list, including
manifest files that the language analyzer did not emit as database `files` rows. Main is responsible
for this installation-wide retained manifest inventory and for proving its sealed database ownership.
A descriptor or a JavaScript callback is not a source access approval and grants no original-folder
or credential access. No other file selection is expanded from paths on disk.

`readRetainedBlob({projectId, sha256, byteSize})` is a main-only capability backed by the existing
source-vault verified read. It must return an exclusively owned fresh Buffer and must not mutate it
after returning. The launcher independently checks length, raw SHA-256 and Git blob OID, awaits one
stdin write at a time and clears that returned buffer in a `finally` block on both success and failure.
It also clears its temporary JSON byte buffer and complete framed stdin buffers. No purpose key,
key bytes, key ID, token or vault-opening capability reaches the helper's argv, environment or JSON.
Immutable JavaScript/Java strings, runtime internals and caller-held aliases cannot be securely erased;
the implementation makes no such claim. Cancellation of an outstanding capability call cannot force
that caller to return; any later returned Buffer is checked against cancellation and cleared.

The operation is a single private framed conversation:

```text
{version:1,operation:"EXPORT_RETAINED",reposRoot,scratchRoot,projectId,selection,retainedCount}
{version:1,kind:"RETAINED_BEGIN", ...descriptor fields except entries}
{version:1,kind:"RETAINED_ENTRY",path,gitOid,rawSha256,byteSize,bytesBase64}  [fileCount times]
{version:1,kind:"RETAINED_END",snapshotId}
... next descriptor ...
EOF
```

The helper rejects duplicate/unknown fields, descriptors out of order, incomplete selection binding,
entry reordering, prefix/case aliases, forbidden paths, bad hashes, noncanonical base64, size/count
mismatches, missing end/EOF and unrecognized policy versions. It independently recomputes the existing
`code-intelligence-local-manifest-v1` binary digest: four-byte big-endian UTF-8 string lengths, framed
policy/limits strings, each entry marker/path/REGULAR_FILE/eight-byte size/raw SHA-256, and the final
count/total marker. The existing strict UTF-8, NUL and whole-text `SecretMask` checks still apply before
any blob is inserted. Detection fails the operation without modifying, redacting or printing source.

The helper creates only `scratchRoot/{projectId}`, exclusively and with mode 0700, under a canonical
main-owned 0700 parent outside the managed repository root. It inserts validated blobs into a fresh
JGit object database, uses an in-memory DirCache with regular 100644 modes, and builds a parentless
commit with both identities `Code Intelligence <local@code-intelligence.invalid>`, the verified UTC
second and the exact message `Code Intelligence local snapshot`. The resulting commit must equal
`commitOid`. This is the existing retained import/run-workspace algorithm; no worktree, Git repository
configuration, alternates, hooks, checkout, filter, native Git or network is used.

Generated objects are read first and missing objects can be read from the existing managed clone.
This is an in-process pair of bounded ObjectReaders, not an alternates file. Corruption of a present
object does not trigger a fallback. Existing managed Git metadata is checked even when generated
objects would otherwise suffice; unsafe symlinks/hardlinks/indirections cannot be hidden by retained
input. The existing clone and source folder are never written. A missing clone is allowed only when
all selected objects are supplied by exact reconstruction; other missing known history fails normally.
The same standard SourceGraph selection, envelope checks and sorted receipt digest are then used for
export. Import therefore needs no retained-specific archive format or authority restoration.

Per retained manifest: at most 50,000 files, 512 MiB raw bytes, 2 MiB per file, 16 MiB entry metadata,
64 components per path and 255 UTF-8 bytes per component. Existing selection-wide 50,000 file entries
and command-wide 10 GiB raw-source/200,000 object limits remain. Reconstruction additionally caps the
sum of each manifest's file/directory/commit/root-tree node counts at 200,000; this conservative count
can reject a very large repeated tree even when object IDs deduplicate. All bounds fail explicitly,
without omitting snapshots. The Java monotonic deadline/interruption and Node deadline/reap contract
remain in force; there is no claim that this removes the need for parent disk/RSS/free-space budgets.

The fresh scratch child is identity-checked and deleted after success and ordinary failure, after
JGit readers are closed. Cancellation preserves the interrupt signal but permits cleanup fsync to
finish. Cleanup failure prevents successful process exit, even if END was already written. A process
crash can leave plaintext private objects. A later invocation never adopts or deletes an existing
child, including an apparently valid orphan; the coordinator preserves that failed transaction and
uses a new transaction UUID parent on retry. This is not native hostile-ancestor confinement or SSD
secure erase. Original managed source and safety/key storage are not part of helper cleanup.

Author verification for this extension is separate from the earlier 45-case launcher baseline:
`/tmp/ci-backup-resume-source-author-second-2026-10-03.log` and `.xml` record 76 synthetic Node passes,
zero failures and three opt-in packaged-JAR tests skipped (79 total). The newly added packaged cases
check exact independently constructed commit/object bytes after a missing-clone export/restore/null
approval-time re-export, and actual SIGKILL after a private object write followed by orphan refusal
and a fresh transaction retry. Those packaged tests are not claimed as run by that author command.
The Java candidate includes actual RetainedRunWorkspace object-contract comparison, mixed legacy
history, multiple historical retained snapshots, raw CRLF/Unicode/empty bytes, malformed descriptors,
valid-digest unsafe paths, secret/encoding/size guards, cancellation and owned-only cleanup. Its first
freeze hashes are `/tmp/ci-backup-resume-source-java-first-freeze-2026-10-03.json`; compile/test/format/JAR
results belong to the parent's serialized gate and must be reported separately. No actual user source,
user database, installed application, Keychain, network or paid provider was accessed by these fixtures.
