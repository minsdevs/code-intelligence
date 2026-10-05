'use strict';
const assert = require('node:assert/strict'), test = require('node:test'), crypto = require('node:crypto');
const { queriesFromInventory, queryAll, registryUrl, verifyPublicCoordinates } = require('../scan-candidate-advisories.cjs');
test('only explicit external coordinates are selected and private root package metadata is not transmitted', () => {
  const rootHash = crypto.createHash('sha256').update('package.json').digest('hex');
  const input = { kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', packages: [
    { name: 'private-application', version: '1.0.0', evidence: { entryPathSha256: rootHash } },
    { name: 'public-dependency', version: '2.0.0' }], backend: { components: [
      { fileName: 'unknown.jar', metadata: [] },
      { metadata: [{ kind: 'pom', status: 'DECLARED_STATIC_METADATA', fields: { groupId: 'example', artifactId: 'lib', version: '1.0' } }] }] } };
  const result = queriesFromInventory(input);
  assert.equal(result.queries.length, 2); assert.equal(result.omitted.length, 1);
  assert.doesNotMatch(JSON.stringify(result.queries), /private/);
});

test('declared-private dependencies are omitted before registry or OSV disclosure', () => {
  const input = { kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', packages: [
    { name: '@internal/secret', version: '1.0', declaredPrivate: true }, { name: 'public-library', version: '2.0' }], backend: { components: [] } };
  const selected = queriesFromInventory(input);
  assert.equal(selected.queries.length, 1); assert.equal(selected.omitted[0].reason, 'DECLARED_PRIVATE_EXCLUDED');
  assert.doesNotMatch(JSON.stringify(selected), /internal|secret/);
});
test('anonymous public registry confirmation rejects private, missing and mismatched metadata', async () => {
  const queries = ['valid', 'private', 'missing', 'mismatch'].map(name => ({ package: { ecosystem: 'npm', name }, version: '1.0' }));
  const checked = await verifyPublicCoordinates(queries, async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return { status: name === 'missing' ? 404 : 200,
      body: JSON.stringify({ name: name === 'mismatch' ? 'other' : name, version: '1.0', private: name === 'private' }) };
  });
  assert.deepEqual(checked.map(row => row.status), ['ANONYMOUS_PUBLIC_REGISTRY_CONFIRMED', 'PUBLICATION_UNVERIFIED', 'PUBLICATION_UNVERIFIED', 'PUBLICATION_UNVERIFIED']);
  assert.throws(() => registryUrl({ package: { ecosystem: 'Maven', name: 'private/../../:a' }, version: '1.0' }));
});
test('batch pagination follows only the queries with a returned token and preserves result ordering', async () => {
  const queries = [{ package: { name: 'a', ecosystem: 'npm' }, version: '1' }, { package: { name: 'b', ecosystem: 'npm' }, version: '2' }];
  const calls = [];
  const result = await queryAll(queries, async request => {
    calls.push(request);
    return calls.length === 1 ? { results: [{ vulns: [{ id: 'GHSA-first' }], next_page_token: 'page2' }, {}] }
      : { results: [{ vulns: [{ id: 'GHSA-second' }] }] };
  });
  assert.deepEqual(calls[1].queries, [{ ...queries[0], page_token: 'page2' }]);
  assert.deepEqual(result.findings.map(item => item.ids), [['GHSA-first', 'GHSA-second'], []]);
});
test('incomplete or repeated pagination cannot be reported as a complete result', async () => {
  const queries = [{ package: { name: 'a', ecosystem: 'npm' }, version: '1' }];
  await assert.rejects(queryAll(queries, async () => ({ results: [] })));
  await assert.rejects(queryAll(queries, async () => ({ results: [{ next_page_token: 'same' }] })));
});

test('Maven coordinates require matching bytes and filename, never just a current Gradle version', () => {
  const digest = 'a'.repeat(64);
  const inventory = { kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', packages: [{ name: 'public-dependency', version: '1.0' }],
    backend: { components: [{ fileName: 'library.jar', evidence: { sha256: digest }, metadata: [] }] } };
  const artifact = { groupId: 'org.example', artifactId: 'library', version: '2.0', fileName: 'library.jar', sha256: digest };
  const resolved = entries => ({ kind: 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS', components: entries });
  const accepted = queriesFromInventory(inventory, resolved([artifact]));
  assert.equal(accepted.hashMatchedJars, 1); assert.equal(accepted.omitted.length, 0);
  assert.equal(accepted.queries[1].package.name, 'org.example:library');
  for (const changed of [{ ...artifact, sha256: 'b'.repeat(64) }, { ...artifact, fileName: 'other.jar' }]) {
    const declined = queriesFromInventory(inventory, resolved([changed]));
    assert.equal(declined.hashMatchedJars, 0); assert.equal(declined.omitted[0].reason, 'NO_HASH_MATCHED_RESOLVED_COORDINATES');
    assert.equal(declined.queries.length, 1);
  }
  const ambiguous = queriesFromInventory(inventory, resolved([artifact, { ...artifact, groupId: 'other.example' }]));
  assert.equal(ambiguous.hashMatchedJars, 0);
  assert.equal(ambiguous.omitted[0].reason, 'AMBIGUOUS_RESOLVED_COORDINATES');
  inventory.backend.components[0].metadata = [{ kind: 'pom', status: 'DECLARED_STATIC_METADATA',
    fields: { groupId: 'mismatched', artifactId: 'metadata', version: '99' } }];
  const noFallback = queriesFromInventory(inventory, resolved([{ ...artifact, sha256: 'b'.repeat(64) }]));
  assert.equal(noFallback.queries.length, 1);
  assert.equal(noFallback.omitted[0].reason, 'NO_HASH_MATCHED_RESOLVED_COORDINATES');
});

test('only absent resolved input permits legacy POM metadata; supplied malformed values never do', () => {
  const inventory = { kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', packages: [{ name: 'public-dependency', version: '1.0' }],
    backend: { components: [{ fileName: 'library.jar', evidence: { sha256: 'a'.repeat(64) },
      metadata: [{ kind: 'pom', status: 'DECLARED_STATIC_METADATA', fields: { groupId: 'legacy', artifactId: 'metadata', version: '1.0' } }] }] } };
  assert.equal(queriesFromInventory(inventory).queries.length, 2);
  for (const malformed of [null, false, 0, '', [], {}, { kind: 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS', components: null }]) {
    assert.throws(() => queriesFromInventory(inventory, malformed));
  }
  const emptyResolved = queriesFromInventory(inventory, { kind: 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS', components: [] });
  assert.equal(emptyResolved.queries.length, 1);
  assert.equal(emptyResolved.omitted[0].reason, 'NO_HASH_MATCHED_RESOLVED_COORDINATES');
});

test('CLI rejects a supplied null resolved JSON before opening output or sending a registry/OSV request', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
  const source = path.resolve(__dirname, '../scan-candidate-advisories.cjs'), requireSource = createRequire(source);
  const inventory = { kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', packages: [{ name: 'public-dependency', version: '1.0' }],
    backend: { components: [{ metadata: [{ kind: 'pom', status: 'DECLARED_STATIC_METADATA',
      fields: { groupId: 'legacy', artifactId: 'metadata', version: '1.0' } }] }] } };
  let outputs = 0, network = 0;
  const mockFs = { realpathSync: value => value,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 1024 }),
    readFileSync: file => Buffer.from(path.basename(file) === 'resolved.json' ? 'null' : JSON.stringify(inventory)),
    openSync() { outputs++; throw new Error('UNEXPECTED_OUTPUT'); },
  };
  const context = { module: { exports: {} }, __dirname: '/synthetic/validation/pre-release', Buffer,
    require: name => name === 'node:fs' ? mockFs : name === './owned-output.cjs'
      ? { ensureOutputParent: () => '/synthetic/validation/local/pre-release-final' } : requireSource(name),
    fetch: async () => { network++; throw new Error('UNEXPECTED_NETWORK'); } };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  await assert.rejects(context.module.exports.main(['--online-public-packages', '--inventory', 'inventory.json', '--output', 'out.json',
    '--resolved-maven', 'resolved.json']), /RESOLVED_MAVEN_INVALID/);
  assert.equal(outputs, 0); assert.equal(network, 0);
});
