'use strict';
// G-UPDATE: update-startup.cjs wiring of the validation-build-only loopback feed (update-validation-feed.cjs):
// the feed enables the real updater path (menu item, manifest check, dialogs) without the shipped key file.
// Fixture keys in memory, loopback HTTPS fixture server, fake Electron surfaces; no real host or signing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const manifests = require('../src/update-manifest.cjs');
const { openUpdateStartup, TARGET_FLYWAY } = require('../src/update-startup.cjs');
const { startUpdateServer, HOST } = require('./fixtures/update-https-server.cjs');

const release = crypto.generateKeyPairSync('ed25519');
const spki = key => key.export({ format: 'der', type: 'spki' }).toString('base64');

async function harness(t, { metadata, script = [] }) {
  const userData = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-update-feed-')); await fs.chmod(userData, 0o700);
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const dialogs = [], menus = [], state = { highWaterBuild: '100', lastManifestSerial: 0, journal: { sequence: 1, headHash: 'a'.repeat(64) } };
  const events = [];
  const electron = {
    app: { isPackaged: false },
    dialog: { showMessageBox: async options => { dialogs.push({ title: options.title, detail: options.detail, buttons: options.buttons });
      const answer = script.find(item => item.title === options.title); if (!answer) throw new Error('UNSCRIPTED_DIALOG ' + options.title);
      return { response: answer.response, checkboxChecked: false }; } },
    shell: { showItemInFolder: file => events.push(['reveal', file]) },
    net: { request: () => { throw new Error('ELECTRON_NET_MUST_NOT_BE_USED_WITH_THE_FEED'); } },
    Menu: { buildFromTemplate: template => template, setApplicationMenu: menu => menus.push(menu) },
  };
  const safety = { updateState: () => state, async recordStartedBuild() { events.push(['started']); return state; },
    async recordAcceptedManifest(verified) { events.push(['accepted', verified.acceptedSerial]); return state; },
    async sanctionRecoveryRollback(verified) { events.push(['sanctioned', verified.acceptedSerial]); return state; } };
  // The signed feed exercises the macOS arm64 updater independently of the test host.
  for (const [name, value] of Object.entries({ platform: 'darwin', arch: 'arm64', getSystemVersion: () => '14.6' })) {
    const original = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(process, name, original); else delete process[name]; });
  }
  const startup = await openUpdateStartup({ electron, safety, userData, runningBuild: '100', runtimeRoot: userData, execPath: '/x/Contents/MacOS/x',
    resourcesPath: userData, stopRuntime: async () => events.push(['stop']), quit: () => events.push(['quit']), metadata });
  assert.equal(await startup.beforeRuntime(), true);
  await startup.afterHealthy();
  return { startup, dialogs, menus, events, userData };
}
const findItem = menus => menus.flat().flatMap(entry => entry.submenu ?? []).find(item => item?.id === 'check-for-updates');

test('without a feed the shipped placeholder keeps the updater disabled: no menu, no status', async t => {
  const h = await harness(t, { metadata: { name: 'code-intelligence-validation' } });
  assert.equal(h.menus.length, 0);
  assert.equal(h.startup.updateStatus(), null);
  await h.startup.checkForUpdates();
  assert.deepEqual(h.dialogs, []);
});

test('a feed on a non-validation package is refused before anything is wired', async t => {
  await assert.rejects(harness(t, { metadata: { name: 'code-intelligence', validationUpdateFeed: { host: HOST, port: 47621, caPem: '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(64) + '\n-----END CERTIFICATE-----\n',
    keyId: 'validation-fixture', publicKey: spki(release.publicKey), teamId: 'VALIDATN00', manifestPath: '/stable/manifest.json' } } }), { code: 'UPDATE_VALIDATION_FEED_REFUSED' });
});

test('with the feed the real updater is installed: menu item, pinned-key manifest verification, refusal and offer dialogs', async t => {
  const server = await startUpdateServer(t);
  const feed = { host: HOST, port: server.port, caPem: server.ca, keyId: 'validation-fixture', publicKey: spki(release.publicKey), teamId: 'VALIDATN00', manifestPath: '/stable/manifest.json' };
  const h = await harness(t, { metadata: { name: 'code-intelligence-validation', validationUpdateFeed: feed },
    script: [{ title: 'No verified update', response: 0 }, { title: 'Update available', response: 1 }] });
  const item = findItem(h.menus);
  assert.ok(item, 'menu item with id check-for-updates');
  assert.equal(item.label, 'Check for Updates…');
  assert.deepEqual({ ...h.startup.updateStatus() }, { enabled: true, phase: 'IDLE', kind: null, version: null, buildSequence: null, error: null, validationFeed: true, simulatedIdentity: [] });
  const body = changes => ({ format: 1, kind: 'update', product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop.validation', teamId: 'VALIDATN00',
    channel: 'stable', serial: 5, issuedAt: Date.now() - 60000, expiresAt: Date.now() + 86400000, version: '0.2.0', buildSequence: '200', platform: 'darwin', arch: 'arm64',
    minimumSystemVersion: '13.0', compatibleFromBuild: '1', schema: { flyway: TARGET_FLYWAY, safetyJournalMajor: 1, backupFormat: 3 },
    artifact: { kind: 'zip', url: `https://${HOST}/stable/app.zip`, size: 1, sha256: '0'.repeat(64) }, recovery: null, ...changes });
  const serve = (value, privateKey = release.privateKey) => server.routes.set('/stable/manifest.json', { body: Buffer.from(JSON.stringify(manifests.signManifest(value, { keyId: 'validation-fixture', privateKey }))) });
  // Refused: wrong arch, then a forged signature; each shows the refusal dialog with the code only.
  serve(body({ arch: 'x86_64' })); await h.startup.checkForUpdates();
  assert.equal(h.dialogs.at(-1).title, 'No verified update'); assert.match(h.dialogs.at(-1).detail, /Reason: UPDATE_ARCH_MISMATCH$/);
  serve(body(), crypto.generateKeyPairSync('ed25519').privateKey); await h.startup.checkForUpdates();
  assert.match(h.dialogs.at(-1).detail, /Reason: UPDATE_SIGNATURE_INVALID$/);
  // Offered: a valid manifest for a newer build; the user cancels before any download.
  serve(body()); item.click(); await new Promise(resolve => setTimeout(resolve, 300));
  for (const end = Date.now() + 5000; h.dialogs.at(-1).title !== 'Update available' && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.dialogs.at(-1).title, 'Update available'); assert.deepEqual(h.dialogs.at(-1).buttons, ['Download and verify', 'Cancel']);
  assert.deepEqual(server.requests, ['/stable/manifest.json', '/stable/manifest.json', '/stable/manifest.json']);
  assert.equal(h.startup.updateStatus().phase, 'AVAILABLE'); assert.equal(h.startup.updateStatus().buildSequence, '200');
  assert.equal(h.events.some(([kind]) => kind === 'accepted' || kind === 'reveal' || kind === 'quit'), false);
  assert.equal(await fs.stat(path.join(h.userData, 'updates')).catch(() => null), null);
});
