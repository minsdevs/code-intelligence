'use strict';
// G-UPDATE NU-01: the product updater against a loopback HTTPS fixture server with in-memory
// fixture keys (test/fixtures/update-https-server.cjs). codesign/spctl/stapler/hdiutil run through
// an injected fake runner; no real update host, release key, signing identity or notarization is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const manifests = require('../src/update-manifest.cjs');
const updates = require('../src/update-service.cjs');
const beforePack = require('../scripts/desktop-build-gate.cjs');
const { startUpdateServer, HOST } = require('./fixtures/update-https-server.cjs');

const darwin = { skip: process.platform !== 'darwin' };
const release = crypto.generateKeyPairSync('ed25519'), attacker = crypto.generateKeyPairSync('ed25519');
const ARTIFACT = Buffer.from('synthetic signed DMG bytes for the updater fixture only\n'.repeat(512));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const spki = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
const RUNNING = Object.freeze({ product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345',
  platform: 'darwin', arch: 'arm64', osVersion: '14.6', buildSequence: '150', schemaFlyway: 27, safetyJournalMajor: 1 });

function keyFile(changes = {}) {
  return Buffer.from(JSON.stringify({ format: 1, purpose: 'code-intelligence-update-manifest', product: 'code-intelligence',
    bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345', channel: 'stable', manifestUrl: `https://${HOST}/stable/manifest.json`,
    allowedHosts: [HOST], keys: [{ keyId: 'release-fixture', publicKey: spki(release.publicKey) }], ...changes }));
}
function body(changes = {}) {
  const now = Date.now();
  return { format: 1, kind: 'update', product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345',
    channel: 'stable', serial: 42, issuedAt: now - 60000, expiresAt: now + 86400000, version: '0.2.0', buildSequence: '200',
    platform: 'darwin', arch: 'arm64', minimumSystemVersion: '13.0', compatibleFromBuild: '100',
    schema: { flyway: 27, safetyJournalMajor: 1, backupFormat: 3 },
    artifact: { kind: 'dmg', url: `https://${HOST}/stable/0.2.0/app.dmg`, size: ARTIFACT.length, sha256: sha256(ARTIFACT) },
    recovery: null, ...changes };
}
const envelope = (value = body(), privateKey = release.privateKey) => manifests.signManifest(value, { keyId: 'release-fixture', privateKey });

// Fake macOS tools. An attached image or unpacked zip contains one app with a bundled runtime manifest.
function fakeRunner(observed = {}) {
  const app = { bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345', strict: 0, notarized: true, stapled: 0,
    buildSequence: '200', ...observed };
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    const make = async root => {
      const runtime = path.join(root, 'Code Intelligence.app', 'Contents', 'Resources', 'runtime');
      await fs.mkdir(runtime, { recursive: true });
      await fs.writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ format: 1, buildSequence: app.buildSequence }));
      await fs.symlink('/Applications', path.join(root, 'Applications')).catch(() => {});
    };
    if (file === updates.TOOLS.hdiutil && args[0] === 'attach') { await make(args[args.indexOf('-mountpoint') + 1]); return { code: 0, stdout: '', stderr: '' }; }
    if (file === updates.TOOLS.hdiutil && args[0] === 'detach') { await fs.rm(args[1], { recursive: true, force: true }); await fs.mkdir(args[1]); return { code: 0, stdout: '', stderr: '' }; }
    if (file === updates.TOOLS.ditto) { await make(args[3]); return { code: 0, stdout: '', stderr: '' }; }
    if (file === updates.TOOLS.codesign && args[0] === '--verify') return { code: app.strict, stdout: '', stderr: '' };
    if (file === updates.TOOLS.codesign && args[0] === '-dv') return { code: 0, stdout: '',
      stderr: `Executable=/x\nIdentifier=${app.bundleId}\nFormat=app bundle with Mach-O thin (arm64)\nTeamIdentifier=${app.teamId}\n` };
    if (file === updates.TOOLS.spctl) return app.notarized ? { code: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }
      : { code: 3, stdout: '', stderr: 'rejected\nsource=Unnotarized Developer ID\n' };
    if (file === updates.TOOLS.xcrun) return { code: app.stapled, stdout: '', stderr: '' };
    throw new Error(`unexpected tool ${file}`);
  };
  return { runner, calls };
}

async function fixture(t, { runner = fakeRunner().runner, state = { highWaterBuild: '150', lastManifestSerial: 41 }, config = keyFile(),
  confirmed = true, checkpoint = null } = {}) {
  const server = await startUpdateServer(t);
  const userData = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-update-service-')); await fs.chmod(userData, 0o700);
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const events = [];
  const service = updates.createUpdateService({ config: updates.parseUpdateKeys(config), userData, running: RUNNING, request: server.request, runner,
    readState: () => state, readCheckpoint: async () => checkpoint,
    recordAccepted: async verified => { events.push(['recordAccepted', verified.acceptedSerial, manifests.isVerifiedManifest(verified)]); },
    sanctionRollback: async verified => { events.push(['sanctionRollback', verified.acceptedSerial]); },
    restoreCheckpoint: async id => { events.push(['restoreCheckpoint', id]); },
    reveal: async file => { events.push(['reveal', file]); }, confirm: async info => { events.push(['confirm', info.version]); return confirmed; },
    quit: () => events.push(['quit']) });
  const serve = (value, artifact = ARTIFACT) => {
    server.routes.set('/stable/manifest.json', { body: Buffer.from(JSON.stringify(value)) });
    server.routes.set('/stable/0.2.0/app.dmg', { body: artifact });
  };
  return { server, userData, service, events, serve };
}
const exists = file => fs.lstat(file).then(() => true, () => false);

test('pinned key file: the shipped placeholder disables the updater and a release build refuses it', async t => {
  const shipped = await updates.loadUpdateKeys(path.join(__dirname, '..', 'build', 'update-keys.json'));
  assert.equal(shipped.enabled, false); assert.deepEqual(Object.keys(shipped.pinnedKeys), []);
  await assert.rejects(updates.loadUpdateKeys(path.join(__dirname, '..', 'build', 'update-keys.json'), { release: true }), { code: 'UPDATE_KEYS_MISSING' });
  // beforePack refuses a distributed macOS target before any signing step; a validation directory build is not affected.
  await assert.rejects(beforePack({ electronPlatformName: 'darwin', targets: [{ name: 'dmg' }, { name: 'zip' }],
    packager: { projectDir: path.join(__dirname, '..') } }), { code: 'UPDATE_KEYS_MISSING' });
  assert.equal(await updates.requireReleaseUpdateKeys(path.join(__dirname, '..'), [{ name: 'dir' }]), null);
  assert.equal(updates.parseUpdateKeys(keyFile(), { release: true }).enabled, true);
  for (const changes of [{ keys: [] }, { manifestUrl: null }, { teamId: null }, { allowedHosts: [] },
    { keys: [{ keyId: 'rsa', publicKey: spki(crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey) }] },
    { keys: [{ keyId: 'a', publicKey: spki(release.publicKey) }, { keyId: 'a', publicKey: spki(attacker.publicKey) }] },
    { manifestUrl: `http://${HOST}/m.json` }, { manifestUrl: `https://${HOST}:8443/m.json` }, { manifestUrl: 'https://evil.example/m.json' },
    { extra: true }]) {
    assert.throws(() => updates.parseUpdateKeys(keyFile(changes)), { code: 'UPDATE_KEYS_INVALID' }, JSON.stringify(Object.keys(changes)));
  }
});

test('valid update over HTTPS: check, download into userData/updates/<serial>, verify identity, user-confirmed reveal and quit', darwin, async t => {
  const { runner, calls } = fakeRunner();
  const f = await fixture(t, { runner });
  f.serve(envelope());
  assert.equal((await f.service.check()).phase, 'AVAILABLE');
  await assert.rejects(f.service.handOff(), { code: 'UPDATE_NOT_VERIFIED' });
  assert.equal((await f.service.download()).phase, 'DOWNLOADED');
  const artifact = path.join(f.userData, 'updates', '42', 'artifact.dmg');
  const stat = await fs.lstat(artifact);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal((await fs.lstat(path.dirname(artifact))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(artifact)), ['artifact.dmg']);
  assert.equal((await f.service.verifyDownloaded()).phase, 'VERIFIED');
  assert.deepEqual(calls.map(call => call.slice(0, 2).join(' ')), ['/usr/bin/hdiutil attach', '/usr/bin/codesign --verify',
    '/usr/bin/codesign -dv', '/usr/sbin/spctl --assess', '/usr/bin/xcrun stapler', '/usr/bin/hdiutil detach']);
  assert.deepEqual(await fs.readdir(path.dirname(artifact)), ['artifact.dmg'], 'inspection scratch is removed');
  const done = await f.service.handOff();
  assert.equal(done.phase, 'HANDED_OFF');
  assert.deepEqual(f.events, [['confirm', '0.2.0'], ['reveal', artifact], ['recordAccepted', 42, true], ['quit']]);
  assert.deepEqual(f.server.requests, ['/stable/manifest.json', '/stable/0.2.0/app.dmg']);
});

test('the user can decline the hand-off; nothing is recorded, revealed or quit', darwin, async t => {
  const f = await fixture(t, { confirmed: false });
  f.serve(envelope());
  await f.service.check(); await f.service.download(); await f.service.verifyDownloaded();
  assert.equal((await f.service.handOff()).phase, 'VERIFIED');
  assert.deepEqual(f.events, [['confirm', '0.2.0']]);
});

test('forged or tampered manifests are refused before any artifact request', darwin, async t => {
  const f = await fixture(t);
  for (const [value, code] of [[envelope(body(), attacker.privateKey), 'UPDATE_SIGNATURE_INVALID'],
    [{ ...envelope(), keyId: 'attacker' }, 'UPDATE_KEY_UNKNOWN'], [{ ...envelope(), keyId: 'constructor' }, 'UPDATE_KEY_UNKNOWN'],
    [(() => { const e = envelope(); e.body.buildSequence = '201'; return e; })(), 'UPDATE_SIGNATURE_INVALID'],
    [{ not: 'an envelope' }, 'UPDATE_ENVELOPE_INVALID']]) {
    f.serve(value);
    await assert.rejects(f.service.check(), { code });
    assert.equal(f.service.status().phase, 'IDLE'); assert.equal(f.service.status().error, code);
  }
  f.server.routes.set('/stable/manifest.json', { body: Buffer.from('{not json') });
  await assert.rejects(f.service.check(), { code: 'UPDATE_MANIFEST_INVALID' });
  assert(f.server.requests.every(url => url === '/stable/manifest.json'));
  assert.equal(await exists(path.join(f.userData, 'updates')), false);
});

test('wrong platform, architecture, downgrade, replay and expired manifests are refused', darwin, async t => {
  const f = await fixture(t);
  for (const [changes, code] of [[{ platform: 'win32' }, 'UPDATE_PLATFORM_MISMATCH'], [{ arch: 'x64' }, 'UPDATE_ARCH_MISMATCH'],
    [{ buildSequence: '149' }, 'UPDATE_DOWNGRADE'], [{ buildSequence: '150' }, 'UPDATE_DOWNGRADE'], [{ serial: 41 }, 'UPDATE_MANIFEST_REPLAYED'],
    [{ teamId: 'ZZZZZ99999' }, 'UPDATE_IDENTITY_MISMATCH'], [{ issuedAt: 1, expiresAt: 2 }, 'UPDATE_MANIFEST_EXPIRED'],
    [{ artifact: { ...body().artifact, url: 'https://evil.example/app.dmg' } }, 'UPDATE_ARTIFACT_URL']]) {
    f.serve(envelope(body(changes)));
    await assert.rejects(f.service.check(), { code }, code);
  }
  // The area-B floor (high-water) applies even when the running build is older than it.
  const below = await fixture(t, { state: { highWaterBuild: '210', lastManifestSerial: 41 } });
  below.serve(envelope()); await assert.rejects(below.service.check(), { code: 'UPDATE_DOWNGRADE' });
});

test('oversize manifest or artifact responses are cut off at the cap', darwin, async t => {
  const f = await fixture(t);
  f.server.routes.set('/stable/manifest.json', { body: Buffer.alloc(updates.LIMITS.manifestBytes + 1, 0x20) });
  await assert.rejects(f.service.check(), { code: 'UPDATE_TOO_LARGE' });
  // Without a length header the streamed byte count is enforced.
  f.server.routes.set('/stable/manifest.json', (request, response) => {
    response.writeHead(200, { 'transfer-encoding': 'chunked' });
    const chunk = Buffer.alloc(16 * 1024, 0x20); let sent = 0;
    const write = () => { while (sent < 16 && response.write(chunk)) sent++; if (sent < 16) response.once('drain', write); else response.end(); };
    write();
  });
  await assert.rejects(f.service.check(), { code: 'UPDATE_TOO_LARGE' });
  f.serve(envelope(), Buffer.concat([ARTIFACT, Buffer.from('x')]));
  await f.service.check();
  await assert.rejects(f.service.download(), { code: 'UPDATE_TOO_LARGE' });
  assert.deepEqual(await fs.readdir(path.join(f.userData, 'updates', '42')), [], 'a refused partial download is removed');
  f.server.routes.set('/stable/0.2.0/app.dmg', { status: 302, headers: { location: 'https://evil.example/app.dmg' }, body: Buffer.alloc(0) });
  await assert.rejects(f.service.download(), { code: 'UPDATE_HTTP_STATUS' });
  const huge = await fixture(t);
  huge.serve(envelope(body({ artifact: { ...body().artifact, size: updates.LIMITS.artifactBytes + 1 } })));
  await huge.service.check();
  await assert.rejects(huge.service.download(), { code: 'UPDATE_TOO_LARGE' });
  assert.deepEqual(huge.server.requests, ['/stable/manifest.json']);
});

test('a tampered or truncated artifact is refused after download and never handed off', darwin, async t => {
  const f = await fixture(t);
  const tampered = Buffer.from(ARTIFACT); tampered[100] ^= 1;
  f.serve(envelope(), tampered);
  await f.service.check();
  await assert.rejects(f.service.download(), { code: 'UPDATE_ARTIFACT_HASH' });
  f.serve(envelope(), ARTIFACT.subarray(1));
  await assert.rejects(f.service.download(), { code: 'UPDATE_ARTIFACT_SIZE' });
  assert.deepEqual(await fs.readdir(path.join(f.userData, 'updates', '42')), []);
  await assert.rejects(f.service.verifyDownloaded(), { code: 'UPDATE_NOT_DOWNLOADED' });
  // Bytes changed on disk after download are caught again before inspection.
  f.serve(envelope());
  await f.service.download();
  const artifact = path.join(f.userData, 'updates', '42', 'artifact.dmg');
  const bytes = await fs.readFile(artifact); bytes[5] ^= 1; await fs.writeFile(artifact, bytes);
  await assert.rejects(f.service.verifyDownloaded(), { code: 'UPDATE_ARTIFACT_HASH' });
  await assert.rejects(f.service.handOff(), { code: 'UPDATE_NOT_VERIFIED' });
  assert.deepEqual(f.events, []);
});

test('identity of the downloaded app comes from its code signature: mismatches are refused', darwin, async t => {
  for (const [observed, code] of [[{ teamId: 'ZZZZZ99999' }, 'UPDATE_APP_TEAM_MISMATCH'], [{ bundleId: 'dev.codeintelligence.desktop.validation' }, 'UPDATE_APP_BUNDLE_MISMATCH'],
    [{ strict: 1 }, 'UPDATE_APP_SIGNATURE_INVALID'], [{ notarized: false }, 'UPDATE_APP_NOT_NOTARIZED'], [{ stapled: 65 }, 'UPDATE_APP_NOT_NOTARIZED'],
    [{ buildSequence: '199' }, 'UPDATE_APP_BUILD_MISMATCH']]) {
    const { runner, calls } = fakeRunner(observed);
    const f = await fixture(t, { runner });
    f.serve(envelope());
    await f.service.check(); await f.service.download();
    await assert.rejects(f.service.verifyDownloaded(), { code }, code);
    assert.equal(f.service.status().phase, 'DOWNLOADED');
    assert.equal(calls.at(-1).slice(0, 2).join(' '), '/usr/bin/hdiutil detach', 'the image is always detached');
    await assert.rejects(f.service.handOff(), { code: 'UPDATE_NOT_VERIFIED' });
    assert.deepEqual(f.events, []);
  }
});

test('a zip artifact is unpacked into a private scratch directory that is removed after inspection', darwin, async t => {
  const { runner, calls } = fakeRunner();
  const f = await fixture(t, { runner });
  const value = body({ artifact: { ...body().artifact, kind: 'zip', url: `https://${HOST}/stable/0.2.0/app.zip` } });
  f.server.routes.set('/stable/manifest.json', { body: Buffer.from(JSON.stringify(envelope(value))) });
  f.server.routes.set('/stable/0.2.0/app.zip', { body: ARTIFACT });
  await f.service.check(); await f.service.download();
  assert.equal((await f.service.verifyDownloaded()).phase, 'VERIFIED');
  assert.equal(calls[0][0], '/usr/bin/ditto');
  assert.deepEqual(await fs.readdir(path.join(f.userData, 'updates', '42')), ['artifact.zip']);
});

test('a signed recovery manifest restores its bound checkpoint before the rollback is sanctioned', darwin, async t => {
  const checkpointId = '5b1f0a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const value = body({ kind: 'recovery', buildSequence: '120', serial: 43, schema: { flyway: 26, safetyJournalMajor: 1, backupFormat: 3 },
    recovery: { checkpointId, checkpointSchemaFlyway: 26, reason: 'rollback after failed migration' } });
  const { runner } = fakeRunner({ buildSequence: '120' });
  const missing = await fixture(t, { runner });
  missing.serve(envelope(value));
  await assert.rejects(missing.service.check(), { code: 'UPDATE_RECOVERY_CHECKPOINT' });
  const f = await fixture(t, { runner, checkpoint: { id: checkpointId, schemaFlyway: 26, createdByBuild: '120' } });
  f.serve(envelope(value));
  assert.equal((await f.service.check()).kind, 'recovery');
  await f.service.download(); await f.service.verifyDownloaded(); await f.service.handOff();
  assert.deepEqual(f.events.map(event => event[0]), ['confirm', 'restoreCheckpoint', 'sanctionRollback', 'reveal', 'quit']);
  assert.equal(f.events[1][1], checkpointId);
});

test('a disabled updater never makes a request; concurrent operations are refused', darwin, async t => {
  const server = await startUpdateServer(t);
  const disabled = updates.createUpdateService({ config: await updates.loadUpdateKeys(path.join(__dirname, '..', 'build', 'update-keys.json')),
    userData: os.tmpdir(), running: RUNNING, request: server.request, runner: fakeRunner().runner, readState: () => ({ highWaterBuild: '0', lastManifestSerial: 0 }),
    readCheckpoint: async () => null, recordAccepted: async () => {}, sanctionRollback: async () => {}, restoreCheckpoint: async () => {},
    reveal: async () => {}, confirm: async () => true, quit: () => {} });
  await assert.rejects(disabled.check(), { code: 'UPDATE_NOT_CONFIGURED' });
  assert.deepEqual(server.requests, []);
  const f = await fixture(t);
  f.serve(envelope());
  const first = f.service.check();
  await assert.rejects(f.service.check(), { code: 'UPDATE_BUSY' });
  await first;
});

test('electronRequest uses Electron net without redirects, cookies, credentials or cache', async () => {
  const seen = [];
  const net = { request(options) {
    seen.push(options);
    const request = new EventEmitter();
    request.end = () => { const body = new PassThrough(); body.statusCode = 200; body.headers = { 'content-length': '2' };
      setImmediate(() => { request.emit('response', body); body.end(Buffer.from('ok')); }); };
    request.abort = () => seen.push('abort');
    return request;
  } };
  const response = await updates.electronRequest(net)(`https://${HOST}/m.json`);
  const chunks = []; for await (const chunk of response.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ok'); assert.equal(response.statusCode, 200);
  assert.deepEqual(seen[0], { method: 'GET', url: `https://${HOST}/m.json`, redirect: 'error', credentials: 'omit', useSessionCookies: false, cache: 'no-store' });
  response.abort(); assert.equal(seen[1], 'abort');
});
