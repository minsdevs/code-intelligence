'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIMITS } = require('../lib/json.cjs');
const { sha256 } = require('../lib/safe-io.cjs');
const { sandbox, read, write, digest, rebind, editFixture, editObservations, run, cell } = require('./helpers.cjs');

function fails(result, code) {
  assert.equal(result.status, 1); assert.equal(result.summary.result, 'FAIL'); assert.equal(result.stderr, '');
  if (code) assert.equal(result.summary.code, code);
  if (result.report) assert.equal(result.report.releaseGate.result, 'BLOCKED');
}

test('explicit contract-only pass writes six bounded artifacts and preserves inputs', t => {
  const env = sandbox(t), original = digest(env.corpus), result = run(env, { mode: 'contract' });
  assert.equal(result.status, 0); assert.equal(result.summary.scope, 'CONTRACT_ONLY');
  assert.equal(result.report.productEvaluation, 'NOT_RUN'); assert.equal(result.report.observationEvaluation, 'NOT_RUN');
  assert.equal(result.report.releaseGate.result, 'BLOCKED'); assert.equal(result.report.cells.length, 18);
  assert.ok(result.report.cells.every(item => item.publicSupported === false && item.result === 'NOT_RUN' && item.metrics === null));
  assert.equal(digest(env.corpus), original);
  assert.deepEqual(fs.readdirSync(result.output).sort(), ['artifact-manifest.json', 'coverage-partition.json',
    'evidence-check.json', 'junit.xml', 'report.json', 'resource-samples.csv'].sort());
  const manifest = read(path.join(result.output, 'artifact-manifest.json'));
  assert.equal(manifest.outputs.length, 5); assert.equal(manifest.selfHash, null);
  for (const output of manifest.outputs) {
    assert.equal(digest(path.join(result.output, output.name)), output.sha256);
    assert.equal(fs.statSync(path.join(result.output, output.name)).size, output.bytes);
  }
  assert.ok(manifest.inputs.length > 10 && manifest.inputs.every(item => Object.keys(item).sort().join(',') === 'bytes,sha256'));
  assert.match(fs.readFileSync(path.join(result.output, 'resource-samples.csv'), 'utf8'), /CONTRACT_ONLY,NOT_RUN,,,\n$/);
  assert.match(fs.readFileSync(path.join(result.output, 'junit.xml'), 'utf8'), /productEvaluation" value="NOT_RUN/);
});

test('missing observations and build remain blocked with actual exit 2', t => {
  const result = run(sandbox(t), { observations: false, build: false });
  assert.equal(result.status, 2); assert.equal(result.report.productEvaluation, 'BLOCKED');
  assert.equal(result.report.observationEvaluation, 'NOT_RUN');
  assert.ok(result.report.blockerCodes.includes('OBSERVATIONS_MISSING'));
  assert.ok(result.report.blockerCodes.includes('PRODUCT_BUILD_MISSING'));
});

test('a named but absent observation bundle remains blocked, not a pass', t => {
  const env = sandbox(t), result = run(env, { observations: path.join(env.inputs, 'absent.json') });
  assert.equal(result.status, 2); assert.ok(result.report.blockerCodes.includes('OBSERVATIONS_MISSING'));
});

test('authored good observations measure four cells but never prove a build or public support', t => {
  const result = run(sandbox(t));
  assert.equal(result.status, 2); assert.equal(result.report.observationEvaluation, 'PASS');
  assert.equal(result.report.buildBinding.comparison, 'MATCH');
  assert.equal(result.report.buildBinding.artifactVerification, 'NOT_RUN');
  assert.equal(result.report.buildBinding.productExecutionVerification, 'NOT_RUN');
  assert.equal(result.report.observationProvenance, 'SYNTHETIC_SELF_TEST');
  assert.equal(result.report.planned300AnnotationPilot.independentlyReviewedAnnotations, 0);
  assert.equal(result.report.cells.filter(item => item.result === 'BLOCKED').length, 4);
  assert.equal(result.report.cells.filter(item => item.result === 'NOT_RUN').length, 14);
  assert.ok(result.report.cells.every(item => item.publicSupported === false && item.samples.evaluationPositive === 0));
  const calls = cell(result.report, 'J-C');
  assert.equal(calls.counts.tp, 1); assert.equal(calls.counts.fp, 0); assert.equal(calls.metrics.candidateExactSetAccuracy, 1);
  assert.equal(calls.metrics.overallGoldRecall, null);
  assert.equal(calls.metrics.overallGoldRecallStatus, 'NOT_MEASURED');
  assert.equal(calls.metrics.overallGoldRecallReason, 'UNSUPPORTED_POSITIVE_ORACLE_MISSING');
  assert.ok(calls.blockerCodes.includes('INSUFFICIENT_EVALUATION_CORPUS'));
  assert.ok(calls.blockerCodes.includes('INDEPENDENT_ORACLE_REVIEW_MISSING'));
  const http = cell(result.report, 'X-HTTP'); assert.equal(http.strata.length, 4);
  assert.ok(http.strata.every(item => item.result === 'NOT_RUN' && item.metrics === null));
  const coverage = read(path.join(result.output, 'coverage-partition.json'));
  assert.equal(coverage.measurement, 'SYNTHETIC_SELF_TEST'); assert.equal(coverage.partitions.length, 4);
  for (const partition of coverage.partitions) {
    assert.equal(partition.total, Object.values(partition.counts).reduce((a, b) => a + b, 0));
    assert.equal(partition.total, partition.eligible + partition.excluded);
  }
});

test('checked-in known-bad false-resolved observation really exits 1', t => {
  const env = sandbox(t), result = run(env, { observations: path.join(env.inputs, 'selftest/known-bad-observations.json') });
  fails(result); assert.equal(cell(result.report, 'J-C').counts.falseResolved, 1);
  assert.ok(cell(result.report, 'J-C').failureCodes.includes('FALSE_RESOLVED'));
});

for (const suffix of ['direct', 'dynamic']) test('duplicate ' + suffix + ' fact counts FP, including an empty abstention', t => {
  const env = sandbox(t);
  editObservations(env, observations => {
    const run = observations.runs[0], duplicate = structuredClone(run.facts.find(fact => fact.observationId.endsWith('.' + suffix)));
    duplicate.observationId = 'duplicate.' + suffix; run.facts.push(duplicate);
  });
  const result = run(env); fails(result);
  const calls = cell(result.report, 'J-C'); assert.equal(calls.counts.duplicates, 1); assert.equal(calls.counts.fp, 1);
  assert.equal(calls.metrics.precision, 0.5);
});

test('zero emitted facts has null precision and zero recall, not vacuous success', t => {
  const env = sandbox(t); editObservations(env, observations => observations.runs.forEach(run => { run.facts = []; }));
  const result = run(env); fails(result);
  assert.equal(cell(result.report, 'J-C').metrics.precision, null);
  assert.equal(cell(result.report, 'J-C').metrics.recall, 0);
  assert.equal(cell(result.report, 'J-C').metrics.candidateRecallAt5, 0);
  assert.equal(cell(result.report, 'J-C').metrics.candidateExactSetAccuracy, 0);
});

test('one missing invalid-file diagnostic fails even with a tiny sample', t => {
  const env = sandbox(t); editObservations(env, observations => { observations.runs[0].facts.find(fact => fact.valid === false).diagnostics = []; });
  const result = run(env); fails(result);
  assert.equal(cell(result.report, 'J-P').counts.invalidFiles, 1);
  assert.ok(cell(result.report, 'J-P').failureCodes.includes('INVALID_DIAGNOSTIC_MISSING'));
});

test('one missing candidate changes recall and exact-set accuracy separately', t => {
  const env = sandbox(t); editObservations(env, observations => observations.runs[0].facts.find(fact => fact.kind === 'CANDIDATES').targets.pop());
  const result = run(env); fails(result); const metrics = cell(result.report, 'J-C').metrics;
  assert.equal(metrics.candidatePrecision, 1); assert.equal(metrics.candidateRecallAt5, 0.5); assert.equal(metrics.candidateExactSetAccuracy, 0);
});

test('unmatched evidence enters a blocking annotation-review queue', t => {
  const env = sandbox(t); editObservations(env, observations => {
    const fact = structuredClone(observations.runs[0].facts.find(fact => fact.observationId.endsWith('.direct')));
    fact.observationId = 'unmatched'; fact.source.start++; observations.runs[0].facts.push(fact);
  });
  const result = run(env); fails(result);
  assert.equal(cell(result.report, 'J-C').counts.unmatched, 1);
  assert.equal(result.report.annotationReviewQueue.length, 1);
  assert.match(result.report.annotationReviewQueue[0].observationRef, /^[a-f0-9]{64}$/);
  assert.ok(cell(result.report, 'J-C').failureCodes.includes('ANNOTATION_REVIEW_REQUIRED'));
});

const observationMutations = [
  ['unknown field', value => { value.secret = 'SECRET_NOT_FOR_REPORT'; }, 'UNKNOWN_FIELD'],
  ['unsupported major', value => { value.contractVersion = '2.0.0'; }, 'CONTRACT_UNSUPPORTED'],
  ['duplicate observation ID', value => { value.runs[0].facts[1].observationId = value.runs[0].facts[0].observationId; }, 'DUPLICATE_ID'],
  ['duplicate run', value => { value.runs[1] = structuredClone(value.runs[0]); }, 'DUPLICATE_ID'],
  ['missing run', value => { value.runs.pop(); }, 'OBSERVATION_INCOMPLETE'],
  ['wrong corpus binding', value => { value.corpusSha256 = '0'.repeat(64); }, 'OBSERVATION_BINDING_MISMATCH'],
  ['wrong source binding', value => { value.runs[0].sourceDigest = '0'.repeat(64); }, 'OBSERVATION_BINDING_MISMATCH'],
  ['missing outcome', value => { value.runs[0].outcomes.pop(); }, 'COVERAGE_PARTITION_MISMATCH'],
  ['duplicate outcome', value => { value.runs[0].outcomes[1] = structuredClone(value.runs[0].outcomes[0]); }, 'DUPLICATE_OUTCOME'],
  ['excluded source marked success', value => { value.runs[0].outcomes.find(item => item.status === 'EXCLUDED').status = 'SUCCESS'; }, 'COVERAGE_PARTITION_MISMATCH'],
  ['bytes beyond source', value => { value.runs[0].outcomes[0].bytesRead = 999999; }, 'COVERAGE_BYTES_MISMATCH'],
  ['missing evidence', value => { delete value.runs[0].facts[1].source; }, 'SCHEMA_VIOLATION'],
  ['source hash mismatch', value => { value.runs[0].facts[1].source.sha256 = '0'.repeat(64); }, 'SOURCE_HASH_MISMATCH'],
  ['namespace mismatch', value => { value.runs[0].facts[1].source.namespace = 'another-scope'; }, 'NAMESPACE_MISMATCH'],
  ['span outside bytes', value => { value.runs[0].facts[1].source.end = 999999; }, 'SPAN_OUT_OF_BOUNDS'],
  ['empty evidence span', value => { const source = value.runs[0].facts[1].source; source.end = source.start; }, 'EMPTY_EVIDENCE_SPAN'],
  ['unsafe integer', value => { value.runs[0].facts[1].source.start = Number.MAX_SAFE_INTEGER + 1; }, 'SCHEMA_VIOLATION'],
  ['candidate k over five', value => { value.runs[0].facts.find(fact => fact.kind === 'CANDIDATES').targets = ['a', 'b', 'c', 'd', 'e', 'f']; }, 'CANDIDATE_LIMIT'],
  ['duplicate target', value => { value.runs[0].facts[1].targets.push(value.runs[0].facts[1].targets[0]); }, 'DUPLICATE_TARGET'],
  ['resolved without target', value => { value.runs[0].facts[1].targets = []; }, 'EVIDENCE_MISSING'],
  ['resolved with abstention reason', value => { value.runs[0].facts[1].reasonCode = 'UNSUPPORTED'; }, 'CONTRADICTORY_FACT_STATE'],
  ['successful outcome with failure reason', value => { value.runs[0].outcomes[0].reasonCode = 'FAILED'; }, 'CONTRADICTORY_OUTCOME_STATE'],
  ['unsupported outcome emitting resolved facts', value => { const outcome = value.runs[0].outcomes[1]; outcome.status = 'UNSUPPORTED'; outcome.reasonCode = 'UNSUPPORTED'; }, 'CONTRADICTORY_OUTCOME_STATE'],
  ['contradictory execution', value => { value.runs[0].executionState = 'FAILED'; }, 'CONTRADICTORY_EXECUTION_STATE'],
  ['wrong observed language version', value => { value.runs[1].versions[0].version = '4.9.0'; }, 'FIXTURE_VERSION_MISMATCH'],
  ['product capture relabeling synthetic scope', value => { value.provenance.kind = 'PRODUCT_CAPTURE'; }, 'OBSERVATION_SCOPE_MISMATCH'],
];
for (const [name, mutate, code] of observationMutations) test('strict observations reject ' + name, t => {
  const env = sandbox(t); editObservations(env, mutate); const result = run(env); fails(result, code);
  assert.equal(result.report.contractResult, 'FAIL'); assert.equal(result.report.observationEvaluation, 'NOT_RUN');
  for (const file of fs.readdirSync(result.output)) assert.ok(!fs.readFileSync(path.join(result.output, file), 'utf8').includes('SECRET_NOT_FOR_REPORT'));
});

test('UTF-8 evidence offsets cannot split an accented character, including CRLF source', t => {
  const env = sandbox(t), bytes = fs.readFileSync(path.join(env.inputs, 'fixtures/typescript-calls/source/calls.ts'));
  assert.ok(bytes.includes('\r\n')); const offset = bytes.indexOf(Buffer.from('é'));
  editObservations(env, value => { value.runs[1].facts[1].source.start = offset + 1; });
  fails(run(env), 'SPAN_UTF8_BOUNDARY');
});

test('observation parse errors never echo malformed secret text', t => {
  const env = sandbox(t); fs.writeFileSync(env.observations, '{"secret":"SENTINEL_DO_NOT_COPY",');
  const result = run(env); fails(result, 'MALFORMED_JSON');
  assert.ok(!result.stdout.includes('SENTINEL_DO_NOT_COPY'));
  for (const file of fs.readdirSync(result.output)) assert.ok(!fs.readFileSync(path.join(result.output, file), 'utf8').includes('SENTINEL_DO_NOT_COPY'));
});

test('duplicate escaped JSON keys cannot replace earlier observations', t => {
  const env = sandbox(t); fs.writeFileSync(env.observations, '{"runs":[],"r\\u0075ns":[]}');
  fails(run(env), 'DUPLICATE_JSON_KEY');
});

test('oversized observation is rejected before JSON parsing', t => {
  const env = sandbox(t); fs.writeFileSync(env.observations, Buffer.alloc(LIMITS.jsonBytes + 1, 32));
  fails(run(env), 'INPUT_TOO_LARGE');
});

for (const [name, digestValue, code] of [['mismatch', '0'.repeat(64), 'BUILD_DIGEST_MISMATCH'], ['malformed', 'not-a-digest', 'BUILD_DIGEST_INVALID']]) {
  test('caller build digest ' + name + ' is a hard failure', t => {
    const result = run(sandbox(t), { build: digestValue }); fails(result, code);
    if (result.report) assert.equal(result.report.buildBinding.comparison, 'MISMATCH');
  });
}

test('omitting build still scores supplied bad observations as failure', t => {
  const env = sandbox(t), result = run(env, { build: false, observations: path.join(env.inputs, 'selftest/known-bad-observations.json') });
  fails(result); assert.ok(result.report.blockerCodes.includes('PRODUCT_BUILD_MISSING'));
});

const fixtureMutations = [
  ['declared version outside cell', ({ fixture }) => { fixture.versions[0].version = '17'; }, 'FIXTURE_VERSION_MISMATCH'],
  ['duplicate coverage owner', ({ fixture }) => { fixture.eligibility[1] = { ...fixture.eligibility[0], owner: 'another-owner' }; }, 'DUPLICATE_COVERAGE_OWNER'],
  ['unsafe source traversal', ({ fixture }) => { fixture.source[0].path = '../outside.java'; }, 'UNSAFE_PATH'],
  ['absolute source path', ({ fixture }) => { fixture.source[0].path = '/tmp/source.java'; }, 'UNSAFE_PATH'],
  ['unknown manifest command', ({ fixture }) => { fixture.command = 'never-execute'; }, 'UNKNOWN_FIELD'],
  ['fabricated independent review', ({ review }) => { review.status = 'INDEPENDENT_REVIEWED'; }, 'CONTRADICTORY_REVIEW_STATE'],
  ['duplicate gold location', ({ gold }) => { gold.cases.push({ ...gold.cases[1], caseId: 'other-case' }); }, 'DUPLICATE_CASE_LOCATION'],
];
for (const [name, mutate, code] of fixtureMutations) test('fixture contract rejects ' + name, t => {
  const env = sandbox(t); editFixture(env, 'java-calls', mutate); fails(run(env), code);
});

test('cross-split family leakage fails even with distinct source languages', t => {
  const env = sandbox(t), corpus = read(env.corpus); corpus.purpose = 'PRODUCT_EVALUATION'; write(env.corpus, corpus);
  editFixture(env, 'typescript-calls', ({ fixture }) => { fixture.split = 'HOLDOUT'; });
  fails(run(env), 'CROSS_SPLIT_LEAK');
});

test('a shared single source file leaks across splits despite renamed projects and families', t => {
  const env = sandbox(t), corpus = read(env.corpus); corpus.purpose = 'PRODUCT_EVALUATION'; write(env.corpus, corpus);
  const javaPath = path.join(env.inputs, 'fixtures/java-calls/source/Calls.java');
  editFixture(env, 'typescript-calls', ({ fixture, root }) => {
    fixture.split = 'HOLDOUT'; fixture.origin.projectId = 'other'; fixture.scenarioFamilyId = 'other'; fixture.generatorFamilyId = 'other';
    const bytes = fs.readFileSync(javaPath); fs.writeFileSync(path.join(root, 'source/copied.java'), bytes);
    fixture.source.push({ path: 'source/copied.java', sha256: sha256(bytes), bytes: bytes.length, namespace: 'copied' });
  });
  fails(run(env), 'CROSS_SPLIT_LEAK');
});

for (const [name, mutate, code] of [
  ['support promotion', value => { value.cells[0].publicSupported = true; }, 'SCHEMA_VIOLATION'],
  ['lower precision threshold', value => { value.thresholds.resolvedPrecision = 0.5; }, 'SCHEMA_VIOLATION'],
  ['missing public cell', value => { value.cells.pop(); }, 'SCHEMA_VIOLATION'],
  ['renamed cell', value => { value.cells[0].cellId = 'RENAMED'; }, 'PUBLIC_CELL_POLICY_MISMATCH'],
]) test('fixed capability policy rejects ' + name, t => {
  const env = sandbox(t), value = read(env.capabilities); mutate(value); write(env.capabilities, value); rebind(env);
  fails(run(env), code);
});

test('source bytes changed after authoring fail their pinned hash', t => {
  const env = sandbox(t); fs.appendFileSync(path.join(env.inputs, 'fixtures/java-calls/source/Calls.java'), '// changed\n');
  fails(run(env), 'SOURCE_HASH_MISMATCH');
});

for (const type of ['symlink', 'hardlink', 'directory']) test('source ' + type + ' is rejected without reading a special input', t => {
  const env = sandbox(t), file = path.join(env.inputs, 'fixtures/java-calls/source/Calls.java');
  const other = path.join(env.temp, 'other.java'); fs.renameSync(file, other);
  if (type === 'symlink') fs.symlinkSync(other, file);
  else if (type === 'hardlink') fs.linkSync(other, file);
  else fs.mkdirSync(file);
  fails(run(env), type === 'symlink' ? 'SYMLINK_REJECTED' : 'SPECIAL_FILE_REJECTED');
});

test('existing output is never clobbered', t => {
  const env = sandbox(t), output = path.join(env.temp, 'existing'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'sentinel'), 'retain'); const result = run(env, { output });
  fails(result, 'OUTPUT_EXISTS'); assert.equal(result.report, null);
  assert.deepEqual(fs.readdirSync(output), ['sentinel']); assert.equal(fs.readFileSync(path.join(output, 'sentinel'), 'utf8'), 'retain');
});

test('new output inside input tree is rejected', t => {
  const env = sandbox(t), output = path.join(env.inputs, 'new-output'), result = run(env, { output });
  fails(result, 'OUTPUT_OVERLAPS_INPUT'); assert.equal(fs.existsSync(output), false);
});

test('output through a symlink ancestor is rejected', t => {
  const env = sandbox(t), link = path.join(env.temp, 'alias'); fs.symlinkSync(env.inputs, link);
  fails(run(env, { output: path.join(link, 'out') }), 'SYMLINK_REJECTED');
  assert.equal(fs.existsSync(path.join(env.inputs, 'out')), false);
});

test('contract mode cannot conceal supplied product observations', t => {
  const env = sandbox(t), result = run(env, { mode: 'contract', extra: ['--observations', env.observations] });
  fails(result, 'MODE_OPTION_CONFLICT'); assert.equal(result.report, null);
});

test('missing corpus still protects its intended input directory from output creation', t => {
  const env = sandbox(t); env.corpus = path.join(env.inputs, 'missing-corpus.json');
  const output = path.join(env.inputs, 'new-output'); fails(run(env, { output }), 'OUTPUT_OVERLAPS_INPUT');
  assert.equal(fs.existsSync(output), false);
});

for (const missing of [true, false]) test((missing ? 'missing' : 'malformed') + ' observations reserve their separate parent before validation', t => {
  const env = sandbox(t), observationRoot = path.join(env.temp, 'other-inputs'); fs.mkdirSync(observationRoot);
  const observations = path.join(observationRoot, 'observations.json');
  if (!missing) fs.writeFileSync(observations, '{ malformed');
  const output = path.join(observationRoot, 'new-output');
  fails(run(env, { observations, output }), 'OUTPUT_OVERLAPS_INPUT'); assert.equal(fs.existsSync(output), false);
});

test('resolved and unresolved claims for the same fact location are contradictory', t => {
  const env = sandbox(t); editObservations(env, value => {
    const fact = structuredClone(value.runs[0].facts[1]); fact.observationId = 'contradictory.abstention';
    fact.resolution = 'UNRESOLVED'; fact.targets = []; fact.reasonCode = 'DYNAMIC_TARGET'; value.runs[0].facts.push(fact);
  });
  fails(run(env), 'CONTRADICTORY_LOCATION_STATE');
});

function addCorrectDevelopmentFacts(env) {
  editFixture(env, 'java-calls', ({ gold }) => {
    const base = gold.cases.find(item => item.caseId.endsWith('.direct'));
    for (let index = 0; index < 99; index++) gold.cases.push({ ...structuredClone(base), caseId: 'java-extra-' + index,
      source: { ...base.source, start: index, end: index + 1 } });
  });
  editObservations(env, value => {
    const base = value.runs[0].facts.find(item => item.observationId.endsWith('.direct'));
    for (let index = 0; index < 99; index++) value.runs[0].facts.push({ ...structuredClone(base), observationId: 'java-extra-' + index,
      source: { ...base.source, start: index, end: index + 1 } });
  });
}

test('100 correct development facts cannot mask a wrong holdout fact in the actual CLI', t => {
  const env = sandbox(t), originalRoot = path.join(env.inputs, 'fixtures/java-calls');
  const root = path.join(env.inputs, 'fixtures/java-holdout'); fs.cpSync(originalRoot, root, { recursive: true });
  const file = path.join(root, 'fixture.json'), fixture = read(file), gold = read(path.join(root, 'gold.json'));
  const negatives = read(path.join(root, 'negatives.json')), review = read(path.join(root, 'review.json'));
  const holdout = structuredClone(read(env.observations).runs[0]);
  fixture.fixtureId = 'java-holdout'; fixture.origin.projectId = 'holdout-project'; fixture.scenarioFamilyId = 'holdout-scenario';
  fixture.generatorFamilyId = 'holdout-family'; fixture.split = 'HOLDOUT';
  fixture.capabilities = ['J-C']; fixture.patterns = fixture.patterns.filter(item => item.patternId === 'direct-source-call');
  fixture.eligibility = fixture.eligibility.filter(item => item.cellId === 'J-C');
  gold.cases = gold.cases.filter(item => item.caseId.endsWith('.direct')); negatives.cases = [];
  holdout.facts = holdout.facts.filter(item => item.observationId.endsWith('.direct'));
  holdout.outcomes = holdout.outcomes.filter(item => item.cellId === 'J-C');
  for (const meta of fixture.source) {
    const sourceFile = path.join(root, meta.path); fs.appendFileSync(sourceFile, '// distinct synthetic holdout bytes\n');
    meta.sha256 = digest(sourceFile); meta.bytes = fs.statSync(sourceFile).size; meta.namespace = 'holdout-namespace';
  }
  const bindSpan = item => {
    const meta = fixture.source.find(meta => meta.path === item.source.path);
    item.source.sha256 = meta.sha256; item.source.namespace = meta.namespace;
    if (item.kind === 'PARSER') item.source.end = meta.bytes;
  };
  for (const bundle of [gold, negatives]) {
    bundle.fixtureId = fixture.fixtureId;
    for (const item of bundle.cases) { item.caseId = item.caseId.replace('java-calls', 'java-holdout'); bindSpan(item); }
  }
  write(path.join(root, 'gold.json'), gold); write(path.join(root, 'negatives.json'), negatives);
  fixture.gold.sha256 = digest(path.join(root, 'gold.json')); fixture.negatives.sha256 = digest(path.join(root, 'negatives.json'));
  review.fixtureId = fixture.fixtureId; review.goldSha256 = fixture.gold.sha256; review.negativesSha256 = fixture.negatives.sha256;
  write(path.join(root, 'review.json'), review); fixture.review.sha256 = digest(path.join(root, 'review.json')); write(file, fixture);
  const corpus = read(env.corpus); corpus.purpose = 'PRODUCT_EVALUATION';
  corpus.fixtures.push({ path: 'fixtures/java-holdout/fixture.json', sha256: digest(file) }); write(env.corpus, corpus);
  holdout.fixtureId = fixture.fixtureId;
  for (const fact of holdout.facts) { fact.observationId = fact.observationId.replace('java-calls', 'java-holdout'); bindSpan(fact); }
  holdout.facts.find(item => item.observationId.endsWith('.direct')).targets = ['wrong.holdout.target'];
  for (const outcome of holdout.outcomes) if (outcome.status !== 'EXCLUDED') outcome.bytesRead = fixture.source.find(meta => meta.path === outcome.path).bytes;
  editObservations(env, value => { value.provenance.kind = 'PRODUCT_CAPTURE'; value.runs.push(holdout); });
  addCorrectDevelopmentFacts(env); rebind(env);
  const oracleFiles = read(env.corpus).fixtures.flatMap(reference => {
    const fixtureFile = path.join(env.inputs, reference.path), manifest = read(fixtureFile), dir = path.dirname(fixtureFile);
    return [path.join(dir, manifest.gold.path), path.join(dir, manifest.negatives.path)];
  });
  const before = oracleFiles.map(digest), result = run(env); fails(result);
  const calls = cell(result.report, 'J-C');
  assert.equal(calls.samples.evaluationPositive, 1);
  assert.equal(calls.counts.tp, 0); assert.equal(calls.counts.fp, 1); assert.equal(calls.counts.fn, 1);
  assert.equal(calls.metrics.precision, 0); assert.equal(calls.metrics.recall, 0);
  assert.equal(result.report.observationEvaluation, 'FAIL'); assert.equal(result.report.scoredRuns, 1);
  assert.equal(result.report.macro.precision, 0); assert.equal(result.report.macro.recall, 0);
  assert.equal(result.report.unscoredDevelopmentRuns, 2); assert.deepEqual(result.report.scoringSplits, ['VALIDATION', 'HOLDOUT']);
  assert.deepEqual(oracleFiles.map(digest), before);
});

test('product scope containing only development runs reports no evaluated observations', t => {
  const env = sandbox(t), corpus = read(env.corpus); corpus.purpose = 'PRODUCT_EVALUATION'; write(env.corpus, corpus);
  editObservations(env, value => { value.provenance.kind = 'PRODUCT_CAPTURE'; }); rebind(env);
  const result = run(env); assert.equal(result.status, 2); assert.equal(result.report.observationEvaluation, 'NOT_RUN');
  assert.equal(result.report.scoredRuns, 0); assert.equal(result.report.unscoredDevelopmentRuns, 2);
  assert.equal(result.report.macro.precision, null); assert.ok(result.report.cells.every(item => item.metrics === null));
});

for (const guarded of [false, true]) test('100 good facts cannot conceal an abstention promotion with guard=' + guarded, t => {
  const env = sandbox(t); addCorrectDevelopmentFacts(env);
  editFixture(env, 'java-calls', ({ gold, negatives }) => {
    const index = negatives.cases.findIndex(item => item.caseId.endsWith('.dynamic'));
    const [abstention] = negatives.cases.splice(index, 1);
    abstention.polarity = 'POSITIVE'; abstention.mustNotEmitResolved = guarded; gold.cases.push(abstention);
  });
  editObservations(env, value => {
    const fact = structuredClone(value.runs[0].facts.find(item => item.observationId.endsWith('.dynamic')));
    fact.observationId = 'wrong.extra.resolution'; fact.resolution = 'STATIC_RESOLVED'; fact.targets = ['wrong']; fact.reasonCode = null;
    value.runs[0].facts.push(fact);
  });
  const before = digest(path.join(env.inputs, 'fixtures/java-calls/gold.json'));
  fails(run(env), guarded ? 'CONTRADICTORY_LOCATION_STATE' : 'ORACLE_ABSTENTION_UNGUARDED');
  assert.equal(digest(path.join(env.inputs, 'fixtures/java-calls/gold.json')), before);
});
