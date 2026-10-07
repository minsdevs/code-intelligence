'use strict';

// G-COST PK-08: the validation-build-only loopback fake-provider variant. All data is synthetic; the only
// network use is a local 127.0.0.1 server owned by the test. No real provider, DNS or credential is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');
const { createProviderTransport, validationProviderTarget } = require('../src/ai-https-transport.cjs');
const { openDesktopAiGateway } = require('../src/ai-desktop-gateway.cjs');
const { requireValidationOnlyProviderVariant } = require('../scripts/desktop-build-gate.cjs');
const { VALIDATION_APP_ID } = require('../scripts/electron-fuses.cjs');
const releaseMetadata = require('../package.json');

const ORIGIN = 'http://127.0.0.1:47613';
const validation = (origin = ORIGIN) => ({ ...releaseMetadata, name: 'code-intelligence-validation',
  productName: 'Code Intelligence Validation', validationAiProviderOrigin: origin });
const refused = { message: 'AI provider build variant refused' };
function request(overrides = {}) {
  return { origin: 'https://api.openai.com', path: '/v1/chat/completions', method: 'POST',
    retries: 0, redirects: 0, timeoutMs: 60000, maxResponseBytes: 2 * 1024 * 1024,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-test-credential' },
    body: Buffer.from('{"synthetic":"request"}'), ...overrides };
}
async function fakeProvider(t, respond = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'fixture-1' });
  response.end('{"ok":true}');
}) {
  const received = [];
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      received.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) });
      respond(incoming, response);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { received, origin: `http://127.0.0.1:${server.address().port}` };
}

test('the release package metadata carries no provider variant and keeps the fixed HTTPS provider', async t => {
  assert.equal(Object.hasOwn(releaseMetadata, 'validationAiProviderOrigin'), false);
  assert.equal(validationProviderTarget(releaseMetadata), null);
  assert.equal(validationProviderTarget(null), null);
  const calls = [];
  t.mock.method(https, 'request', options => {
    calls.push(options);
    const client = new EventEmitter();
    client.end = () => { setImmediate(() => client.emit('error', new Error('synthetic offline'))); return client; };
    client.destroy = () => client;
    return client;
  });
  t.mock.method(dns, 'lookup', () => { throw new Error('Test attempted forbidden real DNS'); });
  t.mock.method(http, 'request', () => { throw new Error('release transport must not use plain HTTP'); });
  await assert.rejects(createProviderTransport(releaseMetadata)(request()), { message: 'AI provider response unavailable' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].protocol, 'https:'); assert.equal(calls[0].hostname, 'api.openai.com'); assert.equal(calls[0].port, 443);
  assert.equal(calls[0].servername, 'api.openai.com'); assert.equal(calls[0].rejectUnauthorized, true);
});

test('a release-configured build refuses the loopback override at transport, gateway and build gate', async () => {
  const release = { ...releaseMetadata, validationAiProviderOrigin: ORIGIN };
  assert.throws(() => validationProviderTarget(release), refused);
  assert.throws(() => createProviderTransport(release), refused);
  for (const name of ['code-intelligence-desktop', 'code-intelligence', 'Code Intelligence Validation', undefined])
    assert.throws(() => validationProviderTarget({ ...validation(), name }), refused);
  // The gateway composes its transport from the build metadata before it opens anything.
  await assert.rejects(openDesktopAiGateway({ buildMetadata: release }), refused);
  // electron-builder beforePack: a release app id or a distributed target cannot carry the variant.
  const packager = (id, metadata, extraMetadata) => ({ appInfo: { id }, info: { metadata }, config: { extraMetadata } });
  assert.throws(() => requireValidationOnlyProviderVariant({ targets: [{ name: 'dir' }],
    packager: packager('dev.codeintelligence.desktop', releaseMetadata, { validationAiProviderOrigin: ORIGIN }) }), refused);
  assert.throws(() => requireValidationOnlyProviderVariant({ targets: [{ name: 'dir' }],
    packager: packager('dev.codeintelligence.desktop', releaseMetadata, { name: 'code-intelligence-validation', validationAiProviderOrigin: ORIGIN }) }),
  { code: 'VALIDATION_AI_PROVIDER_REFUSED' });
  assert.throws(() => requireValidationOnlyProviderVariant({ targets: [{ name: 'dmg' }],
    packager: packager(VALIDATION_APP_ID, releaseMetadata, { name: 'code-intelligence-validation', validationAiProviderOrigin: ORIGIN }) }),
  { code: 'VALIDATION_AI_PROVIDER_REFUSED' });
  assert.throws(() => requireValidationOnlyProviderVariant({ targets: [{ name: 'dir' }],
    packager: packager('dev.codeintelligence.desktop', validation(), {}) }), { code: 'VALIDATION_AI_PROVIDER_REFUSED' });
  assert.equal(requireValidationOnlyProviderVariant({ targets: [{ name: 'dir' }, { name: 'dmg' }],
    packager: packager('dev.codeintelligence.desktop', releaseMetadata, {}) }), null);
  assert.deepEqual(requireValidationOnlyProviderVariant({ targets: [{ name: 'dir' }],
    packager: packager(VALIDATION_APP_ID, releaseMetadata, { name: 'code-intelligence-validation', validationAiProviderOrigin: ORIGIN }) }),
  { hostname: '127.0.0.1', family: 4, port: 47613 });
});

test('the validation variant accepts only an exact loopback HTTP origin', () => {
  assert.deepEqual(validationProviderTarget(validation()), { hostname: '127.0.0.1', family: 4, port: 47613 });
  assert.deepEqual(validationProviderTarget(validation('http://[::1]:65535')), { hostname: '::1', family: 6, port: 65535 });
  for (const origin of ['https://127.0.0.1:47613', 'http://localhost:47613', 'http://127.0.0.2:47613', 'http://10.0.0.1:47613',
    'http://192.168.1.10:47613', 'http://api.openai.com:443', 'http://[::ffff:127.0.0.1]:47613', 'http://127.0.0.1',
    'http://127.0.0.1:80', 'http://127.0.0.1:0999', 'http://127.0.0.1:65536', 'http://127.0.0.1:47613/',
    'http://127.0.0.1:47613/v1', 'http://user@127.0.0.1:47613', ' http://127.0.0.1:47613', 'http://127.0.0.1:47613\n', '', null, 47613, {}])
    assert.throws(() => validationProviderTarget(validation(origin)), refused, String(origin));
});

test('the validation transport sends one approved request to the loopback fake provider and nothing else', async t => {
  const provider = await fakeProvider(t);
  t.mock.method(https, 'request', () => { throw new Error('validation transport must not use HTTPS'); });
  t.mock.method(dns, 'lookup', () => { throw new Error('Test attempted forbidden real DNS'); });
  const transport = createProviderTransport(validation(provider.origin));
  const result = await transport(request());
  assert.deepEqual({ statusCode: result.statusCode, body: result.body.toString(), id: result.providerRequestId },
    { statusCode: 200, body: '{"ok":true}', id: 'fixture-1' });
  assert.equal(provider.received.length, 1);
  const [sent] = provider.received;
  assert.equal(sent.method, 'POST'); assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.body.toString(), '{"synthetic":"request"}');
  assert.equal(sent.headers.authorization, 'Bearer synthetic-test-credential');
  assert.equal(sent.headers['accept-encoding'], 'identity');
  // The same request checks apply: a non-provider request never reaches the fake provider.
  await assert.rejects(transport(request({ origin: 'https://example.invalid' })), { message: 'AI provider response unavailable' });
  await assert.rejects(transport(request({ redirects: 1 })), { message: 'AI provider response unavailable' });
  assert.equal(provider.received.length, 1);
});

test('the validation transport follows no redirect and accepts only a JSON 2xx answer', async t => {
  const provider = await fakeProvider(t, (_request, response) => {
    response.writeHead(307, { Location: 'https://api.openai.com/v1/chat/completions', 'Content-Type': 'application/json' });
    response.end('{}');
  });
  const transport = createProviderTransport(validation(provider.origin));
  await assert.rejects(transport(request()), { message: 'AI provider response unavailable' });
  assert.equal(provider.received.length, 1);
});
