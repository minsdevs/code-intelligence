'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tapCounts, tapDiagnostics, requireNativePass, requireStandardUserToken } = require('../scripts/native-acceptance-windows.cjs');

// These are parser/gate regressions, not native acceptance or DPAPI substitutes.
const successfulCounts = () => ({ tests: 9, pass: 9, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const successfulExit = () => ({ status: 0, error: undefined, signal: null });

test('Windows acceptance requires at least nine executed tests and a clean process exit', () => {
  requireNativePass(successfulExit(), successfulCounts());
  requireNativePass(successfulExit(), { ...successfulCounts(), tests: 32, pass: 32 });
  assert.throws(() => requireNativePass(successfulExit(), { ...successfulCounts(), tests: 8, pass: 8 }));
  assert.throws(() => requireNativePass(successfulExit(), { ...successfulCounts(), pass: 8 }));
  for (const field of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.throws(() => requireNativePass(successfulExit(), { ...successfulCounts(), [field]: 1 }));
  }
  for (const patch of [{ status: 1 }, { status: null }, { error: new Error('private detail') }, { signal: 'SIGTERM' }]) {
    assert.throws(() => requireNativePass({ ...successfulExit(), ...patch }, successfulCounts()));
  }
});

test('Windows TAP diagnostics export only ordinals, outcomes and allowlisted source locations', () => {
  const privateValue = 'do-not-export-password-or-private-path';
  const tap = `TAP version 13
# Subtest: ${privateValue}
ok 1 - ${privateValue}
  ---
  duration_ms: 1
  ...
not ok 2 - ${privateValue}
  ---
  location: 'C:\\${privateValue}\\windows-native-boundary.test.cjs:41:1'
  error: '${privateValue}'
  expected: '${privateValue}'
  actual: '${privateValue}'
  stack: |-
    TestContext.<anonymous> (C:\\${privateValue}\\windows-unix-server.test.cjs:43:10)
  ...
# tests 2
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;
  const evidence = tapDiagnostics(tap);
  assert.deepEqual(evidence, [
    { ordinal: 1, status: 'PASS', sourceLocations: [] },
    { ordinal: 2, status: 'FAIL', sourceLocations: [{ file: 'windows-native-boundary.test.cjs', line: 41, column: 1 }, { file: 'windows-unix-server.test.cjs', line: 43, column: 10 }] },
  ]);
  assert.equal(JSON.stringify(evidence).includes(privateValue), false);
  assert.deepEqual(tapDiagnostics(tap.replaceAll('\n', '\r\n')), evidence);
  assert.deepEqual(tapCounts(tap), { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
});

test('Windows diagnostics remain bounded and cannot replace missing or failing TAP counters', () => {
  assert.deepEqual(tapDiagnostics('private startup failure'), []);
  assert.throws(() => tapCounts('private startup failure'));
  const lines = Array.from({ length: 200 }, (_, index) => `not ok ${index + 1} - private detail\n` +
    '  stack: |-\n' + '    C:\\private\\windows-native-boundary.test.cjs:11:2\n'.repeat(20)).join('');
  const evidence = tapDiagnostics(lines);
  assert.equal(evidence.length, 128);
  assert.equal(evidence[0].sourceLocations.length, 8);
  assert.throws(() => tapCounts(lines));
});

test('Windows child attestation requires exact fresh SID, actual nonadmin token, loaded profile and CurrentUser DPAPI', () => {
  const token = { elevated: false, serviceAccount: false, freshLocalUser: true, exactSid: true,
    administratorGroup: false, profileLoaded: true, currentUserDpapi: true };
  requireStandardUserToken(token);
  for (const key of Object.keys(token)) {
    assert.throws(() => requireStandardUserToken({ ...token, [key]: !token[key] }));
    assert.throws(() => requireStandardUserToken({ ...token, [key]: String(token[key]) }));
    const missing = { ...token }; delete missing[key];
    assert.throws(() => requireStandardUserToken(missing));
  }
  assert.throws(() => requireStandardUserToken({ elevated: false, serviceAccount: false, freshLocalUser: true }));
  assert.throws(() => requireStandardUserToken({ ...token, privateProfilePath: 'private' }));
  for (const invalid of [undefined, null, [], 1, true]) assert.throws(() => requireStandardUserToken(invalid));
});
