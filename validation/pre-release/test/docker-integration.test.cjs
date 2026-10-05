'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { argumentsFor, testEnvironment, countCorpusFiles } = require('../run-docker-integration.cjs');
const { runOwnedCommand, stopOwned } = require('../owned-test-process.cjs');

test('integration CLI accepts only explicit suites and local Docker sockets before any work', () => {
  assert.deepEqual(argumentsFor(['--suite', 'auth', '--socket', 'unix:///var/run/docker.sock']),
    { suite: 'auth', endpoint: 'unix:///var/run/docker.sock' });
  for (const argv of [[], ['--suite', 'backend'], ['--suite', 'prune', '--socket', 'unix:///var/run/docker.sock'],
    ['--suite', 'auth', '--socket', 'tcp://remote:2375'], ['--suite', 'auth', '--socket', 'unix:///other.sock']]) {
    assert.throws(() => argumentsFor(argv));
  }
});

test('Gradle launch uses a private Docker config without inheriting provider or remote Docker settings', () => {
  const root = '/synthetic/run', home = os.homedir();
  const env = testEnvironment(root, 'unix://' + path.join(home, '.docker/run/docker.sock'), home);
  assert.equal(env.DOCKER_CONFIG, root + '/docker');
  assert.equal(env.CI_DOCKER_TEST_ROOT, root);
  assert.equal(env.TESTCONTAINERS_REUSE_ENABLE, 'false');
  assert.equal(env.TESTCONTAINERS_RYUK_DISABLED, 'false');
  assert.equal(env.HOME, home); // Only Gradle's cache uses this; the init script replaces worker HOME.
  for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'SPRING_PROFILES_ACTIVE', 'DOCKER_AUTH_CONFIG', 'JAVA_TOOL_OPTIONS'])
    assert.equal(Object.hasOwn(env, name), false);
});

test('corpus count uses actual file entries, not directories, links or a nonexistent copy-summary field', () => {
  assert.equal(countCorpusFiles({ entries: [{ path: 'a', sha256: 'a'.repeat(64) }, { path: 'b', sha256: 'b'.repeat(64) },
    { path: 'directory', directory: true }, { path: 'alias', link: 'a' }] }), 2);
  assert.throws(() => countCorpusFiles({ files: 54 }), /CORPUS_INVENTORY_REQUIRED/);
});

function fakeChild(onSignal) {
  const child = new EventEmitter();
  child.signals = []; child.unreferenced = false; child.destroyed = 0;
  child.kill = signal => { child.signals.push(signal); onSignal?.(child, signal); return true; };
  child.stdout = { destroy: () => { child.destroyed++; } };
  child.stderr = { destroy: () => { child.destroyed++; } };
  child.unref = () => { child.unreferenced = true; };
  return child;
}
for (const code of [0, 7]) test(`natural direct child exit ${code} is preserved without a signal`, async () => {
  const child = fakeChild();
  const result = await runOwnedCommand('synthetic', [], {}, { timeoutMs: 100, spawnProcess: () => {
    queueMicrotask(() => child.emit('close', code, null)); return child;
  } });
  assert.equal(result.status, code); assert.equal(result.timedOut, false); assert.equal(result.directExitObserved, true);
  assert.deepEqual(child.signals, []);
});

test('timeout followed by exit0 remains a timeout and cannot be counted as a successful test command', async () => {
  const child = fakeChild(c => queueMicrotask(() => c.emit('close', 0, null)));
  const result = await runOwnedCommand('synthetic', [], {}, { timeoutMs: 1, graceMs: 2, spawnProcess: () => child });
  assert.equal(result.status, 0); assert.equal(result.timedOut, true); assert.equal(result.errorCode, 'COMMAND_TIMEOUT');
  assert.equal(result.processTreeTerminationVerified, false); assert.deepEqual(child.signals, ['SIGTERM']);
});

test('only the retained child receives escalation and unconfirmed closure is not hidden', async () => {
  const child = fakeChild();
  const result = await runOwnedCommand('synthetic', [], {}, { timeoutMs: 1, graceMs: 1, spawnProcess: () => child });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.directExitObserved, false); assert.equal(result.timedOut, true);
  assert.equal(child.unreferenced, true); assert.equal(child.destroyed, 2);
});

test('already-closed analyzer does not receive a signal', async () => {
  const child = fakeChild(); const exit = { code: 0, signal: null };
  const result = await stopOwned(child, Promise.resolve(exit), 1);
  assert.equal(result.closed, true); assert.deepEqual(result.exit, exit); assert.deepEqual(child.signals, []);
});

test('spawn failure is redacted and never converted into a normal exit', async () => {
  const child = fakeChild();
  const result = await runOwnedCommand('synthetic', [], {}, { timeoutMs: 100, spawnProcess: () => {
    queueMicrotask(() => { child.emit('error', Object.assign(new Error('private-sentinel'), { code: 'ENOENT' })); child.emit('close', -2, null); });
    return child;
  } });
  assert.equal(result.errorCode, 'ENOENT'); assert.equal(result.status, -2);
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel/);
});
