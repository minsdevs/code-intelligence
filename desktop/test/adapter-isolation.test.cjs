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
  ADAPTER_STDIO_PROTOCOL, ADAPTER_STDIO_VERSION, BRIDGE_EXECUTABLE, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
  SUPERVISOR_EXECUTABLE, TEST_ONLY_MODE, AdapterIsolationError, adapterIsolationMode, adapterIsolationRuntimeMode,
  attestSupervisor, createBridgeAdapter, createFrameDecoder, createStdioAdapterClient, createTestOnlyAdapter, encodeFrame,
  isSyntheticFixtureRequest, openAdapterIsolation
} = require('../src/adapter-isolation.cjs');
const { EventEmitter } = require('node:events');

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

function fixture(t, { entitlements = '<key>com.apple.security.app-sandbox</key><true/>', bridgeEntitlements = '', listed = true,
  bytes = Buffer.from('supervisor'), bridgeBytes = Buffer.from('bridge') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ...SUPERVISOR_EXECUTABLE), bridge = path.join(root, ...BRIDGE_EXECUTABLE);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o755 }); fs.writeFileSync(bridge, bridgeBytes, { mode: 0o755 });
  const manifest = { files: {}, ...(listed ? { adapterSupervisor: { format: 1, supervisorSha256: sha(bytes), bridgeSha256: sha(bridgeBytes) } } : {}) };
  const readEntitlements = async target => {
    assert.ok([file, bridge].includes(target), target);
    return `<plist><dict>${target === file ? entitlements : bridgeEntitlements}</dict></plist>`;
  };
  return { root, file, bridge, manifest, readEntitlements, appContents: root };
}

const attest = (f, overrides = {}) => attestSupervisor({ platform: 'darwin', appContents: f.appContents, manifest: f.manifest,
  readEntitlements: f.readEntitlements, ...overrides });

test('attestation binds the fixed packaged supervisor and bridge, their manifest hashes and their entitlements', async t => {
  const good = fixture(t);
  assert.deepEqual(await attest(good),
    { path: good.file, sha256: sha(Buffer.from('supervisor')), bridge: good.bridge, bridgeSha256: sha(Buffer.from('bridge')) });
  assert.equal(await reason(attest(good, { platform: 'win32' })), 'PLATFORM_UNSUPPORTED');
  assert.equal(await reason(attest(fixture(t, { listed: false }))), 'SUPERVISOR_NOT_IN_MANIFEST');
  const malformed = fixture(t); malformed.manifest.adapterSupervisor.format = 2;
  assert.equal(await reason(attest(malformed)), 'SUPERVISOR_NOT_IN_MANIFEST');
  const runtimeListed = fixture(t, { listed: false });
  runtimeListed.manifest.files['adapter-supervisor/AdapterSupervisor.xpc/Contents/MacOS/AdapterSupervisor'] = sha(Buffer.from('supervisor'));
  assert.equal(await reason(attest(runtimeListed)), 'SUPERVISOR_NOT_IN_MANIFEST', 'the runtime-tree location of the first draft is not accepted');
  const missing = fixture(t); fs.rmSync(missing.file);
  assert.equal(await reason(attest(missing)), 'SUPERVISOR_MISSING');
  const linked = fixture(t); fs.renameSync(linked.file, linked.file + '.real'); fs.symlinkSync(linked.file + '.real', linked.file);
  assert.equal(await reason(attest(linked)), 'SUPERVISOR_MISSING');
  const swapped = fixture(t); fs.writeFileSync(swapped.file, 'replaced');
  assert.equal(await reason(attest(swapped)), 'SUPERVISOR_HASH_MISMATCH');
  const noBridge = fixture(t); fs.rmSync(noBridge.bridge);
  assert.equal(await reason(attest(noBridge)), 'BRIDGE_MISSING');
  const linkedBridge = fixture(t); fs.renameSync(linkedBridge.bridge, linkedBridge.bridge + '.real'); fs.symlinkSync(linkedBridge.bridge + '.real', linkedBridge.bridge);
  assert.equal(await reason(attest(linkedBridge)), 'BRIDGE_MISSING');
  const swappedBridge = fixture(t); fs.writeFileSync(swappedBridge.bridge, 'replaced');
  assert.equal(await reason(attest(swappedBridge)), 'BRIDGE_HASH_MISMATCH');
  for (const entitlements of ['', '<key>com.apple.security.app-sandbox</key><false/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.server</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.files.user-selected.read-only</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.files.downloads.read-write</key><true/>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key><array><string>/</string></array>',
    '<key>com.apple.security.app-sandbox</key><true/><key>keychain-access-groups</key><array><string>X.y</string></array>',
    '<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.automation.apple-events</key><true/>']) {
    assert.equal(await reason(attest(fixture(t, { entitlements }))), 'SUPERVISOR_ENTITLEMENTS_REJECTED', entitlements);
  }
  for (const bridgeEntitlements of ['<key>com.apple.security.get-task-allow</key><true/>',
    '<key>com.apple.security.cs.disable-library-validation</key><true/>', '<key>com.apple.security.app-sandbox</key><false/>']) {
    assert.equal(await reason(attest(fixture(t, { bridgeEntitlements }))), 'BRIDGE_ENTITLEMENTS_REJECTED', bridgeEntitlements);
  }
  const unreadable = fixture(t);
  assert.equal(await reason(attest(unreadable, { readEntitlements: async () => { throw new Error('codesign failed'); } })), 'SUPERVISOR_UNSIGNED');
  const unsignedBridge = fixture(t);
  assert.equal(await reason(attest(unsignedBridge, { readEntitlements: async target => {
    if (target === unsignedBridge.bridge) throw new Error('codesign failed');
    return '<plist><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>';
  } })), 'BRIDGE_UNSIGNED');
});

test('xpc-required never falls back to an ordinary child or the HTTP sidecar', async t => {
  let ordinary = 0, launched = 0;
  const spawnOrdinary = () => { ordinary++; };
  const open = (f, extra = {}) => openAdapterIsolation({ mode: 'xpc-required', platform: 'darwin', appContents: f.appContents,
    manifest: f.manifest, readEntitlements: f.readEntitlements, spawnOrdinary, ...extra });
  const bad = fixture(t); fs.writeFileSync(bad.file, 'tampered');
  assert.equal(await reason(open(bad, { launchSupervisor: async () => { launched++; } })), 'SUPERVISOR_HASH_MISMATCH');
  const good = fixture(t);
  assert.equal(await reason(open(good, { launchSupervisor: async () => { launched++; throw new Error('sandbox init failed'); } })), 'SUPERVISOR_LAUNCH_FAILED');
  assert.equal(await reason(openAdapterIsolation({ mode: 'unknown', platform: 'darwin', appContents: good.root,
    manifest: good.manifest, readEntitlements: good.readEntitlements, spawnOrdinary })), 'MODE_INVALID');
  assert.equal(await reason(openAdapterIsolation({ mode: TEST_ONLY_MODE, spawnOrdinary })), 'MODE_INVALID', 'TEST_ONLY needs its explicit development worker');
  assert.deepEqual({ ordinary, launched }, { ordinary: 0, launched: 1 });
  const session = { analyze: async () => ({}) };
  const opened = await open(good, { launchSupervisor: async attested => { assert.equal(attested.path, good.file); return session; } });
  assert.deepEqual({ mode: opened.mode, isolated: opened.isolated, session: opened.session === session }, { mode: 'xpc-required', isolated: true, session: true });
  const bridged = await open(good);
  assert.equal(bridged.session.isolated, true, 'the default launcher is the attested bridge');
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

// A synthetic bridge (or TEST_ONLY worker) process: reads the open line (bridge only), then plays the
// worker side of the framed session. No supervisor, analyzer or Electron process is started.
function fakeProcesses({ exitBeforeHandshake, hang = false, hangAfter = Infinity, tokenFromEnv = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(), call = { command, args: [...args], env: { ...options.env }, stdio: options.stdio, preamble: null, frames: [], killed: null, answered: 0, stdinEnded: false };
    calls.push(call);
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
    const exit = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code; child.signalCode = signal; child.stdout.end(); child.emit('exit', code, signal);
    };
    child.kill = signal => { call.killed = signal; exit(null, signal); return true; };
    const decoder = createFrameDecoder(MAX_REQUEST_FRAME_BYTES);
    // Like the analyzer, a worker knows only the 03 §6 sessions opened in its own process.
    const sessions = new Set();
    const answer = ({ id, body }) => {
      const command = body.session;
      if (!command) return { id, ok: true, result: { analyzed: body.files.length } };
      if (command.op === 'open') {
        const opened = crypto.randomBytes(16).toString('hex');
        sessions.add(opened);
        return { id, ok: true, result: { session: { id: opened, op: 'open' } } };
      }
      const refuse = code => ({ id, ok: false, error: { status: 400, response: { statusCode: 400, code, retryable: false } } });
      if (!sessions.has(command.id)) return refuse('SESSION_UNKNOWN');
      if (!['put', 'seal', 'analyze', 'page', 'close'].includes(command.op)) return refuse('SESSION_INVALID');
      if (command.op === 'close') sessions.delete(command.id);
      return { id, ok: true, result: { session: { id: command.id, op: command.op } } };
    };
    let pending = Buffer.alloc(0), token = tokenFromEnv ? options.env.ADAPTER_RUN_TOKEN : null;
    child.stdin.on('data', chunk => {
      if (exitBeforeHandshake !== undefined && call.preamble !== null) return;
      let bytes = chunk;
      if (!tokenFromEnv && call.preamble === null) {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf(0x0a);
        if (end < 0) return;
        call.preamble = pending.subarray(0, end).toString('utf8');
        token = call.preamble.split(' ')[2];
        bytes = pending.subarray(end + 1);
        if (exitBeforeHandshake !== undefined) { setImmediate(() => exit(exitBeforeHandshake)); return; }
      }
      for (const frame of decoder.push(bytes)) {
        call.frames.push(frame);
        if (hang || (frame.runToken === undefined && ++call.answered > hangAfter)) continue;
        if (frame.runToken !== undefined) {
          child.stdout.write(encodeFrame(frame.runToken === token
            ? { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, ready: true }
            : { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, error: 'PROTOCOL_MISMATCH' }, 1024));
        } else child.stdout.write(encodeFrame(answer(frame), 1 << 20));
      }
    });
    child.stdin.on('finish', () => { call.stdinEnded = true; setImmediate(() => exit(0)); });
    return child;
  };
  return { spawn, calls };
}

test('each isolated analysis runs its own bridge session with a fresh run token that never leaves stdin', async () => {
  const fake = fakeProcesses();
  const adapter = createBridgeAdapter({ bridge: '/App.app/Contents/MacOS/adapter-bridge', spawn: fake.spawn });
  assert.deepEqual(await adapter.analyze({ files: [{ path: 'a.ts', content: '' }] }), { analyzed: 1 });
  assert.deepEqual(await adapter.analyze({ files: [] }), { analyzed: 0 });
  assert.equal(fake.calls.length, 2);
  const tokens = fake.calls.map(call => call.preamble.match(/^open ts-analyzer ([0-9a-f]{64})$/)?.[1]);
  assert.ok(tokens.every(Boolean) && tokens[0] !== tokens[1], JSON.stringify(fake.calls.map(call => call.preamble)));
  for (const [index, call] of fake.calls.entries()) {
    assert.equal(call.command, '/App.app/Contents/MacOS/adapter-bridge');
    assert.deepEqual(call.args, []);
    assert.deepEqual(call.stdio, ['pipe', 'pipe', 'ignore']);
    assert.equal(JSON.stringify(call.env).includes(tokens[index]), false, 'the run token is not in the environment');
    assert.deepEqual(call.frames[0], { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken: tokens[index] });
    assert.equal(call.killed, null, 'a finished session ends by closing stdin');
  }
  await adapter.verify(); await adapter.verify();
  assert.equal(fake.calls.length, 3, 'the live handshake check runs once per runtime start');
  assert.equal(fake.calls[2].frames.length, 1, 'verification sends no analysis');
});

test('one analyzer session runs in one bridge session from open to close (03 §6)', async () => {
  const fake = fakeProcesses();
  const adapter = createBridgeAdapter({ bridge: '/b', spawn: fake.spawn });
  const opened = await adapter.analyze({ session: { op: 'open', fileCount: 1, bytes: 1, digest: 'a'.repeat(64) } });
  const id = opened.session.id;
  for (const op of ['put', 'seal', 'analyze', 'page', 'close']) {
    assert.deepEqual(await adapter.analyze({ session: { op, id } }), { session: { id, op } }, op);
  }
  assert.equal(fake.calls.length, 1, 'every command of the session reached the worker that opened it');
  assert.deepEqual(fake.calls[0].frames.slice(1).map(frame => frame.body.session.op), ['open', 'put', 'seal', 'analyze', 'page', 'close']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.calls[0].killed, null, 'close ends the session by closing stdin');
  assert.ok(fake.calls[0].stdinEnded, 'the worker is gone after close');
  const late = await adapter.analyze({ session: { op: 'put', id } }).catch(error => error);
  assert.deepEqual([late.code, late.status, late.response.code], ['ADAPTER_REQUEST_REJECTED', 400, 'SESSION_UNKNOWN'], 'a closed session is not reopened');
  assert.deepEqual(await adapter.analyze({ files: [] }), { analyzed: 0 }, 'single requests keep their own bridge session');
  assert.equal(fake.calls.length, 3);
});

test('an analyzer session ends on a rejection, an abandoned command or idleness', async () => {
  const open = adapter => adapter.analyze({ session: { op: 'open', fileCount: 1, bytes: 1, digest: 'a'.repeat(64) } }).then(reply => reply.session.id);
  const fake = fakeProcesses();
  const adapter = createBridgeAdapter({ bridge: '/b', spawn: fake.spawn, idleMs: 20 });
  const idle = await open(adapter);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(fake.calls[0].stdinEnded, 'an idle session ends its worker');
  const late = await adapter.analyze({ session: { op: 'seal', id: idle } }).catch(error => error);
  assert.equal(late.response?.code, 'SESSION_UNKNOWN');
  const rejected = await open(adapter);
  const refusal = await adapter.analyze({ session: { op: 'reopen', id: rejected } }).catch(error => error);
  assert.equal(refusal.code, 'ADAPTER_REQUEST_REJECTED');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(fake.calls.at(-1).stdinEnded, 'a rejected command ends its worker');

  const hanging = fakeProcesses({ hangAfter: 1 });
  const held = createBridgeAdapter({ bridge: '/b', spawn: hanging.spawn });
  const abandoned = await open(held);
  const controller = new AbortController();
  const pending = held.analyze({ session: { op: 'analyze', id: abandoned } }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await reason(pending), 'ADAPTER_CLOSED');
  assert.equal(hanging.calls[0].killed, 'SIGKILL', 'an abandoned command kills the session worker');
  assert.equal(hanging.calls.length, 1);
});

test('bridge refusals keep their cause and an abandoned analysis kills its bridge', async () => {
  for (const [code, expected] of [[70, 'WORKER_REJECTED'], [69, 'SUPERVISOR_LAUNCH_FAILED'], [64, 'SUPERVISOR_LAUNCH_FAILED'], [1, 'ADAPTER_CLOSED']]) {
    const fake = fakeProcesses({ exitBeforeHandshake: code });
    const adapter = createBridgeAdapter({ bridge: '/b', spawn: fake.spawn });
    assert.equal(await reason(adapter.analyze({ files: [] })), expected, String(code));
    await assert.rejects(adapter.verify(), error => error.reason === expected);
  }
  const fake = fakeProcesses({ hang: true });
  const controller = new AbortController();
  const pending = createBridgeAdapter({ bridge: '/b', spawn: fake.spawn }).analyze({ files: [] }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await reason(pending), 'ADAPTER_CLOSED');
  assert.equal(fake.calls[0].killed, 'SIGKILL');
  const slow = fakeProcesses({ hang: true });
  assert.equal(await reason(createBridgeAdapter({ bridge: '/b', spawn: slow.spawn, timeoutMs: 20 }).analyze({ files: [] })), 'ADAPTER_CLOSED');
  assert.equal(slow.calls[0].killed, 'SIGKILL', 'the analysis time limit kills the bridge');
});

test('TEST_ONLY unsigned analysis needs an unpackaged app, the explicit variable and a declared synthetic fixture', async () => {
  const xpc = { adapterIsolation: 'xpc-required' };
  const env = { CODE_INTELLIGENCE_ADAPTER_TEST_ONLY: 'synthetic-fixtures' };
  assert.equal(adapterIsolationRuntimeMode({ metadata: xpc, isPackaged: false, env }), TEST_ONLY_MODE);
  assert.equal(adapterIsolationRuntimeMode({ metadata: xpc, isPackaged: true, env }), 'xpc-required', 'a packaged app ignores the variable');
  assert.equal(adapterIsolationRuntimeMode({ metadata: {}, isPackaged: true, env }), 'legacy-http');
  assert.equal(adapterIsolationRuntimeMode({ metadata: xpc, isPackaged: undefined, env }), 'xpc-required');
  assert.equal(adapterIsolationRuntimeMode({ metadata: xpc, isPackaged: false, env: { CODE_INTELLIGENCE_ADAPTER_TEST_ONLY: '1' } }), 'xpc-required');
  assert.equal(adapterIsolationRuntimeMode({ metadata: xpc, isPackaged: false, env: {} }), 'xpc-required');
  const fixtureBody = { files: [{ path: 'package.json', content: JSON.stringify({ name: 'f', codeIntelligenceSyntheticFixture: 'TEST_ONLY' }) },
    { path: 'src/a.ts', content: '' }] };
  assert.equal(isSyntheticFixtureRequest(fixtureBody), true);
  for (const body of [{ files: [] }, { files: [{ path: 'src/package.json', content: fixtureBody.files[0].content }] },
    { files: [{ path: 'package.json', content: '{"codeIntelligenceSyntheticFixture":true}' }] },
    { files: [{ path: 'package.json', content: '{' }] }, null, { files: 'x' }]) {
    assert.equal(isSyntheticFixtureRequest(body), false, JSON.stringify(body));
  }
  const fake = fakeProcesses({ tokenFromEnv: true });
  const adapter = createTestOnlyAdapter({ execPath: '/dev/Electron', script: '/repo/analyzers/ts-analyzer/dist/stdio.js', spawn: fake.spawn });
  assert.equal(adapter.isolated, false);
  assert.equal(await reason(adapter.analyze({ files: [{ path: 'src/a.ts', content: '' }] })), 'TEST_ONLY_FIXTURE_REQUIRED');
  assert.equal(fake.calls.length, 0, 'a user repository never reaches the unsandboxed worker');
  assert.deepEqual(await adapter.analyze(fixtureBody), { analyzed: 2 });
  assert.deepEqual([fake.calls[0].command, fake.calls[0].args], ['/dev/Electron', ['/repo/analyzers/ts-analyzer/dist/stdio.js']]);
  assert.equal(fake.calls[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.match(fake.calls[0].env.ADAPTER_RUN_TOKEN, /^[0-9a-f]{64}$/);
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
  context.syntheticControl = { opened: 0, rotations: 0 };
  vm.runInContext(`runtimeManifest = { files: {} }; runtime = { ports: { analyzer: 1 }, transport: {
      analyzer: { origin: 'https://127.0.0.1:1' }, analyzerToken: 'a'.repeat(64), materials: { analyzer: { pin: 'b'.repeat(64) } } } };
    spawnManaged = async (...values) => syntheticSpawn(...values);
    openAnalyzerControl = async () => { syntheticControl.opened++; adapterControl = { socketPath: '/private/ci-adapter-x/control.sock',
      rotate: () => String(++syntheticControl.rotations).repeat(64).slice(0, 64) }; };`, context);
  return { context, spawns, logs, run: source => vm.runInContext(source, context) };
}

test('main starts no ordinary analyzer child when the build requires XPC isolation and records the refusal', async () => {
  const h = loadMain({ ...require('../package.json'), adapterIsolation: 'xpc-required' });
  const ready = await h.run('spawnAnalyzer()');
  assert.equal(typeof ready, 'function');
  await ready({ aborted: false });
  assert.deepEqual(h.spawns, [], 'no ordinary child, no ELECTRON_RUN_AS_NODE, no HTTP sidecar');
  const status = JSON.parse(JSON.stringify(h.run('runtime.adapterIsolation')));
  assert.deepEqual(status, { mode: 'xpc-required', isolated: false, code: 'ADAPTER_ISOLATION_UNAVAILABLE', reason: 'SUPERVISOR_NOT_IN_MANIFEST' });
  assert.ok(h.logs.some(line => line === 'DESKTOP_ADAPTER_ISOLATION ADAPTER_ISOLATION_UNAVAILABLE SUPERVISOR_NOT_IN_MANIFEST'), h.logs.join('\n'));
  // The control path still opens, so the backend's analysis fails with the visible refusal code.
  assert.equal(h.context.syntheticControl.opened, 1);
  await assert.rejects(h.run('runtime.adapterSession'), error => error.code === 'ADAPTER_ISOLATION_UNAVAILABLE');
});

test('the backend gets the control socket and a fresh capability per process instead of the analyzer URL', async () => {
  const h = loadMain({ ...require('../package.json'), adapterIsolation: 'xpc-required' });
  await h.run('spawnAnalyzer()');
  const first = JSON.parse(JSON.stringify(h.run('analyzerEnvironment()')));
  const second = JSON.parse(JSON.stringify(h.run('analyzerEnvironment()')));
  assert.deepEqual(Object.keys(first).sort(), ['TS_ANALYZER_CONTROL_CAPABILITY', 'TS_ANALYZER_CONTROL_SOCKET']);
  assert.equal(first.TS_ANALYZER_CONTROL_SOCKET, '/private/ci-adapter-x/control.sock');
  assert.notEqual(first.TS_ANALYZER_CONTROL_CAPABILITY, second.TS_ANALYZER_CONTROL_CAPABILITY);
  const legacy = loadMain(require('../package.json'));
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(legacy.run('analyzerEnvironment()')))).sort(),
    ['TS_ANALYZER_AUTH_TOKEN', 'TS_ANALYZER_BASE_URL', 'TS_ANALYZER_TLS_CERT_SHA256']);
  assert.equal(legacy.context.syntheticControl.opened, 0);
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
