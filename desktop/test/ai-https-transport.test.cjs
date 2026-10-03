'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const dns = require('node:dns');
const { createHttpsTransport } = require('../src/ai-https-transport.cjs');

const MAX_RESPONSE = 2 * 1024 * 1024;
const STATIC_ERROR = 'AI provider response unavailable';
// All data is synthetic. Every transport below receives an injected request double; no network,
// account, real provider credential, default https.request or real DNS is used by these tests.
function request(overrides = {}) {
  return { origin: 'https://api.openai.com', path: '/v1/chat/completions', method: 'POST',
    retries: 0, redirects: 0, timeoutMs: 60000, maxResponseBytes: MAX_RESPONSE,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-test-credential' },
    body: Buffer.from('{"synthetic":"request"}'), ...overrides };
}
function unavailable(error) {
  assert.equal(error.constructor, Error);
  assert.equal(error.message, STATIC_ERROR);
  assert.equal(error.cause, undefined);
  assert.equal(error.code, undefined);
  assert.deepEqual(Object.keys(error), []);
  return true;
}
function fixture(t, { requestError, endError, lookupImpl = (_host, _options, callback) => {
  callback(null, [{ address: '1.1.1.1', family: 4 }]);
} } = {}) {
  t.mock.method(https, 'request', () => { throw new Error('Test attempted forbidden real HTTPS'); });
  t.mock.method(dns, 'lookup', () => { throw new Error('Test attempted forbidden real DNS'); });
  const calls = []; const incoming = []; const lookups = [];
  const transport = createHttpsTransport((options, callback) => {
    const client = new EventEmitter();
    client.destroyCalls = 0; client.endCalls = 0;
    client.destroy = () => { client.destroyCalls++; return client; };
    client.end = bytes => {
      client.endCalls++; client.bodyReference = bytes; client.bodyAtEnd = Buffer.from(bytes);
      if (endError) throw endError;
      return client;
    };
    calls.push({ options, callback, client });
    if (requestError) throw requestError;
    return client;
  }, (hostname, options, callback) => {
    lookups.push({ hostname, options });
    return lookupImpl(hostname, options, callback);
  });
  t.after(() => t.mock.restoreAll());
  return { transport, calls, lookups,
    respond({ statusCode = 200, headers = { 'content-type': 'application/json' }, complete = true } = {}) {
      assert.equal(calls.length, 1);
      const value = new EventEmitter();
      Object.assign(value, { statusCode, headers, complete, destroyCalls: 0 });
      value.destroy = () => { value.destroyCalls++; return value; };
      incoming.push(value); calls[0].callback(value);
      return value;
    }, incoming };
}
function complete(incoming, bytes = Buffer.from('{"synthetic":"response"}')) {
  incoming.emit('data', bytes); incoming.emit('end');
}
function fakeTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
}
function lookupOutcome(f, options = { all: true }, hostname = 'api.openai.com') {
  return new Promise(resolve => f.calls[0].options.lookup(hostname, options,
    (error, address, family) => resolve({ error, address, family })));
}
function assertSingleResolution(f) {
  assert.deepEqual(f.lookups, [{ hostname: 'api.openai.com', options: { all: true, verbatim: true } }]);
  assert.equal(f.calls.length, 1);
}

test('exact outbound options pin HTTPS endpoint, TLS, no agent proxy and identity encoding', async t => {
  const f = fixture(t); const input = request(); const original = Buffer.from(input.body);
  const result = f.transport({ ...input, proxy: 'https://unused.invalid', agent: 'unused', hostname: 'unused.invalid',
    rejectUnauthorized: false, lookup: 'unused', servername: 'unused.invalid' });
  assert.equal(f.calls.length, 1);
  const { options, client } = f.calls[0];
  assert.deepEqual(options, { protocol: 'https:', hostname: 'api.openai.com', port: 443,
    path: '/v1/chat/completions', method: 'POST', agent: false, rejectUnauthorized: true,
    servername: 'api.openai.com', lookup: options.lookup,
    minVersion: 'TLSv1.2', headers: { ...input.headers, 'Content-Length': String(original.length), 'Accept-Encoding': 'identity' } });
  assert.equal(typeof options.lookup, 'function');
  assert.equal(client.endCalls, 1);
  assert.deepEqual(client.bodyAtEnd, original);
  assert.notEqual(client.bodyReference, input.body);
  input.body.fill(33);
  assert.deepEqual(client.bodyReference, original);
  const responseBytes = Buffer.from('{"ok":true}');
  complete(f.respond({ headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req_test-1:2.3' } }), responseBytes);
  assert.deepEqual(await result, { statusCode: 200, body: responseBytes, providerRequestId: 'req_test-1:2.3' });
  assert.equal(client.bodyReference.every(byte => byte === 0), true);
  assert.equal(client.destroyCalls, 0);
  assert.deepEqual(responseBytes, Buffer.from('{"ok":true}'));
  assert.equal(f.calls.length, 1);
});

test('environment proxy settings cannot change the injected request options', async t => {
  const f = fixture(t);
  const previous = new Map();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NODE_USE_ENV_PROXY']) {
    previous.set(key, process.env[key]); process.env[key] = key === 'NODE_USE_ENV_PROXY' ? '1' : 'http://synthetic.invalid:8888';
  }
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const result = f.transport(request()); complete(f.respond()); await result;
  const options = f.calls[0].options;
  assert.equal(options.hostname, 'api.openai.com'); assert.equal(options.agent, false);
  assert.equal(Object.hasOwn(options, 'proxyEnv'), false);
  assert.equal(Object.hasOwn(options, 'proxy'), false);
  assert.equal(JSON.stringify(options).includes('synthetic.invalid'), false);
  assert.equal(f.calls.length, 1);
});

for (const [label, mutate] of [
  ['HTTP origin', input => { input.origin = 'http://api.openai.com'; }],
  ['arbitrary host', input => { input.origin = 'https://synthetic.invalid'; }],
  ['userinfo origin', input => { input.origin = 'https://api.openai.com@synthetic.invalid'; }],
  ['trailing origin slash', input => { input.origin += '/'; }],
  ['different endpoint', input => { input.path = '/v1/responses'; }],
  ['absolute endpoint URL', input => { input.path = 'https://synthetic.invalid/'; }],
  ['query string', input => { input.path += '?key=synthetic'; }],
  ['different method', input => { input.method = 'GET'; }],
  ['retry option', input => { input.retries = 1; }],
  ['missing retry option', input => { delete input.retries; }],
  ['redirect option', input => { input.redirects = 1; }],
  ['missing redirect option', input => { delete input.redirects; }],
  ['longer timeout', input => { input.timeoutMs = 60001; }],
  ['disabled timeout', input => { input.timeoutMs = 0; }],
  ['larger response budget', input => { input.maxResponseBytes++; }],
  ['string body', input => { input.body = '{}'; }],
  ['empty body', input => { input.body = Buffer.alloc(0); }],
  ['oversized body', input => { input.body = Buffer.alloc(1024 * 1024 + 1); }],
  ['missing headers', input => { delete input.headers; }],
  ['extra authorization alias', input => { input.headers.authorization = 'Bearer synthetic'; }],
  ['extra host header', input => { input.headers.Host = 'synthetic.invalid'; }],
  ['extra proxy header', input => { input.headers['Proxy-Authorization'] = 'synthetic'; }],
  ['extra content length', input => { input.headers['Content-Length'] = '1'; }],
  ['wrong accept', input => { input.headers.Accept = '*/*'; }],
  ['wrong request content type', input => { input.headers['Content-Type'] = 'text/plain'; }],
  ['missing credential', input => { delete input.headers.Authorization; }],
  ['empty credential', input => { input.headers.Authorization = 'Bearer '; }],
  ['other authorization scheme', input => { input.headers.Authorization = 'Basic synthetic'; }],
  ['oversized credential', input => { input.headers.Authorization = 'Bearer ' + 'a'.repeat(4097); }],
  ['space in credential', input => { input.headers.Authorization = 'Bearer synthetic credential'; }],
  ['newline in credential', input => { input.headers.Authorization = 'Bearer synthetic\ncredential'; }],
  ['trailing credential LF', input => { input.headers.Authorization = 'Bearer synthetic\n'; }],
  ['trailing credential CR', input => { input.headers.Authorization = 'Bearer synthetic\r'; }],
  ['DEL in credential', input => { input.headers.Authorization = 'Bearer synthetic\x7f'; }],
]) test(`invalid request ${label} makes zero HTTPS calls`, async t => {
  const f = fixture(t); const input = request(); mutate(input);
  await assert.rejects(f.transport(input), unavailable);
  assert.equal(f.calls.length, 0);
});

test('missing request rejects before any HTTPS call', async t => {
  const f = fixture(t);
  for (const input of [undefined, null, {}]) await assert.rejects(f.transport(input), unavailable);
  assert.equal(f.calls.length, 0);
});
test('maximum accepted request body and credential are sent once', async t => {
  const f = fixture(t); const input = request({ body: Buffer.alloc(1024 * 1024, 120) });
  input.headers.Authorization = 'Bearer ' + 'a'.repeat(4096);
  const result = f.transport(input); complete(f.respond()); await result;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].client.bodyAtEnd.length, 1024 * 1024);
});

for (const statusCode of [199, 301, 302, 303, 307, 308, 400, 401, 408, 429, 500, 503, undefined, '200', 200.5]) {
  test(`provider status ${String(statusCode)} fails without redirect or retry`, async t => {
    const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
    // Object assignment preserves an explicitly absent/invalid status for this synthetic response.
    const incoming = f.respond({ statusCode: statusCode === undefined ? null : statusCode,
      headers: { 'content-type': 'application/json', location: 'https://synthetic.invalid/redirect', 'retry-after': '0' } });
    await rejected;
    assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls[0].client.destroyCalls, 1);
    assert.equal(f.calls.length, 1);
  });
}
for (const [label, headers] of [
  ['missing content type', {}], ['text response', { 'content-type': 'text/html' }],
  ['lookalike JSON content type', { 'content-type': 'application/jsonx' }],
  ['array content type', { 'content-type': ['application/json'] }],
  ['gzip', { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
  ['brotli', { 'content-type': 'application/json', 'content-encoding': 'br' }],
]) test(`response rejects ${label} with a static error and no retry`, async t => {
  const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
  f.respond({ headers }); await rejected; assert.equal(f.calls.length, 1);
});

test('JSON content type is case insensitive and a missing provider request ID stays null', async t => {
  const f = fixture(t); const result = f.transport(request());
  complete(f.respond({ headers: { 'content-type': 'Application/JSON; charset=UTF-8', 'content-encoding': 'identity' } }));
  assert.equal((await result).providerRequestId, null);
});
test('response chunks are copied before completion and returned independently of wiped request memory', async t => {
  const f = fixture(t); const result = f.transport(request()); const incoming = f.respond();
  const first = Buffer.from('{"ok":'); const second = Buffer.from('true}');
  incoming.emit('data', first); first.fill(0);
  incoming.emit('data', second); second.fill(0); incoming.emit('end');
  assert.deepEqual((await result).body, Buffer.from('{"ok":true}'));
});
test('exact response byte limit succeeds', async t => {
  const f = fixture(t); const result = f.transport(request()); const incoming = f.respond();
  incoming.emit('data', Buffer.alloc(MAX_RESPONSE / 2, 97));
  incoming.emit('data', Buffer.alloc(MAX_RESPONSE / 2, 98)); incoming.emit('end');
  const value = await result;
  assert.equal(value.body.length, MAX_RESPONSE); assert.equal(value.body[0], 97); assert.equal(value.body.at(-1), 98);
  assert.equal(f.calls.length, 1);
});
test('response overflow fails immediately across chunk boundaries', async t => {
  const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable); const incoming = f.respond();
  incoming.emit('data', Buffer.alloc(MAX_RESPONSE)); incoming.emit('data', Buffer.from('x'));
  incoming.emit('end'); await rejected;
  assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls[0].client.destroyCalls, 1);
  assert.equal(f.calls[0].client.bodyReference.every(byte => byte === 0), true);
  assert.equal(f.calls.length, 1);
});
for (const [label, send] of [
  ['empty body', incoming => incoming.emit('end')],
  ['incomplete HTTP message', incoming => { incoming.complete = false; complete(incoming); }],
  ['aborted response', incoming => { incoming.emit('data', Buffer.from('partial')); incoming.emit('aborted'); }],
  ['response stream error', incoming => incoming.emit('error', new Error('synthetic response secret'))],
]) test(`${label} never publishes partial provider bytes`, async t => {
  const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable); const incoming = f.respond();
  send(incoming); await rejected;
  assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls[0].client.destroyCalls, 1); assert.equal(f.calls.length, 1);
});

for (const [label, id] of [['empty', ''], ['leading punctuation', '_request'], ['whitespace', 'req test'],
  ['trailing LF', 'req_test\n'], ['trailing CR', 'req_test\r'], ['Unicode separator', 'req_test\u2028'],
  ['too long', 'a'.repeat(129)], ['array', ['req_test']], ['number', 1], ['null', null]]) {
  test(`invalid provider request ID ${label} is not echoed`, async t => {
    const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
    complete(f.respond({ headers: { 'content-type': 'application/json', 'x-request-id': id } }));
    await rejected; assert.equal(f.calls.length, 1);
  });
}
test('maximum canonical provider request ID is returned unchanged', async t => {
  const f = fixture(t); const result = f.transport(request()); const id = 'r' + 'a'.repeat(127);
  complete(f.respond({ headers: { 'content-type': 'application/json', 'x-request-id': id } }));
  assert.equal((await result).providerRequestId, id);
});

for (const [label, options] of [['synchronous request failure', { requestError: new Error('synthetic TLS secret') }],
  ['synchronous upload failure', { endError: new Error('synthetic upload secret') }]]) {
  test(`${label} yields one static rejection without a retry`, async t => {
    const f = fixture(t, options);
    await assert.rejects(f.transport(request()), unavailable); assert.equal(f.calls.length, 1);
  });
}
for (const [label, code] of [['TLS certificate failure', 'CERT_HAS_EXPIRED'], ['TLS hostname failure', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ['DNS failure', 'ENOTFOUND'], ['socket reset', 'ECONNRESET']]) {
  test(`${label} is not retried and does not expose its message or properties`, async t => {
    const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
    const error = Object.assign(new Error('synthetic credential and prompt'), { code, detail: 'synthetic detail' });
    f.calls[0].client.emit('error', error); await rejected;
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].client.destroyCalls, 1);
    assert.equal(f.calls[0].client.bodyReference.every(byte => byte === 0), true);
  });
}

test('total deadline includes the period before DNS TLS or response headers', async t => {
  fakeTime(t); const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
  t.mock.timers.tick(59999); assert.equal(f.calls[0].client.destroyCalls, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(f.calls[0].client.destroyCalls, 1); assert.equal(f.calls.length, 1);
});
test('response progress does not reset the total deadline', async t => {
  fakeTime(t); const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
  t.mock.timers.tick(20000); const incoming = f.respond(); incoming.emit('data', Buffer.from('partial'));
  t.mock.timers.tick(39999); incoming.emit('data', Buffer.from('progress'));
  assert.equal(incoming.destroyCalls, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls.length, 1);
});
test('timeout before response rejects and destroys any later response without retrying', async t => {
  fakeTime(t); const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
  t.mock.timers.tick(60000); await rejected;
  const incoming = f.respond(); complete(incoming);
  assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls.length, 1);
});
test('success cancels the deadline and late terminal events cannot change the outcome', async t => {
  fakeTime(t); const f = fixture(t); const result = f.transport(request()); const incoming = f.respond();
  complete(incoming); const value = await result;
  incoming.emit('aborted'); incoming.emit('error', new Error('late synthetic error'));
  f.calls[0].client.emit('error', new Error('late synthetic client error'));
  t.mock.timers.tick(120000);
  assert.equal(value.body.toString(), '{"synthetic":"response"}');
  assert.equal(incoming.destroyCalls, 0); assert.equal(f.calls[0].client.destroyCalls, 0); assert.equal(f.calls.length, 1);
});
test('failure settles once and ignores later body and terminal events', async t => {
  fakeTime(t); const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable); const incoming = f.respond();
  incoming.emit('aborted'); complete(incoming); incoming.emit('error', new Error('late synthetic error'));
  f.calls[0].client.emit('error', new Error('late synthetic error')); t.mock.timers.tick(120000); await rejected;
  assert.equal(incoming.destroyCalls, 1); assert.equal(f.calls[0].client.destroyCalls, 1); assert.equal(f.calls.length, 1);
});

// Exercise the lookup installed in the observed HTTPS options. A request object can already exist
// while DNS is pending: these are callback/transport tests, not real socket or TLS experiments.
// Special-use examples follow the IANA registries. The production policy deliberately also refuses
// some globally reachable special assignments, so those cases are labelled conservative exclusions.
for (const [address, family] of [
  ['1.1.1.1', 4], ['8.8.8.8', 4], ['104.18.33.45', 4],
  ['2606:4700:4700::1111', 6], ['2001:4860:4860::8888', 6],
  ['2606:4700:0000:0000:0000:0000:0000:ABCD', 6],
]) test(`DNS pins the checked public answer ${address} without resolving it again`, async t => {
  const answers = [{ address, family }];
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, answers) });
  const result = f.transport(request());
  const outcome = await lookupOutcome(f);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.address, answers);
  assert.notEqual(outcome.address, answers);
  assert.notEqual(outcome.address[0], answers[0]);
  answers[0].address = '127.0.0.1'; answers.push({ address: '10.0.0.1', family: 4 });
  assert.deepEqual(outcome.address, [{ address, family }]);
  complete(f.respond()); await result;
  assertSingleResolution(f);
  assert.equal(f.calls[0].options.servername, 'api.openai.com');
  assert.equal(f.calls[0].options.rejectUnauthorized, true);
});

const forbiddenAddresses = [
  ['unspecified IPv4', '0.0.0.0', 4], ['this-network IPv4', '0.1.2.3', 4],
  ['private 10', '10.2.3.4', 4], ['private 172 first', '172.16.0.1', 4],
  ['private 172 last', '172.31.255.254', 4], ['private 192', '192.168.1.1', 4],
  ['loopback IPv4', '127.0.0.1', 4], ['other loopback IPv4', '127.99.1.1', 4],
  ['link local IPv4', '169.254.169.254', 4], ['CGNAT first', '100.64.0.1', 4],
  ['CGNAT last', '100.127.255.254', 4], ['benchmark first', '198.18.0.1', 4],
  ['benchmark last', '198.19.255.254', 4], ['documentation one', '192.0.2.10', 4],
  ['documentation two', '198.51.100.10', 4], ['documentation three', '203.0.113.10', 4],
  ['protocol assignment', '192.0.0.1', 4], ['deprecated 6to4 anycast', '192.88.99.1', 4],
  ['multicast first', '224.0.0.1', 4], ['multicast last', '239.255.255.254', 4],
  ['reserved IPv4', '240.0.0.1', 4], ['broadcast IPv4', '255.255.255.255', 4],
  ['conservative AS112 v4 exclusion', '192.175.48.1', 4],
  ['conservative AS112 direct exclusion', '192.31.196.1', 4],
  ['conservative AMT exclusion', '192.52.193.1', 4],
  ['unspecified IPv6', '::', 6], ['loopback IPv6', '::1', 6],
  ['expanded loopback IPv6', '0:0:0:0:0:0:0:1', 6],
  ['IPv4 mapped dotted', '::ffff:127.0.0.1', 6], ['IPv4 mapped hexadecimal', '::ffff:7f00:1', 6],
  ['IPv4 compatible', '::7f00:1', 6], ['mapped public IPv4', '::ffff:8.8.8.8', 6],
  ['translation prefix', '64:ff9b::808:808', 6], ['local translation prefix', '64:ff9b:1::1', 6],
  ['discard prefix', '100::1', 6], ['Teredo assignment', '2001::1', 6],
  ['conservative special IPv6 block end', '2001:1ff:ffff::1', 6],
  ['documentation IPv6', '2001:db8::1', 6], ['expanded uppercase documentation IPv6', '2001:0DB8:0:0:0:0:0:1', 6],
  ['6to4 IPv6', '2002:0808:0808::1', 6], ['new documentation IPv6 first', '3fff::1', 6],
  ['new documentation IPv6 last', '3fff:fff:ffff::1', 6],
  ['conservative AS112 IPv6 exclusion', '2620:4f:8000::1', 6],
  ['unique local IPv6 first', 'fc00::1', 6], ['unique local IPv6 second', 'fd12:3456::1', 6],
  ['link local IPv6', 'fe80::1', 6], ['link local IPv6 last', 'febf:ffff::1', 6],
  ['multicast IPv6', 'ff02::1', 6], ['zone identifier', '2606:4700::1111%en0', 6],
  ['IPv4 abbreviated', '127.1', 4], ['IPv4 octal spelling', '0177.0.0.1', 4],
  ['IPv4 hexadecimal spelling', '0x7f000001', 4], ['address with trailing LF', '8.8.8.8\n', 4],
  ['address with leading whitespace', ' 8.8.8.8', 4], ['hostname instead of address', 'api.openai.com', 4],
  ['IPv6 address with IPv4 family', '2606:4700::1111', 4], ['IPv4 address with IPv6 family', '8.8.8.8', 6],
  ['string family', '8.8.8.8', '4'], ['zero family', '8.8.8.8', 0],
];
for (const [label, address, family] of forbiddenAddresses) {
  test(`DNS rejects ${label} even alongside a valid public answer`, async t => {
    const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null,
      [{ address: '1.1.1.1', family: 4 }, { address, family }]) });
    const rejected = assert.rejects(f.transport(request()), unavailable);
    const outcome = await lookupOutcome(f);
    unavailable(outcome.error);
    assert.equal(outcome.address, undefined); assert.equal(outcome.family, undefined);
    f.calls[0].client.emit('error', outcome.error); await rejected;
    assertSingleResolution(f);
    assert.equal(f.calls[0].client.destroyCalls, 1);
    assert.equal(f.calls[0].client.bodyReference.every(byte => byte === 0), true);
  });
}

for (const options of [4, { family: 4 }, { family: 4, all: true }, 6, { family: 6 }, { family: 6, all: true }]) {
  test(`DNS validates the entire answer before applying family selection ${JSON.stringify(options)}`, async t => {
    const requestedFamily = typeof options === 'number' ? options : options.family;
    const answers = requestedFamily === 4
      ? [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]
      : [{ address: '2606:4700::1111', family: 6 }, { address: '127.0.0.1', family: 4 }];
    const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, answers) });
    const rejected = assert.rejects(f.transport(request()), unavailable);
    const outcome = await lookupOutcome(f, options);
    unavailable(outcome.error); assert.equal(outcome.address, undefined);
    f.calls[0].client.emit('error', outcome.error); await rejected;
    assertSingleResolution(f);
  });
}

for (const options of [4, 6, { family: 4 }, { family: 6 }, { family: 4, all: true }, { family: 6, all: true }, { all: true }, {}]) {
  test(`DNS preserves vetted address and family callback shape ${JSON.stringify(options)}`, async t => {
    const answers = [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700::1111', family: 6 }];
    const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, answers) });
    const result = f.transport(request()); const outcome = await lookupOutcome(f, options);
    const selected = typeof options === 'number' ? answers.filter(value => value.family === options)
      : options.family ? answers.filter(value => value.family === options.family) : answers;
    assert.equal(outcome.error, null);
    if (options.all) {
      assert.deepEqual(outcome.address, selected); assert.equal(outcome.family, undefined);
    } else {
      assert.equal(outcome.address, selected[0].address); assert.equal(outcome.family, selected[0].family);
    }
    complete(f.respond()); await result; assertSingleResolution(f);
  });
}

for (const [label, value] of [
  ['missing answer', undefined], ['null answer', null], ['non-array answer', {}], ['empty answer', []],
  ['null record', [null]], ['missing address', [{ family: 4 }]], ['missing family', [{ address: '1.1.1.1' }]],
  ['non-string address', [{ address: 1, family: 4 }]],
  ['too many answers', Array.from({ length: 65 }, () => ({ address: '1.1.1.1', family: 4 }))],
]) test(`DNS rejects ${label} without disclosing resolver input`, async t => {
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, value) });
  const rejected = assert.rejects(f.transport(request()), unavailable); const outcome = await lookupOutcome(f);
  unavailable(outcome.error); assert.equal(outcome.address, undefined);
  f.calls[0].client.emit('error', outcome.error); await rejected; assertSingleResolution(f);
});

test('DNS accepts the bounded maximum public answer list without a second resolution', async t => {
  const answers = Array.from({ length: 64 }, () => ({ address: '1.1.1.1', family: 4 }));
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, answers) });
  const result = f.transport(request()); const outcome = await lookupOutcome(f);
  assert.equal(outcome.error, null); assert.deepEqual(outcome.address, answers);
  complete(f.respond()); await result; assertSingleResolution(f);
});

for (const family of [4, 6]) test(`DNS refuses an absent requested family ${family}`, async t => {
  const answers = family === 4 ? [{ address: '2606:4700::1111', family: 6 }] : [{ address: '1.1.1.1', family: 4 }];
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => callback(null, answers) });
  const rejected = assert.rejects(f.transport(request()), unavailable);
  const outcome = await lookupOutcome(f, { family, all: true });
  unavailable(outcome.error); assert.equal(outcome.address, undefined);
  f.calls[0].client.emit('error', outcome.error); await rejected; assertSingleResolution(f);
});

for (const hostname of ['localhost', '127.0.0.1', 'api.openai.com.', 'API.OPENAI.COM', 'synthetic.invalid']) {
  test(`the installed DNS callback refuses an alternate hostname ${hostname} before lookup`, async t => {
    const f = fixture(t); const rejected = assert.rejects(f.transport(request()), unavailable);
    const outcome = await lookupOutcome(f, { all: true }, hostname);
    unavailable(outcome.error); assert.equal(outcome.address, undefined);
    f.calls[0].client.emit('error', outcome.error); await rejected;
    assert.deepEqual(f.lookups, []); assert.equal(f.calls.length, 1);
  });
}

for (const mode of ['callback error', 'synchronous throw']) test(`DNS ${mode} is static and never retried`, async t => {
  const error = Object.assign(new Error('synthetic resolver details'), { code: 'SYNTHETIC_DNS_FAILURE' });
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => {
    if (mode === 'synchronous throw') throw error;
    callback(error, [{ address: '1.1.1.1', family: 4 }]);
  } });
  const rejected = assert.rejects(f.transport(request()), unavailable); const outcome = await lookupOutcome(f);
  unavailable(outcome.error); assert.notEqual(outcome.error, error); assert.equal(outcome.address, undefined);
  f.calls[0].client.emit('error', outcome.error); await rejected; assertSingleResolution(f);
});

test('the transport deadline destroys a request whose DNS callback has not returned', async t => {
  fakeTime(t); let release;
  const f = fixture(t, { lookupImpl: (_host, _options, callback) => { release = callback; } });
  const rejected = assert.rejects(f.transport(request()), unavailable); const pendingLookup = lookupOutcome(f);
  t.mock.timers.tick(59999); assert.equal(f.calls[0].client.destroyCalls, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(f.calls[0].client.destroyCalls, 1);
  release(null, [{ address: '1.1.1.1', family: 4 }]);
  const late = await pendingLookup;
  assert.equal(late.error, null); // DNS cancellation itself is not promised; the request is already closed.
  assert.equal(f.calls[0].client.destroyCalls, 1); assertSingleResolution(f);
});
