'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tapCounts, tapDiagnostics, tapJavaProbes, requireNativePass, requireStandardUserToken } = require('../scripts/native-acceptance-windows.cjs');

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

test('Windows failed TAP retains allowlisted primary causes while rejecting secret-valued fields', () => {
  const tap = 'not ok 1 - private name\n  failureType: testCodeFailure\n  errorType: Error\n' +
    "  error: 'Windows protected storage refused the operation.'\n  code: 'WINDOWS_STORAGE_REFUSED'\n" +
    "  operator: 'rejects'\n  expected: 'private expected'\n  actual: 'private actual'\n" +
    '  stack: |-\n    lose (C:\\private\\windows-storage.cjs:54:44)\n' +
    'not ok 2 - private name\n  failureType: private failure\n  errorType: private type\n' +
    '  error: private message\n  code: PRIVATE_SECRET\n  operator: private operation\n';
  assert.deepEqual(tapDiagnostics(tap), [
    { ordinal: 1, status: 'FAIL', sourceLocations: [{ file: 'windows-storage.cjs', line: 54, column: 44 }],
      diagnostic: { code: 'WINDOWS_STORAGE_REFUSED', failureType: 'testCodeFailure', errorType: 'Error', operator: 'rejects', category: 'windows-storage' } },
    { ordinal: 2, status: 'FAIL', sourceLocations: [] },
  ]);
  assert.deepEqual(tapDiagnostics(tap.replaceAll('\n', '\r\n')), tapDiagnostics(tap));
  assert.equal(JSON.stringify(tapDiagnostics(tap)).includes('private'), false);
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

test('Java probe evidence retains bounded readiness, exchange and exit values without raw output', () => {
  const lines = [
    '# WINDOWS_JAVA_PROBE_RESULT hold EXCHANGE 0 NONE 25000 200 25200 SUCCESS',
    '# WINDOWS_JAVA_PROBE_RESULT extra EXCHANGE null SIGKILL 1000 15000 16000 WINDOWS_JAVA_PROBE_EXCHANGE_TIMEOUT',
    '# WINDOWS_JAVA_PROBE_RESULT normal STARTUP -2147483648 UNKNOWN 300000 0 300000 WINDOWS_JAVA_PROBE_STARTUP_FAILED',
    '# WINDOWS_JAVA_PROBE_RESULT normal STARTUP 4294967295 NONE 30000 0 30000 WINDOWS_JAVA_PROBE_STARTUP_TIMEOUT',
    '# WINDOWS_JAVA_PROBE_RESULT normal EXCHANGE 1 SIGTERM 2 3 5 WINDOWS_JAVA_PROBE_CONNECT_ACCESS_DENIED_FAILED',
    '# WINDOWS_JAVA_PROBE_RESULT normal EXCHANGE null SIGINT 2 3 5 WINDOWS_JAVA_PROBE_ABORTED',
  ];
  const evidence = tapJavaProbes(lines.join('\n') + '\n');
  assert.equal(evidence.length, 6);
  assert.deepEqual(evidence[0], { mode: 'hold', phase: 'EXCHANGE', exitCode: 0, signal: 'NONE',
    startupMs: 25000, exchangeMs: 200, elapsedMs: 25200, code: 'SUCCESS' });
  assert.equal(evidence[1].exitCode, null);
  assert.equal(evidence[2].exitCode, -2147483648);
  assert.equal(evidence[3].exitCode, 4294967295);
  assert.deepEqual(tapJavaProbes(lines.join('\r\n') + '\r\n'), evidence);
  for (const code of ['WINDOWS_JAVA_PROBE_STARTUP_FAILED', 'WINDOWS_JAVA_PROBE_STARTUP_TIMEOUT',
    'WINDOWS_JAVA_PROBE_EXCHANGE_TIMEOUT', 'WINDOWS_JAVA_PROBE_ABORTED']) {
    assert.equal(tapDiagnostics(`not ok 1 - private\n  code: '${code}'\n`)[0].diagnostic.code, code);
  }
});

test('Java probe evidence rejects unbounded numbers, aliases and private text and caps records', () => {
  const good = '# WINDOWS_JAVA_PROBE_RESULT normal EXCHANGE 0 NONE 2 3 5 SUCCESS';
  const invalid = [
    'private ' + good, '  ' + good, good.slice(2), good + ' private', good + ' ',
    good.replace('normal', 'private'), good.replace('EXCHANGE', 'PRIVATE'), good.replace('NONE', 'PRIVATE'),
    ...['-2147483649', '4294967296', '-0', '+1', '01', '1.2', '1e3', 'NaN'].map(value => good.replace(' 0 NONE', ` ${value} NONE`)),
    ...['300001', '-1', '1.5', '1e3', '000001'].flatMap(value => [
      good.replace(' 2 3 5 ', ` ${value} 3 5 `), good.replace(' 2 3 5 ', ` 2 ${value} 5 `), good.replace(' 2 3 5 ', ` 2 3 ${value} `),
    ]),
    good.replace('SUCCESS', 'PRIVATE_SECRET'), good.replace('SUCCESS', 'WINDOWS_JAVA_PROBE_PRIVATE_FAILED'),
  ];
  assert.deepEqual(tapJavaProbes(invalid.join('\n') + '\n'), []);
  const evidence = tapJavaProbes((good + '\n').repeat(20));
  assert.equal(evidence.length, 8);
  assert.equal(JSON.stringify(tapJavaProbes(invalid.join('\n') + '\n' + good)).includes('private'), false);
});
