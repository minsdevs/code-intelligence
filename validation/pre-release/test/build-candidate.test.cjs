'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { argumentsForCandidate } = require('../build-candidate.cjs');

test('candidate argument parsing requires an explicit absolute bundle and ordered build identity', () => {
  assert.deepEqual(argumentsForCandidate(['--app', '/synthetic/Code Intelligence Validation.app', '--build-sequence', '123']),
    { app: '/synthetic/Code Intelligence Validation.app', buildSequence: '123' });
  for (const sequence of ['', '0', '01', '-1', '1\n', '9223372036854775808', '1e3']) {
    assert.throws(() => argumentsForCandidate(['--app', '/synthetic/app', '--build-sequence', sequence]));
  }
  for (const args of [[], ['--app', 'relative', '--build-sequence', '1'], ['--publish', '/app', '--build-sequence', '1'],
    ['--app', '/app', '--build-sequence', '1', '--overwrite'], ['--app', '/app', '--guess', '1']]) {
    assert.throws(() => argumentsForCandidate(args));
  }
});
