'use strict';

// Main-only adapter for the installation's bundled psql. No public SQL, URL, shell, or raw provider
// body input. The caller owns runtime binary integrity and private core-authority enrollment.
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { TextDecoder } = require('node:util');
const crypto = require('node:crypto');

const MAX = 9223372036854775807n;
const ZERO = '0'.repeat(64);
const LIMITS = Object.freeze({ inputBytes: 16 * 1024 * 1024, outputBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024, requests: 10000, evidence: 10000, timeoutMs: 15000, queued: 32, queuedBytes: 64 * 1024 * 1024 });
const GATE = ['installationId', 'ownerUserId', 'policyRevision', 'policySha256', 'dailyLimitMicroUsd',
  'monthlyLimitMicroUsd', 'reconciliationRequired', 'legacyLiabilityUnresolved', 'journalSequence',
  'journalHash', 'journalProjectionSha256', 'clockHighWaterMs'];
const ROW = ['requestId', 'installationId', 'ownerUserId', 'projectId', 'snapshotId', 'approvalId',
  'planSha256', 'payloadSha256', 'wireBodySha256', 'dispatchBinding', 'budgetDay', 'priceVersion',
  'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict',
  'journalSequence', 'journalHash'];
const BINDING = ['mainEpoch', 'provider', 'model', 'operation', 'endpointId', 'adapterVersion', 'tokenizerId',
  'tokenizerVersion', 'costContractSha256', 'priceSha256', 'settingsRevision', 'policyRevision', 'policySha256',
  'inputTokenUpperBound', 'outputTokenMax', 'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs'];
const BINDING_NUMBERS = ['settingsRevision', 'policyRevision', 'inputTokenUpperBound', 'outputTokenMax',
  'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs'];
const OBLIGATION = ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status',
  'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict'];
const EVIDENCE = ['requestId', 'proofSha256', 'mainEpoch', 'receiptType', 'providerRequestId', 'usageDimensions', 'actualMicroUsd'];
const MAIN_EVIDENCE = ['installationId', 'requestId', 'payloadSha256', 'priceVersion', 'proofSha256',
  'mainEpoch', 'receiptType', 'providerRequestId', 'usageDimensions', 'actualMicroUsd'];
const UNITS = new Set(['INPUT_TOKENS', 'OUTPUT_TOKENS', 'EMBEDDING_INPUT_TOKENS', 'CACHED_INPUT_TOKENS',
  'CACHE_WRITE_TOKENS', 'REASONING_TOKENS', 'REQUESTS']);
const STATES = new Set(['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED']);
const PHASES = new Set(['DISPATCHED', 'SETTLED', 'RECONCILE', 'LATCH', 'ACTIVATED']);
const CODES = new Set(['INVALID', 'CLOSED', 'BUSY', 'AUTHORITY_REQUIRED', 'PROOF_MISMATCH', 'PG_FAILED',
  'PG_TIMEOUT', 'OUTPUT_LIMIT', 'INPUT_LIMIT', 'INVALID_PROJECTION', 'OWNER_REQUIRED', 'CREDENTIAL_UNAVAILABLE',
  'REQUEST_REQUIRED', 'PROCESS_TERMINATION']);
class AiEgressPostgresError extends Error {
  constructor(code = 'PG_FAILED') {
    const safe = CODES.has(code) ? code : 'PG_FAILED';
    super(`AI cost PostgreSQL: ${safe}`); this.name = 'AiEgressPostgresError'; this.code = `AI_COST_PG_${safe}`;
  }
}
function fail(code) { throw new AiEgressPostgresError(code); }
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function full(value, regex) { return typeof value === 'string' && value.match(regex)?.[0] === value; }
function id(value) { if (!full(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)) fail('INVALID'); return value; }
function install(value) { if (!full(value, /^[A-Za-z0-9_-]{1,128}$/)) fail('INVALID'); return value; }
function uuid(value) { if (!full(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) fail('INVALID'); return value; }
function hash(value) { if (!full(value, /^[0-9a-f]{64}$/)) fail('INVALID'); return value; }
function integer(value, positive = false) {
  if (!full(value, /^(0|[1-9][0-9]{0,18})$/) || BigInt(value) > MAX || (positive && value === '0')) fail('INVALID');
  return value;
}
function date(value) {
  if (!full(value, /^\d{4}-\d{2}-\d{2}$/) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INVALID');
  return value;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
}
function same(a, b) { return canonical(a) === canonical(b); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function position(value) {
  exact(value, ['sequence', 'hash', 'projectionSha256', 'clockHighWaterMs']);
  integer(value.sequence); hash(value.hash); hash(value.projectionSha256); integer(value.clockHighWaterMs);
}
function obligation(value) {
  exact(value, OBLIGATION); uuid(value.requestId); hash(value.payloadSha256); date(value.budgetDay);
  id(value.priceVersion); integer(value.reservedMicroUsd); integer(value.liabilityFloorMicroUsd);
  if (!STATES.has(value.status) || typeof value.conflict !== 'boolean') fail('INVALID');
  if (value.status === 'SETTLED') { integer(value.actualMicroUsd); hash(value.proofSha256); }
  else if (value.actualMicroUsd !== null || value.proofSha256 !== null) fail('INVALID');
}
function usage(value) {
  exact(value, ['units']);
  if (!value.units || typeof value.units !== 'object' || Array.isArray(value.units)
      || Object.keys(value.units).length > UNITS.size) fail('INVALID');
  for (const [key, count] of Object.entries(value.units)) { if (!UNITS.has(key)) fail('INVALID'); integer(count); }
}
function evidence(value) {
  exact(value, EVIDENCE); uuid(value.requestId); hash(value.proofSha256); uuid(value.mainEpoch);
  if (!['USAGE', 'PROVEN_NOT_SENT'].includes(value.receiptType)) fail('INVALID');
  if (value.providerRequestId !== null) id(value.providerRequestId);
  integer(value.actualMicroUsd); usage(value.usageDimensions);
  if (value.receiptType === 'USAGE' && !Object.keys(value.usageDimensions.units).length) fail('INVALID');
  if (value.receiptType === 'PROVEN_NOT_SENT'
      && (value.actualMicroUsd !== '0' || value.providerRequestId !== null || Object.keys(value.usageDimensions.units).length)) fail('INVALID');
}
function projection(value, installationId) {
  try {
    exact(value, ['version', 'complete', 'gate', 'requests', 'evidence']);
    if (value.version !== 1 || value.complete !== true) fail('INVALID');
    exact(value.gate, GATE); const g = value.gate;
    if (g.installationId !== installationId) fail('INVALID');
    integer(g.ownerUserId, true);
    for (const key of ['policyRevision', 'dailyLimitMicroUsd', 'monthlyLimitMicroUsd', 'journalSequence', 'clockHighWaterMs']) integer(g[key]);
    for (const key of ['policySha256', 'journalHash', 'journalProjectionSha256']) hash(g[key]);
    if (typeof g.reconciliationRequired !== 'boolean' || typeof g.legacyLiabilityUnresolved !== 'boolean'
        || !Array.isArray(value.requests) || !Array.isArray(value.evidence)
        || value.requests.length > LIMITS.requests || value.evidence.length > LIMITS.evidence) fail('INVALID');
    const seen = new Set(), proofs = new Set();
    for (const row of value.requests) {
      exact(row, ROW); obligation(Object.fromEntries(OBLIGATION.map(key => [key, row[key]])));
      if (row.installationId !== installationId || seen.has(row.requestId)) fail('INVALID'); seen.add(row.requestId);
      hash(row.planSha256); hash(row.wireBodySha256);
      for (const key of ['ownerUserId', 'projectId', 'snapshotId']) if (row[key] !== null) integer(row[key], true);
      if (row.approvalId !== null) uuid(row.approvalId);
      if (row.journalSequence !== null) integer(row.journalSequence);
      if (row.journalHash !== null) hash(row.journalHash);
      if (row.dispatchBinding !== null) {
        const b = row.dispatchBinding; exact(b, BINDING); uuid(b.mainEpoch);
        for (const key of ['provider', 'model', 'endpointId', 'adapterVersion', 'tokenizerId', 'tokenizerVersion']) id(b[key]);
        if (!['CHAT', 'EMBEDDING', 'CONNECTION_PROBE'].includes(b.operation)) fail('INVALID');
        for (const key of ['costContractSha256', 'priceSha256', 'policySha256']) hash(b[key]);
        for (const key of BINDING_NUMBERS) integer(b[key]);
      }
    }
    for (const item of value.evidence) {
      evidence(item); const key = `${item.requestId}:${item.proofSha256}`;
      if (!seen.has(item.requestId) || proofs.has(key)) fail('INVALID'); proofs.add(key);
    }
    return freeze(copy(value));
  } catch { fail('INVALID_PROJECTION'); }
}
function journal(value, installationId) {
  exact(value, ['installationId', 'position', 'budgetDay', 'restorePending', 'obligations']);
  if (value.installationId !== installationId || typeof value.restorePending !== 'boolean'
      || !Array.isArray(value.obligations) || value.obligations.length > LIMITS.requests) fail('INVALID');
  position(value.position); date(value.budgetDay); const seen = new Set();
  for (const row of value.obligations) {
    obligation(row);
    if (seen.has(row.requestId) || row.budgetDay > value.budgetDay) fail('INVALID'); seen.add(row.requestId);
  }
  return freeze(copy(value));
}
function fromSnapshot(snapshot, installationId) {
  if (!snapshot || snapshot.installationId !== installationId || snapshot.major !== 1
      || !Number.isSafeInteger(snapshot.sequence) || !Number.isSafeInteger(snapshot.clockHighWaterMs)
      || !Array.isArray(snapshot.requests)) fail('PROOF_MISMATCH');
  return journal({ installationId, position: { sequence: String(snapshot.sequence), hash: snapshot.headHash,
    projectionSha256: snapshot.projectionDigest, clockHighWaterMs: String(snapshot.clockHighWaterMs) },
    budgetDay: snapshot.budgetDay, restorePending: snapshot.pendingRestore !== null || Boolean(snapshot.pendingMaintenance),
    obligations: snapshot.requests.map(row => Object.fromEntries(OBLIGATION.map(key => [key, row[key]]))) }, installationId);
}

// All dynamic SQL text below consists solely of canonical JSON encoded as base64. The public
// callbacks cannot select a SQL statement, identifier, command, or connection string.
function input(value) {
  const bytes = Buffer.from(canonical(value), 'utf8');
  if (bytes.length > LIMITS.inputBytes / 2) fail('INPUT_LIMIT');
  return `convert_from(decode('${bytes.toString('base64')}','base64'),'UTF8')::jsonb`;
}
const GATE_JSON = `jsonb_build_object('installationId',g.installation_id,'ownerUserId',g.owner_user_id::text,
  'policyRevision',g.policy_revision::text,'policySha256',g.policy_sha256,'dailyLimitMicroUsd',g.daily_limit_micro_usd::text,
  'monthlyLimitMicroUsd',g.monthly_limit_micro_usd::text,'reconciliationRequired',g.reconciliation_required,
  'legacyLiabilityUnresolved',g.legacy_liability_unresolved,'journalSequence',g.journal_sequence::text,
  'journalHash',g.journal_hash,'journalProjectionSha256',g.journal_projection_sha256,'clockHighWaterMs',g.clock_high_water_ms::text)`;
const BINDING_JSON = `case when r.dispatch_binding='{}'::jsonb then null else r.dispatch_binding || jsonb_build_object(
  ${BINDING_NUMBERS.map(key => `'${key}',r.dispatch_binding->>'${key}'`).join(',')}) end`;
const ROW_JSON = `jsonb_build_object('requestId',r.request_id::text,'installationId',r.installation_id,
  'ownerUserId',r.owner_user_id::text,'projectId',r.project_id::text,'snapshotId',r.snapshot_id::text,'approvalId',r.approval_id::text,
  'planSha256',r.plan_sha256,'payloadSha256',r.payload_sha256,'wireBodySha256',r.wire_body_sha256,'dispatchBinding',${BINDING_JSON},
  'budgetDay',to_char(r.budget_day,'YYYY-MM-DD'),'priceVersion',r.price_version,'reservedMicroUsd',r.reserved_micro_usd::text,
  'status',r.status,'actualMicroUsd',r.actual_micro_usd::text,'proofSha256',r.proof_sha256,
  'liabilityFloorMicroUsd',r.liability_floor_micro_usd::text,'conflict',r.conflict,'journalSequence',r.journal_sequence::text,'journalHash',r.journal_hash)`;
function normalizedUsage(alias) {
  return `${alias}.usage_dimensions || jsonb_build_object('units',coalesce((select jsonb_object_agg(u.key,to_jsonb(u.value #>> '{}'))
    from jsonb_each(${alias}.usage_dimensions->'units') u),'{}'::jsonb))`;
}
const EVIDENCE_JSON = `jsonb_build_object('requestId',e.request_id::text,'proofSha256',e.proof_sha256,'mainEpoch',e.main_epoch,
  'receiptType',e.receipt_type,'providerRequestId',e.provider_request_id,'usageDimensions',${normalizedUsage('e')},'actualMicroUsd',e.actual_micro_usd::text)`;
const PROJECTION_CTE = `gates as (select ${GATE_JSON} as value from public.ai_budget_gate g
    where g.installation_id=(select value->>'installationId' from params)),
  requests as (select r.request_id,${ROW_JSON} as value from public.ai_request_ledger r
    where r.installation_id=(select value->>'installationId' from params) order by r.request_id limit 10001),
  evidence as (select e.request_id,e.proof_sha256,${EVIDENCE_JSON} as value from public.ai_usage_evidence e
    join public.ai_request_ledger r using(request_id) where r.installation_id=(select value->>'installationId' from params)
    order by e.request_id,e.proof_sha256 limit 10001),
  projection as (select jsonb_build_object('version',1,'complete',
    (select count(*)<=10000 from requests) and (select count(*)<=10000 from evidence),'gate',(select value from gates),
    'requests',coalesce((select jsonb_agg(value order by request_id) from requests),'[]'::jsonb),
    'evidence',coalesce((select jsonb_agg(value order by request_id,proof_sha256) from evidence),'[]'::jsonb)) as value)`;
function readSql(value, requested) {
  const select = requested ? `select jsonb_build_object('projection',(select value from projection),
    'request',(select value from requests where request_id=(select (value->>'requestId')::uuid from params)),
    'settings',(select jsonb_build_object('ownerUserId',p.user_id::text,'revision',p.revision::text,
      'provider',p.provider,'model',p.model,'state',case when p.connection_state='ENABLED'
      and s.provider=p.provider and s.model is not distinct from p.model and length(s.encrypted_key)>0
      and octet_length(s.nonce)>0 and s.key_version>0 then 'ACTIVE' else 'INACTIVE' end)
      from public.user_ai_preferences p left join public.user_ai_settings s on s.user_id=p.user_id
      join public.users u on u.id=p.user_id and u.identity_type in ('LOCAL','LOCAL_LINKED')
      and u.local_key=(select value->>'installationId' from params)
      where p.user_id=(select r.owner_user_id from public.ai_request_ledger r
      where r.request_id=(select (value->>'requestId')::uuid from params)
      and r.installation_id=(select value->>'installationId' from params))))` : 'select value from projection';
  return `with params as (select ${input(value)} as value),${PROJECTION_CTE} ${select};`;
}
const SETTINGS_ACTIVE = `p.connection_state='ENABLED' and s.provider=p.provider and s.model is not distinct from p.model
  and length(s.encrypted_key)>0 and octet_length(s.nonce)>0 and s.key_version>0`;
function credentialSql(value) {
  return `with params as (select ${input(value)} as value)
    select jsonb_build_object('ownerUserId',p.user_id::text,'revision',p.revision::text,'provider',p.provider,'model',p.model,
      'keyVersion',s.key_version,'nonceBase64',encode(s.nonce,'base64'),'encryptedKey',s.encrypted_key)
    from public.user_ai_preferences p join public.user_ai_settings s on s.user_id=p.user_id
    join public.users u on u.id=p.user_id and u.identity_type in ('LOCAL','LOCAL_LINKED')
    and u.local_key=(select value->>'installationId' from params)
    where p.user_id=(select (value->>'ownerUserId')::bigint from params)
      and p.provider=(select value->>'provider' from params)
      and p.revision=(select (value->>'settingsRevision')::bigint from params) and ${SETTINGS_ACTIVE};`;
}
function ownerSql(value, enrollment) {
  return `with params as (select ${input(value)} as value)
    select jsonb_build_object('installationId',u.local_key,'ownerUserId',u.id::text${enrollment ? `,
      'legacyUsageCount',(select count(*)::text from public.ai_usage_logs),
      'requestCount',(select count(*)::text from public.ai_request_ledger),
      'gateCount',(select count(*)::text from public.ai_budget_gate)` : ''})
    from public.users u where u.identity_type in ('LOCAL','LOCAL_LINKED') and u.local_key=(select value->>'installationId' from params);`;
}
function maintenanceGateSql(value) {
  return `do $maintenance_gate$
    declare v jsonb := ${input(value)}; g public.ai_budget_gate%rowtype; legacy boolean;
    begin
      lock table public.users, public.ai_budget_gate, public.ai_request_ledger, public.ai_usage_evidence,
        public.ai_usage_logs in share row exclusive mode;
      if (select count(*) from public.users where identity_type in ('LOCAL','LOCAL_LINKED')) <> 1
        or not exists(select 1 from public.users where id=(v->>'ownerUserId')::bigint
          and local_key=v->>'installationId' and identity_type in ('LOCAL','LOCAL_LINKED'))
        or exists(select 1 from public.users where local_key is not null and
          (id<>(v->>'ownerUserId')::bigint or local_key<>v->>'installationId' or identity_type not in ('LOCAL','LOCAL_LINKED')))
        or exists(select 1 from public.ai_budget_gate where installation_id<>v->>'installationId'
          or owner_user_id<>(v->>'ownerUserId')::bigint)
        then raise exception 'maintenance owner mismatch'; end if;
      legacy := (v->>'legacyLiabilityUnresolved')::boolean or exists(select 1 from public.ai_usage_logs);
      select * into g from public.ai_budget_gate where installation_id=v->>'installationId';
      if not found then
        if exists(select 1 from public.ai_request_ledger) or exists(select 1 from public.ai_usage_evidence)
          then raise exception 'unbound financial state'; end if;
        insert into public.ai_budget_gate(installation_id,owner_user_id,policy_sha256,
          legacy_liability_unresolved,journal_hash,journal_projection_sha256)
        values(v->>'installationId',(v->>'ownerUserId')::bigint,v->>'policySha256',legacy,'${ZERO}','${ZERO}');
      else
        update public.ai_budget_gate set legacy_liability_unresolved=legacy_liability_unresolved or legacy,
          reconciliation_required=true,updated_at=now() where installation_id=v->>'installationId';
      end if;
    end $maintenance_gate$;
    select jsonb_build_object('ok',true);`;
}
function maintenanceState(value, installationId, sealed) {
  if (!value || value.aiOff !== true || typeof value.legacyLiabilityUnresolved !== 'boolean'
      || value.recoveryOnly === true) fail('PROOF_MISMATCH');
  const normalized = fromSnapshot(value, installationId);
  if (sealed) {
    if (value.pendingRestore !== null || !value.pendingMaintenance) fail('PROOF_MISMATCH');
    const seal = value.pendingMaintenance;
    exact(seal, ['transactionId', 'kind', 'payloadSha256', 'pgProjectionDigest', 'legacyLiabilityUnresolved', 'budgetDay', 'minimumVersion']);
    uuid(seal.transactionId); hash(seal.payloadSha256); hash(seal.pgProjectionDigest); date(seal.budgetDay); integer(seal.minimumVersion);
    if (!['BACKUP', 'RESTORE'].includes(seal.kind) || typeof seal.legacyLiabilityUnresolved !== 'boolean'
        || (seal.legacyLiabilityUnresolved && !value.legacyLiabilityUnresolved)) fail('PROOF_MISMATCH');
  }
  return { snapshot: freeze(copy(value)), normalized };
}
function rowLiability(row) {
  return row.status === 'SETTLED' && !row.conflict ? BigInt(row.actualMicroUsd)
    : [BigInt(row.reservedMicroUsd), BigInt(row.liabilityFloorMicroUsd)].reduce((a, b) => a > b ? a : b);
}
function reconstructMaintenanceProjection(live, archived, trusted, installationId) {
  if (!live.gate.reconciliationRequired || (archived && archived.gate.ownerUserId !== live.gate.ownerUserId)) fail('PROOF_MISMATCH');
  const sources = archived ? [live, archived] : [live];
  if (sources.some(source => source.gate.legacyLiabilityUnresolved) && !trusted.snapshot.legacyLiabilityUnresolved) fail('PROOF_MISMATCH');
  const obligations = new Map(trusted.normalized.obligations.map(row => [row.requestId, row]));
  const metadata = sources.map(source => new Map(source.requests.map(row => [row.requestId, row])));
  for (const source of sources) for (const row of source.requests) {
    const b = obligations.get(row.requestId);
    if (!b || BigInt(b.liabilityFloorMicroUsd) < rowLiability(row) || (row.conflict && !b.conflict)) fail('PROOF_MISMATCH');
    if (row.status === 'SETTLED' && b.status === 'SETTLED' && !b.conflict
        && (row.proofSha256 !== b.proofSha256 || row.actualMicroUsd !== b.actualMicroUsd)) fail('PROOF_MISMATCH');
  }
  const proofs = new Map();
  for (const source of sources) for (const item of source.evidence) {
    const b = obligations.get(item.requestId);
    if (!b || BigInt(b.liabilityFloorMicroUsd) < BigInt(item.actualMicroUsd)) fail('PROOF_MISMATCH');
    const key = `${item.requestId}:${item.proofSha256}`, previous = proofs.get(key);
    if (previous && !same(previous, item)) fail('PROOF_MISMATCH');
    proofs.set(key, item);
  }
  const p = trusted.normalized.position;
  const requests = [...obligations.values()].map(b => {
    const original = metadata.map(m => m.get(b.requestId)).find(row => row &&
      ['payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].every(key => row[key] === b[key]));
    const kept = original ? Object.fromEntries(['ownerUserId', 'projectId', 'snapshotId', 'approvalId', 'planSha256',
      'wireBodySha256', 'dispatchBinding'].map(key => [key, original[key]])) : { ownerUserId: null, projectId: null,
      snapshotId: null, approvalId: null, planSha256: ZERO, wireBodySha256: ZERO, dispatchBinding: null };
    return { ...b, installationId, ...kept, journalSequence: p.sequence, journalHash: p.hash };
  }).sort((a, b) => a.requestId.localeCompare(b.requestId));
  const maximum = values => values.map(BigInt).reduce((a, b) => a > b ? a : b);
  const revision = maximum(sources.map(s => s.gate.policyRevision)) + 1n;
  if (revision > MAX) fail('INVALID');
  const gate = { ...live.gate, policyRevision: revision.toString(), reconciliationRequired: true,
    legacyLiabilityUnresolved: sources.some(s => s.gate.legacyLiabilityUnresolved) || trusted.snapshot.legacyLiabilityUnresolved,
    journalSequence: p.sequence, journalHash: p.hash, journalProjectionSha256: p.projectionSha256,
    clockHighWaterMs: maximum([p.clockHighWaterMs, ...sources.map(s => s.gate.clockHighWaterMs)]).toString() };
  gate.policySha256 = crypto.createHash('sha256').update(`AI_BUDGET_POLICY_1\n${installationId}\n${gate.ownerUserId}\n${gate.policyRevision}\n${gate.dailyLimitMicroUsd}\n${gate.monthlyLimitMicroUsd}`).digest('hex');
  return projection({ version: 1, complete: true, gate, requests, evidence: [...proofs.values()]
    .sort((a, b) => a.requestId.localeCompare(b.requestId) || a.proofSha256.localeCompare(b.proofSha256)) }, installationId);
}
function seedMaintenanceSql(value) {
  return `do $maintenance_seed$
    declare v jsonb := ${input(value)}; g jsonb := v->'gate'; item jsonb;
    begin
      lock table public.users,public.ai_budget_gate,public.ai_request_ledger,public.ai_usage_evidence,public.ai_usage_logs in share row exclusive mode;
      if exists(select 1 from public.ai_budget_gate) or exists(select 1 from public.ai_request_ledger)
        or exists(select 1 from public.ai_usage_evidence) then raise exception 'staging financial state not empty'; end if;
      if exists(select 1 from public.ai_usage_logs) and not (g->>'legacyLiabilityUnresolved')::boolean
        then raise exception 'unresolved staged legacy usage'; end if;
      if (select count(*) from public.users where identity_type in ('LOCAL','LOCAL_LINKED'))<>1
        or not exists(select 1 from public.users where id=(g->>'ownerUserId')::bigint
          and local_key=g->>'installationId' and identity_type in ('LOCAL','LOCAL_LINKED'))
        or exists(select 1 from public.users where local_key is not null and
          (id<>(g->>'ownerUserId')::bigint or local_key<>g->>'installationId' or identity_type not in ('LOCAL','LOCAL_LINKED')))
        then raise exception 'staging owner mismatch'; end if;
      insert into public.ai_budget_gate(installation_id,owner_user_id,policy_revision,policy_sha256,daily_limit_micro_usd,
        monthly_limit_micro_usd,reconciliation_required,legacy_liability_unresolved,journal_sequence,journal_hash,journal_projection_sha256,clock_high_water_ms)
        values(g->>'installationId',(g->>'ownerUserId')::bigint,(g->>'policyRevision')::bigint,g->>'policySha256',
          (g->>'dailyLimitMicroUsd')::bigint,(g->>'monthlyLimitMicroUsd')::bigint,true,(g->>'legacyLiabilityUnresolved')::boolean,
          (g->>'journalSequence')::bigint,g->>'journalHash',g->>'journalProjectionSha256',(g->>'clockHighWaterMs')::bigint);
      for item in select value from jsonb_array_elements(v->'requests') loop
        insert into public.ai_request_ledger(request_id,installation_id,owner_user_id,project_id,snapshot_id,approval_id,plan_sha256,
          payload_sha256,wire_body_sha256,dispatch_binding,budget_day,price_version,reserved_micro_usd,status,actual_micro_usd,
          proof_sha256,liability_floor_micro_usd,conflict,journal_sequence,journal_hash)
        values((item->>'requestId')::uuid,item->>'installationId',(item->>'ownerUserId')::bigint,(item->>'projectId')::bigint,
          (item->>'snapshotId')::bigint,(item->>'approvalId')::uuid,item->>'planSha256',item->>'payloadSha256',item->>'wireBodySha256',
          case when item->'dispatchBinding'='null'::jsonb then '{}'::jsonb else item->'dispatchBinding' end,
          (item->>'budgetDay')::date,item->>'priceVersion',(item->>'reservedMicroUsd')::bigint,item->>'status',
          (item->>'actualMicroUsd')::bigint,item->>'proofSha256',(item->>'liabilityFloorMicroUsd')::bigint,(item->>'conflict')::boolean,
          (item->>'journalSequence')::bigint,item->>'journalHash');
      end loop;
      for item in select value from jsonb_array_elements(v->'evidence') loop
        insert into public.ai_usage_evidence(request_id,proof_sha256,main_epoch,receipt_type,provider_request_id,usage_dimensions,actual_micro_usd)
        values((item->>'requestId')::uuid,item->>'proofSha256',item->>'mainEpoch',item->>'receiptType',item->>'providerRequestId',
          item->'usageDimensions',(item->>'actualMicroUsd')::bigint);
      end loop;
    end $maintenance_seed$;
    select jsonb_build_object('ok',true);`;
}
function evidenceSql(value) {
  return `do $cost_evidence$
    declare v jsonb := ${input(value)}; r public.ai_request_ledger%rowtype; e public.ai_usage_evidence%rowtype;
    begin
      perform 1 from public.ai_budget_gate where installation_id=v->>'installationId' for update;
      if not found then raise exception 'cost gate missing'; end if;
      select * into strict r from public.ai_request_ledger where request_id=(v->>'requestId')::uuid
        and installation_id=v->>'installationId';
      if r.payload_sha256 <> v->>'payloadSha256' or r.price_version <> v->>'priceVersion'
        or r.owner_user_id is null or r.project_id is null or r.snapshot_id is null or r.approval_id is null
        or r.dispatch_binding='{}'::jsonb or r.dispatch_binding->>'mainEpoch' <> v->>'mainEpoch'
        then raise exception 'cost evidence mismatch'; end if;
      if v->>'receiptType'='USAGE' and (
        (r.dispatch_binding->>'operation'='CHAT' and not (v->'usageDimensions'->'units' ?& array['INPUT_TOKENS','OUTPUT_TOKENS'])) or
        (r.dispatch_binding->>'operation'='EMBEDDING' and not (v->'usageDimensions'->'units' ? 'EMBEDDING_INPUT_TOKENS')))
        then raise exception 'cost usage missing'; end if;
      select * into e from public.ai_usage_evidence where request_id=r.request_id and proof_sha256=v->>'proofSha256';
      if found then
        if e.main_epoch <> v->>'mainEpoch' or e.receipt_type <> v->>'receiptType'
          or e.provider_request_id is distinct from v->>'providerRequestId'
          or e.actual_micro_usd <> (v->>'actualMicroUsd')::bigint
          or (${normalizedUsage('e')}) is distinct from v->'usageDimensions'
          then raise exception 'cost evidence immutable'; end if;
      else
        insert into public.ai_usage_evidence(request_id,proof_sha256,main_epoch,receipt_type,provider_request_id,usage_dimensions,actual_micro_usd)
          values(r.request_id,v->>'proofSha256',v->>'mainEpoch',v->>'receiptType',v->>'providerRequestId',
            v->'usageDimensions',(v->>'actualMicroUsd')::bigint);
      end if;
    end $cost_evidence$;
    select jsonb_build_object('ok',true);`;
}
function publishSql(value) {
  return `do $cost_publish$
    declare v jsonb := ${input(value)}; j jsonb := v->'journal'; p jsonb := j->'position';
      g public.ai_budget_gate%rowtype; r public.ai_request_ledger%rowtype; item jsonb;
      next_status text; next_actual bigint; next_proof text; next_floor bigint; next_conflict boolean;
      blocked boolean; seq bigint := (p->>'sequence')::bigint; held bigint;
    begin
      select * into strict g from public.ai_budget_gate where installation_id=j->>'installationId' for update;
      if seq < g.journal_sequence or (seq=g.journal_sequence and seq<>0 and
        (g.journal_hash<>p->>'hash' or g.journal_projection_sha256<>p->>'projectionSha256'))
        then raise exception 'cost journal regression'; end if;
      blocked := g.legacy_liability_unresolved or (j->>'restorePending')::boolean
        or (g.reconciliation_required and v->>'phase'<>'RECONCILE');
      if v->>'phase' in ('DISPATCHED','SETTLED') then
        select * into strict r from public.ai_request_ledger where request_id=(v->>'requestId')::uuid
          and installation_id=g.installation_id;
        if v->>'phase'='SETTLED' then
          item := v->'settlement';
          if r.payload_sha256<>item->>'payloadSha256' or not exists(select 1 from public.ai_usage_evidence e
            where e.request_id=r.request_id and e.proof_sha256=item->>'proofSha256'
            and e.actual_micro_usd=(item->>'actualMicroUsd')::bigint)
            then raise exception 'cost settlement evidence missing'; end if;
        else
          item := v->'dispatch';
          if r.owner_user_id is null or r.project_id is null or r.snapshot_id is null or r.approval_id is null
            or r.dispatch_binding='{}'::jsonb or r.payload_sha256<>item->>'payloadSha256' or r.price_version<>item->>'priceVersion'
            or r.reserved_micro_usd<>(item->>'reservedMicroUsd')::bigint
            or r.budget_day<>(item->>'budgetDay')::date or r.dispatch_binding->>'mainEpoch'<>item->>'mainEpoch'
            then raise exception 'cost dispatch mismatch'; end if;
        end if;
      end if;
      for item in select value from jsonb_array_elements(j->'obligations') loop
        select * into r from public.ai_request_ledger where request_id=(item->>'requestId')::uuid
          and installation_id=g.installation_id;
        if not found then
          insert into public.ai_request_ledger(request_id,installation_id,plan_sha256,payload_sha256,wire_body_sha256,
            dispatch_binding,budget_day,price_version,reserved_micro_usd,status,actual_micro_usd,proof_sha256,
            liability_floor_micro_usd,conflict,journal_sequence,journal_hash)
          values((item->>'requestId')::uuid,g.installation_id,'${ZERO}',item->>'payloadSha256','${ZERO}','{}',
            (item->>'budgetDay')::date,item->>'priceVersion',(item->>'reservedMicroUsd')::bigint,item->>'status',
            (item->>'actualMicroUsd')::bigint,item->>'proofSha256',(item->>'liabilityFloorMicroUsd')::bigint,
            (item->>'conflict')::boolean,seq,p->>'hash');
        else
          if r.journal_sequence>seq then raise exception 'cost request journal regression'; end if;
          next_conflict := r.conflict or (item->>'conflict')::boolean
            or r.payload_sha256<>item->>'payloadSha256' or r.price_version<>item->>'priceVersion'
            or r.budget_day<>(item->>'budgetDay')::date or r.reserved_micro_usd<>(item->>'reservedMicroUsd')::bigint
            or (r.status='SETTLED' and (item->>'status'<>'SETTLED' or r.actual_micro_usd is distinct from (item->>'actualMicroUsd')::bigint
              or r.proof_sha256 is distinct from item->>'proofSha256'));
          next_floor := greatest(r.liability_floor_micro_usd,(item->>'liabilityFloorMicroUsd')::bigint);
          if next_conflict then
            next_floor := greatest(next_floor,r.reserved_micro_usd,coalesce(r.actual_micro_usd,0),
              (item->>'reservedMicroUsd')::bigint,coalesce((item->>'actualMicroUsd')::bigint,0));
            next_status := r.status; next_actual := r.actual_micro_usd; next_proof := r.proof_sha256;
          elsif item->>'status'='SETTLED' then
            next_status := 'SETTLED'; next_actual := (item->>'actualMicroUsd')::bigint; next_proof := item->>'proofSha256';
          else
            next_status := case when r.status='UNKNOWN_HELD' or item->>'status'='UNKNOWN_HELD' then 'UNKNOWN_HELD'
              when r.status='DISPATCHED' or item->>'status'='DISPATCHED' then 'DISPATCHED' else 'RESERVED' end;
            next_actual := null; next_proof := null;
          end if;
          update public.ai_request_ledger set status=next_status,actual_micro_usd=next_actual,proof_sha256=next_proof,
            liability_floor_micro_usd=next_floor,conflict=next_conflict,journal_sequence=seq,journal_hash=p->>'hash',updated_at=now()
            where request_id=r.request_id;
        end if;
      end loop;
      if exists(select 1 from public.ai_request_ledger q where q.installation_id=g.installation_id and
        (q.conflict or (q.status='SETTLED' and q.actual_micro_usd>q.reserved_micro_usd)
        or (q.status<>'RESERVED' and not exists(select 1 from jsonb_array_elements(j->'obligations') z
          where (z->>'requestId')::uuid=q.request_id)))) then blocked:=true; end if;
      if greatest(g.clock_high_water_ms,(p->>'clockHighWaterMs')::bigint) > (v->>'nowMs')::bigint
        or (j->>'budgetDay')::date > (v->>'today')::date then blocked:=true; end if;
      update public.ai_budget_gate set journal_sequence=seq,journal_hash=p->>'hash',journal_projection_sha256=p->>'projectionSha256',
        clock_high_water_ms=greatest(clock_high_water_ms,(p->>'clockHighWaterMs')::bigint),
        reconciliation_required=blocked,updated_at=now() where installation_id=g.installation_id;
    end $cost_publish$;
    select jsonb_build_object('ok',true);`;
}

async function createAiEgressPostgres(options) { return openAiEgressPostgres(options, null); }
async function openAiEgressPostgres(options, maintenanceParent) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['psqlPath', 'installationId', 'connection', 'env', 'spawn', 'now', 'timeoutMs'].includes(key))) fail('INVALID');
  const { psqlPath, installationId } = options; install(installationId);
  if (typeof psqlPath !== 'string' || !path.isAbsolute(psqlPath) || path.resolve(psqlPath) !== psqlPath) fail('INVALID');
  let info; try { info = await fs.lstat(psqlPath); } catch { fail('INVALID'); }
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) fail('INVALID');
  const connection = options.connection;
  exact(connection, ['host', 'port', 'user', 'database']);
  if (connection.host !== '127.0.0.1' || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || !full(connection.user, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
      || !full(connection.database, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/)) fail('INVALID');
  if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)
      || Object.keys(options.env).some(key => !['PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].includes(key))) fail('INVALID');
  if (options.env.PGSSLMODE !== undefined && options.env.PGSSLMODE !== 'verify-full') fail('INVALID');
  if (options.env.PGSSLROOTCERT !== undefined && (typeof options.env.PGSSLROOTCERT !== 'string'
      || !path.isAbsolute(options.env.PGSSLROOTCERT) || path.normalize(options.env.PGSSLROOTCERT) !== options.env.PGSSLROOTCERT)) fail('INVALID');
  const environment = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'code-intelligence-ai-cost', PGSSLMODE: 'verify-full' };
  for (const [key, value] of Object.entries(options.env)) {
    if (typeof value !== 'string' || !value.length || value.length > 16384 || value.includes('\0')) fail('INVALID');
    environment[key] = value;
  }
  if (!environment.PGPASSWORD) fail('INVALID');
  const spawn = options.spawn || childProcess.spawn; const wall = options.now || Date.now;
  if (typeof spawn !== 'function' || typeof wall !== 'function') fail('INVALID');
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > LIMITS.timeoutMs) fail('INVALID');
  let authority = null, closed = false, queued = 0, queuedBytes = 0, serial = Promise.resolve(), active = null, closePromise;
  let terminationFailure = false;
  let stageConsumed = false;
  let creatingStages = 0;
  const children = new Set();
  const args = Object.freeze(['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--pset=pager=off',
    '--set=ON_ERROR_STOP=1', `--host=${connection.host}`, `--port=${connection.port}`, `--username=${connection.user}`,
    `--dbname=${connection.database}`, '--file=-']);
  function run(sql, readOnly) {
    if (closed) return Promise.reject(new AiEgressPostgresError('CLOSED'));
    const bytesQueued = Buffer.byteLength(sql);
    if (queued >= LIMITS.queued || queuedBytes + bytesQueued > LIMITS.queuedBytes) return Promise.reject(new AiEgressPostgresError('BUSY'));
    if (bytesQueued > LIMITS.inputBytes) return Promise.reject(new AiEgressPostgresError('INPUT_LIMIT'));
    queued++; queuedBytes += bytesQueued;
    const result = serial.then(() => {
      if (closed) fail('CLOSED');
      return new Promise((resolve, reject) => {
        const prefix = readOnly ? 'begin isolation level repeatable read read only;' : 'begin;';
        const stdin = `${prefix}\nset local search_path=pg_catalog,public;\nset local statement_timeout='10000ms';\nset local lock_timeout='5000ms';\n${sql}\ncommit;\n`;
        let child, timer, killTimer, reapTimer, settled = false, reason = null, outputBytes = 0, errorBytes = 0;
        const chunks = [];
        function finish(error, value) {
          if (settled) return; settled = true;
          if (error === 'PROCESS_TERMINATION') terminationFailure = true;
          clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer);
          chunks.forEach(chunk => chunk.fill(0)); chunks.length = 0;
          if (active?.child === child) active = null;
          error ? reject(new AiEgressPostgresError(error)) : resolve(value);
        }
        function terminate(code) {
          reason ||= code;
          try { child?.kill('SIGTERM'); } catch { /* Escalate below. */ }
          if (!killTimer) killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 200);
          if (!reapTimer) reapTimer = setTimeout(() => finish('PROCESS_TERMINATION'), 2000);
        }
        try { child = spawn(psqlPath, args, { env: { ...environment }, cwd: path.dirname(psqlPath),
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch { finish('PG_FAILED'); return; }
        active = { child, terminate };
        child.once('error', () => {
          if (child.pid) terminate(reason || 'PG_FAILED');
          else finish(reason || 'PG_FAILED');
        });
        child.stdout.on('data', bytes => {
          if (settled) return;
          outputBytes += bytes.length;
          if (outputBytes > LIMITS.outputBytes) { terminate('OUTPUT_LIMIT'); return; }
          chunks.push(Buffer.from(bytes));
        });
        child.stderr.on('data', bytes => {
          if (settled) return;
          errorBytes += bytes.length; if (errorBytes > LIMITS.stderrBytes) terminate('OUTPUT_LIMIT');
        });
        child.stdin.on('error', () => terminate('PG_FAILED'));
        child.once('close', code => {
          if (reason || code !== 0) { finish(reason || 'PG_FAILED'); return; }
          try {
            const bytes = Buffer.concat(chunks); let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } finally { bytes.fill(0); }
            const value = text ? JSON.parse(text) : null;
            finish(null, value);
          } catch { finish('PG_FAILED'); }
        });
        timer = setTimeout(() => terminate('PG_TIMEOUT'), timeoutMs);
        try { child.stdin.end(stdin); } catch { terminate('PG_FAILED'); }
      });
    });
    serial = result.catch(() => {}).finally(() => { queued--; queuedBytes -= bytesQueued; });
    return result;
  }
  function boundAuthority() { if (!authority) fail('AUTHORITY_REQUIRED'); return authority; }
  function bindAuthority(value) {
    if (closed) fail('CLOSED');
    exact(value, ['readDispatch', 'readEvidence', 'readSettlement', 'readJournal',
      ...(value && Object.hasOwn(value, 'readMaintenanceSnapshot') ? ['readMaintenanceSnapshot'] : [])]);
    if (authority || Object.values(value).some(fn => typeof fn !== 'function')) fail('INVALID');
    authority = Object.freeze({ ...value });
  }
  async function readProjection() { return projection(await run(readSql({ installationId }, false), true), installationId); }
  async function readCommittedRequest(requestId) {
    uuid(requestId);
    const value = await run(readSql({ installationId, requestId }, true), true);
    try {
      exact(value, ['request', 'settings', 'projection']); const p = projection(value.projection, installationId);
      if (!value.request) fail('REQUEST_REQUIRED');
      if (!same(value.request, p.requests.find(row => row.requestId === requestId))) fail('INVALID_PROJECTION');
      exact(value.settings, ['ownerUserId', 'revision', 'provider', 'model', 'state']);
      integer(value.settings.ownerUserId, true); integer(value.settings.revision); id(value.settings.provider); id(value.settings.model);
      if (!['ACTIVE', 'INACTIVE'].includes(value.settings.state)) fail('INVALID');
      return freeze(copy(value));
    } catch (e) { if (e.code === 'AI_COST_PG_REQUEST_REQUIRED') throw e; fail('INVALID_PROJECTION'); }
  }
  async function readLocalOwner() {
    const value = await run(ownerSql({ installationId }, false), true);
    if (!value) fail('OWNER_REQUIRED'); exact(value, ['installationId', 'ownerUserId']);
    if (value.installationId !== installationId) fail('OWNER_REQUIRED'); integer(value.ownerUserId, true);
    return freeze(copy(value));
  }
  async function readEnrollmentState() {
    const value = await run(ownerSql({ installationId }, true), true);
    if (!value) fail('OWNER_REQUIRED'); exact(value, ['installationId', 'ownerUserId', 'legacyUsageCount', 'requestCount', 'gateCount']);
    if (value.installationId !== installationId) fail('OWNER_REQUIRED'); integer(value.ownerUserId, true);
    for (const key of ['legacyUsageCount', 'requestCount', 'gateCount']) integer(value[key]);
    return freeze(copy(value));
  }
  // This main-only enrollment cannot enable AI or establish zero historical liability by default.
  // It validates the entire installation scope and persists the legacy OR before a backup seal.
  async function prepareMaintenanceGate(value) {
    exact(value, ['ownerUserId', 'legacyLiabilityUnresolved']); integer(value.ownerUserId, true);
    if (typeof value.legacyLiabilityUnresolved !== 'boolean') fail('INVALID');
    const current = readMaintenance(false);
    const policySha256 = crypto.createHash('sha256').update(
      `AI_BUDGET_POLICY_1\n${installationId}\n${value.ownerUserId}\n0\n0\n0`).digest('hex');
    const legacyLiabilityUnresolved = value.legacyLiabilityUnresolved || current.snapshot.legacyLiabilityUnresolved;
    const result = await run(maintenanceGateSql({ installationId, ...value, legacyLiabilityUnresolved, policySha256 }), false);
    if (!same(result, { ok: true })) fail('PG_FAILED');
    const observed = await readProjection();
    const latest = readMaintenance(false);
    if (observed.gate.ownerUserId !== value.ownerUserId || !observed.gate.reconciliationRequired
        || ((legacyLiabilityUnresolved || latest.snapshot.legacyLiabilityUnresolved) && !observed.gate.legacyLiabilityUnresolved)) fail('PROOF_MISMATCH');
    return observed;
  }
  function readMaintenance(sealed) {
    if (closed) fail('CLOSED');
    if (maintenanceParent) maintenanceParent.assertOpen();
    const read = boundAuthority();
    if (typeof read.readMaintenanceSnapshot !== 'function') fail('AUTHORITY_REQUIRED');
    const state = maintenanceState(read.readMaintenanceSnapshot(), installationId, sealed);
    if (!same(state.normalized, journal(read.readJournal(), installationId))) fail('PROOF_MISMATCH');
    return state;
  }
  async function createMaintenanceStage(value) {
    exact(value, ['database']);
    if (maintenanceParent || !full(value.database, /^ci_backup_stage_[0-9a-f]{16,32}$/) || value.database === connection.database) fail('INVALID');
    readMaintenance(false);
    if (children.size + creatingStages >= 2) fail('BUSY');
    creatingStages++;
    try {
      const child = await openAiEgressPostgres({ psqlPath, installationId, connection: { ...connection, database: value.database },
        env: Object.fromEntries(Object.entries(environment).filter(([key]) => ['PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].includes(key))),
        spawn, now: wall, timeoutMs }, { assertOpen() { if (closed) fail('CLOSED'); }, authority: boundAuthority() });
      if (closed) { await child.close(); fail('CLOSED'); }
      const wrapped = Object.freeze({ ...child, close: () => child.close().finally(() => children.delete(wrapped)) });
      children.add(wrapped); return wrapped;
    } finally { creatingStages--; }
  }
  async function seedMaintenanceProjection(value) {
    if (!maintenanceParent || stageConsumed) fail('AUTHORITY_REQUIRED');
    exact(value, ['liveProjection', 'archivedProjection', 'journalSnapshot']);
    const current = readMaintenance(true);
    if (!same(current.snapshot, value.journalSnapshot)) fail('PROOF_MISMATCH');
    const live = projection(value.liveProjection, installationId);
    const archived = value.archivedProjection === null ? null : projection(value.archivedProjection, installationId);
    const expected = reconstructMaintenanceProjection(live, archived, current, installationId);
    stageConsumed = true;
    if (!same(current.snapshot, readMaintenance(true).snapshot)) fail('PROOF_MISMATCH');
    const result = await run(seedMaintenanceSql(expected), false);
    if (!same(result, { ok: true })) fail('PG_FAILED');
    const committed = await readProjection();
    if (!same(expected, committed) || !same(current.snapshot, readMaintenance(true).snapshot)) fail('PROOF_MISMATCH');
    return committed;
  }
  async function readCredential(value) {
    exact(value, ['ownerUserId', 'provider', 'settingsRevision']); integer(value.ownerUserId, true);
    id(value.provider); integer(value.settingsRevision);
    const result = await run(credentialSql({ installationId, ...value }), true);
    if (!result) fail('CREDENTIAL_UNAVAILABLE');
    exact(result, ['ownerUserId', 'revision', 'provider', 'model', 'keyVersion', 'nonceBase64', 'encryptedKey']);
    if (result.ownerUserId !== value.ownerUserId || result.revision !== value.settingsRevision || result.provider !== value.provider)
      fail('CREDENTIAL_UNAVAILABLE');
    id(result.model);
    if (!Number.isInteger(result.keyVersion) || result.keyVersion <= 0 || result.keyVersion > 2147483647) fail('CREDENTIAL_UNAVAILABLE');
    for (const key of ['nonceBase64', 'encryptedKey']) if (!full(result[key], /^[A-Za-z0-9+/]+={0,2}$/) || result[key].length > 16384) fail('CREDENTIAL_UNAVAILABLE');
    return freeze(copy(result));
  }
  async function commitEvidence(value) {
    exact(value, MAIN_EVIDENCE);
    if (value.installationId !== installationId) fail('PROOF_MISMATCH'); hash(value.payloadSha256); id(value.priceVersion);
    evidence(Object.fromEntries(EVIDENCE.map(key => [key, value[key]])));
    const proof = boundAuthority().readEvidence(value.requestId, value.proofSha256);
    if (!proof || !same(value, proof)) fail('PROOF_MISMATCH');
    const result = await run(evidenceSql(copy(value)), false);
    if (!same(result, { ok: true })) fail('PG_FAILED');
  }
  async function applySettlement(value) {
    exact(value, ['phase', 'requestId', 'journal']);
    if (!PHASES.has(value.phase) || (['DISPATCHED', 'SETTLED'].includes(value.phase) ? value.requestId === null : value.requestId !== null)) fail('INVALID');
    if (value.requestId !== null) uuid(value.requestId);
    const read = boundAuthority();
    const trusted = journal(read.readJournal(), installationId);
    if (!same(trusted, fromSnapshot(value.journal, installationId))) fail('PROOF_MISMATCH');
    let dispatch = null, settlement = null;
    const row = trusted.obligations.find(item => item.requestId === value.requestId);
    if (value.phase === 'DISPATCHED') {
      dispatch = read.readDispatch(value.requestId);
      exact(dispatch, ['installationId', 'requestId', 'mainEpoch', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'position']);
      position(dispatch.position); uuid(dispatch.mainEpoch);
      if (!row || row.status !== 'DISPATCHED' || dispatch.installationId !== installationId || dispatch.requestId !== row.requestId
          || ['payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].some(key => dispatch[key] !== row[key])
          || BigInt(dispatch.position.sequence) > BigInt(trusted.position.sequence)) fail('PROOF_MISMATCH');
    }
    if (value.phase === 'SETTLED') {
      if (!row || row.status !== 'SETTLED') fail('PROOF_MISMATCH');
      settlement = read.readSettlement(value.requestId, row.proofSha256);
      exact(settlement, ['installationId', 'requestId', 'payloadSha256', 'proofSha256', 'actualMicroUsd', 'position']);
      position(settlement.position);
      if (settlement.installationId !== installationId || settlement.requestId !== row.requestId
          || ['payloadSha256', 'proofSha256', 'actualMicroUsd'].some(key => settlement[key] !== row[key])
          || BigInt(settlement.position.sequence) > BigInt(trusted.position.sequence)) fail('PROOF_MISMATCH');
    }
    const now = wall();
    if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) fail('INVALID');
    const result = await run(publishSql({ phase: value.phase, requestId: value.requestId, journal: trusted,
      dispatch, settlement, nowMs: String(now), today: new Date(now).toISOString().slice(0, 10) }), false);
    if (!same(result, { ok: true })) fail('PG_FAILED');
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true; active?.terminate('CLOSED');
    closePromise = Promise.all([serial, ...[...children].map(child => child.close())]).then(() => {
      authority = null; delete environment.PGPASSWORD;
      if (terminationFailure) fail('PROCESS_TERMINATION');
    });
    return closePromise;
  }
  if (maintenanceParent) {
    bindAuthority(maintenanceParent.authority);
    return Object.freeze({ seedMaintenanceProjection, readProjection, readback: readProjection, close });
  }
  return Object.freeze({ readCommittedRequest, readProjection, readback: readProjection, commitEvidence, applySettlement,
    readLocalOwner, readEnrollmentState, readCredential, prepareMaintenanceGate, createMaintenanceStage, bindAuthority, close });
}

module.exports = Object.freeze({ createAiEgressPostgres, AiEgressPostgresError, LIMITS,
  validateCostProjection: projection });
