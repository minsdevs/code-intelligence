'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateSpaceBudget } = require('../candidate-capacity.cjs');
const { MINIMUM_FREE_BYTES } = require('../../../desktop/scripts/macos-runtime-supply.cjs');

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const valid = () => ({ dependencyBytes: 3 * GiB, sourceBytes: 256 * MiB, runtimeBytes: 2 * GiB,
  electronBytes: 512 * MiB, analyzerDependencyBytes: 400 * MiB });

test('candidate reuse budget applies the documented copy allowances with 64 MiB rounding', () => {
  const result = candidateSpaceBudget(valid());
  const unrounded = 3n * 1024n ** 3n + 256n * 1024n ** 2n + 4n * 1024n ** 3n + 512n * 1024n ** 2n
    + 1024n * 1024n ** 2n + 1024n * 1024n ** 2n + 256n * 1024n ** 2n + 2n * 1024n ** 3n;
  const quantum = 64n * 1024n ** 2n, expected = ((unrounded + quantum - 1n) / quantum) * quantum;
  assert.equal(result.policy, 'VERIFIED_RUNTIME_REUSE_COPY_ALLOWANCE_V1');
  assert.equal(result.requiredFreeBytes, expected.toString());
  assert.equal(result.breakdown.analyzerCopiesBytes, String(1024n * 1024n ** 2n));
  assert.equal(result.breakdown.unroundedRequiredBytes, unrounded.toString());
  assert.equal(result.limit, 'Planning allowance based on measured logical copy bytes; not a disk reservation, physical-allocation prediction or hard write bound');
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.breakdown), true);
});

test('required capacity is always rounded upward to a 64 MiB boundary', () => {
  const input = valid(); input.sourceBytes = 1;
  const required = BigInt(candidateSpaceBudget(input).requiredFreeBytes), quantum = 64n * 1024n ** 2n;
  assert.equal(required % quantum, 0n);
  assert(required > BigInt(input.dependencyBytes + input.sourceBytes));
});

test('increasing dependency bytes increases the required allowance', () => {
  const small = valid(), large = valid(); large.dependencyBytes += 64 * MiB;
  assert(BigInt(candidateSpaceBudget(large).requiredFreeBytes) > BigInt(candidateSpaceBudget(small).requiredFreeBytes));
});

test('large measured inputs can require more than the provisioning eight-GiB floor', () => {
  const input = valid(); input.dependencyBytes = 20 * GiB;
  assert(BigInt(candidateSpaceBudget(input).requiredFreeBytes) > 8n * 1024n ** 3n);
});

test('source bytes may be zero while other measured inputs must be positive safe integers', () => {
  const input = valid(); input.sourceBytes = 0;
  assert.doesNotThrow(() => candidateSpaceBudget(input));
  for (const key of ['dependencyBytes', 'runtimeBytes', 'electronBytes', 'analyzerDependencyBytes']) {
    const value = valid(); value[key] = 0;
    assert.throws(() => candidateSpaceBudget(value), /CANDIDATE_CAPACITY_INPUT/);
  }
});

test('missing, non-finite, negative, fractional, unsafe and extra inputs are refused', () => {
  const cases = [];
  const missing = valid(); delete missing.runtimeBytes; cases.push(missing);
  for (const bad of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const value = valid(); value.sourceBytes = bad; cases.push(value); }
  cases.push({ ...valid(), extra: 1 });
  for (const value of cases) assert.throws(() => candidateSpaceBudget(value), /CANDIDATE_CAPACITY_INPUT/);
});

test('per-field planning caps reject oversized logical byte measurements', () => {
  const dependency = valid(); dependency.dependencyBytes = 48 * GiB + 1;
  const runtime = valid(); runtime.runtimeBytes = 16 * GiB + 1;
  assert.throws(() => candidateSpaceBudget(dependency), /CANDIDATE_CAPACITY_INPUT/);
  assert.throws(() => candidateSpaceBudget(runtime), /CANDIDATE_CAPACITY_INPUT/);
});

test('the pure calculation does not mutate its input and the provisioning floor remains eight GiB', () => {
  const input = valid(), before = { ...input };
  candidateSpaceBudget(input);
  assert.deepEqual(input, before);
  assert.equal(MINIMUM_FREE_BYTES, 8n * 1024n ** 3n);
});

test('an xpc-required candidate adds two worker Electron rewrites to the allowance', () => {
  const base = candidateSpaceBudget(valid()), isolated = candidateSpaceBudget(valid(), { adapterSupervisor: true });
  assert.equal(isolated.breakdown.adapterSupervisorAllowanceBytes, String(2n * 512n * 1024n ** 2n));
  assert.equal(base.breakdown.adapterSupervisorAllowanceBytes, undefined);
  assert.equal(BigInt(isolated.breakdown.unroundedRequiredBytes) - BigInt(base.breakdown.unroundedRequiredBytes), 2n * 512n * 1024n ** 2n);
});
