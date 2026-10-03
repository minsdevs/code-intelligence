'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const { openAiEgressBridge, MAX_FRAME } = require('../src/ai-egress-bridge.cjs');

const CAP = 'a'.repeat(64);
const EPOCH = 'b'.repeat(64);
function envelope(overrides = {}) {
  return { version: 1, auth: CAP, epoch: EPOCH, callId: crypto.randomUUID(), operation: 'STATUS', payload: {}, ...overrides };
}
function frame(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
async function setup(t, handler = async () => ({ ready: true })) {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/ci-ai-bridge-'));
  await fs.chmod(directory, 0o700);
  const bridge = await openAiEgressBridge({ directory, capability: CAP, epoch: EPOCH, handler, frameTimeoutMs: 500 });
  t.after(async () => { await bridge.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, bridge };
}
async function exchange(socketPath, payload, { finish = true, pieces = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('test timeout')); }, 1500);
    socket.on('connect', () => {
      if (pieces) for (let i = 0; i < payload.length; i++) socket.write(payload.subarray(i, i + 1));
      else socket.write(payload);
      if (finish) socket.end();
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

test('private socket receives one complete authenticated frame and returns no capability', async t => {
  const calls = [];
  const { bridge } = await setup(t, async (operation, payload) => { calls.push({ operation, payload }); return { ready: true }; });
  const request = envelope();
  const response = await exchange(bridge.socketPath, frame(request), { pieces: true });
  assert.equal(response.readUInt32BE(0), response.length - 4);
  const value = JSON.parse(response.subarray(4));
  assert.deepEqual(value, { version: 1, callId: request.callId, ok: true, result: { ready: true } });
  assert.deepEqual(calls, [{ operation: 'STATUS', payload: {} }]);
  assert.equal(response.includes(CAP), false);
  assert.equal((await fs.lstat(bridge.socketPath)).mode & 0o777, 0o600);
});

for (const [label, patch] of [
  ['wrong capability', { auth: 'c'.repeat(64) }], ['wrong epoch', { epoch: 'c'.repeat(64) }],
  ['renderer API token', { auth: 'renderer-api-token' }], ['unknown operation', { operation: 'SEND_URL' }],
  ['unknown envelope field', { url: 'https://example.invalid' }], ['nonobject payload', { payload: [] }],
  ['wrong version', { version: 2 }], ['invalid call ID', { callId: 'unsafe' }],
]) {
  test(`private channel rejects ${label} before domain callbacks`, async t => {
    let calls = 0;
    const { bridge } = await setup(t, async () => { calls++; return {}; });
    const result = await exchange(bridge.socketPath, frame(envelope(patch)));
    assert.equal(result.length, 0); assert.equal(calls, 0);
  });
}

for (const kind of ['second-frame', 'trailing-byte', 'truncated', 'duplicate-json-key', 'invalid-utf8', 'oversized']) {
  test(`private channel rejects ${kind} before any operation`, async t => {
    let calls = 0;
    const { bridge } = await setup(t, async () => { calls++; return {}; });
    const body = JSON.stringify(envelope());
    let bytes = frame(body);
    if (kind === 'second-frame') bytes = Buffer.concat([bytes, frame(envelope())]);
    if (kind === 'trailing-byte') bytes = Buffer.concat([bytes, Buffer.from('x')]);
    if (kind === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    if (kind === 'duplicate-json-key') bytes = frame(body.replace('"version":1', '"version":2,"version":1'));
    if (kind === 'invalid-utf8') bytes = frame(Buffer.from([0xc3, 0x28]));
    if (kind === 'oversized') { bytes = Buffer.alloc(4); bytes.writeUInt32BE(MAX_FRAME + 1); }
    const result = await exchange(bridge.socketPath, bytes);
    assert.equal(result.length, 0); assert.equal(calls, 0);
  });
}

test('a complete prefix without FIN never authorizes an operation', async t => {
  let calls = 0;
  const { bridge } = await setup(t, async () => { calls++; return {}; });
  assert.equal((await exchange(bridge.socketPath, frame(envelope()), { finish: false })).length, 0);
  assert.equal(calls, 0);
});

test('handler failure emits a static error without sensitive cause', async t => {
  const { bridge } = await setup(t, async () => { throw new Error(`synthetic secret ${CAP}`); });
  const result = await exchange(bridge.socketPath, frame(envelope()));
  const value = JSON.parse(result.subarray(4));
  assert.equal(value.ok, false); assert.equal(value.code, 'AI_GATEWAY_UNAVAILABLE');
  assert.equal(result.includes(CAP), false); assert.equal(result.includes('synthetic secret'), false);
});

test('close rejects new work and waits for already running domain work', async t => {
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  const { bridge } = await setup(t, async () => { entered(); await released; return {}; });
  const request = exchange(bridge.socketPath, frame(envelope()));
  await started;
  let closed = false;
  const closing = bridge.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish(); await closing; await request;
  await bridge.close();
  await assert.rejects(fs.lstat(bridge.socketPath), { code: 'ENOENT' });
});

test('unsafe or existing socket paths are not replaced', async t => {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/ci-ai-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const args = { directory, capability: CAP, epoch: EPOCH, handler: async () => ({}) };
  await fs.chmod(directory, 0o755);
  await assert.rejects(openAiEgressBridge(args));
  await fs.chmod(directory, 0o700);
  await fs.writeFile(`${directory}/ai.sock`, 'preserve', { mode: 0o600 });
  await assert.rejects(openAiEgressBridge(args));
  assert.equal(await fs.readFile(`${directory}/ai.sock`, 'utf8'), 'preserve');
});
