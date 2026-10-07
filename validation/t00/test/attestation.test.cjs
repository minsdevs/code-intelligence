'use strict';

// Local execution attestation and DEVELOPMENT_BASELINE scope. The bundles here are test-authored
// from the checked-in development transcription; they exercise binding checks, not product accuracy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('../lib/safe-io.cjs');
const { stableJson } = require('../lib/json.cjs');
const { sourceDigest } = require('../lib/contracts.cjs');
const { artifactDigest } = require('../lib/attestation.cjs');
const { ROOT, read, write, digest } = require('./helpers.cjs');
const FIXTURES = ['dev-t00-java-calls'];

function baseline(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't00-attest-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const inputs = path.join(temp, 'inputs'), artifacts = path.join(temp, 'artifacts'), bundle = path.join(temp, 'bundle');
  for (const directory of [inputs, artifacts, bundle, path.join(artifacts, 'classes')]) fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(path.join(ROOT, 'capability-manifest.json'), path.join(inputs, 'capability-manifest.json'));
  for (const id of FIXTURES) fs.cpSync(path.join(ROOT, 'baseline/fixtures', id), path.join(inputs, 'fixtures', id), { recursive: true });
  const corpus = { contractVersion: '1.0.0', corpusId: 'accuracy-development-baseline', purpose: 'DEVELOPMENT_BASELINE',
    fixtures: FIXTURES.map(id => ({ path: 'fixtures/' + id + '/fixture.json', sha256: digest(path.join(inputs, 'fixtures', id, 'fixture.json')) })) };
  write(path.join(inputs, 'corpus.json'), corpus);
  fs.writeFileSync(path.join(artifacts, 'app.bin'), 'product bytes\n');
  fs.writeFileSync(path.join(artifacts, 'classes', 'A.class'), 'a'); fs.writeFileSync(path.join(artifacts, 'classes', 'B.class'), 'b');
  const env = { temp, inputs, artifacts, bundle, corpus: path.join(inputs, 'corpus.json'), capabilities: path.join(inputs, 'capability-manifest.json'),
    observations: path.join(bundle, 'observations.json'), attestation: path.join(bundle, 'attestation.json'), sequence: 0 };
  author(env);
  return env;
}

// Facts mirror the authored cases exactly so that only the attestation decides the result.
function author(env, edit = {}) {
  const corpus = read(env.corpus), runs = [], attestedRuns = [];
  for (const reference of corpus.fixtures) {
    const manifestFile = path.join(env.inputs, reference.path), manifest = read(manifestFile), root = path.dirname(manifestFile);
    const cases = ['gold', 'negatives'].flatMap(kind => read(path.join(root, manifest[kind].path)).cases);
    runs.push({ fixtureId: manifest.fixtureId, sourceDigest: sourceDigest(manifest.source), executionState: 'COMPLETED', reasonCode: null,
      versions: manifest.versions, facts: cases.map((item, index) => ({ observationId: manifest.fixtureId + '.o' + index, cellId: item.cellId,
        kind: item.kind, relationKind: item.relationKind, source: item.source, resolution: item.expected.resolution,
        targets: item.expected.targets, valid: item.expected.valid, diagnostics: item.expected.diagnostics, reasonCode: item.expected.reasonCode })),
      outcomes: manifest.eligibility.map(item => ({ path: item.path, cellId: item.cellId, owner: item.owner,
        status: item.eligible ? 'SUCCESS' : 'EXCLUDED', bytesRead: item.eligible ? manifest.source.find(meta => meta.path === item.path).bytes : 0,
        reasonCode: item.eligible ? null : item.exclusionReason })) });
    attestedRuns.push({ fixtureId: manifest.fixtureId, sourceDigest: sourceDigest(manifest.source), executionState: 'COMPLETED',
      consumedSources: manifest.source.map(meta => ({ path: meta.path, sha256: meta.sha256, bytes: meta.bytes })) });
  }
  const budget = { bytes: 0 };
  const build = { path: 'BACKEND_PIPELINE_HARNESS', revision: 'a'.repeat(40), dirtyProductPaths: 0, components: [
    { name: 'app', path: 'app.bin', ...artifactDigest(path.join(env.artifacts, 'app.bin'), budget) },
    { name: 'classes', path: 'classes', ...artifactDigest(path.join(env.artifacts, 'classes'), budget) }] };
  edit.build?.(build);
  const productBuildSha256 = edit.declaredDigest ?? sha256(Buffer.from(stableJson(build)));
  const observations = { contractVersion: '1.0.0', bundleId: 'attest-test', provenance: { kind: 'PRODUCT_CAPTURE',
    producerVersion: 'attestation-test', captureAttestation: 'EXTERNAL_ATTESTATION', productBuildSha256 },
    corpusSha256: digest(env.corpus), capabilityManifestSha256: digest(env.capabilities), runs };
  edit.observations?.(observations);
  write(env.observations, observations);
  const attestation = { contractVersion: '1.0.0', attestationId: 'attest-test', kind: 'BACKEND_PIPELINE_HARNESS', productBuildSha256, build,
    observationsSha256: digest(env.observations), corpusSha256: digest(env.corpus), capabilityManifestSha256: digest(env.capabilities),
    runs: attestedRuns, execution: { path: 'BACKEND_PIPELINE_HARNESS', nonce: '0'.repeat(32), startedAt: 'x', finishedAt: 'y',
      driverSha256: '1'.repeat(64), converterSha256: '2'.repeat(64), adapterVersion: 'attestation-test' } };
  edit.attestation?.(attestation);
  write(env.attestation, attestation);
  env.build = productBuildSha256;
}

function run(env, { attestation = true, artifactRoot = true, extra = [] } = {}) {
  const output = path.join(env.temp, 'out-' + env.sequence++);
  const args = [path.join(ROOT, 'runner.cjs'), '--mode', 'gate', '--offline', '--corpus', env.corpus, '--capabilities', env.capabilities,
    '--observations', env.observations, '--product-build-sha256', env.build, '--output', output, ...extra];
  if (attestation) args.push('--execution-attestation', env.attestation);
  if (attestation && artifactRoot) args.push('--product-artifact-root', env.artifacts);
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  const reportFile = path.join(output, 'report.json');
  return { status: child.status, summary: JSON.parse(child.stdout), report: fs.existsSync(reportFile) ? read(reportFile) : null };
}

test('a bound attestation with re-hashed artifacts is recorded but never unblocks the gate', t => {
  const env = baseline(t), result = run(env);
  assert.equal(result.status, 2); assert.equal(result.summary.result, 'BLOCKED');
  assert.equal(result.report.contractResult, 'PASS'); assert.equal(result.report.observationEvaluation, 'PASS');
  assert.equal(result.report.corpusPurpose, 'DEVELOPMENT_BASELINE');
  assert.equal(result.report.buildBinding.artifactVerification, 'VERIFIED');
  assert.equal(result.report.buildBinding.productExecutionVerification, 'HARNESS_ATTESTED_UNSIGNED');
  assert.equal(result.report.executionAttestation.signed, false);
  assert.equal(result.report.executionAttestation.artifactRecheck.length, 2);
  assert.ok(result.report.blockerCodes.includes('EXECUTION_ATTESTATION_LOCAL_UNSIGNED'));
  assert.ok(result.report.blockerCodes.includes('DEVELOPMENT_MATERIAL_ONLY'));
  assert.ok(!result.report.blockerCodes.includes('PRODUCT_EXECUTION_UNVERIFIED'));
  assert.equal(result.report.releaseGate.result, 'BLOCKED');
  assert.ok(result.report.cells.every(cell => cell.publicSupported === false && cell.result !== 'PASS'));
  assert.ok(result.report.cells.filter(cell => cell.metrics).every(cell => cell.blockerCodes.includes('DEVELOPMENT_MATERIAL_ONLY')));
});

test('without an artifact root the attestation binds bytes but artifact verification stays NOT_RUN', t => {
  const env = baseline(t), result = run(env, { artifactRoot: false });
  assert.equal(result.status, 2);
  assert.equal(result.report.buildBinding.artifactVerification, 'NOT_RUN');
  assert.equal(result.report.buildBinding.productExecutionVerification, 'HARNESS_ATTESTED_UNSIGNED');
});

test('one changed artifact byte fails the re-hash', t => {
  const env = baseline(t);
  fs.writeFileSync(path.join(env.artifacts, 'classes', 'B.class'), 'c');
  const result = run(env);
  assert.equal(result.status, 1); assert.equal(result.summary.code, 'ARTIFACT_DIGEST_MISMATCH');
  assert.equal(result.report.buildBinding.productExecutionVerification, 'NOT_RUN');
});

test('a declared build digest that is not derived from its components is refused', t => {
  const env = baseline(t);
  author(env, { declaredDigest: 'f'.repeat(64) });
  assert.equal(run(env).summary.code, 'ATTESTATION_DIGEST_NOT_DERIVED');
});

test('observation bytes changed after attestation are refused', t => {
  const env = baseline(t), observations = read(env.observations);
  observations.bundleId = 'changed-after-attestation'; write(env.observations, observations);
  assert.equal(run(env).summary.code, 'ATTESTATION_BINDING_MISMATCH');
});

test('a consumed roster that omits a fixture file is refused', t => {
  const env = baseline(t);
  author(env, { attestation: value => { value.runs[0].consumedSources.pop(); } });
  assert.equal(run(env).summary.code, 'ATTESTATION_SOURCE_MISMATCH');
});

test('a component path escaping the artifact root is refused', t => {
  const env = baseline(t);
  author(env, { build: build => { build.components[0].path = '../inputs/corpus.json'; } });
  assert.equal(run(env).summary.code, 'UNSAFE_PATH');
});

test('an external-attestation claim without the attestation file is missing evidence', t => {
  const env = baseline(t), result = run(env, { attestation: false });
  assert.equal(result.status, 1); assert.equal(result.summary.code, 'ATTESTATION_MISSING');
  assert.ok(result.report.blockerCodes.includes('PRODUCT_EXECUTION_UNVERIFIED'));
});

test('an unverified product capture cannot be paired with an attestation', t => {
  const env = baseline(t);
  author(env, { observations: value => { value.provenance.captureAttestation = 'UNVERIFIED'; } });
  assert.equal(run(env).summary.code, 'ATTESTATION_UNEXPECTED');
});

test('an artifact root without an attestation and attestation options in contract mode are conflicts', t => {
  const env = baseline(t);
  const loose = run(env, { attestation: false, extra: ['--product-artifact-root', env.artifacts] });
  assert.equal(loose.summary.code, 'MODE_OPTION_CONFLICT');
  const contract = spawnSync(process.execPath, [path.join(ROOT, 'runner.cjs'), '--mode', 'contract', '--offline', '--corpus', env.corpus,
    '--capabilities', env.capabilities, '--execution-attestation', env.attestation, '--output', path.join(env.temp, 'contract')], { encoding: 'utf8' });
  assert.equal(JSON.parse(contract.stdout).code, 'MODE_OPTION_CONFLICT');
});

test('a development baseline corpus cannot carry an evaluation split', t => {
  const env = baseline(t), corpus = read(env.corpus), file = path.join(env.inputs, corpus.fixtures[0].path), fixture = read(file);
  fixture.split = 'VALIDATION'; write(file, fixture); corpus.fixtures[0].sha256 = digest(file); write(env.corpus, corpus);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'runner.cjs'), '--mode', 'contract', '--offline', '--corpus', env.corpus,
    '--capabilities', env.capabilities, '--output', path.join(env.temp, 'split')], { encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).code, 'BASELINE_SCOPE_MISMATCH');
});
