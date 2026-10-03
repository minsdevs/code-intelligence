# T09 maintenance cost projection adapter

Date: 2026-10-03. Scope: the maintenance additions to
`desktop/src/ai-egress-postgres.cjs` and the new
`desktop/test/backup-cost-postgres.test.cjs`. Existing
`desktop/test/ai-egress-postgres.test.cjs` is unchanged.
The separate typed product-data adapter remains frozen; this component fills its
intentionally empty V25 tables using current main's durable journal authority.

This is an internal main capability, not a renderer/API method, user approval,
financial settlement proof or permission to enable AI. It performs no database
creation/deletion, archive SQL execution, application swap or provider call.

## Authority and API

The original four callbacks remain accepted by `bindAuthority` for ordinary cost
operations. Maintenance additionally requires the fifth synchronous private getter:

```text
readDispatch(requestId)
readEvidence(requestId, proofSha256)
readSettlement(requestId, proofSha256)
readJournal()                    // Existing normalized Java-compatible journal view.
readMaintenanceSnapshot()        // New: current full journal.snapshot(), owned by main.
```

`readMaintenanceSnapshot` is compared with the normalized `readJournal` projection.
It must report AI OFF, a Boolean persistent legacy-liability flag and a nonpoisoned
journal. The snapshot supplied to stage seeding must exactly equal that private getter's
current full value; copying fields into an input object cannot grant authority.

```js
const live = await adapter.prepareMaintenanceGate({
  ownerUserId, legacyLiabilityUnresolved,
});
// Main next completes its maintenance barrier and durable B conservative merge/seal.
const stage = await adapter.createMaintenanceStage({ database });
const restored = await stage.seedMaintenanceProjection({
  liveProjection: live,
  archivedProjection,  // Strict projection, or null only after main proves no archived V25 data.
  journalSnapshot,     // Exact current private main snapshot after the B merge/seal.
});
await stage.close();
```

`createMaintenanceStage` accepts only a different database matching
`ci_backup_stage_[0-9a-f]{16,32}`. The parent supplies the same fixed loopback host,
port, username, psql binary, closed environment, deadlines and private authority.
Main creates and owns that separate random database. The internal stage capability
cannot be requested through the public factory options, even when the ordinary
factory is pointed at a staging-looking name.

The frozen child exposes only `seedMaintenanceProjection`, `readProjection`,
`readback` and `close`. It cannot bind different authority, create descendants,
publish ordinary settlements or read provider credentials. At most two children
can be open/creating; closing one frees capacity. Parent close closes all children
and interrupts their active processes.

`validateCostProjection(value, installationId)` remains a pure typed validation
and owned-copy API. It does not authenticate B or make a projection authoritative.
Main is responsible for obtaining `liveProjection` from completed preparation
under its admission/writer barrier, and for validating complete archive table
coverage before representing absent archive cost rows as null.

## Main maintenance preparation

Preparation is allowed before a maintenance seal exists, but actual main B must
already be OFF. It takes SQL table locks on users, the V25 tables and legacy usage.
Exactly one LOCAL or LOCAL_LINKED user must match current installation and owner.
Foreign/multiple local identities, any foreign keyed profile and any foreign or
different-owner gate fail. No identity or ownership is silently remapped.

If a gate is absent, V25 request/evidence tables must be empty. Preparation creates
a gate with default zero limits, revision zero, the Java-compatible zero-policy
hash and reconciliation required. It never infers a completed cost ledger from
legacy token logs. Known unresolved liability is OR of caller's trusted maintenance
input, actual B, existing PG state and existence of legacy usage rows. Existing
true remains true. Current limits, policy and immutable request rows are unchanged.
Preparation reads the committed projection back and rechecks owner, reconciliation
and current B legacy state before returning.

The zero gate is not an enrollment/activation shortcut. Main must supply its
conservative legacy decision and persist the resulting OR into B before restoration.
Ordinary cost enrollment and permits still retain their existing requirements.

## Conservative reconstruction before the first INSERT

Seeding requires a current pending maintenance seal (BACKUP or RESTORE), AI OFF,
no incomplete pending restore and a nonpoisoned journal. Seal metadata is typed and
the full snapshot must match the private current snapshot. Actual normalized
position, hash, projection digest and obligations must also match `readJournal`.

The live projection must require reconciliation. Its owner must match any archived
gate owner. Every live/archive request UUID must already exist in B; missing requests
are never silently omitted. For each such UUID, B's liability floor must cover its
source ledger liability and every supplied evidence actual. Source conflict=true
cannot disappear into B conflict=false. Different known settlements require an
explicit B conflict. Live/archive legacy=true with B legacy=false is rejected: an
area-A-only flag could otherwise disappear on a later restore.

Each final PG request is built from B's exact status, actual/proof, reservation,
liability floor and conflict. The implementation does **not** insert an archived
SETTLED row first and try to update it through the V25 immutability trigger.
Original metadata is preserved from live first, then archive, only if request UUID,
payload SHA, budget day, price version and reserved amount match B. When neither
matches, or the request exists only in B, owner/project/snapshot/approval/binding
are null and plan/wire hashes are zero. This historical placeholder cannot dispatch.

Evidence is a union of exact typed rows. Identical UUID/proof duplicates are
deduplicated; different contents under one immutable UUID/proof key fail. Retaining
an evidence row does not release a hold or grant it settlement authority.
Known zero actual remains the string `"0"`; an unknown actual remains null.

The reconstructed gate preserves current live daily/monthly limits and owner.
Its policy revision is max(live, archive)+1 with signed-64-bit overflow rejection.
The hash matches `AiCostLedger.policyHash` exactly:

```text
SHA256("AI_BUDGET_POLICY_1\n" + installationId + "\n" + ownerUserId + "\n"
       + policyRevision + "\n" + dailyLimitMicroUsd + "\n" + monthlyLimitMicroUsd)
```

Reconciliation is always true. Legacy is OR of live/archive/B and must already be
durable in B if known in A. Journal sequence/hash/projection digest come from B;
clock high-water is max(live, archive, B). This never imports an archived activation
or increases limits to archived preferences. Future clock values remain conservative
recovery blockers; they are not normalized down to the current time.

## SQL transaction and completion

The stage SQL takes locks on users, V25 and legacy usage, then verifies all three
V25 tables are empty and the single current local owner matches. Existing financial
rows are never deleted, truncated, reset, updated or upserted to make a stage reusable.
A stage containing legacy usage requires the reconstructed legacy flag to be true.
All dynamic values are typed JSON encoded into fixed SQL templates using base64;
no archive SQL/identifier/path can enter the statement.

The final B-derived gate, requests and evidence are inserted once with ordinary
V25 constraints/triggers active. A successful psql COMMIT is followed by an actual
read-only full projection readback. It must exactly equal the expected gate, all
requests and all evidence. Current private B is re-read and must still exactly
equal the original sealed snapshot. A changed B head or differing committed row
rejects completion; the stage stays unusable for switching/activation.

Any SQL attempt consumes that child's seeding capability, including lost ACK,
readback failure or process error. Retry needs a new disposable stage; no destructive
reset is offered. Preflight validation failures perform no SQL and can be corrected
after main completes the required B merge. A second child targeting a populated
stage is rejected by the SQL empty-state guard.

The adapter retains existing stdin-only psql, closed environment, bounded queue,
input/output, timeout, process termination and static error rules. A callback's full
snapshot is private main data, not an API accepting `verified:true` from a caller.
Same-process malicious code/native compromise and concurrent writers outside main's
maintenance barrier remain outside this internal capability boundary.

## Verification evidence

Author syntax checks pass. Final Node run: **83 unit PASS = 41 unchanged existing
adapter tests + 42 new maintenance tests; two opt-in real-PG cases SKIP**, no failures,
cancellations or todo. Logs:
`/tmp/ci-backup-cost-pg-unit-final-2026-10-03.log` and `.xml`.
The earlier first run was 82 unit PASS before the durable-B legacy regression was
added; it remains separate historical evidence and is not added to final counts.

Coverage includes four/five-getter compatibility, actual OFF requirement, B/PG/input/
legacy-history OR, owner mismatch, child capabilities and bounded lifecycle, invalid
stage destinations, incomplete/forged/stale snapshots, preservation of current limits,
revision/hash changes, B-only and mismatched placeholders, liability/evidence/conflict
floors, unknown versus zero, exact evidence union, committed readback mutation,
one-attempt staging and parent-close interruption.

The new opt-in test requires root-created **two empty disposable databases** and
`CI_BACKUP_COST_PG_TEST_PSQL`, `_SOURCE`, `_TARGET`, `_PORT`, `_USER`, `_PASSWORD`,
optional `_LIBRARY`. Both names must use the fixed staging pattern. It applies
minimal synthetic users/legacy-usage prerequisites plus the **real V25 migration**;
it is not a full V1–V25 product schema test. It checks actual gate enrollment/legacy
persistence, foreign keyed-user rejection, B-derived first insert of an unknown
hold instead of an archived settlement, limits/revision/hash, evidence preservation,
placeholder metadata and refusal of immutable replay/nonempty staging. This author
has not executed that DB test; root owns disposable PostgreSQL execution.

Frozen candidate SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `desktop/src/ai-egress-postgres.cjs` | `85c0afcab9ce5bb765092de71072fd3fe355cfb91bac1a80cef81add901466df` |
| `desktop/test/backup-cost-postgres.test.cjs` | `a0b2f81e0869c0e9ae5391460b6a1db03059f709106cd30cb86b3aa8c2a957c6` |
| final unit log | `a8df0bcc55498202256d4169b7adbf24e1ec105163e74d30c3c2b9c52b087115` |
| final unit XML | `cfb7871c874675dae7bc355c8ece11da4663186d70696d78ded5cd06f235c2e9` |

This does not complete T09, certify the new main orchestration or authorize release.
Main still owns admission/drain, authenticated archive/source coverage, complete
financial normalization, durable B union/seal/legacy preservation, current-policy
snapshot ordering, stage ownership, application swap/recovery, fresh process/channel
identities and explicit later activation. There is no author Gradle, real user DB,
Keychain, GUI, installed-app, provider, paid-call, deployment or external upload activity.
