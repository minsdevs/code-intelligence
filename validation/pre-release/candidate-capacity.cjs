'use strict';

const MiB = 1024n ** 2n;
const GiB = 1024n ** 3n;
const KEYS = Object.freeze(['dependencyBytes', 'sourceBytes', 'runtimeBytes', 'electronBytes', 'analyzerDependencyBytes']);
const LIMITS = Object.freeze({ dependencyBytes: 48 * 1024 ** 3, sourceBytes: 16 * 1024 ** 3,
  runtimeBytes: 16 * 1024 ** 3, electronBytes: 16 * 1024 ** 3, analyzerDependencyBytes: 16 * 1024 ** 3 });

// ADR-01 `xpc-required` adds the worker Electron copy: its fuse flip and the signing of the staged
// and packaged service each rewrite the framework binaries instead of cloning them.
function candidateSpaceBudget(input, { adapterSupervisor = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== [...KEYS].sort().join(',')) throw new TypeError('CANDIDATE_CAPACITY_INPUT');
  for (const key of KEYS) {
    const value = input[key];
    if (!Number.isSafeInteger(value) || value < (key === 'sourceBytes' ? 0 : 1) || value > LIMITS[key]) {
      throw new TypeError('CANDIDATE_CAPACITY_INPUT');
    }
  }
  const dependency = BigInt(input.dependencyBytes), source = BigInt(input.sourceBytes), runtime = BigInt(input.runtimeBytes);
  const electron = BigInt(input.electronBytes), analyzer = BigInt(input.analyzerDependencyBytes);
  const analyzerCopyAllowance = 2n * (analyzer > 512n * MiB ? analyzer : 512n * MiB);
  const javaStaticTmpAllowance = 4n * 256n * MiB;
  const generatedAsarAllowance = 256n * MiB;
  const additionalFreeAllowance = 2n * GiB;
  const adapterSupervisorAllowance = adapterSupervisor === true ? 2n * electron : 0n;
  const unrounded = dependency + source + 2n * runtime + electron + analyzerCopyAllowance
    + javaStaticTmpAllowance + generatedAsarAllowance + additionalFreeAllowance + adapterSupervisorAllowance;
  const quantum = 64n * MiB;
  const required = ((unrounded + quantum - 1n) / quantum) * quantum;
  return Object.freeze({
    policy: 'VERIFIED_RUNTIME_REUSE_COPY_ALLOWANCE_V1',
    requiredFreeBytes: required.toString(),
    breakdown: Object.freeze({ dependencyBytes: dependency.toString(), sourceBytes: source.toString(),
      runtimeCopiesBytes: (2n * runtime).toString(), electronBytes: electron.toString(),
      analyzerCopiesBytes: analyzerCopyAllowance.toString(), javaStaticTmpAllowanceBytes: javaStaticTmpAllowance.toString(),
      generatedAsarAllowanceBytes: generatedAsarAllowance.toString(), additionalFreeAllowanceBytes: additionalFreeAllowance.toString(),
      ...(adapterSupervisor === true ? { adapterSupervisorAllowanceBytes: adapterSupervisorAllowance.toString() } : {}),
      unroundedRequiredBytes: unrounded.toString(), roundingQuantumBytes: quantum.toString() }),
    limit: 'Planning allowance based on measured logical copy bytes; not a disk reservation, physical-allocation prediction or hard write bound',
  });
}

module.exports = { candidateSpaceBudget };
