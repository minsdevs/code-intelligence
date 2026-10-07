#!/usr/bin/env node
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { ContractError, requireThat } = require('./lib/errors.cjs');
const { SafeIO, sha256, writeNew } = require('./lib/safe-io.cjs');
const { loadContracts, validator } = require('./lib/contracts.cjs');
const { verifyAttestation } = require('./lib/attestation.cjs');
const { evaluate } = require('./lib/metrics.cjs');
const { VERSION, CELLS, THRESHOLDS } = require('./lib/policy.cjs');
const { LIMITS } = require('./lib/json.cjs');

function argumentsFor(argv) {
  const options = {}, names = new Map([['--mode', 'mode'], ['--corpus', 'corpus'], ['--capabilities', 'capabilities'],
    ['--observations', 'observations'], ['--product-build-sha256', 'productBuildSha256'], ['--output', 'output'],
    ['--execution-attestation', 'executionAttestation'], ['--product-artifact-root', 'productArtifactRoot']]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--offline') { requireThat(!options.offline, 'DUPLICATE_OPTION'); options.offline = true; continue; }
    requireThat(names.has(flag) && index + 1 < argv.length, 'INVALID_ARGUMENTS');
    const name = names.get(flag); requireThat(!Object.hasOwn(options, name), 'DUPLICATE_OPTION');
    options[name] = argv[++index];
  }
  requireThat(['contract', 'gate'].includes(options.mode) && options.corpus && options.capabilities && options.output && options.offline, 'INVALID_ARGUMENTS');
  if (options.productBuildSha256 != null) requireThat(/^[a-f0-9]{64}$/.test(options.productBuildSha256), 'BUILD_DIGEST_INVALID');
  requireThat(options.mode !== 'contract' || (!options.observations && !options.productBuildSha256 && !options.executionAttestation
    && !options.productArtifactRoot), 'MODE_OPTION_CONFLICT');
  // An attestation only binds a supplied observation bundle; an artifact root only re-checks an attestation.
  requireThat(!options.executionAttestation || options.observations, 'MODE_OPTION_CONFLICT');
  requireThat(!options.productArtifactRoot || options.executionAttestation, 'MODE_OPTION_CONFLICT');
  return options;
}

function emptyCells() {
  return CELLS.map(cell => ({ cellId: cell.cellId, publicSupported: false, result: 'NOT_RUN', metrics: null,
    failureCodes: [], blockerCodes: ['PRODUCT_EXECUTION_UNVERIFIED', 'INDEPENDENT_ORACLE_REVIEW_MISSING'] }));
}

function main(argv) {
  let options;
  try { options = argumentsFor(argv); }
  catch (error) { return summary(1, 'FAIL', error instanceof ContractError ? error.code : 'INTERNAL_ERROR'); }
  const io = new SafeIO(), scope = options.mode === 'contract' ? 'CONTRACT_ONLY' : 'PRODUCT_GATE';
  let loaded, evaluation, errorCode, runnerDigest, attested;
  try {
    io.protect(__dirname);
    // Reserve every input's existing parent before checking any leaf. A missing
    // corpus or observation file must not erase its output-exclusion boundary.
    let parentError;
    for (const file of [options.corpus, options.capabilities, options.observations, options.executionAttestation].filter(Boolean)) {
      try { io.protectInputParent(file); } catch (error) { parentError ??= error; }
    }
    if (parentError) throw parentError;
    // Hash the actual implementation and schema, not a Git HEAD that may omit dirty changes.
    const implementation = ['runner.cjs', 'lib/errors.cjs', 'lib/json.cjs', 'lib/safe-io.cjs', 'lib/policy.cjs',
      'lib/contracts.cjs', 'lib/metrics.cjs', 'lib/attestation.cjs', 'schemas/contracts.schema.json'];
    runnerDigest = sha256(Buffer.from(implementation.map(file => file + ':' + sha256(io.read(path.join(__dirname, file)))).join('\n')));
    loaded = loadContracts(io, options);
    if (options.executionAttestation && loaded.observations) {
      if (options.productArtifactRoot) io.protect(options.productArtifactRoot);
      attested = verifyAttestation(io, validator(io), options, loaded);
      loaded.executionAttested = true;
    }
    evaluation = evaluate(loaded);
    io.assertUnchanged();
  } catch (error) {
    errorCode = error instanceof ContractError ? error.code : 'INTERNAL_ERROR';
    try { io.assertUnchanged(); }
    catch (verificationError) { if (verificationError.code === 'INPUT_CHANGED') errorCode = 'INPUT_CHANGED'; }
  }
  const failed = errorCode != null || evaluation?.failed === true;
  const result = failed ? 'FAIL' : options.mode === 'contract' ? 'PASS' : 'BLOCKED';
  const exitCode = failed ? 1 : options.mode === 'contract' ? 0 : 2;
  const blockerCodes = options.mode === 'gate' ? [attested && !errorCode ? 'EXECUTION_ATTESTATION_LOCAL_UNSIGNED' : 'PRODUCT_EXECUTION_UNVERIFIED',
    'INDEPENDENT_ORACLE_REVIEW_MISSING', 'FULL_EVALUATION_CORPUS_MISSING'] : [];
  if (options.mode === 'gate' && loaded?.corpus?.purpose === 'DEVELOPMENT_BASELINE') blockerCodes.push('DEVELOPMENT_MATERIAL_ONLY');
  if (options.mode === 'gate' && (!options.observations || loaded?.observationMissing)) blockerCodes.push('OBSERVATIONS_MISSING');
  if (options.mode === 'gate' && !options.productBuildSha256) blockerCodes.push('PRODUCT_BUILD_MISSING');
  const report = {
    contractVersion: VERSION, runId: crypto.randomUUID(), createdAt: new Date().toISOString(), scope, result, exitCode,
    corpusPurpose: loaded?.corpus?.purpose ?? null,
    contractResult: errorCode ? 'FAIL' : 'PASS', observationEvaluation: evaluation?.observationEvaluation ?? 'NOT_RUN',
    productEvaluation: options.mode === 'contract' ? 'NOT_RUN' : 'BLOCKED',
    releaseGate: { gateId: 'G-ACCURACY', result: 'BLOCKED', publicSupported: false },
    planned300AnnotationPilot: { result: 'NOT_RUN', independentlyReviewedAnnotations: 0, reviewerTimeMeasured: false },
    buildBinding: { callerProvidedSha256: options.productBuildSha256 ?? null,
      observationDeclaredSha256: loaded?.observations?.provenance.productBuildSha256 ?? null,
      comparison: errorCode === 'BUILD_DIGEST_MISMATCH' ? 'MISMATCH' : options.productBuildSha256 && loaded?.observations ? 'MATCH' : 'MISSING',
      artifactVerification: attested && !errorCode ? attested.artifactVerification : 'NOT_RUN',
      productExecutionVerification: attested && !errorCode ? attested.productExecutionVerification : 'NOT_RUN' },
    executionAttestation: attested && !errorCode ? { kind: attested.kind, attestationSha256: attested.attestationSha256, signed: false,
      revision: attested.revision, dirtyProductPaths: attested.dirtyProductPaths, components: attested.components,
      artifactRecheck: attested.checkedComponents } : null,
    observationProvenance: loaded?.observations?.provenance.kind ?? null,
    scoringSplits: evaluation?.scoringSplits ?? [], scoredRuns: evaluation?.scoredRuns ?? 0,
    unscoredDevelopmentRuns: evaluation?.unscoredDevelopmentRuns ?? 0,
    oracleProvenance: 'DECLARATIONS_ONLY_IDENTITY_NOT_AUTHENTICATED',
    errorCodes: errorCode ? [errorCode] : [], blockerCodes,
    thresholds: THRESHOLDS, cells: evaluation?.cells ?? emptyCells(), macro: evaluation?.macro ?? null,
    caseFailures: evaluation?.caseFailures ?? [], annotationReviewQueue: evaluation?.annotationReviewQueue ?? [], resourceMeasurement: 'NOT_RUN',
    limitations: ['T00A_CONTRACT_FRAMEWORK_ONLY', attested && !errorCode ? 'LOCAL_UNSIGNED_EXECUTION_ATTESTATION_NO_INDEPENDENT_ORACLE'
      : 'NO_INDEPENDENT_ORACLE_OR_REAL_PRODUCT_EXECUTION_PROOF',
      'NO_PUBLIC_SUPPORT_PROMOTION', 'NO_CONCURRENT_ANCESTOR_SWAP_CONFINEMENT'],
  };
  let output;
  try { output = io.createOutput(options.output); }
  catch (error) { return summary(1, 'FAIL', error instanceof ContractError ? error.code : 'OUTPUT_UNAVAILABLE'); }
  try {
    const files = [], json = value => JSON.stringify(value, null, 2) + '\n';
    files.push(writeNew(output, 'report.json', json(report)));
    const failure = result === 'FAIL' ? '<failure message="T00_VALIDATION_FAILED"/>' : result === 'BLOCKED' ? '<skipped message="PRODUCT_GATE_BLOCKED"/>' : '';
    files.push(writeNew(output, 'junit.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<testsuite name="T00a-${scope}" tests="1" failures="${result === 'FAIL' ? 1 : 0}" skipped="${result === 'BLOCKED' ? 1 : 0}">`
      + `<properties><property name="productEvaluation" value="${report.productEvaluation}"/></properties>`
      + `<testcase classname="T00a" name="${scope}">${failure}</testcase></testsuite>\n`));
    files.push(writeNew(output, 'coverage-partition.json', json({ contractVersion: VERSION, scope,
      result: loaded?.observations && !errorCode ? 'PASS' : errorCode ? 'FAIL' : 'NOT_RUN',
      measurement: loaded?.observations?.provenance.kind ?? 'NOT_RUN', partitions: evaluation?.coverage ?? [] })));
    files.push(writeNew(output, 'resource-samples.csv', 'scope,status,sample_index,duration_ms,process_tree_rss_bytes\n' + scope + ',NOT_RUN,,,\n'));
    files.push(writeNew(output, 'evidence-check.json', json({ contractVersion: VERSION, scope,
      result: errorCode ? 'FAIL' : loaded?.observations ? 'PASS' : 'NOT_RUN',
      observationSourceBindingsChecked: evaluation?.checkedFacts ?? 0, productProducerConsumedTheseBytes: attested && !errorCode ? 'HARNESS_ATTESTED_UNSIGNED' : 'NOT_VERIFIED' })));
    const manifest = { contractVersion: VERSION, runId: report.runId, scope, runnerSha256: runnerDigest ?? null,
      tools: { node: process.version, platform: process.platform, architecture: process.arch }, limits: LIMITS,
      inputs: io.inputManifest(), outputs: files, selfHash: null, selfHashReason: 'MANIFEST_EXCLUDED_TO_AVOID_SELF_REFERENCE',
      inputPaths: 'OMITTED', sourceText: 'OMITTED', productBuildSha256: options.productBuildSha256 ?? null };
    writeNew(output, 'artifact-manifest.json', json(manifest));
  } catch { return summary(1, 'FAIL', 'ARTIFACT_WRITE_FAILED'); }
  return summary(exitCode, result, errorCode ?? null, scope);
}

function summary(exitCode, result, code, scope = null) {
  // Never print caught Error.message/stack, arbitrary IDs, paths, source, or observation values.
  process.stdout.write(JSON.stringify({ contractVersion: VERSION, scope, result, exitCode, code }) + '\n');
  return exitCode;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, argumentsFor };
