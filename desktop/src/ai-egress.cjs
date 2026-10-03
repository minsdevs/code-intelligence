'use strict';

// Trusted main-process core. No socket, renderer API, environment switch, or real-provider catalog.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_INTEGER = 9223372036854775807n;
const MILLION = 1000000n;
const DAY_MS = 86400000;
const CATALOG_TTL_MS = 30 * DAY_MS;
const PLAN_TTL_MS = 10 * 60 * 1000;
const LIMITS = Object.freeze({ bodyBytes: 1024 * 1024, totalBodyBytes: 64 * 1024 * 1024,
  pending: 64, pendingPerOwner: 32, requests: 10000, concurrent: 2, responseBytes: 2 * 1024 * 1024,
  timeoutMs: 60000, jsonDepth: 32, jsonKeys: 50000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED']);
const ENDPOINTS = Object.freeze({
  'openai.chat': Object.freeze({ provider: 'openai', operation: 'CHAT', origin: 'https://api.openai.com', path: '/v1/chat/completions', auth: 'bearer' }),
  'openai.embed': Object.freeze({ provider: 'openai', operation: 'EMBEDDING', origin: 'https://api.openai.com', path: '/v1/embeddings', auth: 'bearer' }),
  'gemini.chat': Object.freeze({ provider: 'gemini', operation: 'CHAT', origin: 'https://generativelanguage.googleapis.com', suffix: ':generateContent', auth: 'google' }),
  'gemini.embed': Object.freeze({ provider: 'gemini', operation: 'EMBEDDING', origin: 'https://generativelanguage.googleapis.com', suffix: ':embedContent', auth: 'google' }),
});
const CODES = new Set(['INVALID', 'UNSUPPORTED', 'EXPIRED', 'APPROVAL_REQUIRED', 'CHANGED', 'OFF', 'RECOVERY_REQUIRED',
  'BUDGET_EXCEEDED', 'CAPACITY', 'BUSY', 'DUPLICATE', 'USAGE_UNKNOWN', 'TRANSPORT_FAILED', 'PROJECTION_FAILED',
  'SETTLEMENT_FAILED', 'CLOCK_REGRESSION', 'CLOSED', 'DRAIN_TIMEOUT']);
class AiEgressError extends Error {
  constructor(code = 'RECOVERY_REQUIRED') {
    const safe = CODES.has(code) ? code : 'RECOVERY_REQUIRED';
    super(`AI egress: ${safe}`); this.name = 'AiEgressError'; this.code = `AI_EGRESS_${safe}`;
  }
}
function fail(code) { throw new AiEgressError(code); }
function safeError(error, fallback = 'RECOVERY_REQUIRED') {
  return error instanceof AiEgressError ? new AiEgressError(error.code.slice('AI_EGRESS_'.length)) : new AiEgressError(fallback);
}
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function full(value, expression) { return typeof value === 'string' && value.match(expression)?.[0] === value; }
function id(value) { if (!full(value, ID)) fail('INVALID'); return value; }
function hash(value) { if (!full(value, HASH)) fail('INVALID'); return value; }
function uuid(value) { if (!full(value, UUID)) fail('INVALID'); return value; }
function integer(value, positive = false) {
  if (!full(value, /^(0|[1-9][0-9]{0,18})$/) || BigInt(value) > MAX_INTEGER || (positive && value === '0')) fail('INVALID');
  return value;
}
function milliseconds(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail('INVALID');
  return value;
}
function date(value) {
  if (!full(value, /^\d{4}-\d{2}-\d{2}$/) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INVALID');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function same(a, b) { return canonical(a) === canonical(b); }
function ceil(numerator, denominator) { return (numerator + denominator - 1n) / denominator; }
function boundedMoney(value) { if (value < 0n || value > MAX_INTEGER) fail('UNSUPPORTED'); return value.toString(); }

// JSON.parse alone silently accepts duplicate keys. Scan strings/containers before parsing; valid
// JSON still comes from the built-in parser. Do not reserialize the approved wire body.
function parseBody(bytes, maximum = LIMITS.bodyBytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximum) fail('INVALID');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('INVALID'); }
  const stack = []; let keys = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null); if (stack.length > LIMITS.jsonDepth) fail('INVALID');
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++; }
      if (at >= text.length) fail('INVALID');
      let value;
      try { value = JSON.parse(text.slice(start, at + 1)); } catch { fail('INVALID'); }
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('INVALID');
      let next = at + 1; while (/\s/.test(text[next] || 'x')) next++;
      if (text[next] === ':') {
        const object = stack.at(-1);
        if (!object || object.has(value) || ++keys > LIMITS.jsonKeys
            || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('INVALID');
        object.add(value);
      }
    }
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID');
    return freeze(value);
  } catch { fail('INVALID'); }
}

const CONTRACT_FIELDS = ['provider', 'model', 'operation', 'endpointId', 'adapterVersion', 'tokenizerId', 'tokenizerVersion',
  'costContractSha256', 'priceVersion', 'priceSha256', 'verifiedAtEpochMs', 'inputTokenLimit', 'embeddingTokenLimit',
  'outputTokenLimit', 'rates', 'validateBody', 'inputBound', 'readUsage'];
const RATE_FIELDS = ['inputMicroUsdPerMillion', 'cachedInputMicroUsdPerMillion', 'outputMicroUsdPerMillion', 'embeddingMicroUsdPerMillion', 'fixedMicroUsd'];
function contract(value, now) {
  if (!value) fail('UNSUPPORTED');
  try {
    exact(value, CONTRACT_FIELDS);
    const endpoint = ENDPOINTS[value.endpointId];
    if (!endpoint || endpoint.provider !== value.provider || endpoint.operation !== value.operation) fail('UNSUPPORTED');
    for (const name of ['provider', 'model', 'adapterVersion', 'tokenizerId', 'tokenizerVersion', 'priceVersion']) id(value[name]);
    if (value.priceVersion.length > 96) fail('UNSUPPORTED');
    hash(value.costContractSha256); hash(value.priceSha256); milliseconds(value.verifiedAtEpochMs);
    if (value.verifiedAtEpochMs > now || now - value.verifiedAtEpochMs > CATALOG_TTL_MS) fail('UNSUPPORTED');
    for (const name of ['inputTokenLimit', 'embeddingTokenLimit', 'outputTokenLimit']) integer(value[name]);
    for (const name of ['validateBody', 'inputBound', 'readUsage']) if (typeof value[name] !== 'function') fail('UNSUPPORTED');
    exact(value.rates, RATE_FIELDS); for (const valueRate of Object.values(value.rates)) integer(valueRate);
    if (BigInt(value.rates.cachedInputMicroUsdPerMillion) > BigInt(value.rates.inputMicroUsdPerMillion)) fail('UNSUPPORTED');
    const metadata = Object.fromEntries(CONTRACT_FIELDS.filter(name => typeof value[name] !== 'function').map(name => [name, clone(value[name])]));
    return Object.freeze({ ...freeze(metadata), validateBody: value.validateBody, inputBound: value.inputBound,
      readUsage: value.readUsage, fingerprint: sha(canonical(metadata)) });
  } catch { fail('UNSUPPORTED'); }
}
function cost(rates, usage, reserve) {
  const numerator = (BigInt(usage.inputTokens) - BigInt(usage.cachedInputTokens)) * BigInt(rates.inputMicroUsdPerMillion)
    + BigInt(usage.cachedInputTokens) * BigInt(rates.cachedInputMicroUsdPerMillion)
    + BigInt(usage.outputTokens) * BigInt(rates.outputMicroUsdPerMillion)
    + BigInt(usage.embeddingInputTokens) * BigInt(rates.embeddingMicroUsdPerMillion)
    + BigInt(rates.fixedMicroUsd) * MILLION;
  return boundedMoney(reserve ? ceil(numerator * 11n, MILLION * 10n) : ceil(numerator, MILLION));
}
function bound(model, body, outputMax) {
  try {
    if (model.validateBody(body, Object.freeze({ model: model.model, operation: model.operation, outputTokenMax: outputMax })) !== true)
      fail('UNSUPPORTED');
    const result = model.inputBound(body); exact(result, ['inputTokens', 'embeddingInputTokens']);
    integer(result.inputTokens); integer(result.embeddingInputTokens); integer(outputMax);
    if (BigInt(result.inputTokens) > BigInt(model.inputTokenLimit)
        || BigInt(result.embeddingInputTokens) > BigInt(model.embeddingTokenLimit)
        || BigInt(outputMax) > BigInt(model.outputTokenLimit)
        || (model.operation === 'CHAT' && (outputMax === '0' || result.embeddingInputTokens !== '0'))
        || (model.operation === 'EMBEDDING' && (outputMax !== '0' || result.inputTokens !== '0'))) fail('UNSUPPORTED');
    return { ...result, cachedInputTokens: '0', outputTokens: outputMax };
  } catch { fail('UNSUPPORTED'); }
}
function endpointRequest(model, credential, body, requestId) {
  if (typeof credential !== 'string' || !credential.length || credential.length > 4096 || /[\x00-\x20\x7f]/.test(credential))
    fail('RECOVERY_REQUIRED');
  const endpoint = ENDPOINTS[model.endpointId];
  return Object.freeze({ requestId, method: 'POST', origin: endpoint.origin,
    path: endpoint.path || `/v1beta/models/${encodeURIComponent(model.model)}${endpoint.suffix}`,
    headers: Object.freeze({ 'Content-Type': 'application/json', Accept: 'application/json',
      ...(endpoint.auth === 'bearer' ? { Authorization: `Bearer ${credential}` } : { 'x-goog-api-key': credential }) }),
    body, timeoutMs: LIMITS.timeoutMs, maxResponseBytes: LIMITS.responseBytes, redirects: 0, retries: 0 });
}

const PREPARE_FIELDS = ['requestId', 'approvalId', 'planSha256', 'ownerUserId', 'projectId', 'snapshotId', 'settingsRevision',
  'provider', 'model', 'operation', 'policyRevision', 'policySha256', 'budgetDay', 'expiresAt', 'outputTokenCap', 'body'];
function preparedInput(value) {
  exact(value, PREPARE_FIELDS); uuid(value.requestId); uuid(value.approvalId); hash(value.planSha256);
  for (const name of ['ownerUserId', 'projectId', 'snapshotId']) integer(value[name], true);
  integer(value.settingsRevision); integer(value.policyRevision); hash(value.policySha256);
  id(value.provider); id(value.model); date(value.budgetDay); milliseconds(value.expiresAt); integer(value.outputTokenCap);
  if (!['CHAT', 'EMBEDDING'].includes(value.operation) || !Buffer.isBuffer(value.body) || !value.body.length || value.body.length > LIMITS.bodyBytes) fail('INVALID');
  return { ...Object.fromEntries(PREPARE_FIELDS.filter(name => name !== 'body').map(name => [name, value[name]])), body: Buffer.from(value.body) };
}
function metadata(input, model, bounds, installationId, mainEpoch, validUntilEpochMs) {
  const wireBodySha256 = sha(input.body);
  const dispatchBinding = {
    mainEpoch, provider: model.provider, model: model.model, operation: model.operation, endpointId: model.endpointId,
    adapterVersion: model.adapterVersion, tokenizerId: model.tokenizerId, tokenizerVersion: model.tokenizerVersion,
    costContractSha256: model.costContractSha256, priceSha256: model.priceSha256, settingsRevision: input.settingsRevision,
    policyRevision: input.policyRevision, policySha256: input.policySha256, inputTokenUpperBound: bounds.inputTokens,
    outputTokenMax: bounds.outputTokens, embeddingInputTokenUpperBound: bounds.embeddingInputTokens, wireBodyBytes: String(input.body.length),
    validUntilEpochMs: String(validUntilEpochMs),
  };
  const result = { requestId: input.requestId, installationId, ownerUserId: input.ownerUserId, projectId: input.projectId,
    snapshotId: input.snapshotId, approvalId: input.approvalId, planSha256: input.planSha256,
    wireBodySha256, wireBodyBytes: String(input.body.length), budgetDay: input.budgetDay,
    priceVersion: model.priceVersion, reservedMicroUsd: cost(model.rates, bounds, true), dispatchBinding };
  return freeze({ ...result, payloadSha256: sha(canonical(result)) });
}
function reservation(value) {
  return Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].map(key => [key, value[key]]));
}
function journalRow(value) {
  const result = reservation(value);
  uuid(result.requestId); hash(result.payloadSha256); date(result.budgetDay); id(result.priceVersion); integer(result.reservedMicroUsd);
  if (!STATES.has(value.status) || typeof value.conflict !== 'boolean') fail('PROJECTION_FAILED');
  integer(value.liabilityFloorMicroUsd);
  if (value.status === 'SETTLED') { integer(value.actualMicroUsd); hash(value.proofSha256); }
  else if (value.actualMicroUsd !== null || value.proofSha256 !== null) fail('PROJECTION_FAILED');
  return { ...result, status: value.status, actualMicroUsd: value.actualMicroUsd, proofSha256: value.proofSha256,
    liabilityFloorMicroUsd: value.liabilityFloorMicroUsd, conflict: value.conflict };
}
function liability(value) {
  if (value.status === 'SETTLED' && !value.conflict) return BigInt(value.actualMicroUsd);
  return BigInt(value.reservedMicroUsd) > BigInt(value.liabilityFloorMicroUsd)
    ? BigInt(value.reservedMicroUsd) : BigInt(value.liabilityFloorMicroUsd);
}

const GATE_FIELDS = ['installationId', 'ownerUserId', 'policyRevision', 'policySha256', 'dailyLimitMicroUsd',
  'monthlyLimitMicroUsd', 'reconciliationRequired', 'legacyLiabilityUnresolved', 'journalSequence', 'journalHash',
  'journalProjectionSha256', 'clockHighWaterMs'];
const ROW_FIELDS = ['requestId', 'installationId', 'ownerUserId', 'projectId', 'snapshotId', 'approvalId', 'planSha256',
  'payloadSha256', 'wireBodySha256', 'dispatchBinding', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status',
  'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict', 'journalSequence', 'journalHash'];
const EVIDENCE_FIELDS = ['requestId', 'proofSha256', 'mainEpoch', 'receiptType', 'providerRequestId', 'usageDimensions', 'actualMicroUsd'];
const BINDING_FIELDS = ['mainEpoch', 'provider', 'model', 'operation', 'endpointId', 'adapterVersion', 'tokenizerId',
  'tokenizerVersion', 'costContractSha256', 'priceSha256', 'settingsRevision', 'policyRevision', 'policySha256',
  'inputTokenUpperBound', 'outputTokenMax', 'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs'];
function projection(value, installationId) {
  try {
    exact(value, ['version', 'complete', 'gate', 'requests', 'evidence']);
    if (value.version !== 1 || value.complete !== true) fail('PROJECTION_FAILED');
    exact(value.gate, GATE_FIELDS); const gate = value.gate;
    if (gate.installationId !== installationId) fail('PROJECTION_FAILED');
    for (const name of ['ownerUserId', 'policyRevision', 'dailyLimitMicroUsd', 'monthlyLimitMicroUsd', 'journalSequence', 'clockHighWaterMs']) integer(gate[name]);
    integer(gate.ownerUserId, true); hash(gate.policySha256); hash(gate.journalHash); hash(gate.journalProjectionSha256);
    if (typeof gate.reconciliationRequired !== 'boolean' || typeof gate.legacyLiabilityUnresolved !== 'boolean'
        || !Array.isArray(value.requests) || !Array.isArray(value.evidence)
        || value.requests.length > LIMITS.requests || value.evidence.length > LIMITS.requests) fail('PROJECTION_FAILED');
    const seen = new Set(); const proofs = new Set();
    for (const row of value.requests) {
      exact(row, ROW_FIELDS); journalRow(row);
      if (row.installationId !== installationId || seen.has(row.requestId)) fail('PROJECTION_FAILED');
      seen.add(row.requestId); hash(row.planSha256); hash(row.wireBodySha256);
      for (const field of ['ownerUserId', 'projectId', 'snapshotId']) if (row[field] !== null) integer(row[field], true);
      if (row.approvalId !== null) uuid(row.approvalId);
      if (row.dispatchBinding !== null) {
        exact(row.dispatchBinding, BINDING_FIELDS);
        const b = row.dispatchBinding; uuid(b.mainEpoch);
        for (const field of ['provider', 'model', 'operation', 'endpointId', 'adapterVersion', 'tokenizerId', 'tokenizerVersion']) id(b[field]);
        for (const field of ['costContractSha256', 'priceSha256', 'policySha256']) hash(b[field]);
        for (const field of ['settingsRevision', 'policyRevision', 'inputTokenUpperBound', 'outputTokenMax',
          'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs']) integer(b[field]);
      }
      if (row.journalSequence !== null) integer(row.journalSequence);
      if (row.journalHash !== null) hash(row.journalHash);
    }
    for (const item of value.evidence) {
      exact(item, EVIDENCE_FIELDS); uuid(item.requestId); hash(item.proofSha256); uuid(item.mainEpoch); integer(item.actualMicroUsd);
      if (!seen.has(item.requestId) || proofs.has(`${item.requestId}:${item.proofSha256}`)
          || !['USAGE', 'PROVEN_NOT_SENT'].includes(item.receiptType)) fail('PROJECTION_FAILED');
      proofs.add(`${item.requestId}:${item.proofSha256}`);
      if (item.providerRequestId !== null) id(item.providerRequestId);
      exact(item.usageDimensions, ['units']);
      const units = item.usageDimensions.units;
      if (!units || typeof units !== 'object' || Array.isArray(units) || Object.keys(units).length > 7) fail('PROJECTION_FAILED');
      for (const [name, number] of Object.entries(units)) {
        if (!['INPUT_TOKENS', 'OUTPUT_TOKENS', 'EMBEDDING_INPUT_TOKENS', 'CACHED_INPUT_TOKENS',
          'CACHE_WRITE_TOKENS', 'REASONING_TOKENS', 'REQUESTS'].includes(name)) fail('PROJECTION_FAILED');
        integer(number);
      }
    }
    return freeze(clone(value));
  } catch { fail('PROJECTION_FAILED'); }
}
function position(snapshot) {
  return { sequence: String(snapshot.sequence), hash: snapshot.headHash, projectionSha256: snapshot.projectionDigest,
    clockHighWaterMs: String(snapshot.clockHighWaterMs) };
}
function usage(model, bytes) {
  try {
    const value = model.readUsage(parseBody(bytes, LIMITS.responseBytes));
    exact(value, ['inputTokens', 'cachedInputTokens', 'outputTokens', 'embeddingInputTokens']);
    for (const count of Object.values(value)) integer(count);
    if (BigInt(value.cachedInputTokens) > BigInt(value.inputTokens) || (model.operation === 'CHAT' && value.embeddingInputTokens !== '0')
        || (model.operation === 'EMBEDDING' && (value.inputTokens !== '0' || value.outputTokens !== '0'))) fail('USAGE_UNKNOWN');
    return freeze({ ...value });
  } catch { fail('USAGE_UNKNOWN'); }
}

/** All adapters are trusted main-only dependencies, never deserialized options from a channel.
 * openJournal owns enrollment/open selection; it must preserve durable enrollment and key lifecycle.
 * bindAuthority receives a separate private read port. The returned public facade has no proof/key/permit getters.
 */
async function createAiEgress(options) {
  const dependencies = ['openJournal', 'readCommittedRequest', 'readProjection', 'commitEvidence', 'applySettlement',
    'readback', 'credentialProvider', 'contractCatalog', 'transport', 'bindAuthority'];
  if (!options || dependencies.some(name => typeof options[name] !== 'function')) fail('INVALID');
  const { installationId, mainEpoch, runningBuild } = options;
  const recoveryMode = options.recoveryMode ?? false;
  if (typeof recoveryMode !== 'boolean') fail('INVALID');
  if (!full(installationId, /^[A-Za-z0-9_-]{1,128}$/)) fail('INVALID');
  uuid(mainEpoch); integer(runningBuild);
  const wall = options.clock?.wall || Date.now;
  const monotonic = options.clock?.monotonic || (() => Number(process.hrtime.bigint() / 1000000n));
  if (typeof wall !== 'function' || typeof monotonic !== 'function') fail('INVALID');
  const pending = new Map(); const executing = new Map(); const issued = new Set(); const approvals = new Set();
  const observations = new Map(); const dispatched = new Map(); const settlements = new Map(); const tasks = new Set();
  let journal; let blocked = true; let recovery = true; let closed = false; let closing = false; let closePromise;
  let activation = null; let generation = 0; let bytesHeld = 0; let serial = Promise.resolve();
  let maintenance = null;
  let expiryTimer = null;
  let lastWall = 0; let lastMono = 0;
  const serialize = operation => {
    const result = serial.then(operation); serial = result.catch(() => {}); return result;
  };
  function now() {
    const time = milliseconds(wall()); const ticks = monotonic();
    if (!Number.isFinite(ticks) || ticks < 0 || time < lastWall || ticks < lastMono) fail('CLOCK_REGRESSION');
    lastWall = time; lastMono = ticks; return { time, ticks };
  }
  function ready() {
    if (closed || closing) fail('CLOSED');
    const state = journal.snapshot();
    if (blocked || maintenance || recoveryMode || state.aiOff || state.pendingMaintenance || state.legacyLiabilityUnresolved) fail('OFF');
  }
  function release(entry) {
    if (!entry.released) { entry.released = true; bytesHeld -= entry.input.body.length; entry.input.body.fill(0); }
    pending.delete(entry.input.requestId);
  }
  function invalidate() {
    blocked = true; generation++;
    clearTimeout(expiryTimer); expiryTimer = null;
    for (const entry of pending.values()) release(entry);
  }
  function sweep() {
    const clock = now();
    for (const entry of pending.values()) if (clock.time >= entry.until || clock.ticks - entry.createdTicks >= PLAN_TTL_MS) release(entry);
    return clock;
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer); expiryTimer = null;
    if (!pending.size || closed || closing) return;
    const clock = now();
    const delay = Math.max(1, Math.min(...[...pending.values()].map(entry =>
      Math.min(entry.until - clock.time, PLAN_TTL_MS - (clock.ticks - entry.createdTicks)))));
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      try { sweep(); scheduleExpiry(); }
      catch { void serialize(() => stop('CLOCK_REGRESSION')); }
    }, delay);
    expiryTimer.unref();
  }
  function currentContract(entry) {
    const clock = now();
    if (clock.time >= entry.until || clock.ticks - entry.createdTicks >= PLAN_TTL_MS) fail('EXPIRED');
    if (new Date(clock.time).toISOString().slice(0, 10) !== entry.input.budgetDay) fail('EXPIRED');
    const next = contract(options.contractCatalog({ provider: entry.input.provider, model: entry.input.model, operation: entry.input.operation }), clock.time);
    if (next.fingerprint !== entry.model.fingerprint || ['validateBody', 'inputBound', 'readUsage'].some(name => next[name] !== entry.model[name])
        || !same(bound(next, entry.parsed, entry.input.outputTokenCap), entry.bounds)
        || sha(entry.input.body) !== entry.metadata.wireBodySha256) fail('CHANGED');
    return next;
  }
  function matchRequest(row, entry) {
    const expected = entry.metadata;
    for (const field of ['requestId', 'installationId', 'ownerUserId', 'projectId', 'snapshotId', 'approvalId', 'planSha256',
      'payloadSha256', 'wireBodySha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'dispatchBinding'])
      if (!same(row[field], expected[field])) fail('CHANGED');
  }
  function readyGate(gate, entry) {
    const time = now().time;
    if (gate.reconciliationRequired || gate.legacyLiabilityUnresolved) fail('RECOVERY_REQUIRED');
    if (BigInt(gate.clockHighWaterMs) > BigInt(time)) fail('CLOCK_REGRESSION');
    if (entry && (gate.ownerUserId !== entry.input.ownerUserId || gate.policyRevision !== entry.input.policyRevision
        || gate.policySha256 !== entry.input.policySha256)) fail('CHANGED');
    if (gate.dailyLimitMicroUsd === '0' || gate.monthlyLimitMicroUsd === '0') fail('BUDGET_EXCEEDED');
  }
  function compareProjection(pg, snapshot, allowReservations = false) {
    if (snapshot.legacyLiabilityUnresolved && !pg.gate.legacyLiabilityUnresolved) fail('PROJECTION_FAILED');
    const rows = new Map(pg.requests.map(row => [row.requestId, row]));
    for (const row of snapshot.requests) {
      if (!rows.has(row.requestId) || !same(journalRow(row), journalRow(rows.get(row.requestId)))) fail('PROJECTION_FAILED');
      rows.delete(row.requestId);
    }
    for (const row of rows.values()) {
      const entry = pending.get(row.requestId) || executing.get(row.requestId);
      if (!allowReservations || !entry || row.status !== 'RESERVED' || row.conflict
          || row.liabilityFloorMicroUsd !== row.reservedMicroUsd) fail('PROJECTION_FAILED');
      matchRequest(row, entry);
    }
    if (pg.gate.journalSequence !== String(snapshot.sequence) || pg.gate.journalHash !== snapshot.headHash
        || pg.gate.journalProjectionSha256 !== snapshot.projectionDigest) fail('PROJECTION_FAILED');
  }
  function budget(pg, snapshot) {
    const today = new Date(now().time).toISOString().slice(0, 10);
    const union = new Map(pg.requests.map(row => [row.requestId, row]));
    for (const row of snapshot.requests) if (!union.has(row.requestId)) union.set(row.requestId, row);
    let held = 0n; let daily = 0n; let monthly = 0n;
    for (const row of union.values()) {
      if (row.conflict) fail('RECOVERY_REQUIRED');
      const amount = liability(row);
      if (row.status !== 'SETTLED') held += amount;
      else { if (row.budgetDay === today) daily += amount; if (row.budgetDay.slice(0, 7) === today.slice(0, 7)) monthly += amount; }
    }
    if (held + daily > BigInt(pg.gate.dailyLimitMicroUsd) || held + monthly > BigInt(pg.gate.monthlyLimitMicroUsd)) fail('BUDGET_EXCEEDED');
  }
  async function committed(entry, expectedStatus) {
    const data = await options.readCommittedRequest(entry.input.requestId);
    exact(data, ['request', 'settings', 'projection']);
    const pg = projection(data.projection, installationId);
    const row = pg.requests.find(item => item.requestId === entry.input.requestId);
    if (!row || !same(row, data.request)) fail('PROJECTION_FAILED');
    exact(data.settings, ['ownerUserId', 'revision', 'provider', 'model', 'state']);
    if (!same(data.settings, { ownerUserId: entry.input.ownerUserId, revision: entry.input.settingsRevision,
      provider: entry.input.provider, model: entry.input.model, state: 'ACTIVE' })) fail('CHANGED');
    matchRequest(row, entry); currentContract(entry); readyGate(pg.gate, entry);
    if (row.status !== expectedStatus || row.conflict) fail('CHANGED');
    compareProjection(pg, journal.snapshot(), true); budget(pg, journal.snapshot());
    return pg;
  }
  async function publish(phase, requestId = null) {
    const snapshot = journal.snapshot();
    await options.applySettlement(freeze({ phase, requestId, journal: clone(snapshot) }));
    const pg = projection(await options.readback(), installationId);
    compareProjection(pg, snapshot, phase !== 'RECONCILE');
    return pg;
  }
  async function stop(reason = 'PROJECTION_FAILURE') {
    invalidate(); recovery = true;
    try { await journal.latch(reason); } catch { /* Keep the process barrier even if durable I/O fails. */ }
  }
  const callbacks = Object.freeze({
    recoveryMode,
    ...(typeof options.verifyMaintenanceSeal === 'function' ? { verifyMaintenanceSeal: options.verifyMaintenanceSeal } : {}),
    ...(typeof options.verifyMaintenanceCompletion === 'function' ? { verifyMaintenanceCompletion: options.verifyMaintenanceCompletion } : {}),
    verifyCommittedReservation: async value => {
      const entry = executing.get(value.requestId);
      if (!entry || !entry.approved || !same(value, reservation(entry.metadata)) || blocked) fail('APPROVAL_REQUIRED');
      await committed(entry, 'RESERVED');
      return { ...value, committed: true };
    },
    verifySettlement: async value => {
      const observed = observations.get(value.requestId);
      if (!observed || observed.proofSha256 !== value.proofSha256 || observed.actualMicroUsd !== value.actualMicroUsd
          || observed.payloadSha256 !== value.payloadSha256) fail('SETTLEMENT_FAILED');
      const pg = projection(await options.readProjection(), installationId);
      const entry = executing.get(value.requestId);
      const row = pg.requests.find(item => item.requestId === value.requestId);
      if (!entry || !row || !['DISPATCHED', 'UNKNOWN_HELD'].includes(row.status) || row.conflict) fail('SETTLEMENT_FAILED');
      matchRequest(row, entry);
      const proof = pg.evidence.find(item => item.requestId === value.requestId && item.proofSha256 === value.proofSha256);
      const expected = Object.fromEntries(EVIDENCE_FIELDS.map(name => [name, observed[name]]));
      if (!proof || !same(proof, expected)) fail('SETTLEMENT_FAILED');
      return { ...value, verified: true };
    },
    verifyActivation: async (snapshot, acknowledgement) => {
      const consent = activation;
      if (!consent || consent.generation !== generation || closed || closing || maintenance || recoveryMode
          || acknowledgement.projectionDigest !== snapshot.projectionDigest || !blocked) return false;
      const read = await options.readProjection();
      // OFF can arrive while PG is responding. Reject consent normally rather than poisoning an
      // otherwise healthy journal, and never let an older activation overwrite the memory barrier.
      if (activation !== consent || consent.generation !== generation || closed || closing) return false;
      const pg = projection(read, installationId);
      readyGate(pg.gate); compareProjection(pg, snapshot); budget(pg, snapshot);
      return consent.ownerUserId === pg.gate.ownerUserId && consent.policyRevision === pg.gate.policyRevision
        && consent.policySha256 === pg.gate.policySha256;
    },
  });
  try {
    journal = await options.openJournal(callbacks);
    const initial = journal.snapshot();
    if (initial.installationId !== installationId || initial.major !== 1 || BigInt(initial.minimumVersion) > BigInt(runningBuild)) fail('RECOVERY_REQUIRED');
    if (!recoveryMode && (initial.pendingRestore || initial.pendingMaintenance)) fail('RECOVERY_REQUIRED');
    await journal.latch('RESTART_RECONCILIATION');
    options.bindAuthority(Object.freeze({
      // Trusted main adapters may bind staged financial rows to the actual maintenance seal.
      // This getter is deliberately absent from the JOURNAL bridge response and lifecycle facade.
      readMaintenanceSnapshot: () => freeze(clone(journal.snapshot())),
      readDispatch: requestId => freeze(clone(dispatched.get(uuid(requestId)) || null)),
      readEvidence: (requestId, proofSha256) => {
        const value = observations.get(uuid(requestId)); hash(proofSha256);
        return value?.proofSha256 === proofSha256 ? freeze(clone(value)) : null;
      },
      readSettlement: (requestId, proofSha256) => {
        const value = settlements.get(uuid(requestId)); hash(proofSha256);
        return value?.proofSha256 === proofSha256 ? freeze(clone(value)) : null;
      },
      readJournal: () => {
        const snapshot = journal.snapshot();
        return freeze({ installationId, position: position(snapshot), budgetDay: snapshot.budgetDay,
          restorePending: snapshot.pendingRestore !== null || Boolean(snapshot.pendingMaintenance), obligations: snapshot.requests.map(journalRow) });
      },
    }));
  } catch (error) { if (journal) await journal.close().catch(() => {}); throw safeError(error); }

  function diagnostics() {
    const state = journal.snapshot();
    return Object.freeze({ aiOff: blocked || Boolean(maintenance) || recoveryMode || state.aiOff,
      recoveryOnly: recovery || recoveryMode || state.recoveryOnly || Boolean(state.pendingMaintenance) || Boolean(state.legacyLiabilityUnresolved) });
  }
  async function prepare(input) {
    if (closed || closing) fail('CLOSED');
    if (maintenance || recoveryMode || journal.snapshot().pendingMaintenance || journal.snapshot().legacyLiabilityUnresolved) fail('OFF');
    let value; let entry;
    try {
      const clock = sweep(); value = preparedInput(input);
      if (issued.has(value.requestId) || journal.snapshot().requests.some(row => row.requestId === value.requestId)) fail('DUPLICATE');
      if (issued.size >= LIMITS.requests || pending.size + executing.size >= LIMITS.pending
          || [...pending.values(), ...executing.values()].filter(e => e.input.ownerUserId === value.ownerUserId).length >= LIMITS.pendingPerOwner
          || bytesHeld + value.body.length > LIMITS.totalBodyBytes) fail('CAPACITY');
      const model = contract(options.contractCatalog({ provider: value.provider, model: value.model, operation: value.operation }), clock.time);
      if (model.provider !== value.provider || model.model !== value.model || model.operation !== value.operation) fail('UNSUPPORTED');
      const parsed = parseBody(value.body); const bounds = bound(model, parsed, value.outputTokenCap);
      const until = Math.min(value.expiresAt, clock.time + PLAN_TTL_MS, model.verifiedAtEpochMs + CATALOG_TTL_MS);
      if (until <= clock.time || value.budgetDay !== new Date(clock.time).toISOString().slice(0, 10)) fail('EXPIRED');
      entry = { input: value, parsed, model, bounds, until, createdTicks: clock.ticks, approved: false, released: false,
        metadata: metadata(value, model, bounds, installationId, mainEpoch, until) };
      bytesHeld += value.body.length; issued.add(value.requestId); pending.set(value.requestId, entry);
      scheduleExpiry();
      return entry.metadata;
    } catch (error) {
      if (entry) release(entry); else if (value) value.body.fill(0);
      if (error.code === 'AI_EGRESS_CLOCK_REGRESSION') await serialize(() => stop('CLOCK_REGRESSION'));
      throw safeError(error);
    }
  }
  async function approve(input) {
    try {
      ready(); exact(input, ['requestId', 'approvalId', 'payloadSha256']); uuid(input.requestId); uuid(input.approvalId); hash(input.payloadSha256);
      const entry = pending.get(input.requestId);
      if (!entry || entry.approved || approvals.has(input.approvalId)) fail('DUPLICATE');
      if (entry.input.approvalId !== input.approvalId || entry.metadata.payloadSha256 !== input.payloadSha256) fail('CHANGED');
      currentContract(entry); entry.approved = true; approvals.add(input.approvalId);
      return Object.freeze({ requestId: input.requestId, payloadSha256: input.payloadSha256, approved: true });
    } catch (error) {
      const entry = pending.get(input?.requestId); if (entry) release(entry);
      if (error.code === 'AI_EGRESS_CLOCK_REGRESSION') await serialize(() => stop('CLOCK_REGRESSION'));
      throw safeError(error);
    }
  }
  async function perform(entry) {
    let response; let responseBytes; let intent = false; let epoch;
    try {
      await serialize(async () => {
        ready(); currentContract(entry); epoch = generation;
        const credential = await options.credentialProvider(freeze({ ownerUserId: entry.input.ownerUserId,
          provider: entry.input.provider, settingsRevision: entry.input.settingsRevision }));
        ready(); if (epoch !== generation) fail('OFF');
        const request = endpointRequest(entry.model, credential, entry.input.body, entry.input.requestId);
        await committed(entry, 'RESERVED');
        const permit = await journal.reserveAndPermit(reservation(entry.metadata)); intent = true;
        const snapshot = journal.snapshot();
        dispatched.set(entry.input.requestId, freeze({ installationId, mainEpoch, ...reservation(entry.metadata), position: position(snapshot) }));
        await publish('DISPATCHED', entry.input.requestId);
        await committed(entry, 'DISPATCHED');
        await journal.consumePermit(permit);
        ready(); currentContract(entry); if (epoch !== generation) fail('OFF');
        // No await between the final barrier and the sole transport invocation.
        // Attach rejection handling immediately; network settlement happens outside the control queue.
        response = Promise.resolve(options.transport(request)).then(value => ({ value }), error => ({ error }));
      });
      const outcome = await response;
      if (outcome.error) fail('TRANSPORT_FAILED');
      exact(outcome.value, ['statusCode', 'body', 'providerRequestId']);
      if (!Number.isInteger(outcome.value.statusCode) || outcome.value.statusCode < 200 || outcome.value.statusCode > 299
          || !Buffer.isBuffer(outcome.value.body) || !outcome.value.body.length || outcome.value.body.length > LIMITS.responseBytes) fail('USAGE_UNKNOWN');
      if (outcome.value.providerRequestId !== null) id(outcome.value.providerRequestId);
      responseBytes = Buffer.from(outcome.value.body);
      const used = usage(entry.model, responseBytes); const actualMicroUsd = cost(entry.model.rates, used, false);
      const proofSha256 = sha(canonical({ requestId: entry.input.requestId, payloadSha256: entry.metadata.payloadSha256,
        wireBodySha256: entry.metadata.wireBodySha256, mainEpoch, priceSha256: entry.model.priceSha256,
        providerRequestId: outcome.value.providerRequestId, responseSha256: sha(responseBytes), usage: used, actualMicroUsd }));
      const observed = freeze({ installationId, requestId: entry.input.requestId, payloadSha256: entry.metadata.payloadSha256,
        priceVersion: entry.model.priceVersion, proofSha256, mainEpoch, receiptType: 'USAGE', providerRequestId: outcome.value.providerRequestId,
        usageDimensions: { units: { INPUT_TOKENS: used.inputTokens, CACHED_INPUT_TOKENS: used.cachedInputTokens, OUTPUT_TOKENS: used.outputTokens,
          EMBEDDING_INPUT_TOKENS: used.embeddingInputTokens, REQUESTS: '1' } }, actualMicroUsd });
      await serialize(async () => {
        observations.set(entry.input.requestId, observed);
        await options.commitEvidence(freeze(clone(observed)));
        await journal.settle({ requestId: entry.input.requestId, payloadSha256: entry.metadata.payloadSha256, actualMicroUsd, proofSha256 });
        settlements.set(entry.input.requestId, freeze({ installationId, requestId: entry.input.requestId,
          payloadSha256: entry.metadata.payloadSha256, actualMicroUsd, proofSha256, position: position(journal.snapshot()) }));
        const pg = await publish('SETTLED', entry.input.requestId);
        if (journal.snapshot().aiOff || pg.gate.reconciliationRequired) { invalidate(); recovery = true; }
      });
      // Accounting has completed before answer bytes leave main. Caller persistence failure cannot undo it.
      const result = { requestId: entry.input.requestId, payloadSha256: entry.metadata.payloadSha256,
        statusCode: outcome.value.statusCode, body: responseBytes, actualMicroUsd, proofSha256 };
      responseBytes = null; return Object.freeze(result);
    } catch (error) {
      await serialize(async () => {
        if (intent) try { await journal.holdUnknown(entry.input.requestId, 'UNKNOWN_USAGE'); } catch { /* Durable state remains authoritative. */ }
        await stop(error.code === 'AI_EGRESS_CLOCK_REGRESSION' ? 'CLOCK_REGRESSION' : 'PROJECTION_FAILURE');
      });
      throw safeError(error, intent ? 'SETTLEMENT_FAILED' : 'RECOVERY_REQUIRED');
    } finally { responseBytes?.fill(0); release(entry); executing.delete(entry.input.requestId); }
  }
  async function execute(input) {
    ready(); exact(input, ['requestId', 'payloadSha256']); uuid(input.requestId); hash(input.payloadSha256);
    const entry = pending.get(input.requestId);
    if (!entry || entry.metadata.payloadSha256 !== input.payloadSha256) fail('DUPLICATE');
    if (!entry.approved) fail('APPROVAL_REQUIRED');
    if (executing.size >= LIMITS.concurrent) fail('BUSY');
    pending.delete(input.requestId); executing.set(input.requestId, entry);
    const task = perform(entry); tasks.add(task);
    try { return await task; } finally { tasks.delete(task); }
  }
  async function latch() {
    invalidate();
    return serialize(async () => {
      if (closed) fail('CLOSED');
      try { await journal.latch('USER_OFF'); await publish('LATCH'); recovery = true; return diagnostics(); }
      catch (error) { recovery = true; throw safeError(error, 'PROJECTION_FAILED'); }
    });
  }
  // Lifecycle and the fixed USER_OFF operation must work without a running DB or initialized gate.
  // The private channel cannot accept a caller-selected reason or publication mode.
  async function latchOffline(reason = 'USER_OFF') {
    if (!['USER_OFF', 'RESTART_RECONCILIATION', 'RESTORE'].includes(reason)) fail('INVALID');
    invalidate(); recovery = true;
    return serialize(async () => {
      if (closed) fail('CLOSED');
      try { await journal.latch(reason); return diagnostics(); }
      catch (error) { throw safeError(error); }
    });
  }
  async function reconcile(input) {
    if (maintenance || recoveryMode || journal.snapshot().pendingMaintenance) fail('OFF');
    exact(input, ['restoreId']); uuid(input.restoreId); invalidate();
    return serialize(async () => {
      if (closed || closing) fail('CLOSED');
      if (executing.size) fail('BUSY');
      try {
        await journal.latch('RESTART_RECONCILIATION');
        const pg = projection(await options.readProjection(), installationId); const snapshot = journal.snapshot();
        if (pg.gate.legacyLiabilityUnresolved || BigInt(pg.gate.clockHighWaterMs) > BigInt(now().time)) fail('RECOVERY_REQUIRED');
        // A larger PG floor is carried as a larger conservative hold. A same-UUID discrepancy
        // becomes a journal conflict; no invented settlement proof or empty fallback is used.
        const obligations = pg.requests.map(row => ({ ...reservation(row), reservedMicroUsd:
          (liability(row) > BigInt(row.reservedMicroUsd) ? liability(row) : BigInt(row.reservedMicroUsd)).toString(),
          status: row.status, actualMicroUsd: row.actualMicroUsd, proofSha256: row.proofSha256 }));
        await journal.mergeRestore({ restoreId: input.restoreId, obligations,
          budgetDay: [snapshot.budgetDay, new Date(now().time).toISOString().slice(0, 10)].sort().at(-1), minimumVersion: snapshot.minimumVersion });
        const read = await publish('RECONCILE');
        recovery = read.gate.reconciliationRequired || read.gate.legacyLiabilityUnresolved || journal.snapshot().recoveryOnly;
        return diagnostics();
      } catch (error) { await stop(); throw safeError(error, 'PROJECTION_FAILED'); }
    });
  }
  async function activate(input) {
    if (maintenance || recoveryMode || journal.snapshot().pendingMaintenance || journal.snapshot().legacyLiabilityUnresolved) fail('OFF');
    exact(input, ['ownerUserId', 'policyRevision', 'policySha256', 'userApproved']);
    integer(input.ownerUserId, true); integer(input.policyRevision); hash(input.policySha256);
    if (input.userApproved !== true) fail('APPROVAL_REQUIRED');
    // Capture before queueing: a later OFF invalidates even activation work which has not started.
    const epoch = generation;
    const superseded = () => epoch !== generation || closed || closing || maintenance || recoveryMode;
    return serialize(async () => {
      if (superseded()) fail('OFF'); if (executing.size) fail('BUSY');
      if (!blocked) fail('CHANGED');
      try {
        activation = freeze({ ...clone(input), generation: epoch });
        await journal.activate({ projectionDigest: journal.snapshot().projectionDigest, userApproved: true });
        if (superseded()) fail('OFF');
        const pg = await publish('ACTIVATED');
        if (superseded()) fail('OFF');
        readyGate(pg.gate); budget(pg, journal.snapshot());
        blocked = false; recovery = false; return diagnostics();
      } catch (error) {
        const canceled = superseded();
        await stop(canceled ? 'USER_OFF' : 'PROJECTION_FAILURE');
        throw canceled ? new AiEgressError('OFF') : safeError(error);
      }
      finally { activation = null; }
    });
  }
  function beginMaintenance(input) {
    try {
      exact(input, ['transactionId', 'kind']); uuid(input.transactionId);
      if (!['BACKUP', 'RESTORE'].includes(input.kind)) fail('INVALID');
      if (closed || closing) fail('CLOSED');
      if (maintenance) fail('BUSY');
      const pendingMaintenance = journal.snapshot().pendingMaintenance;
      if (pendingMaintenance && (pendingMaintenance.transactionId !== input.transactionId || pendingMaintenance.kind !== input.kind)) fail('CHANGED');
    } catch (error) { return Promise.reject(safeError(error)); }
    const lease = { ...input, drained: false };
    // This barrier is synchronous, before writing OFF or waiting for a queued PG read.
    // Old activation work and old prepared requests cannot cross it.
    maintenance = lease; invalidate(); recovery = true;
    const started = serialize(async () => {
      if (closed || closing) fail('CLOSED');
      await journal.latch('RESTORE');
    });
    const requireLease = (drained = true) => {
      if (closed || closing) fail('CLOSED');
      if (maintenance !== lease || (drained && !lease.drained)) fail('BUSY');
      if (tasks.size || executing.size) { if (drained) fail('BUSY'); }
    };
    const run = operation => serialize(async () => {
      requireLease();
      try { return await operation(); }
      catch (error) { recovery = true; throw safeError(error, 'PROJECTION_FAILED'); }
    });
    const handle = Object.freeze({
      async waitForDrain(value) {
        exact(value, ['timeoutMs']);
        if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 120000) fail('INVALID');
        requireLease(false);
        let timer;
        try {
          await Promise.race([
            (async () => {
              await started;
              // EXECUTE owns these promises through transport, evidence, settlement, catch and
              // final buffer cleanup. Socket closure and the journal active-request set do not.
              await Promise.allSettled([...tasks]);
              await serial;
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new AiEgressError('DRAIN_TIMEOUT')), value.timeoutMs); }),
          ]);
          requireLease(false);
          if (tasks.size || executing.size) fail('BUSY');
          lease.drained = true;
        } finally { clearTimeout(timer); }
      },
      readProjection() { return run(async () => projection(await options.readProjection(), installationId)); },
      mergeAndCommit(value) {
        let captured;
        try {
          exact(value, ['mergeInput']); const merge = value.mergeInput;
          exact(merge, ['restoreId', 'obligations', 'budgetDay', 'minimumVersion']);
          uuid(merge.restoreId); date(merge.budgetDay); integer(merge.minimumVersion);
          if (!Array.isArray(merge.obligations) || merge.obligations.length > LIMITS.requests) fail('INVALID');
          for (const row of merge.obligations) {
            exact(row, ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256']);
            uuid(row.requestId); hash(row.payloadSha256); date(row.budgetDay); id(row.priceVersion); integer(row.reservedMicroUsd);
            if (!STATES.has(row.status)) fail('INVALID');
            if (row.status === 'SETTLED') { integer(row.actualMicroUsd); hash(row.proofSha256); }
            else if (row.actualMicroUsd !== null || row.proofSha256 !== null) fail('INVALID');
          }
          captured = freeze(clone(merge));
        } catch (error) { return Promise.reject(safeError(error)); }
        return run(async () => {
          // mergeRestore alone is B's monotonic import, not the product restore receipt.
          // Its persisted input digest rejects an altered resume after a partial append.
          await journal.mergeRestore(captured);
          return publish('RECONCILE');
        });
      },
      refreshProjection() { return run(() => publish('RECONCILE')); },
      release() {
        return run(async () => {
          const snapshot = journal.snapshot();
          if (snapshot.pendingRestore || snapshot.pendingMaintenance || snapshot.recoveryOnly
              || snapshot.maintenanceReceipt?.transactionId !== lease.transactionId
              || snapshot.maintenanceReceipt.kind !== lease.kind) fail('RECOVERY_REQUIRED');
          // A completion receipt advances the journal head. Omitting the final PG publication
          // must fail here even when the same request count/liability was already committed.
          compareProjection(projection(await options.readback(), installationId), snapshot);
          maintenance = null; invalidate(); recovery = true;
          return diagnostics();
        });
      },
    });
    return started.then(() => handle, error => { throw safeError(error); });
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true; invalidate();
    closePromise = (async () => {
      let failure;
      try { await serialize(() => journal.latch('USER_OFF')); } catch (error) { failure = error; }
      // A poisoned/fsync-failed journal may reject a fresh latch. Still drain actual execution
      // and close its descriptor/lock before the lifecycle is allowed to close the keyring.
      await Promise.allSettled([...tasks]); await serial;
      try { await journal.close(); } catch (error) { failure ||= error; }
      closed = true;
      if (failure) throw failure;
    })().catch(error => { recovery = true; throw safeError(error); });
    return closePromise;
  }
  return Object.freeze({ prepare, approve, execute, activate, reconcile, latch, latchOffline, beginMaintenance, diagnostics, close });
}

module.exports = Object.freeze({ createAiEgress, AiEgressError, LIMITS, CATALOG_TTL_MS, PLAN_TTL_MS });
