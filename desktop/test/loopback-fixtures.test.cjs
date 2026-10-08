'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { startUpdateServer } = require('./fixtures/update-https-server.cjs');

function send(origin, url, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = (origin.startsWith('https:') ? https : http).request(origin + url,
      { agent: false, rejectUnauthorized: false, ...options }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body, id: response.headers['x-request-id'] }));
      });
    outgoing.on('error', reject); outgoing.end();
  });
}

test('cost HTTP fixture excludes probes but records wrong provider paths', async t => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/ai-cost-egress-runtime.cjs'), 'utf8');
  const functionSource = source.match(/async function startHttpProvider\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const records = [];
  const context = vm.createContext({ http, Buffer, crypto, PUBLIC_SYNTHETIC_KEY: 'synthetic', providerServer: null,
    record: async (file, value) => { records.push({ file, value }); },
    providerResponse: (_mode, id) => ({ statusCode: 200, providerRequestId: id, body: '{}' }) });
  const provider = await vm.runInContext(functionSource + '\nstartHttpProvider()', context);
  t.after(() => new Promise(resolve => context.providerServer.close(resolve)));
  assert.equal((await send(provider.origin, '/')).status, 404);
  assert.equal((await send(provider.origin, '/favicon.ico')).status, 404);
  assert.equal(records.filter(row => row.file === 'http-provider.jsonl').length, 0);
  assert.equal((await send(provider.origin, '/v1/chat/completions', { method: 'POST' })).id, 'http-1');
  await send(provider.origin, '/wrong-path', { method: 'POST' });
  await send(provider.origin, '/', { headers: { authorization: 'Bearer synthetic' } });
  assert.deepEqual(records.filter(row => row.file === 'http-provider.jsonl').map(row => row.value.path),
    ['/v1/chat/completions', '/wrong-path', '/']);
  assert.equal(records.filter(row => row.file === 'http-stray.jsonl').length, 2);
});

test('update HTTPS fixture excludes foreign hosts without hiding genuine unknown paths', async t => {
  let socketServer;
  const createServer = https.createServer;
  t.mock.method(https, 'createServer', (...args) => { socketServer = createServer(...args); return socketServer; });
  const fixture = await startUpdateServer(t);
  const origin = `https://127.0.0.1:${socketServer.address().port}`;
  let responses = 0;
  fixture.routes.set('/known', (_request, response) => response.end(String(++responses)));
  assert.equal((await send(origin, '/')).status, 404);
  assert.equal((await send(origin, '/known')).status, 404);
  assert.deepEqual(fixture.requests, []); assert.equal(responses, 0);
  const answer = await fixture.request(fixture.base + '/known');
  for await (const _chunk of answer.body) { /* Drain the real response. */ }
  const missing = await fixture.request(fixture.base + '/wrong-path');
  for await (const _chunk of missing.body) { /* Drain the real response. */ }
  assert.equal(missing.statusCode, 404); assert.equal(responses, 1);
  assert.deepEqual(fixture.requests, ['/known', '/wrong-path']);
});

for (const index of [0, 1]) test('Windows HTTPS handler ' + index + ' ignores unrelated probes without hiding wrong paths', () => {
  const source = fs.readFileSync(path.join(__dirname, 'service-transport-windows.test.cjs'), 'utf8');
  const start = source.indexOf('  servers[' + index + "].on('request', ");
  const end = source.indexOf('\n  });', start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const requests = [];
  const servers = []; servers[index] = { on: (_event, callback) => { handler = callback; } };
  vm.runInNewContext(source.slice(start, end + 6), { servers, requests, assert, token: 'synthetic', transport: { analyzerToken: 'synthetic' } });
  let status;
  const response = { writeHead(value) { status = value; return this; }, end() {} };
  handler({ method: 'GET', url: '/', headers: {}, resume() {} }, response);
  assert.equal(status, 404); assert.deepEqual(requests, []);
  const headers = index === 0 ? { 'x-code-intelligence-token': 'synthetic' } : { authorization: 'Bearer synthetic' };
  handler({ method: 'GET', url: '/wrong-path', headers }, response);
  assert.equal(status, 204);
  if (index === 0) assert.deepEqual(requests, ['/wrong-path']);
  assert.throws(() => handler({ method: 'GET', url: '/health', headers: {} }, response));
});
