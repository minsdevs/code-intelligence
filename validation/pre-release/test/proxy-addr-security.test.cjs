'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const analyzerPackage = path.resolve(__dirname, '../../../analyzers/ts-analyzer/package.json');
const analyzerRequire = createRequire(analyzerPackage);
const proxyAddr = analyzerRequire('proxy-addr');

test('IPv4-mapped IPv6 /8 does not trust an unrelated IPv4 address', () => {
  const trust = proxyAddr.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.7'), false);
});

test('native IPv4 /8 trusts only addresses in the 10/8 network', () => {
  const trust = proxyAddr.compile('10.0.0.0/8');
  assert.equal(trust('10.23.45.67'), true);
  assert.equal(trust('203.0.113.7'), false);
});

test('IPv4-mapped IPv6 /104 matches the equivalent 10/8 IPv4 range only', () => {
  const trust = proxyAddr.compile('::ffff:10.0.0.0/104');
  assert.equal(trust('10.23.45.67'), true);
  assert.equal(trust('203.0.113.7'), false);
});
