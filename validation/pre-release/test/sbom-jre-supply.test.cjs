'use strict';

// JRE supply record (supply-chain defect D4): the repository record of the
// Temurin JDK the bundled jlink image is built from, and how the SBOM generator
// binds the candidate's JRE witnesses to it. Authored inputs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const supply = require('../../../desktop/scripts/macos-runtime-supply.json');
const { validateSupply } = require('../../../desktop/scripts/macos-runtime-supply.cjs');
const jre = require('../sbom-jre-supply.cjs');
const sbom = require('../sbom-candidate.cjs');

const copy = () => JSON.parse(JSON.stringify(supply.jre));
const observed = { buildWitness: '21.0.12+8-LTS', javaVersion: '21.0.12', vendorWitness: 'Eclipse Adoptium' };

test('repository records the exact Temurin JDK archive and its source revision', () => {
  const record = supply.jre;
  assert.equal(record.vendor, 'Eclipse Adoptium');
  assert.equal(record.version, '21.0.12+8'); assert.equal(record.fullVersion, '21.0.12+8-LTS'); assert.equal(record.vendorVersion, 'Temurin-21.0.12+8');
  assert.equal(record.url, 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz');
  assert.equal(record.sha256, '021d629349ebc12a409faa517b837ec80ceee8f58a5ac85c788ecad07ca6881c');
  assert.equal(record.bytes, 200069721);
  assert.equal(record.sourceUrl, 'https://github.com/adoptium/jdk21u/tree/04806bcb1d50');
  assert.equal(record.sourceArchiveUrl, 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk-sources_21.0.12_8.tar.gz');
  assert.equal(record.license, 'GPL-2.0-only WITH Classpath-exception-2.0');
  assert.match(record.checksumSource, /not compared with the Adoptium-published checksum/);
  assert.deepEqual(jre.validateRecord(record), []);
  // The record sits beside the four C sources; source provisioning is unchanged.
  assert.equal(validateSupply(supply), supply);
  assert.deepEqual(supply.sources.map(item => item.id), ['openssl', 'postgres', 'redis', 'pgvector']);
});

test('a record matching the candidate witnesses becomes the JRE provenance', () => {
  const result = jre.provenance(supply.jre, observed);
  assert.equal(result.status, 'RECORDED_MATCH');
  assert.equal(result.recordedSourceUrl, supply.jre.url); assert.equal(result.recordedSha256, supply.jre.sha256);
  assert.equal(result.sourceUrl, supply.jre.sourceUrl); assert.equal(result.sourceArchiveUrl, supply.jre.sourceArchiveUrl);
  assert.equal(result.imageToArchiveBytes, 'NOT_VERIFIED_BY_GENERATOR');
  assert.deepEqual(result.mismatches, []);
});

test('a missing, malformed or mismatched record fails the JRE provenance', () => {
  assert.equal(jre.provenance(undefined, observed).status, 'FAIL_NO_SUPPLY_RECORD');
  assert.equal(jre.provenance(null, observed).recordedSha256, null);
  for (const [field, value] of [['sha256', 'A'.repeat(64)], ['version', '21.0.12'], ['url', supply.jre.url.replace('aarch64', 'x64')],
    ['sourceUrl', 'https://github.com/adoptium/jdk21u'], ['sourceArchiveUrl', supply.jre.sourceArchiveUrl.replace('_8.tar', '_9.tar')],
    ['vendor', ''], ['bytes', 0], ['checksumSource', '']]) {
    const record = copy(); record[field] = value;
    const result = jre.provenance(record, observed);
    assert.equal(result.status, 'FAIL_SUPPLY_RECORD_INVALID', field); assert.ok(result.errors.includes(field), field);
  }
  for (const [witness, value, mismatch] of [['buildWitness', '21.0.13+11-LTS', 'fullVersion'], ['javaVersion', '21.0.11', 'version'],
    ['vendorWitness', 'Azul Systems, Inc.', 'vendor'], ['buildWitness', null, 'fullVersion'], ['vendorWitness', null, 'vendor']]) {
    const result = jre.provenance(supply.jre, { ...observed, [witness]: value });
    assert.equal(result.status, 'FAIL_SUPPLY_RECORD_MISMATCH', witness); assert.deepEqual(result.mismatches, [mismatch], witness);
  }
});

test('the CycloneDX component carries the recorded archive and source as external references', () => {
  const component = (ref, extra) => ({ ref, files: [{ sha256: 'a'.repeat(64), location: 'x' }], noticeEvidence: [], properties: {}, ...extra });
  const result = provenance => ({ product: { name: 'App', version: '1.0.0', bundleId: 'x', minimumSystemVersion: '13.0' }, unattributed: [],
    components: new Map([['temurin-jre', component('temurin-jre', { kind: 'jre', type: 'platform', name: 'eclipse-temurin-jre (jlink image)',
      version: '21.0.12+8-LTS', licenceSourceKind: 'REVIEWED_POLICY_ASSERTION', provenance, externalReferences: jre.externalReferences(provenance), licence: { class: 'STRONG_COPYLEFT', chosen: [] } })]]) });
  const meta = { serial: '01234567-89ab-5cde-8f01-23456789abcd', timestamp: '2026-10-07T00:00:00.000Z', toolSha256: 'b'.repeat(64),
    bundleTreeDigest: 'c'.repeat(64), buildSequence: 1, candidate: '.native-product-X' };
  const bom = sbom.cycloneDx(result(jre.provenance(supply.jre, observed)), meta);
  assert.deepEqual(sbom.validateCycloneDx(bom), []);
  const [item] = bom.components;
  assert.deepEqual(item.externalReferences, [
    { type: 'distribution', url: supply.jre.url, hashes: [{ alg: 'SHA-256', content: supply.jre.sha256 }], comment: 'Eclipse Temurin JDK archive the jlink image is built from' },
    { type: 'vcs', url: supply.jre.sourceUrl, comment: 'Corresponding source revision (GPL-2.0 WITH Classpath-exception-2.0)' },
    { type: 'distribution', url: supply.jre.sourceArchiveUrl, comment: 'Corresponding source archive (GPL-2.0 WITH Classpath-exception-2.0)' }]);
  const missing = sbom.cycloneDx(result(jre.provenance(undefined, observed)), meta);
  assert.equal(missing.components[0].externalReferences, undefined);
  assert.match(missing.components[0].properties.find(entry => entry.name === 'ci:provenance').value, /FAIL_NO_SUPPLY_RECORD/);
  const broken = sbom.cycloneDx(result(jre.provenance(supply.jre, observed)), meta);
  broken.components[0].externalReferences[0].hashes[0].content = 'nothex';
  broken.components[0].externalReferences[1].type = 'source';
  assert.deepEqual(sbom.validateCycloneDx(broken), ['components[0]: externalReference', 'components[0]: externalReference']);
});
