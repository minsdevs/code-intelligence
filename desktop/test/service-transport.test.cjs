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
  let transport;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await transport?.close();
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
  return { root, transport, requests, rotate() { token = crypto.randomBytes(32).toString('hex'); } };
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
