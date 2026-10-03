'use strict';
const crypto = require('node:crypto');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('./backup-export-policy.cjs');
const { validateCostProjection } = require('./ai-egress-postgres.cjs');
const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const OBLIGATION = ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status',
  'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict'];
const BINDING_NUMBERS = ['settingsRevision', 'policyRevision', 'inputTokenUpperBound', 'outputTokenMax',
  'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs'];
const MAX = 9223372036854775807n;
function fail() { throw new Error('Backup cost state cannot be verified.'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function number(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) fail();
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > MAX) fail(); return text;
}
function camel(value) { return value.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function unbox(value) { return value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'json') ? value.json : value; }
function translate(values) {
  const value = {};
  for (const [key, item] of Object.entries(values)) if (!['created_at', 'updated_at'].includes(key)) value[camel(key)] = unbox(item);
  return value;
}
function createBackupCostCollector(installationId) {
  let gate = null, bytes = 0, legacy = false, closed = false; const requests = [], evidence = [];
  return Object.freeze({
    add(row) {
      if (closed) fail();
      try { if (canonical(POLICY.projectRow(row?.table, row?.values)) !== canonical(row)) fail(); } catch { fail(); }
      if (row.table === 'ai_usage_logs') { legacy = true; return; }
      if (!['ai_budget_gate', 'ai_request_ledger', 'ai_usage_evidence'].includes(row.table)) return;
      bytes += Buffer.byteLength(canonical(row)); if (bytes > 64 * 1024 * 1024) fail();
      const value = translate(row.values);
      if (row.table === 'ai_budget_gate') { if (gate) fail(); gate = value; }
      else if (row.table === 'ai_request_ledger') {
        if (value.dispatchBinding && !Object.keys(value.dispatchBinding).length) value.dispatchBinding = null;
        if (value.dispatchBinding) {
          value.dispatchBinding = { ...value.dispatchBinding };
          for (const field of BINDING_NUMBERS) value.dispatchBinding[field] = number(value.dispatchBinding[field]);
        }
        requests.push(value); if (requests.length > 10000) fail();
      } else {
        if (!value.usageDimensions?.units) fail(); value.usageDimensions = { ...value.usageDimensions,
          units: Object.fromEntries(Object.entries(value.usageDimensions.units).map(([key, count]) => [key, number(count)])) };
        evidence.push(value); if (evidence.length > 10000) fail();
      }
    },
    finish() {
      if (closed) fail(); closed = true;
      if (!gate) { if (requests.length || evidence.length) fail(); return { projection: null, legacyLiabilityUnresolved: legacy }; }
      requests.sort((a, b) => a.requestId.localeCompare(b.requestId));
      evidence.sort((a, b) => `${a.requestId}:${a.proofSha256}`.localeCompare(`${b.requestId}:${b.proofSha256}`));
      const projection = validateCostProjection({ version: 1, complete: true, gate, requests, evidence }, installationId);
      return { projection, legacyLiabilityUnresolved: legacy || gate.legacyLiabilityUnresolved };
    },
  });
}
function liability(row) {
  if (row.status === 'SETTLED' && !row.conflict) return BigInt(row.actualMicroUsd);
  return [row.reservedMicroUsd, row.liabilityFloorMicroUsd, row.actualMicroUsd || '0'].map(BigInt).reduce((a, b) => a > b ? a : b);
}
function mergeId(transactionId, part) {
  if (typeof transactionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(transactionId)) fail();
  const h = sha(`CI_BACKUP_MERGE_1\n${transactionId}\n${part}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function buildMaintenanceMergeInputs({ transactionId, liveProjection, archivedProjection, snapshot, budgetDay, minimumVersion }) {
  number(minimumVersion);
  if (!snapshot?.installationId || typeof budgetDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(budgetDay)
      || new Date(`${budgetDay}T00:00:00Z`).toISOString().slice(0, 10) !== budgetDay) fail();
  const projections = [validateCostProjection(liveProjection, snapshot.installationId),
    ...(archivedProjection ? [validateCostProjection(archivedProjection, snapshot.installationId)] : [])];
  const highestDay = [budgetDay, snapshot.budgetDay, ...projections.flatMap(p => p.requests.map(r => r.budgetDay))].sort().at(-1);
  const minVersion = (BigInt(minimumVersion) > BigInt(number(snapshot.minimumVersion)) ? minimumVersion : snapshot.minimumVersion);
  return projections.map((p, index) => {
    const maxima = new Map();
    for (const e of p.evidence) maxima.set(e.requestId, [maxima.get(e.requestId) || 0n, BigInt(e.actualMicroUsd)].reduce((a, b) => a > b ? a : b));
    return { restoreId: mergeId(transactionId, index === 0 ? 'live' : 'archive'), budgetDay: highestDay,
      minimumVersion: minVersion, obligations: p.requests.map(row => ({ ...Object.fromEntries(OBLIGATION.slice(0, 8).map(key => [key, row[key]])),
        reservedMicroUsd: [BigInt(row.reservedMicroUsd), liability(row), maxima.get(row.requestId) || 0n].reduce((a, b) => a > b ? a : b).toString(),
      })).sort((a, b) => a.requestId.localeCompare(b.requestId)) };
  });
}
function maintenanceProjectionDigest(projection) {
  const p = validateCostProjection(projection, projection?.gate?.installationId);
  // Journal position and the derived admission flag change when the maintenance receipt is
  // published. The durable financial state must keep the same digest across that transition.
  // Pending maintenance still requires the flag independently in the verifier below.
  const { journalSequence, journalHash, journalProjectionSha256, clockHighWaterMs,
    reconciliationRequired, ...gate } = p.gate;
  return sha(canonical({ gate, requests: p.requests.map(row => Object.fromEntries(OBLIGATION.map(key => [key, row[key]])))
    .sort((a, b) => a.requestId.localeCompare(b.requestId)), evidence: p.evidence }));
}
function createMaintenanceVerifier({ installationId, readProjection }) {
  if (typeof readProjection !== 'function') fail();
  return async (snapshot, metadata) => {
    const fields = ['transactionId', 'kind', 'payloadSha256', 'pgProjectionDigest',
      'legacyLiabilityUnresolved', 'budgetDay', 'minimumVersion'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))
        || Object.keys(metadata).length !== fields.length || fields.some(key => !Object.hasOwn(metadata, key))
        || typeof metadata.transactionId !== 'string'
        || metadata.transactionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0] !== metadata.transactionId
        || !['BACKUP', 'RESTORE'].includes(metadata.kind) || typeof metadata.legacyLiabilityUnresolved !== 'boolean'
        || ['payloadSha256', 'pgProjectionDigest'].some(key => typeof metadata[key] !== 'string'
          || metadata[key].match(/^[0-9a-f]{64}$/)?.[0] !== metadata[key])
        || typeof metadata.budgetDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(metadata.budgetDay)
        || !Number.isFinite(Date.parse(`${metadata.budgetDay}T00:00:00Z`))
        || new Date(`${metadata.budgetDay}T00:00:00Z`).toISOString().slice(0, 10) !== metadata.budgetDay
        || typeof metadata.minimumVersion !== 'string') fail();
    number(metadata.minimumVersion);
    if (!snapshot || snapshot.installationId !== installationId || snapshot.aiOff !== true || snapshot.pendingRestore
        || !Number.isSafeInteger(snapshot.sequence) || !Number.isSafeInteger(snapshot.clockHighWaterMs)) fail();
    const p = validateCostProjection(await readProjection(), installationId);
    if (p.gate.journalSequence !== String(snapshot.sequence) || p.gate.journalHash !== snapshot.headHash
        || p.gate.journalProjectionSha256 !== snapshot.projectionDigest
        || BigInt(p.gate.clockHighWaterMs) < BigInt(snapshot.clockHighWaterMs)
        || metadata.pgProjectionDigest !== maintenanceProjectionDigest(p)
        || metadata.legacyLiabilityUnresolved !== p.gate.legacyLiabilityUnresolved
        || (snapshot.pendingMaintenance && !p.gate.reconciliationRequired)
        || (snapshot.legacyLiabilityUnresolved && !p.gate.legacyLiabilityUnresolved)) fail();
    const rows = value => value.map(row => Object.fromEntries(OBLIGATION.map(key => [key, row[key]])))
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
    if (canonical(rows(snapshot.requests)) !== canonical(rows(p.requests))) fail();
    return { ...metadata, verified: true };
  };
}
module.exports = Object.freeze({ createBackupCostCollector, buildMaintenanceMergeInputs,
  maintenanceProjectionDigest, createMaintenanceVerifier });
