'use strict';

// Binds the candidate's bundled JRE (a jlink image) to the Temurin JDK supply
// record in desktop/scripts/macos-runtime-supply.json (`jre`). The generator
// only compares the version and vendor witnesses read from the image with the
// record; the image bytes differ from the JDK archive by design (jlink, staging
// rewrites and signing), so archive-to-image identity is not claimed here.
const RECORD_VENDOR = 'Eclipse Adoptium';

// Adoptium release naming, e.g. 21.0.12+8 ->
// .../jdk-21.0.12%2B8/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz
function releaseUrl(version, asset) {
  const [feature] = version.split('.');
  return `https://github.com/adoptium/temurin${feature}-binaries/releases/download/jdk-${version.replace('+', '%2B')}/OpenJDK${feature}U-${asset}_${version.replace('+', '_')}.tar.gz`;
}

function validateRecord(record) {
  const errors = [];
  const check = (ok, field) => { if (!ok && !errors.includes(field)) errors.push(field); };
  const version = typeof record?.version === 'string' && /^21\.[0-9]+\.[0-9]+\+[0-9]+$/.test(record.version) ? record.version : null;
  check(record?.vendor === RECORD_VENDOR, 'vendor');
  check(version, 'version');
  check(version && record.fullVersion === `${version}-LTS`, 'fullVersion');
  check(version && record.vendorVersion === `Temurin-${version}`, 'vendorVersion');
  check(version && record.url === releaseUrl(version, 'jdk_aarch64_mac_hotspot'), 'url');
  check(typeof record?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256), 'sha256');
  check(Number.isSafeInteger(record?.bytes) && record.bytes > 0, 'bytes');
  check(typeof record?.checksumSource === 'string' && record.checksumSource.length >= 20, 'checksumSource');
  check(typeof record?.sourceRevision === 'string' && /^[a-f0-9]{12,40}$/.test(record.sourceRevision), 'sourceRevision');
  check(typeof record?.sourceRevision === 'string' && record.sourceUrl === `https://github.com/adoptium/jdk21u/tree/${record.sourceRevision}`, 'sourceUrl');
  check(version && record.sourceArchiveUrl === releaseUrl(version, 'jdk-sources'), 'sourceArchiveUrl');
  check(record?.license === 'GPL-2.0-only WITH Classpath-exception-2.0', 'license');
  return errors;
}

// observed: { buildWitness, javaVersion, vendorWitness } from the image.
function provenance(record, observed) {
  const empty = { recordedSourceUrl: null, recordedSha256: null };
  if (!record) return { ...empty, status: 'FAIL_NO_SUPPLY_RECORD' };
  const errors = validateRecord(record);
  if (errors.length) return { ...empty, status: 'FAIL_SUPPLY_RECORD_INVALID', errors };
  const mismatches = [];
  if (observed.buildWitness !== record.fullVersion) mismatches.push('fullVersion');
  if (observed.javaVersion !== record.version.split('+')[0]) mismatches.push('version');
  if (observed.vendorWitness !== record.vendor) mismatches.push('vendor');
  return { status: mismatches.length ? 'FAIL_SUPPLY_RECORD_MISMATCH' : 'RECORDED_MATCH', mismatches,
    recordedSourceUrl: record.url, recordedSha256: record.sha256, recordedBytes: record.bytes, checksumSource: record.checksumSource,
    vendorVersion: record.vendorVersion, sourceRevision: record.sourceRevision, sourceUrl: record.sourceUrl, sourceArchiveUrl: record.sourceArchiveUrl,
    imageToArchiveBytes: 'NOT_VERIFIED_BY_GENERATOR' };
}

// CycloneDX externalReferences for a recorded JRE; none without a matching record.
function externalReferences(result) {
  if (result?.status !== 'RECORDED_MATCH') return undefined;
  const source = 'Corresponding source %s (GPL-2.0 WITH Classpath-exception-2.0)';
  return [{ type: 'distribution', url: result.recordedSourceUrl, hashes: [{ alg: 'SHA-256', content: result.recordedSha256 }],
    comment: 'Eclipse Temurin JDK archive the jlink image is built from' },
  { type: 'vcs', url: result.sourceUrl, comment: source.replace('%s', 'revision') },
  { type: 'distribution', url: result.sourceArchiveUrl, comment: source.replace('%s', 'archive') }];
}

module.exports = { releaseUrl, validateRecord, provenance, externalReferences };
