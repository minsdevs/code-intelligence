'use strict';

// ADR-01 backend -> main control path: install-private Unix-domain socket permissions, the per-backend
// capability, request bounds, the visible ADAPTER_ISOLATION_UNAVAILABLE refusal and cancellation.
// A real socket in a temporary directory; the adapter session is a synthetic double.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_SOCKET_PATH_BYTES, controlDirectory, openAdapterControl } = require('../src/adapter-control.cjs');
const { AdapterIsolationError, MAX_REQUEST_FRAME_BYTES, createFrameDecoder, encodeFrame } = require('../src/adapter-isolation.cjs');

function parent(t) {
  const directory = fs.realpathSync(fs.mkdtempSync('/tmp/ci-ctl-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function exchange(socketPath, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = createFrameDecoder(64 * 1024 * 1024);
    const frames = [];
    socket.on('data', chunk => frames.push(...decoder.push(chunk)));
    socket.on('error', reject);
    socket.on('close', () => resolve(frames));
    socket.on('connect', () => socket.write(bytes));
  });
}
const request = (socketPath, value) => exchange(socketPath, encodeFrame(value, MAX_REQUEST_FRAME_BYTES)).then(frames => frames[0]);

test('the control socket is private to the user: 0700 directory, 0600 socket, path within sun_path', async t => {
  const control = await openAdapterControl({ parents: [parent(t)], handler: { health: async () => {}, analyze: async () => ({}) } });
  t.after(() => control.close());
  const socket = fs.lstatSync(control.socketPath), directory = fs.lstatSync(path.dirname(control.socketPath));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(socket.uid, process.getuid());
  assert.ok(Buffer.byteLength(control.socketPath) <= MAX_SOCKET_PATH_BYTES);
  await control.close();
  assert.equal(fs.existsSync(path.dirname(control.socketPath)), false, 'closing removes the socket directory');
});

test('a parent too deep for sun_path is skipped, and none fitting fails closed', () => {
  const deep = '/tmp/' + 'd'.repeat(90);
  assert.equal(controlDirectory([deep, '/tmp']), '/tmp');
  assert.throws(() => controlDirectory([deep, 'relative/dir']), error => error.code === 'ADAPTER_CONTROL_PATH_TOO_LONG');
});

test('only the current capability is served; rotation revokes the previous backend', async t => {
  let analyzed = 0;
  const control = await openAdapterControl({ parents: [parent(t)], handler: { health: async () => {},
    analyze: async body => { analyzed++; return { echoed: body.files.length }; } } });
  t.after(() => control.close());
  const first = control.capability();
  assert.deepEqual(await request(control.socketPath, { capability: first, op: 'health' }), { ok: true, result: {} });
  assert.deepEqual(await request(control.socketPath, { capability: first, op: 'analyze', body: { files: [1, 2] } }), { ok: true, result: { echoed: 2 } });
  const second = control.rotate();
  assert.notEqual(second, first);
  assert.deepEqual(await request(control.socketPath, { capability: first, op: 'analyze', body: { files: [] } }), { ok: false, code: 'CAPABILITY_REJECTED' });
  for (const capability of ['', 'x'.repeat(64), second.toUpperCase(), 7, null]) {
    assert.deepEqual(await request(control.socketPath, { capability, op: 'health' }), { ok: false, code: 'CAPABILITY_REJECTED' }, String(capability));
  }
  assert.equal(analyzed, 1, 'a rejected capability never reaches the adapter');
  for (const value of [{ capability: second, op: 'health', body: {} }, { capability: second, op: 'analyze' }, { capability: second, op: 'spawn', body: {} }]) {
    assert.deepEqual(await request(control.socketPath, value), { ok: false, code: 'INVALID_REQUEST' }, JSON.stringify(value));
  }
});

test('oversized, malformed or repeated frames close the connection without a response', async t => {
  let calls = 0;
  const control = await openAdapterControl({ parents: [parent(t)], handler: { health: async () => { calls++; }, analyze: async () => { calls++; } } });
  t.after(() => control.close());
  const prefix = length => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(length); return bytes; };
  assert.deepEqual(await exchange(control.socketPath, prefix(MAX_REQUEST_FRAME_BYTES + 1)), []);
  assert.deepEqual(await exchange(control.socketPath, Buffer.concat([prefix(2), Buffer.from('[]')])), []);
  const health = encodeFrame({ capability: control.capability(), op: 'health' }, 1024);
  assert.deepEqual(await exchange(control.socketPath, Buffer.concat([health, health])), []);
  assert.equal(calls, 0);
});

test('an unavailable isolation and adapter rejections reach the backend as codes, never as text', async t => {
  let mode = 'unavailable';
  const control = await openAdapterControl({ parents: [parent(t)], handler: {
    health: async () => { throw new AdapterIsolationError('SUPERVISOR_HASH_MISMATCH'); },
    analyze: async () => {
      if (mode === 'unavailable') throw new AdapterIsolationError('WORKER_REJECTED');
      if (mode === 'syntax') throw Object.assign(new Error('Adapter rejected the analysis request'), { code: 'ADAPTER_REQUEST_REJECTED', status: 400,
        response: { code: 'TS_SYNTAX_ERROR', retryable: false } });
      throw new Error('/Users/someone/private/path exploded');
    } } });
  t.after(() => control.close());
  const capability = control.capability();
  assert.deepEqual(await request(control.socketPath, { capability, op: 'health' }),
    { ok: false, code: 'ADAPTER_ISOLATION_UNAVAILABLE', reason: 'SUPERVISOR_HASH_MISMATCH' });
  assert.deepEqual(await request(control.socketPath, { capability, op: 'analyze', body: {} }),
    { ok: false, code: 'ADAPTER_ISOLATION_UNAVAILABLE', reason: 'WORKER_REJECTED' });
  mode = 'syntax';
  assert.deepEqual(await request(control.socketPath, { capability, op: 'analyze', body: {} }),
    { ok: false, error: { status: 400, response: { code: 'TS_SYNTAX_ERROR', retryable: false } } });
  mode = 'crash';
  assert.deepEqual(await request(control.socketPath, { capability, op: 'analyze', body: {} }), { ok: false, code: 'ANALYZER_FAILURE' });
});

test('a backend that disconnects cancels its analysis', async t => {
  let started, aborted;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const abortedPromise = new Promise(resolve => { aborted = resolve; });
  const control = await openAdapterControl({ parents: [parent(t)], handler: { health: async () => {},
    analyze: (body, { signal }) => { started(); signal.addEventListener('abort', () => aborted(true)); return new Promise(() => {}); } } });
  t.after(() => control.close());
  const socket = net.createConnection(control.socketPath);
  socket.on('error', () => {});
  socket.write(encodeFrame({ capability: control.capability(), op: 'analyze', body: {} }, 1024));
  await startedPromise;
  socket.destroy();
  assert.equal(await abortedPromise, true);
});

test('a connection that never completes its request is dropped', async t => {
  const control = await openAdapterControl({ parents: [parent(t)], requestTimeoutMs: 50, handler: { health: async () => {}, analyze: async () => ({}) } });
  t.after(() => control.close());
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(100);
  assert.deepEqual(await exchange(control.socketPath, prefix), []);
});

test('the socket parent defaults stay short enough on this machine', () => {
  assert.doesNotThrow(() => controlDirectory([os.tmpdir()]));
});
