# T09 credential-free export: current schema and next implementation units

Prepared 2026-10-03 from repository files in `/Users/minseokchae/Dev/code-intelligence`.
This is a read-only design handoff, not an implemented exporter or product backup acceptance result.
No database, installed userData, Keychain, network, provider, `pg_dump`, or `pg_restore` was accessed/run.
No repository source file was edited for this handoff. Existing PostgreSQL, Flyway, JDBC, Electron,
source store, and safety journal remain the intended stack; no database rewrite is proposed.

All repository paths below are relative to that root; `:N` denotes an inspected source line. The
inventory is the **current V1–V23 source schema**, including uncommitted V21–V23 work, not a claim about
an installed database. Future schema changes must deliberately revise the export policy before use.

## Conclusions that affect the next implementation

1. **The current UI backup is not credential-free.** `desktop/src/main.cjs:501` invokes an unrestricted
   custom-format `pg_dump -d codeintel -Fc`; `desktop/src/backup.cjs:96` saves it and copies the entire
   repositories directory. Both encrypted credential tables and unfiltered Git objects/config/history
   can enter this plaintext format2 directory. Wrapping those bytes with `backup-archive.cjs` alone
   would preserve the secrets, not remove them. Priority P0 before claiming format3 production backup.
2. **“Delete AI key rows” does not mean OFF.** `V15__user_ai_settings.sql:7` permits only openai/gemini;
   `encrypted_key` and `nonce` are NOT NULL, with no enabled/reconnect state. `UserAiSetting.java:32`
   and `AiSettingsService.java:49` assume every row contains a decryptable key. `AIProviderConfig.java:46`
   falls back to environment credentials when the row is absent. A separate persisted OFF/reconnect
   preference plus an egress/resolve guard is required. Do not insert empty/fake ciphertext or call the
   regular settings setter during import (`AiSettingsService.java:93` tests the provider connection).
3. **Identity is a binding, not restorable authority.** `main.cjs:667` stores the current localIdentity in
   `secrets.enc`; `DesktopAuthenticationFilter.java:41` looks up `users.local_key` with that value.
   Preserve owner/user IDs while binding the restored local-owner row to the already-existing main
   identity. Never replace `secrets.enc`, vault keys, or installation identity from an archive.
4. **Restoring operational rows can reauthorize work or reduce current accounting.** V22 contains
   paths/inodes and approval-token hashes; Redis contains sessions; legacy `ai_usage_logs` drives the
   current daily-token sum (`AiUsageService.java:30`). None can be blindly restored as fresh permission
   or as the authoritative cost high-water. Backup data never overrides safety area B.
5. **V23 changes import ordering.** Retained snapshots must be inserted with their exact
   `source_contract_version`; a sealed manifest cannot be inserted directly; its entries must be loaded
   before sealing (`V23:102`). `analysis_generations.fencing_epoch` is generated-always identity, and
   project current-generation/snapshot pointers are a composite deferred FK. A plain row replay into an
   already-migrated staging DB needs a trusted, explicit restore loader, not `INSERT *` or disabled guards.
6. **Existing legacy/GitHub source coverage is a real gate.** V23 permits `source_kind='LOCAL'` only and
   legacy snapshots stay `source_contract_version=0`. `FileService.java:101` still uses verified Git-blob
   reads for legacy data. Copying all `data/repos` as a fallback would defeat source filtering; dropping
   it silently would lose source evidence. Until a reviewed legacy/GitHub export adapter exists, a full
   source-preserving format3 export must fail with a concrete unsupported-source reason for those cases.

## Shipping severity and implementation priority

These ratings describe the impact of shipping the current backup path or a naive format3 adapter;
they do not claim a new production regression in the independently reviewed container primitive.

| Severity / priority | Gap and source evidence | User impact / required next boundary |
| --- | --- | --- |
| High / P0 | Unfiltered DB and repository copy: `desktop/src/main.cjs:505`, `desktop/src/backup.cjs:96` | Application credentials and unselected repository history can leave the live store in a plaintext backup. Add the explicit scrubbed policy before connecting a format3 product writer. |
| High / P0 | Missing OFF projection and environment fallback: `V15:4`, `AIProviderConfig.java:48` | Removing archived credentials alone can still resolve an environment key and allow paid egress. Persist reconnect/OFF semantics and enforce B's latch before provider resolution. |
| High / P0 | Normal-DB execution of legacy custom dump: `desktop/src/main.cjs:509`, `desktop/src/backup.cjs:142` | A supplied dump reaches the live database execution boundary. Separate trusted same-install legacy handling in isolated staging; no direct legacy restore or fallback. |
| High / P0 | Live authority and accounting boundaries: `V22:4`, `V22:34`, `AiUsageService.java:30`, frozen05:104–118 | Restoring grants/sessions or replacing the current usage projection can revive authority or reduce known liabilities. Exclude capabilities; seal/merge safety state before any data switch. |
| Medium / P1 | V23 trigger/identity/FK load order: `V23:102`, `V23:142`, `V23:158` | Generic row replay fails or produces invalid current-source references. Build and test an isolated trigger-respecting loader. |
| Medium / P1 | Legacy source and historical retry coverage: `FileService.java:101`, `SourceJobWorkspace.java:98` | A naive scrub loses source evidence or retained retry ability. Block unsupported full exports and make the R1 retry policy explicit. |

## Binding requirements from the frozen plan

`docs/multilanguage-plan-2026-10-02/05-security-performance-operations.md:84` requires same-install
encrypted format3, schema/app/source manifest, data/source/notes/tasks, source key-ID references, and
no GitHub/BYOK credentials or original working folders. `:104` puts installation/vault/journal/OFF/
minimum-version/budget high-water outside ordinary restore roots. `:115` requires sealing current cost
state before modifying area A, then conservative union/merge and invariant verification. `:124–130`
requires independent retained backup/source/safety keys and no key bytes in archives. `:132` requires
an explicit credential export allowlist, schema-evolution failure gate, keyless settings projection,
credential sentinel checks, and isolated legacy format2 handling. Those requirements remain frozen.

## Current secret, authority, and transient classifications

| Object | Exact policy proposed | Current evidence and consequence |
| --- | --- | --- |
| `github_credentials` | Exclude **all rows and all columns** from data export; preserve schema only through trusted migrations | V1:16, V2:4; fields include encrypted_token, nonce, key_version, scopes, kind. Encryption at rest does not make ciphertext eligible for backup. |
| `user_ai_settings` | Do not export raw rows. Export only keyless preference projection: original setting ID (diagnostic), user_id, provider, model, created_at, updated_at; force enabled=false/reconnect-required in the projection | V15:4, V16:1; exclude encrypted_key, nonce, key_version, API-key masks. Current table cannot hold this projection directly. |
| `users.local_key` | Omit raw installation key from portable row data; include a verified local-owner user-ID marker, then bind that exact row to current main identity during trusted staging import | V20:3; user PKs/FKs must remain unchanged. A local-only row would violate `github_id OR local_key` if blindly inserted without this trusted binding. |
| `users` other fields | Preserve id, github_id, login, name, avatar_url, created_at, updated_at, identity_type as private account metadata; presence of github_id must not imply connected state | AccountService:73 requires an actual credential row to report GitHub connected. No OAuth/PAT row is restored. |
| `projects.local_path`, `projects.clone_path` | Omit absolute paths from payload; local_path remains unlinked until a new native picker grant; regenerate any app-owned clone/materialization path from trusted current root/project ID | V1:36, V18:2; preserve project identity/name/source_type/repo identity and valid snapshot pointers. Never interpret an archive string as a filesystem access grant. |
| `projects.pulls_etag` | Omit/reset the remote cache validator; ordinary reconnect/refetch regenerates it | V5:4. All other approved project fields preserved. |
| `local_source_approvals` | Exclude entire data table; no preview token hash, expiry, consumed link, canonical root/device/inode, or live grant is restored | V22:4. Old preview approvals cannot authorize a post-restore scan. |
| `job_local_source_inputs` | Exclude live receipt rows. Retained manifest policy/limit/hash/count provenance is already separately carried. Do not synthesize fake paths or token hashes to satisfy NOT NULL columns | V22:34 and immutable-update trigger :53. Exclusion affects resumability; see explicit historical-job decision below. |
| `analysis_jobs`, `analysis_job_steps` | Preserve historical IDs/relationships/times/status/checkpoint values only after controlled quiescence. Redact opaque error text to NULL in export projection; retain bounded structural failure_code. No queued/running/cancelling work may be restored for automatic dispatch | V1:72, V3:4, V21:2, V22:2; startup recovery treats interrupted jobs as resumable failures (JobStartupRecovery:32). A stopped process is not proof every database job reached terminal state. |
| `ai_usage_logs` | Preserve historical rows as **non-authoritative legacy accounting evidence**, not a replacement for current/journal cost liabilities. Export cost/tokens exactly (decimal strings where applicable). Restore must union/reconcile under OFF before enabling AI | V12:44 has no logical request UUID, reserved amount, final-settlement proof, or journal sequence; AiUsageService:30 sums restored rows directly today. No fabricated microUSD/zero/settlement proof. |
| New strict-cost PG reservations/settlements | **Not present in V1–V23.** Any later table is unknown and blocks export until explicitly classified; future PG rows remain a projection beneath journal authority | Frozen05:108–118. Existing isolated `safety-journal.cjs` is not yet proof of PG gateway integration. |
| Spring sessions/CSRF/OAuth requests | Never export. Invalidate session namespace/cookies on restore and cancel OAuth attempts; do not copy Redis persistence | application.yml:27, SecurityConfig:54, build.gradle.kts:29; namespace `codeintel:session` is Redis, not a V1–V23 SQL session table. Native OAuth attempts/state/PKCE verifier are in-memory maps (GithubNativeOAuthService:40). |
| `playground_sessions` | Preserve as private user-authored/product content; **not** an authentication-session table despite the name | V14:29: selected_paths/proposed_snippet/questions/explanations/claims. Content remains opaque text, never executed or written to a working folder. |
| `authorized-paths.enc` / backend path grants | Never export/replace via backup. Revoke restored projects' local path association; new picker approval required. Current installation grants need an explicit restore policy | main.cjs:319, :369, :666; current backend restart automatically reauthorizes stored roots. DesktopPathAuthorizationService:14 is per-process state. |
| `secrets.enc`, safety roots, keyrings, journal, AI OFF latch, update minVersion, budget time bucket | Never package or restore as files; same-install references/diagnostics only. Their existing state survives both restore and rollback | main.cjs:665 and frozen05:104. Existing main identity storage is not physically moved by this proposal. |
| `flyway_schema_history` | Do not import its archive rows as migration truth. Verify exporter migration version/checksum manifest and rebuild staging schema/history from bundled reviewed migrations | Flyway enabled in application.yml:19. This tool-owned runtime table is additional to the 48 application tables below. |
| Redis data/logs/raw PG data/source scratch/quarantine | Never blanket-copy directories or logs into the payload | main.cjs:277 persists Redis AOF/RDB; file container input must instead come from an explicit scrubbed staging assembly. |

**Important distinction:** “managed-credential-free” means designated application credential columns/
key files are structurally absent. It does not prove arbitrary user notes, PR bodies, AI chats, code,
or JSON metadata never contain a manually pasted secret. Use the common secret policy across every
included text/blob; on a hit, block and report a non-secret reason or require a later explicit export
selection. Do not silently redact or truncate note/task text to claim exact preservation. Classifying
freeform columns as private product content is not blanket authorization to publish them externally.

## Exact-preservation requirements and relational import

Preserve `notes`, `note_references`, `tasks`, `task_goals`, `learning_records`, and `finding_judgments`
IDs, relationships, text, statuses, done flags, sequence/order, origin, timestamps, and nullable references.
The complete column inventory follows below. Do not reconstruct them with ordinary services:
`NoteService.java:140` deletes/reparses references against the **current** snapshot; `TaskService.java:250`
deletes/recreates goal IDs and resets done=false while sanitizing content. Use a reviewed data-only
loader with explicit IDs/column bindings. Exact text checks include UTF-8, CRLF/LF, leading/trailing
space, Markdown, Unicode, and null-vs-empty distinctions. Check table PK-sorted row digests and
cross-table reference counts before/after the staging round trip.

Preserve graph/file/evidence/commit/snapshot IDs and natural keys, Git OIDs, raw source SHA-256,
manifest/generation IDs, provenance versions, and null “not measured” hashes. Do not promote a legacy
snapshot to retained verification or convert Git object IDs into raw content hashes. Polymorphic
note/evidence/summary subject references need owner/project/snapshot validation beyond ordinary FKs;
known unresolved legacy references should retain that status, not be retargeted to a new current graph.

Trusted staging import order must cover these cases:

- Users with verified local-owner binding; projects initially with current pointers NULL; snapshots
  inserted with their original immutable `source_contract_version`.
- Source blobs; manifests inserted unsealed; exact entries; then seal with the original recorded
  `sealed_at` after counts/bytes match. No disabling or rewriting V23 integrity triggers.
- Generations retain UUIDs and historical job IDs. Preserve `fencing_epoch` with a trusted explicit
  generated-identity import path; advance its sequence beyond retained values and any pre-restore
  high-water needed by the integration. This is not a hardware anti-rollback guarantee.
- Restore graph/projections/evidence/user content and all FK dependencies; set feature parents and
  project snapshot/generation pointers after their referenced rows exist. Deferred composite FKs must
  pass before staging commit. Historical manifest/generation `job_id` references intentionally lack a
  job FK; sequence high-water must also consider these IDs if history rows are omitted.
- Never restore QUEUED/RUNNING/CANCELLING jobs into an active scheduler. Drain/cancel through normal
  coordination before export, or explicitly project archived history to a non-resumable representation.
  Merely killing the backend is not a writer-drain/terminal-state protocol.

**Known resumability impact:** `SourceJobWorkspace.java:92–109` joins `job_local_source_inputs` for
`approved_at`, matching hashes/counts, and a STAGING generation. Dropping those live receipts means
restored historical failed jobs cannot use the existing retained-checkpoint retry path. Recommended
R1 behavior: preserve historical job records for diagnosis but require a new user-approved analysis
after restore; make this explicit in UI/API. If checkpoint continuation is a product requirement,
introduce a reviewed **non-capability** retained provenance record and its separate validation path.
Do not reintroduce stale local path/token authority or fake receipt fields for convenience.

## Allowlist and schema-evolution gate

The next safe implementation unit is a versioned **pure export policy** with one disposition per
application table and one explicit disposition/type per column. All unknown tables, columns, enum
states, types, changed nullability/default/generation semantics, unclassified views/functions, or
unreviewed migration checksums must fail the export before reading row data. `SELECT *`, whole-table
serialization of JPA entities, reflective default inclusion, name-pattern-only denylisting, and a
catch-error fallback to full `pg_dump` are forbidden.

Verification strategy (future tests, not executed here):

1. A static source inventory check covers V1–V23 and every ALTER addition. A temporary PostgreSQL
   integration gate applies bundled migrations and compares `pg_catalog`/`information_schema` columns,
   types, nullability, generated/identity definitions, PK/FK/checks/trigger definitions, and extension
   versions against that reviewed contract. Include `flyway_schema_history` as an explicit tool-owned
   exception, not a wildcard for all unknown public tables.
2. Mutant fixtures add `users.refresh_token`, a new credential table, an extra AI-settings secret, or
   change a type/NOT NULL; export must fail before a byte of product payload is published. Renaming an
   unknown secret to an innocent name must still fail because the column is unclassified.
3. Fake/temporary-DB fixtures put distinct dummy sentinels into GitHub ciphertext/nonce and BYOK
   ciphertext/nonce, as well as paths/token hashes and excluded files. The **decrypted staging payload**
   and any staging DB must have zero occurrences in raw, base64, hex, and JSON-string representations.
   Inspecting only the final encrypted file is not evidence of scrubbing. Scanner errors fail closed.
4. Exact user-data corpus verifies note/task IDs/text/goals/done/timestamps and referenced graphs;
   includes decimal/BigInt boundaries, null/empty values, vector/JSONB round trips, failed snapshots,
   and unresolved references. No live provider/network connection during restore.
5. Same-install identity match, retained-key existence, blob ciphertext authenticity/raw SHA/GitOID
   agreement, graph/source references, count/byte totals, and no forbidden filesystem record must be
   validated before final publication or any user DB switch.

Always export explicit reviewed columns through a read-only repeatable-read transaction after an
administrative writer freeze; serialize rows in stable PK order, stream with byte/row/time limits,
and independently verify counts/digests. No raw credential column should even be selected into the
export process just to be deleted later. Multi-user ownership scope must be explicit, see choices.

## Recommended staging payload shape and alternatives

Recommendation for the next prototype: a **typed data-only logical PostgreSQL dump**, built from the
allowlist, inside a bounded deterministic payload. It changes the backup serialization only; PostgreSQL
and the product schema remain unchanged. No SQL text/DDL/function body is accepted from this format.
Use the existing authenticated `backup-archive.cjs` only after the full staging payload is scrubbed and
validated. Its 10 GiB cap applies to the whole payload, including metadata/blob envelopes, not just raw
source bytes; its private direct-child path restriction remains intentional.

Proposed payload major 1 (implementation proposal, not an existing wire contract):

- Fixed magic, bounded canonical manifest, then bounded length-prefixed records and a mandatory EOF
  footer/digest. The manifest carries product/container/payload versions, app/build and migration
  checksums, schema fingerprint, identity hash, snapshot/source format inventory, source key-ID set,
  allowed table descriptors (column list/type version/count/stream digest), source count/byte/digest
  summary, and diagnostic-only safety seal IDs/high-water. It carries no key bytes or install identity
  replacement instruction. Keep large per-blob indexes in a streamed record section, not one huge JSON.
- Records have an enum type and fixed schema, e.g. table-row(table ID + typed values), keyless-AI-
  preference(user ID + provider/model + OFF/reconnect), local-owner binding marker, and retained-source
  ciphertext(project ID + raw SHA + byte size + key ID + bounded envelope). Filesystem output paths are
  reconstructed from fixed root/address rules; no archive record supplies a destination path/SQL name.
- Bigint IDs/sequences, numeric costs, and money use canonical decimal strings; timestamptz retains
  exact instant/precision; bytea uses canonical base64; vector(1536) and JSONB have explicit codecs.
  Preserve all text bytes/semantics; reject over-limit rows rather than truncate. A proposed 8 MiB
  per-record bound requires corpus confirmation; chunk larger eligible values explicitly or fail.
- Every allowed table must be declared, including tables intentionally empty/excluded/projection-only;
  unknown/missing/duplicate/out-of-order sections, unexpected row fields, trailing records, and bad
  counts/hash/PK/FK relationships are errors. No implicit source re-import from a local folder.
- Source section contains only verified retained blob ciphertext referenced by exported manifests,
  with source key IDs retained in area B. Exclude plaintext run workspaces, raw `.git`, quarantines,
  caches, lock files, safety files, `secrets.enc`, authorized paths, and original folders. Validate
  source envelope authentication via the trusted vault API while checking copied ciphertext identity;
  no source key export. Source pin/GC/backup lifecycle coordination is still required.

Alternative if retaining `pg_dump` archive bytes is mandatory: use the allowlist exporter to load a
fresh isolated staging PostgreSQL database created from **trusted bundled migrations**, then take a
dump only of that already-scrubbed staging database. Keep keyless settings/identity binding as separate
typed projections where current NOT NULL constraints prevent their presence. Never dump the live DB
first and patch an opaque archive. This alternative still needs a safe restore loader/execution
boundary; custom dumps contain executable DDL and cannot be made safe by hashes alone. It also incurs
an additional database, disk/free-space allowance, and trigger-aware loading. `--exclude-table-data`
for two tables alone is not a column allowlist and does not solve paths, sessions, schema evolution,
user identity, operational jobs, or AI environment fallback.

Before implementing a product writer, root should settle which dump representation is used. The pure
policy/projection/schema-verifier unit is useful and safe under either choice.

## Concrete implementation sequence (bounded, reviewable units)

1. **Export policy + projection tests**: explicit 48-table/column inventory below, dispositions, typed
   row adapters, keyless AI preferences, local-owner marker, no live data/files. Unit mutant/sentinel/
   exact-preservation fixtures first. No migration edits needed for this unit.
2. **Restore OFF/reconnect semantics**: additive migration for a noncredential AI preference/state
   table (recommended) plus resolver/egress guard and UI view. Existing user_ai_settings remains the
   credential store and restores empty; no fake ciphertext. Reconnection updates the credential only
   through normal explicit user input and must not clear B's OFF latch/reconciliation requirement.
   Cover configured environment keys to prove no fallback after restore. Do not change V15 in place.
3. **Read-only PG exporter + schema gate**: separate maintenance/export entrypoint under main-owned
   capability, stable SQL snapshot, approved row scopes, stream bounds, no provider startup. Current
   main pauses the backend before dump, so a normal HTTP endpoint on that paused backend cannot serve
   this role. Choose a dedicated packaged Java export mode using existing JDBC/Flyway dependencies,
   or quiesce application writers while that process remains alive; do not quietly reopen normal API.
4. **Payload assembler + container adapter**: explicit table/projection/source sections, key-reference
   availability, count/hash/sentinel gate, encrypted fresh-only publication; only synthetic fixtures
   until prior gates pass. Budget/free-space check and source pinning precede assembly.
5. **Isolated data-only staging importer + invariants**: apply trusted migrations; no archive SQL;
   trigger-respecting load order above; owner identity bound to existing install; note/task hashes and
   source/evidence readback; no provider calls/sessions/permissions. User DB remains untouched.
6. **Product maintenance/restore transaction**: admin mutex; pause new jobs/AI and drain writers;
   persist B OFF, seal/reconcile current obligations; stage+verify; recovery checkpoint; swap only A;
   conservative journal merge; health/reference/accounting checks; fresh login/picker grants and
   explicit reactivation. Failures/restarts stay recovery-only. No original DB/source reset or
   destructive rollback shortcut. Same-install legacy format2 requires a separate isolated importer;
   unsupported/malformed/identity-mismatched format2/1 is never sent to the normal database.

## Product decisions and release blockers to keep explicit

- **Ownership scope:** current backup dumps the whole installation. Preserve all installation-owned
  users/projects (including legacy GitHub-only rows) without silently remapping IDs, or explicitly scope
  to the current local owner. Multiple/foreign `users.local_key` identities must block automatic binding
  until reviewed. A GitHub-only row can retain github_id without a restored credential; local-only rows
  require current-install binding. No loss of another owner's notes/tasks by default.
- **Legacy/GitHub source:** implement verified selection/export migration, or offer a clearly separate
  metadata-only export after product choice. A “complete backup” must not silently omit unavailable
  sources, include all Git objects, or mark absent source evidence as verified.
- **Historical job retry:** recommended R1 archives historical status but requires fresh approved jobs;
  resumable checkpoints need separate non-capability provenance. Current receipt join makes this an
  actual implementation contract, not just an error-message choice.
- **Arbitrary user-text secret hits:** preserve requested exact text or explicitly block/ask for export
  selection; never claim all secrets absent from freeform data solely from credential-table exclusions.
- **Legacy accounting:** V12 usage lacks request UUID/proof/reservation. It cannot be treated as a new
  strict-cost settled ledger. Unknown/legacy liabilities require conservative reconciliation; no zero
  cost or reset inferred from an old backup. T08 gateway/journal connection is still required.
- **No plain fallback:** unavailable secure storage/key, missing old source key, unknown schema/format,
  unclassified data, unsupported source, insufficient disk, or failed validation aborts. Never create
  format2 as fallback, write plaintext final payload, fall back to env AI, copy a live source folder,
  restore archived grants/sessions, or execute untrusted pg_dump SQL in the user database.

## Schema freeze and evidence limits

Freeze the existing V1–V23 files, their constraints/triggers, and approved 05 plan for this T09 step.
Record their checksums in tests/payload; intentional future schema changes require a new migration
and explicit export-policy revision, not an edit to historical applied migrations. Do not weaken V23
immutability to make import easier, change note/task IDs/text, regenerate installation identity, replace
the existing DB technology, or reset original data. New AI preference/restore provenance tables are
**proposals**, not currently existing schema. No test/database/export was executed for this design.

Static inventory below is exhaustive for inspected CREATE TABLE plus ALTER ADD COLUMN statements.
It is an input to a future real catalog verification gate; a source parser alone is not proof of actual
database state, extension internals, or applied Flyway history. Table/column classification and line
references were manually cross-checked against the inspected migrations and runtime consumers.

## Current application table/column inventory

Legend: `KEEP` = explicit private product data, subject to owner/source/secret gates; `PROJECT` = use
the exact per-column projection above; `DROP` = schema retained, no data; `ACCOUNTING` = preserve as
diagnostic accounting but never authoritative restored budget. The listed columns include V1–V23
ALTER additions; a `KEEP` row still requires each listed column in the explicit implemented allowlist.

| Table | Policy | All current columns (explicit source order, ALTER additions last) | DDL evidence |
| --- | --- | --- | --- |
| `users` | PROJECT | `id`, `github_id`, `login`, `name`, `avatar_url`, `created_at`, `updated_at`, `local_key`, `identity_type` | `V1__init.sql:6`; `V20__desktop_local_identity.sql:3`; `V20__desktop_local_identity.sql:4` |
| `github_credentials` | DROP | `id`, `user_id`, `kind`, `encrypted_token`, `scopes`, `expires_at`, `created_at`, `updated_at`, `nonce`, `key_version` | `V1__init.sql:16`; `V2__github_credentials_encryption.sql:4` |
| `projects` | PROJECT | `id`, `user_id`, `name`, `repo_owner`, `repo_name`, `default_branch`, `clone_path`, `current_snapshot_id`, `created_at`, `updated_at`, `pulls_etag`, `local_path`, `source_type`, `current_generation_id` | `V1__init.sql:29`; `V5__git_metadata.sql:4`; `V18__local_folder_import.sql:2`; `V18__local_folder_import.sql:3`; `V23__retained_source_manifests.sql:155` |
| `snapshots` | KEEP | `id`, `project_id`, `commit_sha`, `status`, `analyzed_at`, `created_at`, `source_contract_version` | `V1__init.sql:45`; `V23__retained_source_manifests.sql:4` |
| `project_area_selections` | KEEP | `id`, `project_id`, `area_type`, `selected`, `created_at`, `updated_at` | `V1__init.sql:62` |
| `analysis_jobs` | PROJECT | `id`, `project_id`, `snapshot_id`, `type`, `status`, `error`, `created_at`, `updated_at`, `started_at`, `finished_at`, `failure_code` | `V1__init.sql:72`; `V3__job_checkpoint.sql:11`; `V22__local_source_approvals.sql:2` |
| `analysis_job_steps` | PROJECT | `id`, `job_id`, `step_key`, `seq`, `status`, `progress_pct`, `error`, `started_at`, `finished_at`, `attempt` | `V1__init.sql:87`; `V3__job_checkpoint.sql:4` |
| `files` | KEEP | `id`, `snapshot_id`, `path`, `language`, `size`, `line_count`, `content_hash` | `V4__inventory_area_evidence.sql:2` |
| `project_areas` | KEEP | `id`, `snapshot_id`, `area_type`, `confidence`, `summary` | `V4__inventory_area_evidence.sql:15` |
| `area_technologies` | KEEP | `id`, `area_id`, `name`, `version` | `V4__inventory_area_evidence.sql:29` |
| `evidences` | KEEP | `id`, `project_id`, `kind`, `file_path`, `line_start`, `line_end`, `commit_sha`, `pr_number`, `url`, `excerpt`, `created_by`, `created_at` | `V4__inventory_area_evidence.sql:37` |
| `evidence_links` | KEEP | `id`, `evidence_id`, `subject_type`, `subject_id` | `V4__inventory_area_evidence.sql:54` |
| `commits` | KEEP | `id`, `project_id`, `sha`, `author`, `message`, `committed_at`, `additions`, `deletions` | `V5__git_metadata.sql:7` |
| `commit_files` | KEEP | `id`, `commit_id`, `path`, `change_type` | `V5__git_metadata.sql:21` |
| `branches` | KEEP | `id`, `project_id`, `name`, `head_sha` | `V5__git_metadata.sql:31` |
| `tags` | KEEP | `id`, `project_id`, `name`, `head_sha` | `V5__git_metadata.sql:41` |
| `pull_requests` | KEEP | `id`, `project_id`, `number`, `title`, `body`, `state`, `author`, `merged_at`, `head_sha`, `base_sha` | `V5__git_metadata.sql:51` |
| `graph_nodes` | KEEP | `id`, `snapshot_id`, `node_type`, `natural_key`, `name`, `file_id`, `line_start`, `line_end`, `area_type`, `metadata` | `V6__code_graph.sql:2` |
| `graph_edges` | KEEP | `id`, `snapshot_id`, `source_node_id`, `target_node_id`, `edge_type`, `confidence`, `metadata` | `V6__code_graph.sql:20` |
| `infra_resources` | KEEP | `id`, `snapshot_id`, `node_id`, `kind`, `name`, `source_path` | `V7__infra_resources.sql:2` |
| `api_endpoints` | KEEP | `id`, `snapshot_id`, `node_id`, `http_method`, `path`, `handler_key` | `V8__endpoints_entities_features.sql:3` |
| `db_entities` | KEEP | `id`, `snapshot_id`, `node_id`, `entity_name`, `table_name`, `source` | `V8__endpoints_entities_features.sql:16` |
| `features` | KEEP | `id`, `snapshot_id`, `name`, `description`, `parent_id`, `detection`, `confidence` | `V8__endpoints_entities_features.sql:28` |
| `feature_links` | KEEP | `id`, `feature_id`, `node_id`, `role` | `V8__endpoints_entities_features.sql:41` |
| `frontend_routes` | KEEP | `id`, `snapshot_id`, `node_id`, `path`, `component_key` | `V9__frontend_routes.sql:2` |
| `flows` | KEEP | `id`, `snapshot_id`, `name`, `kind`, `entry_node_id` | `V10__flows.sql:2` |
| `flow_steps` | KEEP | `id`, `flow_id`, `seq`, `node_id`, `edge_id`, `description` | `V10__flows.sql:13` |
| `analysis_findings` | KEEP | `id`, `snapshot_id`, `area_type`, `category`, `severity`, `title`, `detail`, `status`, `node_id` | `V11__analysis_findings.sql:2` |
| `summaries` | KEEP | `id`, `snapshot_id`, `subject_type`, `subject_id`, `level`, `content`, `embedding`, `model`, `token_count`, `content_hash`, `created_at`, `embedding_model` | `V12__ai_summaries.sql:2`; `V17__summary_embedding_models.sql:1` |
| `ai_conversations` | KEEP | `id`, `project_id`, `snapshot_id`, `user_id`, `created_at` | `V12__ai_summaries.sql:20` |
| `ai_messages` | KEEP | `id`, `conversation_id`, `role`, `content`, `context`, `claims`, `prompt_tokens`, `completion_tokens`, `created_at` | `V12__ai_summaries.sql:30` |
| `ai_usage_logs` | ACCOUNTING | `id`, `user_id`, `project_id`, `provider`, `model`, `purpose`, `prompt_tokens`, `completion_tokens`, `cost_estimate`, `created_at` | `V12__ai_summaries.sql:44` |
| `notes` | KEEP | `id`, `project_id`, `title`, `content_md`, `created_at`, `updated_at` | `V13__notes_tasks_search.sql:4` |
| `note_references` | KEEP | `id`, `note_id`, `subject_type`, `subject_id`, `raw_target`, `label` | `V13__notes_tasks_search.sql:16` |
| `tasks` | KEEP | `id`, `project_id`, `type`, `title`, `description`, `status`, `origin`, `source_finding_id`, `created_at`, `updated_at` | `V13__notes_tasks_search.sql:28` |
| `task_goals` | KEEP | `id`, `task_id`, `seq`, `content`, `done` | `V13__notes_tasks_search.sql:44` |
| `learning_records` | KEEP | `id`, `task_id`, `note`, `created_at` | `V13__notes_tasks_search.sql:54` |
| `pr_reviews` | KEEP | `id`, `project_id`, `pull_request_id`, `summary`, `origin`, `created_at` | `V14__phase5_review_playground.sql:3` |
| `pr_review_comments` | KEEP | `id`, `review_id`, `seq`, `file_path`, `line`, `severity`, `body`, `confidence`, `evidence` | `V14__phase5_review_playground.sql:15` |
| `playground_sessions` | KEEP | `id`, `project_id`, `title`, `selected_paths`, `proposed_snippet`, `last_question`, `last_explanation`, `last_claims`, `created_at`, `updated_at` | `V14__phase5_review_playground.sql:29` |
| `user_ai_settings` | PROJECT | `id`, `user_id`, `provider`, `encrypted_key`, `nonce`, `key_version`, `created_at`, `updated_at`, `model` | `V15__user_ai_settings.sql:4`; `V16__user_ai_models.sql:1` |
| `finding_judgments` | KEEP | `id`, `user_id`, `project_id`, `stable_key`, `status`, `reason`, `rule_id`, `rule_version`, `evidence_fingerprint`, `created_at`, `updated_at` | `V19__finding_judgments.sql:2` |
| `local_source_approvals` | DROP | `id`, `token_sha256`, `user_id`, `purpose`, `project_id`, `base_snapshot_id`, `project_name`, `schema_version`, `canonical_root`, `root_device`, `root_inode`, `policy_version`, `limits_sha256`, `manifest_sha256`, `selected_files`, `selected_bytes`, `issued_at`, `expires_at`, `consumed_at`, `consumed_job_id`, `revoked_at` | `V22__local_source_approvals.sql:4` |
| `job_local_source_inputs` | DROP | `job_id`, `project_id`, `approval_token_sha256`, `purpose`, `base_snapshot_id`, `schema_version`, `canonical_root`, `root_device`, `root_inode`, `policy_version`, `limits_sha256`, `manifest_sha256`, `selected_files`, `selected_bytes`, `approved_at` | `V22__local_source_approvals.sql:34` |
| `source_blobs` | KEEP | `project_id`, `sha256`, `byte_size`, `key_id`, `created_at` | `V23__retained_source_manifests.sql:17` |
| `source_manifests` | KEEP | `id`, `project_id`, `snapshot_id`, `job_id`, `contract_version`, `producer_version`, `source_kind`, `approval_manifest_sha256`, `limits_sha256`, `policy_version`, `file_count`, `byte_size`, `created_at`, `sealed_at` | `V23__retained_source_manifests.sql:39` |
| `source_manifest_entries` | KEEP | `manifest_id`, `project_id`, `path`, `blob_sha256`, `git_oid`, `byte_size` | `V23__retained_source_manifests.sql:60` |
| `analysis_generations` | KEEP | `id`, `project_id`, `snapshot_id`, `source_manifest_id`, `job_id`, `contract_version`, `producer_version`, `rules_sha256`, `config_sha256`, `dependency_context_sha256`, `status`, `previous_committed_generation_id`, `fencing_epoch`, `created_at`, `committed_at` | `V23__retained_source_manifests.sql:128` |

This totals **48 application tables, 388 columns**: 373 CREATE columns plus 15 ALTER additions.
Policies: 39 KEEP, 5 PROJECT, 3 DROP, 1 ACCOUNTING. Every DROP column is excluded; every PROJECT
column follows the exact disposition above. The matrix is not a type/constraint replacement: current
types, defaults, nullability, indexes, generated values, functions, and triggers remain defined by the
frozen migration bytes. The future catalog gate must compare those semantics too.

### ALTER column delta cross-check

| Table | Added column | Declaration at addition | Evidence |
| --- | --- | --- | --- |
| `github_credentials` | `nonce` | `bytea NOT NULL` | `V2__github_credentials_encryption.sql:4` |
| `github_credentials` | `key_version` | `int NOT NULL DEFAULT 1` | `V2__github_credentials_encryption.sql:4` |
| `analysis_job_steps` | `attempt` | `int NOT NULL DEFAULT 0` | `V3__job_checkpoint.sql:4` |
| `analysis_jobs` | `started_at` | `timestamptz` | `V3__job_checkpoint.sql:11` |
| `analysis_jobs` | `finished_at` | `timestamptz` | `V3__job_checkpoint.sql:11` |
| `projects` | `pulls_etag` | `text` | `V5__git_metadata.sql:4` |
| `user_ai_settings` | `model` | `text` | `V16__user_ai_models.sql:1` |
| `summaries` | `embedding_model` | `text` | `V17__summary_embedding_models.sql:1` |
| `projects` | `local_path` | `TEXT` | `V18__local_folder_import.sql:2` |
| `projects` | `source_type` | `VARCHAR(20) DEFAULT 'GITHUB'` | `V18__local_folder_import.sql:3` |
| `users` | `local_key` | `text` | `V20__desktop_local_identity.sql:3` |
| `users` | `identity_type` | `text NOT NULL DEFAULT 'GITHUB'` | `V20__desktop_local_identity.sql:4` |
| `analysis_jobs` | `failure_code` | `varchar(64)` | `V22__local_source_approvals.sql:2` |
| `snapshots` | `source_contract_version` | `integer NOT NULL DEFAULT 0` | `V23__retained_source_manifests.sql:4` |
| `projects` | `current_generation_id` | `uuid` | `V23__retained_source_manifests.sql:155` |

`V20__desktop_local_identity.sql:2` also drops `users.github_id` NOT NULL and adds the
github_id-or-local_key invariant. V21 changes job status/exclusivity constraints, not columns.
These non-additive constraints are covered by the checksum freeze and future catalog gate.

## Source evidence index

Shorthand Java filenames in this note resolve below; each path is under the repository root.

| Shorthand | Exact file |
| --- | --- |
| `AccountService.java` | `backend/src/main/java/dev/codeintelligence/auth/AccountService.java` |
| `DesktopAuthenticationFilter.java` | `backend/src/main/java/dev/codeintelligence/auth/DesktopAuthenticationFilter.java` |
| `GithubNativeOAuthService.java` | `backend/src/main/java/dev/codeintelligence/auth/GithubNativeOAuthService.java` |
| `UserAccount.java` | `backend/src/main/java/dev/codeintelligence/auth/UserAccount.java` |
| `AiUsageService.java` | `backend/src/main/java/dev/codeintelligence/ai/AiUsageService.java` |
| `AiSettingsService.java` | `backend/src/main/java/dev/codeintelligence/ai/AiSettingsService.java` |
| `UserAiSetting.java` | `backend/src/main/java/dev/codeintelligence/ai/UserAiSetting.java` |
| `AIProviderConfig.java` | `backend/src/main/java/dev/codeintelligence/ai/AIProviderConfig.java` |
| `FileService.java` | `backend/src/main/java/dev/codeintelligence/analysis/core/FileService.java` |
| `SourceJobWorkspace.java` | `backend/src/main/java/dev/codeintelligence/project/SourceJobWorkspace.java` |
| `LocalSnapshotStore.java` | `backend/src/main/java/dev/codeintelligence/project/LocalSnapshotStore.java` |
| `JobStartupRecovery.java` | `backend/src/main/java/dev/codeintelligence/job/JobStartupRecovery.java` |
| `NoteService.java` | `backend/src/main/java/dev/codeintelligence/note/NoteService.java` |
| `TaskService.java` | `backend/src/main/java/dev/codeintelligence/task/TaskService.java` |
| `DesktopPathAuthorizationService.java` | `backend/src/main/java/dev/codeintelligence/project/DesktopPathAuthorizationService.java` |
| `SecurityConfig.java` | `backend/src/main/java/dev/codeintelligence/common/config/SecurityConfig.java` |

`application.yml` means `backend/src/main/resources/application.yml`; `build.gradle.kts` means
`backend/build.gradle.kts`; migration basenames mean `backend/src/main/resources/db/migration/`.

## Frozen migration/plan fingerprint for this handoff

SHA-256 values below identify the read-only source snapshot, not a database inspection or a signed
trust anchor. The implementation must embed a reviewed schema policy and verify the running catalog;
an archive claiming these hashes is insufficient by itself.

| File | SHA-256 |
| --- | --- |
| `V1__init.sql` | `2d66ab364af115a9ab667408b7de5d23a47155542461f9a274401d7c29895408` |
| `V2__github_credentials_encryption.sql` | `c160aebd48a6ade090671ebdbbdac576daadc49528f605dc49bdcbbd65171646` |
| `V3__job_checkpoint.sql` | `605aa36487fba7a0d3cde86bb812e0e1b2ba7fd3930f0d25c7f22009912a301e` |
| `V4__inventory_area_evidence.sql` | `7b36146118238af44cc820f313b8faecd4925c2c4d1b34347dce54c2ccd4cfea` |
| `V5__git_metadata.sql` | `8f3f4ebfb8441fdf639bf7591e3dfe3a8f3c909af4817534453093c46c7f5979` |
| `V6__code_graph.sql` | `fd91e00297d35b66179691b8949707f92869987054098af5c37a7f9a9d6de5d2` |
| `V7__infra_resources.sql` | `3726aa90f2c6f88ad71c272623b9833876d975bac14d055443454270cabccbcf` |
| `V8__endpoints_entities_features.sql` | `f75bb652cfeccdf77844c163380fb25865de539f30358a55584133ee71273d5b` |
| `V9__frontend_routes.sql` | `47770d58252a0a0eca32ed1251daabfdebb0ed580f46122d1a9ea3598f562cf7` |
| `V10__flows.sql` | `dd3f01c31e22ee89462fbf1a916985e0fbd5481e6f00386ac98e79decc42e176` |
| `V11__analysis_findings.sql` | `b87154a4cb46c248be8efb6f04ac2f5d3aa501de1dfa17a53ea2b7930c7138a6` |
| `V12__ai_summaries.sql` | `bb2a3b0f91efcb80bee1298924501b3b743a0d4ad0c32c73ed2f04f9242890be` |
| `V13__notes_tasks_search.sql` | `1ba6ad2d858e55f3b0dd102cb201ec2046491027e9a78b830597481aeebbb706` |
| `V14__phase5_review_playground.sql` | `67abea8c68a7db85744a5bbd23e46d622e1b6ef8c7898fe02d54d6f208ca72ec` |
| `V15__user_ai_settings.sql` | `921d4a018c5966c3c1cebd688df3c75f3b0b1467cffdab4194ae767f05c1fb55` |
| `V16__user_ai_models.sql` | `ef420e5ca131b81edfdf810203b9c4a87db79d8e0df519d03fc023985e2137e5` |
| `V17__summary_embedding_models.sql` | `fe9eaaef044673235ffa1c868553b7ab9d1498922cc7fae6074787c94ca97aca` |
| `V18__local_folder_import.sql` | `f0c4b244401dbfbfdbe8fa7d4179dc56b58ac73637c09601b1a462e6d1db3954` |
| `V19__finding_judgments.sql` | `3dfdb415b35e44a5ed280a2edca1b2fe489ad6f83abeaa9b89aa0d1c2b3e997a` |
| `V20__desktop_local_identity.sql` | `5da83d9968df500eeebbdf588b9cfcd78f0441ae26b9c3e43776f53b0c2b3a99` |
| `V21__cancelling_jobs_remain_exclusive.sql` | `77dafe22315d49fc34700fc780e482753e010cab17e9d25616cca4e1609c2fdb` |
| `V22__local_source_approvals.sql` | `edcfc3a68b48f2d8ffcefcff33e6f4097c87492545c66b99fbb241086cd05d3a` |
| `V23__retained_source_manifests.sql` | `3dc86d04e458b3caa9dffc6a1993e548929649890dce4c6e992e37d23e102024` |
| `05-security-performance-operations.md` | `5303824929d4f098185cf57caffe30f6b79b96835e34a5bd5cb2a35848939105` |

Validation performed for this document: source inventory independently recomputed from all 23
CREATE/ALTER migrations; exact 48/388 totals and 15 additions asserted; runtime consumers and frozen
05/ADR-02 read. No unit/integration/build/DB/export execution was needed or claimed for this read-only
handoff. Product credential-free backup/restore remains blocked until the proposed units and their
synthetic/temporary-DB/end-to-end gates are implemented and independently reviewed.
