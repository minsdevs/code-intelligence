# PostgreSQL typed-backup compatibility fixture

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
- The existing opt-in native typed-backup test, including its updated V26
  platform-identity fixture columns.
- A same-0.8.7 C-to-`en_US.UTF-8` (or `en_US.utf8`) libc target, when that locale
  is installed. Source and target database encoding/provider/collate/ctype/version
  are recorded. The observed restore/refusal applies to this small synthetic
  dataset only; an unavailable locale is explicitly reported as skipped.

## Observed run

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
the production typed payload; the runner does not claim encrypted-container,
packaged application, maintenance recovery or Keychain acceptance. The baseline is
explicitly C/libc/UTF8; ICU and original user locales are unverified. Product
source files, migration SQL, migration hashes and the V27 schema are unchanged.
