'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { createSourceBroker, MAX_FRAME } = require('../src/source-broker.cjs');

const AUTH = 'a'.repeat(64);
const bytes = Buffer.from('export const value = "fixture";\n');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const LINE_TERMINATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];

function request(operation = 'PUT', changes = {}) {
  return { version: 1, requestId: crypto.randomUUID(), auth: AUTH, operation, projectId: '7', sha256,
    byteSize: bytes.length, ...(operation === 'PUT' ? { bytes: bytes.toString('base64') } : {}), ...changes };
}

function frame(value) {
  const json = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return Buffer.concat([head, json]);
}

async function exchange(socketPath, input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection(socketPath);
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture timeout')));
    socket.once('connect', () => socket.write(Buffer.isBuffer(input) ? input : frame(input)));
    socket.on('data', (data) => chunks.push(data));
    socket.once('error', reject);
    socket.once('close', () => {
      const received = Buffer.concat(chunks);
      if (!received.length) { resolve(null); return; }
      try {
        assert.equal(received.readUInt32BE(0), received.length - 4);
        resolve(JSON.parse(received.subarray(4).toString('utf8')));
      } catch (error) { reject(error); }
    });
  });
}

async function fixture(t, overrides = {}, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/ci-sb-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  const entries = new Map();
  const calls = [];
  const vault = {
    async put(value) {
      calls.push(['PUT', value.projectId]);
      const hash = crypto.createHash('sha256').update(value.bytes).digest('hex');
      entries.set(`${value.projectId}:${hash}`, Buffer.from(value.bytes));
      return { projectId: value.projectId, sha256: hash, byteSize: value.bytes.length, keyId: 'b'.repeat(32) };
    },
    async read(value) {
      calls.push(['READ', value.projectId]);
      const stored = entries.get(`${value.projectId}:${value.sha256}`);
      if (!stored) throw new Error('/private/secret/path/key-body-must-not-leak');
      return Buffer.from(stored);
    },
    ...overrides,
  };
  const broker = await createSourceBroker({ socketPath, authToken: AUTH, vault, timeoutMs: 250, ...options });
  t.after(async () => { try { await broker.close(); } finally { await fs.rm(directory, { recursive: true }); } });
  return { socketPath, calls, entries, directory, broker, vault };
}

test('private Unix socket round-trips exact bytes without key exports', async (t) => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.socketPath)).mode & 0o777, 0o600);
  const put = request();
  const stored = await exchange(f.socketPath, put);
  assert.equal(stored.requestId, put.requestId);
  assert.deepEqual(stored.result, { sha256, byteSize: bytes.length, keyId: 'b'.repeat(32) });
  const read = await exchange(f.socketPath, request('READ'));
  assert.equal(read.ok, true);
  assert.deepEqual(Buffer.from(read.result.bytes, 'base64'), bytes);
  assert.deepEqual(f.calls, [['PUT', '7'], ['READ', '7']]);
  assert.equal(JSON.stringify(stored).includes(AUTH), false);
});

test('authentication, scope, hash and envelope validation reject before vault access', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { auth: 'c'.repeat(64) }, { version: 2 }, { projectId: '../7' }, { projectId: '07' },
    { projectId: '9223372036854775808' }, { byteSize: 2 * 1024 * 1024 + 1 },
    { sha256: 'd'.repeat(64) }, { bytes: `${bytes.toString('base64')}\n` },
    { path: '/private/user-source' }, { requestId: 'invalid' }, { requestId: [crypto.randomUUID()] }, { operation: 'KEY_EXPORT' },
  ]) {
    const response = await exchange(f.socketPath, request('PUT', change));
    assert.equal(response.ok, false);
    assert.match(response.code, /^SOURCE_BROKER_(INVALID|UNAUTHORIZED|UNSUPPORTED)$/);
    assert.equal(JSON.stringify(response).includes(AUTH), false);
  }
  assert.equal(f.calls.length, 0);
});

test('identifier line terminators are rejected before vault calls and invalid request IDs are never echoed', async (t) => {
  const f = await fixture(t);
  for (const suffix of LINE_TERMINATORS) {
    for (const operation of ['PUT', 'READ']) {
      for (const field of ['auth', 'projectId', 'sha256', 'requestId']) {
        const input = request(operation);
        input[field] += suffix;
        const response = await exchange(f.socketPath, input);
        assert.equal(response.ok, false);
        assert.equal(response.code, field === 'auth' ? 'SOURCE_BROKER_UNAUTHORIZED' : 'SOURCE_BROKER_INVALID');
        assert.equal(response.requestId, field === 'requestId' ? null : input.requestId);
        assert.deepEqual(Object.keys(response).sort(), ['code', 'ok', 'requestId', 'version']);
        assert.equal(f.calls.length, 0);
      }
    }
    // Error correlation happens before authentication, so malformed IDs must not leak there either.
    const response = await exchange(f.socketPath, request('READ', {
      requestId: crypto.randomUUID() + suffix, auth: 'c'.repeat(64),
    }));
    assert.equal(response.requestId, null);
    assert.equal(response.code, 'SOURCE_BROKER_UNAUTHORIZED');
    assert.equal(f.calls.length, 0);
  }
});

test('noncanonical broker token options cannot create a socket or access the vault', async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.directory, 'candidate');
  for (const suffix of LINE_TERMINATORS) {
    await assert.rejects(async () => {
      const unexpected = await createSourceBroker({ socketPath: candidate, authToken: AUTH + suffix, vault: f.vault });
      await unexpected.close(); // A regression must not leave an extra listening server behind.
    }, { code: 'SOURCE_BROKER_UNAVAILABLE' });
    assert.equal(await fs.lstat(candidate).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }), false);
    assert.equal(f.calls.length, 0);
  }
});

test('a vault key ID with a line terminator never becomes a successful broker response', async (t) => {
  let suffix;
  let calls = 0;
  const f = await fixture(t, { async put(value) {
    calls++;
    return { projectId: value.projectId, sha256, byteSize: bytes.length, keyId: 'b'.repeat(32) + suffix };
  } });
  for (suffix of LINE_TERMINATORS) {
    const before = calls;
    const response = await exchange(f.socketPath, request());
    assert.equal(calls, before + 1);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'SOURCE_BROKER_UNAVAILABLE');
    assert.deepEqual(Object.keys(response).sort(), ['code', 'ok', 'requestId', 'version']);
  }
});

test('foreign project and vault errors have fixed safe responses', async (t) => {
  const f = await fixture(t);
  await exchange(f.socketPath, request());
  const response = await exchange(f.socketPath, request('READ', { projectId: '8' }));
  assert.deepEqual(Object.keys(response).sort(), ['code', 'ok', 'requestId', 'version']);
  assert.equal(response.code, 'SOURCE_BROKER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response), /private|secret|key-body/);
});

test('oversize, malformed, coalesced extra frames and incomplete frames cannot dispatch', async (t) => {
  const f = await fixture(t);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME + 1);
  assert.equal(await exchange(f.socketPath, oversized), null);
  assert.equal(await exchange(f.socketPath, Buffer.concat([frame(request()), frame(request())])), null);
  assert.equal(await exchange(f.socketPath, Buffer.from([0, 0, 0, 40, 123])), null);
  const malformed = await exchange(f.socketPath, Buffer.from([0, 0, 0, 2, 0xff, 0xff]));
  assert.equal(malformed.code, 'SOURCE_BROKER_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('disconnected requests retain operation slots until the vault settles', async (t) => {
  let resolveAll;
  let started = 0;
  const pending = new Promise((resolve) => { resolveAll = resolve; });
  const f = await fixture(t, { async put(value) {
    started++;
    await pending;
    return { projectId: value.projectId, sha256, byteSize: bytes.length, keyId: 'b'.repeat(32) };
  } }, { timeoutMs: 30 });
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await exchange(f.socketPath, request()).catch((error) => {
        assert.ok(['EPIPE', 'ECONNRESET'].includes(error.code));
        return null;
      });
      assert.equal(response, null);
    }
    assert.equal(started, 4);
  } finally { resolveAll(); }
});

test('a failed drain is bounded and never reports successful close', async () => {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/ci-sb-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const vault = { async put(value) { await pending; return { projectId: value.projectId, sha256, byteSize: bytes.length, keyId: 'b'.repeat(32) }; }, async read() {} };
  const broker = await createSourceBroker({ socketPath, authToken: AUTH, vault, timeoutMs: 30, drainTimeoutMs: 30 });
  try {
    assert.equal(await exchange(socketPath, request()), null);
    await assert.rejects(broker.close(), { code: 'SOURCE_BROKER_DRAIN_TIMEOUT' });
    await assert.rejects(broker.close(), { code: 'SOURCE_BROKER_DRAIN_TIMEOUT' });
  } finally { finish(); await fs.rm(directory, { recursive: true }); }
});

test('trickled incomplete frames cannot extend the absolute connection deadline', async (t) => {
  const f = await fixture(t, {}, { timeoutMs: 60 });
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.socketPath);
    let timer;
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(Buffer.from([0, 0, 1, 0]));
      timer = setInterval(() => socket.write(Buffer.from(' ')), 10);
    });
    socket.once('close', () => { clearInterval(timer); resolve(); });
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.calls.length, 0);
});

test('a fragmented second frame cannot start a second operation', async (t) => {
  let first;
  let release;
  let calls = 0;
  const started = new Promise((resolve) => { first = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { async put(value) {
    calls++; first(); await pending;
    return { projectId: value.projectId, sha256, byteSize: bytes.length, keyId: 'b'.repeat(32) };
  } });
  const socket = net.createConnection(f.socketPath);
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(frame(request()));
  await started;
  socket.write(frame(request()));
  await closed;
  release();
  assert.equal(calls, 1);
});

test('read response content is verified independently of the vault port', async (t) => {
  const f = await fixture(t, { async read() { return Buffer.alloc(bytes.length); } });
  assert.equal((await exchange(f.socketPath, request('READ'))).code, 'SOURCE_BROKER_UNAVAILABLE');
});

test('existing socket or foreign filesystem entry is never replaced', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createSourceBroker({ socketPath: f.socketPath, authToken: AUTH, vault: f.vault }));
  const existing = path.join(f.directory, 'sentinel');
  await fs.writeFile(existing, 'preserve');
  await assert.rejects(createSourceBroker({ socketPath: existing, authToken: AUTH, vault: f.vault }));
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserve');
});

test('a lost response may be retried as an exact content-addressed put', async (t) => {
  const f = await fixture(t);
  const first = await exchange(f.socketPath, request());
  const second = await exchange(f.socketPath, request());
  assert.deepEqual(second.result, first.result);
  assert.equal(f.entries.size, 1);
});
