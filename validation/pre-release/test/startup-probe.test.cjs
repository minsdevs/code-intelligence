'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { argumentsFor, parseCommandTable, classifyCommand, electronRole, mergeRoleSnapshot } = require('../run-startup-probe.cjs');

test('CLI accepts only canonical-shaped absolute app argument and startup-probe-3 flag', () => {
  const app = '/code-intelligence/.native-product-AbC123/Code Intelligence Validation.app';
  assert.deepEqual(argumentsFor(['--app', app, '--startup-probe-3']), { app });
  for (const argv of [[], ['--app', app], ['--app', app, '--warm-startup-20'], ['--app', 'relative', '--startup-probe-3'],
    ['--app', '/code-intelligence/not-a-candidate/Code Intelligence Validation.app', '--startup-probe-3'],
    ['--app', '/code-intelligence/.native-product-AbC123/Other.app', '--startup-probe-3'], ['--app', app + '\n', '--startup-probe-3']]) {
    assert.throws(() => argumentsFor(argv));
  }
});

test('command table parser is bounded, strict and rejects duplicate or unsafe pids', () => {
  assert.deepEqual(parseCommandTable(' 10 /runtime/jre/bin/java\n11 /runtime/postgres/bin/postgres\n'), [
    { pid: 10, comm: '/runtime/jre/bin/java' }, { pid: 11, comm: '/runtime/postgres/bin/postgres' },
  ]);
  for (const value of ['0 /x', '-1 /x', '10', '10 /x\n10 /y', '9007199254740992 /x']) assert.throws(() => parseCommandTable(value));
  assert.throws(() => parseCommandTable('1 /x\n'.repeat(50001)));
});

test('binary classification uses exact paths and never infers guardian versus backend', () => {
  const expected = { java: '/r/jre/bin/java', node: '/electron', postgres: '/r/postgres/bin/postgres', redis: '/r/redis/bin/redis-server' };
  assert.equal(classifyCommand('/r/jre/bin/java', expected), 'JAVA');
  assert.equal(classifyCommand('/electron', expected), 'NODE');
  assert.equal(classifyCommand('/r/postgres/bin/postgres', expected), 'POSTGRES');
  assert.equal(classifyCommand('/r/redis/bin/redis-server', expected), 'REDIS');
  assert.equal(classifyCommand('/r/jre/bin/java-helper', expected), 'ELSE');
});

test('Electron type mapping is fixed enum and unknown values stay unknown', () => {
  assert.equal(electronRole('Browser'), 'ELECTRON_MAIN'); assert.equal(electronRole('Renderer'), 'ELECTRON_RENDERER');
  assert.equal(electronRole('Tab'), 'ELECTRON_RENDERER');
  assert.equal(electronRole('GPU'), 'ELECTRON_GPU'); assert.equal(electronRole('Utility'), 'ELECTRON_UTILITY');
  assert.equal(electronRole('Other'), 'UNKNOWN');
});

test('role snapshot preserves XPC scope and marks vanished command rows UNOBSERVED', () => {
  const expected = { java: '/r/jre/bin/java', node: '/electron', postgres: '/r/postgres/bin/postgres', redis: '/r/redis/bin/redis-server' };
  const processes = [{ pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 }, { pid: 12, ppid: 1, rssKiB: 30, scopeOwnerPid: 10 }];
  const commands = [{ pid: 11, comm: '/r/jre/bin/java' }];
  const metrics = [{ pid: 12, type: 'Renderer' }];
  assert.deepEqual(mergeRoleSnapshot(processes, commands, metrics, 10, expected), [
    { pid: 10, ppid: 1, rssKiB: 100, role: 'MAIN' },
    { pid: 11, ppid: 10, rssKiB: 20, role: 'JAVA' },
    { pid: 12, ppid: 1, rssKiB: 30, role: 'ELECTRON_RENDERER', scopeOwnerPid: 10 },
  ]);
  assert.equal(mergeRoleSnapshot([{ pid: 13, ppid: 10, rssKiB: 1 }], [], [], 10, expected)[0].role, 'UNOBSERVED');
});

test('classification output contains no command path, args or environment material', () => {
  const expected = { java: '/secret/runtime/java', node: '/secret/node', postgres: '/secret/postgres', redis: '/secret/redis' };
  const result = mergeRoleSnapshot([{ pid: 2, ppid: 1, rssKiB: 7 }], [{ pid: 2, comm: expected.java }], [], 1, expected);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|\/runtime|\/java|\/node|\/postgres|\/redis/);
  assert.equal(result[0].role, 'JAVA');
  assert.deepEqual(Object.keys(result[0]).sort(), ['pid', 'ppid', 'role', 'rssKiB'].sort());
});

test('fixed role enum cannot expose arbitrary app metric types', () => {
  const expected = { java: '/r/java', node: '/r/node', postgres: '/r/postgres', redis: '/r/redis' };
  const result = mergeRoleSnapshot([{ pid: 20, ppid: 1, rssKiB: 9 }], [], [{ pid: 20, type: 'private-path-token' }], 99, expected);
  assert.equal(result[0].role, 'UNKNOWN'); assert.doesNotMatch(JSON.stringify(result), /private-path-token/);
});
