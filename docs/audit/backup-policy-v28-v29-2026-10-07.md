# Backup policy review of V28/V29 — 2026-10-07 (unit w5-backup)

## Result

`V28__foreign_key_lookup_indexes.sql` (w2-perf) and `V29__local_source_scope.sql` (w3-import) were
merged without a backup-policy review. The desktop backup adapter refused the bundled migration
directory (`BACKUP_PG_MIGRATIONS`), so backup, restore and the pre-update checkpoint target were
blocked or wrong on the next candidate. The policy now pins both migrations; export is V29; exact
V27 and V26 archives restore into a V29 database through pinned restore-only inventories; every
other inventory is refused. Packaged acceptance happens on the next coordinator candidate. This
is not a gate verdict; the release verdict stays **NO_GO**.

## Review of the two migrations

| Migration | Content | Backup consequence |
|---|---|---|
| V28 | nine `CREATE INDEX` on existing FK columns | no column/table change; changes the catalog fingerprint (indexes are part of `catalogSha256`) |
| V29 | `ADD COLUMN scope text NULL CHECK (octet_length 2..131072)` on `local_source_approvals` and `job_local_source_inputs` | both tables are `excluded` (no row is exported or restored, and product-state restore deletes their rows); the new columns are `["scope", "text", true, "none", "omit"]` |

## Decisions

- **Current export schema: V29.** `MIGRATIONS` lists V28/V29 with the exact file SHA-256
  (`88dd245a…2db`, `e98df3f2…8ac`); the export policy accepts only the full V1–V29 inventory.
- **V27 archives restore into V29.** Row shape is unchanged (V27 and V29 select the same columns
  of the same tables), but the archive's `catalogSha256` is the V27 catalog, which differs from
  V29. Without a reader the shipped V27 archive is refused (`BACKUP_PAYLOAD_SUMMARY`/
  `BACKUP_PG_SCHEMA`, shown by mutation below), so a restore-only `REVIEWED_V27_SCHEMA` was added.
  Staging captures the V27 catalog fingerprint from the pinned local SQL after V27 (as it already
  did after V26) and admits a V27 summary only against that fingerprint. Rows load unchanged; the
  staged database is V29 (V28 indexes present, `scope` columns nullable and the excluded tables
  empty), and readback hashes must equal the archive hashes.
- **V26 archives still restore** (file outcome upgrade, zero measurements) — the V26 inventory is
  now derived from the V27 one, so it also lacks the `scope` columns.
- **Refused:** V25 and older, a V28-only inventory (no build ever exported at V28: the old policy
  refused it), any future migration, any changed migration hash/filename, and hybrids (V27
  migrations with V29 tables, V29 migrations without `scope`). No inventory is inferred from a
  prefix or from missing columns.
- **Archive format unchanged:** container format 3, payload version 1, summary version 1. The
  summary already carries the exact migration inventory, which is what selects the reader. An
  older (V27) build receiving a V29 archive refuses it fail-closed (`SCHEMA_MISMATCH`); there is
  no forward compatibility.
- **Updater:** `TARGET_FLYWAY` (derived from `REVIEWED_SCHEMA`) is now 29. Before this fix it was
  27, so a build bundling V28/V29 started on a V27 profile would have recorded `flyway 27 >= 27`
  and skipped the pre-migration checkpoint. Update manifests for the next build must declare
  `schema.flyway >= 29` (`update-manifest.cjs` refuses a lower value as a downgrade).

## Red / green

Red runs used the pre-fix sources of `0be7c30` with the new tests.

| Test | Red (pre-fix) | Green |
|---|---|---|
| `backup-postgres.test.cjs` (74 existing tests) | `BACKUP_PG_MIGRATIONS` ×74 | pass |
| policy "reviewed inventory matches every migration and current source column" | fail (file list differs) | pass |
| policy "V28/V29 are pinned: export is V29 only, V27 is an exact restore-only inventory and unknown migrations are refused" | fail | pass |
| postgres "V27 restore authenticates the pinned V27 catalog and loads unchanged rows into the V29 schema" | fail | pass |
| postgres "archives claiming an unknown, partial or hybrid migration inventory are refused before staging input" | fail | pass |
| postgres "staging requires exactly the pinned V26 then V27 legacy catalogs before the current header" | fail | pass |
| payload "reader accepts an exact V27 archive with unchanged rows while the writer stays V29-only" | fail | pass |
| runtime "old-archive policy: an exact V27 archive restores unchanged into V29; a V28-only or hybrid inventory is refused" | fail | pass |
| update-startup "pre-migration checkpoint target is the reviewed backup schema head and the newest bundled migration (V29)" | `27 !== 29` | pass |
| native "V27 exporter payload restores unchanged into V29 with the V28 indexes and V29 scope columns" (opt-in `CI_BACKUP_V27_PG_BIN`) | new | pass, real PostgreSQL |
| native "V26 exporter payload restores into V29 …" (opt-in `CI_BACKUP_V26_PG_BIN`, shared helper) | — | pass, real PostgreSQL |

Native tests used candidate `LA8ZS9`'s bundled `postgres/bin` (read only) with a fresh private
cluster, port and TLS. The V27 source side runs the exporter and payload writer of `42d3260`;
its four backup files are byte-identical to the `src/` files in `LA8ZS9`'s `app.asar` (checked).
Mutation: removing only the V27 reader (`LEGACY_CATALOGS`/`LEGACY_SCHEMAS` without 27) turns the
mock V27 test red (`BACKUP_PG_SCHEMA`) and the native V27 test red (`BACKUP_PAYLOAD_SUMMARY`).

Suites (this worktree, all read from output):

- `node --test test/backup-*.test.cjs test/update-*.test.cjs test/source-vault-backup.test.cjs`
  with `CI_BACKUP_V26_PG_BIN`, `CI_BACKUP_V27_PG_BIN`, `CI_UPDATE_CHECKPOINT_PG_BIN` = LA8ZS9
  `postgres/bin`: **1525 tests, 1506 pass, 0 fail, 19 skipped** (other opt-in native tests),
  including the recovery matrix test and the real-PostgreSQL update checkpoint test.
- Backend (Gradle `--offline cleanTest`): `LegacyMigrationWalkTest` 1/1 (walks V1–V29 with
  sentinels), `ApplicationIntegrationTest` 4/4 (Flyway "now at version v29").
- Whole desktop suite `node --test test/*.test.cjs`: **3295 tests, 3249 pass, 1 fail, 45 skipped**;
  the failure is the known unrelated dependency-downloader "upstream HTTP failures retain the
  stable builder server-error retry behavior".

## Guard against recurrence

The guard already exists and is the one that caught this: `backup-export-policy.test.cjs`
"reviewed inventory matches every migration and current source column" compares the backend
migration directory with `MIGRATIONS` (and every column added by `CREATE TABLE`/`ADD COLUMN`
with the policy), and the adapter refuses an unlisted migration at runtime. **Unit owners who add
a Flyway migration must update `desktop/src/backup-export-policy.cjs` in the same change**: the
`MIGRATIONS` entry with the file SHA-256, a column tuple with a reviewed disposition for every new
column/table, the restore-only inventory for the previous export schema if archives at that
schema must keep restoring, and run `desktop/test/backup-*.test.cjs`.

## Changed product paths

- `desktop/src/backup-export-policy.cjs` — V28/V29 pins, `scope` tuples, `REVIEWED_V27_SCHEMA`,
  reader table keyed by exact migration count.
- `desktop/src/backup-postgres.cjs` — staging fingerprints V26 and V27 catalogs; compatibility
  selects the fingerprint by exact inventory; `allowV26` renamed `allowLegacy`.
- `desktop/src/backup-payload.cjs` — V26 file-shape detection no longer equates "current" with 27.
- `desktop/src/update-startup.cjs` unchanged; `TARGET_FLYWAY` follows the policy.

## Follow-up (after integration 3b05af4)

| Item | Red | Green |
|---|---|---|
| `validation/backup-compatibility/run.cjs`: current scenarios are V29 (`stock-v29-to-v29-0.8.7`, old/updated SQL V29); V26 restores into V29; new `pinned-historical-v27-to-v29-same-0.8.7` (producer `42d3260`); preflight accepts V29, V27 and V26 and refuses old-SQL V29 | not rerun at the old code (disk budget); the old V26 check asserted 27 Flyway rows (old line 329) where staging now applies 29 | **PASS 11/11**, `validation/local/backup-compatibility-h4v8Yw/report.json` (PostgreSQL 16.15, child exit 0, `portClosed`, `originalPrefixUnchanged`, `vectorBinaryUnchanged`) |
| `GithubCredentialStorePostgresTest` (opt-in) expects 29 migrations; run through `validation/pre-release/run-auth-store.cjs --app` with LA8ZS9's bundled PostgreSQL, offline, synthetic | `auth-store-SJSCRl`: `expected: 27L but was: 29L` (line 64) | `auth-store-jQwD9N`: PASS, 6/6 |

The runner needs `bin/pg_config` and refuses a path inside `.app/`, so its prefix was a private
copy of LA8ZS9's `runtime/postgres` (file-for-file identical; checked) plus `pg_config` from the
preserved source prefix, used only for `--sharedir`. As documented, the runner fetched the three
public pgvector v0.8.1 files (tag ref, SQL, control) without credentials and checked their
pinned SHA-256. Unit tests in that directory (`backup-recovery-matrix`, `backup-interruption-hooks`,
`owned-crash`): 52/52. After the run, the stopped cluster, runtime copy and legacy source copies
were removed (`cleanup.json` in the report directory); the report, logs and payloads are kept.

## Limits and what remains

- Packaged acceptance (a real LA8ZS9 V27 backup restored by the next candidate, the native
  recovery matrix, the updater checkpoint across V27→V29) remains for the next candidate.
- The V27 catalog fingerprint assumes the archive's live catalog equals pinned V1–V27 SQL in an
  empty database (same assumption as the existing V26 and current paths); drifted extension
  versions are still refused, not converted.
