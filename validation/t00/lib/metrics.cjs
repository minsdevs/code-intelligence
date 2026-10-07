'use strict';

const { matchKey } = require('./contracts.cjs');
const { stableJson } = require('./json.cjs');
const { sha256 } = require('./safe-io.cjs');
const { THRESHOLDS } = require('./policy.cjs');

const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const mean = values => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
function wilsonLower(tp, n) {
  if (n === 0) return null;
  const z = 1.96, p = tp / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}
function candidateMetrics(gold, predicted) {
  const wanted = new Set(gold), actual = new Set(predicted);
  const tp = [...actual].filter(item => wanted.has(item)).length;
  const fp = actual.size - tp, fn = wanted.size - tp;
  return { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), exact: fp === 0 && fn === 0 };
}
function counters() {
  return { positiveCases: 0, negativeCases: 0, tp: 0, fp: 0, fn: 0, duplicates: 0, unmatched: 0, falseResolved: 0,
    validFiles: 0, validSucceeded: 0, invalidFiles: 0, invalidDiagnosed: 0,
    candidateTp: 0, candidateFp: 0, candidateFn: 0, candidateCases: 0, exactCandidateCases: 0,
    candidatePrecisions: [], candidateRecalls: [], reasons: new Set(), cases: [] };
}
function values(stats) {
  return {
    precision: ratio(stats.tp, stats.tp + stats.fp), recall: ratio(stats.tp, stats.tp + stats.fn),
    supportedPatternRecall: ratio(stats.tp, stats.tp + stats.fn), overallGoldRecall: null,
    overallGoldRecallStatus: 'NOT_MEASURED', overallGoldRecallReason: 'UNSUPPORTED_POSITIVE_ORACLE_MISSING',
    precisionWilson95Lower: wilsonLower(stats.tp, stats.tp + stats.fp), wilsonN: stats.tp + stats.fp,
    validFileSuccess: ratio(stats.validSucceeded, stats.validFiles), invalidDiagnosticRecall: ratio(stats.invalidDiagnosed, stats.invalidFiles),
    candidatePrecision: ratio(stats.candidateTp, stats.candidateTp + stats.candidateFp),
    candidateRecallAt5: ratio(stats.candidateTp, stats.candidateTp + stats.candidateFn),
    candidateExactSetAccuracy: ratio(stats.exactCandidateCases, stats.candidateCases),
    candidateMacroPrecision: mean(stats.candidatePrecisions), candidateMacroRecall: mean(stats.candidateRecalls),
  };
}
function scoreCase(stats, item, records) {
  stats[item.polarity === 'POSITIVE' ? 'positiveCases' : 'negativeCases']++;
  stats.cases.push(item);
  if (item.mustNotEmitResolved || ['UNRESOLVED', 'UNSUPPORTED', 'INFERRED'].includes(item.expected.resolution)) {
    stats.falseResolved += records.filter(record => record.resolution === 'STATIC_RESOLVED').length;
    if (stats.falseResolved > 0) stats.reasons.add('FALSE_RESOLVED');
  }
  const seen = new Set();
  for (const record of records) {
    const key = stableJson([record.resolution, record.targets, record.valid, record.diagnostics, record.reasonCode]);
    if (seen.has(key)) stats.duplicates++; else seen.add(key);
  }
  if (item.kind === 'PARSER') {
    if (records.length > 1) stats.reasons.add('DUPLICATE_PARSER_RESULT');
    const first = records[0];
    if (item.expected.valid) {
      stats.validFiles++;
      if (first?.valid === true) { stats.validSucceeded++; stats.tp++; } else stats.fn++;
    } else {
      stats.invalidFiles++;
      if (first?.valid === false && item.expected.diagnostics.every(code => first.diagnostics.includes(code))) stats.invalidDiagnosed++;
      else stats.reasons.add('INVALID_DIAGNOSTIC_MISSING');
    }
    stats.fp += Math.max(0, records.length - 1); return;
  }
  const mustAbstain = ['UNRESOLVED', 'UNSUPPORTED'].includes(item.expected.resolution);
  if (mustAbstain && !records.some(record => record.resolution === item.expected.resolution
    && record.reasonCode === item.expected.reasonCode && record.targets.length === 0)) stats.reasons.add('ABSTENTION_MISSING');
  if (item.kind === 'CANDIDATES') {
    const first = records[0], candidate = candidateMetrics(item.expected.targets, first?.targets ?? []);
    stats.candidateCases++;
    stats.candidateTp += candidate.tp; stats.candidateFp += candidate.fp; stats.candidateFn += candidate.fn;
    if (candidate.exact && first != null && first.resolution === item.expected.resolution) stats.exactCandidateCases++;
    if (candidate.precision != null) stats.candidatePrecisions.push(candidate.precision);
    if (candidate.recall != null) stats.candidateRecalls.push(candidate.recall);
    if (records.length > 1) {
      stats.reasons.add('DUPLICATE_CANDIDATE_SET');
      stats.candidateFp += records.slice(1).reduce((sum, record) => sum + record.targets.length, 0);
    }
    return;
  }
  let matched = false, matchedAbstention = false;
  const emptyClaims = new Set();
  for (const record of records) {
    if (record.targets.length === 0) {
      // Abstentions are observable claims too. Repeating a correct empty-target
      // claim cannot evade duplicate FP accounting merely because it has no edge.
      if (mustAbstain) {
        const correct = record.resolution === item.expected.resolution && record.reasonCode === item.expected.reasonCode;
        if (correct && !matchedAbstention) matchedAbstention = true;
        else stats.fp++;
      } else {
        const key = stableJson([record.resolution, record.reasonCode]);
        if (emptyClaims.has(key)) stats.fp++; else emptyClaims.add(key);
      }
      continue;
    }
    const correct = item.expected.resolution === record.resolution
      && stableJson(item.expected.targets) === stableJson(record.targets);
    if (correct && !matched) { stats.tp++; matched = true; }
    else stats.fp += record.targets.length;
  }
  if (item.expected.targets.length > 0 && !matched) stats.fn += item.expected.targets.length;
}

function thresholds(stats, cell, gateWilson = true) {
  const metric = values(stats), failures = new Set(stats.reasons);
  const below = (value, required, code) => { if (value != null && value < required) failures.add(code); };
  if (cell.capability === 'P') {
    below(metric.validFileSuccess, THRESHOLDS.parseSuccess, 'PARSE_SUCCESS_BELOW_THRESHOLD');
    below(metric.invalidDiagnosticRecall, THRESHOLDS.invalidDiagnostics, 'INVALID_DIAGNOSTIC_MISSING');
  } else {
    const symbol = cell.capability === 'S';
    below(metric.precision, symbol ? THRESHOLDS.symbolPrecision : THRESHOLDS.resolvedPrecision, 'PRECISION_BELOW_THRESHOLD');
    below(metric.recall, symbol ? THRESHOLDS.symbolRecall : THRESHOLDS.resolvedRecall, 'RECALL_BELOW_THRESHOLD');
    // Insufficient n is a readiness blocker, never proof of a failing population or a pass.
    if (!symbol && gateWilson && metric.wilsonN >= 200) below(metric.precisionWilson95Lower, THRESHOLDS.wilsonLower, 'WILSON_BELOW_THRESHOLD');
    below(metric.candidatePrecision, THRESHOLDS.candidatePrecision, 'CANDIDATE_PRECISION_BELOW_THRESHOLD');
    below(metric.candidateRecallAt5, THRESHOLDS.candidateRecall, 'CANDIDATE_RECALL_BELOW_THRESHOLD');
    below(metric.candidateExactSetAccuracy, THRESHOLDS.candidateExactSet, 'CANDIDATE_EXACT_SET_BELOW_THRESHOLD');
  }
  if (stats.falseResolved > 0) failures.add('FALSE_RESOLVED');
  if (stats.unmatched > 0) failures.add('ANNOTATION_REVIEW_REQUIRED');
  return [...failures].sort();
}

function sampleCounts(fixtures, cellId, stratum = null) {
  const collected = fixtures.flatMap(fixture => fixture.cases.filter(item => item.cellId === cellId
    && (stratum === null || item.stratum === stratum)).map(item => ({ fixture, item })));
  const evaluated = collected.filter(({ fixture }) => fixture.manifest.split !== 'DEVELOPMENT');
  const positive = rows => rows.filter(({ item }) => item.polarity === 'POSITIVE').length;
  return { authoredPositive: positive(collected), authoredNegative: collected.length - positive(collected),
    evaluationPositive: positive(evaluated), evaluationNegative: evaluated.length - positive(evaluated),
    holdoutPositive: positive(evaluated.filter(({ fixture }) => fixture.manifest.split === 'HOLDOUT')),
    holdoutNegative: evaluated.filter(({ fixture, item }) => fixture.manifest.split === 'HOLDOUT' && item.polarity !== 'POSITIVE').length,
    independentPublicProjects: new Set(evaluated.filter(({ fixture }) => fixture.reviewReady
      && fixture.manifest.origin.kind === 'PUBLIC_REPOSITORY' && fixture.manifest.license.status === 'INDEPENDENTLY_REVIEWED')
      .map(({ fixture }) => fixture.manifest.origin.projectId)).size,
    scenarios: new Set(evaluated.map(({ fixture }) => fixture.manifest.scenarioFamilyId)).size,
    parserFiles: new Set(evaluated.filter(({ item }) => item.kind === 'PARSER')
      .map(({ fixture, item }) => fixture.manifest.fixtureId + '/' + item.source.path)).size,
    independentlyReviewedCases: evaluated.filter(({ fixture }) => fixture.reviewReady).length };
}

function evaluate(loaded) {
  const stats = new Map(loaded.capabilities.cells.map(cell => [cell.cellId, counters()]));
  const strata = new Map();
  for (const cell of loaded.capabilities.cells) for (const stratum of cell.strata) strata.set(stratum.stratumId, counters());
  const coverage = [], caseFailures = [], annotationReviewQueue = [];
  // Development material is scored only in explicitly labelled self-test or development-baseline scopes.
  const scoringSplits = ['SYNTHETIC_SELF_TEST', 'DEVELOPMENT_BASELINE'].includes(loaded.corpus.purpose) ? ['DEVELOPMENT'] : ['VALIDATION', 'HOLDOUT'];
  let checkedFacts = 0, scoredRuns = 0, unscoredDevelopmentRuns = 0;
  for (const run of loaded.observations?.runs ?? []) {
    const fixture = loaded.fixtures.find(item => item.manifest.fixtureId === run.fixtureId);
    const scoreEligible = scoringSplits.includes(fixture.manifest.split);
    if (scoreEligible) scoredRuns++; else unscoredDevelopmentRuns++;
    const groups = new Map(), keys = new Set(fixture.cases.map(matchKey));
    for (const fact of run.facts) {
      checkedFacts++;
      if (!scoreEligible) continue;
      const key = matchKey(fact);
      if (!keys.has(key)) {
        stats.get(fact.cellId).unmatched++;
        annotationReviewQueue.push({ observationRef: sha256(Buffer.from(run.fixtureId + '/' + fact.observationId)),
          cellId: fact.cellId, reasonCode: 'ANNOTATION_REVIEW_REQUIRED' });
        continue;
      }
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(fact);
    }
    for (const item of fixture.cases) {
      if (!scoreEligible) continue;
      const records = groups.get(matchKey(item)) ?? [];
      scoreCase(stats.get(item.cellId), item, records);
      if (item.stratum != null) scoreCase(strata.get(item.stratum), item, records);
      const isolated = counters(); scoreCase(isolated, item, records);
      const failures = thresholds(isolated, loaded.cells.get(item.cellId), false);
      if (failures.length) caseFailures.push({ caseRef: sha256(Buffer.from(run.fixtureId + '/' + item.caseId)), reasonCodes: failures });
    }
    for (const cellId of fixture.manifest.capabilities) {
      const outcomes = run.outcomes.filter(outcome => outcome.cellId === cellId);
      const partition = Object.fromEntries(['SUCCESS', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED', 'PENDING', 'EXCLUDED']
        .map(status => [status, outcomes.filter(outcome => outcome.status === status).length]));
      coverage.push({ fixtureRef: sha256(Buffer.from(run.fixtureId)), split: fixture.manifest.split, scoreEligible, cellId, total: outcomes.length,
        eligible: outcomes.length - partition.EXCLUDED, excluded: partition.EXCLUDED, counts: partition });
      if (scoreEligible && (run.executionState !== 'COMPLETED' || outcomes.some(outcome => ['FAILED', 'CANCELLED', 'PENDING'].includes(outcome.status)))) {
        stats.get(cellId).reasons.add('OBSERVED_EXECUTION_FAILED');
      }
    }
  }
  const cells = loaded.capabilities.cells.map(cell => {
    const current = stats.get(cell.cellId), measured = current.cases.length > 0 || current.unmatched > 0 || current.reasons.size > 0;
    const samples = sampleCounts(loaded.fixtures, cell.cellId);
    const failures = measured ? thresholds(current, cell) : [];
    const blockers = [loaded.executionAttested ? 'EXECUTION_ATTESTATION_LOCAL_UNSIGNED' : 'PRODUCT_EXECUTION_UNVERIFIED', 'PATTERN_ALLOCATION_UNREVIEWED'];
    if (loaded.corpus.purpose === 'DEVELOPMENT_BASELINE') blockers.push('DEVELOPMENT_MATERIAL_ONLY');
    if (!['P', 'S'].includes(cell.capability) && current.tp + current.fp < 200) blockers.push('WILSON_SAMPLE_MISSING');
    const required = cell.sampleRequirements;
    if (samples.evaluationPositive < required.positive || samples.evaluationNegative < required.negative
      || samples.holdoutPositive < required.holdoutPositive || samples.holdoutNegative < required.holdoutNegative
      || samples.independentPublicProjects < required.independentProjects || samples.scenarios < required.scenarios
      || samples.parserFiles < required.parserFiles) blockers.push('INSUFFICIENT_EVALUATION_CORPUS');
    if (samples.independentlyReviewedCases < samples.evaluationPositive + samples.evaluationNegative
      || samples.independentlyReviewedCases === 0) blockers.push('INDEPENDENT_ORACLE_REVIEW_MISSING');
    const stratumResults = cell.strata.map(stratum => {
      const subStats = strata.get(stratum.stratumId), subSamples = sampleCounts(loaded.fixtures, cell.cellId, stratum.stratumId);
      const subFailures = thresholds(subStats, cell, false);
      const enough = subSamples.evaluationPositive >= stratum.minimumPositive && subSamples.evaluationNegative >= stratum.minimumNegative;
      if (subFailures.length) failures.push('HTTP_STRATUM_FAILED');
      if (!enough) blockers.push('HTTP_STRATUM_SAMPLE_MISSING');
      return { stratumId: stratum.stratumId, result: subFailures.length ? 'FAIL' : subStats.cases.length ? 'BLOCKED' : 'NOT_RUN',
        reasonCodes: subFailures, samples: subSamples, metrics: subStats.cases.length ? values(subStats) : null };
    });
    const counts = measured ? Object.fromEntries(Object.entries(current).filter(([key]) => !['candidatePrecisions', 'candidateRecalls', 'reasons', 'cases'].includes(key))) : null;
    return { cellId: cell.cellId, publicSupported: false, result: failures.length ? 'FAIL' : measured ? 'BLOCKED' : 'NOT_RUN',
      scoreScope: loaded.corpus.purpose, sampleRequirements: required, samples, counts, metrics: measured ? values(current) : null,
      failureCodes: [...new Set(failures)].sort(), blockerCodes: [...new Set(blockers)].sort(), strata: stratumResults,
      patterns: cell.patterns.map(patternId => ({ patternId,
        authoredCases: loaded.fixtures.reduce((total, fixture) => total + fixture.cases.filter(item => item.cellId === cell.cellId && item.patternId === patternId).length, 0),
        scoredCases: current.cases.filter(item => item.patternId === patternId).length,
        allocationStatus: 'PENDING_INDEPENDENT_REVIEW' })) };
  });
  return { cells, coverage, checkedFacts, caseFailures, annotationReviewQueue, scoringSplits, scoredRuns, unscoredDevelopmentRuns,
    failed: cells.some(cell => cell.failureCodes.length > 0),
    observationEvaluation: scoredRuns > 0 ? cells.some(cell => cell.failureCodes.length > 0) ? 'FAIL' : 'PASS' : 'NOT_RUN',
    macro: { precision: mean(cells.map(cell => cell.metrics?.precision).filter(value => value != null)),
      recall: mean(cells.map(cell => cell.metrics?.recall).filter(value => value != null)) } };
}

module.exports = { evaluate, ratio, mean, wilsonLower, candidateMetrics, counters, thresholds };
