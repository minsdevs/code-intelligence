# T09 pure backup export policy — development contract

Date: 2026-10-03. Scope: `desktop/src/backup-export-policy.cjs` and its synthetic Node tests.
This is a pure, synchronous schema assertion and typed single-row projection primitive. It does not
read a database, emit SQL, export files, create a backup, restore data, grant access, contact a provider,
or connect to Electron/main. Its only runtime import is `node:util` for rejecting JavaScript proxies.

Current inventory: **V1–V25, 25 migrations, 52 tables, 439 columns**. The original
V1–V23 and V24 records below are historical; the final V25 section defines the
current additive financial-data classification and its verification evidence.

The frozen requirement is `docs/multilanguage-plan-2026-10-02/05-security-performance-operations.md:132`
(explicit credential allowlist/keyless settings), with the restore/safety/key boundaries at lines
84–88 and 104–130. The implementation keeps the existing PostgreSQL/Flyway/Electron architecture.
No migrations, existing production entrypoints, original data, keys, or other agents' files are changed.

## API and schema assertion

```js
const {
  createBackupExportPolicy, REVIEWED_SCHEMA, POLICY_LIMITS, BackupExportPolicyError,
} = require('./backup-export-policy.cjs');

// A trusted future adapter must independently obtain and verify the source schema.
// Passing this constant is useful in synthetic tests, NOT evidence about a live database.
const policy = createBackupExportPolicy(REVIEWED_SCHEMA);
const names = policy.columnsFor('notes'); // frozen approved input column-name list
const projected = policy.projectRow('notes', {
  id: '9007199254740993', project_id: '7', title: '  Note  ', content_md: '# 원문\r\n',
  created_at: '2026-10-03T12:00:00.123456Z', updated_at: '2026-10-03T12:00:00.123456Z',
});
```

`REVIEWED_SCHEMA` and all descendants are frozen. The original V1–V23 candidate contained
23 migrations and 48 tables, 388 columns (373 CREATE columns plus 15 ALTER additions).
Its SHA-256 values remain pinned literals from the reviewed source bytes; the V24 and V25
sections specify subsequent additive inventories. No runtime hashing of supplied files
approves a new schema automatically.
`createBackupExportPolicy` compares this exact shape:

```js
{
  migrations: [{ version: 1, filename: 'V1__init.sql', sha256: '<pinned SHA-256>' }, /* all 23 */],
  tables: [{
    name: 'users',
    columns: [{ name: 'id', type: 'bigint', nullable: false, generation: 'serial' }, /* all columns */],
  }, /* all 48 */],
}
```

Order is immaterial; missing, additional, duplicate or changed entries fail. Unknown descriptor fields,
changed hash/name/version/type/nullability/generation, accessors, symbol keys, sparse arrays, proxies,
and unexpected prototypes fail. The complete schema is checked, including excluded tables/columns.
Input inventory objects are neither mutated nor retained; subsequent caller mutation cannot relax a
created policy. Unknown table requests fail rather than returning an unrestricted/default projection.

Types are normalized **source descriptor spellings**: `bigint`, `integer`, `double precision`, `text`,
`timestamptz`, `date` (added in V25), `boolean`, `jsonb`, `numeric`, `uuid`, `bytea`, `varchar(N)`, `char(N)`, `vector(1536)`.
Generation is `serial`, `identity-always`, or `none`. Bigserial is `bigint` plus `serial`; V23
`analysis_generations.fencing_epoch` is `bigint`, non-null, `identity-always`. V20 makes
`users.github_id` nullable. PostgreSQL catalog aliases such as `timestamp with time zone` and
`character varying(N)` require explicit normalization by a reviewed adapter; implicit aliases are
not accepted here. A supplied schema assertion is not live catalog verification or ownership proof.
Defaults, indexes, foreign keys, trigger/function bodies, extension versions, grants and actual applied
Flyway state are not compared by this API. Full catalog validation remains a separate integration gate.
The descriptor covers application tables only: an actual catalog adapter must separately classify
tool-owned `flyway_schema_history` and extension objects, and reject unclassified tables/views.

## Explicit row selection and dispositions

Every column has a literal `keep` or `omit` disposition in the source. `projectRow` accepts exactly
`columnsFor(table)`, with no unknown/missing fields. It rejects whole raw entities/rows containing
excluded columns; it does not read credentials and then redact them. Shape validation checks all names
before interpreting any field. Getters/toJSON/valueOf are not invoked. Excluded table rows are refused
before inspecting even their shape. The result is a frozen owned projection, not an executable restore
instruction. The module grants no right to issue even an allowlisted SELECT.

| Table/scope | Selected data and result semantics |
| --- | --- |
| `github_credentials`, `local_source_approvals`, `job_local_source_inputs` | No columns; `projectRow` throws `TABLE_EXCLUDED`. Schema descriptors remain in the exact inventory. No tokens, approval receipts, roots/devices/inodes or expiry/consumption authority are projected. |
| `user_ai_settings` | Only id, user_id, provider, created_at, updated_at, model. Excludes encrypted_key, nonce, key_version. Result `kind=keyless-ai-preference`, `settings={enabled:false,reconnectRequired:true,allowEnvironmentFallback:false}`. No fake ciphertext, masks or provider call. |
| `users` | Excludes local_key; preserves approved profile fields and existing IDs. `identity={authorityIncluded:false,ownerBindingRequired:true}`. Does not authenticate a local owner or bind/reassign an installation identity. |
| `projects` | Excludes clone_path, local_path, pulls_etag. Preserves approved metadata/IDs/pointers and nullable legacy source_type. `sourceAccess={pathAuthorityIncluded:false}`. Does not grant or regenerate any path. |
| `analysis_jobs`, `analysis_job_steps` | Excludes opaque error text. Preserves selected historical fields without rewriting status or IDs; `execution={resumable:false,dispatchAllowed:false}`. QUEUED/RUNNING/CANCELLING jobs and RUNNING steps are rejected. PENDING steps can be historical remainder of a failed job; they remain non-resumable projections. |
| `ai_usage_logs` | Exact legacy fields, including nullable decimal cost, plus `accounting={authoritative:false,reconciliationRequired:true}`. Does not invent request UUID, settled proof, reserved amount or zero cost. Never a replacement safety ledger. |
| All other reviewed tables | Explicit private product data (`kind=data`) under the selected typed input contract. Includes notes/references/tasks/goals/learning/adjudication, graph/evidence, AI conversation history and retained-source key-ID references. |

Common envelope: `{policyVersion:1,table,kind,values,...fixed annotations}`. Column ordering follows the
fixed descriptor; values are not trimmed, sanitized, case-folded, normalized to current snapshot IDs,
renumbered or truncated. No note/task service is called. Error fields are **absent**, not copied as
text; a future staging loader can explicitly create SQL NULL for them. Preserved arbitrary freeform
notes, task descriptions, code, JSON or chat text may contain a manually pasted secret. This primitive
does not detect/remove such text or claim a globally secret-free payload. Its guarantee is structural
exclusion of designated managed credential/capability columns, with exact permitted-value preservation.

The OFF/reconnect and non-resumable/non-authoritative annotations are data only. They do not change
current settings, prevent environment-key fallback, close sessions, freeze a scheduler or reconcile a
budget. All those product enforcement paths remain unimplemented here.

## Typed row values, ownership and fixed bounds

- SQL NULL is JavaScript `null`, accepted only for nullable columns; absent/undefined is rejected.
  Bigint values are canonical signed 64-bit **decimal strings**, including IDs beyond 2^53. Numbers,
  BigInt objects/primitives, exponent notation, leading zeros, whitespace and out-of-range values fail.
- SQL integer is a finite signed 32-bit integer Number; boolean is a Boolean primitive; double precision
  is a finite Number. Negative numeric zero is rejected where JSON serialization would lose its sign.
  `numeric` is an exact plain-decimal string, up to 256 characters, without exponent/NaN/Infinity.
  Decimal scale/trailing zeros are preserved; the module never parses costs to floating point.
- Timestamptz input is a valid year 0001–9999 UTC ISO string with optional 1–6 fractional digits. Leap
  dates are checked; timezone offsets, leap seconds, Date objects and truncation to milliseconds fail.
  Strings retain exact fractional digits. Upstream UTC/microsecond conversion is not implemented.
- UUID input is canonical lowercase hex. Current char(N) columns contain exact lowercase hex hashes or
  key IDs; varchar limits count Unicode code points. Source contract versions and known SQL/application
  discriminators are checked. Selected V23 size/count/COMMITTED-time/current-pointer rules are checked.
  This is not a full SQL-constraint, foreign-key, source-manifest or cross-row ownership validator.
- JSONB uses `{json: <plain JSON value>}` to distinguish SQL NULL from JSON literal null. Its trees are
  copied recursively and frozen; shared inputs produce independent copies. Literal `__proto__` keys
  remain own data properties without prototype mutation. Cycles, accessors, proxies, sparse arrays,
  functions, symbols, typed buffers, nonplain objects and non-finite/unsafe-integer numbers fail.
  Fractional values are finite JavaScript Numbers. **Already-rounded upstream JSONB decimals cannot
  be detected or recovered here.** A future PG adapter must preserve/explicitly reject arbitrary-
  precision JSON numerics before JSON.parse loses information; this remains an integration blocker.
- Vector input is a dense 1536-element finite Number array in float32 range; a new frozen array is
  returned without implicit quantization. Actual pgvector codec round-trip fidelity is not certified.
- Fixed limits: 2 MiB UTF-8 per string; 8 MiB conservative encoded-row budget including 2 KiB envelope
  reserve; depth 16, 16,384 visited nodes, 4,096 members per nested container; numeric length 256.
  UTF-8 byte lengths, escaped characters and nested values count toward the budget. NUL/unpaired
  surrogates fail. Over-limit values fail without truncation or input mutation. These intentionally
  bounded supported inputs are not a claim that every existing database row fits the prototype.

No caller row/nested object is returned by reference or retained internally. Output and published
constants are frozen. Same-process malicious mutation of Node globals/native intrinsics, memory
compromise and initial allocation of enormous caller objects are outside this data boundary's threat
model. This API is not exposed to a renderer, socket or untrusted execution environment.

Error codes are `SCHEMA_MISMATCH`, `TABLE_UNKNOWN`, `TABLE_EXCLUDED`, `INVALID_ROW`, `ACTIVE_JOB`, and
`LIMIT_EXCEEDED`. Error text is static and contains no supplied column names, paths, values or causes.
Shape/member violations can report `INVALID_ROW`; callers must not depend on messages for recovery.
The module has no logging, fallback, credential access, environment lookup or mutable allowlist option.

## Verification and remaining release boundaries

Author syntax and Node synthetic tests: **68/68 PASS**, failure/cancel/skip/todo 0. Coverage includes
all 45 permitted tables, literal schema/migration inventory, mutations of every one of 388 column
types, unknown/missing/duplicate descriptors, credential/path sentinels, excluded getters, wrong states,
64-bit IDs, exact note/task corpus, NULL/JSON-null, microseconds, invalid Unicode, nested ownership,
cycle/proxy/prototype cases, field/row/depth/member/node bounds and vectors.

Author evidence: `/tmp/ci-backup-export-policy-test.log` and `.xml` (the final run below identifies the
frozen code/test candidate). No author Gradle, database, provider, Keychain, GUI or user-data execution.
Root then ran the complete frozen desktop candidate: **456/456 PASS**, failure/error/skip/cancel 0,
including these 68 cases and the prior 388. Evidence: `/tmp/ci-desktop-final-2026-10-03.log`/`.xml`.
Production SHA-256: `9a4e0072eaa5a7e263d5ce2f8df2fb18aa7df305b7855931c4d98f50dd3bc16d`;
final test SHA-256: `c52f9e0cfbfd701c5890a505663abccf8dc0bfb9cf7d7771208b868b9dafc2df`.

Root's final real PostgreSQL catalog probe also passed **8/8**: 23 bundled migrations applied to
an isolated, temporary, network-disabled PostgreSQL container; 48/388 type/nullability/generation
match; seven actual-DDL mutants rejected. It used cached images, no user database, and removed its
own container. Evidence: `/tmp/ci-backup-export-catalog-final-2026-10-03.log`; reproducible probe:
`docs/audit/verify-backup-export-catalog.cjs`. This uses psql migration application, not Flyway history
validation. It does not certify defaults/constraints/functions, row codecs, full database export,
restore, provider OFF or product backup correctness.

Independent review passed **21/21 synthetic probe groups**, with 904 explicit rejection assertions.
The reviewer independently inventoried 23 migrations/48 tables/388 columns and verified author/root
artifacts; the reviewer did not run the real DB or Gradle. The source guard originally ignored
non-versioned SQL filenames. Root corrected both inventory checks to compare every top-level `.sql`
filename before reading SQL or starting a process; independent VM probes confirmed rejection of
repeatable, undo, additional versioned and unclassified SQL files. No unresolved C/H/M finding remains
within this primitive's reviewed scope. Report: `/tmp/ci-backup-export-policy-independent-review-2026-10-03.md`
and `.json`. The original review hashes precede this evidence-only documentation update.

Remaining work includes trusted live
catalog/owner scope and precision-safe adapters; writer drain; source coverage/secret policy; actual
streaming data-only payload writer and staging importer; OFF/reconnect enforcement; B sealing/merge;
session/grant invalidation; key/source availability; path confinement; archive/container connection;
durable recovery and end-to-end restore invariants. Missing keys, unknown schema/data or unsupported
values must abort: no full pg_dump/format2/plaintext/credential/env-key fallback is introduced.
Passing this primitive's tests does **not** make format3 product backup/restore ready for release.

## V24 additive follow-up — AI connection preferences

The earlier 23-migration/48-table/388-column inventory and author 68/root 456/catalog
8 results above describe the preserved V1–V23 candidate. They are historical
evidence, not validation of this follow-up. The V24 candidate's pinned inventory was
**24 migrations, 49 tables, 395 columns**, with 46 permitted table projections and
the same three excluded tables. No V1–V23 migration pin, table/column descriptor,
selected-column list, or row disposition was changed.

The new reviewed migration is `V24__ai_connection_preferences.sql`, SHA-256
`5c77edd63d6dc98f04d0b91278b365bd0413688731a52e7b87869a9db83cbad3`.
The complete SQL bytes, including its constraints and existing-connection
backfill, remain pinned; the policy does not generate or alter that SQL. Source
schema assertion explicitly includes all seven new columns:

| Column | Source type/nullability | Projection |
| --- | --- | --- |
| `user_id` | bigint, required, not generated | Preserve exact signed int64 string |
| `provider` | text, nullable | Preserve `openai`, `gemini`, or SQL NULL |
| `model` | text, nullable | Preserve exact text or SQL NULL; non-NULL requires provider |
| `connection_state` | text, required | Omit; never select or read the original activation state |
| `revision` | bigint, required | Omit; never restore the original approval revision |
| `created_at` | timestamptz, required | Preserve exact validated UTC/microsecond string |
| `updated_at` | timestamptz, required | Preserve exact validated UTC/microsecond string |

`columnsFor('user_ai_preferences')` returns exactly
`['user_id', 'provider', 'model', 'created_at', 'updated_at']`. Its projection reuses
the existing `kind='keyless-ai-preference'` envelope and frozen annotations:

```js
settings: {
  enabled: false,
  reconnectRequired: true,
  allowEnvironmentFallback: false,
}
```

No credential bytes, fabricated encrypted key, nonce, key version, original
connection state, or original revision appear in these values. Provider/model
preferences can be represented without an API key. Raw rows containing
`connection_state` or `revision` are rejected before those fields are read, even
for valid source `OFF`/`ENABLED`/`RECONNECT_REQUIRED` states or revision zero. Their
types/nullability/generation are still part of the full source-schema assertion.
The primitive does not validate values of omitted columns by consuming them.
Unknown non-NULL provider enums fail; `{provider:null,model:null}` is permitted,
whereas a non-NULL model with NULL provider fails the projected V24 SQL constraint.
Free-form model text retains the existing typed-text limits and is not silently
trimmed, normalized, or replaced.

Both `user_ai_settings` and `user_ai_preferences` may describe the same `user_id`.
They remain separate, individually keyless projections. This policy does not
choose which row wins, infer precedence from timestamps or an omitted revision,
merge them, or upgrade either row into authority. A future staging loader must
define and verify cross-row precedence, bind ownership, preserve only permitted
preferences, invalidate old authorization revisions, and require fresh local
approval/reconnection before enabling AI. It must never invent credential bytes
to satisfy the legacy settings table or recover authority from environment keys.

The OFF/reconnect/environment-fallback annotations remain **data only**. This
follow-up does not implement a staging loader, change a running connection,
force provider OFF, exercise budget/journal reconciliation, or validate actual
backup/restore. The source migration's existing-key backfill to `ENABLED` is
deliberately not an export permission or a restorable activation decision.

Author verification on Node 26.5.0: syntax checks passed; updated synthetic unit
suite **77/77 PASS**, with failure/cancel/skip/todo all zero. All original 68 test
cases remain, with inventory counts and unknown-version fixtures advanced for
V24; nine additional cases cover the omitted-column rule, the complete new source
descriptor, keyless exact-value projection, enum/null/provider constraints,
authorization/credential extras, non-restorable activation/revision, every new
column's descriptor mutations, migration mutations, and same-user independent
rows. The full inventory check hashes all current migration files and rejects
unclassified SQL. A separate preservation check confirmed identical 23 old
migration pins, 48 old table descriptors/selected-column lists, and 388 old column
descriptors against the pre-edit module copy.

Evidence is separate from the previous candidate:

- Before the change: 67/68 PASS, with the one expected inventory rejection for
  unclassified V24, in `/tmp/ci-backup-policy-v24-before-2026-10-03.log` and `.xml`.
- Current author units: `/tmp/ci-backup-policy-v24-2026-10-03.log` and `.xml`.
- Preservation: `/tmp/ci-backup-policy-v24-preservation-2026-10-03.json`.
- Production SHA-256: `1a87193436c3923f657f27a90442a41a8220a821859475f594acb7e54e4c4d7e`.
- Test SHA-256: `55c5ca7f2e878e0ad4626d14de827db314d8fc03d5eaa51e83d9b463f16a6110`.

This author run used no Gradle, database, Docker, GUI, real credential, provider,
or live user data. Root's current complete desktop, real catalog, and backend
gates must be reported separately; the earlier 456/456 desktop and 8/8 catalog
passes do not cover V24. The remaining product restore blockers listed above
remain in force.

## V25 additive follow-up — financial obligations and budget diagnostics

The current inventory is **25 migrations, 52 tables, 439 columns**, with
49 permitted table projections and the same three excluded tables. V25 adds
14 budget columns, 22 ledger columns and 8 evidence columns. All 44 columns are
explicitly selected and preserved. No V1–V24 migration pin, table/column
descriptor, table kind, selected-column list or keep/omit disposition changed.
The new literal pin is `V25__ai_cost_reservations.sql`, SHA-256
`b5d547a4f0a24f263b8cf53983c57e446e0c9ee90a8f5c64e347e6ec89b1f1ec`.
This policy change does not modify that migration or certify its runtime behavior.

Every field below is `generation=none`; required means `nullable=false`.
Bigint fields remain exact signed-int64 decimal strings. Amounts, limits,
revisions, sequences and clock high-water fields with V25 nonnegative checks
also reject negative values; `ai_budget_gate.owner_user_id` must be positive.

| `ai_budget_gate` column | Type | Nullable | Classification |
| --- | --- | --- | --- |
| `installation_id` | text | no | Historical installation reference; no enrollment authority |
| `owner_user_id` | bigint | no | Historical owner reference; fresh ownership binding required |
| `policy_revision` | bigint | no | Policy diagnostic revision; cannot restore activation approval |
| `policy_sha256` | text | no | Canonical hash reference |
| `daily_limit_micro_usd` | bigint | no | Exact historical limit preference |
| `monthly_limit_micro_usd` | bigint | no | Exact historical limit preference |
| `reconciliation_required` | boolean | no | Historical flag; never the restored gate decision |
| `legacy_liability_unresolved` | boolean | no | Historical flag; cannot establish absence of debt |
| `journal_sequence` | bigint | no | Historical projection position; no journal authority |
| `journal_hash` | text | no | Historical journal hash reference |
| `journal_projection_sha256` | text | no | Historical projection hash reference |
| `clock_high_water_ms` | bigint | no | Diagnostic high-water value; cannot lower the live safety clock |
| `created_at` | timestamptz | no | Exact validated UTC/microsecond timestamp |
| `updated_at` | timestamptz | no | Exact validated UTC/microsecond timestamp |

| `ai_request_ledger` column | Type | Nullable | Classification |
| --- | --- | --- | --- |
| `request_id` | uuid | no | Obligation identity |
| `installation_id` | text | no | Historical installation reference |
| `owner_user_id` | bigint | yes | Historical owner reference or SQL NULL |
| `project_id` | bigint | yes | Historical project reference; deletion must not erase debt |
| `snapshot_id` | bigint | yes | Historical snapshot reference; deletion must not erase debt |
| `approval_id` | uuid | yes | Historical approval identity, not a preview/dispatch capability |
| `plan_sha256` | text | no | Plan hash reference; no opaque plan or prompt copy |
| `payload_sha256` | text | no | Payload hash reference; no payload bytes |
| `wire_body_sha256` | text | no | Wire-body hash reference; no HTTP body or headers |
| `dispatch_binding` | jsonb | no | Bounded owned JSON object under the metadata producer contract |
| `budget_day` | date | no | Exact canonical calendar day |
| `price_version` | text | no | Exact historical pricing reference |
| `reserved_micro_usd` | bigint | no | Exact reservation obligation |
| `status` | text | no | Historical obligation state, including in-flight/unresolved states |
| `actual_micro_usd` | bigint | yes | Exact settled amount or SQL NULL |
| `proof_sha256` | text | yes | Historical proof hash reference or SQL NULL |
| `liability_floor_micro_usd` | bigint | no | Exact liability floor; never inferred as zero |
| `conflict` | boolean | no | Historical conflict evidence |
| `journal_sequence` | bigint | yes | Historical recorded journal position or SQL NULL |
| `journal_hash` | text | yes | Historical journal hash reference or SQL NULL |
| `created_at` | timestamptz | no | Exact validated UTC/microsecond timestamp |
| `updated_at` | timestamptz | no | Exact validated UTC/microsecond timestamp |

| `ai_usage_evidence` column | Type | Nullable | Classification |
| --- | --- | --- | --- |
| `request_id` | uuid | no | Obligation identity |
| `proof_sha256` | text | no | Historical proof hash reference |
| `main_epoch` | text | no | Historical epoch identifier, not an epoch key or activation grant |
| `receipt_type` | text | no | `USAGE` or `PROVEN_NOT_SENT` evidence classification |
| `provider_request_id` | text | yes | Historical provider request reference or SQL NULL |
| `usage_dimensions` | jsonb | no | Bounded owned JSON object under the metadata producer contract |
| `actual_micro_usd` | bigint | no | Exact recorded amount |
| `created_at` | timestamptz | no | Exact validated UTC/microsecond timestamp |

Gate rows use `kind='budget-diagnostic'`, ledger rows `kind='financial-obligation'`,
and evidence rows `kind='financial-evidence'`. All three receive the fixed,
frozen annotation below independently of their historical field values:

```js
safety: {
  enabled: false,
  dispatchAllowed: false,
  activationAuthorityIncluded: false,
  reconciliationRequired: true,
}
```

Gate rows also receive
`accounting={historicalProjection:true,journalAuthorityIncluded:false,restoreMode:'PREFERENCES_AND_DIAGNOSTICS'}`.
Ledger and evidence rows receive
`accounting={obligationData:true,conservativeMergeRequired:true,replaceJournal:false,releaseLiabilityAllowed:false}`.
These are **data annotations**, not an implemented restore loader, live OFF switch,
merge, receipt authenticator, owner enrollment or proof of strict budget enforcement.
An old gate whose two reconciliation/liability flags are false still exports
those original values for diagnosis, while its separate fixed safety annotation
requires OFF and reconciliation. It must never clear the independent safety latch.

`RESERVED`, `DISPATCHED` and `UNKNOWN_HELD` rows remain exportable obligations;
they are not rejected like running analysis jobs or converted into resumable work.
`SETTLED` requires both `actual_micro_usd` and `proof_sha256`; other states require
both to be SQL NULL. `PROVEN_NOT_SENT` requires an exact zero amount. These checks
do not authenticate a receipt, prove dispatch never happened, trust a main epoch,
or authorize release of an existing hold. Hash-reference fields require exactly
64 lowercase hexadecimal characters; that syntax alone is not cryptographic proof.

The new `date` input is an exact `YYYY-MM-DD` string in years 0001–9999 with real
calendar/leap-day validation, preserved without timezone conversion. Date objects,
timestamps, timezone suffixes, BC/infinity, noncanonical padding and trailing
separators fail. Existing timestamptz behavior is unchanged. The two new JSONB
fields must contain JSON objects, not arrays, scalars, SQL NULL or JSON null.
They retain the existing deep-copy/freeze, precision and size limits. Monetary
columns never pass through JavaScript Number; numeric JSON already rounded by an
upstream decoder remains undetectable, as documented above.

No managed key/token/capability column is added. Unknown top-level fields such as
`requestPlanToken`, `trusted_enrollment`, `activation_capability`, `epoch_key`,
`api_key`, `request_body` or `prompt` are rejected before their values are read.
The approved `approval_id`, `main_epoch` and hash fields are historical identifiers,
not restorable credentials. **This is not a deep metadata allowlist or a complete
secret scanner.** Arbitrary text or object members inside `dispatch_binding` or
`usage_dimensions` are preserved under the typed JSON contract and could contain
a secret written by a malformed historical producer. The future writer must enforce
the exact financial-metadata producer contract and source policy; this primitive
cannot claim globally credential-free contents or recover lost JSON precision.

The future importer must preserve obligations even when their product project,
snapshot or user row was deleted. It must bind installation/owner scope, verify
completeness and cryptographic journal/proof relationships, and conservatively
merge into the independently surviving main journal. It must not replace that
journal with a backup, import database projection hashes as journal authority,
lower an existing liability/high-water mark, resume an old dispatch, or treat a
missing row as zero cost. Historical limit preferences must not silently approve
increased spending. The pure single-row API performs none of these cross-row or
runtime operations and grants no permission to read financial rows.

Author verification on Node **26.5.0**: both syntax checks and **92/92 synthetic
tests PASS**, failure/cancel/skip/todo 0. The existing 77 cases remain, with only
inventory counts/unknown-version fixtures advanced and V24 pin tests selecting
version 24 explicitly. Fifteen new cases cover all new fields and descriptor
mutations, migration pin mutations, all four ledger states, exact large money/IDs,
nullable historical references, invalid dates/hashes/settlement combinations,
metadata ownership and hostile accessors/proxies, capability-shaped extras,
immutable OFF/merge annotations, and the secret-scanning limitation. The source
inventory now recognizes lower-case `create table` in V25 and distinguishes its
table-level constraints from columns. It still compares **all** top-level `.sql`
filenames to the pinned list before accepting the inventory.

Evidence for this candidate:

- Baseline rejection: **76/77 PASS**, one expected unclassified-V25 inventory
  failure in `/tmp/ci-backup-policy-v25-before-2026-10-03.log` and `.xml`.
- Current author tests: `/tmp/ci-backup-policy-v25-2026-10-03.log` and `.xml`.
  XML SHA-256: `f30cf69f92c13569198fd699051098d6a208a0aaae00c60be476a4c18fef17d4`.
- Preservation check: `/tmp/ci-backup-policy-v25-preservation-2026-10-03.json`
  confirms all 24 old pins, 49 old table definitions/kinds, 395 old column
  definitions/dispositions and 49 old selected-column lists are identical.
- Policy SHA-256: `cda631a447291e6569ef8da92b2bfaaa4e27a88af2c4807f75905a711ac46cb5`.
- Test SHA-256: `01ed332502a84105b8c63fb0b4d2f414c3de42b9fd80233f54cbf91bd68f2b1a`.

These are author tests, not independent review. No author database, Gradle,
Docker, GUI, provider, credential or user-data operation was performed. Root's
actual V25 catalog, complete desktop/backend gates and independent review remain
separate. Earlier V23/V24 passes do not validate V25. The policy remains
disconnected from product export/restore, and the remaining restore, financial
reconciliation and release blockers above still apply.
