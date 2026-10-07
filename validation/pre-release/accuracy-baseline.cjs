'use strict';

// G-ACCURACY case-level findings for a development baseline. The T00 runner reports only hashed
// case references; this tool joins the same corpus and observation bundle (loaded through the
// runner's own contract loader, so every binding check is repeated) and lists each failing case
// and each unmatched product fact with its fixture path and 1-based line. It reads gold to
// compare against it, never writes it, and never changes the runner's metrics or thresholds.
const fs = require('node:fs');
const path = require('node:path');
const { SafeIO } = require('../t00/lib/safe-io.cjs');
const { loadContracts, validator, matchKey } = require('../t00/lib/contracts.cjs');
const { verifyAttestation } = require('../t00/lib/attestation.cjs');
const { stableJson } = require('../t00/lib/json.cjs');

function lineOf(bytes, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < bytes.length; index++) if (bytes[index] === 0x0a) line++;
  return line;
}
const overlaps = (a, b) => a.path === b.path && a.start < b.end && b.start < a.end;
const brief = record => ({ resolution: record.resolution, targets: record.targets, valid: record.valid,
  diagnostics: record.diagnostics, reasonCode: record.reasonCode });

// The same per-case outcome rules as validation/t00/lib/metrics.cjs scoreCase, reported by name.
function classify(item, records) {
  const outcomes = [];
  const guarded = item.mustNotEmitResolved || ['UNRESOLVED', 'UNSUPPORTED', 'INFERRED'].includes(item.expected.resolution);
  const resolved = records.filter(record => record.resolution === 'STATIC_RESOLVED').length;
  if (guarded && resolved > 0) outcomes.push('FALSE_RESOLVED');
  if (item.kind === 'PARSER') {
    const first = records[0];
    if (item.expected.valid) outcomes.push(first?.valid === true ? 'TP' : 'FN');
    else outcomes.push(first?.valid === false && item.expected.diagnostics.every(code => first.diagnostics.includes(code))
      ? 'DIAGNOSED' : 'INVALID_DIAGNOSTIC_MISSING');
    if (records.length > 1) outcomes.push('DUPLICATE_FP');
    return outcomes;
  }
  const mustAbstain = ['UNRESOLVED', 'UNSUPPORTED'].includes(item.expected.resolution);
  if (mustAbstain) outcomes.push(records.some(record => record.resolution === item.expected.resolution
    && record.reasonCode === item.expected.reasonCode && record.targets.length === 0) ? 'ABSTAINED' : 'ABSTENTION_MISSING');
  if (item.kind === 'CANDIDATES') {
    const wanted = new Set(item.expected.targets), got = new Set(records[0]?.targets ?? []);
    const tp = [...got].filter(target => wanted.has(target)).length;
    outcomes.push(records[0] && tp === wanted.size && got.size === tp && records[0].resolution === item.expected.resolution
      ? 'CANDIDATE_EXACT' : records[0] ? 'CANDIDATE_MISMATCH' : 'CANDIDATE_MISSING');
    if (records.length > 1) outcomes.push('DUPLICATE_FP');
    return outcomes;
  }
  let matched = false;
  for (const record of records) {
    if (record.targets.length === 0) continue;
    const correct = item.expected.resolution === record.resolution && stableJson(item.expected.targets) === stableJson(record.targets);
    if (correct && !matched) { outcomes.push('TP'); matched = true; } else outcomes.push(matched && correct ? 'DUPLICATE_FP' : 'FP');
  }
  if (item.expected.targets.length > 0 && !matched) outcomes.push('FN');
  return outcomes;
}

function analyse({ corpus, capabilities, observations, executionAttestation }) {
  const io = new SafeIO(), loaded = loadContracts(io, { corpus, capabilities, observations, executionAttestation });
  // Repeat the runner's attestation binding (observation bytes, corpus, consumed roster, derived digest).
  if (executionAttestation) verifyAttestation(io, validator(io), { observations, executionAttestation,
    productBuildSha256: loaded.observations.provenance.productBuildSha256 }, loaded);
  const cases = [], unmatched = [];
  for (const run of loaded.observations.runs) {
    const fixture = loaded.fixtures.find(item => item.manifest.fixtureId === run.fixtureId);
    const keys = new Set(fixture.cases.map(matchKey)), groups = new Map();
    const located = source => ({ path: source.path, line: lineOf(fixture.sources.get(source.path).bytes, source.start),
      start: source.start, end: source.end });
    for (const fact of run.facts) {
      const key = matchKey(fact);
      if (!keys.has(key)) {
        const near = fixture.cases.filter(item => item.cellId === fact.cellId && overlaps(item.source, fact.source)).map(item => item.caseId);
        unmatched.push({ fixtureId: run.fixtureId, observationId: fact.observationId, cellId: fact.cellId, kind: fact.kind,
          relationKind: fact.relationKind, location: located(fact.source), observed: brief(fact), overlappingCases: near });
        continue;
      }
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(fact);
    }
    for (const item of fixture.cases) {
      const records = groups.get(matchKey(item)) ?? [];
      const sameCell = run.facts.filter(fact => fact.cellId === item.cellId && !keys.has(matchKey(fact)) && overlaps(item.source, fact.source));
      cases.push({ fixtureId: run.fixtureId, caseId: item.caseId, cellId: item.cellId, patternId: item.patternId, polarity: item.polarity,
        kind: item.kind, location: located(item.source), expected: item.expected, mustNotEmitResolved: item.mustNotEmitResolved,
        executionState: run.executionState, outcomes: classify(item, records), observed: records.map(brief),
        overlappingUnmatchedFacts: sameCell.map(fact => ({ observationId: fact.observationId, location: located(fact.source), observed: brief(fact) })) });
    }
  }
  const failing = cases.filter(item => item.outcomes.some(code => !['TP', 'DIAGNOSED', 'ABSTAINED', 'CANDIDATE_EXACT'].includes(code)));
  const byCell = {};
  for (const item of cases) {
    const cell = byCell[item.cellId] ??= { cases: 0, positive: 0, negativeOrAmbiguous: 0, outcomes: {} };
    cell.cases++; cell[item.polarity === 'POSITIVE' ? 'positive' : 'negativeOrAmbiguous']++;
    for (const code of item.outcomes) cell.outcomes[code] = (cell.outcomes[code] ?? 0) + 1;
  }
  for (const fact of unmatched) {
    const cell = byCell[fact.cellId] ??= { cases: 0, positive: 0, negativeOrAmbiguous: 0, outcomes: {} };
    cell.unmatchedFacts = (cell.unmatchedFacts ?? 0) + 1;
  }
  return { format: 'accuracy-baseline-findings/1', corpusSha256: loaded.corpusSha256,
    productBuildSha256: loaded.observations.provenance.productBuildSha256, corpusPurpose: loaded.corpus.purpose,
    totals: { cases: cases.length, failingCases: failing.length, unmatchedFacts: unmatched.length,
      falseResolved: cases.filter(item => item.outcomes.includes('FALSE_RESOLVED')).length },
    byCell, failingCases: failing, unmatchedFacts: unmatched };
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!['corpus', 'capabilities', 'observations', 'execution-attestation', 'output'].includes(name)
      || typeof argv[index + 1] !== 'string' || options[name]) {
      console.error('ACCURACY_BASELINE_ARGUMENTS'); return 1;
    }
    options[name === 'execution-attestation' ? 'executionAttestation' : name] = path.resolve(argv[index + 1]);
  }
  if (!options.corpus || !options.capabilities || !options.observations || !options.output) { console.error('ACCURACY_BASELINE_ARGUMENTS'); return 1; }
  const result = analyse(options);
  fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: options.output, ...result.totals }));
  return 0;
}
module.exports = { analyse, classify, lineOf };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error?.code ?? 'ACCURACY_BASELINE_FAILED'); process.exitCode = 1; }
}
