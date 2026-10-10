'use strict';
// G-UPDATE packaged acceptance: the validation-build-only loopback update feed (update-validation-feed.cjs).
// Fixture keys in memory only; no real host, release key, signing identity or notarization.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const feeds = require('../src/update-validation-feed.cjs');
const updates = require('../src/update-service.cjs');
const gate = require('../scripts/desktop-build-gate.cjs');
const { startUpdateServer, HOST } = require('./fixtures/update-https-server.cjs');

const release = crypto.generateKeyPairSync('ed25519');
const spki = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
const CA = '-----BEGIN CERTIFICATE-----\n' + Buffer.alloc(96, 7).toString('base64') + '\n-----END CERTIFICATE-----\n';
const feed = (changes = {}) => ({ host: 'updates.validation.invalid', port: 47621, caPem: CA, keyId: 'validation-fixture',
  publicKey: spki(release.publicKey), teamId: 'VALIDATN00', manifestPath: '/stable/manifest.json', ...changes });
const validation = (value = feed()) => ({ name: 'code-intelligence-validation', validationUpdateFeed: value });

test('metadata without a feed yields null; a feed outside a validation build is refused', () => {
  assert.equal(feeds.validationUpdateFeed({ name: 'code-intelligence' }), null);
  assert.equal(feeds.validationUpdateFeed(null), null);
  assert.throws(() => feeds.validationUpdateFeed({ name: 'code-intelligence', validationUpdateFeed: feed() }), { code: 'UPDATE_VALIDATION_FEED_REFUSED' });
  assert.throws(() => feeds.validationUpdateFeed({ name: 'code-intelligence-validation', validationUpdateFeed: null }), { code: 'UPDATE_VALIDATION_FEED_REFUSED' });
});

test('every feed field is validated: host shape, loopback-only port range, PEM, key id, Team ID and manifest path', () => {
  assert.deepEqual({ ...feeds.validationUpdateFeed(validation()) }, feed());
  for (const bad of [{ host: '127.0.0.1' }, { host: 'localhost' }, { port: 80 }, { port: '47621' }, { caPem: 'not pem' }, { keyId: '' },
    { teamId: 'short' }, { teamId: 'lowercase0' }, { manifestPath: 'stable/manifest.json' }, { manifestPath: '/../manifest.json' },
    { publicKey: 42 }, { extra: true }]) {
    assert.throws(() => feeds.validationUpdateFeed(validation(feed(bad))), { code: 'UPDATE_VALIDATION_FEED_REFUSED' }, JSON.stringify(bad));
  }
  const missing = feed(); delete missing.caPem;
  assert.throws(() => feeds.validationUpdateFeed(validation(missing)), { code: 'UPDATE_VALIDATION_FEED_REFUSED' });
});

test('the feed becomes an enabled pinned-key configuration through the product key-file parser', () => {
  const config = feeds.feedUpdateConfig(feeds.validationUpdateFeed(validation()));
  assert.equal(config.enabled, true);
  assert.equal(config.manifestUrl, 'https://updates.validation.invalid/stable/manifest.json');
  assert.deepEqual([...config.allowedHosts], ['updates.validation.invalid']);
  assert.equal(config.teamId, 'VALIDATN00'); assert.equal(config.bundleId, 'dev.codeintelligence.desktop.validation');
  assert.equal(config.pinnedKeys['validation-fixture'].asymmetricKeyType, 'ed25519');
  // A public key that is not Ed25519 SPKI is refused by the same parser.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => feeds.feedUpdateConfig(feeds.validationUpdateFeed(validation(feed({ publicKey: spki(rsa.publicKey) })))), { code: 'UPDATE_KEYS_INVALID' });
});

test('the feed request connects only to loopback for the fixture host, pins the fixture CA and refuses other hosts', async t => {
  const server = await startUpdateServer(t);
  server.routes.set('/stable/manifest.json', { body: Buffer.from('{"ok":true}') });
  const request = feeds.feedRequest(feed({ host: HOST, port: server.port, caPem: server.ca }));
  const response = await request(`https://${HOST}/stable/manifest.json`);
  assert.equal(response.statusCode, 200);
  const chunks = []; for await (const chunk of response.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}');
  assert.deepEqual(server.requests, ['/stable/manifest.json']);
  // Another CA, another host, plain HTTP or an explicit port are refused without a request reaching the server.
  await assert.rejects(feeds.feedRequest(feed({ host: HOST, port: server.port }))(`https://${HOST}/stable/manifest.json`), { code: 'UPDATE_NETWORK' });
  await assert.rejects(request('https://other.example.invalid/stable/manifest.json'), { code: 'UPDATE_NETWORK' });
  await assert.rejects(request(`http://${HOST}/stable/manifest.json`), { code: 'UPDATE_NETWORK' });
  await assert.rejects(request(`https://${HOST}:8443/stable/manifest.json`), { code: 'UPDATE_NETWORK' });
  assert.deepEqual(server.requests, ['/stable/manifest.json']);
});

test('the validation runner keeps codesign/hdiutil/ditto real and records exactly the simulated identity observations', async () => {
  const calls = [];
  const real = async (file, args) => {
    calls.push([file, ...args]);
    if (file === updates.TOOLS.codesign && args[0] === '-dv') return { code: 0, stdout: '', stderr: 'Identifier=dev.codeintelligence.desktop.validation\nTeamIdentifier=not set\n' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const { runner, simulated, note } = feeds.feedRunner(feed(), real);
  assert.match(note, /simulated/);
  assert.deepEqual(await runner(updates.TOOLS.codesign, ['--verify', '--deep', '--strict', '/x.app']), { code: 0, stdout: '', stderr: '' });
  const display = await runner(updates.TOOLS.codesign, ['-dv', '--verbose=4', '/x.app']);
  assert.match(display.stderr, /^TeamIdentifier=VALIDATN00$/m);
  assert.match((await runner(updates.TOOLS.spctl, ['--assess', '--type', 'execute', '-vv', '/x.app'])).stderr, /source=Notarized Developer ID/);
  assert.equal((await runner(updates.TOOLS.xcrun, ['stapler', 'validate', '/x.app'])).code, 0);
  await runner(updates.TOOLS.hdiutil, ['attach', '-readonly', '/x.dmg']);
  assert.deepEqual([...new Set(simulated)].sort(), ['spctl', 'stapler', 'teamIdentifier']);
  // spctl and stapler never reach the real tools; codesign and hdiutil do.
  assert.deepEqual(calls.map(call => call[0]), [updates.TOOLS.codesign, updates.TOOLS.codesign, updates.TOOLS.hdiutil]);
  // A real Team ID (a Developer ID signed app) is passed through untouched.
  const signed = feeds.feedRunner(feed(), async () => ({ code: 0, stdout: '', stderr: 'TeamIdentifier=ABCDE12345\n' }));
  assert.match((await signed.runner(updates.TOOLS.codesign, ['-dv', '/x.app'])).stderr, /TeamIdentifier=ABCDE12345/);
  assert.deepEqual(signed.simulated, []);
});

test('beforePack refuses the feed outside a validation directory build and accepts it there', () => {
  const metadata = validation();
  const context = (appId, targets) => ({ packager: { info: { metadata: {} }, config: { extraMetadata: metadata }, appInfo: { id: appId } }, targets });
  assert.throws(() => gate.requireValidationOnlyUpdateFeed(context('dev.codeintelligence.desktop', [{ name: 'dir' }])), { code: 'VALIDATION_UPDATE_FEED_REFUSED' });
  assert.throws(() => gate.requireValidationOnlyUpdateFeed(context('dev.codeintelligence.desktop.validation', [{ name: 'dmg' }])), { code: 'VALIDATION_UPDATE_FEED_REFUSED' });
  assert.deepEqual({ ...gate.requireValidationOnlyUpdateFeed(context('dev.codeintelligence.desktop.validation', [{ name: 'dir' }])) }, feed());
  assert.equal(gate.requireValidationOnlyUpdateFeed({ packager: { info: { metadata: { name: 'code-intelligence' } }, config: {} }, targets: [{ name: 'dmg' }] }), null);
});
