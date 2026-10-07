#!/usr/bin/env node
'use strict';

// T00 annotation tooling (see ANNOTATING.md). Commands:
//   build    --spec <spec.json> --output <new fixture dir>
//   compare  --a <spec.json> --b <spec.json>
//   validate --capabilities <manifest> --corpus <corpus.json> [--corpus ...] [--observations <file> ...] [--allow-unrecorded]
//   show     --fixture <fixture.json> [--case <caseId>]
// No command reads product observations as an authoring input, and no command writes into an
// existing fixture: a changed oracle is a new fixture version with a new review.
const fs = require('node:fs');
const path = require('node:path');
const { ContractError, requireThat } = require('./lib/errors.cjs');
const { SafeIO, sha256 } = require('./lib/safe-io.cjs');
const { stableJson } = require('./lib/json.cjs');
const { loadContracts, matchKey } = require('./lib/contracts.cjs');
const { build, compare, RECORD_FORMAT } = require('./lib/annotation.cjs');

const toolSha256 = () => sha256(Buffer.from(['annotate.cjs', 'lib/annotation.cjs']
  .map(file => file + ':' + sha256(fs.readFileSync(path.join(__dirname, file)))).join('\n')));

function parse(argv) {
  const [command, ...rest] = argv, options = { corpus: [], observations: [] };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--allow-unrecorded') { options.allowUnrecorded = true; continue; }
    const name = flag?.replace(/^--/, ''), value = rest[++index];
    requireThat(['spec', 'output', 'a', 'b', 'capabilities', 'corpus', 'observations', 'fixture', 'case'].includes(name)
      && typeof value === 'string', 'INVALID_ARGUMENTS');
    if (Array.isArray(options[name])) options[name].push(path.resolve(value));
    else { requireThat(!Object.hasOwn(options, name), 'DUPLICATE_OPTION'); options[name] = ['case'].includes(name) ? value : path.resolve(value); }
  }
  return { command, options };
}

function validate({ corpus: corpora, capabilities, observations, allowUnrecorded }) {
  requireThat(corpora.length > 0 && capabilities, 'INVALID_ARGUMENTS');
  const errors = [], summary = [], splits = new Map(), fixtures = new Map();
  const claim = (key, split, fixtureId) => {
    const previous = splits.get(key);
    if (previous && previous.split !== split) errors.push({ fixtureId, code: 'CROSS_SPLIT_LEAK', with: previous.fixtureId });
    else if (!previous) splits.set(key, { split, fixtureId });
  };
  for (const corpusFile of corpora) {
    const io = new SafeIO();
    let loaded;
    try { loaded = loadContracts(io, { corpus: corpusFile, capabilities }); }
    catch (error) { errors.push({ corpus: path.basename(corpusFile), code: error instanceof ContractError ? error.code : 'INTERNAL_ERROR' }); continue; }
    const references = JSON.parse(fs.readFileSync(corpusFile, 'utf8')).fixtures;
    loaded.fixtures.forEach((fixture, index) => {
      const { manifest } = fixture, directory = path.dirname(path.join(path.dirname(corpusFile), references[index].path));
      if (fixtures.has(manifest.fixtureId)) errors.push({ fixtureId: manifest.fixtureId, code: 'DUPLICATE_ID' });
      fixtures.set(manifest.fixtureId, fixture);
      for (const item of fixture.cases) {
        for (const [otherId, other] of fixtures) if (otherId !== manifest.fixtureId && other.cases.some(c => c.caseId === item.caseId)) {
          errors.push({ fixtureId: manifest.fixtureId, code: 'DUPLICATE_ID', caseId: item.caseId });
        }
      }
      // Families and content may not cross splits, across every supplied corpus file.
      claim('project:' + manifest.origin.projectId, manifest.split, manifest.fixtureId);
      claim('scenario:' + manifest.scenarioFamilyId, manifest.split, manifest.fixtureId);
      claim('generator:' + manifest.generatorFamilyId, manifest.split, manifest.fixtureId);
      for (const meta of manifest.source) claim('file-content:' + meta.sha256, manifest.split, manifest.fixtureId);
      const recordFile = path.join(directory, 'annotation-record.json');
      let recorded = 'MISSING';
      if (fs.existsSync(recordFile)) {
        const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
        recorded = 'CHECKED';
        if (record.format !== RECORD_FORMAT || record.fixtureId !== manifest.fixtureId
          || record.goldSha256 !== manifest.gold.sha256 || record.negativesSha256 !== manifest.negatives.sha256) {
          errors.push({ fixtureId: manifest.fixtureId, code: 'RECORD_MISMATCH' });
        }
        const byId = new Map(record.cases.map(item => [item.caseId, item]));
        if (byId.size !== fixture.cases.length) errors.push({ fixtureId: manifest.fixtureId, code: 'RECORD_MISMATCH' });
        for (const item of fixture.cases) {
          const entry = byId.get(item.caseId), bytes = fixture.sources.get(item.source.path)?.bytes;
          if (!entry || entry.path !== item.source.path || entry.start !== item.source.start || entry.end !== item.source.end) {
            errors.push({ fixtureId: manifest.fixtureId, code: 'RECORD_MISMATCH', caseId: item.caseId }); continue;
          }
          if (!bytes || sha256(bytes.subarray(item.source.start, item.source.end)) !== entry.spanSha256) {
            errors.push({ fixtureId: manifest.fixtureId, code: 'SPAN_TEXT_MISMATCH', caseId: item.caseId });
          }
        }
      } else if (!allowUnrecorded) errors.push({ fixtureId: manifest.fixtureId, code: 'ANNOTATION_RECORD_MISSING' });
      summary.push({ fixtureId: manifest.fixtureId, split: manifest.split, cases: fixture.cases.length, record: recorded,
        review: fixture.review.status, independentlyReviewed: fixture.reviewReady });
    });
  }
  // Gold must not mirror a product observation bundle. A full bijection between product facts and
  // non-parser oracle cases in the same cells is refused until independent reviewers sign it off.
  for (const file of observations) {
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const run of bundle.runs ?? []) {
      const fixture = fixtures.get(run.fixtureId); if (!fixture) continue;
      const signature = item => stableJson([matchKey(item), item.expected?.resolution ?? item.resolution,
        [...(item.expected?.targets ?? item.targets)].sort()]);
      const cases = fixture.cases.filter(item => item.kind !== 'PARSER'), cells = new Set(cases.map(item => item.cellId));
      const facts = run.facts.filter(item => item.kind !== 'PARSER' && cells.has(item.cellId));
      const caseSet = new Set(cases.map(signature)), factSet = new Set(facts.map(signature));
      if (cases.length >= 3 && fixture.reviewReady !== true && caseSet.size === factSet.size
        && [...caseSet].every(item => factSet.has(item))) errors.push({ fixtureId: run.fixtureId, code: 'GOLD_MIRRORS_OBSERVATIONS' });
    }
  }
  return { result: errors.length ? 'FAIL' : 'PASS', fixtures: summary, errors };
}

function show({ fixture: manifestFile, case: caseId }) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), root = path.dirname(manifestFile);
  const cases = ['gold', 'negatives'].flatMap(kind => JSON.parse(fs.readFileSync(path.join(root, manifest[kind].path), 'utf8')).cases);
  return cases.filter(item => !caseId || item.caseId === caseId).map(item => {
    const bytes = fs.readFileSync(path.join(root, item.source.path)), before = bytes.subarray(0, item.source.start).toString('utf8');
    return { caseId: item.caseId, cellId: item.cellId, polarity: item.polarity, path: item.source.path,
      line: before.split('\n').length, text: bytes.subarray(item.source.start, item.source.end).toString('utf8').slice(0, 400),
      expected: item.expected };
  });
}

function main(argv) {
  let result, exitCode = 0;
  try {
    const { command, options } = parse(argv);
    if (command === 'build') { requireThat(options.spec && options.output, 'INVALID_ARGUMENTS'); result = build(options.spec, options.output, toolSha256()); }
    else if (command === 'compare') { requireThat(options.a && options.b, 'INVALID_ARGUMENTS'); result = compare(options.a, options.b); if (result.disagreements.length) exitCode = 3; }
    else if (command === 'validate') { result = validate(options); if (result.result !== 'PASS') exitCode = 1; }
    else if (command === 'show') { requireThat(options.fixture, 'INVALID_ARGUMENTS'); result = show(options); }
    else requireThat(false, 'INVALID_ARGUMENTS');
  } catch (error) {
    result = { result: 'FAIL', code: error instanceof ContractError ? error.code : error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'INTERNAL_ERROR' };
    exitCode = 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return exitCode;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, validate, show };
