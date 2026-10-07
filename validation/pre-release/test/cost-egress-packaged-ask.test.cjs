'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PERSONAL, packagedVariant, providerResponse, sourceText, startFakeProvider } = require('../cost-egress-packaged-ask.cjs');
const { SUPPORTED_MODEL } = require('../../../desktop/src/ai-model-contracts.cjs');

const asarWith = metadata => ({ extractFile: (_file, name) => { assert.equal(name, 'package.json'); return Buffer.from(JSON.stringify(metadata)); } });

test('only a validation candidate carrying the loopback origin can run the packaged ask', () => {
  const validation = { name: 'code-intelligence-validation', validationAiProviderOrigin: 'http://127.0.0.1:47613' };
  assert.deepEqual(packagedVariant(asarWith(validation), 'app.asar').target, { hostname: '127.0.0.1', family: 4, port: 47613 });
  // A candidate built before the variant: blocked, not launched.
  assert.equal(packagedVariant(asarWith({ name: 'code-intelligence-validation' }), 'app.asar').target, null);
  // A release-named package with the origin is refused by the product's own rule.
  const release = packagedVariant(asarWith({ ...validation, name: 'code-intelligence-desktop' }), 'app.asar');
  assert.equal(release.target, null); assert.equal(release.refused, true);
});

test('the fixture source carries every personal-data sentinel and the provider answer settles a known amount', () => {
  for (const value of PERSONAL) assert.ok(sourceText().includes(value), value);
  const answer = JSON.parse(providerResponse(1));
  assert.equal(answer.model, SUPPORTED_MODEL);
  assert.deepEqual(answer.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } });
});

test('the fake provider records each request and answers with JSON on loopback only', async () => {
  const provider = await startFakeProvider({ hostname: '127.0.0.1', port: 0 });
  try {
    const port = provider.port;
    const body = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, id: response.headers['x-request-id'], text: Buffer.concat(chunks).toString() }));
      });
      request.on('error', reject); request.end('{"messages":[]}');
    });
    assert.equal(body.status, 200); assert.equal(body.id, 'packaged-1'); assert.equal(JSON.parse(body.text).model, SUPPORTED_MODEL);
    assert.equal(provider.requests.length, 1);
    // A non-provider probe of the port is answered 404 and never counted as a provider request.
    const stray = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); })
        .on('error', reject);
    });
    assert.equal(stray, 404); assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.strays, [{ method: 'GET', path: '/', bytes: 0, authorizationPresent: false }]);
    assert.deepEqual({ method: provider.requests[0].method, url: provider.requests[0].url, auth: provider.requests[0].authorization,
      body: provider.requests[0].body.toString() }, { method: 'POST', url: '/v1/chat/completions', auth: 'Bearer synthetic', body: '{"messages":[]}' });
  } finally { await provider.close(); }
});
