'use strict';

// Unit tests for the shared product-dump -> T00 observation adapter, on hand-written dumps over the
// checked-in development-baseline fixtures. No product, database or gold is involved in the dumps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { treeDigest, gitBlobSha1, readFixture, convertFixture, writeBundle, compareDumps, apiProjection, sha256 } = require('../accuracy-observations.cjs');
const { artifactDigest } = require('../../t00/lib/attestation.cjs');
const { stableJson } = require('../../t00/lib/json.cjs');
const BASELINE = path.resolve(__dirname, '../../t00/baseline');
const RUNNER = path.resolve(__dirname, '../../t00/runner.cjs');
const CAPABILITIES = path.resolve(__dirname, '../../t00/capability-manifest.json');

function corpusFor(t, ids) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-observations-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const id of ids) fs.cpSync(path.join(BASELINE, 'fixtures', id), path.join(temp, 'fixtures', id), { recursive: true });
  const corpus = path.join(temp, 'corpus.json');
  fs.writeFileSync(corpus, JSON.stringify({ contractVersion: '1.0.0', corpusId: 'accuracy-development-baseline', purpose: 'DEVELOPMENT_BASELINE',
    fixtures: ids.map(id => ({ path: 'fixtures/' + id + '/fixture.json', sha256: sha256(fs.readFileSync(path.join(temp, 'fixtures', id, 'fixture.json'))) })) }));
  return { temp, corpus, fixtures: JSON.parse(fs.readFileSync(corpus, 'utf8')).fixtures.map(reference => readFixture(corpus, reference)) };
}

function javaDump(fixture, edit = {}) {
  const file = name => fixture.sources.get('source/' + name);
  const row = (name, status, reason = null) => ({ path: 'source/' + name, size: file(name).bytes.length,
    contentHash: gitBlobSha1(file(name).bytes), analysisStatus: status, analysisReason: reason });
  const method = (key, line) => ({ type: 'METHOD', key: 'java:demo.Calls#' + key, path: 'source/Calls.java', lineStart: line, lineEnd: line, metadata: {} });
  const dump = { path: 'BACKEND_PIPELINE_HARNESS', executionState: 'COMPLETED', failureCode: null,
    consumedSources: [...fixture.sources.values()].map(source => ({ path: source.meta.path, sha256: source.meta.sha256, bytes: source.meta.bytes })),
    files: [row('Calls.java', 'SUCCESS'), row('Invalid.java', 'FAILED', 'JAVA_PARSE_FAILED')],
    nodes: [method('twice(int)', 6), method('direct()', 7), method('indirect(demo.Action)', 8),
      { type: 'METHOD', key: 'java:demo.FirstAction#run()', path: 'source/Calls.java', lineStart: 3, lineEnd: 3, metadata: {} },
      { type: 'METHOD', key: 'java:demo.SecondAction#run()', path: 'source/Calls.java', lineStart: 4, lineEnd: 4, metadata: {} }],
    edges: [
      { type: 'CALLS', source: 'java:demo.Calls#direct()', target: 'java:demo.Calls#twice(int)', confidence: 'CONFIRMED', metadata: {} },
      { type: 'CALLS', source: 'java:demo.Calls#indirect(demo.Action)', target: 'java:demo.SecondAction#run()', confidence: 'PROBABLE', metadata: {} },
      { type: 'CALLS', source: 'java:demo.Calls#indirect(demo.Action)', target: 'java:demo.FirstAction#run()', confidence: 'PROBABLE', metadata: {} }],
    endpoints: [], entities: [], routes: [] };
  edit.dump?.(dump);
  return dump;
}

test('calls map by confidence; candidates group per span; parser verdicts only for per-file failures', t => {
  const { fixtures } = corpusFor(t, ['dev-t00-java-calls']), fixture = fixtures[0];
  const { run, audit } = convertFixture(fixture, javaDump(fixture), 'x.');
  const calls = run.facts.filter(fact => fact.cellId === 'J-C');
  const direct = calls.find(fact => fact.resolution === 'STATIC_RESOLVED'), candidates = calls.find(fact => fact.kind === 'CANDIDATES');
  const text = fact => fixture.sources.get(fact.source.path).bytes.subarray(fact.source.start, fact.source.end).toString('utf8');
  // Without call-site metadata the declaration line is the only product-published span.
  assert.equal(text(direct), 'static int direct() { return twice(2); }');
  assert.deepEqual(candidates.targets, ['java:demo.FirstAction#run()', 'java:demo.SecondAction#run()']);
  assert.equal(candidates.resolution, 'INFERRED'); assert.equal(calls.length, 2);
  assert.equal(audit.projections['call-declaration-no-callsite-evidence'], 3);
  const parser = run.facts.filter(fact => fact.cellId === 'J-P');
  assert.deepEqual(parser.map(fact => [fact.source.path, fact.valid, fact.diagnostics]),
    [['source/Calls.java', true, []], ['source/Invalid.java', false, ['SYNTAX_ERROR']]]);
  assert.ok(run.facts.every(fact => fact.observationId.startsWith('x.')));
  assert.deepEqual([audit.evidence.hashChecked, audit.evidence.hashValid], [2, 2]);
  // A project-level rejection names no invalid file: no parser verdict, and the coverage outcome is FAILED.
  const rejected = convertFixture(fixture, javaDump(fixture, { dump: dump => {
    for (const row of dump.files) Object.assign(row, { analysisStatus: 'FAILED', analysisReason: 'PROJECT_SYNTAX_REJECTED' });
  } }));
  assert.equal(rejected.run.facts.filter(fact => fact.cellId === 'J-P').length, 0);
  assert.equal(rejected.audit.projections['parser-no-verdict-FAILED-PROJECT_SYNTAX_REJECTED'], 2);
  assert.ok(rejected.run.outcomes.filter(item => item.cellId === 'J-P').every(item => item.status === 'FAILED' && item.reasonCode === 'PROJECT_SYNTAX_REJECTED'));
});

test('call-site metadata selects the call expression; a changed stored hash is reported, never repaired', t => {
  const { fixtures } = corpusFor(t, ['dev-t00-java-calls']), fixture = fixtures[0];
  const { run, audit } = convertFixture(fixture, javaDump(fixture, { dump: dump => {
    dump.edges[0].metadata = { lineStart: 7, expression: 'twice' };
    dump.files[0].contentHash = '0'.repeat(40);
  } }));
  const direct = run.facts.find(fact => fact.resolution === 'STATIC_RESOLVED');
  assert.equal(fixture.sources.get(direct.source.path).bytes.subarray(direct.source.start, direct.source.end).toString('utf8'), 'twice(2)');
  assert.deepEqual(audit.evidence.hashInvalid, ['source/Calls.java']);
});

test('a written bundle is unique across fixtures, derives its digest and passes the runner contract with attestation', t => {
  const { temp, corpus, fixtures } = corpusFor(t, ['dev-t00-java-calls', 'dev-t00-typescript-calls']);
  const ts = fixtures[1], tsDump = { path: 'BACKEND_PIPELINE_HARNESS', executionState: 'FAILED', failureCode: 'TS_SYNTAX_ERROR',
    consumedSources: [...ts.sources.values()].map(source => ({ path: source.meta.path, sha256: source.meta.sha256, bytes: source.meta.bytes })),
    files: [...ts.sources.values()].map(source => ({ path: source.meta.path, size: source.meta.bytes, contentHash: gitBlobSha1(source.bytes),
      analysisStatus: 'FAILED', analysisReason: 'PROJECT_SYNTAX_REJECTED' })), nodes: [], edges: [], endpoints: [], entities: [], routes: [] };
  fs.mkdirSync(path.join(temp, 'artifacts')); fs.writeFileSync(path.join(temp, 'artifacts', 'product.bin'), 'bytes');
  const build = { path: 'BACKEND_PIPELINE_HARNESS', revision: 'b'.repeat(40), dirtyProductPaths: 0,
    components: [{ name: 'product', path: 'product.bin', ...treeDigest(path.join(temp, 'artifacts', 'product.bin')) }] };
  const bundle = writeBundle({ root: temp, corpus, capabilities: CAPABILITIES,
    dumps: new Map([['dev-t00-java-calls', javaDump(fixtures[0])], ['dev-t00-typescript-calls', tsDump]]), build,
    execution: { path: 'BACKEND_PIPELINE_HARNESS', nonce: 'c'.repeat(32), startedAt: 'a', finishedAt: 'b', driverSha256: 'd'.repeat(64),
      converterSha256: 'e'.repeat(64), revision: 'b'.repeat(40) } });
  assert.equal(bundle.productBuildSha256, sha256(Buffer.from(stableJson(build))));
  const observations = JSON.parse(fs.readFileSync(path.join(bundle.directory, 'observations.json'), 'utf8'));
  const ids = observations.runs.flatMap(run => run.facts.map(fact => fact.observationId));
  assert.equal(new Set(ids).size, ids.length);
  // The runner refuses an output under any input parent, so the report goes to its own temporary root.
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-gate-')), output = path.join(outputRoot, 'gate');
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [RUNNER, '--mode', 'gate', '--offline', '--corpus', corpus, '--capabilities', CAPABILITIES,
    '--observations', path.join(bundle.directory, 'observations.json'), '--product-build-sha256', bundle.productBuildSha256,
    '--execution-attestation', path.join(bundle.directory, 'attestation.json'), '--product-artifact-root', path.join(temp, 'artifacts'),
    '--output', output], { encoding: 'utf8', timeout: 15000 });
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.contractResult, 'PASS', child.stdout);
  assert.equal(report.buildBinding.artifactVerification, 'VERIFIED');
  assert.equal(report.buildBinding.productExecutionVerification, 'HARNESS_ATTESTED_UNSIGNED');
  assert.equal(report.releaseGate.result, 'BLOCKED');
});

test('tree digests agree with the runner re-hash and dump comparison sees API-visible differences only', t => {
  const { temp, fixtures } = corpusFor(t, ['dev-t00-java-calls']);
  const directory = path.join(temp, 'fixtures', 'dev-t00-java-calls'), file = path.join(directory, 'fixture.json');
  assert.deepEqual(treeDigest(directory), artifactDigest(directory, { bytes: 0 }));
  assert.deepEqual(treeDigest(file), artifactDigest(file, { bytes: 0 }));
  const left = javaDump(fixtures[0]), right = javaDump(fixtures[0], { dump: dump => { dump.edges[0].metadata = { lineStart: 7 }; } });
  assert.equal(compareDumps(left, right).equal, true);
  assert.deepEqual(apiProjection(right).edges[0].metadata, {});
  const changed = javaDump(fixtures[0], { dump: dump => { dump.edges[1].confidence = 'CONFIRMED'; } });
  const result = compareDumps(left, changed);
  assert.equal(result.equal, false); assert.equal(result.edges.onlyLeft.length, 1); assert.equal(result.edges.onlyRight.length, 1);
});
