'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { createServiceTransport, createPinnedClient } = require('../../src/service-transport.cjs');

async function main() {
  assert.ok(process.versions.electron, 'This regression must use the real Electron TLS implementation');
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  const root = process.argv[2];
  const server = https.createServer();
  const requests = [];
  let transport;
  const clients = [];
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const token = crypto.randomBytes(32).toString('hex');
    const port = server.address().port;
    transport = await createServiceTransport({ userData: root,
      ports: { backend: port, analyzer: 1, postgres: 2, redis: 3 }, getApiToken: () => token });
    server.setSecureContext({ key: fs.readFileSync(transport.materials.backend.key), cert: transport.materials.backend.pem });
    server.on('request', (request, response) => {
      requests.push(request.url);
      response.writeHead(request.headers['x-code-intelligence-token'] === token ? 204 : 401);
      response.end();
    });
    const client = transport.backend;
    assert.equal((await client.request(client.origin + '/ready')).status, 204);
    clients.push(createPinnedClient(transport.materials.analyzer, port, { 'X-Code-Intelligence-Token': 'must-not-leak' }));
    clients.push(createPinnedClient({ ...transport.materials.backend, pin: '0'.repeat(64) }, port,
      { 'X-Code-Intelligence-Token': 'must-not-leak' }));
    for (const untrusted of clients) await assert.rejects(untrusted.request(client.origin + '/private'));
    assert.deepEqual(requests, ['/ready']);
    assert.equal((await client.request(client.origin + '/still-ready')).status, 204);
    assert.deepEqual(requests, ['/ready', '/still-ready']);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    try { await transport?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
