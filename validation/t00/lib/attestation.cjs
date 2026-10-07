'use strict';

// Verifies a local execution attestation written by the harness that ran the product
// (validation/pre-release/accuracy-export.cjs or accuracy-packaged-export.cjs). It binds the
// exact observation bytes, corpus, consumed roster bytes and a build digest that must be
// derived from the listed build components. With --product-artifact-root the runner re-hashes
// those components on disk. The attestation is unsigned and local: it proves a consistent
// binding to an existing artifact, not a third-party-witnessed execution.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireThat, ContractError } = require('./errors.cjs');
const { stableJson } = require('./json.cjs');
const { sha256, relativePath, checkedAbsolute, within } = require('./safe-io.cjs');
const { sourceDigest } = require('./contracts.cjs');

const KINDS = new Set(['BACKEND_PIPELINE_HARNESS', 'PACKAGED_APP_API']);
const ARTIFACT_BUDGET = 4 * 1024 ** 3;

function hashFile(file, budget) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), 'ARTIFACT_PATH_INVALID');
  budget.bytes += stat.size; requireThat(budget.bytes <= ARTIFACT_BUDGET, 'ARTIFACT_TOO_LARGE');
  const hash = crypto.createHash('sha256'), descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

// Same digest as the exporters: "relative\tsha256\n" lines sorted by UTF-16 code unit order.
function artifactDigest(target, budget) {
  const stat = fs.lstatSync(target);
  requireThat(!stat.isSymbolicLink(), 'ARTIFACT_PATH_INVALID');
  if (stat.isFile()) return { kind: 'FILE', files: 1, sha256: sha256(Buffer.from(path.basename(target) + '\t' + hashFile(target, budget) + '\n')) };
  requireThat(stat.isDirectory(), 'ARTIFACT_PATH_INVALID');
  const files = [];
  (function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), entry = fs.lstatSync(file);
      requireThat(!entry.isSymbolicLink(), 'ARTIFACT_PATH_INVALID');
      if (entry.isDirectory()) walk(file);
      else { requireThat(entry.isFile(), 'ARTIFACT_PATH_INVALID'); files.push(path.relative(target, file).split(path.sep).join('/')); }
      requireThat(files.length <= 200000, 'ARTIFACT_TOO_LARGE');
    }
  })(target);
  files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const lines = files.map(file => file + '\t' + hashFile(path.join(target, file), budget) + '\n').join('');
  return { kind: 'DIRECTORY_TREE', files: files.length, sha256: sha256(Buffer.from(lines)) };
}

function verifyAttestation(io, validate, options, loaded) {
  requireThat(options.productBuildSha256 != null, 'PRODUCT_BUILD_MISSING');
  const attestationPath = checkedAbsolute(options.executionAttestation);
  const bytes = io.read(attestationPath);
  const { parseJson } = require('./json.cjs');
  const attestation = validate('attestation', parseJson(bytes));
  const observationRecord = io.inputs.get(checkedAbsolute(options.observations));
  requireThat(observationRecord != null && attestation.observationsSha256 === observationRecord.sha256, 'ATTESTATION_BINDING_MISMATCH');
  requireThat(attestation.corpusSha256 === loaded.corpusSha256
    && attestation.capabilityManifestSha256 === loaded.capabilityManifestSha256, 'ATTESTATION_BINDING_MISMATCH');
  requireThat(KINDS.has(attestation.kind) && attestation.build.path === attestation.kind, 'ATTESTATION_KIND_INVALID');
  // The digest is derived from the listed components; an arbitrary declared digest is refused.
  requireThat(attestation.productBuildSha256 === sha256(Buffer.from(stableJson(attestation.build))), 'ATTESTATION_DIGEST_NOT_DERIVED');
  requireThat(attestation.productBuildSha256 === loaded.observations.provenance.productBuildSha256
    && attestation.productBuildSha256 === options.productBuildSha256, 'BUILD_DIGEST_MISMATCH');
  const names = new Set();
  for (const component of attestation.build.components) {
    requireThat(!names.has(component.name), 'DUPLICATE_ID'); names.add(component.name); relativePath(component.path);
  }
  requireThat(attestation.runs.length === loaded.fixtures.length, 'ATTESTATION_SOURCE_MISMATCH');
  const runIds = new Set();
  for (const run of attestation.runs) {
    requireThat(!runIds.has(run.fixtureId), 'DUPLICATE_ID'); runIds.add(run.fixtureId);
    const fixture = loaded.fixtures.find(item => item.manifest.fixtureId === run.fixtureId);
    requireThat(fixture != null && run.sourceDigest === fixture.sourceDigest
      && sourceDigest(fixture.manifest.source) === fixture.sourceDigest, 'ATTESTATION_SOURCE_MISMATCH');
    // The harness hashed the bytes it actually fed to the product; they must be the whole roster.
    const roster = fixture.manifest.source.map(item => stableJson([item.path, item.sha256, item.bytes])).sort();
    const consumed = run.consumedSources.map(item => stableJson([item.path, item.sha256, item.bytes])).sort();
    requireThat(stableJson(roster) === stableJson(consumed), 'ATTESTATION_SOURCE_MISMATCH');
    const observed = loaded.observations.runs.find(item => item.fixtureId === run.fixtureId);
    requireThat(observed != null && (observed.executionState === 'COMPLETED') === (run.executionState === 'COMPLETED'), 'ATTESTATION_BINDING_MISMATCH');
  }
  let artifactVerification = 'NOT_RUN';
  const checkedComponents = [];
  if (options.productArtifactRoot) {
    const root = checkedAbsolute(options.productArtifactRoot), budget = { bytes: 0 };
    for (const component of attestation.build.components) {
      const target = path.join(root, component.path);
      requireThat(within(root, target), 'ARTIFACT_PATH_INVALID');
      let actual;
      try { actual = artifactDigest(checkedAbsolute(target), budget); }
      catch (error) { if (error instanceof ContractError) throw error; throw new ContractError('ARTIFACT_PATH_INVALID'); }
      requireThat(actual.sha256 === component.sha256 && actual.files === component.files && actual.kind === component.kind, 'ARTIFACT_DIGEST_MISMATCH');
      checkedComponents.push({ name: component.name, kind: actual.kind, files: actual.files, sha256: actual.sha256 });
    }
    artifactVerification = 'VERIFIED';
  }
  return { kind: attestation.kind, attestationSha256: sha256(bytes), productExecutionVerification: 'HARNESS_ATTESTED_UNSIGNED',
    artifactVerification, components: attestation.build.components.map(item => ({ name: item.name, kind: item.kind, sha256: item.sha256 })),
    checkedComponents, revision: attestation.build.revision ?? null, dirtyProductPaths: attestation.build.dirtyProductPaths ?? null, signed: false };
}

module.exports = { verifyAttestation, artifactDigest };
