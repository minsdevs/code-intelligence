# PostgreSQL typed-backup compatibility fixture

## Packaged preflight acceptance

`rtk proxy node validation/backup-compatibility/native-preflight.cjs --app '<retained Validation.app>'`
tests a newly created automation claim on macOS arm64. It does not accept an existing
profile. The real UI creates an encrypted backup; fixture creation inside the new
app's main process produces an authenticated synthetic catalog mismatch without
returning backup material through IPC. The actual restore path must refuse it while
keeping the safety/recovery record bytes, project state, API token and archives.
The test then reanalyzes source91 to92/current snapshot2 and restores backup1 through
the UI, verifies current snapshot1/source91/model URI, and checks a process restart.

The OS picker result is controlled once. Playwright's Electron loader uses a mock
Keychain; this does not replace the separate real-Keychain test. No user profile or
GitHub App private key is an input. All fixtures are synthetic and initially empty.
The first successful run is `validation/local/restore-preflight/native-Y6flRA/result.json`;
the earlier `native-j08bk9` and `native-RcDzlZ` driver failures remain separate evidence.
After bounding the remaining CDP/response waits with the existing deadline helpers,
the unchanged bundle passed a new empty-fixture run at
`validation/local/restore-preflight/native-jGteM6/result.json`. Both launched processes
exited with code 0 and no signal. The final driver SHA-256 is
`de803bb3f8452b2ad75f2ee64504135105346216ae2c6420f76ed944e4797b9a`.
The tested bundle is `.native-product-wXqDvU/Code Intelligence Validation.app`.
This test neither converts historical archives nor proves a physical extension upgrade.

Run from the original repository with an explicitly supplied, preserved source-build
`prefix/postgres`. No build, application launch, existing database, real account,
Keychain, signing, GitHub Actions or paid provider is involved.

```sh
rtk proxy node validation/backup-compatibility/run.cjs --postgres-prefix /absolute/source-build/prefix/postgres
```

Every invocation creates a new `validation/local/backup-compatibility-*` report
directory. The supplied prefix is read and copied; only the copy is changed or
executed. Source-prefix and vector-library hashes are checked again after shutdown.
The runner starts one owned loopback PostgreSQL child with a new data directory,
synthetic SCRAM credentials and TLS `verify-full`. Explicit synthetic client TLS
files avoid libpq's default home-directory client key lookup. It retains the private
fixture, command logs, payloads and `report.json`, including any failed first attempt. A later
run uses a new directory and never replaces previous evidence. These local files
are ignored by `validation/.gitignore`; do not commit generated credentials or DBs.

The checks cover:

- Stock pgvector 0.8.7, current V27 producer and V27 staging, with a non-null
  1536-dimensional vector and the real HNSW-backed summaries schema.
- Genuine 0.8.1 SQL/control definitions on the unchanged new 0.8.7 binary. The
  fixture changes the copied control default while initializing the source,
  restores the 0.8.7 default before creating targets, and never bypasses the
  adapter's empty-staging guard. A current V27 export must be refused with
  `BACKUP_PG_SCHEMA` before the DB-load iterator or accounting writer is used;
  source rows, empty target rows and original payload bytes must be unchanged.
- Explicit `ALTER EXTENSION vector UPDATE TO '0.8.7'` in that synthetic source.
  A **new** export must restore, source rows must remain equal, and the retained
  old export must still be rejected. This does not convert old archives.
- The pinned historical V26 producer at
  `4d8946c7b18b1cdee4f6f86b1e30fc9d469d923f`, using the same 0.8.7 runtime,
  restored through the current V27 reader with `LEGACY_UNMEASURED` file outcomes,
  no invented measurements, preserved note/vector data and unchanged payload.
- The production `withCompatibilityStage` controller, with an internally generated
  UUID and an acknowledged CREATE OID. A separate synthetic live database is
  initialized as a stage, its adapter is closed, then it is renamed to a generated
  `ci_backup_live_*` name. Stock V27 and pinned V26 pass the real pinned-migration
  comparison; old-SQL V27 fails and preserves the original typed callback exception.
  Each probe adapter closes before cleanup; all probe names/OIDs disappear and the
  complete database name/OID/owner/connection projection and live rows stay equal.
- The production restore coordinator with a real encrypted, users-only old-SQL V27
  export. Real PostgreSQL ports, payload verification, encryption/decryption and
  authenticated recovery records are exercised. Rejection must be
  `BACKUP_RUNTIME_INCOMPATIBLE` with `recoveryRequired=false`; maintenance admission,
  pause, failure and journal-write counters remain zero. The selected archive hash,
  source/live rows and authenticated recovery records stay equal, pending recovery
  remains null, scratch is empty and the probe database is absent. B journal,
  gateway and the unused maintenance finance adapter are test doubles: this is not
  evidence of real cost-ledger replay or successful coordinator restore.
- The existing opt-in native typed-backup test, including its updated V26
  platform-identity fixture columns.
- A same-0.8.7 C-to-`en_US.UTF-8` (or `en_US.utf8`) libc target, when that locale
  is installed. Source and target database encoding/provider/collate/ctype/version
  are recorded. The observed restore/refusal applies to this small synthetic
  dataset only; an unavailable locale is explicitly reported as skipped.

## Disposable preflight observed runs

On 2026-10-05, the first expanded run at
`validation/local/backup-compatibility-nz44fc/report.json` passed all ten checks on
PostgreSQL 16.15. The production controller accepted stock V27 and pinned V26,
preserved the original incompatibility exception for old-SQL V27, and removed all
four newly created preflight probes, including the encrypted coordinator case.
The selected encrypted archive, live OID/rows and authenticated recovery records
were unchanged; admission/pause/failure/journal-write counters were zero and
pending recovery remained null. PID 28774 on port 56011 exited with code 0.

The final run after adding an explicit post-exit port check is preserved at
`validation/local/backup-compatibility-VjdhHc/report.json`. All ten checks passed;
PID 30473 on port 56555 exited with code 0 and `portClosed` is true. Both runs have
`shutdownVerified`, `originalPrefixUnchanged` and `vectorBinaryUnchanged` set to
true. The final report records the before/after source-prefix tree hash
`3dfe0e38241cd7822ead40bda4242360710d814785502c05028fbcbac90c6e54`
and vector binary hash
`56b18f4873f323e6ddcbf18d6113f5fbccb670d6e474e56b28773fe3a425b643`.
No failed expanded run occurred. Reports, command logs, typed payloads, encrypted
archives and the stopped private fixtures are retained separately for both runs.

These two runs exercise the new preflight API and actual encrypted coordinator
refusal. The coordinator's B journal and gateway remain test doubles, and the
synthetic cost tables are empty. They do not prove real cost-ledger recovery,
successful coordinator restore, a historical physical cluster upgrade or a
packaged application/Keychain flow.

## Historical adapter-only runs

The eight-check runs below predate the disposable controller/coordinator preflight
checks. They are preserved evidence of the earlier adapter matrix, not evidence
that the new pre-maintenance rejection or probe cleanup has run successfully.

On 2026-10-05, `validation/local/backup-compatibility-GAaskZ/report.json`
recorded all eight checks passing on PostgreSQL 16.15. Stock V27 and pinned V26
restored with SQL extension 0.8.7. The 0.8.1-SQL/new-0.8.7-binary V27 payload was
rejected without changing source rows; after explicit UPDATE, a new payload
restored and the unchanged old payload was still rejected. There is no automatic
old-payload conversion. C/libc/UTF8 to en_US.UTF-8/libc/UTF8 restored this small
six-row dataset; that observation is neither a general locale compatibility
guarantee nor validation of a locale guard. The original prefix tree and vector
binary hashes were unchanged, and the owned PostgreSQL child exited with code 0.
No failed full matrix run occurred. A separate final run after explicit client
TLS environment hardening is preserved at
`validation/local/backup-compatibility-PwRTQx/report.json`: all eight checks passed,
`clientTlsExplicitSynthetic` is true, source-prefix and vector-binary hashes are
unchanged, and the owned PostgreSQL child (PID 8387) exited with code 0. That run
also covers the updated opt-in native test, bounded shutdown and negative-case
target database metadata. Earlier evidence is preserved rather than relabeled.

## Source provenance and scope

After the final run, the prime retained both reports and all eight original typed
payloads with checksum readback, then removed only the two owned runtime copies,
test clusters, temporary legacy source copies and synthetic TLS files. See
`validation/local/backup-compatibility-cleanup-20261005.json`. The source prefix
was not removed or changed. Run-directory paths in the historical reports are
evidence of their original execution, not reusable database locations.

The official `v0.8.1` tag is checked against commit
`778dacf20c07caf904557a88705142631818d8cb`. Downloads go only into the private
fixture and are checked before installation against these observed SHA-256 hashes
(they are not maintainer signatures):

| Source at the pinned commit | SHA-256 |
| --- | --- |
| `sql/vector.sql` | `7fb5bb279ef83bf9204bfac7405bb5c9a05e49f5ac7d64d1eb4464d103b80f32` |
| `vector.control` | `a0205f50f78f48402e3b5ff707a5225dd684360156ba6a591f02e9afa6a47120` |

Primary references:

- https://github.com/pgvector/pgvector/tree/778dacf20c07caf904557a88705142631818d8cb
- https://github.com/pgvector/pgvector/blob/f37c13f68b57d2c3472b2214fbcff699d6d34876/Makefile
- https://www.postgresql.org/docs/16/extend-extensions.html
- https://www.postgresql.org/docs/16/locale.html

This models **binary replaced before SQL extension UPDATE**, not execution of an
old binary or upgrade of an old physical cluster/index. The archive evidence is
the production typed payload and, for the coordinator rejection check, the real
encrypted container. The runner does not claim packaged application, successful
maintenance recovery, durable B cost-ledger replay or Keychain acceptance. The
baseline is explicitly C/libc/UTF8; ICU and original user locales are unverified.
Only the fixture's copied extension files change during execution; production
source files, migration SQL, migration hashes and the V27 schema are not edited by
the runner. The single owned cluster has sequential administrative operations;
this does not remove PostgreSQL's uncooperative-superuser check-to-DROP race.

## Final preflight cleanup

After checking the owned directories for open processes, the prime removed the
temporary differential package build and the `nz44fc` / `VjdhHc` runtime copies,
stopped test clusters, legacy source copies and synthetic TLS material. The two
reports, logs, original payloads and encrypted archives remain unchanged; all
214 retained evidence files were checked by hash. The exact 17 removed entries are
recorded in `validation/local/restore-preflight/cleanup.json`. Neither the original
source prefix nor either retained application bundle was removed. Historical
fixture DB paths are not reusable after this cleanup.

## Packaged interruption / restart follow-up

`native-interruption.cjs` exercises two opt-in restore I/O failure boundaries using a
retained Validation bundle and a **new automation claim per command**. It does not
modify the bundle or use an existing acceptance or real-account profile.

```sh
rtk proxy node validation/backup-compatibility/native-interruption.cjs \
  --app '<original-repository>/.native-product-<id>/Code Intelligence Validation.app' \
  --point AFTER_SOURCE_RENAME

rtk proxy node validation/backup-compatibility/native-interruption.cjs \
  --app '<original-repository>/.native-product-<id>/Code Intelligence Validation.app' \
  --point BEFORE_COMPLETED_CLEANUP
```

The first boundary throws after the real source rename but before its durability
acknowledgement; recovery should retain the pre-restore snapshot/source `92`. The
second throws during cleanup after B maintenance completion; recovery should retain
the completed restored snapshot/source `91`. Both start with a real backup of `91`
followed by actual UI reanalysis to `92`, and verify recovery plus one further normal
restart. Native picker/confirmation/error-box responses are controlled; OS UI dialog
interaction, real Keychain, nonzero cost obligations, SIGKILL and power loss are not
covered by this driver. Evidence is preserved under `validation/local/restore-interruption/`.

Exit code 0 is not sufficient for clean shutdown: a delivered shutdown recovery
error is recorded separately. The SDK-owned live child reference is retained for
early-exit cleanup; no historical PID can authorize signalling.

See `docs/audit/restore-interruption-2026-10-05.md` for exact results, failed attempts,
bundle identity and remaining release gates. Offline contracts run with
`node --test desktop/test/backup-interruption-hooks.test.cjs`.
