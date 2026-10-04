'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServiceTransport, createPinnedClient } = require('../src/service-transport.cjs');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-service-tls-test-')));
  fs.chmodSync(root, 0o700);
  const server = https.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let transport, allowCloseFailure = false;
  t.after(async () => {
    await transport?.close().catch(error => { if (!allowCloseFailure) throw error; });
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true });
  });
  let token = crypto.randomBytes(32).toString('hex');
  transport = await createServiceTransport({ userData: root,
    ports: { backend: server.address().port, analyzer: 1, postgres: 2, redis: 3 }, getApiToken: () => token });
  server.setSecureContext({ key: fs.readFileSync(transport.materials.backend.key), cert: transport.materials.backend.pem });
  const requests = [];
  server.on('request', (req, res) => {
    requests.push(req.url);
    if (req.headers['x-code-intelligence-token'] !== token) { res.writeHead(401); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: transport.backend.origin + '/must-not-follow' }); res.end(); return; }
    res.writeHead(204); res.end();
  });
  return { root, transport, server, requests, allowCloseFailure() { allowCloseFailure = true; }, rotate() { token = crypto.randomBytes(32).toString('hex'); } };
}

test('pinned TLS rejects a different service before sending HTTP and uses the current launch token', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), client = f.transport.backend;
  const wrong = createPinnedClient(f.transport.materials.analyzer, new URL(client.origin).port * 1,
    { 'X-Code-Intelligence-Token': 'must-not-be-sent' });
  t.after(() => wrong.close());
  await assert.rejects(wrong.request(client.origin + '/private'));
  assert.deepEqual(f.requests, []);
  assert.equal((await client.request(client.origin + '/health')).status, 204);
  f.rotate();
  assert.equal((await client.request(client.origin + '/health')).status, 204);
  assert.throws(() => client.request(client.origin.replace('https:', 'http:') + '/private'));
  assert.throws(() => client.request('https://localhost:' + new URL(client.origin).port + '/private'));
  assert.equal((await client.request(client.origin + '/redirect')).status, 302);
  assert.deepEqual(f.requests, ['/health', '/health', '/redirect']);
});

test('OAuth bridge forwards only one bounded callback and never turns into an HTTP API proxy', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), callback = f.transport.callbackUrl;
  for (const suffix of ['?code=x&state=s&state=t', '?code=x&state=s&extra=x', '?code=x', '?code=x&error=e&state=s']) {
    const response = await fetch(callback + suffix); await response.text(); assert.equal(response.status, 400);
  }
  const api = await fetch(new URL('/api/projects', callback)); await api.text(); assert.equal(api.status, 400);
  assert.deepEqual(f.requests, []);
  const valid = await fetch(callback + '?code=x&state=s'); await valid.text(); assert.equal(valid.status, 200);
  assert.deepEqual(f.requests, ['/api/auth/github/native/callback?code=x&state=s']);
});

test('launch secrets stay in owned private files and shared roots are refused', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const file of [f.transport.redisConfig, ...Object.values(f.transport.materials).map(m => m.key)]) {
    const stat = fs.lstatSync(file);
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  }
  const shared = path.join(f.root, 'shared'); fs.mkdirSync(shared); fs.chmodSync(shared, 0o755);
  await assert.rejects(createServiceTransport({ userData: shared, ports: {}, getApiToken: () => 'a'.repeat(64) }));
});

test('close drains in-flight pinned and callback requests and refuses reuse', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  let reached, count = 0; const received = new Promise(resolve => { reached = resolve; });
  f.server.removeAllListeners('request');
  f.server.on('request', () => { if (++count === 2) reached(); });
  const request = f.transport.backend.request(f.transport.backend.origin + '/pending');
  const rejected = assert.rejects(request);
  const callbackRejected = assert.rejects(fetch(f.transport.callbackUrl + '?code=x&state=s'));
  await received;
  const first = f.transport.close();
  assert.equal(f.transport.close(), first);
  await first; await rejected; await callbackRejected;
  assert.equal(fs.existsSync(f.transport.directory), false);
  assert.throws(() => f.transport.backend.request(f.transport.backend.origin + '/again'));
  assert.throws(() => f.transport.redisReady());
  await assert.rejects(fetch(f.transport.callbackUrl + '?code=x&state=s'));
});

test('close never recursively removes an unrelated entry', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const unrelated = path.join(f.transport.directory, 'unrelated');
  fs.writeFileSync(unrelated, 'retain me');
  const file = f.transport.materials.backend.key;
  await assert.rejects(f.transport.close(), /DESKTOP_TRANSPORT_REFUSED/);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'retain me');
  assert.ok(fs.existsSync(file));
  f.allowCloseFailure();
});

test('failed startup closes resources and removes only its own material directory', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-service-failed-')));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'unrelated'), 'keep');
  await assert.rejects(createServiceTransport({ userData: root,
    ports: { backend: 0, analyzer: 1, postgres: 2, redis: 3 }, getApiToken: () => 'token' }));
  assert.deepEqual(fs.readdirSync(root), ['unrelated']);
});

