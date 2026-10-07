'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { rendererCspFailures } = require('../security-packaged-probe.cjs');

const POLICY = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "style-src 'self' 'unsafe-inline'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const hardened = { documentCsp: POLICY, injectedInlineScriptRan: false, evalAllowed: false, crossOriginFetch: 'blocked',
  listenerReceived: [{ method: 'GET', path: '/', tokenHeaderPresent: false, originHeader: null }] };

test('SEC-M-01 renderer expectations pass only for a delivered policy that blocked every renderer attack', () => {
  assert.deepEqual(rendererCspFailures(hardened), []);
});

test('the LA8ZS9-era renderer outcome (no CSP, inline script, eval and exfiltration worked) fails every expectation', () => {
  const observed = { documentCsp: null, injectedInlineScriptRan: true, evalAllowed: true, crossOriginFetch: 'sent',
    listenerReceived: [{ method: 'GET', path: '/renderer-fetch' }, { method: 'GET', path: '/renderer-image' }] };
  assert.deepEqual(rendererCspFailures(observed), ['DOCUMENT_CSP_MISSING', 'INLINE_SCRIPT_RAN', 'EVAL_ALLOWED',
    'CROSS_ORIGIN_FETCH_SENT', 'RENDERER_REQUEST_REACHED_LISTENER']);
});

test('a delivered but permissive policy is not accepted', () => {
  for (const [policy, failure] of [
    [POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("connect-src 'self'", 'connect-src *'), 'CONNECT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("default-src 'self'; script-src 'self'; ", ''), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("object-src 'none'", "object-src 'self'"), 'OBJECT_SRC_NOT_NONE'],
  ]) assert.deepEqual(rendererCspFailures({ ...hardened, documentCsp: policy }), [failure], policy);
});

test('a missing renderer record fails closed', () => {
  assert.deepEqual(rendererCspFailures(undefined), ['RENDERER_NOT_PROBED']);
});
