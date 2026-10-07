'use strict';

// ADR-01 adapter isolation boundary (SEC-H-02): framing limits, supervisor attestation, the
// ADAPTER_ISOLATION_UNAVAILABLE refusal and the no-fallback rule. Synthetic streams and files only;
// no supervisor, analyzer or Electron process is started.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const test = require('node:test');
const {
  ADAPTER_STDIO_PROTOCOL, ADAPTER_STDIO_VERSION, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
  SUPERVISOR_EXECUTABLE, AdapterIsolationError, adapterIsolationMode, attestSupervisor,
  createFrameDecoder, createStdioAdapterClient, encodeFrame, openAdapterIsolation
} = require('../src/adapter-isolation.cjs');

const TOKEN = 'e'.repeat(64);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefixed = (length, body = Buffer.alloc(0)) => { const p = Buffer.alloc(4); p.writeUInt32BE(length); return Buffer.concat([p, body]); };
const failure = action => { try { action(); } catch (error) { return error.code; } return undefined; };
const reason = async promise => { try { await promise; } catch (error) {
  assert.ok(error instanceof AdapterIsolationError, String(error)); assert.equal(error.code, 'ADAPTER_ISOLATION_UNAVAILABLE'); return error.reason; }
  assert.fail('expected ADAPTER_ISOLATION_UNAVAILABLE'); };

test('the build flag defaults to the current HTTP sidecar and fails closed on anything unknown', () => {
  assert.equal(adapterIsolationMode({}), 'legacy-http');
  assert.equal(adapterIsolationMode({ adapterIsolation: 'legacy-http' }), 'legacy-http');
  assert.equal(adapterIsolationMode({ adapterIsolation: 'xpc-required' }), 'xpc-required');
  for (const value of ['http', 'LEGACY-HTTP', '', null, 1, true, {}, ['legacy-http']]) {
    assert.equal(adapterIsolationMode({ adapterIsolation: value }), 'xpc-required', JSON.stringify(value));
  }
  assert.equal(adapterIsolationMode(require('../package.json')), 'legacy-http', 'the shipped flag is unchanged by this unit');
});

test('frames use the analyzer wire: 4-byte length, bounded JSON object, refusal from the prefix alone', () => {
  assert.equal(MAX_REQUEST_FRAME_BYTES, 10 * 1024 * 1024 + 4096);
  assert.equal(MAX_RESPONSE_FRAME_BYTES, 64 * 1024 * 1024);
  const bytes = Buffer.concat([encodeFrame({ a: 1 }, 64), encodeFrame({ b: 2 }, 64)]);
  const decoder = createFrameDecoder(64);
  assert.deepEqual(decoder.push(bytes.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(bytes.subarray(5)), [{ a: 1 }, { b: 2 }]);
  assert.equal(failure(() => createFrameDecoder(8).push(prefixed(9))), 'FRAME_TOO_LARGE');
  assert.equal(failure(() => createFrameDecoder(8).push(prefixed(0))), 'FRAME_EMPTY');
  assert.equal(failure(() => createFrameDecoder(8).push(prefixed(3, Buffer.from('{x}')))), 'FRAME_INVALID_JSON');
  assert.equal(failure(() => createFrameDecoder(8).push(prefixed(2, Buffer.from('[]')))), 'FRAME_NOT_OBJECT');
  const truncated = createFrameDecoder(64); truncated.push(prefixed(4, Buffer.from('{"')));
  assert.equal(failure(() => truncated.end()), 'FRAME_TRUNCATED');
  const poisoned = createFrameDecoder(8); failure(() => poisoned.push(prefixed(9)));
  assert.equal(failure(() => poisoned.push(encodeFrame({}, 8))), 'FRAME_STREAM_FAILED');
  assert.equal(failure(() => encodeFrame({ pad: 'x'.repeat(16) }, 8)), 'FRAME_TOO_LARGE');
});

function fixture(t, { entitlements = '<key>com.apple.security.app-sandbox</key><true/>', listed = true, bytes = Buffer.from('supervisor') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = SUPERVISOR_EXECUTABLE.join('/');
  const file = path.join(root, ...SUPERVISOR_EXECUTABLE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o755 });
  const manifest = { files: listed ? { [relative]: sha(bytes) } : {} };
  const readEntitlements = async target => { assert.equal(target, file); return `<plist><dict>${entitlements}</dict></plist>`; };
  return { root, file, relative, manifest, readEntitlements };
}

test('attestation binds the fixed packaged supervisor path, its manifest hash and a sandbox-only entitlement set', async t => {
  const good = fixture(t);
  assert.deepEqual(await attestSupervisor({ platform: 'darwin', runtimeRoot: good.root, manifest: good.manifest, readEntitlements: good.readEntitlements }),
    { path: good.file, sha256: sha(Buffer.from('supervisor')) });
  assert.equal(await reason(attestSupervisor({ platform: 'win32', runtimeRoot: good.root, manifest: good.manifest, readEntitlements: good.readEntitlements })), 'PLATFORM_UNSUPPORTED');
  const unlisted = fixture(t, { listed: false });
  assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: unlisted.root, manifest: unlisted.manifest, readEntitlements: unlisted.readEntitlements })), 'SUPERVISOR_NOT_IN_MANIFEST');
  const missing = fixture(t); fs.rmSync(missing.file);
  assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: missing.root, manifest: missing.manifest, readEntitlements: missing.readEntitlements })), 'SUPERVISOR_MISSING');
  const linked = fixture(t); fs.renameSync(linked.file, linked.file + '.real'); fs.symlinkSync(linked.file + '.real', linked.file);
  assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: linked.root, manifest: linked.manifest, readEntitlements: linked.readEntitlements })), 'SUPERVISOR_MISSING');
  const swapped = fixture(t); fs.writeFileSync(swapped.file, 'replaced');
  assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: swapped.root, manifest: swapped.manifest, readEntitlements: swapped.readEntitlements })), 'SUPERVISOR_HASH_MISMATCH');
  for (const entitlements of ['', '<key>com.apple.security.app-sandbox</key><false/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.server</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.files.user-selected.read-only</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.files.downloads.read-write</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key><array><string>/</string></array>',
    '<key>com.apple.security.app-sandbox</key><true/><key>keychain-access-groups</key><array><string>X.y</string></array>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.automation.apple-events</key><true/>']) {
    const f = fixture(t, { entitlements });
    assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: f.root, manifest: f.manifest, readEntitlements: f.readEntitlements })),
      'SUPERVISOR_ENTITLEMENTS_REJECTED', entitlements);
  }
  const unreadable = fixture(t);
  assert.equal(await reason(attestSupervisor({ platform: 'darwin', runtimeRoot: unreadable.root, manifest: unreadable.manifest,
    readEntitlements: async () => { throw new Error('codesign failed'); } })), 'SUPERVISOR_UNSIGNED');
});

test('xpc-required never falls back to an ordinary child or the HTTP sidecar', async t => {
  let ordinary = 0, launched = 0;
  const spawnOrdinary = () => { ordinary++; };
  const bad = fixture(t); fs.writeFileSync(bad.file, 'tampered');
  assert.equal(await reason(openAdapterIsolation({ mode: 'xpc-required', platform: 'darwin', runtimeRoot: bad.root,
    manifest: bad.manifest, readEntitlements: bad.readEntitlements, launchSupervisor: async () => { launched++; }, spawnOrdinary })), 'SUPERVISOR_HASH_MISMATCH');
  const good = fixture(t);
  // The production build has no XPC bridge yet: a verified supervisor still cannot be reached.
  assert.equal(await reason(openAdapterIsolation({ mode: 'xpc-required', platform: 'darwin', runtimeRoot: good.root,
    manifest: good.manifest, readEntitlements: good.readEntitlements, spawnOrdinary })), 'SUPERVISOR_BRIDGE_UNAVAILABLE');
  assert.equal(await reason(openAdapterIsolation({ mode: 'xpc-required', platform: 'darwin', runtimeRoot: good.root,
    manifest: good.manifest, readEntitlements: good.readEntitlements, spawnOrdinary,
    launchSupervisor: async () => { launched++; throw new Error('sandbox init failed'); } })), 'SUPERVISOR_LAUNCH_FAILED');
  assert.equal(await reason(openAdapterIsolation({ mode: 'unknown', platform: 'darwin', runtimeRoot: good.root,
    manifest: good.manifest, readEntitlements: good.readEntitlements, spawnOrdinary })), 'MODE_INVALID');
  assert.deepEqual({ ordinary, launched }, { ordinary: 0, launched: 1 });
  const session = { analyze: async () => ({}) };
  const opened = await openAdapterIsolation({ mode: 'xpc-required', platform: 'darwin', runtimeRoot: good.root,
    manifest: good.manifest, readEntitlements: good.readEntitlements, spawnOrdinary,
    launchSupervisor: async attested => { assert.equal(attested.path, good.file); return session; } });
  assert.deepEqual({ mode: opened.mode, isolated: opened.isolated, session: opened.session === session }, { mode: 'xpc-required', isolated: true, session: true });
  assert.deepEqual(await openAdapterIsolation({ mode: 'legacy-http' }), { mode: 'legacy-http', isolated: false });
  assert.equal(ordinary, 0);
});

function adapterPair() {
  const toAdapter = new PassThrough(), fromAdapter = new PassThrough(), received = [];
  const decoder = createFrameDecoder(MAX_REQUEST_FRAME_BYTES);
  toAdapter.on('data', chunk => received.push(...decoder.push(chunk)));
  return { toAdapter, fromAdapter, received, send: value => fromAdapter.write(encodeFrame(value, 1 << 20)) };
}
const ready = { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, ready: true };

test('the stdio client performs the run-token handshake and matches responses to requests in order', async () => {
  const pair = adapterPair();
  const client = createStdioAdapterClient({ input: pair.fromAdapter, output: pair.toAdapter, runToken: TOKEN });
  pair.send(ready);
  await client.ready;
  assert.deepEqual(pair.received[0], { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken: TOKEN });
  const first = client.analyze({ files: [{ path: 'a.ts', content: '' }] });
  const second = client.analyze({ files: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pair.received.slice(1).map(frame => [frame.id, frame.op]), [[1, 'analyze'], [2, 'analyze']]);
  pair.send({ id: 1, ok: true, result: { nodes: [] } });
  pair.send({ id: 2, ok: false, error: { status: 400, response: { message: 'files array is required' } } });
  assert.deepEqual(await first, { nodes: [] });
  await assert.rejects(second, error => error.code === 'ADAPTER_REQUEST_REJECTED' && error.status === 400);
});

test('protocol violations from the adapter fail closed as ADAPTER_ISOLATION_UNAVAILABLE', async () => {
  for (const [label, act] of [
    ['refused handshake', pair => pair.send({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, error: 'PROTOCOL_MISMATCH' })],
    ['other version', pair => pair.send({ ...ready, version: 2 })],
    ['oversized frame', pair => pair.fromAdapter.write(prefixed(MAX_RESPONSE_FRAME_BYTES + 1))],
    ['early end', pair => pair.fromAdapter.end()],
  ]) {
    const pair = adapterPair();
    const client = createStdioAdapterClient({ input: pair.fromAdapter, output: pair.toAdapter, runToken: TOKEN });
    act(pair);
    assert.equal(await reason(client.ready), label === 'oversized frame' ? 'FRAME_TOO_LARGE' : label === 'early end' ? 'ADAPTER_CLOSED' : 'PROTOCOL_MISMATCH', label);
  }
  const pair = adapterPair();
  const client = createStdioAdapterClient({ input: pair.fromAdapter, output: pair.toAdapter, runToken: TOKEN });
  pair.send(ready); await client.ready;
  const pending = client.analyze({ files: [] });
  pair.send({ id: 7, ok: true, result: {} });
  assert.equal(await reason(pending), 'PROTOCOL_MISMATCH');
  assert.equal(await reason(client.analyze({ files: [] })), 'PROTOCOL_MISMATCH', 'a violated session stays closed');
});

test('an oversized request is refused before any byte reaches the adapter', async () => {
  const pair = adapterPair();
  const client = createStdioAdapterClient({ input: pair.fromAdapter, output: pair.toAdapter, runToken: TOKEN });
  pair.send(ready); await client.ready;
  const before = pair.received.length;
  await assert.rejects(client.analyze({ files: [{ path: 'big.ts', content: 'x'.repeat(MAX_REQUEST_FRAME_BYTES) }] }),
    error => error.code === 'ANALYSIS_LIMIT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pair.received.length, before);
  assert.throws(() => createStdioAdapterClient({ input: pair.fromAdapter, output: pair.toAdapter, runToken: 'short' }), /run token/);
});

function loadMain(metadata) {
  const spawns = [], logs = [];
  const electron = { app: { isPackaged: true, requestSingleInstanceLock: () => true, hasSingleInstanceLock: () => true,
    getVersion: () => '0.1.0', whenReady: () => new Promise(() => {}), on() {}, quit() {}, exit() {},
    getPath: () => { throw new Error('synthetic main must not resolve a real profile path'); } },
  BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, ipcMain: { on() {}, handle() {} },
  dialog: {}, shell: {} };
  const sourceRoot = path.resolve(__dirname, '../src');
  const context = vm.createContext({ Buffer, URL, AbortSignal, __dirname: sourceRoot,
    console: { ...console, error: (...values) => logs.push(values.join(' ')) },
    process: { env: { PATH: '/synthetic/bin' }, argv: ['electron', '.'], pid: 4242, platform: 'darwin', arch: 'arm64',
      execPath: '/synthetic/electron', resourcesPath: '/synthetic/resources', getuid: process.getuid.bind(process) },
    require: name => name === 'electron' ? electron : name === '../package.json' ? metadata
      : require(name.startsWith('./') ? path.join(sourceRoot, name) : name),
    setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'main.cjs'), 'utf8'), context);
  context.syntheticSpawn = (...values) => { spawns.push(values); };
  vm.runInContext(`runtimeManifest = { files: {} }; runtime = { ports: { analyzer: 1 }, transport: { materials: { analyzer: {} } } };
    spawnManaged = async (...values) => syntheticSpawn(...values);`, context);
  return { context, spawns, logs, run: source => vm.runInContext(source, context) };
}

test('main starts no ordinary analyzer child when the build requires XPC isolation and records the refusal', async () => {
  const h = loadMain({ ...require('../package.json'), adapterIsolation: 'xpc-required' });
  const ready = await h.run('spawnAnalyzer()');
  assert.equal(typeof ready, 'function');
  await ready({ aborted: false });
  assert.deepEqual(h.spawns, [], 'no ordinary child, no ELECTRON_RUN_AS_NODE, no HTTP sidecar');
  const status = JSON.parse(JSON.stringify(h.run('runtime.adapterIsolation')));
  assert.equal(status.mode, 'xpc-required');
  assert.equal(status.code, 'ADAPTER_ISOLATION_UNAVAILABLE');
  assert.equal(typeof status.reason, 'string');
  assert.ok(h.logs.some(line => line.startsWith('DESKTOP_ADAPTER_ISOLATION ADAPTER_ISOLATION_UNAVAILABLE ')), h.logs.join('\n'));
});

test('the default build keeps the current analyzer launch unchanged', async () => {
  const h = loadMain(require('../package.json'));
  h.run(`binary = (...parts) => '/synthetic/runtime/' + parts.join('/');`);
  await h.run('spawnAnalyzer()');
  assert.equal(h.spawns.length, 1);
  const [name, command, args, options] = h.spawns[0];
  assert.deepEqual([name, command, [...args]], ['ts-analyzer', '/synthetic/electron', ['/synthetic/runtime/ts-analyzer/dist/main.js']]);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('runtime.adapterIsolation'))), { mode: 'legacy-http', isolated: false });
});

test('the RunAsNode fuse follows the same flag: off once main no longer needs ELECTRON_RUN_AS_NODE', () => {
  const { fusesFor } = require('../scripts/electron-fuses.cjs');
  assert.equal(fusesFor('dev.codeintelligence.desktop', { adapterIsolation: 'xpc-required' }).runAsNode, false);
  assert.equal(fusesFor('dev.codeintelligence.desktop', {}).runAsNode, true);
  assert.equal(fusesFor('dev.codeintelligence.desktop.validation', { adapterIsolation: 'xpc-required' }).runAsNode, false);
  assert.equal(fusesFor('dev.codeintelligence.desktop').runAsNode, adapterIsolationMode(require('../package.json')) === 'legacy-http');
});
