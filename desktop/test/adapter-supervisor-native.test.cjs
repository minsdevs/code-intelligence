'use strict';

// ADR-01 native acceptance of the product supervisor (opt-in: ADAPTER_SUPERVISOR_NATIVE=1, macOS arm64).
// Builds the real service and bridge, assembles them with the npm Electron and the built ts-analyzer
// into an ad-hoc-signed test app, and drives the bridge exactly as main does. The test stage adds
// the denial probes to the signed worker table. macOS keeps the service's sandbox container
// (~/Library/Containers/dev.codeintelligence.test.adapter.adapter-supervisor) after the run.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const adapterSupervisor = require('../scripts/adapter-supervisor.cjs');
const { attestSupervisor, createBridgeAdapter } = require('../src/adapter-isolation.cjs');

const enabled = process.env.ADAPTER_SUPERVISOR_NATIVE === '1' && process.platform === 'darwin' && process.arch === 'arm64';
const repo = path.resolve(__dirname, '..', '..');
const analyzerDist = path.join(repo, 'analyzers', 'ts-analyzer', 'dist', 'stdio.js');
const APP_ID = 'dev.codeintelligence.test.adapter';

function build(root) {
  const stage = path.join(root, 'stage'), analyzer = path.join(root, 'ts-analyzer'), app = path.join(root, 'Test.app');
  adapterSupervisor.compile(path.join(stage, 'bin'), { probe: true });
  fs.mkdirSync(analyzer);
  for (const name of ['dist', 'node_modules', 'package.json']) {
    execFileSync('/bin/cp', ['-cR', path.join(repo, 'analyzers', 'ts-analyzer', name), path.join(analyzer, name)]);
  }
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host.c'), 'int main(void) { return 0; }\n');
  execFileSync('/usr/bin/xcrun', ['clang', '-o', path.join(app, 'Contents', 'MacOS', 'test-host'), path.join(root, 'host.c')]);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string><key>CFBundleExecutable</key><string>test-host</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>\n`);
  return { stage, analyzer, app };
}

function listener() {
  const seen = [];
  const tcp = net.createServer(socket => { let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('close', () => seen.push('tcp:' + data)); });
  return new Promise(resolve => tcp.listen(0, '127.0.0.1', () => {
    const port = tcp.address().port, udp = dgram.createSocket('udp4');
    udp.on('message', message => seen.push('udp:' + message));
    udp.bind(port, '127.0.0.1', () => resolve({ port, seen, close: () => { tcp.close(); udp.close(); } }));
  }));
}

function bridge(app, worker, input, token = crypto.randomBytes(32).toString('hex')) {
  const result = spawnSync(path.join(app, 'Contents', 'MacOS', 'adapter-bridge'), [], {
    input: `open ${worker} ${token}\n${input}`, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const DENIED = ['readOutsideFile', 'createOutsideFile', 'tcpConnectLoopback', 'tcpListenLoopback', 'udpSendLoopback'];

test('the product supervisor runs only signed, hash-checked, sandboxed workers for its own bridge', { skip: !enabled || !fs.existsSync(analyzerDist) }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stage, analyzer, app } = build(root);
  await adapterSupervisor.assembleService({ destination: stage, binaries: path.join(stage, 'bin'),
    electronApp: path.join(repo, 'desktop', 'node_modules', 'electron', 'dist', 'Electron.app'), analyzer, appId: APP_ID, version: '0.1.0', testWorkers: true });
  adapterSupervisor.installService({ app, stage });
  const section = adapterSupervisor.signService({ app, identity: '-', appId: APP_ID, version: '0.1.0', testWorkers: true });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  const contents = path.join(app, 'Contents');
  const sentinel = path.join(root, 'sentinel.txt'), target = path.join(root, 'write-target');
  fs.writeFileSync(sentinel, 'outside the sandbox\n');
  const loopback = await listener();
  t.after(() => loopback.close());

  await t.test('control: the same probe outside the sandbox reads, writes and connects', () => {
    const control = spawnSync(path.join(stage, 'bin', 'probe'), [sentinel, target, String(loopback.port), 'control'], { encoding: 'utf8' });
    const report = JSON.parse(control.stdout);
    assert.equal(report.sandboxed, 0);
    for (const key of DENIED) assert.equal(report[key], 'ALLOWED', key);
  });

  await t.test('main attests the signed service and bridge from the manifest section', async () => {
    const attested = await attestSupervisor({ platform: 'darwin', appContents: contents, manifest: { adapterSupervisor: section } });
    assert.equal(attested.bridge, path.join(contents, 'MacOS', 'adapter-bridge'));
  });

  await t.test('a native worker is sandboxed and denied files, sockets and DNS', () => {
    const run = bridge(app, 'probe', `${sentinel} ${target} ${loopback.port} supervisor-child\n`);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.sandboxed, 1);
    for (const key of DENIED) assert.match(report[key], /^DENIED\(Operation not permitted\)$/, key);
    assert.notEqual(report.dnsResolve, 'ALLOWED');
    assert.equal(fs.existsSync(target), false);
  });

  await t.test('the worker Electron runs as Node inside the sandbox and its children inherit it', () => {
    const run = bridge(app, 'node-probe', `${sentinel} ${target} ${loopback.port}\n`);
    assert.equal(run.status, 0, run.stderr);
    const [node, grandchild] = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.match(node.worker, /^node \d+\.\d+\.\d+ \(electron \d+/);
    assert.equal(node.tcpListen, 'DENIED(EPERM)');
    assert.equal(node.userHome, 'DENIED(EPERM)');
    assert.equal(grandchild.label, 'node-grandchild');
    assert.equal(grandchild.sandboxed, 1);
    for (const key of DENIED) assert.match(grandchild[key], /^DENIED/, key);
  });

  await t.test('the TypeScript analyzer answers through the bridge with the run-token handshake', async () => {
    const adapter = createBridgeAdapter({ bridge: path.join(contents, 'MacOS', 'adapter-bridge') });
    await adapter.verify();
    const result = await adapter.analyze({ files: [{ path: 'src/a.ts', content: "export function f() { return fetch('/api/items') }\n" }] });
    assert.deepEqual(result.apiCalls.map(call => [call.method, call.url]), [['GET', '/api/items']]);
    await assert.rejects(adapter.analyze({ files: 'not-an-array' }), error => error.code === 'ADAPTER_REQUEST_REJECTED' && error.status === 400);
  });

  await t.test('one analyzer session above the single-request bounds runs in one sandboxed worker (03 §6)', async () => {
    // About 10.7 MiB of source in and over 100 MiB of result pages out: more than one 10 MiB request
    // frame and one 64 MiB response frame, so only the session protocol can carry it.
    const files = Array.from({ length: 45 }, (_, f) => ({ path: `src/m${f}.ts`, content: Array.from({ length: 2500 },
      (_, i) => `export function f${f}_${i}(): number { return g${f}_${i}() }\nfunction g${f}_${i}(): number { return ${i} }\n`).join('') }));
    const line = file => `${file.path}\n${crypto.createHash('sha256').update(file.content).digest('hex')}\n`;
    const manifest = { fileCount: files.length, bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
      digest: crypto.createHash('sha256').update(files.map(line).join('')).digest('hex') };
    assert.ok(manifest.bytes > 10.5 * 1024 * 1024);
    const adapter = createBridgeAdapter({ bridge: path.join(contents, 'MacOS', 'adapter-bridge') });
    const send = session => adapter.analyze({ session });
    const { session: { id } } = await send({ op: 'open', ...manifest });
    for (let seq = 0; seq * 4 < files.length; seq++) await send({ op: 'put', id, seq, files: files.slice(seq * 4, seq * 4 + 4) });
    await send({ op: 'seal', id, ...manifest });
    const pages = [await send({ op: 'analyze', id })];
    for (let page = 1; page < pages[0].session.pages; page++) pages.push(await send({ op: 'page', id, page }));
    await send({ op: 'close', id });
    assert.ok(pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0) > 64 * 1024 * 1024);
    const functions = pages.flatMap(page => page.nodes).filter(node => node.type === 'METHOD' && /^[fg]\d+_\d+$/.test(node.name));
    assert.equal(functions.length, 2 * 2500 * files.length);
  });

  await t.test('unknown workers, changed workers and other callers are refused', () => {
    const unknown = bridge(app, 'shell', '');
    assert.deepEqual([unknown.status, unknown.stderr.trim()], [70, 'ADAPTER_BRIDGE WORKER_UNKNOWN']);
    const foreign = path.join(contents, 'MacOS', 'foreign-bridge');
    fs.copyFileSync(path.join(contents, 'MacOS', 'adapter-bridge'), foreign);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', `${APP_ID}.adapter-bridge`, foreign], { stdio: 'ignore' });
    const other = spawnSync(foreign, [], { input: `open probe ${'a'.repeat(64)}\n`, encoding: 'utf8', timeout: 60000 });
    assert.equal(other.status, 69, 'a caller other than the pinned bridge never reaches a worker');
    fs.rmSync(foreign);
    fs.appendFileSync(path.join(contents, adapterSupervisor.SERVICE_DIRECTORY, 'Contents', 'Resources', 'test', 'probe'), '\0');
    const changed = bridge(app, 'probe', `${sentinel} ${target} ${loopback.port} changed\n`);
    assert.deepEqual([changed.status, changed.stderr.trim()], [70, 'ADAPTER_BRIDGE WORKER_HASH_MISMATCH']);
  });

  await t.test('the inherit-signed worker runtime cannot run outside the sandbox', () => {
    const direct = spawnSync(path.join(contents, adapterSupervisor.SERVICE_DIRECTORY, 'Contents', 'MacOS', 'adapter-node'), ['-e', '1'],
      { env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(direct.status, null);
    assert.equal(direct.signal, 'SIGTRAP');
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  // Other local tools scan loopback ports too; only the probes' labelled payloads are attributable.
  assert.deepEqual(loopback.seen.filter(entry => /supervisor-child|node-grandchild|changed/.test(entry)), [],
    'no sandboxed worker reached the loopback listener');
  assert.deepEqual(loopback.seen.filter(entry => entry.endsWith(':control')).sort(), ['tcp:control', 'udp:control']);
});
