'use strict';

// Annotation tooling: deterministic spans from source bytes only, and the validator's refusals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stripMarkers, build, compare } = require('../lib/annotation.cjs');
const { ROOT, read, write, digest } = require('./helpers.cjs');

function workspace(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't00-annotate-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'src'));
  // CRLF and a two-byte character before the marked span: offsets must be bytes of the stripped file.
  fs.writeFileSync(path.join(temp, 'src', 'Calls.java'), 'package demo; // é\r\nclass Calls {\r\n'
    + '  static int twice(int v) { return v * 2; }\r\n  static int direct() { return [[@call]]twice(2)[[/@call]]; }\r\n}\r\n');
  fs.writeFileSync(path.join(temp, 'src', 'Other.java'), 'package demo;\nclass Other {}\n');
  return temp;
}

function spec(temp, overrides = {}) {
  const value = { format: 't00-annotation-spec/1', annotator: { id: 'annotator-a', kind: 'HUMAN', method: 'SOURCE_AUTHORED' },
    fixture: { fixtureId: 'annotate-test', fixtureVersion: '1.0.0', corpusId: 'annotate-corpus',
      license: { spdx: 'MIT', status: 'AUTHOR_DECLARED' },
      origin: { kind: 'SYNTHETIC', projectId: 'annotate-project', uri: 'urn:test:annotate', commit: null },
      scenarioFamilyId: 'annotate-scenario', generatorFamilyId: 'annotate-generator', split: 'DEVELOPMENT',
      versions: [{ name: 'java', version: '21' }], capabilities: ['J-P', 'J-C'], sourceRoot: 'src', sourceMode: 'INLINE_MARKERS',
      namespaces: [{ prefix: '', namespace: 'annotate-ns' }] },
    cases: [
      { caseId: 'annotate.valid', cellId: 'J-P', patternId: 'valid-syntax', kind: 'PARSER', relationKind: 'PARSE', polarity: 'POSITIVE',
        select: { file: 'Calls.java', wholeFile: true }, expected: { resolution: 'NOT_APPLICABLE', valid: true },
        mustNotEmitResolved: false, rationale: 'Valid Java 21.' },
      { caseId: 'annotate.direct', cellId: 'J-C', patternId: 'direct-source-call', kind: 'FACT', relationKind: 'CALLS', polarity: 'POSITIVE',
        select: { marker: 'call' }, expectText: 'twice(2)', expected: { resolution: 'STATIC_RESOLVED', targets: ['java:demo.Calls#twice(int)'] },
        mustNotEmitResolved: false, rationale: 'Direct static call.' }] };
  Object.assign(value, overrides);
  const file = path.join(temp, (value.annotator.id) + '.spec.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const cli = args => {
  const child = spawnSync(process.execPath, [path.join(ROOT, 'annotate.cjs'), ...args], { encoding: 'utf8', timeout: 15000 });
  return { status: child.status, result: JSON.parse(child.stdout) };
};
const errorCode = action => { try { action(); } catch (error) { return error.code; } return null; };

test('inline markers become byte offsets in the stripped source, across CRLF and multibyte text', () => {
  const stripped = stripMarkers(Buffer.from('é\r\n[[@a]]x[[/@a]]y'));
  assert.equal(stripped.bytes.toString('utf8'), 'é\r\nxy');
  assert.deepEqual(stripped.spans.get('a'), { start: 4, end: 5 });
  assert.equal(errorCode(() => stripMarkers(Buffer.from('[[@a]]x'))), 'UNBALANCED_MARKER');
  assert.equal(errorCode(() => stripMarkers(Buffer.from('[[@a]]x[[/@a]][[@a]]y[[/@a]]'))), 'DUPLICATE_MARKER');
  assert.equal(errorCode(() => stripMarkers(Buffer.from([0xc3]))), 'INVALID_UTF8');
});

test('build writes a contract-valid fixture whose spans match the source bytes', t => {
  const temp = workspace(t), output = path.join(temp, 'fixture');
  const built = build(spec(temp), output, 'f'.repeat(64));
  assert.deepEqual([built.positive, built.negativeOrAmbiguous], [2, 0]);
  const gold = read(path.join(output, 'gold.json')), call = gold.cases.find(item => item.caseId === 'annotate.direct');
  const bytes = fs.readFileSync(path.join(output, call.source.path));
  assert.equal(bytes.subarray(call.source.start, call.source.end).toString('utf8'), 'twice(2)');
  assert.ok(!bytes.toString('utf8').includes('[[@'));
  assert.equal(read(path.join(output, 'review.json')).status, 'AUTHOR_PROVISIONAL');
  assert.equal(errorCode(() => build(spec(temp), output, 'f'.repeat(64))), 'OUTPUT_EXISTS');
  const corpus = path.join(temp, 'corpus.json');
  write(corpus, { contractVersion: '1.0.0', corpusId: 'annotate-corpus', purpose: 'SYNTHETIC_SELF_TEST',
    fixtures: [{ path: 'fixture/fixture.json', sha256: digest(path.join(output, 'fixture.json')) }] });
  const checked = cli(['validate', '--capabilities', path.join(ROOT, 'capability-manifest.json'), '--corpus', corpus]);
  assert.equal(checked.status, 0); assert.equal(checked.result.result, 'PASS');
});

test('anchor mismatches, ambiguity and duplicate case ids are refused before writing', t => {
  const temp = workspace(t), base = JSON.parse(fs.readFileSync(spec(temp), 'utf8'));
  const variant = (edit, id) => { const value = structuredClone(base); value.annotator.id = id; edit(value); return spec(temp, value); };
  const mismatch = variant(value => { value.cases[1].expectText = 'twice(3)'; }, 'mismatch');
  assert.equal(errorCode(() => build(mismatch, path.join(temp, 'm'), 'f'.repeat(64))), 'SPAN_TEXT_MISMATCH');
  const ambiguous = variant(value => { value.cases[1].select = { file: 'Calls.java', text: 'twice' }; }, 'ambiguous');
  assert.equal(errorCode(() => build(ambiguous, path.join(temp, 'a'), 'f'.repeat(64))), 'ANCHOR_AMBIGUOUS');
  const duplicate = variant(value => { value.cases[1].caseId = 'annotate.valid'; }, 'duplicate');
  assert.equal(errorCode(() => build(duplicate, path.join(temp, 'd'), 'f'.repeat(64))), 'DUPLICATE_ID');
  for (const name of ['m', 'a', 'd']) assert.equal(fs.existsSync(path.join(temp, name)), false);
});

test('specs or sources shaped like product output are refused as authoring input', t => {
  const temp = workspace(t), base = JSON.parse(fs.readFileSync(spec(temp), 'utf8'));
  base.annotator.id = 'copied'; base.cases[1].observationId = 'p00001';
  assert.equal(errorCode(() => build(spec(temp, base), path.join(temp, 'x'), 'f'.repeat(64))), 'PRODUCT_OUTPUT_INPUT_REFUSED');
  fs.writeFileSync(path.join(temp, 'src', 'dump.json'), JSON.stringify({ format: 'code-intelligence-accuracy-product-dump/1', nodes: [] }));
  assert.equal(errorCode(() => build(spec(temp), path.join(temp, 'y'), 'f'.repeat(64))), 'PRODUCT_OUTPUT_INPUT_REFUSED');
});

test('two-annotator comparison reports span disagreements and refuses one annotator twice', t => {
  const temp = workspace(t), first = spec(temp), value = JSON.parse(fs.readFileSync(first, 'utf8'));
  value.annotator.id = 'annotator-b'; value.cases[1].select = { file: 'Calls.java', from: 'return twice', to: ';', fromOccurrence: 1 };
  delete value.cases[1].expectText;
  const result = compare(first, spec(temp, value));
  assert.equal(result.agreed, 1); assert.deepEqual(result.disagreements, [{ caseId: 'annotate.direct', kind: 'DIFFERENT', fields: ['span'] }]);
  assert.equal(errorCode(() => compare(first, first)), 'SAME_ANNOTATOR');
});

test('validator rejects edited span records, cross-split leakage and gold mirroring an observation bundle', t => {
  const temp = workspace(t), output = path.join(temp, 'fixture');
  build(spec(temp), output, 'f'.repeat(64));
  const capabilities = path.join(ROOT, 'capability-manifest.json'), corpus = path.join(temp, 'corpus.json');
  const corpusFor = (file, fixture, purpose = 'SYNTHETIC_SELF_TEST') => write(file, { contractVersion: '1.0.0', corpusId: 'annotate-corpus', purpose,
    fixtures: [{ path: path.relative(path.dirname(file), path.join(fixture, 'fixture.json')), sha256: digest(path.join(fixture, 'fixture.json')) }] });
  corpusFor(corpus, output);
  const record = path.join(output, 'annotation-record.json'), original = fs.readFileSync(record);
  const edited = read(record); edited.cases[1].end -= 1; write(record, edited);
  assert.ok(cli(['validate', '--capabilities', capabilities, '--corpus', corpus]).result.errors.some(item => item.code === 'RECORD_MISMATCH'));
  fs.writeFileSync(record, original);
  // The same project/generator family in another split is leakage even across corpus files.
  const second = path.join(temp, 'second');
  fs.cpSync(output, second, { recursive: true });
  fs.rmSync(path.join(second, 'annotation-record.json'));
  const manifest = read(path.join(second, 'fixture.json'));
  manifest.fixtureId = 'annotate-test-2'; manifest.split = 'VALIDATION';
  for (const kind of ['gold', 'negatives', 'review']) {
    const file = path.join(second, manifest[kind].path), value = read(file); value.fixtureId = manifest.fixtureId;
    if (value.cases) value.cases = value.cases.map(item => ({ ...item, caseId: item.caseId + '.2' }));
    write(file, value);
  }
  for (const kind of ['gold', 'negatives']) manifest[kind].sha256 = digest(path.join(second, manifest[kind].path));
  const review = read(path.join(second, 'review.json'));
  review.goldSha256 = manifest.gold.sha256; review.negativesSha256 = manifest.negatives.sha256; write(path.join(second, 'review.json'), review);
  manifest.review.sha256 = digest(path.join(second, 'review.json')); write(path.join(second, 'fixture.json'), manifest);
  const secondCorpus = path.join(temp, 'second-corpus.json');
  corpusFor(secondCorpus, second, 'PRODUCT_EVALUATION');
  const leak = cli(['validate', '--capabilities', capabilities, '--corpus', corpus, '--corpus', secondCorpus, '--allow-unrecorded']);
  assert.equal(leak.status, 1);
  assert.deepEqual([...new Set(leak.result.errors.map(item => item.code))], ['CROSS_SPLIT_LEAK'], JSON.stringify(leak.result.errors));
  // An observation bundle whose non-parser facts equal the unreviewed gold is refused (three cases needed).
  const mirrored = JSON.parse(fs.readFileSync(spec(temp), 'utf8'));
  mirrored.annotator.id = 'mirror'; mirrored.fixture.fixtureId = 'mirror-test'; mirrored.fixture.projectId = 'mirror';
  fs.appendFileSync(path.join(temp, 'src', 'Other.java'), 'class Third { static int a() { return [[@c2]]Calls.direct()[[/@c2]] + [[@c3]]Calls.twice(1)[[/@c3]]; } }\n');
  mirrored.cases.push(
    { caseId: 'mirror.c2', cellId: 'J-C', patternId: 'direct-source-call', kind: 'FACT', relationKind: 'CALLS', polarity: 'POSITIVE',
      select: { marker: 'c2' }, expected: { resolution: 'STATIC_RESOLVED', targets: ['java:demo.Calls#direct()'] }, mustNotEmitResolved: false, rationale: 'x' },
    { caseId: 'mirror.c3', cellId: 'J-C', patternId: 'direct-source-call', kind: 'FACT', relationKind: 'CALLS', polarity: 'POSITIVE',
      select: { marker: 'c3' }, expected: { resolution: 'STATIC_RESOLVED', targets: ['java:demo.Calls#twice(int)'] }, mustNotEmitResolved: false, rationale: 'x' });
  const mirrorFixture = path.join(temp, 'mirror');
  build(spec(temp, mirrored), mirrorFixture, 'f'.repeat(64));
  const mirrorCorpus = path.join(temp, 'mirror-corpus.json');
  corpusFor(mirrorCorpus, mirrorFixture);
  const cases = read(path.join(mirrorFixture, 'gold.json')).cases;
  const bundle = path.join(temp, 'observations.json');
  write(bundle, { runs: [{ fixtureId: 'mirror-test', facts: cases.map((item, index) => ({ observationId: 'o' + index, cellId: item.cellId,
    kind: item.kind, relationKind: item.relationKind, source: item.source, resolution: item.expected.resolution, targets: item.expected.targets })) }] });
  const mirror = cli(['validate', '--capabilities', capabilities, '--corpus', mirrorCorpus, '--observations', bundle]);
  assert.ok(mirror.result.errors.some(item => item.code === 'GOLD_MIRRORS_OBSERVATIONS'), JSON.stringify(mirror.result));
});
