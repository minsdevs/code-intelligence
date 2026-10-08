'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const tls = require('node:tls');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { once } = require('node:events');
const { createWindowsBoundary } = require('../src/windows-native-boundary.cjs');
const { createServiceTransport, createPinnedClient } = require('../src/service-transport.cjs');
const { readStorageFile, writeStorageFile } = require('../src/windows-storage-files.cjs');

// Real Windows helper tests, not protocol-model or POSIX permission evidence.
// Test-only staged inventory input; production receives a main-owned verified capability.
const runtime = process.env.CI_WINDOWS_BOUNDARY_TEST_RUNTIME;
const enabled = process.platform === 'win32' && !!runtime;
async function fixture(t) {
  const native = createWindowsBoundary(runtime), children = [];
  const boundary = { ...native, launch(...args) { const child = native.launch(...args); children.push(child); return child; } };
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-service-native-'));
  const root = path.join(container, 'private 한글 space'); boundary.createDirectory(root);
  const servers = [https.createServer(), https.createServer(), tls.createServer()];
  let transport, allowCloseFailure = false;
  t.after(async () => {
    try { await transport?.close().catch(error => { if (!allowCloseFailure) throw error; }); }
    finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'close')));
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
  for (const server of servers) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let token = 'first-launch-token', lost;
  const loss = new Promise(resolve => { lost = resolve; });
  transport = await createServiceTransport({ userData: root, windowsBoundary: boundary, onLost: lost,
    ports: { backend: servers[0].address().port, analyzer: servers[1].address().port, redis: servers[2].address().port, postgres: 5432 },
    getApiToken: () => token });
  const storage = await native.openStorage(transport.directory, { mode: 'private' });
  try {
    for (const [index, name] of ['backend', 'analyzer', 'redis'].entries()) {
      const { bytes } = await readStorageFile(storage, path.basename(transport.materials[name].key), 8192);
      try { servers[index].setSecureContext({ key: bytes, cert: transport.materials[name].pem }); }
      finally { bytes.fill(0); }
    }
  } finally { await storage.close(); }
  const requests = [];
  servers[0].on('request', (req, res) => {
    if (['GET', 'HEAD'].includes(req.method) && req.headers['x-code-intelligence-token'] === undefined
      && !['/health', '/never'].includes(req.url)) { res.writeHead(404).end(); req.resume(); return; }
    requests.push(req.url);
    assert.equal(req.headers['x-code-intelligence-token'], token);
    res.writeHead(204); res.end();
  });
  servers[1].on('request', (req, res) => {
    if (['GET', 'HEAD'].includes(req.method) && req.headers.authorization === undefined
      && req.url !== '/health') { res.writeHead(404).end(); req.resume(); return; }
    assert.equal(req.headers.authorization, 'Bearer ' + transport.analyzerToken); res.writeHead(204); res.end();
  });
  servers[2].on('secureConnection', socket => {
    let received = '';
    socket.on('error', () => {});
    socket.on('data', bytes => {
      received += bytes.toString('ascii');
      if (!received.endsWith('PING\r\n')) return;
      assert.equal(received, `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(transport.redisPassword)}\r\n${transport.redisPassword}\r\n*1\r\n$4\r\nPING\r\n`);
      socket.write('+OK\r\n+PONG\r\n');
    });
  });
  return { root, native, children, transport, loss, requests, rotate() { token = 'rotated-launch-token'; },
    allowCloseFailure() { allowCloseFailure = true; } };
}

test('native private TLS material serves pinned HTTPS, current tokens, Redis AUTH, and exact cleanup', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), transport = f.transport;
  const wrong = createPinnedClient(transport.materials.analyzer, Number(new URL(transport.backend.origin).port));
  try { await assert.rejects(wrong.request(transport.backend.origin + '/never')); }
  finally { await wrong.close(); }
  assert.deepEqual(f.requests, []);
  assert.equal((await transport.backend.request(transport.backend.origin + '/health')).status, 204);
  f.rotate();
  assert.equal((await transport.backend.request(transport.backend.origin + '/health')).status, 204);
  assert.equal((await transport.analyzer.request(transport.analyzer.origin + '/health')).status, 204);
  assert.equal(await transport.redisReady(), true);
  assert.match(transport.jdbcUrl, /sslmode=verify-full&sslrootcert=/);
  assert.equal(transport.postgresEnvironment.PGSSLMODE, 'verify-full');
  const storage = await f.native.openStorage(f.root, { mode: 'private' });
  try {
    const state = await storage.stat(path.relative(f.root, transport.materials.backend.key));
    assert.equal(Object.keys(state).length, 12); assert.equal(state.platform, 'win32'); assert.equal(state.kind, 'file');
    assert.match(state.identity, /^WI1:/); assert.match(state.owner, /^S-1-/);
    await writeStorageFile(storage, 'unrelated', Buffer.from('retain'));
  } finally { await storage.close(); }
  await transport.close();
  assert.equal(fs.existsSync(transport.directory), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'unrelated'), 'utf8'), 'retain');
  assert.throws(() => transport.backend.request(transport.backend.origin + '/closed'));
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('native teardown refuses an unrecorded entry without deleting any owned material', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t); f.allowCloseFailure();
  const storage = await f.native.openStorage(f.transport.directory, { mode: 'private' });
  try { await writeStorageFile(storage, 'unrelated', Buffer.from('retain')); }
  finally { await storage.close(); }
  await assert.rejects(f.transport.close());
  assert.equal(fs.readFileSync(path.join(f.transport.directory, 'unrelated'), 'utf8'), 'retain');
  assert.ok(fs.existsSync(f.transport.materials.backend.key));
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('native storage-helper loss revokes clients and leaves material for diagnosis', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t); f.allowCloseFailure();
  const child = f.children.find(child => child.exitCode === null && child.signalCode === null);
  assert.ok(child); child.kill();
  assert.match((await f.loss).message, /DESKTOP_TRANSPORT_LOST/);
  assert.throws(() => f.transport.backend.request(f.transport.backend.origin + '/lost'));
  assert.throws(() => f.transport.redisReady());
  await assert.rejects(f.transport.close());
  assert.ok(fs.existsSync(f.transport.materials.backend.key));
});

test('native teardown refuses a changed material token and retains all files', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t); f.allowCloseFailure();
  const file = f.transport.materials.backend.key;
  fs.appendFileSync(file, 'changed-by-test');
  await assert.rejects(f.transport.close());
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('changed-by-test'));
  for (const material of Object.values(f.transport.materials)) {
    assert.ok(fs.existsSync(material.key)); assert.ok(fs.existsSync(material.cert));
  }
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});
