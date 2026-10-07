'use strict';

// ADR-01 adapter supervisor packaging: the signed worker table, the entitlement sets, the worker
// fuse wire and the afterPack/signing hooks. Synthetic files only; nothing is compiled or signed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const adapterSupervisor = require('../scripts/adapter-supervisor.cjs');
const { installAdapterSupervisor } = require('../scripts/electron-fuses.cjs');
const { signAdapterSupervisor } = require('../scripts/sign-macos-runtime.cjs');
const { BRIDGE_EXECUTABLE, SUPERVISOR_EXECUTABLE } = require('../src/adapter-isolation.cjs');

const NATIVE = path.join(__dirname, '..', 'native', 'adapter-supervisor');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const keys = file => [...fs.readFileSync(path.join(NATIVE, 'entitlements', file), 'utf8').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1]).sort();

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-supervisor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('packaged locations agree between the packaging helpers and main attestation', () => {
  assert.equal(adapterSupervisor.SUPERVISOR, SUPERVISOR_EXECUTABLE.join('/'));
  assert.equal(adapterSupervisor.BRIDGE, BRIDGE_EXECUTABLE.join('/'));
  assert.match(fs.readFileSync(path.join(NATIVE, 'protocol.h'), 'utf8'), /#define ADAPTER_SERVICE_BUNDLE "Contents\/XPCServices\/AdapterSupervisor\.xpc"/);
});

test('entitlements: sandbox-only supervisor, inherit-sandboxed workers, an entitlement-free bridge', () => {
  assert.deepEqual(keys('supervisor.plist'), ['com.apple.security.app-sandbox']);
  assert.deepEqual(keys('worker.plist'), ['com.apple.security.app-sandbox', 'com.apple.security.cs.allow-jit', 'com.apple.security.inherit']);
  assert.deepEqual(keys('worker-adhoc.plist'), [...keys('worker.plist'), 'com.apple.security.cs.disable-library-validation'].sort(),
    'only an ad-hoc signature, which has no Team ID, relaxes library validation');
  assert.deepEqual(keys('worker-native.plist'), ['com.apple.security.app-sandbox', 'com.apple.security.inherit']);
  assert.deepEqual(keys('bridge.plist'), []);
});

test('the worker Electron copy runs only as Node without NODE_OPTIONS or an inspector', () => {
  assert.deepEqual({ ...adapterSupervisor.WORKER_FUSES },
    { runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false });
});

test('the product worker table has only the TypeScript analyzer, pinned by executable and entry hashes', t => {
  const contents = temporary(t);
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(contents, relative)), { recursive: true }); fs.writeFileSync(path.join(contents, relative), text); };
  write('MacOS/adapter-node', 'electron'); write('Resources/ts-analyzer/dist/stdio.js', 'entry');
  write('Resources/test/probe', 'probe'); write('Resources/test/node-probe.cjs', 'node-probe');
  const product = adapterSupervisor.workerTable(contents);
  assert.deepEqual(Object.keys(product), ['ts-analyzer']);
  assert.deepEqual(product['ts-analyzer'], {
    executable: 'MacOS/adapter-node', sha256: sha(path.join(contents, 'MacOS/adapter-node')),
    script: 'Resources/ts-analyzer/dist/stdio.js', scriptSha256: sha(path.join(contents, 'Resources/ts-analyzer/dist/stdio.js')),
    environment: { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', LANG: 'C', LC_ALL: 'C' },
  });
  assert.deepEqual(Object.keys(adapterSupervisor.workerTable(contents, { testWorkers: true })).sort(), ['node-probe', 'probe', 'ts-analyzer']);
});

test('the service Info.plist is valid, escapes the requirement and identifies the XPC service', t => {
  const file = path.join(temporary(t), 'Info.plist');
  const requirement = 'identifier "dev.example.adapter-bridge" and cdhash H"0123456789abcdef0123456789abcdef01234567"';
  fs.writeFileSync(file, adapterSupervisor.serviceInfo({ appId: 'dev.example', version: '1.2.3', peerRequirement: requirement,
    workers: { 'ts-analyzer': { executable: 'MacOS/adapter-node', sha256: 'a'.repeat(64), environment: { A: '<&>' } } } }));
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.equal(parsed.CFBundleIdentifier, 'dev.example.adapter-supervisor');
  assert.equal(parsed.CFBundlePackageType, 'XPC!');
  assert.equal(parsed.CFBundleExecutable, 'AdapterSupervisor');
  assert.deepEqual(parsed.XPCService, { ServiceType: 'Application' });
  assert.equal(parsed.CodeIntelligencePeerRequirement, requirement);
  assert.equal(parsed.CodeIntelligenceWorkers['ts-analyzer'].environment.A, '<&>');
});

test('afterPack installs the staged service only for xpc-required macOS builds', () => {
  const installs = [];
  const install = options => installs.push(options);
  const context = platform => ({ electronPlatformName: platform, appOutDir: '/out/mac-arm64',
    packager: { appInfo: { productFilename: 'Code Intelligence' }, projectDir: '/repo/desktop' } });
  assert.equal(installAdapterSupervisor(context('darwin'), {}, install), false);
  assert.equal(installAdapterSupervisor(context('darwin'), { adapterIsolation: 'legacy-http' }, install), false);
  assert.equal(installAdapterSupervisor(context('darwin'), { adapterIsolation: 'xpc-required' }, install), true);
  assert.deepEqual(installs, [{ app: '/out/mac-arm64/Code Intelligence.app', stage: '/repo/desktop/stage/adapter-supervisor' }]);
  assert.throws(() => installAdapterSupervisor(context('win32'), { adapterIsolation: 'xpc-required' }, install), { code: 'ADAPTER_SUPERVISOR_MACOS_ONLY' });
});

test('installation refuses to overwrite an existing service', t => {
  const root = temporary(t);
  const app = path.join(root, 'A.app');
  fs.mkdirSync(path.join(app, 'Contents', adapterSupervisor.SERVICE_DIRECTORY), { recursive: true });
  assert.throws(() => adapterSupervisor.installService({ app, stage: root }), { code: 'ADAPTER_SERVICE_EXISTS' });
});

test('signing requires the service exactly when the build requires XPC isolation', t => {
  const root = temporary(t);
  const app = path.join(root, 'A.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  assert.equal(signAdapterSupervisor(app, { identity: '-' }, {}), null);
  assert.throws(() => signAdapterSupervisor(app, { identity: '-' }, { adapterIsolation: 'xpc-required' }), { code: 'MAC_ADAPTER_SUPERVISOR_REQUIRED' });
  fs.mkdirSync(path.join(app, 'Contents', adapterSupervisor.SERVICE_DIRECTORY), { recursive: true });
  assert.throws(() => signAdapterSupervisor(app, { identity: '-' }, { adapterIsolation: 'xpc-required' }), { code: 'MAC_ADAPTER_SUPERVISOR_REQUIRED' },
    'the bridge is required as well');
  assert.throws(() => signAdapterSupervisor(app, { identity: '-' }, {}), { code: 'MAC_ADAPTER_SUPERVISOR_UNEXPECTED' });
});
