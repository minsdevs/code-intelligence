'use strict';

const path = require('node:path');
const { requireThat } = require('./errors.cjs');
const { parseJson, stableJson, LIMITS } = require('./json.cjs');
const { sha256, checkedAbsolute, relativePath } = require('./safe-io.cjs');
const { VERSION, CELLS, THRESHOLDS } = require('./policy.cjs');

// Deliberately limited to the JSON Schema keywords used by our checked-in contract.
// No external references, downloads, expression evaluation, or schema-supplied code.
function validateSchema(value, schema, root) {
  if (schema.$ref) {
    requireThat(/^#\/\$defs\/[A-Za-z]+$/.test(schema.$ref), 'SCHEMA_REFERENCE_UNSUPPORTED');
    return validateSchema(value, root.$defs[schema.$ref.split('/').pop()], root);
  }
  requireThat(schema != null, 'SCHEMA_REFERENCE_UNSUPPORTED');
  if (Object.hasOwn(schema, 'const')) requireThat(stableJson(value) === stableJson(schema.const), 'SCHEMA_VIOLATION');
  if (schema.enum) requireThat(schema.enum.some(item => stableJson(item) === stableJson(value)), 'SCHEMA_VIOLATION');
  if (schema.type) {
    const matches = type => type === 'null' ? value === null
      : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value)
      : typeof value === type;
    requireThat([schema.type].flat().some(matches), 'SCHEMA_VIOLATION');
  }
  if (value === null) return;
  if (typeof value === 'string') {
    requireThat((schema.minLength == null || value.length >= schema.minLength)
      && (schema.maxLength == null || value.length <= schema.maxLength)
      && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value)), 'SCHEMA_VIOLATION');
  }
  if (typeof value === 'number') requireThat(Number.isFinite(value)
    && (schema.minimum == null || value >= schema.minimum) && (schema.maximum == null || value <= schema.maximum), 'SCHEMA_VIOLATION');
  if (Array.isArray(value)) {
    requireThat(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? LIMITS.arrayItems), 'SCHEMA_VIOLATION');
    value.forEach(item => validateSchema(item, schema.items, root));
  } else if (typeof value === 'object') {
    for (const key of schema.required ?? []) requireThat(Object.hasOwn(value, key), 'SCHEMA_VIOLATION');
    for (const key of Object.keys(value)) {
      requireThat(Object.hasOwn(schema.properties ?? {}, key), 'UNKNOWN_FIELD');
      validateSchema(value[key], schema.properties[key], root);
    }
  }
}

function validator(io) {
  const schema = io.json(path.join(__dirname, '../schemas/contracts.schema.json'));
  return (kind, value) => {
    if (Object.hasOwn(schema.$defs[kind].properties, 'contractVersion')) {
      requireThat(value != null && value.contractVersion === VERSION, 'CONTRACT_UNSUPPORTED');
    }
    validateSchema(value, schema.$defs[kind], schema);
    return value;
  };
}

function unique(items, key, code = 'DUPLICATE_ID') {
  const keys = new Set();
  for (const item of items) { const identity = key(item); requireThat(!keys.has(identity), code); keys.add(identity); }
}
const sourceDigest = sources => sha256(Buffer.from(stableJson([...sources].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
const matchKey = item => stableJson([item.cellId, item.kind, item.relationKind, item.source.namespace,
  item.source.path, item.source.start, item.source.end]);
const outcomeKey = item => stableJson([item.path, item.cellId, item.owner]);
const patternKey = item => stableJson([item.cellId, item.patternId, item.stratum]);

function checkSpan(span, sources) {
  const source = sources.get(span.path);
  requireThat(source != null && span.sha256 === source.meta.sha256, 'SOURCE_HASH_MISMATCH');
  requireThat(span.namespace === source.meta.namespace, 'NAMESPACE_MISMATCH');
  requireThat(span.start <= span.end && span.end <= source.bytes.length, 'SPAN_OUT_OF_BOUNDS');
  for (const offset of [span.start, span.end]) {
    requireThat(offset === source.bytes.length || (source.bytes[offset] & 0xc0) !== 0x80, 'SPAN_UTF8_BOUNDARY');
  }
}

function checkFactShape(item, isGold = false) {
  const expected = isGold ? item.expected : item;
  unique(expected.targets, value => value, 'DUPLICATE_TARGET');
  unique(expected.diagnostics, value => value, 'DUPLICATE_DIAGNOSTIC');
  requireThat(expected.targets.length <= 5, 'CANDIDATE_LIMIT');
  if (item.kind === 'PARSER') {
    requireThat(item.relationKind === 'PARSE' && typeof expected.valid === 'boolean'
      && expected.targets.length === 0 && expected.resolution === 'NOT_APPLICABLE'
      && expected.reasonCode === null, 'CONTRADICTORY_FACT_STATE');
    if (isGold && !expected.valid) requireThat(expected.diagnostics.length > 0, 'MISSING_DIAGNOSTIC_ORACLE');
  } else {
    requireThat(item.source.start < item.source.end, 'EMPTY_EVIDENCE_SPAN');
    requireThat(item.relationKind !== 'PARSE' && expected.valid === null && expected.diagnostics.length === 0,
      'CONTRADICTORY_FACT_STATE');
    requireThat(expected.resolution !== 'NOT_APPLICABLE', 'CONTRADICTORY_FACT_STATE');
    if (item.kind === 'FACT') requireThat(expected.targets.length <= 1 && expected.resolution !== 'INFERRED', 'CONTRADICTORY_FACT_STATE');
    if (['UNRESOLVED', 'UNSUPPORTED'].includes(expected.resolution)) {
      requireThat(expected.targets.length === 0 && expected.reasonCode != null, 'CONTRADICTORY_FACT_STATE');
    } else {
      requireThat(expected.targets.length > 0, 'EVIDENCE_MISSING');
      requireThat(expected.reasonCode === null, 'CONTRADICTORY_FACT_STATE');
    }
  }
  if (isGold) {
    requireThat(item.polarity === 'POSITIVE' || item.mustNotEmitResolved, 'NEGATIVE_NOT_GUARDED');
    requireThat(item.kind !== 'CANDIDATES' || item.mustNotEmitResolved, 'CANDIDATE_PROMOTION_UNGUARDED');
    requireThat(!['UNRESOLVED', 'UNSUPPORTED', 'INFERRED'].includes(expected.resolution) || item.mustNotEmitResolved,
      'ORACLE_ABSTENTION_UNGUARDED');
    requireThat(!(item.mustNotEmitResolved && expected.resolution === 'STATIC_RESOLVED'), 'CONTRADICTORY_FACT_STATE');
  }
}

function checkVersions(actual, requirements) {
  unique(actual, item => item.name, 'DUPLICATE_VERSION');
  for (const requirement of requirements) {
    const value = actual.find(item => item.name === requirement.name)?.version;
    requireThat(value != null && (value === requirement.prefix || value.startsWith(requirement.prefix + '.')), 'FIXTURE_VERSION_MISMATCH');
  }
}

function loadContracts(io, options) {
  const validate = validator(io);
  const corpusPath = checkedAbsolute(options.corpus), capabilitiesPath = checkedAbsolute(options.capabilities);
  io.protect(path.dirname(corpusPath)); io.protect(path.dirname(capabilitiesPath));
  const corpusBytes = io.read(corpusPath), capabilitiesBytes = io.read(capabilitiesPath);
  const corpus = validate('corpus', parseJson(corpusBytes));
  const capabilities = validate('capabilities', parseJson(capabilitiesBytes));
  unique(capabilities.cells, item => item.cellId);
  requireThat(stableJson(capabilities.cells) === stableJson(CELLS)
    && stableJson(capabilities.thresholds) === stableJson(THRESHOLDS), 'PUBLIC_CELL_POLICY_MISMATCH');
  unique(capabilities.toolInventory, item => item.producer);
  unique(capabilities.policyReferences, item => item.document);
  unique(corpus.fixtures, item => item.path);
  const cells = new Map(capabilities.cells.map(item => [item.cellId, item]));
  const fixtures = [], caseIds = new Set(), fixtureIds = new Set(), splits = new Map();
  let totalCases = 0;
  function readReference(root, reference, kind) {
    const bytes = io.read(io.resolve(root, reference.path));
    requireThat(sha256(bytes) === reference.sha256, 'INPUT_HASH_MISMATCH');
    return validate(kind, parseJson(bytes));
  }
  function assertSplit(key, split) {
    requireThat(!splits.has(key) || splits.get(key) === split, 'CROSS_SPLIT_LEAK'); splits.set(key, split);
  }
  for (const reference of corpus.fixtures) {
    const fixture = readReference(path.dirname(corpusPath), reference, 'fixture');
    requireThat(fixture.corpusId === corpus.corpusId, 'CORPUS_ID_MISMATCH');
    requireThat(!fixtureIds.has(fixture.fixtureId), 'DUPLICATE_ID'); fixtureIds.add(fixture.fixtureId);
    const root = path.dirname(io.resolve(path.dirname(corpusPath), reference.path)); io.protect(root);
    if (corpus.purpose === 'SYNTHETIC_SELF_TEST') requireThat(fixture.origin.kind === 'SYNTHETIC'
      && fixture.split === 'DEVELOPMENT', 'SELF_TEST_SCOPE_MISMATCH');
    // A development baseline measures implementation-side material only; it can never hold evaluation splits.
    if (corpus.purpose === 'DEVELOPMENT_BASELINE') requireThat(fixture.split === 'DEVELOPMENT', 'BASELINE_SCOPE_MISMATCH');
    if (fixture.origin.kind === 'PUBLIC_REPOSITORY') requireThat(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fixture.origin.commit ?? ''), 'ORIGIN_NOT_PINNED');
    unique(fixture.source, item => item.path); unique(fixture.capabilities, item => item);
    unique(fixture.patterns, patternKey); unique(fixture.eligibility, outcomeKey);
    checkVersions(fixture.versions, []);
    for (const cellId of fixture.capabilities) {
      requireThat(cells.has(cellId), 'UNKNOWN_CELL'); checkVersions(fixture.versions, cells.get(cellId).versions);
    }
    const sources = new Map();
    for (const meta of fixture.source) {
      relativePath(meta.path);
      const bytes = io.read(io.resolve(root, meta.path), LIMITS.sourceBytes);
      requireThat(bytes.length === meta.bytes && sha256(bytes) === meta.sha256, 'SOURCE_HASH_MISMATCH');
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { requireThat(false, 'INVALID_UTF8'); }
      sources.set(meta.path, { meta, bytes });
    }
    assertSplit('project:' + fixture.origin.projectId, fixture.split);
    assertSplit('scenario:' + fixture.scenarioFamilyId, fixture.split);
    assertSplit('generator:' + fixture.generatorFamilyId, fixture.split);
    assertSplit('source:' + sourceDigest(fixture.source), fixture.split);
    for (const meta of fixture.source) assertSplit('file-content:' + meta.sha256, fixture.split);
    // Also detect byte-identical copies with renamed paths or aliased project IDs.
    assertSplit('content:' + sha256(Buffer.from(stableJson(fixture.source.map(item => item.sha256).sort()))), fixture.split);
    for (const pattern of fixture.patterns) {
      const cell = cells.get(pattern.cellId);
      requireThat(fixture.capabilities.includes(pattern.cellId) && cell.patterns.includes(pattern.patternId), 'UNKNOWN_PATTERN');
      const stratum = cell.strata.find(item => item.stratumId === pattern.stratum);
      requireThat(cell.strata.length ? stratum != null : pattern.stratum === null, 'UNKNOWN_STRATUM');
      if (stratum) checkVersions(fixture.versions, stratum.versions);
    }
    for (const eligibility of fixture.eligibility) {
      requireThat(sources.has(eligibility.path) && fixture.capabilities.includes(eligibility.cellId), 'COVERAGE_PARTITION_MISMATCH');
      requireThat(eligibility.eligible ? eligibility.exclusionReason === null : eligibility.exclusionReason !== null,
        'COVERAGE_PARTITION_MISMATCH');
    }
    // Each file/capability has exactly one owner; exclusion never removes it from the roster.
    unique(fixture.eligibility, item => stableJson([item.path, item.cellId]), 'DUPLICATE_COVERAGE_OWNER');
    requireThat(fixture.eligibility.length === fixture.source.length * fixture.capabilities.length, 'COVERAGE_PARTITION_MISMATCH');
    const gold = readReference(root, fixture.gold, 'cases'), negatives = readReference(root, fixture.negatives, 'cases');
    const review = readReference(root, fixture.review, 'review');
    requireThat([gold, negatives, review].every(item => item.fixtureId === fixture.fixtureId), 'FIXTURE_ID_MISMATCH');
    requireThat(review.goldSha256 === fixture.gold.sha256 && review.negativesSha256 === fixture.negatives.sha256, 'REVIEW_HASH_MISMATCH');
    unique(review.reviews, item => item.reviewerId, 'DUPLICATE_REVIEWER');
    for (const decision of review.reviews) requireThat(decision.goldSha256 === fixture.gold.sha256
      && decision.negativesSha256 === fixture.negatives.sha256, 'REVIEW_HASH_MISMATCH');
    const independent = review.reviews.filter(item => item.kind === 'HUMAN' && item.reviewerId !== review.author.id
      && item.independentFromAuthor && item.independentFromImplementers);
    let reviewReady = independent.length >= 2 && independent.every(item => item.decision === 'APPROVE');
    if (review.status === 'ADJUDICATED') {
      const adjudicator = review.adjudicator;
      requireThat(adjudicator != null && adjudicator.kind === 'HUMAN' && adjudicator.reviewerId !== review.author.id
        && !review.reviews.some(item => item.reviewerId === adjudicator.reviewerId)
        && adjudicator.goldSha256 === fixture.gold.sha256 && adjudicator.negativesSha256 === fixture.negatives.sha256,
      'CONTRADICTORY_REVIEW_STATE');
      reviewReady = independent.length >= 2;
    } else requireThat(review.adjudicator === null, 'CONTRADICTORY_REVIEW_STATE');
    if (review.status !== 'AUTHOR_PROVISIONAL') requireThat(reviewReady, 'CONTRADICTORY_REVIEW_STATE');
    else reviewReady = false;
    requireThat(gold.cases.every(item => item.polarity === 'POSITIVE')
      && negatives.cases.every(item => item.polarity !== 'POSITIVE'), 'CASE_POLARITY_MISMATCH');
    const cases = [...gold.cases, ...negatives.cases];
    requireThat(cases.length > 0, 'EMPTY_ORACLE');
    totalCases += cases.length; requireThat(totalCases <= LIMITS.cases, 'CASE_COUNT_LIMIT');
    unique(cases, matchKey, 'DUPLICATE_CASE_LOCATION');
    unique(cases.filter(item => item.kind === 'PARSER'), item => stableJson([item.cellId, item.source.path]), 'DUPLICATE_PARSER_FILE');
    for (const item of cases) {
      requireThat(!caseIds.has(item.caseId), 'DUPLICATE_ID'); caseIds.add(item.caseId);
      requireThat(fixture.patterns.some(pattern => patternKey(pattern) === patternKey(item)), 'UNDECLARED_PATTERN');
      requireThat(fixture.eligibility.some(outcome => outcome.path === item.source.path && outcome.cellId === item.cellId
        && outcome.eligible), 'CASE_OUTSIDE_ELIGIBLE_SCOPE');
      checkSpan(item.source, sources); checkFactShape(item, true);
      if (item.kind === 'PARSER') requireThat(item.source.start === 0 && item.source.end === sources.get(item.source.path).bytes.length,
        'PARSER_FILE_SCOPE_REQUIRED');
      requireThat((cells.get(item.cellId).capability === 'P') === (item.kind === 'PARSER'), 'CASE_CAPABILITY_MISMATCH');
    }
    fixtures.push({ manifest: fixture, sources, cases, review, reviewReady, sourceDigest: sourceDigest(fixture.source) });
  }
  const loaded = { corpus, capabilities, cells, fixtures, totalCases,
    corpusSha256: sha256(corpusBytes), capabilityManifestSha256: sha256(capabilitiesBytes), observations: null };
  if (!options.observations) return loaded;
  let observationInput;
  try { observationInput = io.json(options.observations); }
  catch (error) { if (error.code === 'INPUT_MISSING') { loaded.observationMissing = true; return loaded; } throw error; }
  const observations = validate('observations', observationInput);
  requireThat((corpus.purpose === 'SYNTHETIC_SELF_TEST') === (observations.provenance.kind === 'SYNTHETIC_SELF_TEST'),
    'OBSERVATION_SCOPE_MISMATCH');
  // Only a product capture may claim an external attestation, and that claim needs the attestation input.
  requireThat(observations.provenance.captureAttestation === 'UNVERIFIED'
    || observations.provenance.kind === 'PRODUCT_CAPTURE', 'OBSERVATION_SCOPE_MISMATCH');
  requireThat((observations.provenance.captureAttestation === 'EXTERNAL_ATTESTATION') === Boolean(options.executionAttestation),
    options.executionAttestation ? 'ATTESTATION_UNEXPECTED' : 'ATTESTATION_MISSING');
  requireThat(observations.corpusSha256 === loaded.corpusSha256
    && observations.capabilityManifestSha256 === loaded.capabilityManifestSha256, 'OBSERVATION_BINDING_MISMATCH');
  if (options.productBuildSha256) requireThat(options.productBuildSha256 === observations.provenance.productBuildSha256, 'BUILD_DIGEST_MISMATCH');
  unique(observations.runs, item => item.fixtureId);
  requireThat(observations.runs.length === fixtures.length, 'OBSERVATION_INCOMPLETE');
  const observationIds = new Set();
  for (const run of observations.runs) {
    const fixture = fixtures.find(item => item.manifest.fixtureId === run.fixtureId);
    requireThat(fixture != null && run.sourceDigest === fixture.sourceDigest, 'OBSERVATION_BINDING_MISMATCH');
    requireThat(stableJson(run.versions) === stableJson(fixture.manifest.versions), 'FIXTURE_VERSION_MISMATCH');
    requireThat(run.executionState === 'COMPLETED' ? run.reasonCode === null : run.reasonCode !== null, 'CONTRADICTORY_EXECUTION_STATE');
    unique(run.outcomes, outcomeKey, 'DUPLICATE_OUTCOME');
    requireThat(run.outcomes.length === fixture.manifest.eligibility.length, 'COVERAGE_PARTITION_MISMATCH');
    for (const outcome of run.outcomes) {
      const eligibility = fixture.manifest.eligibility.find(item => outcomeKey(item) === outcomeKey(outcome));
      requireThat(eligibility != null && eligibility.eligible === (outcome.status !== 'EXCLUDED'), 'COVERAGE_PARTITION_MISMATCH');
      requireThat(outcome.bytesRead <= fixture.sources.get(outcome.path).meta.bytes, 'COVERAGE_BYTES_MISMATCH');
      if (!eligibility.eligible) requireThat(outcome.reasonCode === eligibility.exclusionReason && outcome.bytesRead === 0, 'COVERAGE_PARTITION_MISMATCH');
      if (['PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED', 'PENDING'].includes(outcome.status)) requireThat(outcome.reasonCode != null, 'COVERAGE_REASON_MISSING');
      if (outcome.status === 'SUCCESS') requireThat(outcome.reasonCode === null, 'CONTRADICTORY_OUTCOME_STATE');
    }
    const locationStates = new Map();
    for (const fact of run.facts) {
      requireThat(!observationIds.has(fact.observationId), 'DUPLICATE_ID'); observationIds.add(fact.observationId);
      requireThat(fixture.manifest.capabilities.includes(fact.cellId), 'UNKNOWN_CELL');
      checkSpan(fact.source, fixture.sources); checkFactShape(fact);
      requireThat(fixture.manifest.eligibility.some(item => item.eligible && item.path === fact.source.path && item.cellId === fact.cellId),
        'FACT_OUTSIDE_ELIGIBLE_SCOPE');
      const outcome = run.outcomes.find(item => item.path === fact.source.path && item.cellId === fact.cellId);
      requireThat(outcome.status !== 'UNSUPPORTED' || fact.resolution === 'UNSUPPORTED', 'CONTRADICTORY_OUTCOME_STATE');
      if (fact.kind === 'FACT') {
        const location = matchKey(fact);
        requireThat(!locationStates.has(location) || locationStates.get(location) === fact.resolution, 'CONTRADICTORY_LOCATION_STATE');
        locationStates.set(location, fact.resolution);
      }
    }
  }
  loaded.observations = observations; return loaded;
}

module.exports = { loadContracts, validateSchema, validator, matchKey, outcomeKey, sourceDigest, checkSpan, checkFactShape };
