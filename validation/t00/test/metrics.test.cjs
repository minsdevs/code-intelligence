'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ratio, mean, wilsonLower, candidateMetrics, counters, thresholds, evaluate } = require('../lib/metrics.cjs');
const { CELLS } = require('../lib/policy.cjs');

test('zero denominators are undefined; zero successes with a denominator are zero', () => {
  assert.equal(ratio(0, 0), null); assert.equal(ratio(0, 4), 0); assert.equal(mean([]), null);
  assert.equal(mean([1, 0.5, 0]), 0.5); assert.equal(wilsonLower(0, 0), null);
});

test('hand-counted candidate examples distinguish micro precision, recall, and exact set', () => {
  assert.deepEqual(candidateMetrics(['a'], ['a', 'b', 'c', 'd', 'e']),
    { tp: 1, fp: 4, fn: 0, precision: 0.2, recall: 1, exact: false });
  assert.deepEqual(candidateMetrics(['a', 'b'], ['a']),
    { tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5, exact: false });
  assert.deepEqual(candidateMetrics(['a', 'b'], ['b', 'a']),
    { tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, exact: true });
  assert.deepEqual(candidateMetrics([], []),
    { tp: 0, fp: 0, fn: 0, precision: null, recall: null, exact: true });
  assert.deepEqual(candidateMetrics(['a'], []),
    { tp: 0, fp: 0, fn: 1, precision: null, recall: 0, exact: false });
});

test('Wilson 95% lower bound matches independent closed-form boundary cases', () => {
  // For p=1 Wilson simplifies algebraically to n/(n+z²); z=1.96, z²=3.8416.
  assert.ok(Math.abs(wilsonLower(200, 200) - 200 / 203.8416) < 1e-12);
  assert.ok(Math.abs(wilsonLower(1, 1) - 1 / 4.8416) < 1e-12);
  assert.ok(Math.abs(wilsonLower(0, 200)) < 1e-12);
  // p=.5,n=100 simplifies to .5 - .098/sqrt(1.038416).
  assert.ok(Math.abs(wilsonLower(50, 100) - (0.5 - 0.098 / Math.sqrt(1.038416))) < 1e-12);
  assert.ok(wilsonLower(198, 200) > 0.95); assert.ok(wilsonLower(195, 200) < 0.95);
});

const boundaryCases = [
  ['parse success', 'P', { validFiles: 100, validSucceeded: 99 }, { validSucceeded: 98 }, 'PARSE_SUCCESS_BELOW_THRESHOLD'],
  ['invalid diagnostic', 'P', { invalidFiles: 100, invalidDiagnosed: 100 }, { invalidDiagnosed: 99 }, 'INVALID_DIAGNOSTIC_MISSING'],
  ['symbol precision', 'S', { tp: 99, fp: 1, fn: 0 }, { tp: 98, fp: 2 }, 'PRECISION_BELOW_THRESHOLD'],
  ['symbol recall', 'S', { tp: 95, fp: 0, fn: 5 }, { tp: 94, fn: 6 }, 'RECALL_BELOW_THRESHOLD'],
  ['resolved precision', 'C', { tp: 99, fp: 1, fn: 0 }, { tp: 98, fp: 2 }, 'PRECISION_BELOW_THRESHOLD'],
  ['resolved recall', 'C', { tp: 90, fp: 0, fn: 10 }, { tp: 89, fn: 11 }, 'RECALL_BELOW_THRESHOLD'],
  ['candidate precision', 'C', { candidateTp: 90, candidateFp: 10 }, { candidateTp: 89, candidateFp: 11 }, 'CANDIDATE_PRECISION_BELOW_THRESHOLD'],
  ['candidate recall at five', 'C', { candidateTp: 90, candidateFn: 10 }, { candidateTp: 89, candidateFn: 11 }, 'CANDIDATE_RECALL_BELOW_THRESHOLD'],
  ['candidate exact-set accuracy', 'C', { candidateCases: 100, exactCandidateCases: 85 }, { exactCandidateCases: 84 }, 'CANDIDATE_EXACT_SET_BELOW_THRESHOLD'],
];
for (const [name, capability, at, below, reason] of boundaryCases) test(name + ' accepts exact threshold and rejects one count below', () => {
  assert.deepEqual(thresholds(Object.assign(counters(), at), { capability }), []);
  assert.ok(thresholds(Object.assign(counters(), at, below), { capability }).includes(reason));
});

test('insufficient Wilson sample does not turn authored point scores into a statistical pass or failure', () => {
  const stats = Object.assign(counters(), { tp: 1 });
  assert.ok(wilsonLower(1, 1) < 0.95);
  assert.deepEqual(thresholds(stats, { capability: 'C' }), []);
  assert.ok(thresholds(Object.assign(counters(), { tp: 195, fp: 5 }), { capability: 'C' }).includes('WILSON_BELOW_THRESHOLD'));
});

test('one false-resolved or unmatched fact always fails regardless of aggregate precision', () => {
  const stats = Object.assign(counters(), { tp: 10000, falseResolved: 1, unmatched: 1 });
  assert.deepEqual(thresholds(stats, { capability: 'C' }), ['ANNOTATION_REVIEW_REQUIRED', 'FALSE_RESOLVED']);
});

test('one ordinary target error in 100 observations respects aggregate tolerance while retaining the case failure', () => {
  // Pure scorer input: 99 correct targets + 1 wrong target = TP99/FP1/FN1.
  // These ephemeral arithmetic cases are not corpus annotations or independent samples.
  const cases = Array.from({ length: 100 }, (_, index) => ({ caseId: 'case-' + index, cellId: 'J-C', patternId: 'direct-source-call',
    stratum: null, polarity: 'POSITIVE', kind: 'FACT', relationKind: 'CALLS', mustNotEmitResolved: false,
    source: { path: 'synthetic', namespace: 'synthetic', start: index, end: index + 1 },
    expected: { resolution: 'STATIC_RESOLVED', targets: ['wanted'], reasonCode: null } }));
  const fixture = { manifest: { fixtureId: 'arithmetic', split: 'DEVELOPMENT', capabilities: ['J-C'] }, cases, reviewReady: false };
  const facts = cases.map((item, index) => ({ ...item, ...item.expected, observationId: 'observation-' + index,
    targets: index === 0 ? ['wrong'] : ['wanted'] }));
  const result = evaluate({ corpus: { purpose: 'SYNTHETIC_SELF_TEST' }, capabilities: { cells: CELLS },
    cells: new Map(CELLS.map(item => [item.cellId, item])), fixtures: [fixture],
    observations: { runs: [{ fixtureId: 'arithmetic', executionState: 'COMPLETED', outcomes: [], facts }] } });
  assert.equal(result.caseFailures.length, 1); assert.equal(result.failed, false);
  const scored = result.cells.find(item => item.cellId === 'J-C');
  assert.equal(scored.metrics.precision, 0.99); assert.equal(scored.metrics.recall, 0.99);
  assert.equal(scored.result, 'BLOCKED'); assert.equal(scored.publicSupported, false);
});
