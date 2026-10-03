# T09 typed PostgreSQL backup adapter

Date: 2026-10-03. Scope: `desktop/src/backup-postgres.cjs` and
`desktop/test/backup-postgres.test.cjs`. This adapter reads approved logical data and
loads a separate fresh staging database. It never invokes `pg_dump`/`pg_restore`,
accepts archive SQL, drops a database, swaps application storage, or authenticates
financial obligations. The existing export policy is unchanged: **25 migrations,
52 application tables, 439 columns**.

## Main-only API

```js
const { createBackupPostgres, validateBackupSummary } = require('./backup-postgres.cjs');
const adapter = await createBackupPostgres({
  psqlPath, migrationRoot, installationId,
  connection: { host: '127.0.0.1', port, user, database },
  env: { PGPASSWORD }, // Optional trusted LD_LIBRARY_PATH / DYLD_LIBRARY_PATH only.
  mode: 'export',    // or 'staging'
});
const summary = await adapter.exportRows({ writeRow: async projectedEnvelope => {} });
const liveSequenceHighWater = await adapter.readSequenceHighWater();
const livePreferenceRevisionHighWater = await adapter.readPreferenceRevisionHighWater();
await adapter.close();
```

The factory accepts optional trusted `spawn` and a reduced `timeoutMs` for tests.
The returned object is frozen. Neither renderer nor archive data supplies a process,
connection, environment, migration path, SQL identifier, or SQL statement.
`installationId` is a canonical UUID supplied by current main identity.
The psql executable and migration directory must be absolute canonical paths without
symlink resolution; each SQL file is a regular nonsymlink file with its reviewed SHA.
Every top-level `.sql` filename must match the pinned migration inventory, including
rejection of extra repeatable/undo/unclassified migrations. Verified bytes are retained
for initialization; a subsequent path replacement does not change the executed SQL.

An export summary is an owned frozen object:

```text
version: 1
schema: exact REVIEWED_SCHEMA
ownerUserId: canonical positive signed-64-bit decimal string
catalogSha256: SHA-256 of the normalized catalog description
sequenceHighWater: { "table.column": nonnegative signed-64-bit decimal string, ... }
preferenceRevisionHighWater: { "userId": nonnegative signed-64-bit decimal string, ... }
tableCounts: { each of all 52 reviewed names: canonical decimal count }
tableSha256: { each of all 52 reviewed names: SHA-256 }
rowCount: canonical decimal total
```

`validateBackupSummary(value)` is a **pure shape/limit/schema assertion** returning
an owned frozen copy. It performs no I/O. A syntactically valid `catalogSha256` or row
digest remains an unverified claim; this function grants no live DB, archive, identity,
source or financial authority. It rejects missing table coverage, unsafe numeric
metadata, excluded-table nonzero counts, changed migrations, extra keys and accessors.

Rows use exactly `backup-export-policy.projectRow` envelopes. Their table order follows
`REVIEWED_SCHEMA.tables`; SQL row order follows the explicit primary key. Empty and
excluded tables have count zero and SHA-256 of empty bytes. Each table digest is over
recursive key-sorted JSON of each projected envelope followed by LF. Counts/digests
are accumulated while streaming and checked against SQL section trailers and mandatory
completion records. Partial callback output is not a completed backup.

## Read boundary and catalog validation

Each export uses one `READ ONLY REPEATABLE READ` psql transaction. Only its header query
is initially written to stdin. JavaScript must validate catalog, history, owner and
terminal-job checks before the writer sends the first product-row SELECT. A failed
header therefore produces no product row query or callback. Only selected policy columns
enter row JSON: managed ciphertext, nonces, token hashes, original folders and path grants
are never selected merely to redact them afterwards.

The header checks exact application column/type/nullability/generation descriptors,
25 successful SQL Flyway rows with script/version/CRC, regular tables without RLS,
the explicit public application function-name set, no rewrite rules, enabled triggers,
validated constraints/indexes, the explicit serial/identity sequence-name set and the
`pg_trgm`/`plpgsql`/`vector` extension-name set. `flyway_schema_history` is the one explicit
tool-owned relation exception; it is queried using fixed history columns, never exported.

The catalog SHA additionally covers defaults, constraint definitions, index definitions,
trigger definitions/state, nonextension public function definitions, sequence definitions,
extension versions and PostgreSQL major version. A staging database built from trusted
migrations must have the same SHA before loading. Cross-major/extension changes or
definition differences fail closed rather than silently adjusting the schema.
The exporter alone does **not** independently derive every live constraint/function body
from migration text. That exact baseline comparison occurs at staging load. Main must
keep output private until its complete source/archive/catalog verification succeeds.

Export scope is the whole installation. All profile/project IDs are retained, including
GitHub-only users. Exactly one LOCAL or LOCAL_LINKED identity must have the current main
installation key; foreign/multiple/local-without-key identities fail. `local_key` is not
exported. QUEUED/RUNNING/CANCELLING jobs and RUNNING job steps block export. A failed job's
historical PENDING steps can remain; operational approval/receipt tables restore empty.
Main still must quiesce writers and stop admissions. Sequence values are non-MVCC state,
so an RR transaction is not a substitute for that maintenance barrier.

## Precision and serialization

PostgreSQL emits selected fields as lexical strings or SQL null. Bigint/numeric values
stay decimal strings, timestamps use UTC with six fractional digits, and boolean/integer/
double/vector values enter only their policy codecs. Text is not trimmed, rewritten or
reconstructed through application services. SQL NULL is `null`; JSONB literal null is
`{json:null}`. JSONB is emitted as its original lexical text inside the outer row envelope.

Before JSON.parse, each JSONB numeric token is compared mathematically with the decimal
serialization of its prospective JavaScript Number. Nonfinite numbers, negative zero,
unsafe integer values, underflow/overflow and decimal rounding are rejected. Decimal-scale
differences such as `0.1000` to `0.1` preserve JSON numeric value. Arbitrary precision values
are never changed to strings. Numeric strings and escaped string contents are untouched.
The policy then applies its depth/member/node/UTF-8 and 8 MiB row limits.

These are intentionally bounded supported inputs. An unsupported number, over-limit text,
timestamp outside the policy range or malformed value aborts; no truncation or fallback
to an opaque dump occurs. Freeform user notes/chat/code can contain user-pasted secrets;
structural credential exclusion does not claim every allowed text is secret-free.

## Fresh staging and trigger-respecting load

`mode:'staging'` requires a database name matching
`ci_backup_stage_[0-9a-f]{16,32}`. Main creates/owns that separate random database.
`initializeStaging()` requires no preexisting public relations/functions, applies only
the 25 verified migrations and creates fresh Flyway history from those same bytes.
Its SQL checksum follows Flyway CRC32 over UTF-8 lines excluding separators/initial BOM.
Archive history is never imported. The initialized catalog is read and validated before
COMMIT. Migration/schema failure permanently consumes that adapter's staging attempt.

```js
await staging.initializeStaging();
const result = await staging.loadRows({
  rows: asyncIterableOfProjectedEnvelopes,
  expected: archiveSummary,
  liveOwnerUserId,                    // Required, main-observed; equals archived owner ID.
  livePreferenceRevisionHighWater,    // Required, main-observed map; {} is valid.
  liveSequenceHighWater,              // Optional trusted map; default floors are zero.
  writeAccounting: async envelope => { /* Collect only; not a journal settlement. */ },
});
```

Load rechecks its initialized catalog and empty tables in the load transaction. It
checks every row/envelope, count, table digest, owner and final iterator EOF. It rejects
extra/missing/changed rows and never reuses a staging attempt after failure. The sole
LOCAL/LOCAL_LINKED row retains its archived ID, which must equal `liveOwnerUserId`, and
receives only current main's installation key. Other owners are not remapped.

Projects initially have null current pointers; snapshots retain original immutable source
contract versions. Features initially have null parents. Manifests are inserted unsealed,
entries are inserted normally, and original `sealed_at` is applied afterwards. Generations
retain UUIDs and fencing epochs through `OVERRIDING SYSTEM VALUE`. Deferred references
are checked after original project/feature pointers are restored. No V23 trigger, FK or
identity constraint is disabled. Stored graph/note/task IDs and exact text are inserted
directly, never reparsed through normal services.

Every serial/identity sequence is advanced to max(archived high-water, trusted live floor,
loaded row IDs). `analysis_jobs.id` additionally considers historical manifest/generation
job IDs. Exhausted signed-64-bit sequence bounds fail. Sequence updates are nontransactional
PostgreSQL operations, so a failed stage must be discarded, never reused; original storage
is untouched. Main must pass current floors when preserving pre-restore high-water matters.

Credential and local-approval tables remain empty. Canonical V24 preferences take precedence
over the same user's legacy V15 keyless projection. A legacy projection is used only when
V24 has no row. No fake ciphertext or normal credential-save/provider call is used. Preferences
are always OFF with revision max(archive, trusted live)+1, rejecting overflow. If a restored
user has a live revision floor but no archived preference, a provider/model-null OFF row
preserves that floor. Absent archived users are not recreated from revision metadata.
Main still starts a fresh backend/channel/token epoch and maintains B's OFF latch.

The loader reads all approved rows back inside the same transaction and checks their
digests/counts, accounting for intentional settings/financial projections. It separately
checks actual OFF state and exact reseeded revisions. COMMIT is withheld until JavaScript
accepts that full readback. A trigger/codec/pointer/readback failure therefore cannot issue
COMMIT. `exportRows` is available on that stage only after successful load/publication.

## Accounting boundary

V12 usage rows retain their original nullable cost and nonauthoritative policy annotation.
No fake request UUID, proven-not-sent receipt or zero liability is invented from legacy usage.
V25 budget/request/evidence envelopes preserve exact financial data, but are **not inserted
into staging by this adapter**. After complete validation, readback and successful PG COMMIT,
they are passed to `writeAccounting`. The callback is a bounded data collector, not permission
to settle or replace B. Main must conservatively combine live A, authenticated B and archive
obligations, persist unknown legacy liability, preserve current policy and verify readback
before any application switch/reactivation. Empty table counts never prove no liabilities.

Failed accounting publication leaves a committed disposable stage unavailable through this
adapter and requires recovery/discard. It cannot undo, lower or erase a live financial hold.
The loader returns restored table counts/digests, accounting row count,
`reconciliationRequired:true` and `credentialsRestored:false`; this is not an AI permit.

## Process bounds and cleanup

Fixed psql invocation: `-X`, no password prompt, quiet tuples-only unaligned output,
pager disabled, `ON_ERROR_STOP=1`, loopback connection and `--file=-`. All SQL uses stdin.
Values enter fixed templates through UTF-8 JSON/base64; identifiers come only from reviewed
descriptors. Passwords/SQL are not argv and raw stdout/stderr/causes are not error messages.
The environment is closed: no inherited PATH/HOME/PGOPTIONS/PGSERVICE/NODE_OPTIONS.

Limits: 120 s operation/queue deadline (reducible), queue two, one million rows, 16 MiB
wire line, 1 GiB stdout, 2 GiB total stdin, 64 KiB discarded stderr and 64 MiB retained
financial/preference metadata. Per-statement deadline is 60 s, lock timeout 5 s.
stdin drain and async stdout iteration provide backpressure. Consumers and input iterators
are raced against the operation deadline; accounting callbacks also have a deadline and
close interruption. SIGTERM is followed by SIGKILL after 200 ms; failure to reap by 2 s
is reported explicitly. `close()` rejects queued work, terminates active work and clears
the owned password reference. Arbitrary same-process hostile callbacks/native compromise
remain outside this main-only data boundary.

## Evidence and limitations

Latest author candidate: **63 unit PASS, one opt-in real-PG SKIP**, failure/cancel/todo zero.
Syntax checks pass. Logs: `/tmp/ci-backup-postgres-unit-final-2026-10-03.log` and `.xml`.
Earlier first attempt was a test-file syntax error; it is not a product regression claim.
The 54/60-test intermediate counts are historical and must not be added to the final count.

Root independently ran the earlier candidate against two disposable PostgreSQL databases:
**55/55 PASS = 54 unit + one real integration case**, zero skips/failures. Evidence:
`/tmp/ci-backup-postgres-real-first-2026-10-03.log` and `.xml`. The integration applies
trusted migrations, exports synthetic users/retained manifests/notes/settings/usage and
loads a second DB. It checks exact text/large IDs, SQL-null/JSON-null, sealed_at, retained
identity, fencing sequence floor, no credential restoration, canonical preference precedence,
OFF/revision advancement and rejection of an unsafe JSONB integer. It does not contain real
keys, source files or paid provider calls. The nine subsequent unit cases and pure-summary
export are verified by the latest unit run; do not label the first real run a rerun of all 63.

The author additionally invoked the installed **Flyway 12.4.0 ChecksumCalculator** directly,
without Gradle or DB access: all 25 migration CRCs match. Probe/output:
`/tmp/BackupFlywayChecksumProbe.java`, `/tmp/ci-backup-flyway-checksums-2026-10-03.txt`.
Actual staged Spring/Flyway startup remains a separate root integration gate.

Frozen SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `desktop/src/backup-postgres.cjs` | `d09fb2be5a04d9cd3d225defef06d846056aa2a5e37758de63c2e560d98eafa9` |
| `desktop/test/backup-postgres.test.cjs` | `4eb86f7447233647dfbadb37ad0e13b3de5f709b6ee8614873cd4ea659df2f33` |
| latest unit log | `e91e4ae5579574b5f42bfd785e3d59c86010ab8482b123721a2dfea723a92ace` |
| latest unit XML | `ef94d95f807e7c06916f79526dd5e6fb6f7cab9b34bc285d9fe87cfb3d932074` |

This adapter alone does not complete T09 or establish release readiness. Parent integration
still owns maintenance/drain, retained source coverage/authenticity and pinning, payload/container
authentication, sufficient space, B sealing/conservative union, stage financial reconstruction,
fresh runtime/session/channel identity, durable recovery/swap and source/reference checks.
Legacy Git-backed source completeness and polymorphic cross-row reference semantics are not
certified by ordinary FK checks. No user database, Keychain, installed app, GUI, network provider,
publication, paid call, commit or deployment was accessed by this author task.
